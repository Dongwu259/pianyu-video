/**
 * 节拍脉冲包络（纯函数，渲染合成与单测共用）。
 *
 * BGM 鼓点上画面做微缩放 + 光效闪动（ROADMAP P1「节拍响应式画面」）。
 * 防「抽搐」设计（v1.2.1）：
 * - 重拍加权：假定 4/4，第 0/4/8…拍全幅，中间拍只给 45%——按小节呼吸而不是每拍抽一下；
 * - 快拍衰减：拍间隔 <0.5s（>120 BPM）时幅度按间隔比例缩小，避免高频频闪；
 * - 平滑起跳：起振用 ~50ms（1.5 帧）线性爬坡代替单帧阶跃，缩放不再跳变。
 */

/** 脉冲衰减窗（帧）：超过此窗口的节拍视为已衰减完，提前跳过 */
const PULSE_WINDOW_FRAMES = 24;

/** 脉冲强度 → 画面缩放幅值（微缩放，峰值 +1.8%） */
export const PULSE_SCALE_AMOUNT = 0.018;
/** 脉冲强度 → 光效闪动不透明度幅值（峰值 6%，保持隐约可感） */
export const PULSE_FLASH_AMOUNT = 0.06;

/** 中间拍的幅度系数（重拍 = 1；4/4 假定下的呼吸感） */
const OFFBEAT_AMOUNT = 0.45;
/** 快拍衰减的基准间隔（秒）：间隔短于此值按比例压幅度 */
const FAST_BEAT_INTERVAL = 0.5;

/** 第 i 拍的脉冲幅度系数：重拍加权 × 快拍衰减 */
const beatAccentAt = (beatsSec: number[], i: number): number => {
  const prev = beatsSec[i];
  const next = beatsSec[i + 1] ?? prev + (prev - (beatsSec[i - 1] ?? prev));
  const interval = Math.max(0.05, next - prev);
  const accent = i % 4 === 0 ? 1 : OFFBEAT_AMOUNT;
  const fastScale = Math.min(1, interval / FAST_BEAT_INTERVAL);
  return accent * fastScale;
};

/**
 * 给定帧的脉冲强度 0..1（旧接口，等幅包络；新代码用 beatPulseEnvelope）。
 * 包络 = exp(-d/4.5)：当帧 1，12 帧后 ≈0.07，24 帧后 ≈0.005 视为消失。
 */
export const beatPulseAt = (beatsSec: number[], frame: number, fps: number): number => {
  let m = 0;
  for (let i = 0; i < beatsSec.length; i++) {
    const b = beatsSec[i];
    const d = frame - b * fps;
    if (d < 0 || d > PULSE_WINDOW_FRAMES) continue;
    const v = Math.exp(-d / 4.5);
    if (v > m) m = v;
  }
  return m;
};

/**
 * 给定帧的加权脉冲强度 0..1（卡点混剪用这个）：
 * 每拍幅度 = 重拍系数 × 快拍系数 × exp 衰减 × 起跳爬坡，多拍取 max 不叠加。
 */
export const beatPulseEnvelope = (beatsSec: number[], frame: number, fps: number): number => {
  if (beatsSec.length === 0) return 0;
  let m = 0;
  for (let i = 0; i < beatsSec.length; i++) {
    const d = frame - beatsSec[i] * fps;
    if (d < 0 || d > PULSE_WINDOW_FRAMES) continue;
    // 起跳爬坡：前 1.5 帧线性上升（30fps 下 50ms），之后指数衰减
    const attack = Math.min(1, d / 1.5);
    const v = beatAccentAt(beatsSec, i) * attack * Math.exp(-d / 4.5);
    if (v > m) m = v;
  }
  return m;
};
