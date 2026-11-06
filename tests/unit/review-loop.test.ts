/**
 * review-loop.ts 单测：审片 agent 闭环纯函数（P2-7）
 * 中性提问模板（无引导句式）、变体命令（基线打头/上限）、未命中降级拆分。
 */
import assert from 'node:assert/strict';
import {buildReviewPrompt, buildVariantsCommand, splitUnmatched} from '../../src/shared/review-loop.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  // 中性提问：含段信息/步长/类目清单/「没问题不提」与「禁止推测」双护栏；无「是不是」引导句式
  const seg = {index: 2, id: 'seg-2', templateId: 'CursorFollow', startSec: 10.5, endSec: 16.5};
  const p = buildReviewPrompt(seg, 0.5, 4);
  assert.ok(p.includes('CursorFollow') && p.includes('0.5s') && p.includes('10.5-16.5'));
  assert.ok(p.includes('没有问题就不要提'), '空护栏');
  assert.ok(p.includes('禁止推测'), '防顺着说护栏');
  assert.ok(!p.includes('是不是') && !p.includes('是否很') || p.includes('是否让你'), '允许的类目问法不含引导预设');
  ok('buildReviewPrompt 中性模板');
}

{
  // 变体命令：{} 基线打头 + 处方序列化；上限 4 变体；win 加 TEMP 前缀
  const cmd = buildVariantsCommand('smoke_test/promo-v11-official.ts', 2, [{flyAmp: 1.2}, {dim: 0.45}]);
  assert.ok(cmd.includes('RENDER_SEGMENT_VARIANTS=2:{},2:{"flyAmp":1.2},2:{"dim":0.45}'), `命令形态（实测 ${cmd}）`);
  assert.ok(cmd.endsWith('smoke_test/promo-v11-official.ts'));
  if (process.platform === 'win32') assert.ok(cmd.includes("TEMP='D:\\Videotool"), 'win TEMP 前缀');
  const capped = buildVariantsCommand('e.ts', 5, [{a: 1}, {b: 2}, {c: 3}, {d: 4}]);
  assert.equal((capped.match(/5:\{/g) ?? []).length, 4, '上限 4 变体（基线+3 处方）');
  ok('buildVariantsCommand 基线打头/序列化/上限');
}

{
  // 未命中降级：命中 cue 覆盖的短语剔除，其余保留为人工判读候选
  const out = splitUnmatched('有点晕，主界面看不清，配色有点土', ['晕', '主界面看不清']);
  assert.deepEqual(out, ['配色有点土'], '已覆盖剔除、新反馈保留');
  assert.deepEqual(splitUnmatched('节奏还行', []), ['节奏还行'], '无命中全保留');
  assert.deepEqual(splitUnmatched('晕', ['晕']), [], '短于 2 字的碎片丢弃');
  assert.deepEqual(splitUnmatched('', ['x']), [], '空反馈');
  ok('splitUnmatched 降级拆分');
}

console.log(`\n共 ${passed} 项全部通过`);
