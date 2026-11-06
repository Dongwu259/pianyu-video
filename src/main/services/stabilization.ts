/**
 * 跟踪稳定分析服务（方案 A 核心，见 RESEARCH-STABILIZATION.md）
 *
 * 链路：Remotion 自带 ffmpeg 把 trim 区间解成 480 宽灰度 PNG 序列（精简 ffmpeg 无 fps
 * 滤镜，故全帧解码后 JS 等距抽样到分析帧率，同 footage.ts 姿势）→ 金字塔块匹配
 * （NCC，见 shared/stabilization.ts）逐帧跟踪 → 平滑求解出每帧校正量表 →
 * 写 <同名>.stab.json sidecar（媒体同目录，与 .cursor.json 先例一致；
 * 目录无写权限时降级 os.tmpdir 并在结果里用 actualPath 体现）。
 *
 * 不 import electron，tsx 可直接跑（单测/e2e 同径）。纯算法全部在
 * src/shared/stabilization.ts，本文件只做 解码/跟踪循环/落盘/缓存。
 */

import execa from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {RenderInternals} from '@remotion/renderer';
import {getVideoMetadata} from './ffprobe';
import {grayOfPng} from './footage';
import {
  STAB_DEFAULTS,
  autoPickPoint,
  buildRawSamples,
  solveStabilization,
  trackPatch,
  type FrameGray,
  type StabCorrection,
  type StabPoint,
  type StabSample,
  type StabTrackFile,
} from '../../shared/stabilization.ts';

// ====== 类型 ======

export interface StabAnalyzeOpts {
  smoothSec?: number;     // 平滑窗口秒，默认 0.8
  maxZoom?: number;       // 自动缩放封顶，默认 1.25
  maxAnalyzeFps?: number; // 分析帧率上限，默认 15（从全帧解码等距抽样）
  trimStart?: number;     // 只分析该区间（媒体秒），默认 0
  trimEnd?: number;       // 默认全片时长
}

/** sidecar 文件内容 = 轨迹文件 + 求解参数与结果 */
export type StabTrackSidecar = StabTrackFile & {
  smoothSec: number;
  maxZoom: number;
  zoom: number;
};

export interface StabAnalyzeStats {
  analyzedFrames: number;   // 实际跟踪的采样帧数
  durationSec: number;      // 分析的媒体区间时长
  lostRatio: number;        // 跟丢帧占比（conf < 0.5）
  maxCorrectionPx: number;  // 最大单帧校正平移量（视频像素）
  meanConf: number;         // 平均置信度
}

export interface StabAnalyzeResult {
  trackPath: string;        // sidecar 实际落盘路径（媒体目录不可写时为 tmpdir 降级路径）
  track: StabTrackFile;
  corrections: StabCorrection[];
  zoom: number;
  smoothSecUsed: number;
  capped: boolean;
  stats: StabAnalyzeStats;
}

// ====== ffmpeg 解码 ======

const getFfmpegPath = (): string =>
  RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
  });

/**
 * 把视频 trim 区间解成 480 宽灰度 PNG 序列到临时目录（-ss/-t 前置快 seek；
 * scale=480:-2 保持宽高比且高度取偶）。调用方负责 rm 掉返回的 dir。
 * （groundTracking 服务同管道复用，故导出）
 */
export const decodeToGrayPngs = async (
  videoPath: string,
  trimStart: number,
  trimEnd: number,
  analyzeWidth: number = STAB_DEFAULTS.analyzeWidth,
): Promise<{dir: string; files: string[]}> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-stab-'));
  const args = ['-ss', String(trimStart), '-t', String(Math.max(0.04, trimEnd - trimStart)), '-i', videoPath,
    '-vf', `scale=${analyzeWidth}:-2`, '-pix_fmt', 'gray', '-vcodec', 'png', path.join(dir, 'f-%05d.png')];
  try {
    await execa(getFfmpegPath(), args, {maxBuffer: 16 * 1024 * 1024});
  } catch (err) {
    fs.rmSync(dir, {recursive: true, force: true});
    throw err;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  return {dir, files};
};

const readGrayFrame = (file: string): FrameGray => {
  const png = PNG.sync.read(fs.readFileSync(file));
  return {data: grayOfPng(png.data), width: png.width, height: png.height};
};
export {readGrayFrame};

/** 抽一帧灰度（自动选点/未来 UI 预览用；timeSec 为媒体秒） */
export const decodeStabFrame = async (videoPath: string, timeSec: number): Promise<FrameGray> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-stab1-'));
  try {
    await execa(
      getFfmpegPath(),
      ['-ss', String(Math.max(0, timeSec)), '-i', videoPath, '-frames:v', '1',
        '-vf', `scale=${STAB_DEFAULTS.analyzeWidth}:-2`, '-pix_fmt', 'gray', '-vcodec', 'png', path.join(dir, 'f.png')],
      {maxBuffer: 16 * 1024 * 1024},
    );
    const file = path.join(dir, 'f.png');
    if (!fs.existsSync(file)) throw new Error('抽帧失败：ffmpeg 未产出画面');
    return readGrayFrame(file);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

// ====== sidecar 读写 ======

/** 视频路径 → sidecar 路径（<同名>.stab.json，媒体同目录） */
export const stabSidecarPath = (videoPath: string): string =>
  videoPath.replace(/\.[^.\\/]+$/, '') + '.stab.json';

/** 写 sidecar：媒体目录不可写时降级 os.tmpdir，返回实际路径 */
const writeStabSidecar = (videoPath: string, data: StabTrackSidecar): string => {
  const primary = stabSidecarPath(videoPath);
  try {
    fs.writeFileSync(primary, JSON.stringify(data), 'utf8');
    return primary;
  } catch {
    // 降级：tmpdir（只读目录/无权限介质）；文件名带源路径简单散列防撞名
    let hash = 0;
    for (let i = 0; i < videoPath.length; i++) hash = (hash * 31 + videoPath.charCodeAt(i)) >>> 0;
    const fallback = path.join(os.tmpdir(), `${path.basename(primary, '.stab.json')}-${hash.toString(36)}.stab.json`);
    fs.writeFileSync(fallback, JSON.stringify(data), 'utf8');
    return fallback;
  }
};

/** 读 sidecar（不存在/损坏/版本不符返回 null） */
export const readStabTrack = async (trackPath: string): Promise<StabTrackSidecar | null> => {
  try {
    const data = JSON.parse(fs.readFileSync(trackPath, 'utf8')) as StabTrackSidecar;
    if (data?.version !== 1 || !Array.isArray(data.samples) || !Array.isArray(data.points)) return null;
    return data;
  } catch {
    return null;
  }
};

// ====== 分析主流程 ======

/**
 * 逐帧跟踪循环：流式读 PNG（内存只留 prev/curr 两帧，长视频不爆），
 * 每个点对 prev→curr 做金字塔块匹配并累计位置（帧间跟踪）。
 */
const trackPointsOverPngs = (
  dir: string,
  files: string[],
  stride: number,
  points: StabPoint[],
): {tracked: {t: number; x: number; y: number}[][]; confs: number[][]; framesRead: number; analWidth: number; analHeight: number} => {
  const tracked = points.map(() => [] as {t: number; x: number; y: number}[]);
  const confs = points.map(() => [] as number[]);
  const pos = points.map((p) => ({x: p.x, y: p.y}));
  let prev: FrameGray | null = null;
  let framesRead = 0;
  let analWidth = 0;
  let analHeight = 0;
  for (let i = 0; i < files.length; i += stride) {
    const curr = readGrayFrame(path.join(dir, files[i]));
    analWidth = curr.width;
    analHeight = curr.height;
    if (prev) {
      for (let p = 0; p < points.length; p++) {
        const r = trackPatch(prev, curr, pos[p].x, pos[p].y);
        pos[p] = {x: r.nx, y: r.ny};
        tracked[p].push({t: 0, x: r.nx, y: r.ny}); // t 由调用方按帧号回填
        confs[p].push(r.score < -1 ? 0 : Math.max(0, Math.min(1, r.score))); // score=-2 出界哨兵 → conf 0
      }
      framesRead++;
    } else {
      // 首帧：位置=初始点（位移基准），conf 记 1
      for (let p = 0; p < points.length; p++) {
        tracked[p].push({t: 0, x: pos[p].x, y: pos[p].y});
        confs[p].push(1);
      }
      framesRead++;
    }
    prev = curr;
  }
  return {tracked, confs, framesRead, analWidth, analHeight};
};

/**
 * 分析视频稳定：解码 → 跟踪 → 平滑求解 → 写 sidecar。
 * points 为视频像素坐标（1~2 个：单点=平移稳定，双点=平移+旋转+缩放）；
 * 传空数组 = 自动模式：解出区间首帧后 autoPickPoint 选 1 个纹理最强点做平移稳定，
 * 实际用的点体现在返回的 track.points 里（UI/AI 据此回显）。
 */
export const analyzeStabilization = async (
  videoPath: string,
  points: StabPoint[],
  opts: StabAnalyzeOpts = {},
): Promise<StabAnalyzeResult> => {
  if (points.length > 2) throw new Error('跟踪点最多 2 个');
  const meta = await getVideoMetadata(videoPath);
  const srcFps = meta.fps > 0 ? meta.fps : 30;
  const trimStart = Math.max(0, opts.trimStart ?? 0);
  const trimEnd = Math.min(meta.duration > 0 ? meta.duration : Infinity, opts.trimEnd ?? Infinity);
  if (!(trimEnd > trimStart)) throw new Error('分析区间为空（trimStart/trimEnd 无效）');
  const sampleFps = Math.min(opts.maxAnalyzeFps ?? STAB_DEFAULTS.analyzeFps, srcFps);
  const smoothSec = opts.smoothSec ?? STAB_DEFAULTS.smoothSec;
  const maxZoom = opts.maxZoom ?? STAB_DEFAULTS.maxZoom;

  // 自动选点：区间首帧（480 宽分析分辨率）梯度最强块中心 → 换算回视频像素
  if (points.length === 0) {
    const first = await decodeStabFrame(videoPath, trimStart);
    const p = autoPickPoint(first);
    const s = meta.width / first.width;
    points = [{x: Math.round(p.x * s), y: Math.round(p.y * s)}];
  }

  const {dir, files} = await decodeToGrayPngs(videoPath, trimStart, trimEnd);
  try {
    if (files.length < 2) throw new Error('解码帧数不足（视频过短或解码失败）');
    // 无 fps 滤镜：全帧解码后按源帧率等距抽样到分析帧率（footage.ts 同款姿势）
    const stride = Math.max(1, Math.round(srcFps / sampleFps));
    const actualFps = srcFps / stride;

    // 跟踪点：视频像素 → 分析分辨率等比换算（分析宽固定 480，高由解码结果确认）
    const scaleToAnal = STAB_DEFAULTS.analyzeWidth / meta.width;
    const analPoints = points.map((p) => ({x: p.x * scaleToAnal, y: p.y * scaleToAnal}));

    const r = trackPointsOverPngs(dir, files, stride, analPoints);
    const scaleToVideo = meta.width / r.analWidth; // 分析像素 → 视频像素
    const n = r.tracked[0].length;
    for (let p = 0; p < points.length; p++) {
      for (let i = 0; i < n; i++) {
        r.tracked[p][i].t = trimStart + (i * stride) / srcFps;
        r.tracked[p][i].x *= scaleToVideo;
        r.tracked[p][i].y *= scaleToVideo;
      }
    }

    const samples: StabSample[] = buildRawSamples(r.tracked, points, r.confs);
    const solved = solveStabilization(samples, actualFps, {
      smoothSec,
      maxZoom,
      videoWidth: meta.width,
      videoHeight: meta.height,
    });

    const track: StabTrackFile = {
      version: 1,
      videoWidth: meta.width,
      videoHeight: meta.height,
      sourceFps: srcFps,
      sampleFps: actualFps,
      points,
      samples,
    };
    const sidecar: StabTrackSidecar = {...track, smoothSec, maxZoom, zoom: solved.zoom};
    const trackPath = writeStabSidecar(videoPath, sidecar);

    const lost = samples.filter((s) => s.conf < STAB_DEFAULTS.lostThreshold).length;
    const maxCorrectionPx = solved.corrections.reduce((m, c) => Math.max(m, Math.hypot(c.cx, c.cy)), 0);
    const meanConf = samples.length > 0 ? samples.reduce((s, x) => s + x.conf, 0) / samples.length : 0;
    return {
      trackPath,
      track,
      corrections: solved.corrections,
      zoom: solved.zoom,
      smoothSecUsed: solved.smoothSecUsed,
      capped: solved.capped,
      stats: {
        analyzedFrames: n,
        durationSec: trimEnd - trimStart,
        lostRatio: samples.length > 0 ? lost / samples.length : 0,
        maxCorrectionPx: Math.round(maxCorrectionPx * 100) / 100,
        meanConf: Math.round(meanConf * 1000) / 1000,
      },
    };
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

// ====== 进程内缓存（mtime+size 校验，上限 16 条，同 footage.ts 姿势）======

const stabCache = new Map<string, {mtimeMs: number; size: number; result: StabAnalyzeResult}>();
const STAB_CACHE_MAX = 16;

const cacheKeyOf = (videoPath: string, points: StabPoint[], opts: StabAnalyzeOpts): string =>
  JSON.stringify({
    p: videoPath,
    pts: points.map((pt) => [pt.x, pt.y]),
    o: [opts.smoothSec, opts.maxZoom, opts.maxAnalyzeFps, opts.trimStart, opts.trimEnd],
  });

/** 带缓存的分析入口：文件 mtime/size 与全部入参一致则直接命中；IPC 统一走这里 */
export const analyzeStabilizationCached = async (
  videoPath: string,
  points: StabPoint[],
  opts: StabAnalyzeOpts = {},
): Promise<StabAnalyzeResult> => {
  const key = cacheKeyOf(videoPath, points, opts);
  try {
    const st = fs.statSync(videoPath);
    const hit = stabCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
    const result = await analyzeStabilization(videoPath, points, opts);
    stabCache.set(key, {mtimeMs: st.mtimeMs, size: st.size, result});
    if (stabCache.size > STAB_CACHE_MAX) {
      stabCache.delete(stabCache.keys().next().value!);
    }
    return result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`视频不存在：${videoPath}`);
    throw err;
  }
};
