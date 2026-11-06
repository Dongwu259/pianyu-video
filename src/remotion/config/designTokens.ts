/**
 * Remotion 内部设计 Token
 * 与品牌简约/明亮风格保持一致
 *
 * 品牌主题（项目级）：accent 系列颜色与字体栈是 getter，取值来自模块主题
 * （MultiSegmentPromo / RemotionPreviewPlayer 每次渲染前调 setBrandTheme 注入
 * 工程的品牌色与字体氛围）。主题对同一合成是常量，getter 读模块态是确定性的；
 * 模板代码继续只读 VIDEO_DESIGN，无需感知品牌设置。
 */

import {buildBrandPalette, DEFAULT_BRAND_COLOR, type BrandPalette} from '../../shared/brand-color';
import {getFontMood, DEFAULT_FONT_MOOD_ID, type FontMood, type FontMoodId} from '../../shared/font-presets';
import {wideAspectCap} from '../utils/aspectLayout';

/** 内置品牌字体族名（MiSans，小米发布的可商用字体；在 root.tsx / 渲染进程入口加载） */
export const BRAND_FONT_FAMILY = 'MiSans';

// ====== 模块级品牌主题（由合成根注入；缺省 = 历史版本视觉） ======
let currentPalette: BrandPalette = buildBrandPalette(DEFAULT_BRAND_COLOR);
let currentMood: FontMood = getFontMood(DEFAULT_FONT_MOOD_ID);

/**
 * 注入品牌主题（每次合成渲染体开头调用，值来自工程的品牌设置）。
 * accent 传 null/undefined/非法值 = 回缺省蓝；fontMood 非法 = 回默认氛围。
 */
export const setBrandTheme = (theme: {accent?: string | null; fontMood?: string | null}): void => {
  currentPalette = buildBrandPalette(theme.accent || DEFAULT_BRAND_COLOR);
  currentMood = getFontMood(theme.fontMood ?? undefined);
};

/** 当前品牌色板（accentDeep/onAccent 等派生色供需要的模板/图层取用） */
export const getBrandPalette = (): BrandPalette => currentPalette;

/** 当前字体氛围预设 */
export const getBrandFontMood = (): FontMood => currentMood;

export const VIDEO_DESIGN = {
  // 视频画框样式
  borderRadius: 12,
  shadow: '0 32px 64px -16px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.05)',
  shadowSoft: '0 8px 24px -8px rgba(0, 0, 0, 0.15)',
  shadowFloat: '0 40px 80px -20px rgba(0, 0, 0, 0.3)',
  // 画框内描边高光（叠加在最上层，提亮边缘质感）
  frameHighlight: 'inset 0 0 0 1px rgba(255, 255, 255, 0.4)',

  // 字体栈（品牌主题 getter：字体氛围预设决定，加载失败自动回退系统字体）
  get titleFont() { return currentMood.titleFont; },
  get bodyFont() { return currentMood.bodyFont; },
  get monoFont() { return currentMood.monoFont; },

  // 颜色（accent 系列为品牌主题 getter，其余为固定底色）
  colors: {
    bg: '#FFFFFF',
    bgAlt: '#F8F9FA',
    bgDark: '#1A1A2E',
    bgGradientLight: 'linear-gradient(135deg, #F8F9FA 0%, #FFFFFF 100%)',
    bgGradientDark: 'linear-gradient(135deg, #1A1A2E 0%, #16213E 100%)',
    textTitle: '#111827',
    textTitleDark: '#F8FAFC',
    textBody: '#374151',
    textBodyDark: '#CBD5E1',
    textMuted: '#6B7280',
    get accent() { return currentPalette.accent; },
    get accentLight() { return currentPalette.accentLight; },
    get accentGlow() { return currentPalette.accentGlow; },
    // PiP contain 模式留白的衬底（深色渐变，避免纯黑死板）
    pipBackdrop: 'linear-gradient(135deg, rgba(26, 26, 46, 0.95) 0%, rgba(22, 33, 62, 0.9) 100%)',
  },

  // 透视距离
  perspective: 1200,

  // 标题/正文字号（基于 1920 宽度设计，竖屏需等比缩放）
  fontSize: {
    title: 72,
    subtitle: 40,
    body: 28,
    caption: 22,
    brand: 36,
  },

  // 间距
  spacing: {
    section: 80,
    paragraph: 32,
    element: 16,
    tight: 8,
  },
};

/** 设计稿基准画布宽度（fontSize/spacing 基于此宽度） */
const BASE_CANVAS_WIDTH = 1920;

/**
 * 按画布宽度线性缩放字号/间距 token
 * 竖屏（如 1080 宽）自动等比缩小，替代模板里手写的竖屏缩放魔数
 */
export const getScaledTokens = (canvasWidth: number, canvasHeight?: number) => {
  // 竖屏字号提升（v9 竖版反馈「文字太小了，其他模板也一样」）：竖画布按宽度缩放只拿到
  // 0.56× 的横版字号，手机满屏观看偏小——竖屏（高>宽）统一提升 1.35×（模板版式留白充足，
  // 35% 内文字块不破版；横版零变化）
  const portrait = canvasHeight !== undefined && canvasHeight > canvasWidth;
  // 宽画幅封顶（画幅审计 P1，21:9）：比 16:9 更宽的画布按宽度等比会拿到 1.31× 字号，
  // 而竖向版式按高度锚定→拉稀/贴底——压回 16:9 等效密度；16:9 及更窄恒 1（零漂移）
  const wideCap = canvasHeight !== undefined ? wideAspectCap(canvasWidth, canvasHeight) : 1;
  const scale = (canvasWidth / BASE_CANVAS_WIDTH) * (portrait ? 1.35 : 1) * wideCap;
  const scaleValues = <T extends Record<string, number>>(values: T): T => {
    const scaled = {} as T;
    (Object.keys(values) as Array<keyof T>).forEach((key) => {
      scaled[key] = (values[key] * scale) as T[keyof T];
    });
    return scaled;
  };
  return {
    ...VIDEO_DESIGN,
    fontSize: scaleValues(VIDEO_DESIGN.fontSize),
    spacing: scaleValues(VIDEO_DESIGN.spacing),
  };
};
