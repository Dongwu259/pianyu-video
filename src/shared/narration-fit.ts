/**
 * 旁白时长护栏（纯函数，可单测）。
 *
 * 问题：旁白音频从段起点播放、超出段时长会重叠到下一段（MultiSegmentPromo 顶层
 * Sequence 不截断），此前无任何检测——听感上就是「两段旁白叠着念」。
 *
 * 修复策略（按听感代价排序）：
 * 1. 溢出在容差内（≤0.3s，转场重叠可吸收）→ ok 不动；
 * 2. 适度提速能放下（新语速 ≤1.4，快而不伤听感）→ speed：按该语速重合成；
 * 3. 提速也放不下或要的语速太离谱 → extend：把段时长延长到 旁白时长 + 气口。
 */

/** 溢出容差（秒）：转场重叠与段尾气口能吸收的小溢出 */
export const NARRATION_FIT_TOLERANCE_SEC = 0.3;
/** 提速修复的语速上限（超过就伤听感，改走延长段） */
export const NARRATION_FIT_MAX_SPEED = 1.4;
/** 延长段时给旁白留的段尾气口（秒） */
export const NARRATION_FIT_BREATH_SEC = 0.4;

export type NarrationFitAction =
  | {action: 'ok'; overflowSec: number}
  | {action: 'speed'; speed: number; overflowSec: number}
  | {action: 'extend'; extendToSec: number; overflowSec: number};

/**
 * @param segmentDurationSec 段时长（秒）
 * @param narrationDurationSec 旁白音频实际时长（秒，TTS 合成后回读）
 * @param currentSpeed 当前合成语速（0.5-2，缺省 1）
 */
export const planNarrationFit = (
  segmentDurationSec: number,
  narrationDurationSec: number,
  currentSpeed = 1,
): NarrationFitAction => {
  const seg = Math.max(0.1, segmentDurationSec);
  const narr = Math.max(0, narrationDurationSec);
  const speed = Math.max(0.5, Math.min(2, currentSpeed));
  const overflowSec = Math.round((narr - seg) * 100) / 100;
  if (overflowSec <= NARRATION_FIT_TOLERANCE_SEC) return {action: 'ok', overflowSec: Math.max(0, overflowSec)};
  // 需要的总提速倍率（新语速 ≈ 现语速 × 旁白/段长，加 3% 余量防合成时长抖动）
  const newSpeed = Math.round(speed * (narr / seg) * 1.03 * 100) / 100;
  if (newSpeed <= NARRATION_FIT_MAX_SPEED && newSpeed > speed + 0.02) {
    return {action: 'speed', speed: Math.min(2, newSpeed), overflowSec};
  }
  return {action: 'extend', extendToSec: Math.round((narr + NARRATION_FIT_BREATH_SEC) * 10) / 10, overflowSec};
};
