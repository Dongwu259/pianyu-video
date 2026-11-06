/**
 * 模板市场场景筛选（src/renderer/components/market-tags.ts）单元测试
 *
 * 覆盖：tags 聚合（行业词剔除、去重、次数降序、同次数稳定排序、top-N 截断、空目录）
 * 与按标签过滤（null = 全部、无命中返回空）。行业分组另见 tests/unit/industries.test.ts。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/market-tags.test.ts
 */

import assert from 'node:assert/strict';
import {aggregateMarketTags, filterEntriesByTag} from '../../src/renderer/components/market-tags.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const e = (id: string, tags?: string[]) => ({id, tags});

// ====== 1. 聚合 ======

console.log('aggregateMarketTags:');
{
  const tags = aggregateMarketTags([
    e('a', ['电商', '促销']),
    e('b', ['电商', '深色']),
    e('c', ['深色']),
    e('d', ['深色']),
    e('x'), // 无 tags 字段
    e('y', []), // 空 tags
  ]);
  // 「电商」是行业词（industries.ts 词表），不进场景 chips——行业筛选由行业行/分组标题承担
  assert.deepEqual(tags, ['深色', '促销'], '行业词剔除 + 去重 + 次数降序；缺省/空 tags 忽略');
  ok('行业词不进 chips，其余标签去重并按出现次数降序');

  const tie = aggregateMarketTags([e('a', ['b', 'a']), e('b', ['c'])]);
  assert.deepEqual(tie, ['a', 'b', 'c'], '次数相同按标签名排序（稳定）');
  ok('同次数排序稳定');

  const many = aggregateMarketTags(
    [e('a', ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'])],
    8,
  );
  assert.equal(many.length, 8, '最多返回 max 个');
  ok('top-N 截断（默认 8 个）');

  assert.deepEqual(aggregateMarketTags([]), [], '空目录 → 空 chips');
  ok('空目录返回空数组');
}

// ====== 2. 过滤 ======

console.log('filterEntriesByTag:');
{
  const list = [e('a', ['电商']), e('b', ['教育']), e('c')];
  assert.deepEqual(filterEntriesByTag(list, null), list, 'null = 全部（原样返回）');
  ok('「全部」不过滤');

  assert.deepEqual(filterEntriesByTag(list, '电商').map((x) => x.id), ['a']);
  ok('按标签过滤');

  assert.deepEqual(filterEntriesByTag(list, '美食'), [], '无命中 → 空列表（UI 显示「该分类暂无模板」）');
  ok('无命中返回空列表');
}

console.log(`\n全部通过（${passed} 项）`);
