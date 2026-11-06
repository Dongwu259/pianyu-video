/**
 * BGM 时间轴定位的派生值与节拍坐标映射（P2.5 阶段二 v1.5，纯函数）。
 *
 * BgmTrack 三个可选字段 startAtSec / trimStartSec / trimEndSec 的语义：
 * - 时间轴位置：BGM 在成片第 startAtSec 秒起播，播到片尾（不足循环平铺，见 bgm-loop.ts）；
 * - 媒体窗：只用素材的 [trimStartSec, trimEndSec) 段，循环窗长度 = span。
 * - 节拍（beats，媒体时间）必须映射到时间轴坐标才对得上听到的声音：
 *   timeline = startAt + (beat − trimStart)，且只保留落在媒体窗内的拍。
 *
 * 全部缺省时 startAt=0、窗=[0, duration]，与 v1.5 之前的行为逐帧一致（零回归）。
 * 渲染端（MultiSegmentPromo）、卡点对齐（alignSegmentsToBeats）、SfxLane/TimelinePanel
 * 音效标记统一经 bgmTimelineBeats 取拍，保证「看到的拍 = 听到的拍」。
 */
import type {BgmTrack, BgmVolumeKey} from './types';
import {getBgmBeats, type BeatSource} from './beat-align';

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** 循环窗最短时长（秒）：比接缝交叉淡化 0.12s 长一个量级，保证循环有意义、UI 把手可拖 */
export const BGM_MIN_LOOP_SPAN_SEC = 2;

/** 起播点（秒，≥0 钳制；非法输入回 0）。时间轴 UI 另按成片总长钳上界，渲染端多铺不越界 */
export const bgmStartAtSec = (bgm: Pick<BgmTrack, 'startAtSec'>): number =>
  Number.isFinite(bgm.startAtSec) ? Math.max(0, bgm.startAtSec as number) : 0;

/** 媒体截取起点（秒，[0, duration−2] 钳制） */
export const bgmTrimStartSec = (bgm: Pick<BgmTrack, 'duration' | 'trimStartSec'>): number => {
  const dur = Math.max(0, bgm.duration || 0);
  const v = Number.isFinite(bgm.trimStartSec) ? (bgm.trimStartSec as number) : 0;
  return clamp(v, 0, Math.max(0, dur - BGM_MIN_LOOP_SPAN_SEC));
};

/** 媒体截取终点（秒，[trimStart+2, duration] 钳制） */
export const bgmTrimEndSec = (bgm: Pick<BgmTrack, 'duration' | 'trimStartSec' | 'trimEndSec'>): number => {
  const dur = Math.max(0, bgm.duration || 0);
  const v = Number.isFinite(bgm.trimEndSec) ? (bgm.trimEndSec as number) : dur;
  return clamp(v, bgmTrimStartSec(bgm) + BGM_MIN_LOOP_SPAN_SEC, Math.max(BGM_MIN_LOOP_SPAN_SEC, dur));
};

/** 循环窗长度（秒）= trimEnd − trimStart，恒 ≥ 2 */
export const bgmLoopSpanSec = (bgm: Pick<BgmTrack, 'duration' | 'trimStartSec' | 'trimEndSec'>): number =>
  bgmTrimEndSec(bgm) - bgmTrimStartSec(bgm);

/**
 * 时间轴坐标的节拍表：媒体窗内的拍映射到 timeline = startAt + (beat − trimStart)。
 * 窗外的拍丢弃（被截掉的前奏/尾奏不该再压拍）。缺省字段时等于 getBgmBeats 原样返回。
 */
export const bgmTimelineBeats = (bgm: BeatSource & Pick<BgmTrack, 'startAtSec' | 'trimStartSec' | 'trimEndSec'> | null | undefined): number[] => {
  if (!bgm) return [];
  const beats = getBgmBeats(bgm);
  if (beats.length === 0) return [];
  const startAt = bgmStartAtSec(bgm);
  const ts = bgmTrimStartSec(bgm);
  const te = bgmTrimEndSec(bgm);
  // 缺省快路径：startAt=0 且窗=全长时原样返回（含旧工程回退峰值检测的拍）
  if (startAt === 0 && ts === 0 && te >= (bgm.duration || 0) - 1e-9) return beats;
  const EPS = 1e-6;
  return beats.filter((b) => b >= ts - EPS && b < te - EPS).map((b) => startAt + (b - ts));
};

// ====== 音量包络（P2.5 音频升级 v1.2：时间轴「音量线」）======

/** 包络点数上限（拖拽/AI 写入共用；足够表达一首曲子的强弱叙事，防模型倾倒垃圾点） */
export const BGM_VOLUME_KEYS_MAX = 24;

/**
 * 音量包络取值：sec 相对 BGM 起播点（startAtSec 锚定）。关键点线性插值，
 * 首点前/末点后取端点值（拖动 BGM 块延长循环时包络语义连续）。空/缺省 = 恒 1
 * （与无包络的旧行为逐帧一致，零回归）。非法输入（NaN/负 volume）容错为 1。
 */
export const bgmVolumeAt = (keys: BgmTrack['volumeKeys'], secSinceStart: number): number => {
  if (!keys || keys.length === 0) return 1;
  if (!Number.isFinite(secSinceStart)) return 1;
  // 折半找最后一个 sec ≤ t 的点（点表须升序——normalizeBgmVolumeKeys 保证）
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].sec <= secSinceStart) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return vol(keys[0]);
  if (idx >= keys.length - 1) return vol(keys[keys.length - 1]);
  const a = keys[idx];
  const b = keys[idx + 1];
  const span = b.sec - a.sec;
  if (span <= 0) return vol(b);
  const q = (secSinceStart - a.sec) / span;
  return vol(a) + (vol(b) - vol(a)) * q;
};

const vol = (k: BgmVolumeKey): number =>
  Number.isFinite(k.volume) ? clamp(k.volume, 0, 1) : 1;

/**
 * 包络点表清洗（UI 拖拽落点 / AI set_bgm volumeKeys 共用）：
 * sec 钳 [0, spanSec]、volume 钳 [0,1]、按 sec 升序排序、同 sec 去重（后者胜），
 * 超上限截断。返回 undefined 表示「空包络」（写入方据此剥离字段）。
 */
export const normalizeBgmVolumeKeys = (
  keys: unknown,
  spanSec: number,
): BgmVolumeKey[] | undefined => {
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  const hi = Number.isFinite(spanSec) && spanSec > 0 ? spanSec : 600;
  const cleaned: BgmVolumeKey[] = [];
  for (const k of keys.slice(0, BGM_VOLUME_KEYS_MAX)) {
    if (typeof k !== 'object' || k === null) continue;
    const sec = Number((k as Record<string, unknown>).sec);
    const volume = Number((k as Record<string, unknown>).volume);
    if (!Number.isFinite(sec) || !Number.isFinite(volume)) continue;
    cleaned.push({sec: clamp(sec, 0, hi), volume: clamp(volume, 0, 1)});
  }
  if (cleaned.length === 0) return undefined;
  cleaned.sort((a, b) => a.sec - b.sec);
  // 同 sec（0.01s 内）去重：后值胜
  const out: BgmVolumeKey[] = [];
  for (const k of cleaned) {
    if (out.length > 0 && k.sec - out[out.length - 1].sec < 0.01) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
};

/**
 * 建议的 BGM 截取起点（掐前奏直进主体；一键流水线 J-cut 副歌先行的默认值）：
 * 波形峰值按 ~1s 滑动窗从头扫描，首个「窗均 ≥ 全片峰值均值 × 0.45」的位置 = 主体进点
 * （前奏普遍低能量，进点 = 能量跳升处）。钳制：进点 <1.5s 不值得掐（返回 0）；
 * 至少留 8s 循环窗。peaks 不可用/曲子太短 → 0（不掐，保持旧行为）。
 */
export const suggestBgmTrimStartSec = (peaks: number[] | undefined, durationSec: number): number => {
  if (!Array.isArray(peaks) || peaks.length < 30 || !Number.isFinite(durationSec) || durationSec < 12) return 0;
  const perSec = peaks.length / durationSec;
  const win = Math.max(3, Math.round(perSec)); // ~1s 窗
  const meanAll = peaks.reduce((s, p) => s + (Number.isFinite(p) ? p : 0), 0) / peaks.length;
  const threshold = meanAll * 0.45;
  for (let i = 0; i + win <= peaks.length; i++) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += Number.isFinite(peaks[j]) ? peaks[j] : 0;
    if (s / win >= threshold) {
      const sec = i / perSec;
      if (sec < 1.5) return 0;
      return Math.min(sec, Math.max(0, durationSec - 8));
    }
  }
  return 0;
};
