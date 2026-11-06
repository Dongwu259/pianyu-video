/**
 * bench-judge 单测（timeline-master-plan M3：「时间线操作 bench」判分器）
 *
 * 锚定：路径取值（含数组下标/缺键）、三型断言（eq/about/len/absent）、unchanged 防顺手改坏、
 * forbiddenCalls 面纪律、判分器可判分（正确过/错误挂）。真链路（MCP 回放）由
 * scripts/bench-timeline-ops.ts selftest 覆盖。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs --test tests/unit/bench-judge.test.ts
 */
import assert from 'node:assert/strict';
import {getPath, evaluateBenchJudge, judgeDiscriminates, type BenchTask} from '../../src/shared/bench-judge.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 路径取值 ======
{
  const state = {segments: [{id: 'a', beats: [{t: 1, kind: 'accent'}], videos: [{trimStart: 3.5}]}], bgm: {startAtSec: 0}};
  assert.equal(getPath(state, 'segments[0].beats[0].kind'), 'accent', '数组下标链');
  assert.equal(getPath(state, 'bgm.startAtSec'), 0, '对象链');
  assert.equal(getPath(state, 'segments[0].captions'), undefined, '缺键 undefined');
  assert.equal(getPath(state, 'segments[9].id'), undefined, '越界 undefined');
  assert.equal(getPath(state, 'bgm'), state.bgm, '整子树引用');
  ok('getPath 点路径四态（下标链/缺键/越界/子树）');
}

// ====== 判分四型 + unchanged + forbidden ======
{
  const fixture = {segments: [{id: 'a', duration: 6, beats: undefined}], bgm: null};
  const judge = {
    assert: [
      {path: 'segments[0].beats', eq: [{t: 1, kind: 'mark'}]},
      {path: 'segments[0].duration', about: 6},
      {path: 'segments[0].beats', len: 1},
    ],
    unchanged: ['bgm', 'segments[0].id'],
    forbiddenCalls: ['set_bgm'],
  };
  const postGood = {segments: [{id: 'a', duration: 6, beats: [{t: 1, kind: 'mark'}]}], bgm: null};
  assert.equal(evaluateBenchJudge(postGood, fixture, judge, [{tool: 'set_segment_beats'}]).length, 0, '正确终态零失败');

  const postWrongKind = {segments: [{id: 'a', duration: 6, beats: [{t: 1, kind: 'accent'}]}], bgm: null};
  assert.equal(evaluateBenchJudge(postWrongKind, fixture, judge, []).length, 1, 'eq 深等抓 kind 错');

  const postDrift = {segments: [{id: 'a', duration: 6.5, beats: [{t: 1, kind: 'mark'}]}], bgm: null};
  const driftFails = evaluateBenchJudge(postDrift, fixture, judge, []);
  assert.ok(driftFails.some((f) => f.kind === 'about'), 'about 容差抓数值漂移');

  const postSideEffect = {segments: [{id: 'b', duration: 6, beats: [{t: 1, kind: 'mark'}]}], bgm: {startAtSec: 3}};
  const sideFails = evaluateBenchJudge(postSideEffect, fixture, judge, []);
  assert.equal(sideFails.filter((f) => f.kind === 'unchanged').length, 2, 'unchanged 抓顺手改坏（id+bgm）');

  const faceFails = evaluateBenchJudge(postGood, fixture, judge, [{tool: 'set_bgm'}]);
  assert.equal(faceFails.filter((f) => f.kind === 'forbidden').length, 1, 'forbiddenCalls 抓面违规');

  const absentFails = evaluateBenchJudge(
    {segments: [{beats: [{t: 1}]}]},
    {segments: []},
    {assert: [{path: 'segments[0].beats', absent: true}]},
    [],
  );
  assert.equal(absentFails.length, 1, 'absent 抓键仍在');
  assert.equal(evaluateBenchJudge({segments: [{}]}, {segments: []}, {assert: [{path: 'segments[0].beats', absent: true}]}, []).length, 0, 'absent 过（键已清）');
  ok('判分四型（eq/about/len/absent）+ unchanged + forbidden 全语义');
}

// ====== 判分器可判分（正确过/错误挂） ======
{
  const task = {
    id: 'x', title: 'x', prompt: '',
    fixture: {segments: [], bgm: null},
    refTrajectory: [{tool: 'set_segment_beats', args: {}}],
    badTrajectory: [{tool: 'set_segment_beats', args: {}}],
    judge: {assert: [{path: 'segments[0].beats', eq: [{t: 1, kind: 'mark'}]}]},
  } as unknown as BenchTask;
  const refState = {segments: [{beats: [{t: 1, kind: 'mark'}]}]};
  const badState = {segments: [{beats: [{t: 2, kind: 'mark'}]}]};
  const r = judgeDiscriminates(refState, badState, task.fixture, task);
  assert.equal(r.refPass, true, '正确终态过');
  assert.equal(r.badCaught, true, '错误终态挂');
  ok('judgeDiscriminates（判分器本身可判分）');
}

console.log(`\nbench-judge: ${passed} 组全过`);
