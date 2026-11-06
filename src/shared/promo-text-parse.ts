/**
 * 说服力场景模板的文案解析（纯函数，可单测）
 *
 * StatCounter / Testimonial / KineticType 等模板把结构化信息编码在现有 PromoText
 * 的自由文本字段里（title/subtitle/features），此处负责解析成强类型结构：
 * - 数据行「99.9% 服务可用率」→ {value, suffix, label}（数字滚动 + 标签）
 * - 高亮词「核心短语」→ 渲染分段（高亮盒替换引号本身）
 * - 证言行 [引言, "姓名，职位", 星级] → {quote, author, role, rating}
 *
 * 解析失败一律降级为「按原文展示」，绝不丢文案。
 */

/** StatCounter 的一条数据：数值 + 后缀单位 + 标签 */
export interface StatItem {
  /** 目标数值（已去掉千分位） */
  value: number;
  /** 小数位数（由原文决定：99.9 → 1 位） */
  decimals: number;
  /** 数值后缀单位（% / 万+ / x / 倍 / K…，可空） */
  suffix: string;
  /** 数值下方的说明标签（可空） */
  label: string;
  /** 原文含千分位逗号时滚动过程也按千分位格式化 */
  groupDigits: boolean;
  /** 原始行（解析失败时按原样展示） */
  raw: string;
}

// 数值 token：整数/小数，允许半角或全角千分位逗号（1,200,000 / 1，200，000）
const NUM_RE = /^(\d[\d,，.]*)$/;

/**
 * 解析一行数据文案：「<数值><可选后缀> <标签>」。
 * 例：「99.9% 服务可用率」「3000万+ 累计用户」「1,200,000 次调用」「3x 效率提升」。
 * 不是「数值开头」的行返回 null（调用方按原文静态展示）。
 */
export const parseStatLine = (line: string): StatItem | null => {
  const s = (line ?? '').trim();
  if (!s) return null;
  // 数值段 = 开头连续的数字/逗号/小数点；后缀段 = 紧随的非空白非数字（至多 4 字符）
  const m = s.match(/^([\d,，.]+)([^\d\s]{0,4})?\s*(.*)$/u);
  if (!m) return null;
  const numToken = m[1];
  if (!NUM_RE.test(numToken)) return null;
  const normalized = numToken.replace(/，/g, ',');
  const groupDigits = normalized.includes(',');
  const value = Number(normalized.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const dot = normalized.indexOf('.');
  const decimals = dot >= 0 ? normalized.length - dot - 1 : 0;
  return {
    value,
    decimals,
    suffix: m[2] ?? '',
    label: (m[3] ?? '').trim(),
    groupDigits,
    raw: s,
  };
};

/** 滚动过程中的当前值格式化（保持小数位与千分位与原文一致） */
export const formatStatValue = (item: StatItem, value: number): string => {
  const fixed = value.toFixed(item.decimals);
  if (!item.groupDigits) return fixed;
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
};

// ====== 3D 数据可视化模板（GrowthBars3D / TrendLine3D）的数据点解析 ======

/** 图表数据点：分类标签 + 数值 + 展示文本（柱顶/端点标注用） */
export interface DataPoint {
  /** 分类标签（如「一月」「月活用户」，可空） */
  label: string;
  /** 参与柱高/纵轴归一的数值（万/亿/千/百/K/M 后缀已折算真实值，跨行可比） */
  value: number;
  /** 原文数值段（含后缀，如「120万」「99.9%」），标注直接按原文展示 */
  display: string;
}

// 数量级后缀 → 倍率（「120万」与「85」同台时按真实值归一，柱高才可比）
const MAGNITUDE_SUFFIX: Record<string, number> = {万: 1e4, 亿: 1e8, 千: 1e3, 百: 1e2, K: 1e3, k: 1e3, M: 1e6};

// 标签在前的数据行：「月活用户 120万」「一月 120」「Q1: 3.2万」（分隔符可省）
const LABEL_FIRST_RE = /^(.+?)[\s:：\-—~]*(\d[\d,，.]*)([万亿千百KkM]\+?|%|x|倍)?\s*$/u;

/**
 * 解析一行图表数据（两种写法，标签优先匹配数值在前的 StatCounter 同款）：
 * - 数值在前：「120万 月活用户」「99.9% 服务可用率」（走 parseStatLine）
 * - 标签在前：「月活用户 120万」「一月 120」（分隔符空格/冒号/连字符均可省）
 * 返回 null = 两种写法都不命中（调用方决定降级策略，不丢文案原则同 parseStatLine）。
 */
export const parseDataPointLine = (line: string): DataPoint | null => {
  const s = (line ?? '').trim();
  if (!s) return null;
  // 数值开头 → StatCounter 行解析（「1.2.3」等坏数字在此判死，不再试标签写法）
  if (/^\d/.test(s)) {
    const st = parseStatLine(s);
    if (!st) return null;
    const token = s.match(/^[\d,，.]+/)?.[0] ?? String(st.value);
    const mag = MAGNITUDE_SUFFIX[st.suffix.replace(/\+$/, '')] ?? 1;
    return {label: st.label, value: st.value * mag, display: `${token}${st.suffix}`};
  }
  const m = s.match(LABEL_FIRST_RE);
  if (!m) return null;
  const numToken = m[2];
  if (!NUM_RE.test(numToken)) return null;
  const value = Number(numToken.replace(/[,，]/g, ''));
  if (!Number.isFinite(value)) return null;
  const suffix = m[3] ?? '';
  const mag = MAGNITUDE_SUFFIX[suffix.replace(/\+$/, '')] ?? 1;
  return {label: m[1].trim(), value: value * mag, display: `${numToken}${suffix}`};
};

/** parseDataSeries 的解析档位 */
export interface DataSeriesOptions {
  /** 有效数据点下限：不足 min 条整体回退 fallback（半截数据不如完整示例） */
  min: number;
  /** 数据点上限：超出截断（图表密度上限） */
  max: number;
  /** 回退示例数据（各模板自带，贴合场景语义） */
  fallback: DataPoint[];
}

/**
 * 从 features 文本行解析图表数据系列：逐行 parseDataPointLine、丢弃解析失败的行；
 * 有效条数 < min → 返回 fallback（截到 max）；≥ min → 截断到 max 返回。
 */
export const parseDataSeries = (lines: string[] | undefined, opts: DataSeriesOptions): DataPoint[] => {
  const parsed = (lines ?? []).map(parseDataPointLine).filter((x): x is DataPoint => x !== null);
  if (parsed.length < opts.min) return opts.fallback.slice(0, opts.max);
  return parsed.slice(0, opts.max);
};

/** 高亮渲染分段：「」『』"" 内的片段标记 highlight（引号本身不渲染，由高亮样式替代） */
export interface HighlightSegment {
  text: string;
  highlight: boolean;
}

const HIGHLIGHT_RE = /[「『"]([^」』"]+)[」』"]/gu;

/** 把含「高亮词」的文案切成渲染分段；无引号时返回单段原文 */
export const parseHighlightSegments = (text: string): HighlightSegment[] => {
  const out: HighlightSegment[] = [];
  let last = 0;
  for (const m of (text ?? '').matchAll(HIGHLIGHT_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({text: text.slice(last, idx), highlight: false});
    out.push({text: m[1], highlight: true});
    last = idx + m[0].length;
  }
  if (last < (text ?? '').length) out.push({text: (text ?? '').slice(last), highlight: false});
  return out.length > 0 ? out : [{text: text ?? '', highlight: false}];
};

/** Testimonial 的强类型文案 */
export interface TestimonialContent {
  quote: string;
  author: string;
  role: string;
  /** 星级 0-5（0 = 隐藏星级）；features[2] 缺省/非法时按 5 星 */
  rating: number;
}

const AUTHOR_SPLIT_RE = /[，,、·|/]+/;

/**
 * 从 features 拆证言：features[0] 引言 / features[1] 署名（「姓名，职位」） / features[2] 星级（0-5）。
 * 引言缺省时回退 subtitle → title，保证只有一行也能用。
 */
export const parseTestimonial = (
  features: string[] | undefined,
  fallbackQuote?: string,
): TestimonialContent => {
  const list = (features ?? []).map((f) => (f ?? '').trim()).filter(Boolean);
  const quote = list[0] || (fallbackQuote ?? '').trim();
  const authorPart = list[1] ?? '';
  const parts = authorPart.split(AUTHOR_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  const author = parts[0] ?? '';
  const role = parts.slice(1).join(' · ');
  const rawRating = list[2] !== undefined ? Number(list[2]) : NaN;
  const rating = Number.isInteger(rawRating) && rawRating >= 0 && rawRating <= 5 ? rawRating : 5;
  return {quote, author, role, rating};
};

// ====== 词弹字幕分词（CaptionLayer wordPop 用） ======

/** 字幕词单元：countable = 计入逐词节奏（CJK 单字 / 拉丁词），空白与标点只负责排版 */
export interface CaptionUnit {
  text: string;
  countable: boolean;
}

const CAPTION_UNIT_RE = /[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9'’@#&.\-_%]+|\s+|./gu;

/**
 * 字幕文本切成词单元：中文按字、拉丁按词、空白合并为单个空格单元、其它字符单列。
 * 空白单元保留原文本（渲染用 pre-wrap，多空格自然折叠为单空格，不丢词间距）。
 */
export const tokenizeCaption = (text: string): CaptionUnit[] => {
  const out: CaptionUnit[] = [];
  for (const m of (text ?? '').matchAll(CAPTION_UNIT_RE)) {
    const t = m[0];
    if (/^\s+$/.test(t)) out.push({text: ' ', countable: false});
    else if (/^[\u3400-\u9fff\uf900-\ufaff]$/.test(t) || /^[A-Za-z0-9'’@#&.\-_%]+$/.test(t)) {
      out.push({text: t, countable: true});
    } else out.push({text: t, countable: false});
  }
  return out;
};

// ====== 时间线 / 定价 / 前后对比 模板的行解析 ======

/** TimelineRoadmap 节点：features 行「节点标签 节点描述」（首个空格前为标签，如「v1.0」「2024Q1」） */
export interface TimelineNode {
  tag: string;
  label: string;
}

export const parseTimelineNode = (line: string): TimelineNode => {
  const s = (line ?? '').trim();
  const sp = s.indexOf(' ');
  return sp < 0 ? {tag: s, label: ''} : {tag: s.slice(0, sp), label: s.slice(sp + 1).trim()};
};

/** PricingTiers 档位：features 行「档位名 价格 描述」（前两段不含空格，其余为描述） */
export interface PricingTier {
  name: string;
  price: string;
  desc: string;
}

export const parsePricingTier = (line: string): PricingTier => {
  const parts = (line ?? '').trim().split(/\s+/);
  return {name: parts[0] ?? '', price: parts[1] ?? '', desc: parts.slice(2).join(' ')};
};

/** BeforeAfter 指标行：「16小时 → 5分钟」→ 前后两段文本（→ / -> / ⇒ 均可） */
export interface BeforeAfterMetric {
  before: string;
  after: string;
}

export const parseBeforeAfterMetric = (line: string): BeforeAfterMetric | null => {
  const m = (line ?? '').split(/\s*(?:→|->|⇒|=>)\s*/);
  if (m.length !== 2 || !m[0].trim() || !m[1].trim()) return null;
  return {before: m[0].trim(), after: m[1].trim()};
};

/** ComingSoon 日期分段：「2026.09.01」→ ['2026','09','01']（非日期原文整段返回） */
export const parseDateSegments = (text: string): string[] => {
  const s = (text ?? '').trim();
  if (!s) return [];
  if (/^[\d.．/\-年月日号\s]+$/.test(s) && /\d/.test(s)) {
    return s.split(/[.．/\-年月日号\s]+/).filter(Boolean);
  }
  return [s];
};

// ====== 批 2 真缺口三形态（2026-10-13）：DiffReveal 行 / PriceAnchorPro 徽章拆分 ======

/** DiffReveal 行（diff 惯例前缀）：'-'=删除行、'+'=新增行、无前缀=上下文行 */
export interface DiffRow {
  kind: 'del' | 'add' | 'ctx';
  text: string;
}

export const parseDiffRows = (lines: string[] | undefined, maxRows = 10): DiffRow[] =>
  (lines ?? [])
    .map((l) => {
      const raw = (l ?? '').trim();
      if (raw.startsWith('-')) return {kind: 'del' as const, text: raw.slice(1).trim()};
      if (raw.startsWith('+')) return {kind: 'add' as const, text: raw.slice(1).trim()};
      return {kind: 'ctx' as const, text: raw};
    })
    .filter((r) => r.text !== '')
    .slice(0, maxRows);

/** PriceAnchorPro：features 前缀 '!'=信赖徽章（≤3），其余=卖点对勾行（≤4） */
export interface PriceAnchorContent {
  perks: string[];
  badges: string[];
}

export const parsePriceAnchor = (lines: string[] | undefined, maxPerks = 4, maxBadges = 3): PriceAnchorContent => {
  const perks: string[] = [];
  const badges: string[] = [];
  for (const l of lines ?? []) {
    const raw = (l ?? '').trim();
    if (!raw) continue;
    if (raw.startsWith('!')) {
      const t = raw.slice(1).trim();
      if (t && badges.length < maxBadges) badges.push(t);
    } else if (perks.length < maxPerks) {
      perks.push(raw);
    }
  }
  return {perks, badges};
};
