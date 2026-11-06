/**
 * historyUtils AI 事务标最小版（timeline-master-plan 持续基建带②）单测：
 * 打标/消费/丢弃三态——标记一次性（消费后清空）、无标记时消费返回 null（=user 语义）。
 */
import assert from 'node:assert/strict';
import {markAgentOp, consumeAgentOp, dropAgentOp, type HistorySnapshot} from '../../src/renderer/store/historyUtils.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  assert.equal(consumeAgentOp(), null, '初始无标记');
  markAgentOp('update_segment');
  const m = consumeAgentOp();
  assert.deepEqual(m, {source: 'agent', opName: 'update_segment'}, '消费取回工具名');
  assert.equal(consumeAgentOp(), null, '标记一次性（再消费为 null）');
  ok('打标-消费一次性');
}
{
  markAgentOp('set_bgm_position');
  dropAgentOp();
  assert.equal(consumeAgentOp(), null, '丢弃后无标记');
  ok('丢弃（工具无历史副作用时防串标）');
}
{
  // source/opName 为 additive 可选字段：带标快照照常 JSON 判等/深拷贝（App.tsx 附标路径）
  const snap = {segments: [], source: 'agent' as const, opName: 'reorder_segments'} as unknown as HistorySnapshot;
  const clone = JSON.parse(JSON.stringify(snap)) as HistorySnapshot;
  assert.equal(clone.source, 'agent', '标随快照深拷贝存活');
  assert.equal(JSON.stringify(snap), JSON.stringify(clone), '判等不受影响');
  ok('快照 additive 字段安全');
}

console.log(`history-source: ${passed} 组全 PASS`);
