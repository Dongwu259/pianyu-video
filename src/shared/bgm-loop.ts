/**
 * BGM 循环平铺规划（纯函数，可单测）。
 *
 * 问题：BGM 短于成片时 <Audio> 播完即止，后半段成片无声（此前无循环/裁剪机制）。
 * 方案：把 BGM 按「等 power 交叉淡化」平铺成 N 份 Sequence——相邻两份重叠
 * CROSSFADE 帧，前一份尾淡出、后一份头淡入，接缝无咔哒声也无音量凹陷。
 *
 * MultiSegmentPromo 消费本规划渲染 N 个 <Sequence>；音量包络（淡入/淡出/ducking）
 * 仍按绝对帧计算，每份 Sequence 内由本地帧换算绝对帧。
 */

/** 循环接缝交叉淡化时长（秒）：够消咔哒声，又短到听不出节奏断点 */
export const BGM_LOOP_CROSSFADE_SEC = 0.12;
/** BGM 需要循环而工程未配淡出时的默认片尾淡出（秒）：循环戛然而止比自然曲目结尾更突兀 */
export const BGM_LOOP_DEFAULT_FADEOUT_SEC = 2;

export interface BgmLoopPlan {
  /** BGM 平铺份数（1 = 不循环，与旧行为逐帧一致） */
  copies: number;
  /** 每份的帧数（= BGM 完整时长） */
  copyFrames: number;
  /** 第 k 份的起始帧（绝对帧）：startAt + k*(copyFrames - crossfadeFrames)；copies=0 = BGM 不进成片 */
  startFrames: number[];
  /** 接缝交叉淡化帧数（0 = 不循环无接缝） */
  crossfadeFrames: number;
  /** 实际采用的片尾淡出秒数（循环且未配淡出时取默认值） */
  effectiveFadeOutSec: number;
}

/** planBgmLoop 输入（P2.5 v1.5：起播点 + 媒体循环窗；spanSec=整曲时长且 startAtSec=0 = 旧行为逐帧一致） */
export interface BgmLoopPlanInput {
  /** 循环窗时长（秒）= trimEnd − trimStart */
  spanSec: number;
  /** 成片时间轴起播点（秒，缺省 0） */
  startAtSec?: number;
  /** 成片总时长（秒，内容帧 + 片尾淡黑） */
  videoTotalSec: number;
  /** 工程配置的淡出秒数（0/undefined = 未配置） */
  fadeOutSec?: number;
  /** 合成帧率 */
  fps: number;
}

export const planBgmLoop = (input: BgmLoopPlanInput): BgmLoopPlan => {
  const {spanSec, videoTotalSec, fadeOutSec, fps} = input;
  const startAtF = Math.round(Math.max(0, input.startAtSec ?? 0) * fps);
  const copyFrames = Math.max(1, Math.round(Math.max(0, spanSec) * fps));
  const totalFrames = Math.max(1, Math.round(Math.max(0, videoTotalSec) * fps));
  // 起播点在片尾之后：BGM 完全不出现在成片（UI 侧已钳上界；渲染端空规划零渲染）
  if (startAtF >= totalFrames) {
    return {
      copies: 0,
      copyFrames,
      startFrames: [],
      crossfadeFrames: 0,
      effectiveFadeOutSec: fadeOutSec || 0,
    };
  }
  if (spanSec <= 0 || copyFrames >= totalFrames - startAtF) {
    return {
      copies: 1,
      copyFrames,
      startFrames: [startAtF],
      crossfadeFrames: 0,
      effectiveFadeOutSec: fadeOutSec || 0,
    };
  }
  const crossfadeFrames = Math.max(1, Math.round(BGM_LOOP_CROSSFADE_SEC * fps));
  // 接缝重叠后每新增一份净增 copyFrames - crossfadeFrames 覆盖；份数从起播点起覆盖到 totalFrames
  const stride = copyFrames - crossfadeFrames;
  const copies = 1 + Math.ceil((totalFrames - startAtF - copyFrames) / stride);
  const startFrames = Array.from({length: copies}, (_, k) => startAtF + k * stride);
  return {
    copies,
    copyFrames,
    startFrames,
    crossfadeFrames,
    effectiveFadeOutSec: fadeOutSec && fadeOutSec > 0 ? fadeOutSec : BGM_LOOP_DEFAULT_FADEOUT_SEC,
  };
};

/**
 * 第 k 份在本地帧 f 处的接缝淡入/淡出倍率（等 power 近似用线性即可，0.12s 窗内听感无差）：
 * - 非首份的头部 crossfadeFrames 线性淡入；
 * - 非末份的尾部 crossfadeFrames 线性淡出。
 * 与全局包络（淡入/淡出/ducking）相乘使用。
 */
export const bgmLoopEnvelopeAt = (
  plan: BgmLoopPlan,
  copyIndex: number,
  localFrame: number,
): number => {
  if (plan.copies <= 1) return 1;
  const cf = plan.crossfadeFrames;
  let v = 1;
  if (copyIndex > 0 && localFrame < cf) v = Math.min(v, localFrame / cf);
  if (copyIndex < plan.copies - 1 && localFrame > plan.copyFrames - cf) {
    v = Math.min(v, Math.max(0, (plan.copyFrames - localFrame) / cf));
  }
  return v;
};
