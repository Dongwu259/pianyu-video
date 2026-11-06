/**
 * 素材库自动配段 纯分配逻辑 单元测试
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/pool-distribution.test.ts
 */

import assert from 'node:assert/strict';
import {allocatePoolRoundRobin, computePoolDeficits, countUnmetSegments} from '../../src/shared/pool-distribution.ts';

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 模拟注册表：min/max 素材数
const limits = (id: string): {min: number; max: number} | undefined =>
  ({FeatureList: {min: 0, max: 0}, CityScape3D: {min: 0, max: 6}, RevealSlide: {min: 1, max: 1}, SplitShowcase: {min: 2, max: 2}, ScreenRecord: {min: 1, max: 1}})[id];

test('纯文字模板（max 0）不参与分配', () => {
  const d = computePoolDeficits([{templateId: 'FeatureList', clipCount: 0}], limits);
  assert.deepEqual(d, [0]);
});

test('空段补到 max(1, min)；已有多条的段只补 min 差额', () => {
  const d = computePoolDeficits(
    [{templateId: 'RevealSlide', clipCount: 0}, {templateId: 'RevealSlide', clipCount: 1}, {templateId: 'SplitShowcase', clipCount: 1}],
    limits,
  );
  // 空段缺 1；已有 1 条（=min）缺 0；SplitShowcase min2 还缺 1
  assert.deepEqual(d, [1, 0, 1]);
});

test('未知模板按 min1/max1 兜底', () => {
  const d = computePoolDeficits([{templateId: 'mkt-unknown', clipCount: 0}], limits);
  assert.deepEqual(d, [1]);
});

test('轮转分配：缺口 [1,0,1] + 库 2 条 → 段0、段2 各得 1', () => {
  const fills = allocatePoolRoundRobin([1, 0, 1], 2);
  assert.deepEqual(fills.map((f) => f.length), [1, 0, 1]);
  assert.deepEqual(fills.flat(), [0, 1]); // 池下标按序发出
});

test('库耗尽即停，不循环复用', () => {
  const fills = allocatePoolRoundRobin([2, 2, 2], 3);
  assert.deepEqual(fills.map((f) => f.length), [1, 1, 1]);
  assert.deepEqual(fills.flat(), [0, 1, 2]);
});

test('库富余时片段全满足即提前结束', () => {
  const fills = allocatePoolRoundRobin([1, 2], 10);
  assert.deepEqual(fills.map((f) => f.length), [1, 2]);
  assert.equal(fills.flat().length, 3);
});

test('unmet 计数：缺口未填满的片段数', () => {
  const deficits = [2, 0, 1];
  const fills = allocatePoolRoundRobin(deficits, 1);
  assert.equal(countUnmetSegments(deficits, fills), 2); // 段0 缺 2 只得 1、段2 得 0——都算未满足
});

test('空库/零缺口边界', () => {
  assert.deepEqual(allocatePoolRoundRobin([0, 0], 0).map((f) => f.length), [0, 0]);
  assert.equal(countUnmetSegments([0, 0], allocatePoolRoundRobin([0, 0], 5)), 0);
});

console.log(`[pool-distribution] ✓ ${passed} 项全部通过`);
