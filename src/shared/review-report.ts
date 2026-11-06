/**
 * VLM 审片（review_render）——提示词模板与报告解析（纯函数，Node 可直跑单测）。
 *
 * 模式：对成片按段时间轴抽帧 → 交给用户已配置的多模态 LLM 按固定评分维度审片 →
 * 解析出结构化报告（分数 + 问题清单 + 修改建议）。评审质量不依赖调用方 agent 的
 * 视觉能力，质量标尺固定在本模块。
 *
 * 分数 1-5（5 = 商业投放水准）；verdict：pass ≥4 / revise ≥3 / rework <3。
 */

// ====== 评分维度 ======

export interface ReviewDimension {
  key: string;
  label: string;
  desc: string;
}

export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  {key: 'hook', label: '首帧钩子', desc: '开场 1-2 秒能否留住观众（冲突感/悬念/视觉冲击）'},
  {key: 'readability', label: '文字可读性', desc: '标题/字幕字号与对比度是否足够、有无被画面元素干扰'},
  {key: 'motionCoherence', label: '动效一致性', desc: '进出场与转场节奏是否统一、有无突兀跳变或廉价闪烁感'},
  {key: 'colorUnity', label: '色调统一', desc: '多段素材色彩是否协调、整体调性是否一致（无拼贴感）'},
  {key: 'safeArea', label: '字幕与安全区', desc: '文字/Logo 是否越出安全区、是否过于贴边或被裁切'},
  {key: 'commercial', label: '整体商业感', desc: '是否达到商业投放水准（构图、信息密度、收尾完整度）'},
];

/** AI 生成模板（review_template）专用维度：评审「模板本身」而不是成片叙事 */
export const TEMPLATE_REVIEW_DIMENSIONS: ReviewDimension[] = [
  {key: 'readability', label: '文字可读性', desc: '字号/字重/对比度是否足够，标题与正文层级是否清晰'},
  {key: 'layout', label: '构图布局', desc: '对齐/留白/视觉平衡，元素有无溢出画布或互相遮挡'},
  {key: 'brandFit', label: '品牌一致性', desc: '是否使用了设计令牌（VIDEO_DESIGN 的颜色/字号/圆角/阴影）与品牌色，而非随手硬编码'},
  {key: 'motion', label: '动画节奏', desc: '对比两帧推断：入场是否按预期完成、元素错峰是否合理、稳定段是否真的稳定'},
  {key: 'polish', label: '商业质感', desc: '阴影/圆角/层次/留白是否精致，有无廉价感（默认字体堆叠/生硬色块/元素贴边）'},
];

// ====== 报告结构 ======

export interface ReviewIssue {
  /** 关联评分维度 key（见 REVIEW_DIMENSIONS） */
  dimension: string;
  /** 关联片段下标（0 起；全局性问题省略） */
  segmentIndex?: number;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  suggestion: string;
}

export interface ReviewReport {
  /** 各维度分数 1-5（key 见 REVIEW_DIMENSIONS） */
  scores: Record<string, number>;
  /** 总分 1-5（各维度平均） */
  overall: number;
  verdict: 'pass' | 'revise' | 'rework';
  issues: ReviewIssue[];
  summary: string;
}

// ====== 提示词 ======

/** 传入 buildReviewPrompt 的故事板上文（executor 从 store 提炼） */
export interface ReviewStoryboardContext {
  segments: Array<{
    index: number;
    templateId: string;
    title?: string;
    subtitle?: string;
    duration: number;
  }>;
  /** 每张抽帧画面的说明（时间点 + 所属段） */
  frames: Array<{timeSec: number; note: string}>;
  /** 审片侧重（缺省全面审查） */
  focus?: string;
}

export const buildReviewPrompt = (ctx: ReviewStoryboardContext): string => {
  const dimLines = REVIEW_DIMENSIONS.map((d) => `- ${d.key}（${d.label}）：${d.desc}`).join('\n');
  const segLines = ctx.segments
    .map((s) => `  第 ${s.index} 段（${s.duration}s，模板 ${s.templateId}）：标题「${s.title || '无'}」${s.subtitle ? ` 副标题「${s.subtitle}」` : ''}`)
    .join('\n');
  const frameLines = ctx.frames.map((f, i) => `  图 ${i + 1}：${f.note}`).join('\n');
  const focusLine = ctx.focus ? `\n本次审片侧重点：${ctx.focus}（其余维度仍需打分，但问题清单优先围绕侧重展开）。` : '';

  return [
    '你是一名严格的商业宣传片审片导演。下面是一支宣传片的分段抽帧画面（按时间顺序）、故事板结构和评分维度。',
    '请逐张查看画面后，按维度打 1-5 分（5 = 可直接商业投放）并给出问题清单。',
    focusLine,
    '',
    '故事板结构：',
    segLines,
    '',
    '抽帧画面（共 ' + ctx.frames.length + ' 张，按全片时间顺序）：',
    frameLines,
    '',
    '评分维度：',
    dimLines,
    '',
    '要求：',
    '1. 只输出一个 JSON 对象，不要输出任何其他文字或 markdown 围栏。',
    '2. JSON 结构：{"scores":{每个维度 key:1-5 整数},"overall":1-5,"issues":[{"dimension":"维度key","segmentIndex":片段下标或省略,"severity":"high|medium|low","problem":"具体问题（引用画面证据）","suggestion":"可执行的修改建议（指明用哪个工具改什么）"}],"summary":"一句话总评","verdict":"pass|revise|rework"}',
    '3. issues 按严重度降序；每条 suggestion 必须可落地（如「第 2 段标题字号不足，建议调大」而不是「优化文字」）。',
    '4. 没有问题的维度不要编造问题；整体达到投放水准就给 pass，不要为了显得严格而挑刺。',
  ].join('\n');
};

// ====== AI 生成模板审片（review_template）======

/** 传入 buildTemplateReviewPrompt 的模板上文（executor 从 def + 合成段提炼） */
export interface TemplateReviewContext {
  name: string;
  description: string;
  durationSec: number;
  orientation: string;
  /** 演示文案（合成单段用的示例 title/subtitle） */
  demoTitle: string;
  demoSubtitle: string;
  /** 每张抽帧画面的说明（时间点 + 阶段：入场完成/稳定段） */
  frames: Array<{timeSec: number; note: string}>;
  focus?: string;
}

/**
 * 生成模板的 VLM 审片提示词：评审对象是「模板本身」而非成片叙事。
 * JSON 结构与 buildReviewPrompt 一致（parseReviewReport 复用，维度换 TEMPLATE_REVIEW_DIMENSIONS）。
 */
export const buildTemplateReviewPrompt = (ctx: TemplateReviewContext): string => {
  const dimLines = TEMPLATE_REVIEW_DIMENSIONS.map((d) => `- ${d.key}（${d.label}）：${d.desc}`).join('\n');
  const frameLines = ctx.frames.map((f, i) => `  图 ${i + 1}：${f.note}`).join('\n');
  const focusLine = ctx.focus ? `\n本次审片侧重点：${ctx.focus}（其余维度仍需打分，但问题清单优先围绕侧重展开）。` : '';

  return [
    '你是一名严格的商业 MG 动效模板评审。下面是一个 AI 现场生成的视频模板在不同时间点的渲染画面、模板设计意图和评分维度。',
    '请逐张查看画面后，按维度打 1-5 分（5 = 可直接商用的模板水准）并给出问题清单。',
    focusLine,
    '',
    `模板：「${ctx.name}」（${ctx.durationSec}s，${ctx.orientation === 'portrait' ? '竖屏' : '横屏'}）`,
    `设计意图：${ctx.description || '未提供'}`,
    `演示文案：标题「${ctx.demoTitle}」 副标题「${ctx.demoSubtitle}」（评审模板对真实文案的适配能力，文案本身是占位）`,
    '',
    '渲染画面（共 ' + ctx.frames.length + ' 张，同一模板不同时间点）：',
    frameLines,
    '',
    '评分维度：',
    dimLines,
    '',
    '要求：',
    '1. 只输出一个 JSON 对象，不要输出任何其他文字或 markdown 围栏。',
    '2. JSON 结构：{"scores":{每个维度 key:1-5 整数},"overall":1-5,"issues":[{"dimension":"维度key","severity":"high|medium|low","problem":"具体问题（引用画面证据）","suggestion":"可执行的修改建议（指明代码层面怎么改：调什么样式/动画参数）"}],"summary":"一句话总评","verdict":"pass|revise|rework"}',
    '3. issues 按严重度降序；每条 suggestion 必须可落地到 TSX 代码修改（如「标题 fontSize 从 40 提到 64 并用 VIDEO_DESIGN.fontSize.title」而不是「优化文字」）。',
    '4. 没有问题的维度不要编造问题；整体达到商用模板水准就给 pass，不要为了显得严格而挑刺。',
  ].join('\n');
};

// ====== 解析 ======

const clampScore = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(5, Math.max(1, Math.round(n)));
};

const VERDICTS = ['pass', 'revise', 'rework'] as const;
const SEVERITIES = ['high', 'medium', 'low'] as const;

const verdictFromOverall = (overall: number): ReviewReport['verdict'] =>
  overall >= 4 ? 'pass' : overall >= 3 ? 'revise' : 'rework';

/** 从模型输出文本中剥掉 markdown 围栏并截取首个完整 JSON 对象 */
const extractJsonCandidate = (text: string): string | null => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start >= 0 && end > start) return c.slice(start, end + 1);
  }
  return null;
};

const normalizeIssue = (raw: unknown): ReviewIssue | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const problem = typeof o.problem === 'string' ? o.problem.trim() : '';
  if (!problem) return null;
  const severity = typeof o.severity === 'string' && (SEVERITIES as readonly string[]).includes(o.severity)
    ? (o.severity as ReviewIssue['severity'])
    : 'medium';
  const segIdx = Number(o.segmentIndex);
  return {
    dimension: typeof o.dimension === 'string' ? o.dimension : 'commercial',
    segmentIndex: Number.isInteger(segIdx) && segIdx >= 0 ? segIdx : undefined,
    severity,
    problem,
    suggestion: typeof o.suggestion === 'string' ? o.suggestion.trim() : '',
  };
};

/**
 * 解析模型输出的审片报告。
 * 失败时返回 {ok:false, raw}，调用方把原文返回给 agent（不阻断，agent 仍可读文本报告）。
 */
export const parseReviewReport = (
  modelText: string,
  dimensions: ReviewDimension[] = REVIEW_DIMENSIONS,
): {ok: true; report: ReviewReport} | {ok: false; raw: string} => {
  const text = (modelText || '').trim();
  if (!text) return {ok: false, raw: modelText};
  const jsonStr = extractJsonCandidate(text);
  if (!jsonStr) return {ok: false, raw: modelText};
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return {ok: false, raw: modelText};
  }
  if (!parsed || typeof parsed !== 'object') return {ok: false, raw: modelText};
  const o = parsed as Record<string, unknown>;

  // 分数：只要有一个合法维度分数就接受，缺失维度补 overall
  const scores: Record<string, number> = {};
  const rawScores = (o.scores && typeof o.scores === 'object' ? o.scores : {}) as Record<string, unknown>;
  for (const d of dimensions) {
    const s = clampScore(rawScores[d.key]);
    if (s !== undefined) scores[d.key] = s;
  }
  const values = Object.values(scores);
  const overallRaw = clampScore(o.overall);
  const overall = overallRaw ?? (values.length > 0
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : 3);
  if (values.length === 0) scores.commercial = overallRaw ?? 3;

  const verdict = typeof o.verdict === 'string' && (VERDICTS as readonly string[]).includes(o.verdict)
    ? (o.verdict as ReviewReport['verdict'])
    : verdictFromOverall(overall);

  const issues = Array.isArray(o.issues)
    ? o.issues.map(normalizeIssue).filter((i): i is ReviewIssue => i !== null)
    : [];

  return {
    ok: true,
    report: {
      scores,
      overall,
      verdict,
      issues,
      summary: typeof o.summary === 'string' ? o.summary.trim() : '',
    },
  };
};
