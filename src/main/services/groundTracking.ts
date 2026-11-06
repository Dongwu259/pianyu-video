/**
 * 3D 地面追踪分析服务（见 shared/groundTrack.ts 头注的数学链路）
 *
 * 链路：复用稳定管道的 ffmpeg 灰度解码（480 宽）→ 自动地面选锚（下半画面
 * 梯度能量 + 空间分散）→ 金字塔块匹配逐帧跟踪（带上帧速度外推 searchHint，
 * 走动镜头大位移不跟丢）→ RANSAC 共面筛选 + 跟丢填补 + 逐帧单应残差
 * （shared/groundTrack 纯函数）→ 换算回视频像素写 <同名>.ground.json sidecar。
 *
 * 不 import electron，tsx 可直接跑（单测/e2e 同径）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getVideoMetadata} from './ffprobe.ts';
import {decodeToGrayPngs, readGrayFrame} from './stabilization.ts';
import {trackPatch} from '../../shared/stabilization.ts';
import {
  GROUND_DEFAULTS,
  assembleGroundTrack,
  autoPickGroundAnchors,
  validateGroundTrackFile,
  type GroundTrackFile,
} from '../../shared/groundTrack.ts';

// ====== 类型 ======

export interface GroundAnalyzeOpts {
  maxAnalyzeFps?: number;  // 分析帧率上限，默认 15
  trimStart?: number;      // 只分析该区间（媒体秒），默认 0
  trimEnd?: number;        // 默认全片时长
  candidateAnchors?: number; // 自动选锚数，默认 10
}

export interface GroundAnalyzeStats {
  analyzedFrames: number;   // 采样帧数
  durationSec: number;      // 分析区间时长
  candidateAnchors: number; // 候选锚点数
  keptAnchors: number;      // RANSAC 后幸存锚点数
  rejected: number;         // 剔除数（非共面/坏点）
  lostRatio: number;        // 低置信（锚点×帧）占比
  meanResidualPx: number;   // 逐帧单应重投影平均残差（视频像素）
  meanConf: number;         // 平均置信度
}

export interface GroundAnalyzeResult {
  trackPath: string;   // sidecar 实际落盘路径
  track: GroundTrackFile;
  stats: GroundAnalyzeStats;
  /** 质量黄灯：残差或跟丢超阈值（UI/AI 提示挪点/换素材） */
  warn: boolean;
}

// ====== sidecar 读写 =====

/** 视频路径 → sidecar 路径（<同名>.ground.json，媒体同目录） */
export const groundSidecarPath = (videoPath: string): string =>
  videoPath.replace(/\.[^.\\/]+$/, '') + '.ground.json';

/** 写 sidecar：媒体目录不可写时降级 os.tmpdir（同 stabilization 姿势） */
const writeGroundSidecar = (videoPath: string, data: GroundTrackFile): string => {
  const primary = groundSidecarPath(videoPath);
  try {
    fs.writeFileSync(primary, JSON.stringify(data), 'utf8');
    return primary;
  } catch {
    let hash = 0;
    for (let i = 0; i < videoPath.length; i++) hash = (hash * 31 + videoPath.charCodeAt(i)) >>> 0;
    const fallback = path.join(os.tmpdir(), `${path.basename(primary, '.ground.json')}-${hash.toString(36)}.ground.json`);
    fs.writeFileSync(fallback, JSON.stringify(data), 'utf8');
    return fallback;
  }
};

/** 读 sidecar（不存在/损坏/版本不符返回 null；渲染端加载与 UI 强度重算共用） */
export const readGroundTrack = async (trackPath: string): Promise<GroundTrackFile | null> => {
  try {
    return validateGroundTrackFile(JSON.parse(fs.readFileSync(trackPath, 'utf8')));
  } catch {
    return null;
  }
};

// ====== 分析主流程 =====

/**
 * 逐帧跟踪循环（流式读 PNG，内存留 prev/curr 两帧 + 参考帧）：
 * 每锚点对 prev→curr 金字塔块匹配，帧间累计位置；searchHint = 上一帧位移
 * （速度外推，走动镜头搜索窗跟着走）。
 * 每 REANCHOR_EVERY 个采样帧做一次「回参考帧重定位」：用参考帧模板在当前帧
 * 直接重搜（搜索中心 = 链式位置外推），与链式位置一致（< SNAP_PX）则吸附——
 * 链式匹配的子像素误差会随机游走累积（平滑纹理上 30 帧可漂 4-8px，足以被
 * RANSAC 误杀），周期性绝对定位把漂移按住。
 */
const REANCHOR_EVERY = 4;
const SNAP_PX = 8;

const trackAnchorsOverPngs = (
  dir: string,
  files: string[],
  stride: number,
  anchors: {x: number; y: number}[],
): {tracked: {t: number; x: number; y: number}[][]; confs: number[][]; analWidth: number; analHeight: number} => {
  const tracked = anchors.map(() => [] as {t: number; x: number; y: number}[]);
  const confs = anchors.map(() => [] as number[]);
  const pos = anchors.map((p) => ({x: p.x, y: p.y}));
  const vel = anchors.map(() => ({x: 0, y: 0}));
  let prev: ReturnType<typeof readGrayFrame> | null = null;
  let refFrame: ReturnType<typeof readGrayFrame> | null = null;
  let analWidth = 0;
  let analHeight = 0;
  let sampleIdx = 0;
  for (let i = 0; i < files.length; i += stride) {
    const curr = readGrayFrame(path.join(dir, files[i]));
    analWidth = curr.width;
    analHeight = curr.height;
    if (!refFrame) refFrame = curr;
    if (prev) {
      const patchHalf = 12 + 4; // patchSize/2 + 余量：贴边位置 patch 无法完整入画，NCC 必失真
      const reanchor = sampleIdx % REANCHOR_EVERY === 0 && refFrame;
      for (let p = 0; p < anchors.length; p++) {
        const r = trackPatch(prev, curr, pos[p].x, pos[p].y, {
          searchHint: {x: vel[p].x, y: vel[p].y},
        });
        let nx = r.nx;
        let ny = r.ny;
        let score = r.score;
        if (reanchor) {
          const hint = {x: pos[p].x - anchors[p].x, y: pos[p].y - anchors[p].y};
          const r0 = trackPatch(refFrame, curr, anchors[p].x, anchors[p].y, {searchHint: hint});
          if (r0.score > 0.5 && Math.hypot(r0.nx - nx, r0.ny - ny) < SNAP_PX) {
            nx = r0.nx;
            ny = r0.ny;
            score = Math.max(score, r0.score);
          }
        }
        vel[p] = {x: nx - pos[p].x, y: ny - pos[p].y};
        pos[p] = {x: nx, y: ny};
        tracked[p].push({t: 0, x: nx, y: ny}); // t 由调用方回填
        const nearEdge =
          nx < patchHalf || nx > curr.width - patchHalf ||
          ny < patchHalf || ny > curr.height - patchHalf;
        const conf = score < -1 ? 0 : Math.max(0, Math.min(1, score));
        confs[p].push(nearEdge ? 0 : conf);
      }
      sampleIdx++;
    } else {
      for (let p = 0; p < anchors.length; p++) {
        tracked[p].push({t: 0, x: pos[p].x, y: pos[p].y});
        confs[p].push(1);
      }
      sampleIdx++;
    }
    prev = curr;
  }
  return {tracked, confs, analWidth, analHeight};
};

/**
 * 分析地面跟踪：解码 → 自动选锚 → 跟踪 → RANSAC 共面筛选 → sidecar。
 * 自动模式（默认）：下半画面梯度能量选 candidateAnchors 个分散锚点，
 * 共面性由 RANSAC 单应自验证（用户无需懂「共面」）。
 * 幸存锚点 < 4（地面纹理不足/大幅遮挡）抛中文错误（UI/AI 直接展示）。
 */
export const analyzeGroundTracking = async (
  videoPath: string,
  opts: GroundAnalyzeOpts = {},
): Promise<GroundAnalyzeResult> => {
  const meta = await getVideoMetadata(videoPath);
  const srcFps = meta.fps > 0 ? meta.fps : 30;
  const trimStart = Math.max(0, opts.trimStart ?? 0);
  const trimEnd = Math.min(meta.duration > 0 ? meta.duration : Infinity, opts.trimEnd ?? Infinity);
  if (!(trimEnd > trimStart)) throw new Error('分析区间为空（trimStart/trimEnd 无效）');
  const sampleFps = Math.min(opts.maxAnalyzeFps ?? GROUND_DEFAULTS.analyzeFps, srcFps);

  const {dir, files} = await decodeToGrayPngs(videoPath, trimStart, trimEnd, GROUND_DEFAULTS.analyzeWidth);
  try {
    if (files.length < 3) throw new Error('解码帧数不足（视频过短或解码失败）');
    const stride = Math.max(1, Math.round(srcFps / sampleFps));
    const actualFps = srcFps / stride;

    // 自动选锚：首帧（分析分辨率）
    const first = readGrayFrame(path.join(dir, files[0]));
    const candidates = autoPickGroundAnchors(first, {count: opts.candidateAnchors});
    if (candidates.length < GROUND_DEFAULTS.minAnchors) {
      throw new Error(`地面纹理不足：仅找到 ${candidates.length} 个可用锚点（需 ≥4），建议换纹理更丰富的画面段落`);
    }

    const r = trackAnchorsOverPngs(dir, files, stride, candidates);
    const nFrames = r.tracked[0].length;
    for (let p = 0; p < candidates.length; p++) {
      for (let i = 0; i < nFrames; i++) {
        r.tracked[p][i].t = trimStart + (i * stride) / srcFps;
      }
    }

    // 组装（分析分辨率，阈值同单位）→ 换算视频像素
    const assembled = assembleGroundTrack(r.tracked, r.confs);
    if (!assembled) {
      throw new Error('无法确定地面平面：共面锚点不足 4 个（画面可能是纯色地面/大遮挡，换个段落或手动放点重试）');
    }
    const scaleToVideo = meta.width / r.analWidth;
    const anchorsVideo = assembled.anchors.map((p) => ({
      x: Math.round(p.x * scaleToVideo * 100) / 100,
      y: Math.round(p.y * scaleToVideo * 100) / 100,
    }));
    const samples = assembled.samples.map((s) => ({
      t: Math.round(s.t * 1000) / 1000,
      pts: s.pts.map((p) => ({
        x: Math.round(p.x * scaleToVideo * 100) / 100,
        y: Math.round(p.y * scaleToVideo * 100) / 100,
      })),
      conf: Math.round(s.conf * 1000) / 1000,
      confs: s.confs,
    }));

    // lostRatio：低置信（锚点×帧）占比
    let lowCount = 0;
    let total = 0;
    let confSum = 0;
    for (let p = 0; p < r.tracked.length; p++) {
      for (let i = 0; i < nFrames; i++) {
        total++;
        const c = r.confs[p][i];
        if (c < GROUND_DEFAULTS.lostThreshold) lowCount++;
        confSum += c;
      }
    }
    const lostRatio = total > 0 ? lowCount / total : 0;
    const meanConf = total > 0 ? confSum / total : 0;
    const meanResidualPx = Math.round(assembled.meanResidualPx * scaleToVideo * 100) / 100;

    const track: GroundTrackFile = {
      version: 1,
      videoWidth: meta.width,
      videoHeight: meta.height,
      sourceFps: srcFps,
      sampleFps: actualFps,
      anchors: anchorsVideo,
      anchorConf: assembled.anchorConf,
      samples,
      quality: {
        lostRatio: Math.round(lostRatio * 1000) / 1000,
        meanResidualPx,
        rejected: assembled.rejected,
      },
    };
    const trackPath = writeGroundSidecar(videoPath, track);
    const warn =
      meanResidualPx > GROUND_DEFAULTS.warnResidualPx ||
      lostRatio > GROUND_DEFAULTS.warnLostRatio ||
      anchorsVideo.length < 5; // 恰好 4 锚点：残差无信息量（4 点总可精确拟合），保守黄灯
    return {
      trackPath,
      track,
      warn,
      stats: {
        analyzedFrames: nFrames,
        durationSec: trimEnd - trimStart,
        candidateAnchors: candidates.length,
        keptAnchors: anchorsVideo.length,
        rejected: assembled.rejected,
        lostRatio: Math.round(lostRatio * 1000) / 1000,
        meanResidualPx,
        meanConf: Math.round(meanConf * 1000) / 1000,
      },
    };
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

// ====== 进程内缓存（mtime+size 校验，上限 8 条，同 stabilization 姿势）======

const groundCache = new Map<string, {mtimeMs: number; size: number; result: GroundAnalyzeResult}>();
const GROUND_CACHE_MAX = 8;

/** 带缓存的分析入口：文件 mtime/size 与入参一致则直接命中；IPC 统一走这里 */
export const analyzeGroundTrackingCached = async (
  videoPath: string,
  opts: GroundAnalyzeOpts = {},
): Promise<GroundAnalyzeResult> => {
  const key = JSON.stringify({p: videoPath, o: [opts.maxAnalyzeFps, opts.trimStart, opts.trimEnd, opts.candidateAnchors]});
  try {
    const st = fs.statSync(videoPath);
    const hit = groundCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.result;
    const result = await analyzeGroundTracking(videoPath, opts);
    groundCache.set(key, {mtimeMs: st.mtimeMs, size: st.size, result});
    if (groundCache.size > GROUND_CACHE_MAX) {
      groundCache.delete(groundCache.keys().next().value!);
    }
    return result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`视频不存在：${videoPath}`);
    throw err;
  }
};
