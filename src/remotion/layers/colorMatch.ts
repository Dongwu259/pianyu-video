/**
 * 自动曝光匹配上下文
 *
 * MultiSegmentPromo 计算全片素材亮度基准后，把「素材 src → brightness 校正系数」
 * 映射表放进 Context；ClipMedia（所有视频/图片的唯一渲染出口）按自己的 src 查表套
 * filter。模板零改动——无论素材经 Video3D 画框还是全屏铺放，匹配都生效。
 * 预览与成片共用同一消费点，WYSIWYG。
 */

import {createContext, useContext} from 'react';

export interface ColorMatchState {
  /** 素材 src（模板传入的原始 src）→ CSS filter 片段 */
  filters: Map<string, string>;
}

export const ColorMatchContext = createContext<ColorMatchState | null>(null);

/** 取某素材的曝光匹配 filter（无上下文/未命中返回空串） */
export const useColorMatchFilter = (src: string): string => {
  const ctx = useContext(ColorMatchContext);
  if (!ctx || !src) return '';
  return ctx.filters.get(src) ?? '';
};
