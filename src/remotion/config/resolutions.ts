/**
 * 横/竖屏分辨率配置
 */

import {Orientation} from '../../shared/types';

export const RESOLUTIONS: Record<Orientation, {width: number; height: number}> = {
  landscape: {width: 1920, height: 1080},
  portrait: {width: 1080, height: 1920},
};

export const FPS = 30;
