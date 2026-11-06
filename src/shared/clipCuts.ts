/**
 * 素材挖段（cuts）——把一段素材的中间区间抠掉，前后画面无缝拼接。
 *
 * 数据模型：VideoClip.cuts 是一组媒体绝对秒区间 [{start, end}]，必须落在
 * (trimStart, trimEnd) 内。裁剪（trim）决定素材首尾边界，挖段在边界内部再抠洞：
 * 有效时长 trimmedDuration = (trimEnd - trimStart) - Σ挖段长度。
 *
 * 时间映射：播放时间轴（0 = trimStart 处，挖段后无洞的连续时间）↔ 媒体时间
 * （素材文件秒）。渲染端把每个可播区间作为一段切片顺序播放即完成拼接。
 * 窗口尾：trimEnd 显著小于素材时长时（clipEndSec），渲染端在 trimEnd 处封口——
 * 超出部分冻结在窗口最后一帧（音频同止）；timelineToMediaSec 的线性外推仅作
 * 无封口场景的防御性映射（未设 trim/播到文件尾自然冻结）。
 *
 * 全部纯函数，渲染端 / store / AI 工具 / 单测共用。
 */

/** 一段挖掉的区间（媒体绝对秒，start < end） */
export interface ClipCut {
  start: number;
  end: number;
}

/** 单个挖段与相邻挖段小于该间隙时合并为一段（渲染切片过密无意义且费轨） */
export const CUT_MERGE_GAP_SEC = 0.05;
/** 归一后单段挖段的最小长度（不足者丢弃） */
export const CUT_MIN_SEC = 0.1;

/**
 * 归一挖段列表：钳制到 (trimStart, trimEnd) 内、丢弃过短段、排序、
 * 合并重叠/近接段。空结果返回 undefined（可选字段保持干净）。
 */
export const normalizeCuts = (
  cuts: ClipCut[] | undefined,
  trimStart: number,
  trimEnd: number,
): ClipCut[] | undefined => {
  if (!cuts || cuts.length === 0) return undefined;
  const lo = trimStart;
  const hi = Math.max(trimStart, trimEnd);
  const clamped: ClipCut[] = [];
  for (const c of cuts) {
    if (!c || !Number.isFinite(c.start) || !Number.isFinite(c.end)) continue;
    const s = Math.max(lo, Math.min(c.start, hi));
    const e = Math.max(lo, Math.min(c.end, hi));
    if (e - s >= CUT_MIN_SEC) clamped.push({start: s, end: e});
  }
  if (clamped.length === 0) return undefined;
  clamped.sort((a, b) => a.start - b.start);
  const merged: ClipCut[] = [clamped[0]];
  for (const c of clamped.slice(1)) {
    const last = merged[merged.length - 1];
    if (c.start - last.end <= CUT_MERGE_GAP_SEC) {
      last.end = Math.max(last.end, c.end);
    } else {
      merged.push({...c});
    }
  }
  return merged;
};

/** 挖段总长（秒） */
export const cutsTotalSec = (cuts: ClipCut[] | undefined): number =>
  cuts ? cuts.reduce((sum, c) => sum + (c.end - c.start), 0) : 0;

/**
 * 渲染端「窗口尾」判定：trimEnd 显著小于素材时长时返回 trimEnd（渲染端在该处
 * 冻结末帧），否则 undefined（不封口，播到文件尾自然冻结——既有语义零回归）。
 * 0.05s 容差与挖段归一（CUT_MERGE_GAP_SEC）同口径。
 */
export const clipEndSec = (clip: {duration: number; trimEnd?: number}): number | undefined =>
  typeof clip.trimEnd === 'number' && Number.isFinite(clip.trimEnd) && clip.duration > 0 &&
  clip.trimEnd < clip.duration - 0.05
    ? clip.trimEnd
    : undefined;

/** 有效（裁剪 + 挖段后）时长 */
export const effectiveTrimmedDuration = (
  trimStart: number,
  trimEnd: number,
  cuts: ClipCut[] | undefined,
): number => Math.max(0, trimEnd - trimStart - cutsTotalSec(cuts));

/**
 * 可播区间列表（媒体绝对秒）：把 (trimStart, trimEnd) 按 cuts 挖洞后的连续段。
 * 无 cuts 时即单个 [trimStart, trimEnd]。
 */
export const playableIntervals = (
  trimStart: number,
  trimEnd: number,
  cuts: ClipCut[] | undefined,
): ClipCut[] => {
  const out: ClipCut[] = [];
  let cursor = trimStart;
  for (const c of cuts ?? []) {
    if (c.start > cursor) out.push({start: cursor, end: Math.min(c.start, trimEnd)});
    cursor = Math.max(cursor, c.end);
    if (cursor >= trimEnd) break;
  }
  if (cursor < trimEnd) out.push({start: cursor, end: trimEnd});
  return out.filter((i) => i.end - i.start > 0);
};

/**
 * 播放时间轴秒（0 = trimStart）→ 媒体秒。洞内时间点映射到洞的出口（即洞末帧），
 * 超出有效时长则从最后区间末尾线性外推（渲染端「继续往后放」的既有语义）。
 */
export const timelineToMediaSec = (
  timelineSec: number,
  trimStart: number,
  cuts: ClipCut[] | undefined,
): number => {
  const intervals = playableIntervals(trimStart, Number.POSITIVE_INFINITY, cuts);
  let acc = 0;
  for (const iv of intervals) {
    const len = iv.end - iv.start;
    if (timelineSec < acc + len || iv.end === Number.POSITIVE_INFINITY) {
      // 落在本区间（或末区间）：末区间不封口，超出部分线性外推
      return iv.start + (timelineSec - acc);
    }
    acc += len;
  }
  // 空区间兜底（trimStart ≥ ∞ 不会出现；防御性返回）
  return trimStart + timelineSec;
};

/**
 * 媒体秒 → 播放时间轴秒（timelineToMediaSec 的逆；plan-projection 点击节拍映射用）。
 * 洞内（cutAt 命中）返回 null——该媒体时刻在成片里不存在（被挖掉），调用方跳过
 * 而不是猜最近出口（宁少勿猜纪律）。区间外同样 null。
 */
export const mediaToTimelineSec = (
  mediaSec: number,
  trimStart: number,
  trimEnd: number,
  cuts: ClipCut[] | undefined,
): number | null => {
  if (cutAt(mediaSec, cuts)) return null;
  const intervals = playableIntervals(trimStart, trimEnd, cuts);
  let acc = 0;
  for (const iv of intervals) {
    if (mediaSec >= iv.start && mediaSec < iv.end) return acc + (mediaSec - iv.start);
    acc += iv.end - iv.start;
  }
  return null;
};

/**
 * 媒体秒是否落在某个挖段内（是则返回该段，否则 null）。
 * 抽帧看图等场景用它把落进洞里的时间点轻推到洞出口。
 */
export const cutAt = (mediaSec: number, cuts: ClipCut[] | undefined): ClipCut | null => {
  for (const c of cuts ?? []) {
    if (mediaSec >= c.start && mediaSec < c.end) return c;
  }
  return null;
};

/**
 * 按媒体拆分点把 cuts 分给两半（splitSegment 用）：
 * first 拿 (trimStart, splitAt) 内的段，second 拿 (splitAt, trimEnd) 内的段。
 * 恰好骑在拆点上的段按拆点切开。
 */
export const splitCutsAt = (
  cuts: ClipCut[] | undefined,
  splitAt: number,
): {first: ClipCut[] | undefined; second: ClipCut[] | undefined} => {
  const first: ClipCut[] = [];
  const second: ClipCut[] = [];
  for (const c of cuts ?? []) {
    if (c.end <= splitAt) first.push({...c});
    else if (c.start >= splitAt) second.push({...c});
    else {
      first.push({start: c.start, end: splitAt});
      second.push({start: splitAt, end: c.end});
    }
  }
  return {
    first: first.length > 0 ? first : undefined,
    second: second.length > 0 ? second : undefined,
  };
};

/**
 * 播放切片表（渲染端 ClipMedia 消费）：从 baseSec（= trimStart）起播、按 cuts 跳洞，
 * 返回逐片 {timelineFrom 帧, len 帧, mediaFrom 帧}；末片不封口（len = Infinity，
 * 播到文件尾冻结——与无挖段直录的行为一致）。无 cuts 返回单片。
 */
export const buildPlaybackSlices = (
  baseSec: number,
  cuts: ClipCut[] | undefined,
  fps: number,
): {timelineFrom: number; len: number; mediaFrom: number}[] => {
  const sorted = [...(cuts ?? [])]
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const slices: {timelineFrom: number; len: number; mediaFrom: number}[] = [];
  let mediaCursor = baseSec;
  let timelineCursor = 0;
  for (const c of sorted) {
    const segEnd = Math.max(mediaCursor, c.start);
    if (segEnd > mediaCursor) {
      slices.push({
        timelineFrom: Math.round(timelineCursor * fps),
        len: Math.round((segEnd - mediaCursor) * fps),
        mediaFrom: Math.round(mediaCursor * fps),
      });
      timelineCursor += segEnd - mediaCursor;
      mediaCursor = segEnd;
    }
    mediaCursor = Math.max(mediaCursor, c.end);
  }
  // 末片不封口：素材播到文件尾冻结（与无挖段时的直录行为一致）
  slices.push({
    timelineFrom: Math.round(timelineCursor * fps),
    len: Infinity,
    mediaFrom: Math.round(mediaCursor * fps),
  });
  return slices;
};

/**
 * 播放计划（渲染端 ClipMedia 消费）：切片表 + 可播总帧数。
 *
 * endSec（= trimEnd，媒体绝对秒）显著大于 baseSec 时封口：切片只覆盖
 * [baseSec, endSec] 挖洞后的可播区间，playFrames = 逐片帧数精确累加
 * （帧域累加，保证末片 timelineFrom + len === playFrames，冻结帧映射无漂移）。
 * 渲染端超出 playFrames 的部分用 Freeze 冻结在最后一帧（音频同止）。
 *
 * endSec 未给/非法时不封口（playFrames = null），切片与 buildPlaybackSlices
 * 完全一致（末片 Infinity，播到文件尾自然冻结）。
 */
export interface PlaybackPlan {
  slices: {timelineFrom: number; len: number; mediaFrom: number}[];
  /** 可播总帧数（≥1）；不封口为 null */
  playFrames: number | null;
}

export const buildPlaybackPlan = (
  baseSec: number,
  cuts: ClipCut[] | undefined,
  fps: number,
  endSec?: number,
): PlaybackPlan => {
  if (typeof endSec !== 'number' || !Number.isFinite(endSec) || endSec <= baseSec + 1 / fps) {
    return {slices: buildPlaybackSlices(baseSec, cuts, fps), playFrames: null};
  }
  const intervals = playableIntervals(baseSec, endSec, cuts);
  const slices: {timelineFrom: number; len: number; mediaFrom: number}[] = [];
  let accFrames = 0;
  for (const iv of intervals) {
    const len = Math.max(1, Math.round((iv.end - iv.start) * fps));
    slices.push({timelineFrom: accFrames, len, mediaFrom: Math.round(iv.start * fps)});
    accFrames += len;
  }
  if (slices.length === 0) {
    // 防御：可播区间被挖空（cuts 盖满窗口）——保底 1 帧，冻结即静止画面
    return {slices: [{timelineFrom: 0, len: 1, mediaFrom: Math.round(baseSec * fps)}], playFrames: 1};
  }
  return {slices, playFrames: accFrames};
};

/**
 * 有效观看区间：裁剪窗口 [trimStart, trimEnd] 挖掉 cuts 后的媒体时间子区间列表
 * （升序、互不重叠）。抽帧浏览/采样等「只关心实际可用画面」的场景用。
 */
export const effectiveRanges = (
  clip: {duration: number; trimStart?: number; trimEnd?: number; cuts?: ClipCut[]},
): {start: number; end: number}[] => {
  const start = Math.max(0, clip.trimStart ?? 0);
  const rawEnd = clip.trimEnd ?? clip.duration;
  const end = clip.duration > 0 ? Math.min(rawEnd, clip.duration) : rawEnd;
  if (end - start <= 0.05) return [];
  const ranges: {start: number; end: number}[] = [];
  let cursor = start;
  for (const c of (clip.cuts ?? []).slice().sort((a, b) => a.start - b.start)) {
    const s = Math.max(cursor, c.start);
    if (s > cursor) ranges.push({start: cursor, end: Math.min(s, end)});
    cursor = Math.max(cursor, c.end);
    if (cursor >= end) break;
  }
  if (cursor < end) ranges.push({start: cursor, end});
  return ranges.filter((r) => r.end - r.start > 0.01);
};

/**
 * 抽帧采样点规划（view_media_frames 用）：在有效观看区间上均匀取 count 个点，
 * 返回媒体绝对秒（抽帧用）与段内相对秒（= 播放时间轴位置，agent 直接换算 trim/字幕用）。
 * 无裁剪无挖段时区间就是 [0, duration]；区间总长为 0（防御）返回起点单点。
 */
export const planFrameTimes = (
  clip: {duration: number; trimStart?: number; trimEnd?: number; cuts?: ClipCut[]},
  count: number,
): {mediaSec: number; segmentSec: number}[] => {
  const n = Math.max(2, Math.min(8, Math.round(count)));
  const ranges = effectiveRanges(clip);
  if (ranges.length === 0) {
    const at = Math.max(0, clip.trimStart ?? 0);
    return [{mediaSec: at, segmentSec: 0}];
  }
  const total = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const out: {mediaSec: number; segmentSec: number}[] = [];
  for (let i = 0; i < n; i++) {
    let target = total * ((i + 0.5) / n);
    let mediaSec = ranges[ranges.length - 1].end;
    let segmentSec = total;
    for (const r of ranges) {
      const len = r.end - r.start;
      if (target <= len) {
        mediaSec = r.start + target;
        segmentSec = mediaSec - (clip.trimStart ?? 0);
        break;
      }
      target -= len;
    }
    out.push({mediaSec: Math.round(mediaSec * 100) / 100, segmentSec: Math.round(segmentSec * 100) / 100});
  }
  return out;
};
