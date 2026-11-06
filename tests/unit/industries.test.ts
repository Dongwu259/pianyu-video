/**
 * 行业词表（src/shared/industries.ts）与市场行业分组
 * （src/renderer/components/market-tags.ts 的行业部分）单元测试
 *
 * 覆盖：getIndustry 命中/兜底/多 tag 优先级、aggregateMarketTags 不再返回行业词、
 * groupEntriesByIndustry 分组顺序/空组跳过/组内稳定、filterEntriesByIndustry 过滤。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/industries.test.ts
 */

import assert from 'node:assert/strict';
import {INDUSTRIES, getIndustry, isIndustryTag} from '../../src/shared/industries.ts';
import {
  aggregateMarketTags,
  filterEntriesByIndustry,
  groupEntriesByIndustry,
  INDUSTRY_DISPLAY_ORDER,
} from '../../src/renderer/components/market-tags.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const e = (id: string, tags?: string[]) => ({id, tags});

// ====== 1. getIndustry ======

console.log('getIndustry:');
{
  assert.equal(getIndustry(['电商', '促销']), '电商', '首位命中行业词');
  ok('命中行业词');

  assert.equal(getIndustry(['促销']), '通用', '无行业词 → 通用');
  assert.equal(getIndustry([]), '通用', '空 tags → 通用');
  assert.equal(getIndustry(undefined), '通用', 'tags 缺失 → 通用（UI 容错）');
  ok('无命中/空/缺失一律兜底「通用」');

  assert.equal(getIndustry(['促销', '美食']), '美食', '行业词不在首位也能命中');
  assert.equal(getIndustry(['美食', '电商']), '美食', '多个行业词取第一个命中');
  ok('多 tag 时取第一个命中的行业词');
}

// ====== 2. isIndustryTag / 词表 ======

console.log('isIndustryTag / INDUSTRIES:');
{
  assert.deepEqual([...INDUSTRIES], ['通用', '科技', '电商', '教育', '美食', '旅行'], '词表固定 6 个行业');
  for (const ind of INDUSTRIES) assert.ok(isIndustryTag(ind));
  assert.ok(!isIndustryTag('促销'), '场景词不是行业词');
  ok('词表成员判定正确');
}

// ====== 3. aggregateMarketTags 不返回行业词 ======

console.log('aggregateMarketTags（行业词剔除）:');
{
  const tags = aggregateMarketTags([
    e('a', ['电商', '促销']),
    e('b', ['电商', '促销']),
    e('c', ['教育', '课程']),
    e('d', ['通用', '深色']),
  ]);
  assert.deepEqual(tags, ['促销', '课程', '深色'], '行业词（电商/教育/通用）全部剔除');
  for (const ind of INDUSTRIES) assert.ok(!tags.includes(ind), `chips 不含行业词「${ind}」`);
  ok('chips 不再出现行业词');
}

// ====== 4. groupEntriesByIndustry ======

console.log('groupEntriesByIndustry:');
{
  const list = [
    e('t1', ['科技', '发布']),
    e('s1', ['电商', '大促']),
    e('t2', ['科技', '深色']),
    e('x1', ['文字']),      // 无行业词 → 通用
    e('e1', ['教育', '课程']),
    e('x2'),                // tags 缺失 → 通用
  ];
  const groups = groupEntriesByIndustry(list);
  assert.deepEqual(
    groups.map((g) => g.industry),
    ['科技', '电商', '教育', '通用'],
    '组顺序 = 展示顺序（具体行业在前，通用垫底），空组跳过',
  );
  ok('组顺序与空组跳过');

  assert.deepEqual(groups[0].entries.map((x) => x.id), ['t1', 't2'], '组内保持原目录顺序');
  assert.deepEqual(groups[3].entries.map((x) => x.id), ['x1', 'x2'], '无行业词条目归入「通用」');
  ok('组内顺序稳定，兜底归「通用」');

  assert.deepEqual(groupEntriesByIndustry([]), [], '空目录 → 空分组');
  ok('空目录返回空数组');

  // 展示顺序覆盖全部 6 个行业且「通用」在最后
  assert.deepEqual(INDUSTRY_DISPLAY_ORDER, ['科技', '电商', '教育', '美食', '旅行', '通用']);
  ok('INDUSTRY_DISPLAY_ORDER 顺序固定');
}

// ====== 5. filterEntriesByIndustry ======

console.log('filterEntriesByIndustry:');
{
  const list = [e('a', ['电商']), e('b', ['教育']), e('c', ['文字'])];
  assert.deepEqual(filterEntriesByIndustry(list, null), list, 'null = 全部（原样返回）');
  ok('「全部」不过滤');

  assert.deepEqual(filterEntriesByIndustry(list, '电商').map((x) => x.id), ['a']);
  ok('按行业过滤');

  assert.deepEqual(filterEntriesByIndustry(list, '通用').map((x) => x.id), ['c'], '无行业词条目被「通用」筛中');
  ok('「通用」筛中无行业词条目');

  assert.deepEqual(filterEntriesByIndustry(list, '旅行'), [], '无命中 → 空列表');
  ok('无命中返回空列表');
}

console.log(`\n全部通过（${passed} 项）`);
