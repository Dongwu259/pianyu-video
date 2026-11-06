/**
 * T3 转场锚点（纯函数，无运行时依赖，Node 可直跑单测）——RESEARCH-TRANSITIONS.md §二/T3。
 *
 * 「形状接形状」的运镜拟合：模板经 TemplateMeta.transitionAnchor 声明画面中天然的
 * 屏幕画框/设备壳/终端窗，zoomIn/zoomOut 出入段时镜头精确飞到锚点包围盒**盖满画布**
 * （cover 语义：长边方向溢出——手机壳宽锚点飞进去时高度溢出、宽幅画框锚点宽度溢出）。
 * 两段锚点形状匹配（如都有屏幕画框）时，出段末帧「锚点铺满」与入段首帧「从锚点铺满
 * 缩出」在拍点对接 = 无缝穿越的观感。
 *
 * 优先级：显式 transitionParams（focusX/focusY/zoom，用户在转场焦点编辑器设置的）>
 * 模板锚点拟合 > 旧默认（layout 自动焦点 / DEFAULT_ZOOM）。锚点只影响 zoomIn/zoomOut；
 * 其余转场类型不消费锚点。
 */

import {clamp, clampZoom, MIN_ZOOM, MAX_ZOOM, resolveFocus, type FocusPoint} from './transition-style';
import type {TemplateLayout, TransitionAnchor, TransitionParams} from './types';

/** 锚点包围盒（归一化，layout 偏移已叠加） */
export interface AnchorRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * 锚点 → 画布上的包围盒：followLayout（缺省）时中心叠加该段 layout.videoOffsetX/Y
 * （与 getAutoFocus 的自动焦点同口径，用户拖动画框偏移后锚点跟着走）。
 */
export const resolveAnchorRect = (anchor: TransitionAnchor, layout?: TemplateLayout): AnchorRect => {
  const follow = anchor.followLayout !== false;
  return {
    cx: clamp(anchor.cx + (follow ? (layout?.videoOffsetX ?? 0) : 0), 0, 1),
    cy: clamp(anchor.cy + (follow ? (layout?.videoOffsetY ?? 0) : 0), 0, 1),
    w: clamp(anchor.w, 0.01, 1),
    h: clamp(anchor.h, 0.01, 1),
  };
};

/**
 * cover 拟合：缩放倍率 zoom = max(1/w, 1/h)（归一化两轴同权——锚点包围盒缩放后
 * 宽 ≥ 画布宽 且 高 ≥ 画布高 = 盖满），焦点 = 锚点中心。zoom 钳 [MIN_ZOOM, MAX_ZOOM]
 * （MAX_ZOOM 已为锚点放宽到 6.5：手机壳宽锚点 w≈0.16 需要 ≈6.3 才能盖满横屏画布；
 * 显式手动参数仍由 llm-tools 校验器钳 1.2-4，UI 滑杆同源常量）。
 */
export const anchorZoomFit = (
  anchor: TransitionAnchor,
  layout?: TemplateLayout,
): {focus: FocusPoint; zoom: number} => {
  const r = resolveAnchorRect(anchor, layout);
  const zoom = clamp(Math.max(1 / r.w, 1 / r.h), MIN_ZOOM, MAX_ZOOM);
  return {focus: {x: r.cx, y: r.cy}, zoom};
};

/**
 * zoomIn/zoomOut 某一侧（出段/入段）的运镜参数解析：
 * - 显式 transitionParams.focusX/focusY/zoom 优先（用户手动设置的焦点/倍率不动）；
 * - 否则若锚点存在 → 锚点拟合（focus = 锚点中心，zoom = cover 倍率）；
 * - 否则回落旧行为（focus = autoFocusLayout 的视频画框中心；zoom = undefined →
 *   transitionStyle 内部用 DEFAULT_ZOOM，字符串级零回归）。
 *
 * @param params 边界转场参数（驱动方的 transitionParams）
 * @param anchor 本侧模板声明的锚点（出段 = 前段锚点、入段 = 后段锚点；无则 undefined）
 * @param anchorLayout 锚点属主的 layout（锚点跟随偏移用）
 * @param autoFocusLayout 自动焦点回落的 layout（旧行为：出段用下一段 layout、入段用本段 layout）
 */
export const resolveZoomTransitionOpts = (
  params: TransitionParams | undefined,
  anchor: TransitionAnchor | undefined,
  anchorLayout?: TemplateLayout,
  autoFocusLayout?: TemplateLayout,
): {focus: FocusPoint; zoom: number | undefined} => {
  const fit = anchor ? anchorZoomFit(anchor, anchorLayout) : null;
  const hasExplicitFocus = params?.focusX !== undefined || params?.focusY !== undefined;
  return {
    focus: hasExplicitFocus || !fit ? resolveFocus(params, autoFocusLayout) : fit.focus,
    zoom: params?.zoom !== undefined ? clampZoom(params.zoom) : fit?.zoom,
  };
};

/** 模板 meta 是否声明了合法锚点（w/h 在 (0,1]，注册表标注的健全性校验/单测用） */
export const isValidTransitionAnchor = (a: TransitionAnchor | undefined): a is TransitionAnchor =>
  !!a && (a.shape === 'rect' || a.shape === 'circle') &&
  a.w > 0 && a.w <= 1 && a.h > 0 && a.h <= 1 &&
  a.cx >= 0 && a.cx <= 1 && a.cy >= 0 && a.cy <= 1;
