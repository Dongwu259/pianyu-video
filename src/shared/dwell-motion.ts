/**
 * 驻留微运动（dwell motion）——入场完成后的持续克制运动（纯函数，可单测）。
 *
 * 商业宣传片的底线是「画面永远在动」：入场动画结束后内容若完全静止，观感立刻
 * 掉回 PPT。本模块提供标准化的驻留运动原语，供模板套在内容容器上：
 * - breathe：1 ± amount 的缓慢呼吸缩放（默认 1.2%，4.5s 周期）；
 * - drift：±N px 的缓慢平移漂移（x/y 不同周期，防机械感）；
 * - float：±N px 的垂直悬浮（卡片/设备壳类）。
 * 全程正弦驱动，逐帧确定；phase 按段下标错开，避免多元素同频共振的「集体呼吸」。
 *
 * 用法：模板内容容器 style.transform = dwellTransform(frame, fps, {breathe: 0.012, driftY: 3}, segmentIndex)。
 * 入场期间叠加这层 1-2% 的慢运动不可见，入场结束后画面保持「活着」——无需与入场进度耦合。
 */

export interface DwellOptions {
  /** 呼吸缩放幅度（0.006-0.02 观感安全；false=关闭） */
  breathe?: number | false;
  /** 水平漂移幅度 px（false=关闭） */
  driftX?: number | false;
  /** 垂直漂移幅度 px（false=关闭） */
  driftY?: number | false;
  /** 呼吸周期（秒） */
  breathePeriodSec?: number;
  /** 漂移周期（秒，x 用该值、y 用 ×1.31 防同频） */
  driftPeriodSec?: number;
}

const TAU = Math.PI * 2;

/** 呼吸缩放系数（1 ± amount） */
export const dwellBreathe = (
  frame: number,
  fps: number,
  amount = 0.012,
  periodSec = 4.5,
  phase = 0,
): number => 1 + amount * Math.sin(TAU * (frame / fps / periodSec) + phase);

/** 漂移位移（px）：x/y 不同周期，叠加第二谐波让轨迹不死板 */
export const dwellDrift = (
  frame: number,
  fps: number,
  ampX = 4,
  ampY = 3,
  periodSec = 9,
  phase = 0,
): {x: number; y: number} => {
  const t = frame / fps;
  return {
    x: ampX * Math.sin(TAU * (t / periodSec) + phase) + ampX * 0.3 * Math.sin(TAU * (t / (periodSec * 0.37)) + phase * 2),
    y: ampY * Math.sin(TAU * (t / (periodSec * 1.31)) + phase * 1.7) + ampY * 0.3 * Math.sin(TAU * (t / (periodSec * 0.53)) + phase),
  };
};

/**
 * 组合驻留 transform（scale + translate）。全部关闭/全零时返回 undefined（样式透传无副作用）。
 * @param seed 相位种子（如段下标）：相邻段的驻留运动错开相位，不会整屏同频
 */
export const dwellTransform = (
  frame: number,
  fps: number,
  opts: DwellOptions = {},
  seed = 0,
): string | undefined => {
  const phase = seed * 1.37; // 无理数间隔错相
  const parts: string[] = [];
  if (opts.breathe) {
    parts.push(`scale(${dwellBreathe(frame, fps, opts.breathe, opts.breathePeriodSec ?? 4.5, phase).toFixed(4)})`);
  }
  const ax = opts.driftX || 0;
  const ay = opts.driftY || 0;
  if (ax > 0 || ay > 0) {
    const d = dwellDrift(frame, fps, ax, ay, opts.driftPeriodSec ?? 9, phase);
    parts.push(`translate(${d.x.toFixed(2)}px, ${d.y.toFixed(2)}px)`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
};
