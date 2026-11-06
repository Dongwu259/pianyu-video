/**
 * 高光挖矿（mine_highlights）——共享纯逻辑，渲染端执行器 / 主进程服务 / 单测共用。
 *
 * 流水线分工：
 * - 主进程（services/highlightMining.ts）：ffmpeg silencedetect 探静音 + 可选 ASR
 *   分块转写，产出「素材时间线」（时长 / 语音窗口 / ASR 分段）；
 * - 本模块：把 ASR 分段聚成话题块、组装挖矿提示词、防御性解析模型回复；
 * - 渲染端执行器：抽帧给多模态模型 + 调 LLM 选高光，产出带理由的保留区间；
 * - apply_cut_list：把保留区间换算成 VideoClip 的 trim + cuts（挖段无缝拼接）。
 *
 * 全部纯函数，不 import 运行时依赖。
 */

import type {ClipCut} from './clipCuts';
import type {AsrVerboseSegment} from './asr';

/** ASR 原始分段（媒体绝对秒；主进程 asr.ts 的 transcribeMediaRaw 产出） */
export type RawAsrSegment = AsrVerboseSegment;

/** 语音聚类：ASR 分段按间隙合并成的话题块（LLM 判断内容重要性的最小单元） */
export interface SpeechCluster {
  startSec: number;
  endSec: number;
  /** 本块拼接后的转写文本（可能截断） */
  text: string;
}

/** 提示词里单个聚类转写文本的截断上限（控 token） */
const CLUSTER_TEXT_LIMIT = 160;

/**
 * ASR 分段 → 话题块：相邻分段间隙 ≤ maxGapSec 合并为一块。
 * 短于 minClusterSec 的块丢弃（嗯/啊式的碎句没有独立价值，时间线索由窗口兜底）。
 */
export const buildSpeechClusters = (
  segments: RawAsrSegment[],
  opts?: {maxGapSec?: number; minClusterSec?: number},
): SpeechCluster[] => {
  const maxGap = opts?.maxGapSec ?? 1.2;
  const minLen = opts?.minClusterSec ?? 0.8;
  // AsrVerboseSegment 用 start/end；聚类内部统一成 startSec/endSec
  const valid = segments
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text.trim())
    .sort((a, b) => a.start - b.start);
  const clusters: SpeechCluster[] = [];
  for (const s of valid) {
    const last = clusters[clusters.length - 1];
    if (last && s.start - last.endSec <= maxGap) {
      last.endSec = Math.max(last.endSec, s.end);
      if (last.text.length < CLUSTER_TEXT_LIMIT) {
        last.text = (last.text + s.text.trim()).slice(0, CLUSTER_TEXT_LIMIT);
      }
    } else {
      clusters.push({startSec: s.start, endSec: s.end, text: s.text.trim().slice(0, CLUSTER_TEXT_LIMIT)});
    }
  }
  return clusters.filter((c) => c.endSec - c.startSec >= minLen);
};

/** 静音区间（秒）→ 语音窗口（补集，钳到 [0, durationSec]，过滤零长窗口） */
export const speechWindowsFromSilences = (
  silences: {start: number; end: number}[],
  durationSec: number,
): {startSec: number; endSec: number}[] => {
  const spans = silences
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const windows: {startSec: number; endSec: number}[] = [];
  let cursor = 0;
  for (const s of spans) {
    const start = Math.max(0, s.start);
    if (start - cursor > 0.05) windows.push({startSec: cursor, endSec: Math.min(start, durationSec)});
    cursor = Math.max(cursor, s.end);
  }
  if (durationSec - cursor > 0.05) windows.push({startSec: cursor, endSec: durationSec});
  return windows.filter((w) => w.endSec - w.startSec > 0.05);
};

/** 全时长均匀抽帧时间点（避开首尾 3%，帧数钳到 [1, count]） */
export const sampleFrameTimes = (durationSec: number, count: number): number[] => {
  const n = Math.max(1, Math.min(count, Math.floor(durationSec)));
  if (n <= 1) return [Math.min(durationSec / 2, Math.max(0, durationSec * 0.5))];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round((durationSec * (0.03 + (0.94 * i) / (n - 1))) * 100) / 100);
  }
  return out;
};

/** 模型选出的单个高光窗口（媒体绝对秒） */
export interface HighlightPick {
  startSec: number;
  endSec: number;
  /** 保留理由（给 agent/用户看，也用于自检取舍） */
  reason: string;
  /** 这段讲了什么/发生了什么的一句话摘要 */
  summary: string;
}

export interface MiningPromptCtx {
  durationSec: number;
  targetDurationSec: number;
  maxSegments: number;
  /** 审片侧重/题材偏好（用户自然语言，可空） */
  focus?: string;
  /** 语音话题块（未配 ASR 或失败时为空数组） */
  clusters: SpeechCluster[];
  asrUsed: boolean;
  /** 随提示词一起发送的抽帧时间点（执行器附图，提示词里标注时间戳） */
  frameTimes: number[];
}

/** 组装挖矿提示词（user 消息的文字部分；帧以 image_url 附加） */
export const buildMiningPrompt = (ctx: MiningPromptCtx): string => {
  const clusterLines = ctx.clusters.length > 0
    ? ctx.clusters.map((c, i) => `${i + 1}. [${c.startSec.toFixed(1)}-${c.endSec.toFixed(1)}s] ${c.text}`).join('\n')
    : '（无转写线索——请完全依据画面判断）';
  const frameLine = ctx.frameTimes.map((t) => `${t.toFixed(1)}s`).join('、');
  return `你是专业剪辑师。下面是一条 ${ctx.durationSec.toFixed(1)} 秒的原始素材（vlog/口播/录屏），请从里面挑出值得保留的高光片段，目标成片总时长约 ${ctx.targetDurationSec} 秒，最多 ${ctx.maxSegments} 段。

${ctx.focus ? `用户侧重：${ctx.focus}\n` : ''}
## 转写话题块（按时间顺序，时间 = 素材绝对秒）
${clusterLines}

## 抽帧画面
按时间顺序附了 ${ctx.frameTimes.length} 帧画面（时间点：${frameLine}），据此判断画面内容与节奏。

## 挑选原则
1. 只保留有信息量/有情绪/有动作的画面：走神、等待、加载、摸索、重复表述、纯寒暄一律不选；
2. 每段 3-15 秒，边界落在句与句/动作与动作的间隙（转写块的边界就是天然切点）；
3. 总保留时长尽量贴近目标（±20% 以内）；
4. 按时间顺序输出；段与段之间允许有丢弃的间隙（剪辑时会无缝拼掉）；
5. 宁缺毋滥：找不到足够高光就少选，不要凑数。

只输出 JSON（不要任何其他文字）：
{"highlights": [{"startSec": 数字, "endSec": 数字, "summary": "这段内容一句话", "reason": "为什么值得保留"}]}`;
};

/** 从模型回复中提取 JSON 候选（剥 markdown 围栏；对象 {…} 与数组 […] 两种形态各取一个） */
const extractJsonCandidates = (text: string): string[] => {
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const out: string[] = [];
  const ob = stripped.indexOf('{');
  const cb = stripped.lastIndexOf('}');
  if (ob !== -1 && cb > ob) out.push(stripped.slice(ob, cb + 1));
  const oa = stripped.indexOf('[');
  const ca = stripped.lastIndexOf(']');
  if (oa !== -1 && ca > oa) out.push(stripped.slice(oa, ca + 1));
  return out;
};

const finiteClamp = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * 防御性解析模型回复 → 高光清单（钳到 [0, durationSec]、去过短/颠倒区间、按起点排序）。
 * 解析失败返回 null（调用方回喂模型原文，不阻断）。
 */
export const parseHighlightResponse = (
  modelText: string,
  durationSec: number,
): HighlightPick[] | null => {
  const text = (modelText || '').trim();
  if (!text) return null;
  let list: unknown[] | null = null;
  for (const candidate of extractJsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const obj = parsed as {highlights?: unknown} | null;
    if (Array.isArray(obj?.highlights)) {
      list = obj.highlights;
      break;
    }
    if (Array.isArray(parsed)) {
      list = parsed as unknown[];
      break;
    }
  }
  if (!list) return null;
  const picks: HighlightPick[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const s = finiteClamp(r.startSec, 0, Math.max(0, durationSec - 0.2));
    const e = finiteClamp(r.endSec, 0, durationSec);
    if (s === null || e === null || e - s < 0.5) continue;
    picks.push({
      startSec: s,
      endSec: e,
      summary: typeof r.summary === 'string' ? r.summary.slice(0, 120) : '',
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : '',
    });
  }
  if (picks.length === 0) return null;
  picks.sort((a, b) => a.startSec - b.startSec);
  return picks;
};

/** 归一保留区间：钳到 [0, durationSec]、排序、合并重叠/近接、丢弃过短段 */
export const normalizeKeepRanges = (
  ranges: {start: number; end: number}[],
  durationSec: number,
  opts?: {minKeepSec?: number; mergeGapSec?: number},
): {start: number; end: number}[] => {
  const minKeep = opts?.minKeepSec ?? 0.3;
  const mergeGap = opts?.mergeGapSec ?? 0.05;
  const valid = ranges
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, durationSec)),
      end: Math.max(0, Math.min(r.end, durationSec)),
    }))
    .filter((r) => r.end - r.start >= minKeep)
    .sort((a, b) => a.start - b.start);
  const merged: {start: number; end: number}[] = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({...r});
    }
  }
  return merged;
};

/**
 * 保留区间 → VideoClip 的 trim + cuts（apply_cut_list 的落地数学）：
 * trimStart = 首段起点，trimEnd = 末段终点，中间缝隙全部变成挖段——
 * 播放时保留区间无缝拼接（shared/clipCuts 的切片语义）。输入须已归一（非空、有序）。
 */
export const keepRangesToTrim = (keeps: {start: number; end: number}[]): {trimStart: number; trimEnd: number; cuts: ClipCut[]} => {
  if (keeps.length === 0) throw new Error('keepRangesToTrim: 保留区间为空');
  const trimStart = keeps[0].start;
  const trimEnd = keeps[keeps.length - 1].end;
  const cuts: ClipCut[] = [];
  for (let i = 1; i < keeps.length; i++) {
    const gapStart = keeps[i - 1].end;
    const gapEnd = keeps[i].start;
    if (gapEnd - gapStart >= 0.1) cuts.push({start: gapStart, end: gapEnd});
  }
  return {trimStart, trimEnd, cuts};
};
