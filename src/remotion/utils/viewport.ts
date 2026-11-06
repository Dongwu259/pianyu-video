/**
 * 取景视口（viewport）几何计算
 *
 * 纯函数，不依赖 remotion —— Remotion 渲染层（Video3D / CustomTemplateRender）
 * 与渲染进程取景编辑器（ClipViewportEditor）共用同一份数学，保证所见即所得。
 *
 * 组合方式：先由 fitVideo 得到基础适配尺寸（base），再叠加
 * viewport.scale 缩放与 viewport.offset（占画框比例）平移，
 * 最后按适配模式夹取，保证：
 * - cover：缩放后媒体始终完全覆盖画框（平移范围 ±(媒体−画框)/2）
 * - contain：媒体不超出画框（平移范围 ±|媒体−画框|/2，放大后同 cover）
 */

import type {ClipViewport, FitMode} from '../../shared/types';
import type {FitResult} from './fitVideo';

/** 编辑器侧的缩放倍率限制（渲染侧只做宽松夹取，见 clampViewport） */
export const VIEWPORT_SCALE_LIMITS: Record<FitMode, {min: number; max: number}> = {
  cover: {min: 1, max: 4},
  contain: {min: 0.5, max: 4},
};

/** 渲染侧宽松限制：防止异常数据破坏画面（cover 额外强制 ≥1 以维持覆盖） */
const RENDER_SCALE_MIN = 0.1;
const RENDER_SCALE_MAX = 8;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** 是否为默认取景（无需存到片段数据里） */
export const isDefaultViewport = (v: ClipViewport | undefined): boolean =>
  !v || (v.scale === 1 && v.offsetX === 0 && v.offsetY === 0);

/**
 * 夹取取景参数，返回合法化后的 viewport。
 * 平移上限按「缩放后尺寸与画框尺寸之差的一半」换算成画框比例：
 *   maxOffset = |base·scale − frame| / 2 / frame
 */
export const clampViewport = (
  frameW: number,
  frameH: number,
  baseW: number,
  baseH: number,
  mode: FitMode,
  viewport: ClipViewport
): ClipViewport => {
  const minScale = mode === 'cover' ? 1 : RENDER_SCALE_MIN;
  const scale = clamp(viewport.scale || 1, minScale, RENDER_SCALE_MAX);
  const w = baseW * scale;
  const h = baseH * scale;
  const maxOX = frameW > 0 ? Math.abs(w - frameW) / 2 / frameW : 0;
  const maxOY = frameH > 0 ? Math.abs(h - frameH) / 2 / frameH : 0;
  return {
    scale,
    offsetX: clamp(viewport.offsetX || 0, -maxOX, maxOX),
    offsetY: clamp(viewport.offsetY || 0, -maxOY, maxOY),
  };
};

export interface ViewportPlacement {
  width: number;       // 媒体最终绘制宽度（px）
  height: number;      // 媒体最终绘制高度（px）
  translateX: number;  // 媒体左上角相对画框左上角的 X 位移（px）
  translateY: number;  // 媒体左上角相对画框左上角的 Y 位移（px）
}

/**
 * 将取景视口应用到 fitVideo 的基础适配结果上。
 * viewport 缺省时退化为原 fit 行为（媒体居中：
 * cover 时 translate = −fit.offset，contain 时 = +fit.offset，两者都等于 (frame−base)/2）。
 */
export const applyViewport = (
  frameW: number,
  frameH: number,
  base: FitResult,
  mode: FitMode,
  viewport?: ClipViewport
): ViewportPlacement => {
  if (!viewport) {
    return {
      width: base.width,
      height: base.height,
      translateX: (frameW - base.width) / 2,
      translateY: (frameH - base.height) / 2,
    };
  }
  const v = clampViewport(frameW, frameH, base.width, base.height, mode, viewport);
  const w = base.width * v.scale;
  const h = base.height * v.scale;
  return {
    width: w,
    height: h,
    translateX: (frameW - w) / 2 + v.offsetX * frameW,
    translateY: (frameH - h) / 2 + v.offsetY * frameH,
  };
};
