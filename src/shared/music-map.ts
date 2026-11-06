/**
 * 音乐结构图（music-map）——剪辑大脑的「音乐理解」层
 *
 * 在 beat-detect（节拍网格）之上补齐三件事：
 * 1. 能量曲线：每拍一个能量值（该拍区间的 RMS，按全曲 90 分位归一到 0..1）——
 *    「副歌密、铺垫稀」的量化依据；
 * 2. 重拍（downbeat）：4/4 假设下按起振强度选相位，小节头 = 结构切点的候选锚点
 *    （段落边界吸附到重拍，切点才落在乐句上而不是半句中间）；
 * 3. 段落（sections）：能量经 ±2 小节平滑后做迟滞穿越分割，边界吸附重拍、
 *    最短 4 小节合并，按相对能量打标签（intro/build/drop/break/outro）。
 *
 * 全部纯函数（与 beat-detect 同一份 8kHz PCM 口径），Node 可直跑单测。
 * 未检出节拍时退化为「全曲一段 build + 仅能量曲线」，调用方照常可用。
 */

import {detectBeatsFromSamples, type BeatDetection} from './beat-detect.ts';

export type SectionLabel = 'intro' | 'build' | 'drop' | 'break' | 'outro';

export interface MusicSection {
  startSec: number;
  endSec: number;
  /** 段内平均能量 0..1（相对全曲 90 分位） */
  energy: number;
  label: SectionLabel;
}

export interface MusicMap {
  bpm: number;
  beats: number[];
  downbeats: number[];
  /** 小节时长（4 拍，秒；无节拍时 0） */
  barSec: number;
  /** 每拍能量（与 beats 对齐：beats[i] 到 beats[i+1] 区间的归一化能量；末拍到曲尾） */
  beatEnergies: number[];
  /** 每拍 kick（底鼓）强度 0..1，与 beats 对齐（分频段检测，见 beat-bands.ts；由 analyzeMusicMap 填充） */
  beatKicks?: number[];
  /** 每拍 snare/hat（军鼓/镲）强度 0..1，与 beats 对齐（同 beatKicks） */
  beatSnares?: number[];
  sections: MusicSection[];
  durationSec: number;
}

const SR = 8000;
/** 能量帧步长（采样点）：25ms 一帧，比 beat-detect 的 8ms 省算且对段落足够 */
const ENERGY_HOP = 200;
const ENERGY_WIN = 400;

/** 重采样到 8k（与 beat-detect 同款线性抽取，口径一致） */
const to8k = (samples: Float32Array, sampleRate: number): Float32Array => {
  if (sampleRate === SR) return samples;
  const ratio = sampleRate / SR;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)];
  return out;
};

/** RMS 能量帧序列（不做对数压缩——段落比较要保留响度比例） */
const energyFrames = (s: Float32Array): number[] => {
  const n = Math.max(0, Math.floor((s.length - ENERGY_WIN) / ENERGY_HOP) + 1);
  const out = new Array<number>(n);
  for (let f = 0; f < n; f++) {
    const start = f * ENERGY_HOP;
    let sum = 0;
    for (let i = start; i < start + ENERGY_WIN; i++) sum += s[i] * s[i];
    out[f] = Math.sqrt(sum / ENERGY_WIN);
  }
  return out;
};

const frameSec = ENERGY_HOP / SR;

const energyAt = (frames: number[], t0: number, t1: number): number => {
  const a = Math.max(0, Math.floor(t0 / frameSec));
  const b = Math.min(frames.length, Math.ceil(t1 / frameSec));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += frames[i];
  return sum / (b - a);
};

const percentile = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** 重拍相位：4/4 假设，逐拍能量（用起振强度更准，但拍区间能量已够用）选最强相位 */
const estimateDownbeats = (beats: number[], beatEnergies: number[]): number[] => {
  if (beats.length < 8) return [];
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let score = 0;
    let n = 0;
    for (let i = phase; i < beats.length; i += 4) {
      score += beatEnergies[i] ?? 0;
      n++;
    }
    if (n > 0 && score / n > bestScore) {
      bestScore = score / n;
      bestPhase = phase;
    }
  }
  return beats.filter((_, i) => i % 4 === bestPhase);
};

/** 段落标签：按全曲各段能量的分布（均值±标准差）打标，避免绝对阈值对响度风格敏感 */
const labelSections = (sections: Array<Omit<MusicSection, 'label'>>): MusicSection[] => {
  const n = sections.length;
  const mean = sections.reduce((a, s) => a + s.energy, 0) / n;
  const std = Math.sqrt(sections.reduce((a, s) => a + (s.energy - mean) ** 2, 0) / n);
  return sections.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === n - 1;
    let label: SectionLabel = 'build';
    if (isFirst && s.energy < mean - 0.5 * std) label = 'intro';
    else if (isLast && s.energy < mean - 0.5 * std) label = 'outro';
    else if (s.energy >= mean + 0.4 * std) label = 'drop';
    else if (s.energy <= mean - 0.6 * std) label = 'break';
    return {...s, label};
  });
};

/**
 * 主入口：PCM → 音乐结构图。
 * @param det 可选已有的节拍检测结果（避免重复跑 detectBeatsFromSamples）
 */
export const buildMusicMapFromSamples = (
  rawSamples: Float32Array,
  sampleRate: number,
  det?: BeatDetection,
): MusicMap => {
  const s = to8k(rawSamples, sampleRate);
  const durationSec = s.length / SR;
  const frames = energyFrames(s);
  const detection = det ?? detectBeatsFromSamples(s, SR);
  const beats = detection?.beats ?? [];
  const bpm = detection?.bpm ?? 0;

  if (frames.length === 0) {
    return {bpm, beats, downbeats: [], barSec: 0, beatEnergies: [], sections: [], durationSec};
  }
  const norm = percentile(frames, 90) || 1e-6;

  // 每拍能量（末拍到曲尾）
  const beatEnergies = beats.map((b, i) => {
    const t1 = i + 1 < beats.length ? beats[i + 1] : durationSec;
    return Math.min(1, energyAt(frames, b, t1) / norm);
  });

  const downbeats = estimateDownbeats(beats, beatEnergies);
  const barSec = beats.length >= 5
    ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) * 4
    : 0;

  // ---- 段落分割：拍能量 ±2 小节平滑 → 迟滞穿越 → 边界吸重拍 → 最短 4 小节合并 ----
  const sections: MusicSection[] = [];
  if (beats.length < 16 || barSec <= 0) {
    // 无可靠节拍：全曲一段（能量照给，调用方仍能按能量决策）
    const e = Math.min(1, energyAt(frames, 0, durationSec) / norm);
    return {
      bpm, beats, downbeats, barSec,
      beatEnergies,
      sections: [{startSec: 0, endSec: durationSec, energy: e, label: 'build'}],
      durationSec,
    };
  }

  const beatsPerBar = 4;
  const smoothWin = 2 * beatsPerBar; // ±2 小节
  const smoothed = beatEnergies.map((_, i) => {
    const a = Math.max(0, i - smoothWin);
    const b = Math.min(beatEnergies.length, i + smoothWin + 1);
    let sum = 0;
    for (let j = a; j < b; j++) sum += beatEnergies[j];
    return sum / (b - a);
  });
  const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
  const hi = mean * 1.15;
  const lo = mean * 0.85;

  // 迟滞穿越：上穿 hi 记高态、下穿 lo 记低态，状态翻转处为候选边界（拍索引）
  const candidates: number[] = [];
  let high = smoothed[0] > mean;
  for (let i = 1; i < smoothed.length; i++) {
    if (!high && smoothed[i] > hi) { candidates.push(i); high = true; }
    else if (high && smoothed[i] < lo) { candidates.push(i); high = false; }
  }
  // 吸附到最近重拍（无重拍则吸附到最近的 4 的整数倍拍）
  const snapBeat = (beatIdx: number): number => {
    if (downbeats.length > 0) {
      const t = beats[beatIdx];
      let best = downbeats[0];
      for (const d of downbeats) if (Math.abs(d - t) < Math.abs(best - t)) best = d;
      return best;
    }
    const snapped = Math.round(beatIdx / beatsPerBar) * beatsPerBar;
    return beats[Math.min(beats.length - 1, snapped)];
  };
  const boundaries = [0, ...candidates.map(snapBeat).filter((t) => t > 0.05 && t < durationSec - 0.05), durationSec]
    .filter((v, i, a) => i === 0 || v > a[i - 1] + 0.01); // 去重

  // 最短 4 小节合并（太短的段并进能量更高的邻居）
  const minSec = 4 * barSec;
  const merged: Array<{startSec: number; endSec: number}> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    merged.push({startSec: boundaries[i], endSec: boundaries[i + 1]});
  }
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i].endSec - merged[i].startSec < minSec) {
        const e = (m: {startSec: number; endSec: number}) => energyAt(frames, m.startSec, m.endSec);
        const self = e(merged[i]);
        const left = i > 0 ? e(merged[i - 1]) : -1;
        const right = i < merged.length - 1 ? e(merged[i + 1]) : -1;
        if (left < 0 && right < 0) break;
        if (right >= left) {
          merged[i].endSec = merged[i + 1].endSec;
          merged.splice(i + 1, 1);
        } else {
          merged[i - 1].endSec = merged[i].endSec;
          merged.splice(i, 1);
        }
        changed = true;
        break;
      }
    }
  }

  const unlabeled: Array<Omit<MusicSection, 'label'>> = [];
  for (const m of merged) {
    const e = Math.min(1, energyAt(frames, m.startSec, m.endSec) / norm);
    unlabeled.push({startSec: m.startSec, endSec: m.endSec, energy: e});
  }
  sections.push(...labelSections(unlabeled));

  return {bpm, beats, downbeats, barSec, beatEnergies, sections, durationSec};
};
