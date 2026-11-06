/**
 * AI 提示卡「素材拖入」时间线（B2，随变临摹复盘「拖拽卡片到聊天栏」）
 *
 * 纯函数模块：AiPromptCard 的 dragIn 动效时间线——素材卡 ghost 沿贝塞尔飞向输入框、
 * 落点收成附件 chip、打字顺延到落定之后。与 remotion 解耦，单测可锚定。
 * springProgress 复用 click-zoom-smooth 的欠阻尼弹簧（同一家时间语言）。
 */
import {springProgress} from './click-zoom-smooth';

/** ghost 起飞帧（输入框入场 barIn 0-10 帧之后稍作停顿） */
export const DRAG_START_FRAME = 14;
/** ghost 飞行时长（秒） */
export const DRAG_FLY_SEC = 1.05;
/** 落定 chip 弹窗窗长（帧） */
export const DRAG_CHIP_FRAMES = 22;

/** 二次贝塞尔（ghost 飞行路径） */
export const quadBezier = (
  p0: {x: number; y: number},
  p1: {x: number; y: number},
  p2: {x: number; y: number},
  q: number,
): {x: number; y: number} => {
  const t = Math.min(1, Math.max(0, q));
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
};

/** 飞行进度（0..1，smoothstep 缓入缓出——拖拽手感的匀滑段） */
export const dragInFlyQ = (frame: number, fps: number): number => {
  const flyFrames = Math.max(1, Math.round(DRAG_FLY_SEC * fps));
  const q = (frame - DRAG_START_FRAME) / flyFrames;
  const x = Math.min(1, Math.max(0, q));
  return x * x * (3 - 2 * x);
};

/** 落定 chip 弹窗进度（飞行结束起弹簧；0 = 尚未落定） */
export const dragInChipPop = (frame: number, fps: number): number =>
  springProgress((frame - DRAG_START_FRAME - Math.round(DRAG_FLY_SEC * fps)) / DRAG_CHIP_FRAMES);

/** 打字起始帧：dragIn 开时顺延到落定之后（关时回到模板原 8 帧） */
export const dragInTypingStartFrame = (fps: number, dragOn: boolean): number =>
  dragOn ? DRAG_START_FRAME + Math.round(DRAG_FLY_SEC * fps) + 6 : 8;
