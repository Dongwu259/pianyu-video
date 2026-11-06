/**
 * 统一模板目录与轻量检索。
 *
 * 模板数量增长到数百个时，LLM 不应一次接收完整清单。调用方先确定体裁、
 * 叙事槽位、风格与画面动作，再用本模块返回少量稳定排序的候选。
 */
import type {TemplateAction, TemplateMeta, TemplateSlot, TemplateStyle} from './types.ts';
import type {VideoType} from './video-type.ts';
import {templateFitsVideoType} from './template-registry.ts';
import type {MarketCatalogEntryWithStatus} from './template-pack.ts';

export type {TemplateAction, TemplateStyle};

export const TEMPLATE_STYLES: TemplateStyle[] = [
  'minimal', 'cinematic', 'editorial', 'tech', 'warm', 'bold', 'playful', 'documentary',
];
export const TEMPLATE_ACTIONS: TemplateAction[] = [
  'static', 'reveal', 'slide', 'zoom', 'pan', 'split', 'compare', 'list', 'count',
  'timeline', 'type', 'cursor', 'montage',
];
export const isTemplateStyle = (value: unknown): value is TemplateStyle =>
  typeof value === 'string' && (TEMPLATE_STYLES as string[]).includes(value);
export const isTemplateAction = (value: unknown): value is TemplateAction =>
  typeof value === 'string' && (TEMPLATE_ACTIONS as string[]).includes(value);

export interface TemplateSearchQuery {
  videoType?: VideoType;
  slot?: TemplateSlot;
  style?: TemplateStyle;
  action?: TemplateAction;
  query?: string;
  needsMedia?: boolean;
  limit?: number;
}

export interface TemplateSearchResult {
  templates: TemplateMeta[];
  total: number;
  facets: {
    styles: TemplateStyle[];
    actions: TemplateAction[];
    slots: TemplateSlot[];
  };
}

/** 远程市场目录的轻量检索条件。远程目录只提供元数据，不参与本地渲染。 */
export interface OnlineTemplateSearchQuery {
  style?: TemplateStyle;
  action?: TemplateAction;
  slot?: TemplateSlot;
  query?: string;
}

type Taxonomy = {styles: TemplateStyle[]; actions: TemplateAction[]; searchTags: string[]};

/** 旧模板没有显式分类时的兼容映射；新模板可直接在 TemplateMeta 上覆盖。 */
export const BUILTIN_TEMPLATE_TAXONOMY: Record<string, Taxonomy> = {
  RevealSlide: {styles: ['cinematic', 'editorial'], actions: ['reveal', 'slide'], searchTags: ['片头', '展示', '揭示']},
  StackCards: {styles: ['editorial', 'playful'], actions: ['reveal', 'montage'], searchTags: ['卡片', '多素材']},
  CinematicPan: {styles: ['cinematic', 'documentary'], actions: ['pan', 'zoom'], searchTags: ['电影', '运镜', '氛围']},
  SplitShowcase: {styles: ['editorial', 'tech'], actions: ['split', 'reveal'], searchTags: ['产品展示', '功能', '分屏']},
  MinimalFloat: {styles: ['minimal', 'cinematic'], actions: ['static', 'pan'], searchTags: ['极简', '悬浮']},
  KenBurns: {styles: ['documentary', 'cinematic'], actions: ['pan', 'zoom'], searchTags: ['照片', '慢推', '纪录']},
  CursorFollow: {styles: ['tech'], actions: ['cursor', 'zoom'], searchTags: ['录屏', '鼠标', '操作']},
  DeviceShowcase: {styles: ['tech', 'cinematic'], actions: ['reveal', 'zoom'], searchTags: ['设备', '手机', '软件展示']},
  GridMosaic: {styles: ['editorial', 'playful'], actions: ['montage', 'reveal'], searchTags: ['网格', '照片墙', '多图']},
  VerticalScroll: {styles: ['editorial', 'minimal'], actions: ['slide', 'list'], searchTags: ['滚动', '长图', '列表']},
  SplitCompare: {styles: ['editorial', 'tech'], actions: ['split', 'compare'], searchTags: ['对比', '前后', '分屏']},
  NeonTech: {styles: ['tech', 'bold'], actions: ['reveal', 'zoom'], searchTags: ['科技', '霓虹', '数字']},
  TextSlide: {styles: ['minimal', 'editorial'], actions: ['slide', 'list'], searchTags: ['文字', '要点', '说明']},
  VideoCut: {styles: ['minimal', 'documentary'], actions: ['static', 'zoom', 'montage'], searchTags: ['全屏', '素材', '快切', 'vlog', '口播']},
  ScreenRecord: {styles: ['minimal', 'tech'], actions: ['static'], searchTags: ['录屏', '原片']},
  LowerThird: {styles: ['editorial', 'minimal'], actions: ['slide', 'reveal'], searchTags: ['字幕条', '人物介绍']},
  StatCounter: {styles: ['tech', 'bold'], actions: ['count', 'reveal'], searchTags: ['数据', '数字', '指标']},
  Testimonial: {styles: ['editorial', 'warm'], actions: ['reveal', 'list'], searchTags: ['口碑', '证言', '客户']},
  FeatureList: {styles: ['editorial', 'tech'], actions: ['list', 'reveal'], searchTags: ['功能', '清单', '要点']},
  KineticType: {styles: ['bold'], actions: ['type', 'reveal'], searchTags: ['钩子', '大字', '节拍', '标题']},
  TimelineRoadmap: {styles: ['editorial', 'tech'], actions: ['timeline', 'reveal'], searchTags: ['流程', '时间线', '路线图']},
  PricingTiers: {styles: ['editorial', 'tech'], actions: ['list', 'compare'], searchTags: ['价格', '套餐', '档位']},
  ComingSoon: {styles: ['bold', 'cinematic'], actions: ['count', 'reveal'], searchTags: ['预告', '新品', '日期']},
  LogoCloud: {styles: ['editorial', 'minimal'], actions: ['montage', 'reveal'], searchTags: ['客户', 'logo', '社会证明']},
  UICallout: {styles: ['tech'], actions: ['cursor', 'zoom'], searchTags: ['界面', '标注', '重点区域']},
  BeforeAfter: {styles: ['editorial', 'tech'], actions: ['compare', 'reveal'], searchTags: ['前后对比', '效果', '改造']},
  CodeTerminal: {styles: ['tech', 'minimal'], actions: ['type', 'reveal'], searchTags: ['代码', '开发者', '终端']},
  GlobePoints: {styles: ['tech', 'cinematic'], actions: ['count', 'reveal'], searchTags: ['全球', '地图', '规模']},
  CardConverge: {styles: ['bold', 'playful'], actions: ['montage', 'reveal'], searchTags: ['卡片汇聚', '蒙太奇', '卡点']},
  BrandIntro: {styles: ['cinematic', 'tech'], actions: ['reveal'], searchTags: ['品牌片头', 'logo', '开场']},
  OutroCTA: {styles: ['cinematic', 'tech'], actions: ['reveal'], searchTags: ['结尾', 'cta', '二维码', '行动号召']},
  VlogStamp: {styles: ['warm', 'documentary'], actions: ['reveal', 'type'], searchTags: ['vlog', '日期', '地点', '旅行']},
  VlogPolaroid: {styles: ['warm', 'playful'], actions: ['montage', 'reveal'], searchTags: ['照片', '拍立得', '旅行']},
  TalkingPoint: {styles: ['editorial', 'bold'], actions: ['list', 'reveal'], searchTags: ['口播', '观点', '出镜']},
  StepCard: {styles: ['tech', 'editorial'], actions: ['list', 'reveal'], searchTags: ['教程', '步骤', '操作']},
  GrowthBars3D: {styles: ['tech', 'bold'], actions: ['count', 'reveal'], searchTags: ['柱状图', '数据', '增长', '报表', '3d']},
  TrendLine3D: {styles: ['tech', 'cinematic'], actions: ['count', 'reveal'], searchTags: ['折线', '趋势', '曲线', '数据', '3d']},
  CameraJourney3D: {styles: ['tech', 'cinematic'], actions: ['pan', 'zoom', 'reveal'], searchTags: ['旅程', '路径', '蜿蜒', '巡览', '一镜到底', '换景', '3d']},
  GalleryHall3D: {styles: ['cinematic', 'editorial'], actions: ['pan', 'reveal'], searchTags: ['艺廊', '美术馆', '长廊', '展厅', '射灯', '一镜到底', '换景', '3d']},
  OrbitCarousel3D: {styles: ['tech', 'bold'], actions: ['pan', 'zoom', 'reveal'], searchTags: ['环绕', '旋转', '展台', '圆环', '光柱', '换景', '3d']},
  TimeTunnel3D: {styles: ['tech', 'cinematic'], actions: ['zoom', 'reveal'], searchTags: ['隧道', '穿越', '门框', '穿越', '纵深', '一镜到底', '换景', '3d']},
  CityScape3D: {styles: ['cinematic', 'bold'], actions: ['pan', 'reveal'], searchTags: ['城市', '夜景', '天际线', '霓虹', '街头', '一镜到底', '换景', '3d']},
  SpiralAtrium3D: {styles: ['cinematic', 'editorial'], actions: ['pan', 'zoom', 'reveal'], searchTags: ['中庭', '螺旋', '旋转楼梯', '盘旋', '上升', '换景', '3d']},
  Starfield3D: {styles: ['tech', 'cinematic'], actions: ['pan', 'reveal'], searchTags: ['星空', '宇宙', '深空', '星图', '科幻', '空间站', '换景', '3d']},
  Hero3DTitle: {styles: ['bold', 'cinematic'], actions: ['reveal'], searchTags: ['标题', '片头', '立体字', '挤出', '发布会', '3d']},
  DeviceShowcase3D: {styles: ['tech', 'bold'], actions: ['zoom', 'reveal'], searchTags: ['设备', '手机', '笔记本', '录屏', '发布会', '3d']},
  ModelTurntable: {styles: ['tech', 'bold'], actions: ['pan', 'zoom'], searchTags: ['模型', '转盘', '360', 'glb', '产品', '3d']},
};

const STYLE_HINTS: Array<[TemplateStyle, string[]]> = [
  ['minimal', ['minimal', '极简', 'clean']], ['cinematic', ['cinematic', '电影', 'cinema']],
  ['editorial', ['editorial', '杂志', '说明']], ['tech', ['tech', '科技', 'terminal', '代码']],
  ['warm', ['warm', '温暖', '手帐', '旅行']], ['bold', ['bold', '大胆', '节拍', 'kinetic']],
  ['playful', ['playful', '活泼', '卡片', 'polaroid']], ['documentary', ['documentary', '纪录', 'vlog', '真实']],
];
const ACTION_HINTS: Array<[TemplateAction, string[]]> = [
  ['static', ['static', '静态', '原片']], ['reveal', ['reveal', '揭示', '展示', '入场']],
  ['slide', ['slide', '滑入', '滚动']], ['zoom', ['zoom', '推近', '放大']], ['pan', ['pan', '平移', '运镜']],
  ['split', ['split', '分屏']], ['compare', ['compare', '对比', '前后']], ['list', ['list', '列表', '清单', '步骤']],
  ['count', ['count', '计数', '数据', '数字']], ['timeline', ['timeline', '时间线', '路线']],
  ['type', ['type', '文字', '打字', '代码']], ['cursor', ['cursor', '鼠标', '界面', '标注']],
  ['montage', ['montage', '蒙太奇', '快切', '合集', '照片']],
];

const uniq = <T,>(items: T[]): T[] => [...new Set(items)];

export const enrichTemplateMeta = (template: TemplateMeta): TemplateMeta => {
  const tax = BUILTIN_TEMPLATE_TAXONOMY[template.id];
  const text = [template.id, template.name, template.description, ...(template.searchTags ?? [])].join(' ').toLocaleLowerCase();
  const inferred: Taxonomy = {
    styles: STYLE_HINTS.filter(([, words]) => words.some((w) => text.includes(w))).map(([style]) => style),
    actions: ACTION_HINTS.filter(([, words]) => words.some((w) => text.includes(w))).map(([action]) => action),
    searchTags: [],
  };
  if (!tax && inferred.styles.length === 0 && inferred.actions.length === 0) return template;
  const source = tax ?? inferred;
  return {
    ...template,
    styles: template.styles?.length ? template.styles : source.styles,
    actions: template.actions?.length ? template.actions : source.actions,
    searchTags: uniq([...(template.searchTags ?? []), ...source.searchTags]),
  };
};

const tokensOf = (value: string): string[] => {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.split(/[\s,，。！？；：:、/|()[\]{}]+/).filter(Boolean);
  // 中文没有空格，保留单字 token 让“数据/教程”等短查询也能命中。
  const chars = [...normalized].filter((c) => /[\u3400-\u9fff]/.test(c));
  return uniq([...words, ...chars]);
};

const queryTokens = (query: string | undefined): string[] => {
  if (!query?.trim()) return [];
  const raw = query.trim().toLocaleLowerCase();
  return uniq([raw, ...tokensOf(raw)]);
};

/**
 * 对在线市场目录做确定性、上下文友好的排序。
 *
 * 市场目录的 tags 由服务端维护，通常包含风格/动作/槽位词；这里不假设
 * 它一定已经安装，因此结果保留 installedVersion/hasUpdate 状态供调用方展示。
 */
export const rankOnlineTemplateCatalog = (
  entries: MarketCatalogEntryWithStatus[],
  query: OnlineTemplateSearchQuery = {},
  limit = 8,
): MarketCatalogEntryWithStatus[] => {
  const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const terms = uniq([
    // Single Chinese characters are useful for local fuzzy search but too
    // noisy for a remote ranking (almost every title would match one).
    ...(queryTokens(query.query).filter((term) => term.length > 1)),
    ...(query.style ? [query.style] : []),
    ...(query.action ? [query.action] : []),
    ...(query.slot ? [query.slot] : []),
  ]);
  const scored = entries.map((entry, index) => {
    const haystack = [entry.id, entry.name, entry.description, ...(entry.tags ?? [])]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += term.length > 1 ? 3 : 1;
    }
    return {entry, score, index};
  });
  return scored
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, boundedLimit)
    .map((item) => item.entry);
};

const mediaScore = (template: TemplateMeta, needsMedia: boolean | undefined): number => {
  if (needsMedia === undefined) return 0;
  const hasMedia = template.minVideos > 0;
  return hasMedia === needsMedia ? 3 : -1;
};

/** 打分与排序（search/browse 共用）：模板数组顺序作为最终 tie-break。 */
const scoreTemplates = (
  templates: TemplateMeta[],
  query: TemplateSearchQuery,
): {total: number; facets: TemplateSearchResult['facets']; scored: Array<{template: TemplateMeta; score: number}>} => {
  const enriched = templates.map(enrichTemplateMeta);
  const filtered = enriched.filter((t) => {
    if (query.videoType && !templateFitsVideoType(t, query.videoType)) return false;
    if (query.slot && !(t.slots ?? []).includes(query.slot)) return false;
    return true;
  });
  const qTokens = queryTokens(query.query);
  const scored = filtered.map((template, index) => {
    const styles = template.styles ?? [];
    const actions = template.actions ?? [];
    const text = [template.id, template.name, template.description, ...(template.searchTags ?? [])].join(' ').toLocaleLowerCase();
    const textTokens = new Set(tokensOf(text));
    let score = 0;
    if (query.style) score += styles.includes(query.style) ? 8 : -2;
    if (query.action) score += actions.includes(query.action) ? 8 : -2;
    score += mediaScore(template, query.needsMedia);
    for (const token of qTokens) {
      if (text.includes(token)) score += token.length > 1 ? 4 : 1;
      else if (textTokens.has(token)) score += 2;
    }
    return {template, score, index};
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const facetStyles = uniq(filtered.flatMap((t) => t.styles ?? []));
  const facetActions = uniq(filtered.flatMap((t) => t.actions ?? []));
  const facetSlots = uniq(filtered.flatMap((t) => t.slots ?? []));
  return {
    total: filtered.length,
    facets: {styles: facetStyles, actions: facetActions, slots: facetSlots},
    scored: scored.map(({template, score}) => ({template, score})),
  };
};

/** 对模板打分并返回稳定、有限的候选（limit 1-20，默认 8）；模板数组顺序作为最终 tie-break。 */
export const searchTemplateCatalog = (
  templates: TemplateMeta[],
  query: TemplateSearchQuery = {},
): TemplateSearchResult => {
  const limit = Math.max(1, Math.min(20, Math.floor(query.limit ?? 8)));
  const {scored, ...rest} = scoreTemplates(templates, query);
  return {...rest, templates: scored.slice(0, limit).map((x) => x.template)};
};

/**
 * 浏览用检索（模板选择器弹窗网格）：与 searchTemplateCatalog 同打分/分词，但
 *  - 默认不截断——浏览场景要看到全量候选；query.limit 传了才截（不限 20 上限）；
 *  - 有关键词时只返回有命中的模板（score > 0），零分模板不进网格。
 */
/**
 * 3D 模板判定（选择器「3D」分类筛选用）：id 以 3D 结尾的 + 两个不以 3D 结尾的早期 3D 模板。
 * 覆盖 3D 场景族（旅程/艺廊/环台/隧道/城市/中庭/星域）、3D 三件套与 3D 数据可视化。
 */
export const IS_3D_EXTRA_IDS = new Set(['Hero3DTitle', 'ModelTurntable']);
export const is3DTemplate = (id: string): boolean => id.endsWith('3D') || IS_3D_EXTRA_IDS.has(id);

export const browseTemplateCatalog = (
  templates: TemplateMeta[],
  query: TemplateSearchQuery = {},
): TemplateSearchResult => {
  const limit = query.limit === undefined ? undefined : Math.max(1, Math.floor(query.limit));
  const {scored, ...rest} = scoreTemplates(templates, query);
  const hits = queryTokens(query.query).length > 0 ? scored.filter((x) => x.score > 0) : scored;
  const list = limit === undefined ? hits : hits.slice(0, limit);
  return {...rest, templates: list.map((x) => x.template)};
};
