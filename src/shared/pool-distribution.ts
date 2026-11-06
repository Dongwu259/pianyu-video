/**
 * 素材库「自动配段」的纯分配逻辑（与 zustand 解耦，可单测）
 *
 * 规则（与 MediaPoolPanel 的语义一致）：
 * - 纯文字模板（maxVideos 0）的片段不参与；
 * - 没有素材的片段补到 max(1, minVideos)——至少 1 条画面；
 * - 已有素材的片段只补 minVideos 差额（用户自己放过的算数，不强行改结构）；
 * - 轮转分配：每一轮给所有还有缺口的片段各发一条，库耗尽即停（不循环复用）。
 */

export interface PoolSegmentInput {
  templateId: string;
  clipCount: number;
}

export interface PoolTemplateLimits {
  min: number;
  max: number;
}

/** 每个片段的缺口条数 */
export const computePoolDeficits = (
  segments: PoolSegmentInput[],
  limitsOf: (templateId: string) => PoolTemplateLimits | undefined,
): number[] =>
  segments.map((seg) => {
    const meta = limitsOf(seg.templateId);
    const max = meta?.max ?? 1;
    if (max === 0) return 0;
    const min = meta?.min ?? 1;
    if (seg.clipCount > 0) return Math.max(0, min - seg.clipCount);
    return Math.max(1, Math.min(min, max));
  });

/**
 * 轮转分配：返回每片段分得的素材池下标列表（按分配顺序）。
 * 总发出条数 ≤ poolSize；库有剩余而片段全满足时提前结束。
 */
export const allocatePoolRoundRobin = (deficits: number[], poolSize: number): number[][] => {
  const fills: number[][] = deficits.map(() => []);
  let pool = 0;
  let progress = true;
  while (pool < poolSize && progress) {
    progress = false;
    for (let i = 0; i < deficits.length && pool < poolSize; i++) {
      if (fills[i].length < deficits[i]) {
        fills[i].push(pool++);
        progress = true;
      }
    }
  }
  return fills;
};

/** 仍未满足的片段数（缺口没被填满的片段） */
export const countUnmetSegments = (deficits: number[], fills: number[][]): number =>
  deficits.reduce((acc, d, i) => acc + (d > fills[i].length ? 1 : 0), 0);
