/**
 * 点击目标描边高亮（1.6 操作视频内核 M1，纯函数）。
 *
 * FocuSee / Loom 双例确认的行业共识手法：点击瞬间在目标元素处渐显一圈描边高亮，
 * 把视线牵到「点了什么」上（水波只表现「点了」，高亮表现「点到了什么」）。
 * 录屏是像素没有 DOM 信息——高亮框以点击点为中心的启发式圆角矩形（宽 = 视频宽 × 比例），
 * 渐显 120ms → 保持 → 渐出；数学在共享层可单测，画框坐标映射在渲染层（与 clickRipples 同式）。
 */

import type {CursorClick} from './capture';

/** 高亮总生命（毫秒） */
export const HIGHLIGHT_LIFE_MS = 550;
/** 渐显时长（毫秒） */
export const HIGHLIGHT_IN_MS = 120;
/** 高亮框宽 = 视频宽 × 该比例 */
export const HIGHLIGHT_W_RATIO = 0.085;
/** 高亮框高宽比（h = w / 该值） */
export const HIGHLIGHT_ASPECT = 1.5;

export interface ClickHighlightState {
  /** 点击点（媒体像素坐标） */
  cx: number;
  cy: number;
  /** 高亮框尺寸（媒体像素） */
  w: number;
  h: number;
  /** 不透明度包络 0..1 */
  opacity: number;
}

/**
 * 当前媒体时刻的高亮状态；无活跃点击返回 null。
 * mediaMs 与点击同一零点（录制零点）。
 */
export const clickHighlightState = (
  clicks: CursorClick[] | undefined,
  mediaMs: number,
  videoW: number,
  videoH: number,
): ClickHighlightState | null => {
  if (!clicks || clicks.length === 0 || !(videoW > 0) || !(videoH > 0)) return null;
  let hit: CursorClick | null = null;
  let dt = 0;
  for (const c of clicks) {
    const d = mediaMs - c.t;
    if (d >= 0 && d <= HIGHLIGHT_LIFE_MS) {hit = c; dt = d;}
  }
  if (!hit) return null;
  // 包络：前 120ms 渐显（easeOut），末 160ms 渐出（easeIn），中间保持
  let q: number;
  if (dt < HIGHLIGHT_IN_MS) {
    const u = dt / HIGHLIGHT_IN_MS;
    q = 1 - Math.pow(1 - u, 2);
  } else if (dt > HIGHLIGHT_LIFE_MS - 160) {
    const u = (HIGHLIGHT_LIFE_MS - dt) / 160;
    q = u * u;
  } else {
    q = 1;
  }
  const w = videoW * HIGHLIGHT_W_RATIO;
  return {cx: hit.x, cy: hit.y, w, h: w / HIGHLIGHT_ASPECT, opacity: q};
};
