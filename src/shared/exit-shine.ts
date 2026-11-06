/**
 * 退场照亮扫光（B4，随变临摹复盘「边聊边改 轻松创作 快退出时字体被照亮」）
 *
 * 纯函数模块：给大字类模板（KineticType 等）在片段末尾生成一段「高光带扫过文字」的
 * 时间线。扫光本身在模板层用 background-clip:text 渐变实现，这里只管进度与窗口。
 * 与 remotion 解耦，单测可锚定。
 */

/** 扫光时长（秒）：从片段末尾往前推的窗口宽度 */
export const EXIT_SHINE_SEC = 0.9;

/**
 * 退场扫光进度（0..1，线性；钳制两端）。
 * 窗口 = [totalFrames − sec×fps, totalFrames)；段长不足窗口时整段返回 0（不打扰短段）。
 * 返回 0 时调用方不渲染扫光层，返回 1 时高光带已完全扫出（同样不渲染）。
 */
export const exitShineProgress = (
  frame: number,
  totalFrames: number,
  fps: number,
  sec: number = EXIT_SHINE_SEC,
): number => {
  if (!(totalFrames > 0) || !(fps > 0)) return 0;
  const winFrames = Math.round(sec * fps);
  const start = totalFrames - winFrames;
  if (start <= 0 || winFrames <= 0) return 0;
  const q = (frame - start) / winFrames;
  return Math.min(1, Math.max(0, q));
};
