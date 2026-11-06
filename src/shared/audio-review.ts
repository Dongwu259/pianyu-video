/**
 * 音频审片（analyze_render_audio）——ffmpeg 输出解析与文案比对（纯函数，Node 可直跑单测）。
 *
 * 三路 ffmpeg 探测的 stderr 解析 + ASR 转写与文案的相似度：
 * - volumedetect：mean_volume / max_volume（爆音疑似 max > PEAK_CLIP_DB）
 * - silencedetect：静音区间列表（>0.8s 视为问题；首尾 0.3s 容差不算）
 * - loudnorm JSON：input_i 综合响度（与 -14 LUFS 目标差值）；volumedetect 缺失时
 *   用 input_tp 真峰值兜底爆音判定（同一 PEAK_CLIP_DB 阈值，两条路径口径一致）
 * 文案比对用字符级相似度（中文友好：剥标点空白后取 bigram Jaccard + 缺字清单）。
 */

/** 爆音疑似阈值（dB）：采样峰值（volumedetect）与真峰值（loudnorm input_tp）共用 */
export const PEAK_CLIP_DB = -0.5;

export interface LoudnessInfo {integrated: number | null; target: number; ok: boolean | null}
export interface PeakInfo {meanDb: number | null; maxDb: number | null; clippingSuspected: boolean | null}
export interface SilenceSpan {start: number; end: number; duration: number}

export const parseVolumeDetect = (stderr: string): PeakInfo => {
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr);
  const meanDb = mean ? parseFloat(mean[1]) : null;
  const maxDb = max ? parseFloat(max[1]) : null;
  return {
    meanDb,
    maxDb,
    clippingSuspected: maxDb === null ? null : maxDb > PEAK_CLIP_DB,
  };
};

export const parseSilenceDetect = (stderr: string): SilenceSpan[] => {
  const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)]
    .map((m) => parseFloat(m[1]));
  const spans: SilenceSpan[] = [];
  for (const s of starts) {
    const e = ends.find((x) => x >= s);
    if (e === undefined) continue;
    spans.push({start: Math.max(0, s), end: e, duration: Math.round((e - Math.max(0, s)) * 100) / 100});
  }
  return spans;
};

/** 过滤有效问题静音：>minSec 且不在首尾容差内 */
export const meaningfulSilences = (spans: SilenceSpan[], totalSec: number, minSec = 0.8, edgeTolerance = 0.3): SilenceSpan[] =>
  spans.filter((s) => s.duration >= minSec && s.start > edgeTolerance && s.end < totalSec - edgeTolerance);

export const parseLoudnormProbe = (stderr: string): LoudnessInfo => {
  const m = /"input_i"\s*:\s*"?(-?[\d.]+)"?/.exec(stderr);
  if (!m) return {integrated: null, target: -14, ok: null};
  const integrated = parseFloat(m[1]);
  // 极端值（-inf/-70 等近乎无声）ffmpeg 会给字符串，正则已排除非数字
  return {integrated, target: -14, ok: Math.abs(integrated - -14) <= 1.5};
};

/** loudnorm 探测里的真峰值（input_tp，dBTP）；volumedetect 在 Remotion 精简 ffmpeg 中
 *  不存在（实测 No such filter），峰值/爆音判定用它兜底 */
export const parseLoudnormTp = (stderr: string): number | null => {
  const m = /"input_tp"\s*:\s*"?(-?[\d.]+)"?/.exec(stderr);
  return m ? parseFloat(m[1]) : null;
};

// ====== ASR 转写 vs 文案比对（中文友好） ======

/** 归一化：剥空白/标点，转小写（中文无大小写，英文统一） */
export const normalizeForCompare = (text: string): string =>
  (text || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** 字符 bigram Jaccard 相似度 0..1（单字符串退化为字符集 Jaccard） */
export const textSimilarity = (a: string, b: string): number => {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string): Set<string> => {
    if (s.length === 1) return new Set([s]);
    const g = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter / (gx.size + gy.size - inter);
};

/** 文案里的「关键词」在转写中缺失的清单（按原文空白切词；中文整句按 4 字滑窗降级） */
export const missingKeywords = (script: string, transcript: string, limit = 8): string[] => {
  const t = normalizeForCompare(transcript);
  const words = (script || '').split(/[\s，。、；：,.;:！？!?\n]+/).map((w) => w.trim()).filter((w) => w.length >= 2);
  const missing: string[] = [];
  for (const w of words) {
    if (missing.length >= limit) break;
    const nw = normalizeForCompare(w);
    if (!nw) continue;
    // 中文长词直接查；查不到再按 4 字滑窗降级（ASR 常有局部错字）
    if (t.includes(nw)) continue;
    if (nw.length > 4) {
      let hit = false;
      for (let i = 0; i + 4 <= nw.length && !hit; i++) {
        if (t.includes(nw.slice(i, i + 4))) hit = true;
      }
      if (hit) continue;
    }
    if (!missing.includes(w)) missing.push(w);
  }
  return missing;
};

// ====== 汇总报告 ======

export interface AudioReviewReport {
  loudness: LoudnessInfo;
  peak: PeakInfo;
  /** 有问题的静音段（已过滤首尾容差） */
  problemSilences: SilenceSpan[];
  asr?: {
    transcript: string;
    similarity: number;
    missingKeywords: string[];
  };
  durationSec: number;
}

/** 人类/AI 可读的问题摘要（无问题时返回空数组） */
export const audioReviewIssues = (r: AudioReviewReport): string[] => {
  const issues: string[] = [];
  if (r.loudness.ok === false) {
    issues.push(`综合响度 ${r.loudness.integrated} LUFS 偏离 -14 目标超过 1.5（渲染时开启「响度归一化」即可修复）`);
  }
  if (r.peak.clippingSuspected) {
    issues.push(`峰值 ${r.peak.maxDb}dB 疑似爆音（超过 ${PEAK_CLIP_DB}dB 安全线），建议降低素材/BGM 音量后重渲`);
  }
  for (const s of r.problemSilences) {
    issues.push(`${s.start}s-${s.end}s 存在 ${s.duration}s 静音段（中段长时间无声会显得断片）`);
  }
  if (r.asr && r.asr.similarity < 0.6) {
    issues.push(`旁白与文案相似度仅 ${(r.asr.similarity * 100).toFixed(0)}%（缺失词：${r.asr.missingKeywords.join('、') || '无'}），可能有漏读/错读`);
  }
  return issues;
};
