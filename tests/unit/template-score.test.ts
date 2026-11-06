/**
 * template-score.ts 单测：模板选型打分（v1 纯函数）
 * 纪律锚点：同输入恒定同顺序（数据/bench 可比）；只软排序不硬过滤。
 */
import assert from 'node:assert/strict';
import {scoreTemplate, rankTemplates, classifyAspect} from '../../src/shared/template-score.ts';
import {GENRE_RECOMMENDED_IDS} from '../../src/shared/template-registry.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const tpl = (id: string, over: Partial<Parameters<typeof scoreTemplate>[0]['template']> = {}) => ({
  id,
  slots: ['showcase'] as never,
  minVideos: 1,
  maxVideos: 4,
  supportsPortrait: true,
  portraitParams: undefined,
  ...over,
});

// --- 1. 体裁策展位：越靠前分越高 ---
{
  const promo = GENRE_RECOMMENDED_IDS.promo;
  const first = scoreTemplate({template: tpl(promo[0]), videoType: 'promo'});
  const third = scoreTemplate({template: tpl(promo[2]), videoType: 'promo'});
  const off = scoreTemplate({template: tpl('__not_in_list__'), videoType: 'promo'});
  assert.ok(first.score > third.score, '策展第 1 名应高于第 3 名');
  assert.ok(third.score > off.score, '策展位应高于名单外');
  assert.equal(first.genreRank, 0);
  assert.equal(off.genreRank, Number.MAX_SAFE_INTEGER);
  ok('体裁策展位序 → 分数单调');
}

// --- 2. 素材数量：不足重罚，匹配加分 ---
{
  const enough = scoreTemplate({template: tpl('X', {minVideos: 2}), videoType: 'vlog', mediaCount: 2});
  const short = scoreTemplate({template: tpl('X', {minVideos: 2}), videoType: 'vlog', mediaCount: 1});
  const over = scoreTemplate({template: tpl('X', {maxVideos: 2}), videoType: 'vlog', mediaCount: 5});
  assert.ok(enough.score > over.score, '匹配应高于超量');
  assert.ok(over.score > short.score, '超量应高于不足（不足是硬伤）');
  assert.ok(short.reasons.some((r) => r.includes('需 ≥2')), '不足要给出理由');
  ok('素材数量匹配/超出/不足 三档');
}

// --- 3. 槽位匹配 ---
{
  const hit = scoreTemplate({template: tpl('X', {slots: ['hook'] as never}), videoType: 'promo', slot: 'hook'});
  const miss = scoreTemplate({template: tpl('X', {slots: ['data'] as never}), videoType: 'promo', slot: 'hook'});
  assert.ok(hit.score > miss.score, '槽位匹配应高于不匹配');
  ok('槽位匹配加减分');
}

// --- 4. 竖屏：不支持重罚，已调参微加分 ---
{
  const noPortrait = scoreTemplate({template: tpl('X', {supportsPortrait: false}), videoType: 'vlog', aspect: 9 / 16});
  const tuned = scoreTemplate({template: tpl('X', {portraitParams: {a: 1} as never}), videoType: 'vlog', aspect: 9 / 16});
  const plain = scoreTemplate({template: tpl('X'), videoType: 'vlog', aspect: 9 / 16});
  assert.ok(plain.score > noPortrait.score, '不支持竖屏应扣分');
  assert.ok(tuned.score > plain.score, '竖屏已调参应微加分');
  assert.ok(noPortrait.reasons.includes('不支持竖屏'));
  ok('竖屏可用性 / 已调参');
}

// --- 5. 已知画幅缺陷：StepCard 在 1:1 扣分 ---
{
  const square = scoreTemplate({template: tpl('StepCard'), videoType: 'tutorial', aspect: 1});
  const landscape = scoreTemplate({template: tpl('StepCard'), videoType: 'tutorial', aspect: 16 / 9});
  assert.ok(landscape.score > square.score, 'StepCard 1:1 应因已知偏侧扣分');
  assert.ok(square.reasons.some((r) => r.includes('偏左')));
  ok('已知画幅缺陷扣分');
}

// --- 6. 批次排序：稳定、分数降序 ---
{
  const list = [tpl('B'), tpl('A'), tpl('C')];
  const ranked = rankTemplates(list, {videoType: 'promo'});
  assert.equal(ranked.length, 3);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, '排序应分数降序');
  }
  const ids = ranked.map((r) => r.template.id).join(',');
  const again = rankTemplates(list, {videoType: 'promo'}).map((r) => r.template.id).join(',');
  assert.equal(ids, again, '同输入应恒定同顺序');
  ok('排序稳定且分数降序');
}

// --- 7. 画幅分类边界 ---
{
  assert.equal(classifyAspect(9 / 16), 'portrait');
  assert.equal(classifyAspect(1), 'square');
  assert.equal(classifyAspect(16 / 9), 'landscape');
  assert.equal(classifyAspect(21 / 9), 'wide');
  assert.equal(classifyAspect(NaN), 'landscape');
  ok('画幅分类边界');
}

console.log(`\ntemplate-score: ${passed} 组全过`);
