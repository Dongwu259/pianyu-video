/**
 * 元素级入场运动模糊（纯函数，可单测）。
 *
 * 问题：此前只有转场有方向拖影，文字/卡片入场无模糊——动效「硬」「数字味」。
 * 方案：按相邻两帧的真实位移量算模糊半径（≈ 快门曝光 0.6 帧的涂抹），入场速度
 * 越快糊得越开、入场结束自然归零。渲染逐帧出图，每帧静态 blur 即等效运动模糊。
 *
 * CSS blur() 是各向同性模糊：入场时长普遍 ≤0.8s、半径 ≤8px，观感与方向性
 * 模糊无差，且免去 SVG filter 定义/引用的结构成本（AnimatedText 头注的结构约束不变）。
 */

/** 入场模糊半径上限（px）：再大文字会糊成一团 */
export const ENTRANCE_BLUR_MAX_PX = 8;
/** 快门曝光系数（帧）：模糊半径 = 帧间位移 × 该系数 */
export const ENTRANCE_BLUR_EXPOSURE = 0.6;
/** 低于该半径不输出 filter（省一层 GPU 合成，也避免亚像素灰边） */
export const ENTRANCE_BLUR_MIN_PX = 0.15;

/** 由相邻两帧位移量（px）算模糊半径（带上下限） */
export const blurFromDelta = (deltaPx: number): number => {
  const r = Math.abs(deltaPx) * ENTRANCE_BLUR_EXPOSURE;
  return r < ENTRANCE_BLUR_MIN_PX ? 0 : Math.min(ENTRANCE_BLUR_MAX_PX, r);
};

/**
 * 缓动入场的模糊半径：入场进度 p（0..1）、位移幅度 distancePx、持续 durationFrames 帧。
 * 用 p 与上一帧 p-1/duration 的位移差（有限差分）算速度——任何缓动曲线都适用。
 */
export const entranceBlurAt = (
  p: number,
  distancePx: number,
  durationFrames: number,
  easing: (x: number) => number,
): number => {
  if (p >= 1 || durationFrames <= 0) return 0;
  const prev = Math.max(0, p - 1 / durationFrames);
  const offsetNow = (1 - easing(p)) * distancePx;
  const offsetPrev = (1 - easing(prev)) * distancePx;
  return blurFromDelta(offsetNow - offsetPrev);
};

/** 弹簧入场的模糊半径：给相邻两帧的弹簧值（0..1）与位移幅度。调用方本就逐帧算 spring，多算一帧 cf-1 即可 */
export const springBlurAt = (springNow: number, springPrev: number, distancePx: number): number =>
  blurFromDelta((springNow - springPrev) * distancePx);

/** 模糊半径 → CSS filter 字符串（0 返回 undefined，样式可直接透传） */
export const blurFilter = (radiusPx: number): string | undefined =>
  radiusPx > 0 ? `blur(${Math.round(radiusPx * 100) / 100}px)` : undefined;
