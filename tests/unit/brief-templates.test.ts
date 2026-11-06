/**
 * 官方提示词模板商店（三期后半）单测：模板结构合法性 + buildBrief 扩写行为。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/brief-templates.test.ts
 */
import assert from 'node:assert/strict';
import {BRIEF_TEMPLATES, getBriefTemplate} from '../../src/shared/brief-templates.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('brief-templates 单元测试');

t('模板清单：6 个场景、id 唯一、空位 key 唯一且 3-6 个', () => {
  assert.equal(BRIEF_TEMPLATES.length, 6);
  const ids = new Set(BRIEF_TEMPLATES.map((x) => x.id));
  assert.equal(ids.size, 6);
  for (const tpl of BRIEF_TEMPLATES) {
    assert.ok(tpl.blanks.length >= 3 && tpl.blanks.length <= 6, `${tpl.id} 空位数 ${tpl.blanks.length}`);
    const keys = new Set(tpl.blanks.map((b) => b.key));
    assert.equal(keys.size, tpl.blanks.length, `${tpl.id} 空位 key 重复`);
    assert.ok(tpl.name && tpl.desc && tpl.videoType, `${tpl.id} 缺展示字段`);
  }
});

t('buildBrief：产品发布模板填值后包含全部关键信息', () => {
  const tpl = getBriefTemplate('product-launch')!;
  const brief = tpl.buildBrief({
    product: '片语',
    tagline: 'AI 全自动宣传片制作器',
    points: '一句话成片,35+ 商业模板，AI 卡点剪辑、4K 导出', // 混合中英文逗号/顿号
    audience: '独立开发者',
    style: '深色科技感',
    duration: '60',
  });
  assert.ok(brief.includes('「片语」'));
  assert.ok(brief.includes('60 秒'));
  assert.ok(brief.includes('AI 全自动宣传片制作器'));
  // 卖点按中英文逗号/顿号拆分，4 个卖点都在
  for (const p of ['一句话成片', '35+ 商业模板', 'AI 卡点剪辑', '4K 导出']) assert.ok(brief.includes(p), p);
  assert.ok(brief.includes('独立开发者'));
  assert.ok(brief.includes('深色科技感'));
  // 结构/节奏/文案/执行四段齐全
  assert.ok(brief.includes('叙事结构'));
  assert.ok(brief.includes('节奏'));
  assert.ok(brief.includes('文案风格'));
  assert.ok(brief.includes('run_auto_pipeline'));
  // 卖点数体现在结构行
  assert.ok(brief.includes('4 个卖点各一段'));
});

t('buildBrief：空值回退与省略规则', () => {
  const tpl = getBriefTemplate('feature-update')!;
  const brief = tpl.buildBrief({product: '片语', feature: 'AI 卡点', before: '手动对拍', benefit: '3 分钟出片'});
  // duration 留空 → fallback 30
  assert.ok(brief.includes('30 秒'));
  // style 无 fallback → 该行省略（不留空标签）
  assert.ok(!brief.includes('视觉风格：'));
  // 标签行不出现空值
  assert.ok(!brief.includes('：\n'));
});

t('buildBrief：促销模板的执行收尾与合规提醒', () => {
  const tpl = getBriefTemplate('promo-sale')!;
  const brief = tpl.buildBrief({product: '会员', offer: '5 折', points: 'AI 成片,4K 导出'});
  assert.ok(brief.includes('5 折'));
  assert.ok(brief.includes('避免夸大虚假宣传用语'));
  assert.ok(brief.includes('review_render 审片'));
});

t('buildBrief：教程模板步骤序号连贯', () => {
  const tpl = getBriefTemplate('tutorial')!;
  const brief = tpl.buildBrief({product: '片语', topic: '快速上手', steps: '新建工程,上传录屏,渲染导出'});
  assert.ok(brief.includes('1) 新建工程'));
  assert.ok(brief.includes('3) 渲染导出'));
  assert.ok(brief.includes('3 步每步一段'));
  assert.ok(brief.includes('tutorial'));
});

t('getBriefTemplate：命中与未命中', () => {
  assert.equal(getBriefTemplate('brand-story')?.name, '品牌故事');
  assert.equal(getBriefTemplate('nope'), undefined);
});

console.log(`\n${passed} 项通过`);
if ((process.exitCode ?? 0) !== 0) process.exit(process.exitCode);
