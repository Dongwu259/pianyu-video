/**
 * 点击水波（clickRipple 视频特效）的纯函数计算。
 *
 * 输入：片段视频的点击事件（CursorClick，录制零点毫秒 + 视频像素坐标）、
 * 当前帧与媒体在画框内的最终几何（fitVideo/applyViewport 的结果）。
 * 输出：当前帧活跃的水波列表（画框内 px 坐标 + 距点击时刻的毫秒）。
 *
 * 坐标映射：媒体像素 (x,y) ∈ vw×vh → 画框 px：
 *   bx = x/vw * placed.width + placed.translateX
 *   by = y/vh * placed.height + placed.translateY
 * placed 是媒体在画框内的最终显示矩形（cover 裁剪 / contain 留白 / 取景视口
 * 均已折叠进该矩形），越界水波由画框 overflow:hidden 自然裁切。
 *
 * 时间映射：片段相对帧 frame（Video3D 内 useCurrentFrame）+ startFrom（帧）
 * 对应媒体文件时间 (startFrom + frame)/fps；dtMs = 媒体时间 − 点击时刻。
 */
import type {CursorClick} from '../../shared/capture';
import {timelineToMediaSec} from '../../shared/clipCuts';
import type {ClipCut} from '../../shared/clipCuts';

/** 单个活跃水波（画框坐标系） */
export interface RippleSpec {
  /** 画框内 px 坐标 X */
  x: number;
  /** 画框内 px 坐标 Y */
  y: number;
  /** 距点击时刻的毫秒（0 = 点击发生帧） */
  dtMs: number;
  /** 尺寸归一倍率（画框宽 / 1280），保证不同画框宽度下视觉一致 */
  scale: number;
}

/** 媒体在画框内的最终几何（与 ViewportPlacement 字段同名，结构兼容） */
export interface RipplePlaced {
  width: number;
  height: number;
  translateX: number;
  translateY: number;
}

/** 水波总生命（覆盖三环错开后的尾程；渲染层单环时长更短，见 videoEffects） */
export const RIPPLE_LIFE_MS = 900;

/** 尺寸归一基准画框宽度 */
export const RIPPLE_BASE_FRAME_W = 1280;

export const computeClickRipples = (args: {
  clicks: CursorClick[] | undefined;
  /** 视频框当前相对帧（Sequence 内） */
  frame: number;
  /** 合成帧率 */
  fps: number;
  /** 媒体起始帧（合成帧率；= trimStart * fps） */
  startFrom: number;
  /** 挖段列表（媒体绝对秒）：有时当前帧的媒体时间按挖段映射（洞内帧 = 洞出口） */
  cutsSec?: ClipCut[];
  /** 窗口尾（媒体绝对秒）：ClipMedia 封口时同步钳制，冻结帧上不冒新水波 */
  endSec?: number;
  /** 媒体原始尺寸 */
  vw: number;
  vh: number;
  /** 媒体在画框内的最终几何 */
  placed: RipplePlaced;
  /** 画框宽度 px（尺寸归一基准） */
  frameW: number;
}): RippleSpec[] => {
  const {clicks, frame, fps, startFrom, cutsSec, endSec, vw, vh, placed, frameW} = args;
  if (!clicks || clicks.length === 0 || vw <= 0 || vh <= 0 || fps <= 0) return [];
  const mediaSec0 =
    cutsSec && cutsSec.length > 0
      ? timelineToMediaSec(frame / fps, startFrom / fps, cutsSec)
      : (startFrom + frame) / fps;
  const mediaMs = (endSec !== undefined ? Math.min(mediaSec0, endSec) : mediaSec0) * 1000;
  const scale = frameW / RIPPLE_BASE_FRAME_W;
  const out: RippleSpec[] = [];
  for (const c of clicks) {
    const dtMs = mediaMs - c.t;
    if (dtMs < 0 || dtMs >= RIPPLE_LIFE_MS) continue;
    out.push({
      x: (c.x / vw) * placed.width + placed.translateX,
      y: (c.y / vh) * placed.height + placed.translateY,
      dtMs,
      scale,
    });
  }
  return out;
};
