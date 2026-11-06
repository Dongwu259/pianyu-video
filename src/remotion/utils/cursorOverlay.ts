/**
 * 美化光标覆盖层 - 纯函数（坐标/平滑数学与 React 解耦，便于单测）。
 *
 * 录屏不含系统光标（录制时未采集系统指针，见 CursorFollow 模板注释），
 * 本层把录制时 30Hz 轮询的轨迹（VideoClip.cursorPoints，视频像素坐标）
 * 合成为一枚平滑移动的光标：
 * - 平滑：对称窗口 5 采样滑动平均（渲染期离线计算，允许用"未来"采样），
 *   消除轮询抖动与快速甩动造成的折线感；
 * - 坐标：媒体像素 → 画框 px，与 clickRipples 同口径（placed 折叠了
 *   cover/contain/取景视口的全部几何）；
 * - 按压：点击瞬间光标轻微收缩回弹、光晕增强（与点击水波互补）。
 */
import type {CursorClick, CursorPoint} from '../../shared/capture';
import {timelineToMediaSec} from '../../shared/clipCuts';
import type {ClipCut} from '../../shared/clipCuts';
import {sampleTrack} from './followCamera';
import type {RipplePlaced} from './clickRipples';

/** 平滑窗口毫秒数（对称 ±60ms；30Hz 轮询间隔 33ms，窗口覆盖约 4 个原始采样） */
const SMOOTH_SPAN_MS = 120;
/** 窗口内采样点数（滑动平均） */
const SMOOTH_SAMPLES = 5;
/** 按压脉冲时长（秒）：点击当帧 1，线性衰减到 0 */
const PRESS_SEC = 0.3;

// ====== 光标拖尾倾斜（DogSC PointerTrack.swift cursorRotationRadians 同构移植） ======

/** 倾斜档位 → 幅度/灵敏度（弱/中/强；gain 同时降低起摆阈值与响应跨度 → 高档更早起摆） */
const LEAN_TIERS: Record<number, {maxDeg: number; gain: number}> = {
  1: {maxDeg: 5, gain: 1},
  2: {maxDeg: 7, gain: 1.5},
  3: {maxDeg: 9, gain: 2},
};
/** 速度采样窗（毫秒）：取当前/前窗/前两窗三个平滑位置求混合速度 */
const LEAN_WINDOW_MS = 80;
/** 前窗速度权重（保留部分上一窗方向 → 加速/转弯时身体「拖」在尖端后面） */
const LEAN_PREV_WEIGHT = 0.38;
/** 停驻衰减窗（毫秒）：最后一个轨迹点后归零（不动不歪） */
const LEAN_IDLE_MS = 180;
/** 起摆阈值（归一速度/秒，以视频高度归一；DogSC 同值） */
const LEAN_THRESHOLD = 0.006;
/** 响应跨度（归一速度/秒：阈值到此为满摆） */
const LEAN_SPAN = 0.18;

/** 媒体域某时刻的平滑位置（对称窗口滑动平均；t 早于轨迹起点返回 null） */
const smoothedMediaAt = (points: CursorPoint[], mediaMs: number): {x: number; y: number} | null => {
  if (mediaMs < points[0].t) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < SMOOTH_SAMPLES; i++) {
    const t = mediaMs - SMOOTH_SPAN_MS / 2 + (SMOOTH_SPAN_MS * i) / (SMOOTH_SAMPLES - 1);
    const p = sampleTrack(points, t);
    sx += p.x;
    sy += p.y;
  }
  return {x: sx / SMOOTH_SAMPLES, y: sy / SMOOTH_SAMPLES};
};

/**
 * 光标拖尾倾斜角（度）：把光标热点当作沉重的领先尖端，箭头身体根据近期
 * 速度方向轻微摆尾（最大 ±5°/7°/9°）。因果且确定性——只采样过去的轨迹
 * 位置（预览 = 导出）。箭头尾朝右下 (1,-1)/√2，移动方向与尾向的叉积
 * 表达尾应摆到多远；向右移动 → 负角（逆时针），尾向左下滞后。
 * leanTier 0 或轨迹不足 → 0（零回归）。
 */
export const cursorLeanDeg = (args: {
  points: CursorPoint[] | undefined;
  /** 当前媒体时刻（录制零点毫秒，与 points.t 同域） */
  mediaMs: number;
  /** 视频高度 px（速度归一基准） */
  vh: number;
  /** 倾斜档位：0 关 / 1 弱 / 2 中 / 3 强 */
  leanTier: number;
}): number => {
  const {points, mediaMs, vh, leanTier} = args;
  const tier = LEAN_TIERS[Math.round(leanTier)];
  if (!tier || !points || points.length < 2 || vh <= 0) return 0;
  const p0 = smoothedMediaAt(points, mediaMs);
  const p1 = smoothedMediaAt(points, mediaMs - LEAN_WINDOW_MS);
  const p2 = smoothedMediaAt(points, mediaMs - LEAN_WINDOW_MS * 2);
  if (!p0 || !p1 || !p2) return 0;
  const w = LEAN_WINDOW_MS / 1000;
  const vx = ((p0.x - p1.x) / w) * (1 - LEAN_PREV_WEIGHT) + ((p1.x - p2.x) / w) * LEAN_PREV_WEIGHT;
  const vy = ((p0.y - p1.y) / w) * (1 - LEAN_PREV_WEIGHT) + ((p1.y - p2.y) / w) * LEAN_PREV_WEIGHT;
  const speed = Math.hypot(vx, vy);
  const speedNorm = speed / vh;
  const threshold = LEAN_THRESHOLD / tier.gain;
  if (!Number.isFinite(speedNorm) || speedNorm <= threshold) return 0;
  // 尾向叉积（|torque| ≤ 1）：与尾同向（右下）移动为 0，反向（右上/左下）为满摆
  const torque = Math.min(1, Math.max(-1, (vx - vy) / Math.max(speed, 1e-6) / Math.SQRT2));
  let resp = Math.min(1, Math.max(0, (speedNorm - threshold) / (LEAN_SPAN / tier.gain)));
  resp = resp * resp * (3 - 2 * resp);
  // 停驻衰减：锚 = ≤当前时刻的最近轨迹点（移动中 ≈ 当前时刻 → 不衰减）；
  // 40ms 容差盖住 30Hz 轮询间隔（DogSC 输入 8-16ms 无需容差），停驻 220ms 内归零
  let lastBefore = points[0].t;
  for (const pt of points) {
    if (pt.t <= mediaMs) lastBefore = pt.t;
    else break;
  }
  const idle = 1 - Math.min(1, Math.max(0, (mediaMs - lastBefore - 40) / LEAN_IDLE_MS));
  return -tier.maxDeg * resp * torque * idle;
};

/**
 * 按住状态查询（声明式脚本合成轨迹的 drag/down-up 段）：媒体域某时刻光标是否按住。
 * 取 ≤当前时刻 +40ms 容差内最近的采样点 down 标记（30Hz 采样间隔盖住；
 * 真实录屏轨迹无 down 字段 → 恒 false，零回归）。
 */
export const cursorPressState = (points: CursorPoint[] | undefined, mediaMs: number): boolean => {
  if (!points || points.length === 0) return false;
  let last: CursorPoint | null = null;
  for (const p of points) {
    if (p.t <= mediaMs + 40) last = p;
    else break;
  }
  return last?.down === true;
};

/**
 * 轨迹水平主方向（eye-trace 倾斜纪律用）：速度加权的水平净位移占比——
 * Σ|Δx|·sign(Δx) / Σ(|Δx|+|Δy|)。>0.25 → +1（向右主导），<-0.25 → -1，其余 0（无主导不动）。
 * 纪律：tiltZ 符号与主方向同侧（向右 → rotateZ 正 = 顺时针，内容右缘下沉沿目光流动向）。
 */
export const suggestCursorTiltSign = (points: CursorPoint[] | undefined): -1 | 0 | 1 => {
  if (!points || points.length < 2) return 0;
  let wx = 0;
  let wTotal = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const ax = Math.abs(dx);
    wx += ax * Math.sign(dx);
    wTotal += ax + Math.abs(dy);
  }
  if (wTotal === 0) return 0;
  const ratio = wx / wTotal;
  if (ratio > 0.25) return 1;
  if (ratio < -0.25) return -1;
  return 0;
};

export interface CursorOverlayState {
  /** 画框内 px 坐标 X（光标尖端锚点） */
  x: number;
  /** 画框内 px 坐标 Y（光标尖端锚点） */
  y: number;
  /** 按压强度 0..1（0 = 无点击影响） */
  press: number;
  /** 拖尾倾斜角（度，负=逆时针）：光标身体随近期速度方向轻微摆尾（0 = 不倾斜） */
  leanDeg: number;
}

/**
 * 当前帧的光标状态；轨迹不足两点或参数非法时返回 null（不渲染光标）。
 * 时间映射：mediaMs = (startFrom + frame)/fps×1000（与 clickRipples 同一零点）。
 */
export const cursorOverlayState = (args: {
  points: CursorPoint[] | undefined;
  clicks: CursorClick[] | undefined;
  /** 视频框当前相对帧（Sequence 内） */
  frame: number;
  /** 合成帧率 */
  fps: number;
  /** 媒体起始帧（合成帧率；= trimStart × fps） */
  startFrom: number;
  /** 挖段列表（媒体绝对秒）：有时当前帧的媒体时间按挖段映射（洞内帧 = 洞出口） */
  cutsSec?: ClipCut[];
  /** 窗口尾（媒体绝对秒）：ClipMedia 封口时同步钳制，冻结帧上光标不再漂移 */
  endSec?: number;
  /** 媒体原始尺寸 */
  vw: number;
  vh: number;
  /** 媒体在画框内的最终几何 */
  placed: RipplePlaced;
  /** 拖尾倾斜档位：0 关 / 1 弱 / 2 中 / 3 强（cursorLeanDeg 解读） */
  leanTier?: number;
}): CursorOverlayState | null => {
  const {points, clicks, frame, fps, startFrom, cutsSec, endSec, vw, vh, placed, leanTier} = args;
  if (!points || points.length < 2 || vw <= 0 || vh <= 0 || fps <= 0) return null;
  const mediaSec0 =
    cutsSec && cutsSec.length > 0
      ? timelineToMediaSec(frame / fps, startFrom / fps, cutsSec)
      : (startFrom + frame) / fps;
  const mediaMs = (endSec !== undefined ? Math.min(mediaSec0, endSec) : mediaSec0) * 1000;
  const smoothed = smoothedMediaAt(points, mediaMs);
  if (!smoothed) return null;
  let press = 0;
  if (clicks) {
    for (const c of clicks) {
      const dt = (mediaMs - c.t) / 1000;
      if (dt >= 0 && dt < PRESS_SEC) press = Math.max(press, 1 - dt / PRESS_SEC);
    }
  }
  return {
    x: (smoothed.x / vw) * placed.width + placed.translateX,
    y: (smoothed.y / vh) * placed.height + placed.translateY,
    press,
    leanDeg: cursorLeanDeg({points, mediaMs, vh, leanTier: leanTier ?? 0}),
  };
};
