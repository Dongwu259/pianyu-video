/**
 * 画布比例预设
 *
 * 比例预设是“分辨率 + 方向”的组合。首页让用户选预设，渲染时按预设注册的
 * Composition 输出对应尺寸，预览时按预设画比例正确的预览框。
 *
 * 方向（Orientation）由预设派生：宽 >= 高 -> landscape，否则 portrait。
 * 保留 Orientation 二值类型供所有现有模板/布局逻辑使用，避免大面积重写。
 */

import type {Orientation} from './types';

export interface AspectRatioPreset {
  id: string;          // '16-9' 等，用作 composition id 后缀
  label: string;       // '16:9'
  name: string;        // '横屏'
  desc: string;        // 适用场景
  width: number;
  height: number;
  orientation: Orientation;
}

export const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  {id: '16-9', label: '16:9', name: '横屏', desc: 'YouTube / B站 / 官网', width: 1920, height: 1080, orientation: 'landscape'},
  {id: '9-16', label: '9:16', name: '竖屏', desc: '抖音 / TikTok / 小红书', width: 1080, height: 1920, orientation: 'portrait'},
  {id: '1-1', label: '1:1', name: '方形', desc: 'Instagram / 朋友圈', width: 1080, height: 1080, orientation: 'landscape'},
  {id: '4-5', label: '4:5', name: '竖版图文', desc: '小红书 图文', width: 1080, height: 1350, orientation: 'portrait'},
  {id: '4-3', label: '4:3', name: '经典横屏', desc: '课件 / 传统屏幕', width: 1440, height: 1080, orientation: 'landscape'},
  {id: '21-9', label: '21:9', name: '电影宽屏', desc: '影院 / 超宽屏', width: 2520, height: 1080, orientation: 'landscape'},
];

export const DEFAULT_ASPECT_RATIO_ID = '16-9';

/** 按 id 取预设，找不到回退到首个（16:9） */
export const getAspectRatioPreset = (id: string | undefined | null): AspectRatioPreset =>
  ASPECT_RATIO_PRESETS.find((p) => p.id === id) || ASPECT_RATIO_PRESETS[0];
