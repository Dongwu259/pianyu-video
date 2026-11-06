/**
 * 竖版（9:16）平台安全区 —— 投放 Reels / TikTok / 快手等时的 UI 遮挡规避
 *
 * 竖版视频在社交平台播放时，顶部被账号名/关注按钮遮挡、底部被文案/互动按钮列遮挡：
 * - Instagram Reels：顶部 ~220-250px(≈13%)、底部 ~320-430px(≈17-22%)（1080×1920）
 * - TikTok：顶部 ~108px(≈6%)、底部 ~335px(≈17%)、右侧图标列 ~140px
 * - Meta 广告规范：底部 40% 不放关键文字（广告投放才需要，常规内容不必这么严）
 *
 * 取交集给出一档通用内边距（常规内容推荐值，非广告规范）：
 * 顶部 10%、底部 18%。横版（16:9 等）无平台遮挡，返回 0——
 * 所有调用方无需自行判断画幅，直接用返回值即可。
 */

export interface SafeInsets {
  /** 顶部安全内边距（px，横版为 0） */
  top: number;
  /** 底部安全内边距（px，横版为 0） */
  bottom: number;
}

/** 常规内容的安全区比例（顶/底占画面高度的比例） */
export const PORTRAIT_SAFE_RATIOS = {top: 0.1, bottom: 0.18} as const;

/** 是否竖版画幅（宽 < 高即视为竖版投放形态） */
export const isPortraitCanvas = (width: number, height: number): boolean => height > width;

/** 当前画幅的安全内边距；minimum 保证不低于调用方自有的基础留白 */
export const safeInsets = (width: number, height: number, minimum?: {top?: number; bottom?: number}): SafeInsets => {
  if (!isPortraitCanvas(width, height)) {
    return {top: minimum?.top ?? 0, bottom: minimum?.bottom ?? 0};
  }
  return {
    top: Math.max(Math.round(height * PORTRAIT_SAFE_RATIOS.top), minimum?.top ?? 0),
    bottom: Math.max(Math.round(height * PORTRAIT_SAFE_RATIOS.bottom), minimum?.bottom ?? 0),
  };
};

/** 底部定位元素的安全 bottom 值（取「自身基础留白」与「安全区」的较大者） */
export const safeBottom = (width: number, height: number, baseBottom: number): number =>
  Math.max(baseBottom, safeInsets(width, height).bottom);

/** 顶部定位元素的安全 top 值 */
export const safeTop = (width: number, height: number, baseTop: number): number =>
  Math.max(baseTop, safeInsets(width, height).top);
