/**
 * 节拍对齐（shared/beat-align.ts）纯逻辑单元测试
 *
 * 运行方式：node tests/unit/beat-align.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块无运行时依赖）
 */

import assert from 'node:assert/strict';
import {detectBeats, snapDurationsToBeats, snapTransitionsToBeats} from '../../src/shared/beat-align.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 构造 240 桶、30s 的波形（桶时长 0.125s），在指定桶放尖峰 */
const makePeaks = (spikes: Record<number, number>, base = 0.1): number[] => {
  const peaks = Array.from({length: 240}, () => base);
  for (const [i, v] of Object.entries(spikes)) {
    peaks[Number(i)] = v;
    if (Number(i) > 0 && peaks[Number(i) - 1] === base) peaks[Number(i) - 1] = Math.min(v * 0.3, 0.9);
    if (Number(i) < 239 && peaks[Number(i) + 1] === base) peaks[Number(i) + 1] = Math.min(v * 0.3, 0.9);
  }
  return peaks;
};

// ====== 1. detectBeats 节拍检测 ======

console.log('detectBeats 节拍检测:');
{
  // 每 8 桶一个尖峰 = 每 1s 一拍（8 * 0.125）
  const beats = detectBeats(makePeaks({4: 1.0, 12: 1.0, 20: 1.0, 28: 1.0}), 30);
  assert.equal(beats.length, 4);
  assert.ok(Math.abs(beats[0] - 0.5625) < 1e-9 && Math.abs(beats[3] - 3.5625) < 1e-9);
  ok('等间隔尖峰 → 检出 4 拍，时间在桶中心');

  // 幅度不足全局峰值 55% 的鼓点不检出
  const weak = detectBeats(makePeaks({4: 1.0, 40: 0.5, 80: 0.52}), 30);
  assert.equal(weak.length, 1);
  ok('低于 55% 阈值的峰被过滤');

  // 相邻节拍最小间隔 0.3s：idx4(t=0.5625) 与 idx6(t=0.8125) 间隔 0.25s，后者被拒
  const dense = detectBeats(makePeaks({4: 1.0, 5: 0.7, 6: 0.9, 40: 1.0}), 30);
  assert.deepEqual(dense, [0.5625, (40 + 0.5) * 0.125]);
  ok('密集峰按 0.3s 最小间隔去重');

  assert.deepEqual(detectBeats([], 30), []);
  assert.deepEqual(detectBeats([0.5, 0.5], 30), []);
  assert.deepEqual(detectBeats(makePeaks({}), 30), []);
  assert.deepEqual(detectBeats(makePeaks({4: 1.0}), 0), []);
  ok('空/过短/全平/零时长输入返回空');
}

// ====== 2. snapDurationsToBeats 边界吸附 ======

console.log('snapDurationsToBeats 边界吸附:');
{
  const r = snapDurationsToBeats([2.2, 1.8, 3.4, 2.0], [2.0, 4.0, 7.0]);
  assert.ok(r);
  assert.deepEqual(r.durations, [2.0, 2.0, 3.0, 2.0]);
  assert.equal(r.movedCount, 3);
  ok('三个边界依次压拍，片尾不吸附');

  // 顺序推进：前段吸附后，后续边界从新位置继续累计（3 段才有 2 个内部切点）
  const seq = snapDurationsToBeats([2.2, 2.2, 2.0], [2.0, 4.0]);
  assert.deepEqual(seq?.durations, [2.0, 2.0, 2.0]);
  assert.equal(seq?.movedCount, 2);
  ok('吸附顺序推进，后续边界继续压拍');

  // 超出容差不吸附
  const far = snapDurationsToBeats([2.7, 2.0], [2.0]);
  assert.equal(far?.movedCount, 0);
  assert.deepEqual(far?.durations, [2.7, 2.0]);
  ok('距节拍 0.7s > 容差 0.6s → 不动');

  // 钳到最短时长：边界 1.3 吸附到 0.8 → 不足 min=1 → 钳为 1.0
  const clamped = snapDurationsToBeats([1.3, 2.0], [0.8]);
  assert.deepEqual(clamped?.durations, [1.0, 2.0]);
  assert.equal(clamped?.movedCount, 1);
  ok('吸附结果钳制到最短 1s');

  assert.equal(snapDurationsToBeats([2.0], []), null);
  assert.equal(snapDurationsToBeats([], [1.0]), null);
  ok('无节拍/无片段返回 null');
}

console.log(`\n全部通过（${passed} 组断言）`);

// ====== 转场时长吸附节拍（P1：转场与切点一样踩拍） ======
{
  const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]; // 120 BPM
  const segs = [
    {transition: 'whip' as const, transitionParams: undefined},
    {transition: 'crossfade' as const, transitionParams: {durationSec: 0.47}},
    {transition: 'none' as const, transitionParams: undefined},
    {transition: 'push' as const, transitionParams: {durationSec: 0.9}},
  ];
  const r = snapTransitionsToBeats(segs, beats);
  assert.ok(r !== null);
  assert.equal(r!.durations[0], 0.25, 'whip 缺省 0.35 → 半拍 0.25');
  assert.equal(r!.durations[1], 0.5, '0.47 → 0.5');
  assert.equal(r!.durations[2], 0, '硬切不参与');
  assert.equal(r!.durations[3], 1, '0.9 → 1.0（整拍）');
  assert.equal(r!.movedCount, 3, '移动计数 3');
  ok('转场时长吸附半拍网格（缺省查表 + 就近吸附 + 硬切跳过）');

  const onGrid = snapTransitionsToBeats([{transition: 'crossfade' as const, transitionParams: {durationSec: 0.5}}], beats);
  assert.equal(onGrid?.movedCount, 0);
  ok('已在网格上的时长不动');

  assert.equal(snapTransitionsToBeats(segs, [0, 1]), null);
  ok('节拍不足返回 null（调用方跳过）');
}
