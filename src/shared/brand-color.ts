/**
 * 品牌色工具（纯函数，无依赖）
 *
 * 品牌色是项目级设置（BrandPanel 取色器 / set_brand_style 工具写入），
 * 渲染侧由 designTokens.ts 的模块主题消费：所有模板经 VIDEO_DESIGN.colors.accent
 * 拿到品牌色，本文件负责从单一品牌色派生出配套色板：
 * - accentDeep：渐变深端 / 按压态（加深）
 * - accentLight：浅底衬色（对应原写死的 #EFF6FF）
 * - accentMuted：暗底上的大面积品牌色（Material 暗色规范：暗底强调色需降饱和，
 *   否则高饱和色在暗底上会产生光学振动）
 * - onAccent：品牌色之上的文字色（按亮度取白/近黑，保证对比度）
 * - accentGlow：光晕/阴影用的低透明 rgba
 */

/** 缺省品牌色 = 历史版本模板的强调色（未设置品牌色时成片与旧版完全一致） */
export const DEFAULT_BRAND_COLOR = '#2563EB';

export interface BrandPalette {
  /** 品牌色（规范化 #rrggbb） */
  accent: string;
  /** 加深 14%：渐变深端 */
  accentDeep: string;
  /** 与白混合 92%：浅色衬底 */
  accentLight: string;
  /** 降饱和 + 适度提亮：暗底大面积使用 */
  accentMuted: string;
  /** 品牌色上的文字（'#FFFFFF' 或 '#111827'，取对比度更高者） */
  onAccent: string;
  /** rgba(accent, 0.15)：光晕/阴影 */
  accentGlow: string;
  /** RGB 分量（派生 rgba 用） */
  rgb: readonly [number, number, number];
}

/** 解析 #rgb / #rrggbb → [r,g,b]；非法输入返回 null */
export const hexToRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

export const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** 规范化品牌色输入 → '#rrggbb'（小写）；非法返回 null */
export const normalizeBrandColor = (input: string | null | undefined): string | null => {
  if (!input) return null;
  const rgb = hexToRgb(input);
  return rgb ? rgbToHex(...rgb) : null;
};

/** RGB → HSL（h 0-360, s/l 0-1） */
export const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
};

export const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const hn = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  return [channel(hn + 1 / 3) * 255, channel(hn) * 255, channel(hn - 1 / 3) * 255];
};

/** 两个 hex 颜色线性混合（t=0 → a，t=1 → b） */
export const mixHex = (a: string, b: string, t: number): string => {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  if (!ca || !cb) return a;
  return rgbToHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
};

/** 相对亮度（WCAG 定义） */
export const relativeLuminance = (hex: string): number => {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};

/** WCAG 对比度（1-21） */
export const contrastRatio = (a: string, b: string): number => {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};

/** 品牌色上的文字色：白 / 近黑取对比度更高者（正文级 ≥4.5 为佳，标题至少能拉开差距） */
export const contrastTextOn = (hex: string): string =>
  contrastRatio(hex, '#FFFFFF') >= contrastRatio(hex, '#111827') ? '#FFFFFF' : '#111827';

/** rgba 字符串（alpha 0-1）；非法 hex 回退 alpha 0（不显示） */
export const alphaRgba = (hex: string, alpha: number): string => {
  const c = hexToRgb(hex);
  if (!c) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
};

/**
 * 从单一品牌色派生整套色板。
 * 暗底规范（Material Design dark theme）：高饱和品牌色在暗底降饱和使用（accentMuted），
 * 纯色按钮/强调线仍用原色（accent），保证品牌识别度。
 */
export const buildBrandPalette = (brandColor: string): BrandPalette => {
  // 回退色也走规范化，保证输出一律小写（与合法输入路径一致）
  const accent = normalizeBrandColor(brandColor) ?? normalizeBrandColor(DEFAULT_BRAND_COLOR)!;
  const rgb = hexToRgb(accent)!;
  const [h, s, l] = rgbToHsl(...rgb);
  // 暗底大面积色：降饱和 20%，亮度抬到不刺眼的区间（过暗的品牌色适度提亮）
  const mutedL = l < 0.35 ? Math.min(0.45, l + 0.1) : Math.min(0.78, l + 0.04);
  const accentMuted = rgbToHex(...hslToRgb(h, s * 0.8, mutedL));
  return {
    accent,
    accentDeep: mixHex(accent, '#000000', 0.14),
    accentLight: mixHex(accent, '#FFFFFF', 0.92),
    accentMuted,
    onAccent: contrastTextOn(accent),
    accentGlow: alphaRgba(accent, 0.15),
    rgb,
  };
};
