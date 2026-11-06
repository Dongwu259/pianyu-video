/**
 * 多点缓动曲线单元测试
 *
 * 运行方式：node tests/unit/easing-curve.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import {evalEasingCurve, normalizeCurve, addPoint, removePoint, presetCurve} from '../../src/shared/easing-curve.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('evalEasingCurve 基础:');
{
  assert.equal(evalEasingCurve(undefined, 0.5), 0.5);
  ok('undefined 曲线返回 t（线性）');
}
{
  const lin = presetCurve('linear');
  assert.equal(evalEasingCurve(lin, 0), 0);
  assert.equal(evalEasingCurve(lin, 1), 1);
  assert.equal(evalEasingCurve(lin, 0.5), 0.5);
  ok('线性曲线端点固定、中点 = 0.5');
}
{
  const c = presetCurve('easeIn');
  assert.equal(evalEasingCurve(c, -0.5), 0);
  assert.equal(evalEasingCurve(c, 1.5), 1);
  ok('越界 clamp 到端点 y');
}

console.log('预设曲线形状:');
{
  const ei = presetCurve('easeIn');
  assert.ok(evalEasingCurve(ei, 0.5) < 0.5, `easeIn@0.5=${evalEasingCurve(ei, 0.5)}`);
  const eo = presetCurve('easeOut');
  assert.ok(evalEasingCurve(eo, 0.5) > 0.5, `easeOut@0.5=${evalEasingCurve(eo, 0.5)}`);
  ok('easeIn 慢起（@0.5<0.5）/ easeOut 快起（@0.5>0.5）');
}
{
  const b = presetCurve('bounce');
  let max = 0;
  for (let i = 0; i <= 100; i++) max = Math.max(max, evalEasingCurve(b, i / 100));
  assert.ok(max > 1, `bounce max=${max}`);
  assert.equal(evalEasingCurve(b, 0), 0);
  assert.equal(evalEasingCurve(b, 1), 1);
  ok('bounce 存在 overshoot（>1）且端点固定');
}
{
  const a = presetCurve('anticipate');
  let min = 1;
  for (let i = 0; i <= 100; i++) min = Math.min(min, evalEasingCurve(a, i / 100));
  assert.ok(min < 0, `anticipate min=${min}`);
  ok('anticipate 存在负向预期（<0）');
}

console.log('单调性（非 overshoot 预设应单调不减）:');
{
  for (const id of ['linear', 'easeIn', 'easeOut', 'easeInOut']) {
    const c = presetCurve(id);
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const y = evalEasingCurve(c, i / 100);
      assert.ok(y >= prev - 1e-9, `${id} 非单调 @${(i / 100).toFixed(2)}: ${y} < ${prev}`);
      prev = y;
    }
  }
  ok('linear/easeIn/easeOut/easeInOut 单调不减');
}

console.log('normalizeCurve / addPoint / removePoint:');
{
  const n = normalizeCurve([{x: 0.5, y: 0.5}, {x: 0.2, y: 0.1}, {x: 1, y: 1}, {x: 0, y: 0}]);
  assert.deepEqual(n.points[0], {x: 0, y: 0});
  assert.deepEqual(n.points[n.points.length - 1], {x: 1, y: 1});
  assert.ok(n.points[1].x < n.points[2].x, '中间点未排序');
  ok('normalizeCurve 端点固定 (0,0)/(1,1) + 按 x 排序');
}
{
  const c = addPoint(presetCurve('linear'), 0.5);
  assert.equal(c.points.length, 3);
  assert.equal(c.points[0].x, 0);
  assert.equal(c.points[2].x, 1);
  assert.ok(c.points[1].x > 0 && c.points[1].x < 1);
  ok('addPoint 在中间增加点、端点不变');
}
{
  const c = presetCurve('easeInOut'); // 4 点
  assert.equal(removePoint(c, 1).points.length, 3);
  assert.equal(removePoint(c, 0).points.length, c.points.length); // 首点不可删
  assert.equal(removePoint(c, c.points.length - 1).points.length, c.points.length); // 末点不可删
  ok('removePoint 删中间点、保护首末');
}

console.log(`\n全部通过（${passed} 组断言）`);
