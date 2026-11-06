/**
 * 撤销/重做历史纯逻辑单元测试（快照栈裁剪 / 深拷贝隔离 / 内容判等）
 *
 * 运行方式：node tests/unit/history-utils.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 React / Electron）
 */

import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT,
  deepClone,
  pushHistoryEntry,
  snapshotsEqual,
} from '../../src/renderer/store/historyUtils.ts';
import type {HistorySnapshot} from '../../src/renderer/store/historyUtils.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 构造一个最小快照，title 用于区分不同内容 */
const makeSnapshot = (title: string): HistorySnapshot => ({
  segments: [
    {
      id: `seg-${title}`,
      templateId: 'RevealSlide',
      videos: [],
      text: {title, subtitle: '', features: [], brandName: ''},
      style: {},
      layout: {position: 'center', size: 'medium', align: 'center'},
      duration: 8,
      transition: 'crossfade',
      videoEffect: 'none',
      backgroundEffect: 'none',
    } as HistorySnapshot['segments'][number],
  ],
  templateId: 'RevealSlide',
  videos: [],
  text: {title, subtitle: '', features: [], brandName: ''},
  style: {},
  layout: {position: 'center', size: 'medium', align: 'center'} as HistorySnapshot['layout'],
  bgm: null,
  aspectRatioId: '16-9',
  orientation: 'landscape',
});

// ====== pushHistoryEntry：入栈与容量裁剪 ======

// 未满时按序追加
{
  let past: HistorySnapshot[] = [];
  past = pushHistoryEntry(past, makeSnapshot('a'));
  past = pushHistoryEntry(past, makeSnapshot('b'));
  assert.equal(past.length, 2);
  assert.equal(past[0].text.title, 'a');
  assert.equal(past[1].text.title, 'b');
  ok('入栈按序追加（栈顶是最近一次）');
}

// 超过上限丢弃最旧，保留最新
{
  let past: HistorySnapshot[] = [];
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
    past = pushHistoryEntry(past, makeSnapshot(`s${i}`));
  }
  assert.equal(past.length, HISTORY_LIMIT);
  assert.equal(past[0].text.title, 's10'); // 最旧的 s0..s9 被裁掉
  assert.equal(past[past.length - 1].text.title, `s${HISTORY_LIMIT + 9}`);
  ok(`超过 ${HISTORY_LIMIT} 条时丢弃最旧、保留最新`);
}

// 不修改原数组（纯函数）
{
  const before = [makeSnapshot('x')];
  const after = pushHistoryEntry(before, makeSnapshot('y'));
  assert.equal(before.length, 1);
  assert.notEqual(after, before);
  ok('pushHistoryEntry 是纯函数，不修改原栈');
}

// ====== deepClone：快照与 live 状态脱钩 ======

{
  const snap = makeSnapshot('原文案');
  const clone = deepClone(snap);
  // 修改深拷贝的嵌套字段，原对象不应受影响（反之亦然）
  clone.segments[0].text.title = '被串改';
  clone.text.features?.push('新增卖点');
  assert.equal(snap.segments[0].text.title, '原文案');
  assert.equal(snap.text.features?.length, 0);
  assert.equal(clone.text.title, '原文案'); // 未动的字段保持一致
  ok('deepClone 后修改嵌套字段互不影响');
}

// ====== snapshotsEqual：内容判等（用于跳过伪改动） ======

{
  const a = makeSnapshot('相同');
  const b = deepClone(a);
  assert.notEqual(a.segments, b.segments); // 引用不同
  assert.equal(snapshotsEqual(a, b), true); // 内容相同
  ok('引用不同但内容相同判为相等');
}

{
  const a = makeSnapshot('改动前');
  const b = makeSnapshot('改动后');
  assert.equal(snapshotsEqual(a, b), false);
  ok('内容不同判为不等');
}

{
  const a = makeSnapshot('同');
  const b = {...deepClone(a), aspectRatioId: '9-16', orientation: 'portrait' as const};
  assert.equal(snapshotsEqual(a, b), false);
  ok('比例/方向变化判为不等');
}

console.log(`\nhistory-utils: ${passed} 个测试全部通过`);
