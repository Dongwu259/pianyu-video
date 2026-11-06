/**
 * 时间线工具函数 - 帧/秒换算、时间槽分配
 */

import {FPS} from '../config/resolutions';
import type {SegmentExitStyle} from '../../shared/types';

/** 秒 → 帧 */
export const secondsToFrames = (seconds: number, fps: number = FPS): number => {
  return Math.round(seconds * fps);
};

/** 帧 → 秒 */
export const framesToSeconds = (frames: number, fps: number = FPS): number => {
  return frames / fps;
};

/**
 * 片尾留白帧数按退场预设取值：
 * sync/fade = 10 帧（素材播到转场前一刻，元素随转场/整帧渐隐一次性消失）；
 * stagger   = 模板各自的旧默认（素材提前退场留白，文字收尾）。
 */
export const trailingForExit = (exitStyle: SegmentExitStyle | undefined, staggerDefault: number): number =>
  exitStyle === 'stagger' ? staggerDefault : 10;

export interface TimeSlot {
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
}

/**
 * 将总时长等分为 N 段视频的时间槽（含间隔）
 *
 * @param totalVideos  视频段数
 * @param totalDurationFrames  总时长（帧）
 * @param gapFrames  视频之间的间隔帧数
 * @param trailingFrames  片尾留白帧数
 */
export const calculateSlotTiming = (
  totalVideos: number,
  totalDurationFrames: number,
  gapFrames: number = 15,
  trailingFrames: number = 45
): TimeSlot[] => {
  const usableFrames = totalDurationFrames - gapFrames * (totalVideos + 1) - trailingFrames;
  // 下限仅保底 10 帧：下限过高时短片段多视频的后续槽位 startFrame 会超出段长，素材静默消失
  const slotDuration = Math.max(Math.floor(usableFrames / totalVideos), 10);

  return Array.from({length: totalVideos}, (_, i) => {
    // 末槽钳位：startFrame + slotDuration 不超出段长
    const startFrame = Math.min(
      gapFrames + i * (slotDuration + gapFrames),
      Math.max(totalDurationFrames - slotDuration, 0)
    );
    return {
      startFrame,
      endFrame: startFrame + slotDuration,
      durationInFrames: slotDuration,
    };
  });
};
