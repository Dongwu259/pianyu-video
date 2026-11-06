/**
 * 「What's New」弹窗的展示判定纯逻辑（不依赖 React / Electron，可单测）
 */

/** localStorage 键：记录已看过更新日志的版本号 */
export const WHATS_NEW_STORAGE_KEY = 'pianyu.whatsNewSeen';

/**
 * 是否应弹出「更新内容」：
 * - 当前版本号缺失（获取失败 / 空串）→ 不显示
 * - 已看过的版本与当前一致 → 不显示（不打扰：同一版本只弹一次）
 * - 其余情况（首次安装 seen 为 null / 空串，或版本升级不一致）→ 显示
 */
export const shouldShowWhatsNew = (
  seenVersion: string | null,
  currentVersion: string | null,
): boolean => {
  if (!currentVersion) return false;
  return seenVersion !== currentVersion;
};
