/**
 * 点击放大丝滑化规划器（操作视频内核 M2；移植自 DogSC 的 AutoZoomPlanner 思路，MIT，
 * github.com/laogou717/dogsc Sources/RecorderCore/AutoZoomPlanner.swift）。
 *
 * 旧 clickZoomEnvelope（followCamera.ts）是「每次点击独立包络 + smoothstep」：
 * 同区域连点注视点来回跳、指针还在操作相机就回落、相邻包络各起各停。本模块用四个
 * 策略换掉这些不丝滑来源：
 * 1. 空间分组（区域稳定优先）：时间上连续（≤clickGroupGapSec）且包围盒 span 不超过
 *    放大后可视范围的 50%（X）/70%（Y）的点击合并为一个相机区域——同一可见区域里的
 *    按钮/输入框/列表项只动光标，不动整个画面；组焦点 = 包围盒中心。
 * 2. 指针活动延长：点击启动放大，但指针持续活动（事件间隔 ≤ activityIdleGapSec）期间
 *    一直保持；静默 settleSec 后才回落（还在操作时相机绝不抽走）。
 * 3. 相接交接：同一爆发内跨区域裂出的包络首尾相接（前组无出场）——交接期缩放保持
 *    满格、注视点从前组焦点平滑移交到后组焦点，不回零重启（速度连续 = 丝滑的本质；
 *    DogSC 把这层做在编辑器包络合并里，片语模板渲染没有编辑器 UI，直接做进采样器）。
 * 4. 弹簧缓动：欠阻尼解析解并归一化到端点——每段首尾精确落位，中段带轻微惯性回弹。
 *
 * 坐标口径：输入输出都是视频像素（与 CursorClick/CursorPoint 一致）；跨度判定按
 * videoW/videoH 归一化。纯函数确定性：同输入同输出，渲染/预览/单测共用。
 */

import type {CursorClick, CursorPoint} from './capture';

/** 包络规划参数（全部可选，默认值取自 DogSC 调优结果） */
export interface ClickZoomPlanOptions {
  /** 点击放大倍率（>1） */
  zoomScale: number;
  /** 进场时长秒 */
  enterSec?: number;
  /** 基础停留时长秒（指针仍在活动时会被 2 延长） */
  holdSec?: number;
  /** 出场时长秒（与后继相接的包络自动清零串联） */
  exitSec?: number;
  /** 时间分组阈值：间隔不超过该值的点击算同一次交互爆发 */
  clickGroupGapSec?: number;
  /** 指针活动判定：事件间隔不超过该值视为持续活动 */
  activityIdleGapSec?: number;
  /** 指针静默后的收尾停留（秒） */
  settleSec?: number;
  /** 焦点离画面边缘的最小归一化距离（0..0.5） */
  safeInset?: number;
  /** 空间分组跨度上限（相对放大后可视范围的比例） */
  spanXRatio?: number;
  spanYRatio?: number;
}

/** 一个相机区域包络（时间全部为毫秒；endMs 为保持期终点，effectEnd = endMs + exitMs） */
export interface ClickZoomEnvelope {
  startMs: number;
  endMs: number;
  enterMs: number;
  exitMs: number;
  /** 组焦点（视频像素，包围盒中心并钳 safeInset） */
  focus: {x: number; y: number};
  zoomScale: number;
}

/** 采样结果：amount ∈ [0,1] 弹簧进度；boost = 1 + (zoomScale-1)×amount；click 供波纹/高亮 */
export interface ClickZoomSmoothState {
  amount: number;
  boost: number;
  /** 当前包络组焦点（amount>0 时非空） */
  focus: {x: number; y: number} | null;
  /** 当前包络组内 ≤t 的最近真实点击（波纹画在真实点击处，不是组中心） */
  click: CursorClick | null;
}

const DEFAULTS = {
  enterSec: 0.7,
  holdSec: 0.9,
  exitSec: 0.7,
  clickGroupGapSec: 1.4,
  activityIdleGapSec: 1.4,
  settleSec: 0.55,
  safeInset: 0.12,
  spanXRatio: 0.5,
  spanYRatio: 0.7,
};

/** 弹簧手感档（springTone 参数）：0=标准=现状 / 1=轻快（更硬更快带回弹）/ 2=厚重（过阻尼慢沉） */
export interface SpringTone {
  mass: number;
  stiffness: number;
  damping: number;
  /** 响应窗（秒）：弹簧在该窗内归一收尾 */
  windowSec: number;
}

export const SPRING_TONES: Record<number, SpringTone> = {
  0: {mass: 1, stiffness: 170, damping: 26, windowSec: 0.72},
  // ω₀=20 ζ=0.69 欠阻尼：利落起跳带一次可感回弹
  1: {mass: 0.8, stiffness: 320, damping: 22, windowSec: 0.55},
  // ω₀=8.9 ζ=1.21 过阻尼：无回弹，缓沉到位
  2: {mass: 1.4, stiffness: 110, damping: 30, windowSec: 1.0},
};

/** 欠阻尼弹簧响应（移植自 DogSC ZoomAnimation.swift springProgress，归一化到端点） */
export const springProgress = (
  t: number,
  mass = 1,
  stiffness = 170,
  damping = 26,
  windowSec = 0.72,
): number => {
  const tt = Math.min(Math.max(t, 0), 1);
  if (tt <= 0 || tt >= 1) return tt;
  const m = Math.max(mass, 0.01);
  const k = Math.max(stiffness, 0.01);
  const c = Math.max(damping, 0.01);
  const omega0 = Math.sqrt(k / m);
  const zeta = Math.min(c / (2 * Math.sqrt(k * m)), 0.9999);
  const omegaD = omega0 * Math.sqrt(Math.max(1 - zeta * zeta, 1e-12));
  // 响应窗（默认 0.72s）；除以窗末响应值 → t=1 时精确回到 1（关键帧端点不漂）
  const duration = Math.max(windowSec, 0.05);
  const response = (s: number): number => {
    const envelope = Math.exp(-zeta * omega0 * s);
    const oscillation = Math.cos(omegaD * s) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * s);
    return 1 - envelope * oscillation;
  };
  return Math.min(Math.max(response(tt * duration) / response(duration), 0), 1);
};

/** 空间点击组：边收边扩的包围盒；焦点 = 包围盒中心 */
interface SpatialGroup {
  clicks: CursorClick[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const groupCanInclude = (
  g: SpatialGroup,
  click: CursorClick,
  spanX: number,
  spanY: number,
): boolean =>
  Math.max(g.maxX, click.x) - Math.min(g.minX, click.x) <= spanX &&
  Math.max(g.maxY, click.y) - Math.min(g.minY, click.y) <= spanY;

const groupAppend = (g: SpatialGroup, click: CursorClick): void => {
  g.clicks.push(click);
  g.minX = Math.min(g.minX, click.x);
  g.maxX = Math.max(g.maxX, click.x);
  g.minY = Math.min(g.minY, click.y);
  g.maxY = Math.max(g.maxY, click.y);
};

/**
 * 规划点击放大包络列表（时间升序、互不重叠）。
 * points 传轨迹采样（可空数组）：用于指针活动延长；无轨迹时退化为固定 hold。
 */
export const planClickZoomEnvelopes = (
  clicks: CursorClick[],
  points: CursorPoint[] | undefined,
  videoW: number,
  videoH: number,
  opts: ClickZoomPlanOptions,
): ClickZoomEnvelope[] => {
  if (!clicks.length || !(videoW > 0) || !(videoH > 0) || !(opts.zoomScale > 1)) return [];
  const o = {...DEFAULTS, ...opts};
  const valid = clicks
    .filter((c) => Number.isFinite(c.t) && c.t >= 0 && Number.isFinite(c.x) && Number.isFinite(c.y))
    .sort((a, b) => a.t - b.t);

  // ---- 时间分组 → 组内空间分组（同一爆发内空间也可裂成多区域：跨度按序贪心合并）----
  const visibleExtent = 1 / Math.max(o.zoomScale, 1);
  const spanX = visibleExtent * o.spanXRatio * videoW;
  const spanY = visibleExtent * o.spanYRatio * videoH;
  const temporalGroups: CursorClick[][] = [];
  for (const click of valid) {
    const prev = temporalGroups[temporalGroups.length - 1];
    // 与上一有效点击间隔 ≤ gap 才算同一爆发（与 DogSC 同口径：比最后元素不是比首元素）
    const lastClick = prev?.[prev.length - 1];
    if (lastClick && click.t - lastClick.t <= o.clickGroupGapSec * 1000) prev.push(click);
    else temporalGroups.push([click]);
  }

  const envelopes: ClickZoomEnvelope[] = [];
  let earliestNextStart = 0;
  for (const temporal of temporalGroups) {
    // 空间分组（按序贪心：跨度上限内并入当前组，超限开新组）
    const spatial: SpatialGroup[] = [];
    for (const click of temporal) {
      const cur = spatial[spatial.length - 1];
      if (cur && groupCanInclude(cur, click, spanX, spanY)) groupAppend(cur, click);
      else spatial.push({clicks: [click], minX: click.x, maxX: click.x, minY: click.y, maxY: click.y});
    }
    if (!spatial.length) continue;

    // 起播时刻：首个区域提前 enter 的 18%（点击前就进场，落点时已就位）；后续区域不早于上一 +0.16s
    const firstTime = temporal[0].t;
    const starts: number[] = [Math.max(firstTime - o.enterSec * 0.18 * 1000, earliestNextStart, 0)];
    for (let i = 1; i < spatial.length; i++) {
      starts.push(Math.max(spatial[i].clicks[0].t - o.enterSec * 1000, starts[i - 1] + 160));
    }
    const lastTime = temporal[temporal.length - 1].t;

    for (let i = 0; i < spatial.length; i++) {
      const isLast = i === spatial.length - 1;
      // 末区域：保持到爆发末 + 基础 hold（且至少容纳一个 enter）；中间区域：保持到下一区域起播
      const endMs = isLast
        ? Math.max(lastTime + o.holdSec * 1000, starts[i] + o.enterSec * 1000)
        : starts[i + 1];
      const exitMs = isLast ? o.exitSec * 1000 : 0;
      if (endMs - starts[i] <= 10) continue;
      const g = spatial[i];
      envelopes.push({
        startMs: starts[i],
        endMs,
        enterMs: o.enterSec * 1000,
        exitMs,
        focus: clampFocus(
          (g.minX + g.maxX) / 2,
          (g.minY + g.maxY) / 2,
          videoW,
          videoH,
          o.safeInset,
        ),
        zoomScale: opts.zoomScale,
      });
    }
    earliestNextStart = (envelopes[envelopes.length - 1]?.endMs ?? lastTime) +
      (envelopes[envelopes.length - 1]?.exitMs ?? 0);
  }

  return extendHoldsThroughPointerActivity(envelopes, valid, points, o);
};

/** 焦点钳 safeInset（离画面边缘留白，放大后不贴边） */
const clampFocus = (x: number, y: number, w: number, h: number, inset: number): {x: number; y: number} => ({
  x: Math.max(inset * w, Math.min((1 - inset) * w, x)),
  y: Math.max(inset * h, Math.min((1 - inset) * h, y)),
});

/**
 * 指针活动延长（DogSC extendingAutomaticHoldsThroughPointerActivity）：
 * 有出场过渡的包络，其组末点击之后指针仍持续活动（事件间隔 ≤ idleGap 且不越下一包络）
 * 时，把保持期延长到活动末 + settle；出场过渡压缩到剩余空间（放不下就直接交接）。
 */
const extendHoldsThroughPointerActivity = (
  envelopes: ClickZoomEnvelope[],
  orderedClicks: CursorClick[],
  points: CursorPoint[] | undefined,
  o: typeof DEFAULTS,
): ClickZoomEnvelope[] => {
  if (!envelopes.length || !points?.length || !orderedClicks.length) return envelopes;
  const events = points
    .filter((p) => Number.isFinite(p.t) && p.t >= 0)
    .sort((a, b) => a.t - b.t);
  if (!events.length) return envelopes;
  const result = envelopes.map((e) => ({...e}));

  for (let i = 0; i < result.length; i++) {
    if (result[i].exitMs <= 1) continue;
    const clip = result[i];
    // 包络保持期内（≤endMs）的最后一次点击
    let lastClick: CursorClick | null = null;
    for (const c of orderedClicks) {
      if (c.t <= clip.endMs + 0.1) lastClick = c;
      else break;
    }
    if (!lastClick || lastClick.t < clip.startMs - 0.1) continue;

    const nextStart = i + 1 < result.length ? result[i + 1].startMs : Infinity;
    // 从末点击起沿轨迹扫：间隔超 idleGap 即静默
    let activityEnd = lastClick.t;
    let prevT = lastClick.t;
    let j = lowerBound(events, lastClick.t);
    for (; j < events.length; j++) {
      const ev = events[j];
      if (ev.t >= nextStart - 0.1) break;
      if (ev.t - prevT > o.activityIdleGapSec * 1000) break;
      prevT = ev.t;
      activityEnd = ev.t;
    }
    if (activityEnd <= lastClick.t + 0.1) continue; // 末点击后无持续活动
    const extendedEnd = Math.min(Math.max(clip.endMs, activityEnd + o.settleSec * 1000), nextStart);
    if (extendedEnd <= clip.endMs + 0.1) continue;
    result[i] = {
      ...clip,
      endMs: extendedEnd,
      // 延长后出场过渡压到下一包络起播前放得下的部分（放不下 = 直接交接，不越界）
      exitMs: Math.min(clip.exitMs, Math.max(nextStart - extendedEnd, 0)),
    };
  }
  return result;
};

const lowerBound = (events: CursorPoint[], tMs: number): number => {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * 逐帧采样：找到「最近一个已开始且未完全出场」的包络（二分），按弹簧进度求 amount。
 * 包络不重叠（规划器保证），无活动包络时返回恒等态。
 * 相接交接（前包络 exit=0 且首尾相接）：交接期（后包络的 enter 窗）缩放保持满格、
 * 注视点从前组焦点平滑移交到本组焦点——同 DogSC「touching clips form one continuous
 * camera move」的交接语义，注视点全程钉住不产生「先居中后漂移」。
 */
export const sampleClickZoom = (
  envelopes: ClickZoomEnvelope[],
  tMs: number,
  clicks?: CursorClick[],
  spring?: SpringTone,
): ClickZoomSmoothState => {
  const idle: ClickZoomSmoothState = {amount: 0, boost: 1, focus: null, click: null};
  if (!envelopes.length) return idle;
  // 二分找最后 startMs ≤ t 的包络；不重叠 → 从它往后只需看一个
  let lo = 0;
  let hi = envelopes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (envelopes[mid].startMs <= tMs) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return idle;
  const e = envelopes[idx];
  const effectEnd = e.endMs + e.exitMs;
  if (tMs > effectEnd) return idle;

  const prev = idx > 0 ? envelopes[idx - 1] : undefined;
  const handedOver =
    prev !== undefined && prev.exitMs <= 1 && Math.abs(prev.endMs - e.startMs) <= 1;

  let amount: number;
  let focus = e.focus;
  const sp = (x: number) =>
    springProgress(x, spring?.mass, spring?.stiffness, spring?.damping, spring?.windowSec);
  if (tMs < e.startMs + e.enterMs) {
    const enterProgress = sp((tMs - e.startMs) / e.enterMs);
    if (handedOver) {
      // 交接期：缩放延续前组满格；注视点按同款弹簧进度平滑移交
      amount = 1;
      focus = {
        x: prev!.focus.x + (e.focus.x - prev!.focus.x) * enterProgress,
        y: prev!.focus.y + (e.focus.y - prev!.focus.y) * enterProgress,
      };
    } else {
      amount = enterProgress;
    }
  } else if (tMs <= e.endMs) {
    amount = 1;
  } else {
    amount = e.exitMs > 0 ? 1 - sp((tMs - e.endMs) / e.exitMs) : 0;
  }
  if (amount <= 0) return idle;
  // 波纹/高亮用组内最近真实点击（画在真实点击处），注视点用组焦点（稳定不跳）
  let click: CursorClick | null = null;
  if (clicks) {
    for (const c of clicks) {
      if (c.t > tMs) break;
      if (c.t >= e.startMs) click = c;
    }
  }
  return {amount, boost: 1 + (e.zoomScale - 1) * amount, focus, click};
};

/**
 * 指定坐标放大锚点（focusAnchorX/Y 参数，0-1 归一化；任一 > 0 即激活）：
 * 返回点击包络应使用的「放大中心」——激活时 = 锚点视频像素坐标（归一化 × videoW/H，
 * 与组焦点同 safeInset 钳位口径，贴边锚不把放大窗顶出画面）；未激活 = 包络组焦点（现状）。
 * 只覆盖放大中心这一个消费点：聚焦蒙版锚点（focusDimTarget 两档语义）与波纹/高亮
 * （画在真实点击处）不经过本函数——操作痕迹与注意力引导不跟锚点跑。
 * 包络未激活（focus=null）时原样返回 null：锚点只改落点，不凭空触发放大。
 * 多次点击恒定同锚 → 相邻包络交接期的焦点插值天然恒等（零漂移）。
 */
export const anchorZoomFocus = (
  state: {focus: {x: number; y: number} | null},
  anchorX: number,
  anchorY: number,
  videoW: number,
  videoH: number,
): {x: number; y: number} | null => {
  if (!(anchorX > 0) && !(anchorY > 0)) return state.focus;
  if (!state.focus) return state.focus;
  return clampFocus(anchorX * videoW, anchorY * videoH, videoW, videoH, DEFAULTS.safeInset);
};

// ====== 聚焦蒙版（D 项；DogSC FocusEffect 思路：兴趣点清晰、四周渐进虚化压暗） ======

/** 聚焦蒙版参数（模板 customParams，additive；默认值与 CURSOR_FOLLOW_PARAMS 注册一致） */
export interface FocusDimParams {
  /** 0/1 开关（默认关 = 现状不变） */
  focusDimOn: number;
  /** 虚化强度（px，0-16） */
  focusDimBlur: number;
  /** 清晰区半径（归一化，相对平面短边 0.15-0.5；条带模式 = 清晰带半高） */
  focusDimSize: number;
  /** 压暗程度（0-0.6） */
  focusDimDark: number;
  /** 锚定模式：0 = 组焦点（点击包围盒中心）；1 = 指针跟随（当前轨迹位置，
   *  DogSC FocusEffect 的 pointer 语义——打字/悬停场景内容不在点击点处时视线跟手） */
  focusDimTarget: number;
  /** 清晰区形状：0 = 横向椭圆（默认）；1 = 角度条带（DogSC linear 形状——代码行/表格/时间轴横条场景） */
  focusDimShape?: number;
  /** 条带角度（度，-90~90，0 = 水平带；条带模式生效） */
  focusDimAngle?: number;
}

export interface FocusMaskGeometry {
  /** 蒙版中心（平面像素；组焦点模式 = 包络组焦点映射，指针模式 = 当前轨迹注视点映射） */
  cx: number;
  cy: number;
  /** 清晰区半径（px；radial=Y 方向基准、X 拉长 aspect 倍；band=清晰带半高） */
  r: number;
  /** 清晰区横向拉长比（radial → 横向椭圆） */
  aspect: number;
  blur: number;
  dark: number;
  /** 层透明度 = 包络强度（与相机弹簧同参淡入淡出） */
  opacity: number;
  /** 清晰区形状（D5）：radial 横向椭圆 / band 角度条带 */
  shape: 'radial' | 'band';
  /** 条带角度（度；band 生效，0 = 水平带） */
  angleDeg: number;
}

/**
 * 聚焦蒙版几何解算（纯函数，渲染层只管铺 CSS）：点击包络激活时以锚点为中心，
 * 四周 backdrop 虚化+压暗、中心 mask 挖空保持清晰——视线钉在操作处。
 * 无包络/开关关闭返回 null（渲染层不挂层，零成本）。opacity = amount 让蒙版与
 * 相机缩放用同一弹簧进度进出（A/B 项的包络驱动）。
 * anchorX/Y：指针跟随模式的当前注视点（视频像素，调用方取轨迹当前帧）；组焦点
 * 模式忽略之（用包络组焦点）。
 */
export const focusMaskState = (
  dim: FocusDimParams,
  clickState: {amount: number; focus: {x: number; y: number} | null},
  cam: {scale: number; translateX: number; translateY: number},
  videoW: number,
  videoH: number,
  planeW: number,
  planeH: number,
  anchor?: {x: number; y: number} | null,
): FocusMaskGeometry | null => {
  if (dim.focusDimOn < 0.5 || !clickState.focus || clickState.amount <= 0.001) return null;
  const blur = Math.min(16, Math.max(0, dim.focusDimBlur));
  const dark = Math.min(0.6, Math.max(0, dim.focusDimDark));
  const size = Math.min(0.5, Math.max(0.15, dim.focusDimSize));
  // 锚点：指针跟随模式用调用方传入的当前注视点，组焦点模式用包络组焦点
  const ax = dim.focusDimTarget >= 0.5 && anchor ? anchor.x : clickState.focus.x;
  const ay = dim.focusDimTarget >= 0.5 && anchor ? anchor.y : clickState.focus.y;
  // 锚点的平面坐标（与波纹/高亮同款相机映射）
  const cx = planeW / 2 + cam.scale * (ax - videoW / 2) + cam.translateX;
  const cy = planeH / 2 + cam.scale * (ay - videoH / 2) + cam.translateY;
  return {
    cx,
    cy,
    r: size * Math.min(planeW, planeH),
    // 横向椭圆：文字行/输入框是横向内容，X 方向 1.7 倍覆盖整行（v8 打字场景实证修复）
    aspect: 1.7,
    blur,
    dark,
    opacity: Math.min(1, clickState.amount),
    shape: (dim.focusDimShape ?? 0) >= 0.5 ? 'band' : 'radial',
    angleDeg: Math.min(90, Math.max(-90, dim.focusDimAngle ?? 0)),
  };
};

/**
 * 可读性收框（D4，DogSC ZoomViewportTransform framingTargetInset=0.30 思路）：
 * 点击运镜满格时，落点从点击位置沿同一 amount 进度漂向中心 30% 内缩安全盒——
 * 高倍放大下点击内容不再贴死画布边缘难以阅读；focus 本就在安全区内时零漂移。
 * enter 漂入 / exit 原路返回（amount 同弹簧曲线，连续无跳变）。
 */
export const recenterFocus = (
  focus: {x: number; y: number},
  amount: number,
  videoW: number,
  videoH: number,
): {x: number; y: number} => {
  const inset = 0.3;
  const q = Math.min(Math.max(amount, 0), 1);
  const safeX = Math.min(Math.max(focus.x, videoW * inset), videoW * (1 - inset));
  const safeY = Math.min(Math.max(focus.y, videoH * inset), videoH * (1 - inset));
  // 漂移上限（v9 竖版反馈「放大聚焦没有聚到鼠标点击的位置」）：收框是轻推取景，
  // 不是把兴趣点从点击处搬走——满格时每轴最多向安全盒收 8% 画幅，贴边点击仍以点击为焦点
  const capX = videoW * 0.08;
  const capY = videoH * 0.08;
  const dx = Math.min(capX, Math.max(-capX, safeX - focus.x));
  const dy = Math.min(capY, Math.max(-capY, safeY - focus.y));
  return {x: focus.x + dx * q, y: focus.y + dy * q};
};

// ====== 悬停浮卡（一.2；指针驻留聚类 → 区域放大卡，ScreenDemo floatCard 的悬停版） ======

/** 轨迹采样中检测出的一个悬停事件（指针在小半径内驻留 ≥ hoverMs） */
export interface HoverEvent {
  /** 驻留起点毫秒 */
  t0: number;
  /** 驻留结束毫秒（指针移出半径或轨迹结束） */
  t1: number;
  /** 驻留中心（视频像素 = 驻留段采样均值） */
  x: number;
  y: number;
}

export interface HoverClusterOptions {
  videoW: number;
  videoH: number;
  /** 判定驻留的位移半径（视频像素，指针在此半径内视为没动） */
  stillRadiusPx?: number;
  /** 成悬停事件的最短驻留毫秒 */
  hoverMs?: number;
  /** 悬停结束后该毫秒内发生点击 → 整个事件让位点击运镜（浮卡不弹） */
  clickYieldMs?: number;
}

/**
 * 悬停聚类检测（纯函数）：沿轨迹扫「小半径不动段」，≥ hoverMs 的事件返回；
 * 结束后 clickYieldMs 内有点击的事件剔除（点击运镜接管，悬停只是点前犹豫）。
 * 与 cursor-smooth 的 STILL 判定同思路但独立参数化（那是重定时、这是事件检测）。
 */
export const hoverClusters = (
  points: CursorPoint[] | undefined,
  clicks: CursorClick[] | undefined,
  o: HoverClusterOptions,
): HoverEvent[] => {
  const stillR = o.stillRadiusPx ?? Math.max(4, o.videoW * 0.006);
  const hoverMs = o.hoverMs ?? 550;
  const yieldMs = o.clickYieldMs ?? 400;
  if (!points || points.length < 2) return [];
  const pts = points.filter((p) => Number.isFinite(p.t) && p.t >= 0).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return [];
  const events: HoverEvent[] = [];
  let anchor = pts[0];
  let sumX = pts[0].x;
  let sumY = pts[0].y;
  let n = 1;
  const flush = (endPt: CursorPoint) => {
    if (endPt.t - anchor.t >= hoverMs) {
      events.push({t0: anchor.t, t1: endPt.t, x: sumX / n, y: sumY / n});
    }
  };
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > stillR) {
      flush(pts[i - 1]); // 移出半径：驻留段结束于最后一个驻留点
      anchor = p;
      sumX = p.x;
      sumY = p.y;
      n = 1;
    } else {
      sumX += p.x;
      sumY += p.y;
      n++;
    }
  }
  flush(pts[pts.length - 1]);
  if (!events.length || !clicks?.length) return events;
  // 点击让位：事件结束后 yieldMs 内的最近点击（时间）在事件附近（点击运镜即将接管）
  return events.filter((e) => {
    const soonClick = clicks.find((c) => c.t >= e.t1 && c.t <= e.t1 + yieldMs);
    return !soonClick;
  });
};

/** 悬停浮卡逐帧状态（生长/保持/退场包络；ScreenDemo floatCard 同款语义的悬停版） */
export interface HoverCardState {
  cx: number;
  cy: number;
  /** 0..1 生长进度（easeOutCubic 已应用） */
  scale: number;
  opacity: number;
}

/**
 * tMs 时刻的悬停浮卡状态：驻留满 hoverMs 后 0.22s 从驻留点原地生长；指针移出
 * stillRadius×1.5 或驻留段结束 → 0.25s 收场；该事件时间轴上已过后不再出现。
 * 点击包络激活期间由调用方隐藏浮卡（点击运镜接管）。
 */
export const hoverCardState = (
  events: HoverEvent[],
  points: CursorPoint[] | undefined,
  tMs: number,
  o: HoverClusterOptions,
): HoverCardState | null => {
  const stillR = o.stillRadiusPx ?? Math.max(4, o.videoW * 0.006);
  const hoverMs = o.hoverMs ?? 550;
  const APPEAR = 220;
  const EXIT = 250;
  for (const e of events) {
    if (tMs < e.t0 + hoverMs) continue; // 该事件还没到浮卡时刻（后面的更没到）
    const appearAt = e.t0 + hoverMs;
    // 退场触发：驻留结束（指针走了）或轨迹里指针移出更大半径
    let exitAt = e.t1;
    if (points && points.length > 0) {
      const moved = points.find(
        (p) => p.t > appearAt && p.t <= e.t1 + EXIT && Math.hypot(p.x - e.x, p.y - e.y) > stillR * 1.5,
      );
      if (moved) exitAt = Math.min(exitAt, moved.t);
    }
    if (tMs > exitAt + EXIT) continue; // 已收完场，看下一事件
    const scale = tMs < appearAt + APPEAR
      ? 1 - Math.pow(1 - (tMs - appearAt) / APPEAR, 3)
      : 1;
    const opacity = tMs > exitAt ? 1 - (tMs - exitAt) / EXIT : 1;
    if (opacity <= 0) continue;
    return {cx: e.x, cy: e.y, scale, opacity};
  }
  return null;
};
