/**
 * 时间轴视图布局数学（P2.5 阶段二「时间线作为视图」，见 docs/transition-timeline-roadmap.md §4.2）
 *
 * 纯投影、零渲染改动：把故事板 segments 投影成剪辑软件时间轴的轨道几何——
 * - 视频轨片段矩形：段内容首尾相接（startSec 累加），与 MultiSegmentPromo 的
 *   segmentTimings 同一口径（contentFrames 取整一致）；
 * - 转场块：直接换算 computeTransitionWindows 的骑跨窗口（高潮帧=切点），
 *   保证「时间轴上看到的转场」与「渲染时转场占用的画面区间」严格同源；
 * - 节拍刻度/吸附、标尺刻度、播放头定位等 UI 数学。
 *
 * v5 代契约：本模块只读现有 schema（duration/transition/transitionParams），
 * 不新增段字段、不动 19 工具 EDGE 面与 storyboard schema（冻结见 HANDOVER 跨会话分工）。
 */
import type {Segment, TransitionType} from './types';
import {computeTransitionWindows, getTransitionDefaultSec, clampTransitionSec} from './transition-style';

/** 时间轴一律按渲染帧率换算（与 MultiSegmentPromo / SfxLane 的 FPS 常量一致） */
export const TIMELINE_FPS = 30;

/** 段时长 UI 钳制（与 setCurrentDuration 同口径：0.5 起步支持快切，60 封顶防爆渲染） */
export const MIN_SEGMENT_SEC = 0.5;
export const MAX_SEGMENT_SEC = 60;

export interface TimelineClip {
  segIndex: number;
  /** 段内容起点（绝对秒） */
  startSec: number;
  /** 段内容终点（绝对秒，= 下一段起点） */
  endSec: number;
  durationSec: number;
}

/** 段间转场块（骑跨切点；type='none' 或末段不出块） */
export interface TimelineTransitionBlock {
  /** 边界 i → i+1，由 segments[i].transition 驱动 */
  segIndex: number;
  type: TransitionType;
  /** 转场时长（transitionParams.durationSec ?? 类型默认） */
  durationSec: number;
  /** 窗口起（绝对秒；= 切点 − headPad） */
  startSec: number;
  /** 窗口止（绝对秒，开区间；= 切点 + tail） */
  endSec: number;
  /** 切点 = 高潮帧（绝对秒） */
  cutSec: number;
}

export interface TimelineLayout {
  totalSec: number;
  clips: TimelineClip[];
  /** 每个边界一个（含 frames=0 的硬切占位，UI 据此定位边界命中区） */
  transitions: TimelineTransitionBlock[];
}

/** 段内容帧数（与渲染 contentFramesArr 同口径：缺省 8s、四舍五入到帧） */
const segmentContentFrames = (seg: Segment): number => Math.round((seg.duration || 8) * TIMELINE_FPS);

/** 全片时间轴布局（纯函数；UI 每次 segments 变化重算，量级 = 段数，开销可忽略） */
export const computeTimelineLayout = (segments: Segment[]): TimelineLayout => {
  const contentFrames = segments.map(segmentContentFrames);
  const windows = computeTransitionWindows(segments, contentFrames, TIMELINE_FPS);
  const clips: TimelineClip[] = [];
  const transitions: TimelineTransitionBlock[] = [];
  let acc = 0;
  segments.forEach((seg, i) => {
    const dur = contentFrames[i] / TIMELINE_FPS;
    clips.push({segIndex: i, startSec: acc, endSec: acc + dur, durationSec: dur});
    acc += dur;
    const w = windows[i];
    transitions.push({
      segIndex: i,
      type: seg.transition,
      durationSec:
        w.frames > 0
          ? (seg.transitionParams?.durationSec ?? getTransitionDefaultSec(seg.transition) ?? 0.5)
          : 0,
      startSec: w.startFrame / TIMELINE_FPS,
      endSec: w.endFrame / TIMELINE_FPS,
      cutSec: w.climaxFrame / TIMELINE_FPS,
    });
  });
  return {totalSec: acc, clips, transitions};
};

/** 播放头/任意时刻 → 所在段下标（越过片尾钳到最后一段；空板返回 -1） */
export const findClipIndexAt = (layout: TimelineLayout, sec: number): number => {
  const {clips} = layout;
  if (clips.length === 0) return -1;
  for (let i = clips.length - 1; i >= 0; i--) {
    if (sec >= clips[i].startSec) return i;
  }
  return 0;
};

/** 0.1s 步进取整（段时长/淡入淡出的 UI 粒度，与现有输入框一致） */
export const roundTenth = (v: number): number => Math.round(v * 10) / 10;

/** 段时长钳制 + 0.1 取整（非法输入回退原值；调用方自行处理 NaN） */
export const clampSegmentDuration = (v: number, fallback = 8): number =>
  Number.isFinite(v) ? roundTenth(Math.max(MIN_SEGMENT_SEC, Math.min(MAX_SEGMENT_SEC, v))) : fallback;

/** 转场时长钳制（0.2-2s，与转场行输入框同口径） */
export const clampTimelineTransitionSec = (v: number): number =>
  Number.isFinite(v) ? clampTransitionSec(v) : 0.5;

/**
 * 旁白段内偏移钳制（0.1 步进，[0, 段时长]）：旁白块在时间轴上只能在本段范围内拖动
 * （音频长于段时溢出显示是「播完为止」的真实投影，不改变起点归属）。
 */
export const clampNarrationOffsetSec = (v: number, segDurationSec: number): number =>
  Number.isFinite(v) ? roundTenth(Math.max(0, Math.min(Math.max(0, segDurationSec), v))) : 0;

/** 节拍中位间隔（秒；beats 升序）；不足 2 拍返回 0 = 无法吸附 */
export const medianBeatSec = (beats: number[]): number => {
  if (beats.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const g = beats[i] - beats[i - 1];
    if (g > 0.05) gaps.push(g);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  // 偶数个间隔取两中位平均（0.4/0.6 交替 → 0.5，而不是偏取上界）
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
};

/**
 * 时间点吸附节拍：|t − 最近拍| 在 threshold 内吸到拍上，否则原样返回。
 * threshold 由调用方按像素阈值换算（如 6px / pxPerSec），保证缩放级别下手感一致。
 */
export const snapSecToBeats = (sec: number, beats: number[], thresholdSec: number): number => {
  if (beats.length === 0 || thresholdSec <= 0) return sec;
  // 二分找最近拍（beats 升序；长度通常几十到几百，二分足够且无依赖）
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  let best = beats[lo];
  if (lo > 0 && Math.abs(beats[lo - 1] - sec) < Math.abs(best - sec)) best = beats[lo - 1];
  return Math.abs(best - sec) <= thresholdSec ? best : sec;
};

/** 磁性吸附（时间轴 v5）：节拍点与边界类目标（片段边界/播放头/BGM 起播点等）同权竞争，
 *  阈值内取最近者；无命中返回原值。与 snapSecToBeats 的关系：后者只吸拍（旧语义保留），
 *  本函数是拖拽吸附的统一入口（UI 唯一消费方，坐标口径仍是 layout 系秒）。
 *  threshold <= 0 时原样返回；并列距离时先考虑者胜（beats 在前）。 */
export const snapSecMagnetic = (sec: number, beats: number[], targets: number[], thresholdSec: number): number => {
  if (thresholdSec <= 0) return sec;
  let bestV = sec;
  let bestD = thresholdSec;
  const consider = (v: number) => {
    if (!Number.isFinite(v)) return;
    const d = Math.abs(v - sec);
    if (d < bestD) {
      bestD = d;
      bestV = v;
    }
  };
  for (const b of beats) consider(b);
  for (const t of targets) consider(t);
  return bestV;
};

/** 标尺刻度步长候选（秒；小尺度用 0.5/1s，长片到 60s） */
const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];

export interface RulerTicks {
  /** 主刻度步长（秒） */
  stepSec: number;
  /** 主刻度时间点（秒，升序，不含 0） */
  majors: number[];
  /** 次刻度时间点（stepSec/5，供细网格） */
  minors: number[];
}

/** 标尺刻度规划：主刻度标签间距不小于 minLabelPx（默认 64），随缩放自动换挡 */
export const planRulerTicks = (totalSec: number, pxPerSec: number, minLabelPx = 64): RulerTicks => {
  const stepSec = RULER_STEPS.find((s) => s * pxPerSec >= minLabelPx) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const majors: number[] = [];
  const minors: number[] = [];
  const minorStep = stepSec / 5;
  const n = Math.floor(totalSec / minorStep);
  for (let i = 1; i <= n; i++) {
    const t = round3(i * minorStep);
    if (Math.abs(t / stepSec - Math.round(t / stepSec)) < 1e-6) majors.push(t);
    else minors.push(t);
  }
  return {stepSec, majors, minors};
};

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** 时间码 m:ss.d（播放头/总时长显示共用；按十分位取整进位，不出现 0:60.0） */
export const formatTimelineTc = (sec: number): string => {
  const tenth = Math.round(Math.max(0, sec) * 10);
  const m = Math.floor(tenth / 600);
  const rem = tenth - m * 600;
  const s = Math.floor(rem / 10);
  const d = rem % 10;
  return `${m}:${s < 10 ? '0' : ''}${s}.${d}`;
};
