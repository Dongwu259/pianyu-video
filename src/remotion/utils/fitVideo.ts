/**
 * 视频适配算法 - 将任意分辨率的视频适配到目标画框
 */

import {FitMode} from '../../shared/types';

export interface FitResult {
  width: number;     // 适配后绘制宽度
  height: number;    // 适配后绘制高度
  offsetX: number;   // X 位移（裁剪对齐用）
  offsetY: number;   // Y 位移
  scale: number;     // 总缩放倍率
}

/**
 * 将视频适配到容器
 * - cover: 裁切填充（默认，画面饱满无黑边）
 * - contain: 完整显示（可能有空白区域）
 */
export const fitVideo = (
  containerW: number,
  containerH: number,
  videoW: number,
  videoH: number,
  mode: FitMode = 'cover'
): FitResult => {
  if (videoW <= 0 || videoH <= 0) {
    return {width: containerW, height: containerH, offsetX: 0, offsetY: 0, scale: 1};
  }

  const containerRatio = containerW / containerH;
  const videoRatio = videoW / videoH;

  if (mode === 'cover') {
    // 放大视频直到完全覆盖画框，超出部分裁切
    if (videoRatio > containerRatio) {
      const height = containerH;
      const width = height * videoRatio;
      return {
        width,
        height,
        offsetX: (width - containerW) / 2,
        offsetY: 0,
        scale: 1,
      };
    } else {
      const width = containerW;
      const height = width / videoRatio;
      return {
        width,
        height,
        offsetX: 0,
        offsetY: (height - containerH) / 2,
        scale: 1,
      };
    }
  }

  // contain 模式：完整显示
  if (videoRatio > containerRatio) {
    const width = containerW;
    const height = width / videoRatio;
    return {
      width,
      height,
      offsetX: 0,
      offsetY: (containerH - height) / 2,
      scale: 1,
    };
  } else {
    const height = containerH;
    const width = height * videoRatio;
    return {
      width,
      height,
      offsetX: (containerW - width) / 2,
      offsetY: 0,
      scale: 1,
    };
  }
};
