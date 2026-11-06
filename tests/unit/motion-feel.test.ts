/**
 * 入场运动模糊（entrance-blur）与驻留微运动（dwell-motion）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/motion-feel.test.ts
 */

import assert from 'node:assert/strict';
import {
  blurFromDelta, entranceBlurAt, springBlurAt, blurFilter,
  ENTRANCE_BLUR_MAX_PX,
} from '../../src/shared/entrance-blur.ts';
import {dwellBreathe, dwellDrift, dwellTransform} from '../../src/shared/dwell-motion.ts';

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
};

const quint = (x: number) => 1 - Math.pow(1 - x, 5);

console.log('blurFromDelta（位移→模糊半径）:');
check('零/亚像素位移 → 0；位移大 → 线性放大并钳上限', () => {
  assert.equal(blurFromDelta(0), 0);
  assert.equal(blurFromDelta(0.1), 0); // 低于最小半径
  assert.ok(blurFromDelta(4) > 2 && blurFromDelta(4) < 3); // 4×0.6=2.4
  assert.equal(blurFromDelta(100), ENTRANCE_BLUR_MAX_PX);
  assert.equal(blurFromDelta(-100), ENTRANCE_BLUR_MAX_PX); // 方向无关
});

console.log('entranceBlurAt（缓动入场）:');
check('入场前段模糊最大、终点归零；p≥1 恒 0（第 0 帧无前帧物理上无模糊）', () => {
  const early = entranceBlurAt(1 / 24, 40, 24, quint);
  const mid = entranceBlurAt(0.5, 40, 24, quint);
  assert.ok(early > mid, `early=${early} mid=${mid}`);
  assert.ok(mid > 0);
  assert.equal(entranceBlurAt(1, 40, 24, quint), 0);
  assert.equal(entranceBlurAt(1.2, 40, 24, quint), 0);
  assert.equal(entranceBlurAt(0.5, 40, 0, quint), 0); // 除零保护
});

console.log('springBlurAt / blurFilter:');
check('弹簧差值转模糊；filter 字符串 0 返回 undefined', () => {
  assert.equal(springBlurAt(0.5, 0.5, 24), 0);
  assert.ok(springBlurAt(0.8, 0.5, 24) > 0);
  assert.equal(blurFilter(0), undefined);
  assert.equal(blurFilter(2.4), 'blur(2.4px)');
});

console.log('dwellBreathe / dwellDrift / dwellTransform（驻留微运动）:');
check('呼吸在 1±amount 内正弦波动；不同 phase 错相', () => {
  const v0 = dwellBreathe(0, 30, 0.012, 4.5, 0);
  const v1 = dwellBreathe(34, 30, 0.012, 4.5, 0);
  assert.notEqual(v0, v1);
  for (let f = 0; f < 300; f += 7) {
    const v = dwellBreathe(f, 30, 0.012);
    assert.ok(v >= 0.988 && v <= 1.012, `f=${f} v=${v}`);
  }
  // 错相：不同 seed 同帧不同值（防同频共振）
  assert.notEqual(dwellBreathe(10, 30, 0.012, 4.5, 0), dwellBreathe(10, 30, 0.012, 4.5, 1.37));
});
check('漂移在幅度包络内（含二次谐波余量）且轨迹平滑', () => {
  for (let f = 0; f < 600; f += 11) {
    const d = dwellDrift(f, 30, 4, 3);
    assert.ok(Math.abs(d.x) <= 4 * 1.31, `x=${d.x}`);
    assert.ok(Math.abs(d.y) <= 3 * 1.31, `y=${d.y}`);
  }
  // 平滑：相邻帧位移小（不会跳变）
  const a = dwellDrift(100, 30, 4, 3);
  const b = dwellDrift(101, 30, 4, 3);
  assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1);
});
check('dwellTransform：全关返回 undefined；breathe/drift 组合输出', () => {
  assert.equal(dwellTransform(10, 30, {}), undefined);
  assert.equal(dwellTransform(10, 30, {breathe: false, driftX: false, driftY: false}), undefined);
  const s = dwellTransform(10, 30, {breathe: 0.012, driftY: 3}, 2)!;
  assert.ok(s.includes('scale('));
  assert.ok(s.includes('translate('));
  const onlyDrift = dwellTransform(10, 30, {driftX: 4})!;
  assert.ok(!onlyDrift.includes('scale('));
  assert.ok(onlyDrift.includes('translate('));
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
