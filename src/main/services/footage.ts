/**
 * 素材画面分析（footage）——剪辑大脑的「画面理解」层
 *
 * 从视频素材一次解码 pass 产出两样排片信号（无需 scene/vidstab 滤镜——Remotion
 * 精简 ffmpeg 只有 scale/trim 等基础滤镜，见 compositor 滤镜清单）：
 * 1. 镜头边界：相邻采样帧的亮度差分能量，突变尖峰 = 切镜（自适应门限 + 最短镜头约束）；
 * 2. 运动强度：差分能量的窗口中位数，按全片 90 分位归一 0..1——
 *    「动作大/画面稳」的量化依据，供 edit-brain 匹配音乐段落能量。
 *
 * 实现：Remotion 自带 ffmpeg 整片解成 96×54 灰度 PNG 序列（image2 序号出图 +
 * png 编码器可用、fps 滤镜不可用，故全帧解码后按源 fps 等距抽样 ~6fps），
 * pngjs 纯 JS 解码算差分——全链路无 Electron 依赖，tsx 可直接跑（单测/e2e 同径）。
 */

import execa from 'execa';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {RenderInternals} from '@remotion/renderer';
import {getVideoMetadata} from './ffprobe';

// ====== 类型 ======

export interface FootageShot {
  startSec: number;
  endSec: number;
  /** 运动强度 0..1（相对全片 90 分位归一） */
  motionScore: number;
}

export interface FootageMap {
  durationSec: number;
  /** 采样率（每秒能量点数） */
  sampleFps: number;
  /** 运动能量曲线（0..1，长度为 durationSec*sampleFps 量级） */
  energies: number[];
  shots: FootageShot[];
}

// ====== 纯函数（可单测）======

/** PNG RGBA 数据 → 灰度（gray 源 R=G=B，取 R 通道即可） */
export const grayOfPng = (rgba: Buffer): Float32Array => {
  const n = Math.floor(rgba.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4];
  return out;
};

/** 相邻帧平均亮度差（0..255）序列 */
export const frameDiffs = (frames: Float32Array[]): number[] => {
  const diffs: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let j = 0; j < n; j++) sum += Math.abs(b[j] - a[j]);
    diffs.push(sum / n);
  }
  return diffs;
};

const median = (arr: number[]): number => {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentile = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/**
 * 镜头边界（采样点索引，含 0 与末尾 len）：差分 > max(中位数×3, 全局90分位×0.6) 处，
 * 两边界间距 ≥ minShotSamples（最短镜头防抖）。
 */
export const findShotBoundaries = (diffs: number[], minShotSamples: number): number[] => {
  if (diffs.length === 0) return [0];
  const med = median(diffs);
  const p90 = percentile(diffs, 90);
  const threshold = Math.max(med * 3, p90 * 0.6, 8); // 8/255 防全静态素材全片碎切
  const cuts: number[] = [];
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i] > threshold) {
      // 差分 i 是帧 i 与 i+1 之间 → 边界在采样点 i+1
      if (cuts.length === 0 || i + 1 - cuts[cuts.length - 1] >= minShotSamples) {
        cuts.push(i + 1);
      }
    }
  }
  return [0, ...cuts, diffs.length];
};

/** 边界 + 差分 → 镜头表（能量按 90 分位归一 0..1） */
export const buildShots = (
  boundaries: number[],
  diffs: number[],
  sampleFps: number,
  durationSec: number,
): FootageShot[] => {
  const norm = percentile(diffs, 90) || 1e-6;
  const shots: FootageShot[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i];
    const b = boundaries[i + 1];
    // 镜头内运动 = 该区间差分的中位数（对偶发尖峰鲁棒）
    const seg = diffs.slice(a, Math.max(a, b - 1));
    const motion = Math.min(1, median(seg) / norm);
    shots.push({
      startSec: a / sampleFps,
      endSec: Math.min(durationSec, b / sampleFps),
      motionScore: Math.round(motion * 100) / 100,
    });
  }
  return shots;
};

// ====== 主进程服务 ======

const getFfmpegPath = (): string =>
  RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
  });

const ANALYZE_W = 96;
const ANALYZE_H = 54;
const SAMPLE_FPS = 6;

/**
 * 分析结果缓存（path → mtime/size 校验）：footage 分析要整片解码，同一素材在
 * get_footage_map → auto_beat_montage 等连续调用间会被重复分析，缓存把第二次变成零成本。
 */
const analyzeCache = new Map<string, {mtimeMs: number; size: number; map: FootageMap}>();
const ANALYZE_CACHE_MAX = 32;

/**
 * 分析视频素材：镜头边界 + 运动强度曲线。
 * 长素材自动降采样率（>120s 时 3fps），控制解码量。
 */
export const analyzeFootage = async (filePath: string): Promise<FootageMap> => {
  const meta = await getVideoMetadata(filePath);
  const durationSec = meta.duration > 0 ? meta.duration : 0;
  const srcFps = meta.fps > 0 ? meta.fps : 30;
  const sampleFps = durationSec > 120 ? 3 : SAMPLE_FPS;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-footage-'));
  try {
    const ffmpeg = getFfmpegPath();
    await execa(
      ffmpeg,
      ['-i', filePath, '-vf', `scale=${ANALYZE_W}:${ANALYZE_H}`, '-pix_fmt', 'gray', '-vcodec', 'png', path.join(dir, 'f-%05d.png')],
      {maxBuffer: 16 * 1024 * 1024},
    );
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    if (files.length === 0) {
      return {durationSec, sampleFps, energies: [], shots: durationSec > 0 ? [{startSec: 0, endSec: durationSec, motionScore: 0}] : []};
    }

    // 等距抽样到 sampleFps（无 fps 滤镜，全帧解码后 JS 抽样）
    const stride = Math.max(1, Math.round(srcFps / sampleFps));
    const picked: Float32Array[] = [];
    for (let i = 0; i < files.length; i += stride) {
      const png = PNG.sync.read(fs.readFileSync(path.join(dir, files[i])));
      picked.push(grayOfPng(png.data));
    }
    if (picked.length < 2) {
      return {durationSec, sampleFps, energies: [], shots: durationSec > 0 ? [{startSec: 0, endSec: durationSec, motionScore: 0}] : []};
    }

    const diffs = frameDiffs(picked);
    const norm = percentile(diffs, 90) || 1e-6;
    const energies = diffs.map((d) => Math.min(1, Math.round((d / norm) * 100) / 100));
    const boundaries = findShotBoundaries(diffs, Math.max(2, Math.round(sampleFps * 0.8))); // 最短镜头 0.8s
    const shots = buildShots(boundaries, diffs, sampleFps, durationSec || picked.length / sampleFps);
    return {durationSec, sampleFps, energies, shots};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

/** 带缓存的分析入口：文件 mtime/size 未变则直接命中；IPC 统一走这里 */
export const analyzeFootageCached = async (filePath: string): Promise<FootageMap> => {
  try {
    const st = fs.statSync(filePath);
    const hit = analyzeCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.map;
    const map = await analyzeFootage(filePath);
    analyzeCache.set(filePath, {mtimeMs: st.mtimeMs, size: st.size, map});
    if (analyzeCache.size > ANALYZE_CACHE_MAX) {
      analyzeCache.delete(analyzeCache.keys().next().value!);
    }
    return map;
  } catch {
    return analyzeFootage(filePath);
  }
};
