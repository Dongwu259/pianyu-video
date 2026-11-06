/**
 * 转场数学（纯函数，无运行时依赖，Node 可直跑单测）。
 *
 * 从 MultiSegmentPromo 迁出的全部转场样式计算 + 新增运镜转场（zoomIn/zoomOut/whip），
 * 以及虚拟相机连续运镜族（panChase/orbitSwipe，轨迹数学在 shared/virtual-camera.ts；
 * flyThrough 的 direction 参数化在本文件手写分支，默认行为逐像素冻结），
 * 以及 T2 遮挡物转场（cardSweep/shapeBloom，几何在 shared/transition-occluder.ts；
 * 本文件只管前后段可见性时序，遮挡物本身由合成器覆盖层渲染），
 * 供两处共用，保证时间模型与视觉完全一致：
 * - src/remotion/main/MultiSegmentPromo.tsx（渲染样式与重叠窗口）
 * - src/main/services/renderer.ts（总帧范围计算）
 *
 * 时间模型：前段内容结束后尾部多挂 outOverlap 帧，与后段入场窗口同帧同步（进度 q 0→1）。
 * 'none' 转场 outOverlap=0（硬切）；其余类型时长由 transitionParams.durationSec 决定（缺省 0.5s）。
 *
 * 运镜转场焦点：focus 是「下一片段」画面上的归一化坐标（0-1），缺省自动取下一片段
 * 视频画框中心（由 layout.videoOffsetX/Y 推算）；in/out 两侧围绕同一焦点缩放，形成连续运镜。
 */

import type {Segment, TemplateLayout, TransitionParams, TransitionType} from './types.ts';
import {evalEasingCurve, type EasingCurve} from './easing-curve.ts';
import {easeOutCubic, easeInOutCubic, easeInCubic} from './easings.ts';
import {virtualCameraStyle} from './virtual-camera.ts';
import {occluderSwitched} from './transition-occluder.ts';

// ====== 常量与钳制 ======

export const DEFAULT_TRANSITION_SEC = 0.5;
export const MIN_TRANSITION_SEC = 0.2;
export const MAX_TRANSITION_SEC = 2;
export const DEFAULT_ZOOM = 2;
export const MIN_ZOOM = 1.2;
/** 上限 6.5 为 T3 锚点 cover 拟合放宽（手机壳宽锚点 w≈0.16 需 ≈6.3 才能盖满横屏画布）；
 *  手动参数仍由 llm-tools 校验器与 TransitionFocusPicker 滑杆钳 1.2-4 口径提示 */
export const MAX_ZOOM = 6.5;

/**
 * 各转场类型的缺省时长（秒，@30fps 帧数）。
 * 依据专业快剪的行业规格：快切类转场 8-12 帧（whip/flash 0.3-0.35s）、
 * 位移类 12-14 帧（push/slide 0.4-0.45s）、溶解/展开类 15 帧（0.5s）、
 * 运镜类稍长（0.6s，镜头需要加速距离）。durationSec 未显式设置时按此表取值。
 */
export const TRANSITION_DEFAULT_SEC: Record<TransitionType, number> = {
  none: 0,
  crossfade: 0.5,
  slide: 0.4,
  wipe: 0.5,
  iris: 0.5,
  push: 0.45,
  velocityPush: 0.55,
  zoom: 0.5,
  rotate: 0.6,
  blur: 0.5,
  flash: 0.3,
  zoomIn: 0.6,
  zoomOut: 0.6,
  whip: 0.35,
  flyThrough: 0.6,
  panChase: 0.6,
  orbitSwipe: 0.8,
  cardSweep: 0.7,
  shapeBloom: 0.8,
};

/** 转场缺省时长（按类型查表；未知类型回 0.5s 全局缺省） */
export const getTransitionDefaultSec = (type: TransitionType): number =>
  TRANSITION_DEFAULT_SEC[type] ?? DEFAULT_TRANSITION_SEC;

/**
 * 把转场时长吸附到节拍的半拍网格（0.5×beatSec 的整数倍，钳在合法区间）。
 * 卡点剪辑里转场与切点一样踩拍：吸附后转场收束点恰好落在半拍上，
 * 视觉节奏与音乐网格对齐。beatSec <= 0 时原样返回。
 */
export const snapTransitionSecToBeats = (sec: number, beatSec: number): number => {
  const clamped = clampTransitionSec(sec);
  if (!Number.isFinite(beatSec) || beatSec <= 0) return clamped;
  const half = beatSec / 2;
  return clampTransitionSec(Math.round(clamped / half) * half);
};

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const clampTransitionSec = (sec: number): number => clamp(sec, MIN_TRANSITION_SEC, MAX_TRANSITION_SEC);

export const clampZoom = (z: number): number => clamp(z, MIN_ZOOM, MAX_ZOOM);

/** 片段尾部与下一段重叠的帧数：硬切=0；其余按 durationSec（缺省按类型查表，钳制 0.2-2） */
export const getTransitionFrames = (
  seg: Pick<Segment, 'transition' | 'transitionParams'>,
  fps: number,
): number => {
  if (seg.transition === 'none') return 0;
  const sec = clampTransitionSec(seg.transitionParams?.durationSec ?? getTransitionDefaultSec(seg.transition));
  return Math.max(1, Math.round(sec * fps));
};

/** 末段淡出到黑的帧数（全片收尾固定 0.5s，与片段间转场时长无关） */
export const getOutroFadeFrames = (fps: number): number => Math.max(1, Math.round(DEFAULT_TRANSITION_SEC * fps));

// ====== B3 转场高潮帧对拍（窗口骑跨切点）======

/**
 * 各转场类型的「高潮相位」：观众感知最强的一帧在转场窗口内的相对位置（0-1）。
 * 推导依据（与各转场数学逐类对拍，见 RESEARCH-TRANSITIONS.md §5.3）：
 * - 拖影/摆角/绽放/扫卡类中点达峰（sin 鼓包、驻留盖满区）→ 0.5；
 * - zoomIn/zoomOut 的「到位帧」（easeInOutCubic(0.85)≈0.9965，落定基本完成）→ 0.85；
 * - flash 白场满覆盖平台 q∈[0,0.25] 后衰减——拍点落平台尾（reveal 起点）→ 0.25；
 * - crossfade 线性无高潮 → 0 = 不骑跨，窗口保持「挂在切点后」的旧模型（零回归）；
 * - none 无窗口。
 * 压拍语义：切点（=段内容边界）已被 snapDurationsToBeats 吸到拍上，骑跨后
 * 高潮帧对准切点，即「炸点压拍」——窗口起点 = 切点 − peakPhase × duration。
 */
export const TRANSITION_PEAK_PHASE: Record<TransitionType, number> = {
  none: 0,
  crossfade: 0,
  slide: 0.5,
  wipe: 0.5,
  iris: 0.5,
  push: 0.5,
  velocityPush: 0.5,
  zoom: 0.5,
  rotate: 0.5,
  blur: 0.5,
  flash: 0.25,
  zoomIn: 0.85,
  zoomOut: 0.85,
  whip: 0.5,
  flyThrough: 0.5,
  panChase: 0.5,
  orbitSwipe: 0.5,
  cardSweep: 0.5,
  shapeBloom: 0.5,
};

/**
 * 各转场「默认节奏」对应的曲线预设（无自定义曲线时的真实行为近似）：
 * transitionStyle 无曲线路径分别直接用窗口进度 q（线性）、easeOutCubic（e）、
 * easeInOutCubic（ez）驱动——缓动曲线编辑器打开时据此显示该转场本来的节奏，
 * 而不是所有转场都显示同一条缓出。
 */
export const DEFAULT_TRANSITION_PRESET: Record<TransitionType, 'linear' | 'easeOut' | 'easeInOut'> = {
  none: 'linear',
  crossfade: 'linear', // 直接用 q
  wipe: 'linear',
  iris: 'linear',
  blur: 'linear',
  flash: 'linear', // 底层不动（白闪覆盖层）
  slide: 'easeOut',
  rotate: 'easeOut',
  flyThrough: 'easeOut',
  push: 'easeInOut',
  velocityPush: 'easeInOut', // 出段 easeIn 加速 + 入段 easeOut 减速（合成节奏近似 easeInOut）
  zoom: 'easeInOut',
  zoomIn: 'easeInOut',
  zoomOut: 'easeInOut',
  whip: 'easeInOut',
  panChase: 'easeInOut',
  orbitSwipe: 'easeInOut',
  cardSweep: 'easeInOut',
  shapeBloom: 'easeInOut',
};

/** 一个段间转场窗口的完整描述（B3 骑跨模型；frames=0 表示无窗口/硬切） */
export interface TransitionWindow {
  /** 前段下标（窗口由 segments[i].transition 驱动，覆盖边界 i → i+1） */
  segIndex: number;
  /** 窗口总帧数 W */
  frames: number;
  /** 该转场类型的高潮相位常量 */
  peakPhase: number;
  /** 切点前占用的帧数（骑跨进前段内容；crossfade/none 恒 0） */
  headPad: number;
  /** 切点后占用的帧数（吃进后段内容；= 旧模型的 outOverlap） */
  tail: number;
  /** 窗口首帧（绝对帧，= 前段 contentEnd − headPad） */
  startFrame: number;
  /** 高潮帧（绝对帧；frames>0 时与切点同帧，舍入差 ≤ 半帧由取整吸收） */
  climaxFrame: number;
  /** 窗口末帧（开区间端，= 前段 contentEnd + tail） */
  endFrame: number;
}

/**
 * 全片转场窗口规划（B3 骑跨时间模型，纯函数——合成器挂载/音效锚点/冒烟断言共用）。
 *
 * 窗口 = [切点 − peak×W, 切点 + (1−peak)×W]，高潮帧 = 切点 = 内容边界（拍点吸附不变）。
 * 双侧钳制（防窗口越界与相邻窗口互相重叠，从左到右一遍求解）：
 * - 头部约束：head_i ≤ 前段剩余内容 = contentDuration_i − tail_{i-1}（上一窗口尾已占部分）；
 * - 尾部约束：tail_i ≤ 下一段全部内容 contentDuration_{i+1}（下一段自己的头由下一轮
 *   头部约束在其剩余内容内求解）。
 * 由此归纳可得相邻窗口严格不重叠：windowEnd_{i-1} = contentStart_i + tail_{i-1}
 * ≤ contentStart_i + contentDuration_i − head_i = windowStart_i。
 * 时长为 0 的段（引用已删除模板）不产生窗口也不承载窗口（与旧模型一致）。
 *
 * @param segments 各段的 transition/transitionParams（驱动窗口的类型与时长）
 * @param contentFrames 各段内容帧数（与 segments 等长；不可渲染段 = 0）
 * @param fps 帧率
 */
export const computeTransitionWindows = (
  segments: Array<Pick<Segment, 'transition' | 'transitionParams'>>,
  contentFrames: number[],
  fps: number,
): TransitionWindow[] => {
  const n = segments.length;
  const out: TransitionWindow[] = [];
  let prevTail = 0; // 上一窗口的尾（在本段内容头部已占用的帧数）
  let acc = 0; // 段内容起点游标（绝对帧）
  for (let i = 0; i < n; i++) {
    const own = contentFrames[i] ?? 0;
    const next = i + 1 < n ? (contentFrames[i + 1] ?? 0) : 0;
    const cutFrame = acc + own; // 切点 = 本段内容结束帧（若为末段则无意义但不使用）
    const noWindow = (segIndex: number, startFrame: number): TransitionWindow => ({
      segIndex, frames: 0, peakPhase: 0, headPad: 0, tail: 0,
      startFrame, climaxFrame: startFrame, endFrame: startFrame,
    });
    if (own <= 0 || i === n - 1 || next <= 0 || segments[i].transition === 'none') {
      out.push(noWindow(i, cutFrame));
      prevTail = 0;
      acc += own;
      continue;
    }
    const peak = TRANSITION_PEAK_PHASE[segments[i].transition] ?? 0.5;
    const raw = getTransitionFrames(segments[i], fps);
    // 头/尾各自的可用帧数上界（peak=0 时头部无约束 = 旧模型单侧钳制）
    const maxByHead = peak > 0 ? Math.floor((own - prevTail) / peak) : Infinity;
    const maxByTail = peak < 1 ? Math.floor(next / (1 - peak)) : Infinity;
    const frames = Math.max(0, Math.min(raw, maxByHead, maxByTail));
    const headPad = Math.round(peak * frames);
    const tail = frames - headPad;
    out.push({
      segIndex: i,
      frames,
      peakPhase: frames > 0 ? peak : 0,
      headPad,
      tail,
      startFrame: cutFrame - headPad,
      climaxFrame: cutFrame,
      endFrame: cutFrame + tail,
    });
    prevTail = tail;
    acc += own;
  }
  return out;
};

// ====== 运镜焦点 ======

export interface FocusPoint {
  x: number;
  y: number;
}

/** 由 layout 推算视频画框中心的归一化坐标（运镜转场的自动焦点） */
export const getAutoFocus = (layout?: TemplateLayout): FocusPoint => {
  if (!layout) return {x: 0.5, y: 0.5};
  return {
    x: clamp(0.5 + (layout.videoOffsetX ?? 0), 0, 1),
    y: clamp(0.5 + (layout.videoOffsetY ?? 0), 0, 1),
  };
};

/** 解析运镜焦点：显式参数优先，缺省用下一片段视频画框中心 */
export const resolveFocus = (params: TransitionParams | undefined, nextLayout?: TemplateLayout): FocusPoint => {
  const auto = getAutoFocus(nextLayout);
  return {
    x: clamp(params?.focusX ?? auto.x, 0, 1),
    y: clamp(params?.focusY ?? auto.y, 0, 1),
  };
};

// ====== 转场样式 =====

/** 转场样式（纯数据，结构上兼容 React.CSSProperties 的子集） */
export interface TransitionStyle {
  opacity?: number;
  transform?: string;
  clipPath?: string;
  filter?: string;
  transformOrigin?: string;
  /**
   * 方向性运动模糊（px）：转场中元素沿运动方向的拖影量。
   * CSS blur() 是各向同性的，方向拖影需要 SVG feGaussianBlur(x y)——
   * 合成器（MultiSegmentPromo）把它渲染成动态 SVG 滤镜挂到 wrapper 上。
   */
  motionBlur?: {x: number; y: number};
}

export type TransitionRole = 'in' | 'out';

export interface TransitionStyleOpts {
  /** 运镜焦点（zoomIn/zoomOut）/ 形状绽放圆心（shapeBloom），缺省画面中心 */
  focus?: FocusPoint;
  /** 推进/拉远倍率（仅 zoomIn/zoomOut 使用），缺省 2 */
  zoom?: number;
  /** 缓动曲线（多点 AE 风格）；设置后替换该转场默认的硬编码缓动 */
  curve?: EasingCurve;
  /**
   * 运动朝向档位：slide/push/velocityPush/wipe/whip/panChase/orbitSwipe/cardSweep 用 1上 2下 3左 4右；
   * flyThrough 用 1推近穿过（缺省）/ 2拉远飞出。
   * 缺省各转场内置方向（slide/push/velocityPush/whip/panChase/orbitSwipe/cardSweep 向左、wipe 向右、flyThrough 推近，零回归）。
   */
  direction?: number;
}

/** direction 档位 → 运动朝向单位向量；非法/未给时回退该转场内置默认方向（零回归） */
const dirVecOf = (direction: number | undefined, fallback: {x: number; y: number}): {x: number; y: number} => {
  switch (Math.round(direction ?? 0)) {
    case 1: return {x: 0, y: -1};
    case 2: return {x: 0, y: 1};
    case 3: return {x: -1, y: 0};
    case 4: return {x: 1, y: 0};
    default: return fallback;
  }
};

/** wipe 擦除的方向性 clip-path：沿运动朝向逐渐显出（q 0→1） */
const wipeClip = (q: number, v: {x: number; y: number}): string => {
  const r = (1 - q) * 100;
  if (v.x > 0) return `inset(0 ${r}% 0 0)`;   // 从左向右显出
  if (v.x < 0) return `inset(0 0 0 ${r}%)`;   // 从右向左显出
  if (v.y > 0) return `inset(0 0 ${r}% 0)`;   // 从上向下显出
  return `inset(${r}% 0 0 0)`;                 // 从下向上显出
};

/** direction 是否显式给出（1-4）；未给时各转场输出旧版水平位移字符串（字符串级零回归） */
const hasExplicitDir = (direction: number | undefined): boolean =>
  direction !== undefined && Math.round(direction) >= 1 && Math.round(direction) <= 4;

/** 位移字符串：显式方向走向量 translate(x,y)；未显式时输出旧版 translateX（字符串级零回归） */
const travelTranslate = (v: {x: number; y: number}, mag: number, legacyX: number, explicit: boolean): string =>
  explicit ? `translate(${v.x * mag}%, ${v.y * mag}%)` : `translateX(${legacyX}%)`;

/**
 * 机械路径：给定已缓动的进度 p（通常为 0..1，曲线越界点可超出），计算转场样式（不另加缓动）。
 * 供 opts.curve 设置时使用——曲线负责"速度"，本函数负责"变化内容"。
 * 与无曲线路径的视觉等价（把 p 视作原 e/ez/q）。
 * 注意：clip-path / blur 通道内部会用钳制到 [0,1] 的进度（见函数内注释），
 * transform 通道保留越界以呈现回弹/预期效果。
 */
const mechanicalStyle = (
  type: TransitionType,
  role: TransitionRole,
  p: number,
  opts?: TransitionStyleOpts,
): TransitionStyle => {
  // 曲线进度 p 可越界（anticipate 预设 y 低至 -0.12，bounce 高至 1.12）。
  // translate/scale/rotate 容忍越界（越界正是回弹/预期效果）；opacity 由浏览器自钳。
  // 但 clip-path（circle 负半径 = 非法，整条声明失效跳帧）与 blur（负值同样非法）
  // 不接受越界，这些通道一律改用钳制后的 pc。
  const pc = clamp(p, 0, 1);
  switch (type) {
    case 'crossfade':
      return {opacity: role === 'in' ? p : 1 - p};
    case 'slide': {
      // 后段从 −v 侧滑入覆盖前段（前段不动）；缺省向左滑（v=(-1,0)，同旧版）
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(pc * Math.PI) * 6;
      return role === 'in'
        ? {
            opacity: p,
            transform: travelTranslate({x: -v.x, y: -v.y}, (1 - p) * 100, (1 - p) * 100, hasExplicitDir(opts?.direction)),
            motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)},
          }
        : {};
    }
    case 'wipe':
      return role === 'in' ? {clipPath: wipeClip(pc, dirVecOf(opts?.direction, {x: 1, y: 0}))} : {};
    case 'iris':
      return role === 'in' ? {clipPath: `circle(${pc * 150}% at 50% 50%)`} : {};
    case 'push': {
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(pc * Math.PI) * 9;
      return role === 'in'
        ? {transform: travelTranslate({x: -v.x, y: -v.y}, (1 - p) * 100, (1 - p) * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {transform: travelTranslate(v, p * 100, -p * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}};
    }
    case 'velocityPush': {
      // 速度匹配（velocity-matched，round5 实证 scene 峰值 0.159 口径）：出段全程加速离场、
      // 入段全程减速停稳——切点两侧速度同为峰值且同向（目光无回摆）；位移 110% 保证整窗在动、
      // 中点 sin 拖影 18px 掩护硬切。曲线路径：p 已含速度，机械管位移量。
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(pc * Math.PI) * 18;
      return role === 'in'
        ? {transform: travelTranslate({x: -v.x, y: -v.y}, (1 - p) * 110, (1 - p) * 110, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {transform: travelTranslate(v, p * 110, -p * 110, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}};
    }
    case 'zoom':
      return role === 'in'
        ? {opacity: p, transform: `scale(${0.6 + 0.4 * p})`}
        : {opacity: 1 - p, transform: `scale(${1 + 0.15 * p})`};
    case 'rotate':
      return role === 'in'
        ? {opacity: p, transform: `perspective(1200px) rotateY(${(1 - p) * 90}deg)`}
        : {opacity: 1 - p, transform: `perspective(1200px) rotateY(${-p * 90}deg)`};
    case 'blur':
      return role === 'in'
        ? {opacity: p, filter: `blur(${(1 - pc) * 16}px)`}
        : {opacity: 1 - p, filter: `blur(${pc * 16}px)`};
    case 'flash':
      return {};
    case 'zoomIn': {
      const zoom = clampZoom(opts?.zoom ?? DEFAULT_ZOOM);
      const focus = opts?.focus ?? {x: 0.5, y: 0.5};
      const origin = `${focus.x * 100}% ${focus.y * 100}%`;
      return role === 'in'
        ? {opacity: p, transform: `scale(${zoom + (1 - zoom) * p})`, transformOrigin: origin, filter: `blur(${(1 - pc) * 4}px)`}
        : {opacity: 1 - p, transform: `scale(${1 + (zoom - 1) * p})`, transformOrigin: origin, filter: `blur(${pc * 4}px)`};
    }
    case 'zoomOut': {
      const zoom = clampZoom(opts?.zoom ?? DEFAULT_ZOOM);
      const focus = opts?.focus ?? {x: 0.5, y: 0.5};
      const origin = `${focus.x * 100}% ${focus.y * 100}%`;
      const z0 = 1 + (zoom - 1) * 0.4;
      return role === 'in'
        ? {opacity: p, transform: `scale(${z0 + (1 - z0) * p})`, transformOrigin: origin, filter: `blur(${(1 - pc) * 4}px)`}
        : {opacity: 1 - p, transform: `scale(${1 + 0.1 * p})`, transformOrigin: origin, filter: `blur(${pc * 8}px)`};
    }
    case 'whip': {
      // 快速甩镜：沿运动朝向拖影在中点达峰遮住接缝（缺省向左，同旧版）
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(pc * Math.PI) * 24;
      return role === 'in'
        ? {transform: travelTranslate({x: -v.x, y: -v.y}, (1 - p) * 100, (1 - p) * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {transform: travelTranslate(v, p * 100, -p * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}};
    }
    case 'flyThrough': {
      // 3D 穿越：镜头扎进前段画面（冲过镜头 + 曝光提亮淡出），后段从纵深飞来（blur 收拢）。
      // perspective 内联在 transform 里（rotate 先例）；z 用钳制进度 pc（translateZ 不容越界）。
      // direction=2 拉远飞出：前段向纵深远去缩小变暗，后段从放大近景回落收拢（缺省 1 推近穿过，逐像素冻结）。
      if (Math.round(opts?.direction ?? 1) === 2) {
        return role === 'in'
          ? {opacity: p, transform: `perspective(900px) translateZ(${(1 - pc) * 480}px)`, filter: `blur(${(1 - pc) * 8}px)`}
          : {opacity: 1 - p * p, transform: `perspective(900px) translateZ(${pc * -640}px)`, filter: `brightness(${1 - pc * 0.45})`};
      }
      return role === 'in'
        ? {opacity: p, transform: `perspective(900px) translateZ(${(1 - pc) * -600}px)`, filter: `blur(${(1 - pc) * 10}px)`}
        : {opacity: 1 - p * p, transform: `perspective(900px) translateZ(${pc * 420}px)`, filter: `brightness(${1 + pc * 0.7})`};
    }
    case 'panChase':
    case 'orbitSwipe':
      // 虚拟相机轨迹（shared/virtual-camera.ts）：曲线输出 p 作为替换缓动直接喂轨迹；
      // 拖影/压暗通道内部用钳制进度（同本函数 pc 政策），transform 保留越界呈现回弹。
      return virtualCameraStyle(type, role, p, opts);
    case 'cardSweep':
    case 'shapeBloom':
      // 遮挡物转场（shared/transition-occluder.ts）：前后段可见性由覆盖锁存驱动——
      // 曲线输出 p 喂同一几何，首次盖满 ⟺ 入段就位/出段隐藏（之后不再切回）。
      // 遮挡物本身由合成器覆盖层渲染；切换瞬间必被盖住，任何曲线下零穿帮。
      return occluderSwitched(type, p, opts)
        ? role === 'in' ? {} : {opacity: 0}
        : role === 'in' ? {opacity: 0} : {};
    case 'none':
    default:
      return {};
  }
};

/**
 * 计算转场在某一方（后段入场 in / 前段出场 out）的样式。
 * - 设置 opts.curve 时：用曲线把 q 缓动为 p，走机械路径（曲线掌控速度）。
 * - 无曲线时：保持原有 e/ez 硬编码缓动（行为不变）。
 */
export const transitionStyle = (
  type: TransitionType,
  role: TransitionRole,
  q: number,
  opts?: TransitionStyleOpts,
): TransitionStyle => {
  const curve = opts?.curve;
  if (curve && curve.points && curve.points.length >= 2) {
    return mechanicalStyle(type, role, evalEasingCurve(curve, q), opts);
  }
  const e = easeOutCubic(q);
  const ez = easeInOutCubic(q);
  switch (type) {
    case 'crossfade':
      return {opacity: role === 'in' ? q : 1 - q};
    case 'slide': {
      // 后段从 −v 侧滑入覆盖前段（前段不动）；缺省向左滑（同旧版）
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(q * Math.PI) * 6;
      return role === 'in'
        ? {opacity: q, transform: travelTranslate({x: -v.x, y: -v.y}, (1 - e) * 100, (1 - e) * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {};
    }
    case 'wipe':
      // 沿运动朝向擦开显出；缺省从左向右（同旧版）
      return role === 'in' ? {clipPath: wipeClip(q, dirVecOf(opts?.direction, {x: 1, y: 0}))} : {};
    case 'iris':
      // 后段由中心圆形展开（150% 确保满覆盖，避免收尾跳变）
      return role === 'in' ? {clipPath: `circle(${q * 150}% at 50% 50%)`} : {};
    case 'push': {
      // 双片同移；轻量方向拖影提速感（缺省向左，同旧版）
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(q * Math.PI) * 9;
      return role === 'in'
        ? {transform: travelTranslate({x: -v.x, y: -v.y}, (1 - ez) * 100, (1 - ez) * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {transform: travelTranslate(v, ez * 100, -ez * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}};
    }
    case 'velocityPush': {
      // 速度匹配（velocity-matched）：出段 easeIn³ 全程加速（末速=峰值恰在切点）、
      // 入段 easeOut³ 全程减速（初速=同峰值）——同窗同位移下两导数相等，切点速度严格连续；
      // 对照 push 的 easeInOut（切点中速非峰值）与 whip（out 线性恒速，切点速度跳变）。
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(q * Math.PI) * 18;
      return role === 'in'
        ? {transform: travelTranslate({x: -v.x, y: -v.y}, (1 - easeOutCubic(q)) * 110, (1 - easeOutCubic(q)) * 110, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {transform: travelTranslate(v, easeInCubic(q) * 110, -easeInCubic(q) * 110, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}};
    }
    case 'zoom':
      return role === 'in'
        ? {opacity: q, transform: `scale(${0.6 + 0.4 * ez})`}
        : {opacity: 1 - q, transform: `scale(${1 + 0.15 * ez})`};
    case 'rotate':
      return role === 'in'
        ? {opacity: q, transform: `perspective(1200px) rotateY(${(1 - e) * 90}deg)`}
        : {opacity: 1 - q, transform: `perspective(1200px) rotateY(${-e * 90}deg)`};
    case 'blur':
      return role === 'in'
        ? {opacity: q, filter: `blur(${(1 - q) * 16}px)`}
        : {opacity: 1 - q, filter: `blur(${q * 16}px)`};
    case 'flash':
      // 底层不淡化，由白色覆盖层（渲染时单独叠加）遮蔽切换
      return {};
    case 'zoomIn': {
      // 镜头推进：两侧围绕同一焦点连续缩放，中点（q=0.5）两侧 scale 相等，无缝衔接。
      // 前段 1→zoom 扎进焦点并淡出；后段 zoom→1 从焦点区域落定并淡入。
      const zoom = clampZoom(opts?.zoom ?? DEFAULT_ZOOM);
      const focus = opts?.focus ?? {x: 0.5, y: 0.5};
      const origin = `${focus.x * 100}% ${focus.y * 100}%`;
      return role === 'in'
        ? {
            opacity: q,
            transform: `scale(${zoom + (1 - zoom) * ez})`,
            transformOrigin: origin,
            filter: `blur(${(1 - q) * 4}px)`,
          }
        : {
            opacity: 1 - q,
            transform: `scale(${1 + (zoom - 1) * ez})`,
            transformOrigin: origin,
            filter: `blur(${q * 4}px)`,
          };
    }
    case 'zoomOut': {
      // 镜头拉远：前段轻推+重模糊淡出（后退感）；后段从略放大状态回落到 1（镜头拉远落定）。
      const zoom = clampZoom(opts?.zoom ?? DEFAULT_ZOOM);
      const focus = opts?.focus ?? {x: 0.5, y: 0.5};
      const origin = `${focus.x * 100}% ${focus.y * 100}%`;
      const z0 = 1 + (zoom - 1) * 0.4; // 后段起始倍率（默认 zoom=2 → 1.4）
      return role === 'in'
        ? {
            opacity: q,
            transform: `scale(${z0 + (1 - z0) * ez})`,
            transformOrigin: origin,
            filter: `blur(${(1 - q) * 4}px)`,
          }
        : {
            opacity: 1 - q,
            transform: `scale(${1 + 0.1 * ez})`,
            transformOrigin: origin,
            filter: `blur(${q * 8}px)`,
          };
    }
    case 'whip': {
      // 快速甩镜：双片同移，方向拖影在中点达峰遮住接缝；无淡入淡出（缺省向左，同旧版）。
      const v = dirVecOf(opts?.direction, {x: -1, y: 0});
      const blur = Math.sin(q * Math.PI) * 24;
      return role === 'in'
        ? {transform: travelTranslate({x: -v.x, y: -v.y}, (1 - ez) * 100, (1 - ez) * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}}
        : {transform: travelTranslate(v, ez * 100, -ez * 100, hasExplicitDir(opts?.direction)), motionBlur: {x: blur * Math.abs(v.x), y: blur * Math.abs(v.y)}};
    }
    case 'flyThrough': {
      // 3D 穿越（无曲线路径）：与 mechanicalStyle 同款——前段扎进冲镜头+提亮淡出，后段纵深飞来+blur 收拢。
      // direction=2 拉远飞出（与机械路径同语义）；缺省 1 推近穿过，逐像素冻结。
      const qz = Math.min(1, Math.max(0, q));
      if (Math.round(opts?.direction ?? 1) === 2) {
        return role === 'in'
          ? {opacity: q, transform: `perspective(900px) translateZ(${(1 - qz) * 480}px)`, filter: `blur(${(1 - qz) * 8}px)`}
          : {opacity: 1 - q * q, transform: `perspective(900px) translateZ(${qz * -640}px)`, filter: `brightness(${1 - qz * 0.45})`};
      }
      return role === 'in'
        ? {opacity: q, transform: `perspective(900px) translateZ(${(1 - qz) * -600}px)`, filter: `blur(${(1 - qz) * 10}px)`}
        : {opacity: 1 - q * q, transform: `perspective(900px) translateZ(${qz * 420}px)`, filter: `brightness(${1 + qz * 0.7})`};
    }
    case 'panChase':
    case 'orbitSwipe':
      // 虚拟相机轨迹（无曲线路径）：轨迹内部自带缓动剖面（panChase 余弦启停 / orbitSwipe easeInOutCubic），
      // 这里直接喂窗口进度 q；motionBlur 随相机速度的中段鼓包输出。
      return virtualCameraStyle(type, role, q, opts);
    case 'cardSweep':
    case 'shapeBloom':
      // 遮挡物转场（无曲线路径）：与机械路径同语义——可见性由覆盖锁存驱动（首次盖满 ⟺ 入段就位），
      // 遮挡物几何/渲染见 shared/transition-occluder.ts 与 MultiSegmentPromo 覆盖层。
      return occluderSwitched(type, q, opts)
        ? role === 'in' ? {} : {opacity: 0}
        : role === 'in' ? {opacity: 0} : {};
    case 'none':
    default:
      return {};
  }
};
