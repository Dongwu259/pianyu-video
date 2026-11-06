/**
 * 旁白时长护栏（planNarrationFit）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/narration-fit.test.ts
 */

import assert from 'node:assert/strict';
import {
  planNarrationFit,
  NARRATION_FIT_TOLERANCE_SEC,
  NARRATION_FIT_MAX_SPEED,
  NARRATION_FIT_BREATH_SEC,
} from '../../src/shared/narration-fit.ts';

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

console.log('planNarrationFit（旁白时长护栏）:');

check('旁白短于段长 / 溢出在容差内 → ok 不动', () => {
  assert.equal(planNarrationFit(8, 5).action, 'ok');
  const edge = planNarrationFit(8, 8 + NARRATION_FIT_TOLERANCE_SEC);
  assert.equal(edge.action, 'ok');
});

check('轻微溢出 → 提速重合成（新语速 ≈ 旁白/段长 × 现语速，带 3% 余量）', () => {
  // 8s 段配 10s 旁白：需要 1.25 倍 → 1.25*1.03≈1.29 ≤ 1.4 走提速
  const r = planNarrationFit(8, 10, 1);
  assert.equal(r.action, 'speed');
  if (r.action === 'speed') {
    assert.ok(r.speed > 1.25 && r.speed <= NARRATION_FIT_MAX_SPEED, `speed=${r.speed}`);
    assert.ok(r.overflowSec > 1.9 && r.overflowSec <= 2);
  }
});

check('现语速已高时需要的总倍率超上限 → 延长段（旁白 + 气口）', () => {
  // 8s 段配 10s 旁白但已是 1.2 语速：1.2*1.25*1.03≈1.55 > 1.4 → 延长
  const r = planNarrationFit(8, 10, 1.2);
  assert.equal(r.action, 'extend');
  if (r.action === 'extend') {
    assert.equal(r.extendToSec, Math.round((10 + NARRATION_FIT_BREATH_SEC) * 10) / 10);
  }
});

check('溢出太大提速无望（倍率 >1.4）→ 直接延长段', () => {
  // 5s 段配 12s 旁白：需要 2.4 倍 → 延长
  const r = planNarrationFit(5, 12, 1);
  assert.equal(r.action, 'extend');
  if (r.action === 'extend') assert.equal(r.extendToSec, 12 + NARRATION_FIT_BREATH_SEC);
});

check('边界：段长极小/零旁白不炸，extend 留气口', () => {
  assert.equal(planNarrationFit(0, 0).action, 'ok');
  const r = planNarrationFit(0.05, 3, 1);
  assert.equal(r.action, 'extend');
  if (r.action === 'extend') assert.equal(r.extendToSec, 3 + NARRATION_FIT_BREATH_SEC);
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
