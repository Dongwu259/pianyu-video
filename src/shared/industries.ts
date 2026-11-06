/**
 * 市场模板行业词表 - 受控行业分类
 *
 * 约定（不往 validateTemplatePack 加硬校验，避免破坏旧包/用户导入的包）：
 * - 官方市场模板（scripts/make-market-templates.mjs 生成）tags 恰好含一个词表
 *   行业词，且放在 tags 首位；
 * - UI 侧容错处理：tags 缺失/不含行业词时一律归入「通用」。
 */

/** 受控行业词表（市场模板分类用） */
export const INDUSTRIES = ['通用', '科技', '电商', '教育', '美食', '旅行'] as const;

export type Industry = (typeof INDUSTRIES)[number];

const INDUSTRY_SET: ReadonlySet<string> = new Set(INDUSTRIES);

/** 判断标签是否为行业词（chips 聚合时过滤行业词用，避免与行业行重复） */
export const isIndustryTag = (tag: string): tag is Industry => INDUSTRY_SET.has(tag);

/**
 * 由 tags 推导行业：取 tags 中第一个命中词表的值，无命中（含 tags 缺失）返回「通用」。
 */
export const getIndustry = (tags?: string[]): Industry => {
  for (const tag of tags ?? []) {
    if (isIndustryTag(tag)) return tag;
  }
  return '通用';
};
