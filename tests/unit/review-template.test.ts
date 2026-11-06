/**
 * review_template（AI 生成模板审片自修回路）单测：
 * 参数校验 + 模板审片提示词 + parseReviewReport 自定义维度解析。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/review-template.test.ts
 */
import assert from 'node:assert/strict';
import {validateReviewTemplateArgs} from '../../src/shared/llm-tools.ts';
import {
  buildTemplateReviewPrompt,
  parseReviewReport,
  TEMPLATE_REVIEW_DIMENSIONS,
} from '../../src/shared/review-report.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('review-template 单元测试');

// ====== 参数校验 ======
t('校验：合法 gen- id 通过（focus 可选）', () => {
  const r = validateReviewTemplateArgs({templateId: 'gen-abc123'});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.focus, undefined);
  const r2 = validateReviewTemplateArgs({templateId: 'gen-abc123', focus: '  竖屏适配  '});
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.args.focus, '竖屏适配');
});

t('校验：缺 templateId / 非 gen- id 拒绝', () => {
  assert.equal(validateReviewTemplateArgs({}).ok, false);
  assert.equal(validateReviewTemplateArgs({templateId: '  '}).ok, false);
  const r = validateReviewTemplateArgs({templateId: 'RevealSlide'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors[0].includes('gen-'));
  assert.equal(validateReviewTemplateArgs({templateId: 'custom-x'}).ok, false);
});

// ====== 提示词 ======
t('提示词：包含模板信息/帧说明/维度/JSON 要求', () => {
  const prompt = buildTemplateReviewPrompt({
    name: '暗底品牌卡',
    description: '暗底 + 生长条 + 逐字弹出',
    durationSec: 5,
    orientation: 'landscape',
    demoTitle: '暗底品牌卡',
    demoSubtitle: '暗底 + 生长条 + 逐字弹出',
    frames: [
      {timeSec: 0.8, note: '第 0.8s（入场动画完成后）'},
      {timeSec: 3.5, note: '第 3.5s（稳定段）'},
    ],
    focus: '文字层级',
  });
  assert.ok(prompt.includes('「暗底品牌卡」'));
  assert.ok(prompt.includes('暗底 + 生长条 + 逐字弹出'));
  assert.ok(prompt.includes('第 0.8s（入场动画完成后）'));
  assert.ok(prompt.includes('第 3.5s（稳定段）'));
  assert.ok(prompt.includes('竖屏') === false); // landscape 不显示竖屏
  assert.ok(prompt.includes('横屏'));
  for (const d of TEMPLATE_REVIEW_DIMENSIONS) assert.ok(prompt.includes(d.key), d.key);
  assert.ok(prompt.includes('只输出一个 JSON 对象'));
  assert.ok(prompt.includes('文字层级')); // focus 行
});

// ====== 报告解析（自定义维度）======
t('解析：TEMPLATE_REVIEW_DIMENSIONS 的分数键被正确拾取', () => {
  const modelText = JSON.stringify({
    scores: {readability: 4, layout: 3, brandFit: 5, motion: 4, polish: 3},
    overall: 4,
    issues: [
      {dimension: 'layout', severity: 'high', problem: '标题贴边', suggestion: 'padding 加到 120px'},
      {dimension: 'polish', severity: 'low', problem: '阴影生硬', suggestion: '用 VIDEO_DESIGN.shadow'},
    ],
    summary: '整体可用，布局需调整',
    verdict: 'pass',
  });
  const r = parseReviewReport(modelText, TEMPLATE_REVIEW_DIMENSIONS);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.report.scores.layout, 3);
    assert.equal(r.report.scores.brandFit, 5);
    assert.equal(r.report.overall, 4);
    assert.equal(r.report.verdict, 'pass');
    assert.equal(r.report.issues.length, 2);
    assert.equal(r.report.issues[0].problem, '标题贴边');
  }
});

t('解析：markdown 围栏 + 缺维度回退 + verdict 推导', () => {
  const modelText = '好的，以下是评审结果：\n```json\n' + JSON.stringify({
    scores: {readability: 2},
    issues: [],
    summary: '文字太小',
  }) + '\n```';
  const r = parseReviewReport(modelText, TEMPLATE_REVIEW_DIMENSIONS);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.report.scores.readability, 2);
    assert.equal(r.report.overall, 2); // 由唯一维度分数推导
    assert.equal(r.report.verdict, 'rework'); // <3 → rework
  }
});

t('解析：非 JSON 输出返回 raw 不阻断', () => {
  const r = parseReviewReport('这个模板看起来还行，但我说不出 JSON', TEMPLATE_REVIEW_DIMENSIONS);
  assert.equal(r.ok, false);
});

console.log(`\n${passed} 项通过`);
if ((process.exitCode ?? 0) !== 0) process.exit(process.exitCode);
