/**
 * 模板叙事槽位（template-slots）——模板库扩容后的 LLM 分层检索
 *
 * 背景（RESEARCH-AI-EDITING.md 三）：模板清单过去全量拼进系统提示词（promo 体裁 31 条
 * / 5.7k 字符，占系统提示词 31%）+ get_templates 再返回一遍 JSON，模板扩量后会直接
 * 拖垮 LLM 的选择质量。改为槽位制：
 *   - 系统提示词只放「槽位地图」：每个叙事槽位列 2-3 个首推模板（buildSlotMapText）；
 *   - get_templates 支持 slot 过滤，LLM 先选槽位再拉该槽位的完整候选（含参数规格）。
 *
 * 槽位标注在 template-registry.ts 各模板 meta 的 slots 字段（首个为主槽位）；
 * 自定义/市场模板无标注，视为未分槽，只在无 slot 过滤的全量清单出现。
 */

import type {TemplateMeta, TemplateSlot} from './types.ts';

/** 槽位顺序 = 叙事顺序（开场 → 展示/演绎 → 数据/背书 → 叙事 → 收尾） */
export const TEMPLATE_SLOTS: TemplateSlot[] = ['hook', 'showcase', 'media', 'data', 'proof', 'story', 'cta'];

export const TEMPLATE_SLOT_LABEL: Record<TemplateSlot, string> = {
  hook: '开场钩子',
  showcase: '产品展示',
  media: '素材演绎',
  data: '数据数字',
  proof: '信任背书',
  story: '流程叙事',
  cta: '结尾行动',
};

export const isTemplateSlot = (v: unknown): v is TemplateSlot =>
  typeof v === 'string' && (TEMPLATE_SLOTS as string[]).includes(v);

/** 按槽位分组（保持输入顺序；一个模板跨槽位时在每组都出现；未分槽的不进任何组） */
export const buildSlotMap = (templates: TemplateMeta[]): Array<{slot: TemplateSlot; label: string; templates: TemplateMeta[]}> =>
  TEMPLATE_SLOTS
    .map((slot) => ({
      slot,
      label: TEMPLATE_SLOT_LABEL[slot],
      templates: templates.filter((t) => t.slots?.includes(slot)),
    }))
    .filter((g) => g.templates.length > 0);

/**
 * 系统提示词用的槽位地图文本：每槽位一行、只列前 perSlot 个首推（id「名称」）。
 * 目标体量 ~800 字符以内（对比旧全量清单 5.7k 字符）。
 */
export const buildSlotMapText = (templates: TemplateMeta[], perSlot = 3): string =>
  buildSlotMap(templates)
    .map((g) => `- ${g.label}（${g.slot}）：${g.templates.slice(0, perSlot).map((t) => `${t.id}「${t.name}」`).join('、')}${g.templates.length > perSlot ? ` 等 ${g.templates.length} 个` : ''}`)
    .join('\n');

/** 槽位过滤（get_templates 的 slot 参数）；未分槽模板在任何槽位过滤下都不可见 */
export const filterTemplatesBySlot = (templates: TemplateMeta[], slot: TemplateSlot): TemplateMeta[] =>
  templates.filter((t) => t.slots?.includes(slot));

/** 模板槽位标签串（流水线 prompt 行内标注用）：如「开场钩子/产品展示」；未分槽返回「」 */
export const slotLabelsOf = (t: TemplateMeta): string =>
  (t.slots ?? []).map((s) => TEMPLATE_SLOT_LABEL[s]).join('/');
