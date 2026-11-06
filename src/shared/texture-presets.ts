/**
 * 全局质感层预设（纯数据，无运行时依赖，Node 可直跑单测）。
 *
 * 「质感」是叠加在全片最上层的静态效果组：暗角 / 胶片颗粒 / 上下压暗 / 扫柔光。
 * 三档预设（工程级开关）：干净 = 不叠加；胶片 = 轻暗角 + 细颗粒；
 * 电影 = 重暗角 + 颗粒 + 压暗 + 缓慢扫过的柔光（light leak）。
 * 渲染组件在 remotion/layers/TextureLayer.tsx，预览与导出同源。
 */

import type {TexturePreset} from './types';

export interface TextureParams {
  /** 暗角强度：四角最大不透明度 0..1 */
  vignette: number;
  /** 颗粒不透明度 0..1（噪点平铺，overlay 混合） */
  grain: number;
  /** 上下压暗渐变强度 0..1（模拟胶片暗部压边） */
  tone: number;
  /** 是否叠加缓慢扫过的柔光（light leak，screen 混合） */
  lightLeak: boolean;
}

export const TEXTURE_PARAMS: Record<TexturePreset, TextureParams> = {
  clean: {vignette: 0, grain: 0, tone: 0, lightLeak: false},
  film: {vignette: 0.34, grain: 0.055, tone: 0.1, lightLeak: false},
  cinema: {vignette: 0.42, grain: 0.09, tone: 0.2, lightLeak: true},
};

/** 预设是否完全无效果（组件据此直接不渲染） */
export const isTextureEmpty = (p: TextureParams): boolean =>
  p.vignette === 0 && p.grain === 0 && p.tone === 0 && !p.lightLeak;
