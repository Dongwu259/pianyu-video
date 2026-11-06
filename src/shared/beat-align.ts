/**
 * 节拍对齐（纯函数，无运行时依赖，Node 可直跑单测）。
 *
 * 节拍来源有两代：新工程直接用音频分析产出的 bgm.beats（真实节拍网格，
 * shared/beat-detect 检测、帧级精度）；旧工程/未分析的 BGM 只有 240 桶波形峰值，
 * 回退到 detectBeats 从峰值近似（分辨率有限，仅保兼容）。统一入口 getBgmBeats。
 *
 * 使用方：projectStore.alignSegmentsToBeats（BgmPanel「卡点对齐」按钮 + align_beats 工具）。
 */

/** BGM 侧节拍数据的最小结构（BgmTrack 的子集） */
export interface BeatSource {
  peaks?: number[];
  duration: number;
  beats?: number[];
}

/** 取 BGM 节拍：优先用分析产出的 beats 网格，缺失时回退旧峰值检测 */
export const getBgmBeats = (bgm: BeatSource | null | undefined): number[] => {
  if (!bgm) return [];
  if (Array.isArray(bgm.beats) && bgm.beats.length > 0) return bgm.beats;
  if (Array.isArray(bgm.peaks) && bgm.peaks.length >= 3 && bgm.duration > 0) {
    return detectBeats(bgm.peaks, bgm.duration);
  }
  return [];
};

export interface SnapResult {
  /** 吸附后的各段时长（最后一段不调整：片尾边界由内容决定且有淡出收尾） */
  durations: number[];
  /** 实际发生移动的切点数量 */
  movedCount: number;
}

/**
 * 从波形峰值检测节拍时间（秒）。
 * 规则：局部极大值且幅度 ≥ 55% 全局峰值；相邻节拍最小间隔 0.3s（贪心从左到右接受）。
 */
export const detectBeats = (peaks: number[], durationSec: number): number[] => {
  if (!Array.isArray(peaks) || peaks.length < 3 || !(durationSec > 0)) return [];
  const maxPeak = Math.max(...peaks);
  if (maxPeak <= 0) return [];
  const bucketDur = durationSec / peaks.length;
  const threshold = maxPeak * 0.55;
  const MIN_GAP = 0.3;
  const beats: number[] = [];
  for (let i = 1; i < peaks.length - 1; i++) {
    if (peaks[i] < threshold) continue;
    if (peaks[i] < peaks[i - 1] || peaks[i] <= peaks[i + 1]) continue; // 严格局部峰（右邻取 < 允许平台左沿）
    const t = (i + 0.5) * bucketDur;
    if (beats.length === 0 || t - beats[beats.length - 1] >= MIN_GAP) {
      beats.push(t);
    }
  }
  return beats;
};

/**
 * 把各段累计边界依次吸附到最近节拍。
 * 顺序推进：每段边界吸附成功后，后续边界从吸附后的时间继续累计（保证每个切点都能压拍）。
 * 只有距节拍 ≤ tolerance 的边界才会移动；片尾边界不吸附。
 */
export const snapDurationsToBeats = (
  durations: number[],
  beats: number[],
  opts?: {min?: number; max?: number; tolerance?: number},
): SnapResult | null => {
  if (!Array.isArray(durations) || durations.length === 0 || beats.length === 0) return null;
  const min = opts?.min ?? 1;
  const max = opts?.max ?? 30;
  const tolerance = opts?.tolerance ?? 0.6;

  const out = durations.slice();
  let movedCount = 0;
  let prevBoundary = 0; // 上一段边界（吸附后）
  for (let i = 0; i < out.length - 1; i++) {
    const boundary = prevBoundary + out[i];
    // 最近节拍
    let best: number | null = null;
    for (const b of beats) {
      if (best === null || Math.abs(b - boundary) < Math.abs(best - boundary)) best = b;
    }
    if (best !== null && Math.abs(best - boundary) <= tolerance) {
      const newDur = Math.min(max, Math.max(min, best - prevBoundary));
      if (Math.abs(newDur - out[i]) > 1e-6) {
        out[i] = newDur;
        movedCount++;
      }
    }
    prevBoundary += out[i];
  }
  return {durations: out, movedCount};
};

// ====== 转场时长吸附节拍 ======

import {getTransitionDefaultSec, snapTransitionSecToBeats} from './transition-style';
import type {Segment} from './types';

/** 中位节拍间隔（秒）；节拍少于 3 个时不稳定，返回 null */
const medianBeatSec = (beats: number[]): number | null => {
  if (beats.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const g = beats[i] - beats[i - 1];
    if (g > 0.1 && g < 3) gaps.push(g); // 忽略静音跳变
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
};

export interface TransitionSnapResult {
  /** 吸附后的各段 durationSec（'none' 硬切为 0，不参与） */
  durations: number[];
  movedCount: number;
}

/**
 * 把各段转场时长吸附到节拍的半拍网格（卡点剪辑里转场与切点一样踩拍：
 * 吸附后转场收束点落在半拍上，视觉节奏与音乐网格对齐）。
 * 节拍不足时返回 null（调用方跳过，不影响切点吸附）。
 */
export const snapTransitionsToBeats = (
  segs: Array<Pick<Segment, 'transition' | 'transitionParams'>>,
  beats: number[],
): TransitionSnapResult | null => {
  const beatSec = medianBeatSec(beats);
  if (!beatSec) return null;
  let movedCount = 0;
  const durations = segs.map((s) => {
    if (s.transition === 'none') return 0;
    const cur = s.transitionParams?.durationSec ?? getTransitionDefaultSec(s.transition);
    const snapped = snapTransitionSecToBeats(cur, beatSec);
    if (Math.abs(snapped - cur) > 0.02) movedCount++;
    return snapped;
  });
  return {durations, movedCount};
};
