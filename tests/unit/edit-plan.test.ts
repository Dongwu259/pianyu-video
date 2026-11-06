/** P1 全局动作单元排片纯函数测试。 */
import assert from 'node:assert/strict';
import {planMaterialContinuity, sanitizeSourceWindow, validateEditPlan, constrainEditPlanShots} from '../../src/shared/edit-plan.ts';

let passed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

const units = [
  {startSec: 0, endSec: 2, subject: '表单', before: '空白', action: '填写参数', after: '参数完成', roles: ['setup'] as const},
  {startSec: 2, endSec: 5, subject: '按钮', before: '参数完成', action: '点击提交', after: '出现结果', roles: ['action'] as const},
  {startSec: 5, endSec: 8, subject: '结果', before: '提交中', action: '展示成功结果', after: '完成', roles: ['result'] as const},
];

check('同一素材跨段时动作单元单调递进', () => {
  const plan = planMaterialContinuity(
    [
      {index: 0, title: '准备参数'},
      {index: 1, title: '执行操作'},
      {index: 2, title: '展示结果'},
    ],
    [{name: 'demo.mp4', path: 'C:\\demo.mp4', durationSec: 8, storyUnits: [...units]}],
  );
  const picks = plan.assignments.map((a) => a.storyUnitIndex);
  assert.deepEqual(picks, [0, 1, 2]);
  assert.equal(plan.assignments[1].sourceStartSec, 2);
  assert.equal(plan.assignments[2].sourceEndSec, 8);
});

check('职责不明确时仍能回退到有时序标签的素材', () => {
  const plan = planMaterialContinuity(
    [{index: 0, templateId: 'VideoCut', title: '城市画面'}],
    [{name: 'a.mp4', path: 'a', durationSec: 4, storyUnits: [{...units[0], startSec: 0, endSec: 4}]}],
  );
  assert.equal(plan.assignments[0].source, 'existing');
  assert.equal(plan.assignments[0].storyUnitIndex, 0);
});

check('没有时序标签时保留旧静态素材逻辑', () => {
  const plan = planMaterialContinuity(
    [{index: 0, title: '任意片段'}, {index: 1, title: '另一个片段'}],
    [{name: 'still.png', path: 'still', durationSec: 3}],
  );
  assert.equal(plan.assignments.length, 2);
  assert.ok(plan.assignments.every((a) => a.source === 'existing' && a.storyUnitIndex === undefined));
  assert.ok(plan.notes.some((n) => n.includes('回退静态')));
});

check('非法窗口被钳制，逆序窗口回退整段', () => {
  assert.deepEqual(sanitizeSourceWindow(-4, 99, 10), {startSec: 0, endSec: 10});
  assert.deepEqual(sanitizeSourceWindow(8, 2, 10), {startSec: 0, endSec: 10});
});

check('正式 EditPlan 拦截逆序时间和超出素材窗口', () => {
  const result = validateEditPlan({
    beats: [{id: 'b', index: 0, startSec: 0, endSec: 2}],
    shots: [{id: 's', beatId: 'b', sourcePath: 'a', sourceStartSec: 0, sourceEndSec: 9, timelineStartSec: 0, timelineEndSec: 2, confidence: 1}],
  }, [{name: 'a', path: 'a', durationSec: 5}]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('超过素材时长')));
});

check('maxVideos constraint keeps highest-confidence shots', () => {
  const plan = constrainEditPlanShots({
    beats: [{id: 'b', index: 0, startSec: 0, endSec: 6}],
    shots: [
      {id: 'low', beatId: 'b', templateId: 'VideoCut', sourcePath: 'a', sourceStartSec: 0, sourceEndSec: 2, timelineStartSec: 0, timelineEndSec: 2, confidence: 0.2},
      {id: 'high', beatId: 'b', templateId: 'VideoCut', sourcePath: 'b', sourceStartSec: 0, sourceEndSec: 2, timelineStartSec: 2, timelineEndSec: 4, confidence: 0.9},
      {id: 'mid', beatId: 'b', templateId: 'VideoCut', sourcePath: 'c', sourceStartSec: 0, sourceEndSec: 2, timelineStartSec: 4, timelineEndSec: 6, confidence: 0.6},
    ],
  }, {VideoCut: {maxVideos: 2}});
  assert.deepEqual(plan.shots?.map((s) => s.id), ['high', 'mid']);
  assert.ok(plan.notes.some((n) => n.includes('最多 2')));
});

console.log(`edit-plan tests: ${passed} passed`);
