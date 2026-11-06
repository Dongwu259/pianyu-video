/**
 * ScreenDemo 导播演示 - 逐帧状态解析器（纯函数，模板与单测共用）。
 *
 * 职责：把 M1 导播分析器的镜头计划（director-plan.ts 的 DirectorShot[]，媒体秒时基）
 * 解析成渲染期逐帧状态——当前镜头、进入过渡进度、镜头相机（zoom/焦点）、点击渐晕、
 * 点击浮卡。模板（ScreenDemo）只做 React/Remotion 包装，数学全部在这里可单测。
 *
 * 镜头语言（RESEARCH-SCREENDEMO.md §三.2，参照 FocuSee/Screen Studio）：
 * - 镜头相机按景别定 zoom（wide=全幅 / medium / close），焦点 = 镜头 focus（归一化→像素）；
 * - 镜内缓推：每镜头 zoom 随时间 +5%（消除静止帧，呼应全片节奏原则）；
 * - 非点击镜头焦点向实时光标轻偏 30%（画面活着但不丢构图）；点击镜头焦点冻结在点击点；
 * - whoosh 过渡（≈5 帧）：相机从前镜头状态 easeOutBack 甩到新镜头（轻微过冲）+
 *   方向性平移踢一脚 + 高斯模糊包络（中间最糊两头锐）；
 * - 点击渐晕：点击镜头内以焦点为中心的径向暗化（0.25s 淡入淡出）；
 * - 点击浮卡：点击落点后 0.15s，以点击点为心裁一块圆角浮卡悬浮 2.3s（回弹入场/淡出退场）。
 *
 * 时间基：全部用「媒体秒」（sidecar/镜头计划同一零点）；段内帧 → 媒体秒由模板按
 * trimStart/挖段映射（timelineToMediaSec）后传入。
 */

import type {CursorClick} from './capture';
import type {DirectorShot} from './director-plan';

/** 相机状态（结构与 remotion 侧 followCamera.CameraFrame 兼容，不跨层 import 类型） */
export interface ShotCam {
  scale: number;
  translateX: number;
  translateY: number;
}

/** whoosh 过渡时长（秒；30fps 下 ≈5.4 帧，落在研究口径 4-6 帧） */
export const WHOOSH_SEC = 0.18;
/** 镜内缓推最大幅度（相对该镜头基准 zoom） */
export const DRIFT_MAX = 0.05;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (q: number) => {
  const x = clamp01(q);
  return x * x * (3 - 2 * x);
};

/** easeOutBack：带轻微过冲（峰值 ≈1.1）的缓出，给 whoosh 落定一记「回弹」 */
export const easeOutBack = (q: number): number => {
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = q - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
};

/** 二分定位媒体秒所在镜头（越界钳到首/末镜头；空计划返回 -1） */
export const resolveShotIndex = (plan: DirectorShot[], mediaSec: number): number => {
  if (plan.length === 0) return -1;
  let lo = 0;
  let hi = plan.length - 1;
  if (mediaSec <= plan[0].t0) return 0;
  if (mediaSec >= plan[hi].t1) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (plan[mid].t0 <= mediaSec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** 镜内缓推倍率：镜头进度 0→1 时 zoom 从 1 线性升到 1+driftMax（d 越界钳制） */
export const shotDrift = (shot: DirectorShot, mediaSec: number, driftMax: number = DRIFT_MAX): number =>
  1 + driftMax * clamp01((mediaSec - shot.t0) / Math.max(0.001, shot.t1 - shot.t0));

/** 景别 → 基准 zoom（wide = 全幅 1；medium/close 由模板参数传入）。
 *  有内容拟合建议（zoomFit，34 轮）时在档位区间内取拟合值——缩放随演示目标尺寸走：
 *  close 钳 [1.4, zoomClose]、medium 钳 [1.12, zoomMed]；无 zoomFit 退回固定档位。 */
export const shotZoom = (
  shot: DirectorShot,
  {zoomMed, zoomClose}: {zoomMed: number; zoomClose: number},
): number => {
  if (shot.scale === 'wide') return 1;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (shot.scale === 'medium') {
    return shot.zoomFit !== undefined ? clamp(shot.zoomFit, 1.12, zoomMed) : zoomMed;
  }
  return shot.zoomFit !== undefined ? clamp(shot.zoomFit, 1.4, zoomClose) : zoomClose;
};

/** 镜头焦点（视频像素）：wide = 画面中心；其余按 focus 归一化坐标换算 */
export const shotFocusPx = (
  shot: DirectorShot,
  videoW: number,
  videoH: number,
): {cx: number; cy: number} => {
  if (!shot.focus) return {cx: videoW / 2, cy: videoH / 2};
  return {cx: shot.focus.x * videoW, cy: shot.focus.y * videoH};
};

/**
 * 焦点偏置：非点击镜头把焦点向实时光标拉 30%（构图意图不动，画面跟着活物走）；
 * 点击镜头冻结（点击必须留在画面中心，渐晕/浮卡都以它为锚）。cursor 缺省时不偏。
 */
export const biasFocus = (
  focus: {cx: number; cy: number},
  cursor: {x: number; y: number} | null,
  videoW: number,
  videoH: number,
  bias: number,
  freeze: boolean,
): {cx: number; cy: number} => {
  if (freeze || !cursor || bias <= 0) return focus;
  return {
    cx: focus.cx + (cursor.x - focus.cx) * bias,
    cy: focus.cy + (cursor.y - focus.cy) * bias,
  };
};

/** 过渡状态：q = 相机混合系数（easeOutBack，可 >1 过冲）；qlin = 线性进度（模糊包络用）；
 *  sway = 甩镜方向（+1 推近 / -1 拉远 / 0 无） */
export const transitionState = (
  plan: DirectorShot[],
  index: number,
  mediaSec: number,
  whooshSec: number = WHOOSH_SEC,
): {q: number; qlin: number; sway: number} => {
  const done = {q: 1, qlin: 1, sway: 0};
  if (index <= 0 || index >= plan.length) return done;
  const shot = plan[index];
  if (shot.trans !== 'whoosh') return done;
  const dt = mediaSec - shot.t0;
  if (dt >= whooshSec) return done;
  const qlin = clamp01(Math.max(0, dt) / whooshSec);
  const level = (s: DirectorShot) => (s.scale === 'wide' ? 0 : s.scale === 'medium' ? 1 : 2);
  const sway = level(shot) > level(plan[index - 1]) ? 1 : -1;
  return {q: qlin <= 0 ? 0 : easeOutBack(qlin), qlin, sway};
};

/**
 * 点击渐晕 alpha：仅点击镜头；入/出各 rampSec 秒的 smoothstep 包络，峰值 maxAlpha。
 * 渐晕中心 = 画布中心（镜头相机已把点击焦点放到中心）。
 */
export const vignetteAlpha = (
  shot: DirectorShot,
  mediaSec: number,
  maxAlpha: number = 0.42,
  rampSec: number = 0.25,
): number => {
  if (shot.reason !== 'click') return 0;
  const qIn = smoothstep((mediaSec - shot.t0) / rampSec);
  const qOut = smoothstep((shot.t1 - mediaSec) / rampSec);
  return maxAlpha * Math.min(qIn, qOut);
};

/** 浮卡状态（null = 不显示）：内容相机焦点与出入场包络 */
export interface FloatCardState {
  /** 卡片内容锚点 = 点击点（归一化 0..1，模板乘视频尺寸得像素） */
  cx: number;
  cy: number;
  /** 入场生长缩放（0→1 easeOutCubic，配合模板的 transformOrigin=点击点＝原地生长） */
  scale: number;
  /** 不透明度：在场期间恒 1（无半透明入场期），仅退场末 exitSec 渐出 */
  opacity: number;
}

/**
 * 点击浮卡（就地生长放大镜）：点击镜头内，锚定该镜头的点击时刻（计划 t0 比点击早
 * clickPreSec=0.9s，必须等真正点击落点才出现——取镜头内第一枚点击）。
 * 点击后 appearSec 才出现（让点击高亮环先说话），从锚点原地生长，全程不透明，
 * lifeSec 后快速退场。屏幕位置与贴边钳制由模板折算（本函数只管锚点与时间包络）。
 */
export const floatCardState = (
  clicks: CursorClick[],
  shot: DirectorShot,
  mediaSec: number,
  opts?: {appearSec?: number; lifeSec?: number; enterSec?: number; exitSec?: number},
): FloatCardState | null => {
  if (shot.reason !== 'click') return null;
  const appearSec = opts?.appearSec ?? 0.2;
  const lifeSec = opts?.lifeSec ?? 1.6;
  const enterSec = opts?.enterSec ?? 0.22;
  const exitSec = opts?.exitSec ?? 0.2;
  const anchor = clicks.find((c) => c.t / 1000 >= shot.t0 - 0.001);
  if (!anchor) return null;
  const start = anchor.t / 1000 + appearSec;
  const end = start + lifeSec;
  if (mediaSec < start || mediaSec > end) return null;
  const e = clamp01((mediaSec - start) / Math.max(0.001, enterSec));
  return {
    cx: shot.focus ? shot.focus.x : 0.5,
    cy: shot.focus ? shot.focus.y : 0.5,
    scale: 1 - Math.pow(1 - e, 3),
    opacity: smoothstep((end - mediaSec) / exitSec),
  };
};

/** 相机混合（逐字段线性插值；q 超 1 时外插 = whoosh 过冲） */
export const blendCam = (a: ShotCam, b: ShotCam, q: number): ShotCam => ({
  scale: a.scale + (b.scale - a.scale) * q,
  translateX: a.translateX + (b.translateX - a.translateX) * q,
  translateY: a.translateY + (b.translateY - a.translateY) * q,
});
