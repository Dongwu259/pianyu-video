/**
 * 模板市场场景筛选 - 标签聚合/过滤 + 行业分组纯函数
 *
 * 从市场目录条目的 tags 聚合出筛选 chips：去重、按出现次数降序
 * （次数相同按标签名排序，保证结果稳定），取前 max 个避免 chips 过多。
 * 行业词（shared/industries.ts 词表）不进 chips——行业由行业筛选行/分组标题承担。
 * 抽成纯函数便于单测（tests/unit/market-tags.test.ts、tests/unit/industries.test.ts）。
 */

import {INDUSTRIES, getIndustry, isIndustryTag, type Industry} from '../../shared/industries.ts';

/** 行业分组/筛选行的展示顺序：具体行业在前（词表顺序），「通用」垫底 */
export const INDUSTRY_DISPLAY_ORDER: Industry[] = [...INDUSTRIES.slice(1), INDUSTRIES[0]];

/** 聚合目录中的标签：出现次数降序（同次数按标签名），最多 max 个；行业词不进 chips */
export const aggregateMarketTags = (
  entries: {tags?: string[]}[],
  max = 8,
): string[] => {
  const count = new Map<string, number>();
  for (const e of entries) {
    for (const tag of e.tags ?? []) {
      if (isIndustryTag(tag)) continue;
      count.set(tag, (count.get(tag) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, max)
    .map(([tag]) => tag);
};

/** 按选中标签过滤目录；activeTag 为 null（「全部」）时原样返回 */
export const filterEntriesByTag = <T extends {tags?: string[]}>(
  entries: T[],
  activeTag: string | null,
): T[] => (activeTag === null ? entries : entries.filter((e) => (e.tags ?? []).includes(activeTag)));

/** 按行业过滤目录；industry 为 null（「全部」）时原样返回 */
export const filterEntriesByIndustry = <T extends {tags?: string[]}>(
  entries: T[],
  industry: Industry | null,
): T[] => (industry === null ? entries : entries.filter((e) => getIndustry(e.tags) === industry));

export interface IndustryGroup<T> {
  industry: Industry;
  entries: T[];
}

/**
 * 按行业分组（「全部」视图用）：组顺序按 INDUSTRY_DISPLAY_ORDER，
 * 空组跳过；组内保持原目录顺序。条目顺序不变，仅按行业归类。
 */
export const groupEntriesByIndustry = <T extends {tags?: string[]}>(
  entries: T[],
): IndustryGroup<T>[] => {
  const byIndustry = new Map<Industry, T[]>();
  for (const e of entries) {
    const ind = getIndustry(e.tags);
    const list = byIndustry.get(ind);
    if (list) list.push(e);
    else byIndustry.set(ind, [e]);
  }
  return INDUSTRY_DISPLAY_ORDER
    .filter((ind) => byIndustry.has(ind))
    .map((ind) => ({industry: ind, entries: byIndustry.get(ind) as T[]}));
};
