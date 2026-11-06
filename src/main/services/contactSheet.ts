/**
 * 缩略图墙（contact sheet）主进程服务
 *
 * 一次 ffmpeg 调用把素材按采样率重采样出全部缩略帧（-r 输出帧率重采样走编码器层，
 * 精简 ffmpeg 无 fps/select 滤镜也可用），pngjs 解码后 JS 拼 cols×rows 网格。
 * electron-free（PNG 直接出 dataUrl，单测/脚本可直跑；视觉模型吃 PNG 无碍）。
 * 有 ready 代理走代理（mxf/超大素材），与抽帧同口径。
 */

import execa from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PNG, type PNGImage} from 'pngjs';
import {RenderInternals} from '@remotion/renderer';
import {cellOrigin, cellSize, planContactSheet} from '../../shared/frame-sheet.ts';
import {getVideoMetadata} from './ffprobe';

const getFfmpegPath = (): string =>
  RenderInternals.getExecutablePath({type: 'ffmpeg', indent: false, logLevel: 'error', binariesDirectory: null});

export interface ContactSheetResult {
  dataUrl: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  timesSec: number[];
  /** 实际入图帧数（短素材不满格） */
  frames: number;
}

/** 有 ready 代理读代理（时间轴等价）——由 index.ts 注入（与 frameExtract 同单例） */
let proxyResolver: ((filePath: string) => string) | null = null;
export const setContactSheetProxyResolver = (fn: ((filePath: string) => string) | null): void => {
  proxyResolver = fn;
};

/**
 * 生成素材的缩略图墙（一张 JPEG dataUrl）。
 * @param cells 目标格数（缺省 100 = 10×10；钳 1-144）
 */
export const makeContactSheet = async (
  filePath: string,
  cells = 100,
  thumbW = 96,
): Promise<ContactSheetResult> => {
  const sourcePath = proxyResolver ? proxyResolver(filePath) : filePath;
  const meta = await getVideoMetadata(sourcePath);
  const plan = planContactSheet(meta.duration, cells, thumbW);
  const {w: cw, h: ch} = cellSize(plan.thumbW, meta.width, meta.height);

  if (meta.duration <= 0 || plan.timesSec.length <= 1) {
    // 时长未知/极短：单帧兜底（ffprobe 失败的 webm 等场景）
    const single = await extractFramesAt(sourcePath, [plan.timesSec[0] ?? 0], cw, ch);
    return assemble(single, 1, 1, cw, ch, plan.timesSec.slice(0, 1));
  }

  // 一次解码：-r 把输出重采样到 cells/duration 帧率（编码器层，精简 ffmpeg 可用），
  // image2 序号出图；-t 截时长防拖尾帧
  const outFps = plan.timesSec.length / meta.duration;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-sheet-'));
  try {
    await execa(getFfmpegPath(), [
      '-i', sourcePath,
      '-r', outFps.toFixed(6),
      '-t', String(Math.min(meta.duration, (plan.timesSec.length + 1) / outFps)),
      '-vf', `scale=${cw}:${ch}:force_original_aspect_ratio=decrease`,
      path.join(dir, 'f-%04d.png'),
    ], {maxBuffer: 16 * 1024 * 1024});
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const framesPng = files.slice(0, plan.timesSec.length).map((f) => PNG.sync.read(fs.readFileSync(path.join(dir, f))));
    if (framesPng.length === 0) {
      throw new Error('contact sheet 抽帧失败：ffmpeg 未产出帧');
    }
    const times = plan.timesSec.slice(0, framesPng.length);
    return assemble(framesPng, plan.cols, plan.rows, cw, ch, times);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

/** 逐时间点抽帧（短素材兜底路径，走 -ss 快速 seek） */
const extractFramesAt = async (sourcePath: string, timesSec: number[], cw: number, ch: number): Promise<PNGImage[]> => {
  const out: PNGImage[] = [];
  for (const t of timesSec) {
    const {stdout} = await execa(getFfmpegPath(), [
      '-ss', String(Math.max(0, t)), '-i', sourcePath, '-frames:v', '1',
      '-vf', `scale=${cw}:${ch}:force_original_aspect_ratio=decrease`,
      '-f', 'image2', '-vcodec', 'png', 'pipe:1',
    ], {encoding: 'buffer', maxBuffer: 8 * 1024 * 1024});
    out.push(PNG.sync.read(stdout as unknown as Buffer));
  }
  return out;
};

/** PNG 帧列表 → 网格大图 JPEG dataUrl */
const assemble = (frames: PNGImage[], cols: number, rows: number, cw: number, ch: number, timesSec: number[]): ContactSheetResult => {
  const rowsNeeded = Math.max(1, Math.ceil(frames.length / cols));
  const W = cols * cw;
  const H = rowsNeeded * ch;
  const sheet = new PNG({width: W, height: H});
  // 黑底（缺格区域可见为黑）
  sheet.data.fill(0);
  frames.forEach((f, k) => {
    const {x, y} = cellOrigin({cols, rows, timesSec: timesSec, thumbW: cw}, k, ch);
    const fw = Math.min(f.width, cw);
    const fh = Math.min(f.height, ch);
    // 格内居中贴（源比例 != 格比例时留黑边）
    PNG.bitblt(f, sheet, 0, 0, fw, fh, x + ((cw - fw) >> 1), y + ((ch - fh) >> 1));
  });
  const buf = PNG.sync.write(sheet);
  return {
    dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    width: W,
    height: H,
    cols,
    rows: rowsNeeded,
    timesSec,
    frames: frames.length,
  };
};
