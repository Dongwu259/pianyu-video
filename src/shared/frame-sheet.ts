/**
 * 缩略图墙（contact sheet）纯函数层
 *
 * 一张图 = 全片百帧信息：把「看素材」从 N 次多模态抽帧变成 1 次看拼图 +
 * 文本时间表——多素材工作流的看图预算杀手锏。时间轴语义与素材一致（均匀采样），
 * 第 k 格 = planContactSheetTimes 的第 k 个时间点。
 */

/** contact sheet 网格与采样参数（主进程 makeContactSheet 消费） */
export interface ContactSheetPlan {
  cols: number;
  rows: number;
  /** 每格采样时间点（秒），长度 = 实际格子数（短素材不满格） */
  timesSec: number[];
  /** 每格缩略宽（px，高按素材比例） */
  thumbW: number;
}

export const CONTACT_SHEET_MAX_CELLS = 144; // 12×12 上限（一次解码量控制）
export const CONTACT_SHEET_DEFAULT_CELLS = 100; // 10×10 缺省

/**
 * 规划 contact sheet：在 (0, duration) 上取 (i+0.5)/n 均匀点（中点采样防首帧黑场）。
 * duration 无效时返回单帧 0s。
 */
export const planContactSheet = (
  durationSec: number,
  cells: number,
  thumbW = 96,
): ContactSheetPlan => {
  const n = Math.max(1, Math.min(CONTACT_SHEET_MAX_CELLS, Math.round(cells)));
  const cols = Math.min(12, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const actual = dur === 0 ? 1 : n;
  const timesSec = Array.from({length: actual}, (_, i) =>
    dur === 0 ? 0 : Math.round(((i + 0.5) / n) * dur * 100) / 100,
  );
  return {cols, rows, timesSec, thumbW};
};

/** 拼图帧尺寸：统一格高（宽按素材宽高比钳到格内；素材比例未知时按 16:9） */
export const cellSize = (thumbW: number, videoW: number, videoH: number): {w: number; h: number} => {
  const ratio = videoW > 0 && videoH > 0 ? videoW / videoH : 16 / 9;
  const h = Math.round(thumbW / Math.max(0.5, ratio));
  return {w: thumbW, h: Math.max(2, h)};
};

/** 格子 k（0 起，行优先）在大图中的像素位置 */
export const cellOrigin = (plan: ContactSheetPlan, k: number, cellH: number): {x: number; y: number} => ({
  x: (k % plan.cols) * plan.thumbW,
  y: Math.floor(k / plan.cols) * cellH,
});
