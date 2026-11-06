/**
 * VLM 审片（review_render）纯函数单元测试：报告解析 + 提示词 + 参数校验
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/review-report.test.ts
 */

import assert from 'node:assert/strict';
import {
  parseReviewReport,
  buildReviewPrompt,
  REVIEW_DIMENSIONS,
} from '../../src/shared/review-report.ts';
import {validateReviewRenderArgs} from '../../src/shared/llm-tools.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('parseReviewReport:');
{
  const r = parseReviewReport(
    '{"scores":{"hook":4,"readability":2,"motionCoherence":5},"overall":3.4,"verdict":"revise",' +
    '"issues":[{"dimension":"readability","segmentIndex":1,"severity":"high","problem":"第 2 段标题字号过小","suggestion":"调大标题字号"}],' +
    '"found":false,"summary":"整体尚可，文字需加强"}',
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.report.scores.readability, 2);
    assert.equal(r.report.verdict, 'revise');
    assert.equal(r.report.issues.length, 1);
    assert.equal(r.report.issues[0].severity, 'high');
    assert.equal(r.report.summary, '整体尚可，文字需加强');
  }
  ok('正常 JSON 解析（含无效 issue 字段被过滤）');
}
{
  const r = parseReviewReport('```json\n{"scores":{"hook":5},"issues":[]}\n```');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.report.scores.hook, 5);
    assert.equal(r.report.overall, 5);
    assert.equal(r.report.verdict, 'pass');
  }
  ok('markdown 围栏剥离 + overall 缺省取维度均值');
}
{
  const r = parseReviewReport('前置说明文字 {"scores":{"hook": 6, "readability": 0},"verdict":"meh","issues":"not-array"} 后置说明');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.report.scores.hook, 5, '越界分数钳到 5');
    assert.equal(r.report.scores.readability, 1, '越界分数钳到 1');
    assert.deepEqual(r.report.issues, [], 'issues 非数组→空');
    assert.equal(r.report.verdict, 'revise', '非法 verdict 按总分推断（(5+1)/2=3 → revise）');
  }
  ok('分数钳制 + 非法字段容错');
}
{
  const r = parseReviewReport('模型完全没输出 JSON');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.raw, '模型完全没输出 JSON');
  ok('坏文本返回 {ok:false, raw}');
}
{
  const r = parseReviewReport('');
  assert.equal(r.ok, false);
  ok('空文本返回 {ok:false}');
}
{
  const r = parseReviewReport('{"scores":{},"issues":[]}');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.report.scores.commercial, 3, '全缺维度时补 commercial=3');
    assert.equal(r.report.verdict, 'revise', 'overall 兜底 3 → revise');
  }
  ok('全空分数兜底');
}

console.log('buildReviewPrompt:');
{
  const prompt = buildReviewPrompt({
    segments: [{index: 0, templateId: 'BrandIntro', title: '片语', duration: 2.5}],
    frames: [{timeSec: 1.2, note: '第 1.2s（第 1 段内）'}],
    focus: '标题可读性',
  });
  assert.ok(prompt.includes('审片导演'));
  for (const d of REVIEW_DIMENSIONS) {
    assert.ok(prompt.includes(d.key), `缺少维度 ${d.key}`);
  }
  assert.ok(prompt.includes('BrandIntro') && prompt.includes('片语'));
  assert.ok(prompt.includes('第 1.2s（第 1 段内）'));
  assert.ok(prompt.includes('标题可读性'));
  assert.ok(prompt.includes('只输出一个 JSON 对象'));
  ok('包含全部维度/故事板上文/帧说明/focus/JSON 要求');
}

console.log('validateReviewRenderArgs:');
{
  const r = validateReviewRenderArgs({});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.path, undefined);
  ok('空参数合法（缺省最近渲染产物）');
}
{
  const r = validateReviewRenderArgs({path: 'D:/out/promo.mp4', focus: '节奏'});
  assert.equal(r.ok, true);
  ok('path + focus 合法');
}
{
  assert.equal(validateReviewRenderArgs({path: ''}).ok, false);
  assert.equal(validateReviewRenderArgs({path: 123}).ok, false);
  assert.equal(validateReviewRenderArgs({focus: 'x'.repeat(101)}).ok, false);
  ok('空 path / 非字符串 path / 超 100 字 focus 拒绝');
}

console.log(`\n全部通过（${passed} 组断言）`);
