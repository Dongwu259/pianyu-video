/**
 * beatPulseAt / beatPulseEnvelope 单测：鼓点包络（当帧 1、指数衰减、未来节拍不计、
 * 连拍取 max、窗口外跳过）；加权包络的重拍呼吸 / 快拍衰减 / 平滑起跳。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/beat-pulse.test.ts
 */
import {beatPulseAt, beatPulseEnvelope, PULSE_SCALE_AMOUNT, PULSE_FLASH_AMOUNT} from '../../src/shared/beat-pulse';

let passed = 0;
let failed = 0;
const near = (actual: number, expected: number, msg: string, eps = 1e-6) => {
  if (Math.abs(actual - expected) <= eps) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  }
};
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

// 基准：fps=30，节拍在 1.0s（= 第 30 帧）
const beats = [1.0];

// 1. 空节拍 → 恒 0
near(beatPulseAt([], 30, 30), 0, 'empty beats');
near(beatPulseAt([], 0, 30), 0, 'empty beats at 0');

// 2. 鼓点当帧强度 = 1
near(beatPulseAt(beats, 30, 30), 1, 'beat frame = 1');

// 3. 未来节拍（帧在鼓点之前）→ 0
near(beatPulseAt(beats, 29, 30), 0, 'before beat');
near(beatPulseAt(beats, 0, 30), 0, 'well before beat');

// 4. 指数衰减：d 帧后 = exp(-d/4.5)
near(beatPulseAt(beats, 30 + 4.5, 30), Math.exp(-1), 'decay d=4.5', 1e-9);
near(beatPulseAt(beats, 39, 30), Math.exp(-9 / 4.5), 'decay d=9', 1e-9);

// 5. 窗口外（>24 帧）→ 0（提前跳过分支）
near(beatPulseAt(beats, 55, 30), 0, 'outside window');
near(beatPulseAt(beats, 300, 30), 0, 'far outside window');

// 6. 连拍取 max 不叠加：两拍 0.5s 间隔，在第二拍当帧应 = 1（而非 >1 的叠加）
const beats2 = [1.0, 1.5];
near(beatPulseAt(beats2, 45, 30), 1, 'second beat frame = 1');
// 两拍之间：第一拍衰减中、第二拍未到 → 取第一拍包络
near(beatPulseAt(beats2, 36, 30), Math.exp(-6 / 4.5), 'between beats', 1e-9);

// 7. 幅值常量语义：缩放 ≤ 2%、闪动 ≤ 6%（保持隐约可感，防止未来调参失控）
ok(PULSE_SCALE_AMOUNT > 0 && PULSE_SCALE_AMOUNT <= 0.02, 'scale amount subtle');
ok(PULSE_FLASH_AMOUNT > 0 && PULSE_FLASH_AMOUNT <= 0.06, 'flash amount subtle');

// 8. 不同 fps 换算一致：0.5s 节拍在 fps=60 下第 30 帧 = 1
near(beatPulseAt([0.5], 30, 60), 1, 'fps=60 beat frame');

// ===== beatPulseEnvelope（防抽搐的加权包络）=====

// 9. 空节拍 → 0
near(beatPulseEnvelope([], 30, 30), 0, 'envelope empty beats');

// 10. 重拍呼吸：4/4 网格上第 0 拍全幅，第 1 拍只有 45%
{
  // 拍距 0.5s（120 BPM），fps=30 → 拍在 15/30/45/60 帧
  const grid = [15 / 30, 30 / 30, 45 / 30, 60 / 30].map((t, i) => i * 0.5);
  void grid;
  const beats4 = [0, 0.5, 1.0, 1.5].map((t) => t + 1.0);
  const atDown = beatPulseEnvelope(beats4, 30, 30); // 1.0s = 第 0 拍当帧（attack=0 → 爬坡起点）
  const atOff = beatPulseEnvelope(beats4, 60, 30); // 2.0s = 第 2 拍（i=2，非重拍）当帧
  near(atDown, 0, 'downbeat frame 0 (attack ramp start)', 1e-9);
  // 起跳爬坡 1.5 帧：重拍 i=0 在 d=1.5 帧时到达全幅
  near(beatPulseEnvelope(beats4, 31.5, 30), 1 * Math.exp(-1.5 / 4.5), 'downbeat d=1.5 full amp');
  // 中间拍（i=2）当帧仍是前拍（i=1，幅度 0.45）的衰减尾：连续呼吸而不是清零
  near(atOff, 0.45 * Math.exp(-15 / 4.5), 'offbeat frame 0 = prev tail', 1e-9);
  near(beatPulseEnvelope(beats4, 61.5, 30), 0.45 * Math.exp(-1.5 / 4.5), 'offbeat d=1.5 amp=0.45', 1e-9);
}

// 11. 快拍衰减：140 BPM（拍距 ~0.43s）幅度按间隔比例缩小
{
  const beatsFast = [1.0, 1.0 + 60 / 140, 1.0 + 2 * (60 / 140)];
  const interval = 60 / 140;
  const expect = (interval / 0.5) * Math.exp(-1.5 / 4.5); // i=0 重拍 × 快拍系数
  near(beatPulseEnvelope(beatsFast, 31.5, 30), expect, 'fast beat scaled by interval', 1e-6);
}

// 12. 起跳爬坡：单帧阶跃不再——d=0 时 0，d=0.75 时半幅
{
  const b = [1.0];
  const half = beatPulseEnvelope(b, 30.75, 30);
  ok(half > 0 && half < Math.exp(-0.75 / 4.5), 'attack ramps (frame 0.75 < full)');
}

console.log(`beat-pulse: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
