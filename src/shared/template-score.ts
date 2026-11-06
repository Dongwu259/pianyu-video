/**
 * template-score.ts — 模板选型打分（v1，纯函数；**尚未接线**）
 *
 * 背景：模板数会随移植增长（65 → 75+），单纯靠 description 让模型自己比会越来越难。
 * 打分把「体裁策展位 + 素材数量 + 叙事槽位 + 画幅适配 + 已知缺陷」合成一个可比数值，
 * 由 get_templates / search_templates 用它做**软排序**（把候选压到 3-5 个再交给模型），
 * 而不是硬过滤（硬过滤会误杀组合用法，口径同 P0-2）。
 *
 * 纪律：
 * - 纯函数、零 IO、零随机——同一输入恒定同一顺序，保证数据/bench 可比；
 * - 不新增工具、不改 schema；接线只是改变 get_templates 的返回顺序与一条 note；
 * - 接线时机必须排在 v9 bench 判决之后（返回顺序属训练分布，见 docs/shotcraft-knowledge.md §四）。
 *
 * 信号来源（全部是既有数据，无需新作者）：
 * 1. GENRE_RECOMMENDED_IDS 的**数组顺序**＝体裁策展优先级（产品线已人工策展）；
 * 2. TemplateMeta.minVideos / maxVideos —— 与段内实际素材数比对；
 * 3. TemplateMeta.slots —— 与调用方给的叙事槽位比对；
 * 4. TemplateMeta.supportsPortrait / portraitParams —— 竖屏可用性与已调参标记；
 * 5. 已知画幅缺陷表（来自模板第二梯队四画幅验收的 P2/P3 记档）。
 *
 * 能量档（energy）与时长建议留到 v2：需要新作者元数据，且 EDGE 返回体量有限。
 */
import {GENRE_RECOMMENDED_IDS} from './template-registry.ts';
import type {TemplateMeta} from './types.ts';
import type {VideoType} from './video-type.ts';
import type {TemplateSlot} from './types.ts';

/** 画幅三分类（与验收口径一致：16:9≈1.78 属 wide 之外的中性档） */
export type AspectClass = 'portrait' | 'square' | 'wide' | 'landscape';

/** 已知画幅缺陷（P2/P3 记档）：只在对应画幅下扣分，不影响其它画幅 */
const ASPECT_RISKS: {ids: string[]; when: AspectClass; penalty: number; note: string}[] = [
  {ids: ['StepCard'], when: 'square', penalty: 12, note: '1:1 无素材形态文字块偏左'},
  {ids: ['StepCard'], when: 'portrait', penalty: 10, note: '9:16 无素材形态偏侧'},
  {ids: ['TextSlide'], when: 'wide', penalty: 10, note: '21:9 超宽版式稀疏'},
  {ids: ['CityScape3D'], when: 'portrait', penalty: 6, note: '竖屏个别展板短暂出画'},
];

const W_GENRE_TOP = 30; // 策展位第 1 名的基础分
const W_GENRE_STEP = 3; // 每后退一位扣减
const W_OFF_GENRE = 6; // 体裁可用但不在策展名单
const W_MEDIA_MATCH = 12;
const W_MEDIA_SHORT = -40; // 素材数不足 = 硬伤，重罚（但仍排序，不硬过滤）
const W_MEDIA_OVER = -10;
const W_SLOT_MATCH = 10;
const W_SLOT_MISS = -4;
const W_NO_PORTRAIT = -25;
const W_PORTRAIT_TUNED = 2;

export interface TemplateScoreInput {
  template: Pick<TemplateMeta, 'id' | 'slots' | 'minVideos' | 'maxVideos' | 'supportsPortrait' | 'portraitParams'>;
  videoType: VideoType;
  /** 段内实际素材数（不给 = 不参与打分） */
  mediaCount?: number;
  /** 目标叙事槽位（不给 = 不参与打分） */
  slot?: TemplateSlot;
  /** 画幅比 = 宽/高（16:9≈1.78；不给 = 不做画幅扣分） */
  aspect?: number;
}

export interface TemplateScoreResult {
  score: number;
  /** 排序用的稳定键：策展位次（不在名单 = 大数） */
  genreRank: number;
  /** 人类可读的打分依据（供 get_templates 的 note 与教师示范引用） */
  reasons: string[];
}

export const classifyAspect = (aspect: number): AspectClass => {
  if (!Number.isFinite(aspect) || aspect <= 0) return 'landscape';
  if (aspect < 0.95) return 'portrait';
  if (aspect <= 1.05) return 'square';
  if (aspect >= 2.0) return 'wide';
  return 'landscape';
};

const genreRankOf = (id: string, videoType: VideoType): number => {
  const list = GENRE_RECOMMENDED_IDS[videoType] ?? [];
  const i = list.indexOf(id);
  return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
};

export function scoreTemplate(input: TemplateScoreInput): TemplateScoreResult {
  const {template, videoType, mediaCount, slot, aspect} = input;
  const reasons: string[] = [];
  let score = 0;

  const rank = genreRankOf(template.id, videoType);
  if (rank === Number.MAX_SAFE_INTEGER) {
    score += W_OFF_GENRE;
    reasons.push('体裁可用但不在策展位');
  } else {
    score += Math.max(0, W_GENRE_TOP - rank * W_GENRE_STEP);
    reasons.push(`体裁策展第 ${rank + 1} 位`);
  }

  if (mediaCount !== undefined) {
    if (mediaCount < template.minVideos) {
      score += W_MEDIA_SHORT;
      reasons.push(`需 ≥${template.minVideos} 段素材，当前 ${mediaCount}`);
    } else if (mediaCount > template.maxVideos) {
      score += W_MEDIA_OVER;
      reasons.push(`最多 ${template.maxVideos} 段素材，当前 ${mediaCount}`);
    } else {
      score += W_MEDIA_MATCH;
      reasons.push('素材数量匹配');
    }
  }

  if (slot) {
    const slots = template.slots ?? [];
    if (slots.includes(slot)) {
      score += W_SLOT_MATCH;
      reasons.push(`槽位匹配「${slot}」`);
    } else if (slots.length > 0) {
      score += W_SLOT_MISS;
      reasons.push(`槽位不符（该模板属 ${slots.join('/')}）`);
    }
  }

  const cls = aspect !== undefined ? classifyAspect(aspect) : null;
  if (cls) {
    if (cls === 'portrait') {
      if (!template.supportsPortrait) {
        score += W_NO_PORTRAIT;
        reasons.push('不支持竖屏');
      } else if (template.portraitParams) {
        score += W_PORTRAIT_TUNED;
        reasons.push('竖屏参数已验收');
      }
    }
    for (const risk of ASPECT_RISKS) {
      if (risk.when === cls && risk.ids.includes(template.id)) {
        score -= risk.penalty;
        reasons.push(`${risk.note}（-${risk.penalty}）`);
      }
    }
  }

  return {score, genreRank: rank, reasons};
}

/**
 * 批量排序：分数降序 → 策展位次升序 → id 字典序（保证同分稳定）。
 * 返回新数组，不改入参。
 */
export function rankTemplates<T extends TemplateScoreInput['template']>(
  templates: T[],
  base: Omit<TemplateScoreInput, 'template'>,
): {template: T; score: number; reasons: string[]}[] {
  return templates
    .map((template) => {
      const r = scoreTemplate({...base, template});
      return {template, score: r.score, reasons: r.reasons, genreRank: r.genreRank};
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.genreRank !== b.genreRank) return a.genreRank - b.genreRank;
      return a.template.id < b.template.id ? -1 : a.template.id > b.template.id ? 1 : 0;
    })
    .map(({template, score, reasons}) => ({template, score, reasons}));
}
