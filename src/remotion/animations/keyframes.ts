/**
 * 动画关键帧预设函数
 *
 * 所有函数以当前帧为输入，返回对应的动画属性值（位置、透明度、缩放、旋转）
 * 配合 Remotion 的 useCurrentFrame() 和 interpolate() 使用
 */

import {interpolate, spring} from 'remotion';
import {SPRINGS, EASINGS} from './motion';

// ====== 平移类 ======

/**
 * 水平从左到右穿越画面
 */
export const leftToRight = (
  frame: number,
  duration: number,
  canvasWidth: number,
  offsetRatio: number = 0.3
): number => {
  return interpolate(
    frame,
    [0, duration],
    [-canvasWidth * offsetRatio, canvasWidth * offsetRatio],
    {
      extrapolateRight: 'clamp',
      extrapolateLeft: 'clamp',
      easing: EASINGS.inOut,
    }
  );
};

/**
 * 水平从右到左
 */
export const rightToLeft = (
  frame: number,
  duration: number,
  canvasWidth: number,
  offsetRatio: number = 0.3
): number => {
  return interpolate(
    frame,
    [0, duration],
    [canvasWidth * offsetRatio, -canvasWidth * offsetRatio],
    {
      extrapolateRight: 'clamp',
      extrapolateLeft: 'clamp',
      easing: EASINGS.inOut,
    }
  );
};

// ====== 透明度类 ======

/**
 * 淡入
 */
export const fadeIn = (frame: number, startFrame: number, duration: number = 15): number => {
  return interpolate(frame, [startFrame, startFrame + duration], [0, 1], {
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  });
};

/**
 * 淡出
 */
export const fadeOut = (frame: number, startFrame: number, duration: number = 15): number => {
  return interpolate(frame, [startFrame, startFrame + duration], [1, 0], {
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  });
};

// ====== 缩放类 ======

/**
 * 弹出（spring 弹性缩放）
 */
export const popIn = (frame: number, startFrame: number, fps: number = 30): number => {
  return spring({
    frame: frame - startFrame,
    fps,
    config: SPRINGS.cardPop,
  });
};
// ====== 入场/出场类 ======

type SlideDirection = 'left' | 'right' | 'top' | 'bottom';

/**
 * 从画面外滑入
 */
export const slideIn = (
  frame: number,
  startFrame: number,
  duration: number,
  from: SlideDirection,
  distance: number = 200
): {opacity: number; x: number; y: number} => {
  const progress = interpolate(frame, [startFrame, startFrame + duration], [0, 1], {
    easing: EASINGS.standard,
    extrapolateRight: 'clamp',
    extrapolateLeft: 'clamp',
  });

  const offset = (1 - progress) * distance;
  const directions: Record<SlideDirection, {x: number; y: number}> = {
    left: {x: -offset, y: 0},
    right: {x: offset, y: 0},
    top: {x: 0, y: -offset},
    bottom: {x: 0, y: offset},
  };

  return {opacity: progress, ...directions[from]};
};

// ====== 旋转类 ======

/**
 * 3D 倾斜摆动（用于模板3 的电影感环绕）
 */
export const gentleRotate = (
  frame: number,
  amplitude: number = 8,
  speed: number = 0.02
): number => {
  return Math.sin(frame * speed) * amplitude;
};

/**
 * 从倾斜角度恢复到 0
 */
export const tiltToFlat = (
  frame: number,
  startFrame: number,
  duration: number,
  initialTilt: number
): number => {
  return interpolate(frame, [startFrame, startFrame + duration], [initialTilt, 0], {
    easing: EASINGS.standard,
    extrapolateRight: 'clamp',
  });
};

// ====== 缓动预设 ======

/** 历史别名：缓动 token 已收敛至 motion.ts 的 EASINGS（单一事实源） */
export const EASING_PRESETS = EASINGS;
