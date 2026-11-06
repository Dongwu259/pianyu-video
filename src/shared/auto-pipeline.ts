/**
 * 全自动流水线（run_auto_pipeline）——状态类型与各阶段 LLM 提示词/解析（纯函数，可单测）。
 *
 * 流水线本体在 renderer/ai/autoPipeline.ts（异步 runner，复用 executeLlmTool 执行既有
 * 工具）；本模块只放数据契约：进度状态（get_app_status 透出）+ 四个 LLM 调用的
 * 提示词构造与防御性 JSON 解析（与 review-report/media-tags 同模式）。
 *
 * 解析失败一律 fail-safe：故事板/素材计划解析失败 → 流水线报错终止（无故事板无意义）；
 * 改稿/元数据解析失败 → 跳过该步不阻断（产物仍交付）。
 */

import type {PipelineMaterials, RunPipelineArgs} from './llm-tools.ts';
import type {VideoType} from './video-type.ts';
import {VIDEO_TYPE_LABEL} from './video-type.ts';
import type {MediaStoryUnit, StoryRole} from './media-tags.ts';

/**
 * 全自动流水线会自动挖高光的体裁（剧本声明了「长素材先挖矿」链路的分册）：
 * vlog（旅行/日常长录像）、talkingHead（访谈/直播回放）、tutorial（长录屏）。
 * 其余体裁（promo/montage）挖矿仍可由 agent 手动调用，流水线不自动插入。
 */
export const PIPELINE_MINING_GENRES: readonly VideoType[] = ['vlog', 'talkingHead', 'tutorial'];

/** 体裁是否走流水线自动挖矿（提示词预告 / 素材约束 / 执行门控三处共用） */
export const isPipelineMiningGenre = (videoType: VideoType): boolean =>
  PIPELINE_MINING_GENRES.includes(videoType);

// ====== 体裁口径（人设 / 结构 / 元数据风格）======

/**
 * 按体裁的流水线角色人设。promo 三条与历史文案逐字一致（单测锚定）；
 * 其实体裁换头衔，职责句式不变——流水线各阶段提示词共用。
 */
const PIPELINE_PERSONAS: Record<VideoType, {director: string; producer: string; editor: string}> = {
  promo: {director: '商业宣传片编导', producer: '宣传片执行制片', editor: '宣传片剪辑指导'},
  vlog: {director: '生活 vlog 编导', producer: 'vlog 执行制片', editor: 'vlog 剪辑指导'},
  talkingHead: {director: '口播讲解视频编导', producer: '口播视频执行制片', editor: '口播视频剪辑指导'},
  tutorial: {director: '教程演示视频编导', producer: '教程视频执行制片', editor: '教程视频剪辑指导'},
  montage: {director: '卡点混剪视频编导', producer: '混剪视频执行制片', editor: '混剪视频剪辑指导'},
};

/** 故事板结构要求（提示词「要求」第 1 条）按体裁切换 */
const STORYBOARD_STRUCTURE: Record<VideoType, string> = {
  promo: '1. 3-6 段，叙事完整（钩子→展开→佐证→收尾/CTA），文案精炼有冲击力（中文）',
  vlog: '1. 2-5 段，真实记录的叙事（钩子前置放最抓人的画面→高光主体→收尾），文案口语化、第一人称，不用营销腔',
  talkingHead: '1. 3-6 段，观点表达结构（钩子抛问题或结论先行→逐个观点→总结收束），文案像说话，先给结论再展开',
  tutorial: '1. 3-6 段，教程结构（结果先行→步骤分解→收尾提示），每段对应一个步骤，讲解与画面严格对齐',
  montage: '1. 2-6 段，情绪曲线（开场建立→渐强→高潮快切→收束），文案少而有力，让画面与节拍说话',
};

/** 发布元数据的体裁风格提示 */
const METADATA_STYLE: Record<VideoType, string> = {
  promo: '宣传片口径：标题突出产品与卖点钩子，简介含行动召唤。',
  vlog: 'vlog 口径：标题第一人称、有生活气息（如「在成都的一天」），简介口语化，标签带 vlog/日常/地点词。',
  talkingHead: '口播口径：标题给观点或结论（有态度更抓人），简介点明「看完你会知道什么」。',
  tutorial: '教程口径：标题给步骤感与结果（如「三步学会…」），标签带教程/入门/软件名。',
  montage: '混剪口径：标题给情绪与氛围（如「这场日落值得单曲循环」），标签带卡点/混剪/配乐名。',
};

// ====== 进度状态 ======

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface AutoPipelineStep {
  key: string;
  label: string;
  status: StepStatus;
  note?: string;
}

export interface AutoPipelineOutputs {
  videoPath?: string;
  coverPath?: string;
  reviewOverall?: number;
  reviewVerdict?: string;
  metadataTitle?: string;
  /** 末轮音频审片仍未解决的问题（响度/爆音/静音/旁白比对；无此字段 = 音频通过或未审） */
  audioIssues?: string[];
}

export interface AutoPipelineState {
  status: 'running' | 'done' | 'error';
  brief: string;
  /** 本次流水线采用的工程体裁（启动时快照；人设/结构/挖掘环节按它切换） */
  videoType: VideoType;
  options: Pick<RunPipelineArgs, 'targetDurationSec' | 'reviewRounds' | 'narration' | 'materials'>;
  startedAt: number;
  endedAt?: number;
  steps: AutoPipelineStep[];
  /** 详细日志（新在前，截尾保留 60 条） */
  log: string[];
  outputs?: AutoPipelineOutputs;
  error?: string;
}

export const PIPELINE_STEPS: Array<{key: string; label: string}> = [
  {key: 'storyboard', label: 'AI 编写脚本与故事板（大纲→分镜→润色）'},
  {key: 'materials', label: '配置素材（复用已有 / stock 搜索 / 文生图）'},
  {key: 'mining', label: '高光挖掘（长素材浓缩）'},
  {key: 'montage', label: '音乐结构重排（段落对齐+转场选型）'},
  {key: 'audio', label: '旁白合成与 BGM'},
  {key: 'render', label: '渲染成片'},
  {key: 'review', label: 'VLM 审片'},
  {key: 'autofix', label: '自动改稿重渲'},
  {key: 'deliverables', label: '封面与发布元数据'},
];

/** 日志保留上限（防长流水线内存膨胀；完整过程可看各步 note） */
export const PIPELINE_LOG_LIMIT = 60;

// ====== 防御性 JSON 提取（各解析共用） ======

/** 剥 markdown 围栏后截取首个 JSON 数组/对象文本；找不到返回 null */
export const extractJsonText = (text: string): string | null => {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const arrStart = stripped.indexOf('[');
  const objStart = stripped.indexOf('{');
  let start = -1;
  let end = -1;
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
    start = arrStart;
    end = stripped.lastIndexOf(']');
  } else if (objStart >= 0) {
    start = objStart;
    end = stripped.lastIndexOf('}');
  }
  if (start < 0 || end <= start) return null;
  return stripped.slice(start, end + 1);
};

// ====== 计划层（plan_only 出计划 → 人工确认/修改 → segments 带计划执行）======

export interface PipelinePlanInput {
  videoType: VideoType;
  /** plan 生成的原始故事板片段（或人工改过的） */
  segments: Array<Record<string, unknown>>;
  /** 模板 id → 名称（计划文本展示用；查不到就裸显 id） */
  templateNames: Record<string, string>;
  targetDurationSec: number;
  narration: boolean;
  materials: PipelineMaterials;
  miningPlannedSec?: number;
  hasExistingMaterials: boolean;
  stockAvailable: boolean;
  imageGenAvailable: boolean;
}

const numOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strOr = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 把故事板计划转成给用户看的可读文本（plan_only 工具结果 / 流水线日志共用）。
 * 片段格式约定与 parseStoryboardGen 产物一致（宽松读取，坏字段不抛错）。
 */
export const buildPipelinePlanText = (input: PipelinePlanInput): string => {
  const segLines = input.segments.map((raw, i) => {
    const templateId = strOr(raw.templateId);
    const name = input.templateNames[templateId] ?? templateId;
    const text = (raw.text ?? {}) as Record<string, unknown>;
    const narration = (raw.narration ?? {}) as Record<string, unknown>;
    const head = `${i + 1}. ${name}${numOr(raw.duration, 0) > 0 ? ` ${numOr(raw.duration, 0)}s` : ''}`
      + `${strOr(text.title) ? `「${strOr(text.title)}」` : ''}`
      + `${strOr(text.subtitle) ? `｜${strOr(text.subtitle)}` : ''}`;
    const narr = strOr(narration.text);
    return `${head}${narr ? `\n     旁白：${narr.slice(0, 40)}${narr.length > 40 ? '…' : ''}` : ''}`;
  });
  const total = input.segments.reduce((sum, s) => sum + numOr(s.duration, 0), 0);
  const materialStrategy = input.materials === 'existing-only' ? '只复用已有素材'
    : input.hasExistingMaterials && (input.stockAvailable || input.imageGenAvailable)
      ? `复用已有素材优先，缺的用${input.stockAvailable ? ' stock 搜索' : ''}${input.stockAvailable && input.imageGenAvailable ? ' /' : ''}${input.imageGenAvailable ? '文生图' : ''}补`
      : !input.hasExistingMaterials && (input.stockAvailable || input.imageGenAvailable)
        ? `全部用${input.stockAvailable ? ' stock 搜索' : ''}${input.stockAvailable && input.imageGenAvailable ? ' /' : ''}${input.imageGenAvailable ? '文生图' : ''}取材`
        : '无素材来源（零素材模板成片）';
  return [
    `【成片计划 · ${VIDEO_TYPE_LABEL[input.videoType]}】目标约 ${input.targetDurationSec}s，共 ${input.segments.length} 段（合计 ${total}s）`,
    ...segLines,
    `素材策略：${materialStrategy}`,
    ...(input.miningPlannedSec && input.miningPlannedSec >= 60
      ? [`高光挖掘：检测到最长素材约 ${Math.round(input.miningPlannedSec)}s，执行时自动挖高光浓缩成主体`]
      : []),
    `旁白：${input.narration ? 'TTS 合成（可关）' : '不加旁白'}`,
    '——确认执行：run_auto_pipeline(segments=这份计划)；想改哪段直接说，改完再执行。',
  ].join('\n');
};

// ====== 阶段 0：brief → 叙事大纲（三阶段故事板的第一层）======

/**
 * 大纲拍：一段成片的叙事职责。三阶段链路（大纲→分镜→润色）把「一次性写故事板」
 * 拆成分层推敲——先定叙事骨架，再逐拍落模板与文案，叙事质量不再赌单次生成运气。
 */
export interface OutlineBeat {
  /** 段落职责（钩子/展开/佐证/收尾 CTA 等，自由短文本） */
  role: string;
  /** 这一拍要传达的核心信息（一句话） */
  message: string;
  /** 情绪/节奏提示（如「快、悬念」「缓、信任感」） */
  mood?: string;
  /** 建议秒数 */
  approxSec?: number;
}

export interface OutlineGenInput {
  brief: string;
  videoType: VideoType;
  targetDurationSec: number;
  orientation: 'landscape' | 'portrait';
}

export const buildOutlinePrompt = (input: OutlineGenInput): string => [
  `你是${PIPELINE_PERSONAS[input.videoType].director}。先不写脚本，只为这条片子定叙事大纲，严格输出 JSON 数组（不要围栏/多余文字）：`,
  '[{"role": "这一拍的叙事职责（如 钩子/痛点/展开/佐证/收尾CTA）", "message": "这一拍要传达的核心信息（一句话）", "mood": "情绪与节奏（如 快、悬念 / 缓、信任感）", "approxSec": 建议秒数}]',
  '',
  `需求：${input.brief}`,
  `画幅：${input.orientation === 'portrait' ? '竖版' : '横版'}；目标总时长约 ${input.targetDurationSec}s`,
  '',
  '要求：',
  STORYBOARD_STRUCTURE[input.videoType].replace(/^1\. /, '1. 大纲 3-7 拍，遵循该体裁叙事结构：'),
  '2. 第一拍必须是 3 秒内立住的钩子；最后一拍给明确收尾（CTA 或落版）',
  '3. 情绪曲线要有起伏：信息密拍与呼吸拍交替，不要全程同一节奏',
  '4. 各拍 approxSec 之和 ≈ 目标总时长（上下浮动 15% 内）',
].join('\n');

export const parseOutline = (text: string): {ok: true; beats: OutlineBeat[]} | {ok: false; error: string} => {
  const json = extractJsonText(text);
  if (!json) return {ok: false, error: '模型输出中未找到 JSON'};
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return {ok: false, error: '大纲不是非空数组'};
    const beats: OutlineBeat[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as Record<string, unknown>;
      if (typeof b.role !== 'string' || !b.role.trim() || typeof b.message !== 'string' || !b.message.trim()) continue;
      beats.push({
        role: b.role.trim().slice(0, 12),
        message: b.message.trim().slice(0, 60),
        mood: typeof b.mood === 'string' && b.mood.trim() ? b.mood.trim().slice(0, 20) : undefined,
        approxSec: typeof b.approxSec === 'number' && Number.isFinite(b.approxSec)
          ? Math.max(2, Math.min(60, b.approxSec)) : undefined,
      });
      if (beats.length >= 10) break;
    }
    if (beats.length === 0) return {ok: false, error: '没有含 role+message 的有效大纲拍'};
    return {ok: true, beats};
  } catch (err) {
    return {ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`};
  }
};

/** 大纲拍格式化成给分镜提示词的行（buildStoryboardGenPrompt 消费） */
export const formatOutlineBeats = (beats: OutlineBeat[]): string[] =>
  beats.map((b, i) =>
    `第${i + 1}拍【${b.role}】${b.approxSec ? `（约${b.approxSec}s）` : ''}${b.mood ? ` ${b.mood}` : ''}：${b.message}`,
  );

// ====== 阶段 1：brief → 故事板 segments ======

export interface StoryboardTemplateInfo {
  id: string;
  name: string;
  description: string;
  minVideos: number;
  maxVideos: number;
  defaultDuration: number;
  /** 叙事槽位标签串（如「开场钩子/产品展示」；由 template-slots.slotLabelsOf 生成） */
  slotLabels?: string;
  /** 可调参数简报（如「direction(0-4默认0) zoom(1-3默认1.5)」；由 paramSpecs 压缩生成） */
  paramsBrief?: string;
  styles?: string[];
  actions?: string[];
  searchTags?: string[];
}

/** 把 TemplateMeta.paramSpecs 压缩成一行提示词用参数简报（最多 6 个，防清单膨胀） */
export const paramsBriefOf = (specs: Array<{key: string; min: number; max: number; default: number}> | undefined): string | undefined => {
  if (!specs || specs.length === 0) return undefined;
  const s = specs.slice(0, 6).map((p) => `${p.key}(${p.min}-${p.max}默认${p.default})`).join(' ');
  return s || undefined;
};

export interface StoryboardGenInput {
  brief: string;
  /** 工程体裁：切换编导人设、叙事结构要求与素材策略 */
  videoType: VideoType;
  orientation: 'landscape' | 'portrait';
  aspectRatioId: string;
  targetDurationSec: number;
  templates: StoryboardTemplateInfo[];
  /** 可用素材能力（影响选模板策略） */
  hasExistingMaterials: boolean;
  stockAvailable: boolean;
  imageGenAvailable: boolean;
  /** ≥60s 时流水线会自动挖高光（vlog 体裁 + 长素材）；给模型预告，让它安排承载段 */
  miningPlannedSec?: number;
  /** 三阶段链路：已定的叙事大纲。给出时分镜逐拍落实大纲，不再自由发挥结构 */
  outlineBeats?: OutlineBeat[];
  templateSearchSummary?: string;
}

export const buildStoryboardGenPrompt = (input: StoryboardGenInput): string => {
  const lines = input.templates.map((t) =>
    `- ${t.id}（${t.name}）${t.slotLabels ? `【${t.slotLabels}】` : ''}${t.styles?.length ? `【风格:${t.styles.join('/') }】` : ''}${t.actions?.length ? `【动作:${t.actions.join('/') }】` : ''}：${t.description}${t.minVideos === 0 ? '【零素材可用】' : `【需 ${t.minVideos}-${t.maxVideos} 条素材】`} 默认 ${t.defaultDuration}s${t.paramsBrief ? `｜参数: ${t.paramsBrief}` : ''}`,
  );
  const capability = input.hasExistingMaterials
    ? '用户已有部分素材'
    : input.stockAvailable || input.imageGenAvailable
      ? `用户无现成素材，但${input.stockAvailable ? '可搜索 stock 素材' : ''}${input.stockAvailable && input.imageGenAvailable ? '、' : ''}${input.imageGenAvailable ? '可文生图' : ''}`
      : '用户无素材且未配置 stock/文生图——只能用【零素材可用】模板';
  const miningLine = input.miningPlannedSec && input.miningPlannedSec >= 60
    ? `长素材策略：最长素材约 ${Math.round(input.miningPlannedSec)}s，流水线配完素材会自动挖高光把它浓缩成成片主体——请用 1 个全屏素材模板段（VideoCut 等）承载它，其余段用零素材模板包装（一句话点题 / 地点字幕等）`
    : null;
  const outlineSection = input.outlineBeats && input.outlineBeats.length > 0
    ? [
        '已定叙事大纲（逐拍落实，段数必须与拍数一致，每段绑定一拍职责）：',
        ...formatOutlineBeats(input.outlineBeats),
        '',
      ]
    : [];
  return [
    `你是${PIPELINE_PERSONAS[input.videoType].director}。${input.outlineBeats?.length ? '按已定大纲规划故事板分镜' : '根据需求写脚本并规划故事板'}，严格输出 JSON 数组（不要围栏/多余文字），每段格式：`,
    '{"templateId": "模板id", "duration": 秒, "text": {"title": "主标题", "subtitle": "副标题", "features": ["要点1", "要点2"]}, "narration": {"text": "旁白文案"}, "customParams": {"参数键": 数值}}',
    '',
    `需求：${input.brief}`,
    ...outlineSection,
    ...(input.templateSearchSummary ? [`模板检索说明：${input.templateSearchSummary}`] : []),
    `画幅：${input.aspectRatioId}（${input.orientation === 'portrait' ? '竖版' : '横版'}）；目标总时长约 ${input.targetDurationSec}s（各段 duration 之和上下浮动 15% 内）`,
    `素材情况：${capability}`,
    ...(miningLine ? [miningLine] : []),
    '',
    '可用模板：',
    ...lines,
    '',
    '要求：',
    ...(input.outlineBeats?.length ? ['1. 严格按大纲拍序与职责分段，输出段数必须与大纲拍数一致，各段 duration 参考大纲 approxSec'] : [STORYBOARD_STRUCTURE[input.videoType]]),
    '2. 需素材的段控制在一半以内，其余用零素材模板（文案即画面）；素材段选 1 条素材即可',
    '2b. 素材类型-模板对位：实拍素材（真人/实景/产品实拍）优先 Fullbleed 满幅族（FullbleedTitle/FullbleedFeature/FullbleedCTA）或 VideoCut——实拍画面是主角，禁止把它放进 3D 画中画族缩成小窗；录屏/截图/图形素材才用展板画中画类模板',
    '3. 标题 ≤14 字、副标题 ≤22 字、每段要点 ≤3 条各 ≤16 字（features 数组）',
    '4. narration.text 与画面互补（不重复读标题），每段 ≤2 句，无旁白的段省略 narration',
    '5. customParams 可省略（省略=模板全默认）；只给需要偏离默认的键，键与取值范围见模板清单「参数」——刻意调 1-2 个关键参数（如飞入方向 direction 配合上下段运动、推近倍率）能明显减少模板感',
  ].join('\n');
};

export const parseStoryboardGen = (text: string): {ok: true; segments: Array<Record<string, unknown>>} | {ok: false; error: string} => {
  const json = extractJsonText(text);
  if (!json) return {ok: false, error: '模型输出中未找到 JSON'};
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return {ok: false, error: '故事板不是非空数组'};
    const segments = arr.filter((s) => s && typeof s === 'object' && typeof (s as Record<string, unknown>).templateId === 'string');
    if (segments.length === 0) return {ok: false, error: '没有含 templateId 的有效片段'};
    return {ok: true, segments: segments as Array<Record<string, unknown>>};
  } catch (err) {
    return {ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`};
  }
};

// ====== 阶段 1.5：文案润色（三阶段故事板的第三层；失败保留原文案）======

export interface PolishSegmentBrief {
  index: number;
  templateId: string;
  title?: string;
  subtitle?: string;
  features?: string[];
  narration?: string;
}

export interface PolishPatch {
  index: number;
  title?: string;
  subtitle?: string;
  features?: string[];
  narration?: string;
}

export const buildPolishPrompt = (input: {videoType: VideoType; segments: PolishSegmentBrief[]}): string => {
  const segLines = input.segments.map((s) =>
    `- 第 ${s.index} 段（${s.templateId}）：标题「${s.title || '无'}」 副标题「${s.subtitle || '无'}」${s.features?.length ? ` 要点：${s.features.join('／')}` : ''}${s.narration ? ` 旁白：「${s.narration}」` : ''}`,
  );
  return [
    `你是${PIPELINE_PERSONAS[input.videoType].editor}。对刚写好的分镜文案做最后一遍润色，严格输出 JSON 数组（不要围栏/多余文字）：`,
    '[{"index": 段下标, "title": "润色后标题", "subtitle": "润色后副标题", "features": ["润色后要点"], "narration": "润色后旁白"}]',
    '',
    '润色准则：',
    '1. 只改值得改的段（占 1/3 左右即可）；已足够好的段不要进补丁',
    '2. 标题追求钩子与具体（数字/反差/利益点），避免空泛形容词堆叠',
    '3. 旁白口语化、像人说的话，与标题不重复；书面腔的旁白必须改',
    '4. 硬约束不变：标题 ≤14 字、副标题 ≤22 字、要点 ≤3 条各 ≤16 字、旁白每段 ≤2 句',
    '',
    '当前分镜：',
    ...segLines,
  ].join('\n');
};

export const parsePolish = (text: string): {ok: true; patches: PolishPatch[]} | {ok: false; error: string} => {
  const json = extractJsonText(text);
  if (!json) return {ok: false, error: '模型输出中未找到 JSON'};
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return {ok: false, error: '润色补丁数组为空'};
    const patches: PolishPatch[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      if (typeof p.index !== 'number' || !Number.isInteger(p.index)) continue;
      patches.push({
        index: p.index,
        title: typeof p.title === 'string' ? p.title.trim().slice(0, 40) : undefined,
        subtitle: typeof p.subtitle === 'string' ? p.subtitle.trim().slice(0, 60) : undefined,
        features: Array.isArray(p.features) ? p.features.filter((b): b is string => typeof b === 'string').slice(0, 4) : undefined,
        narration: typeof p.narration === 'string' ? p.narration.trim().slice(0, 300) : undefined,
      });
    }
    if (patches.length === 0) return {ok: false, error: '没有有效的润色补丁项'};
    return {ok: true, patches};
  } catch (err) {
    return {ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`};
  }
};

/** 把润色补丁合并进分镜片段（就地改 text/narration 字段；其余字段不动） */
export const applyPolishPatches = (
  segments: Array<Record<string, unknown>>,
  patches: PolishPatch[],
): Array<Record<string, unknown>> => {
  const byIndex = new Map(patches.map((p) => [p.index, p]));
  return segments.map((seg, i) => {
    const p = byIndex.get(i);
    if (!p) return seg;
    const next = {...seg};
    const text = {...((seg.text ?? {}) as Record<string, unknown>)};
    if (p.title !== undefined) text.title = p.title;
    if (p.subtitle !== undefined) text.subtitle = p.subtitle;
    if (p.features !== undefined) text.features = p.features;
    next.text = text;
    if (p.narration !== undefined) {
      next.narration = {...((seg.narration ?? {}) as Record<string, unknown>), text: p.narration};
    }
    return next;
  });
};

// ====== 阶段 2：素材配置计划 ======

export interface MaterialsSegmentBrief {
  index: number;
  templateId: string;
  minVideos: number;
  title?: string;
  subtitle?: string;
}

export interface ExistingMaterialBrief {
  name: string;
  path: string;
  durationSec: number;
  tag?: string;
  /** P0 时序理解结果；旧工程可能没有。 */
  storyUnits?: MediaStoryUnit[];
}

export interface MaterialsPlanInput {
  /** 工程体裁（vlog + 长素材时给「只放一段待浓缩」的分配约束） */
  videoType: VideoType;
  segments: MaterialsSegmentBrief[];
  existing: ExistingMaterialBrief[];
  stockAvailable: boolean;
  imageGenAvailable: boolean;
  strategy: PipelineMaterials;
}

export interface MaterialAssignment {
  index: number;
  source: 'existing' | 'stock' | 'imagegen' | 'none';
  existingPath?: string;
  stockQuery?: string;
  stockType?: 'video' | 'photo';
  imagePrompt?: string;
  /** existing 素材在 storyUnits 中的动作单元下标。 */
  storyUnitIndex?: number;
  /** existing 素材原始时间线窗口（秒）。 */
  sourceStartSec?: number;
  sourceEndSec?: number;
  /** 该段在连续动作链中的职责。 */
  continuityRole?: StoryRole;
  /** 排片器说明，供流水线日志/UI 使用。 */
  continuityNote?: string;
}

export interface MaterialsPlan {
  assignments: MaterialAssignment[];
  bgm?: {wantMood?: string; wantEnergy?: string};
}

export const buildMaterialsPlanPrompt = (input: MaterialsPlanInput): string => {
  const need = input.segments.filter((s) => s.minVideos > 0);
  const segLines = need.map((s) =>
    `- 第 ${s.index} 段（${s.templateId}）：标题「${s.title || '无'}」${s.subtitle ? ` 副标题「${s.subtitle}」` : ''}`,
  );
  const matLines = input.existing.length > 0
    ? input.existing.map((m) => {
      const units = (m.storyUnits ?? []).slice(0, 8).map((u, i) =>
        `#${i} ${u.startSec.toFixed(1)}-${u.endSec.toFixed(1)}s「${u.action}」[${u.roles.join('/') || 'untyped'}]`,
      ).join('；');
      return `- ${m.path}（${m.durationSec.toFixed(1)}s${m.tag ? `，${m.tag}` : ''}${units ? `，动作单元：${units}` : ''}）`;
    })
    : ['（无已有素材）'];
  const sources = [
    input.existing.length > 0 || input.strategy === 'existing-only' ? 'existing（复用已有素材，优先）' : null,
    input.stockAvailable && input.strategy !== 'existing-only' ? 'stock（免费商用素材搜索，搜索词用英文）' : null,
    input.imageGenAvailable && input.strategy !== 'existing-only' ? 'imagegen（文生图，英文提示词）' : null,
  ].filter(Boolean);
  // 挖矿体裁 + 长素材：流水线随后会挖高光浓缩，长素材只进一个承载段，避免被拆散到多段
  const hasLong = isPipelineMiningGenre(input.videoType) && input.existing.some((m) => m.durationSec >= 60);
  return [
    `你是${PIPELINE_PERSONAS[input.videoType].producer}。以下故事板片段需要配素材，请给出配置计划，严格输出 JSON（不要围栏/多余文字）：`,
    '{"assignments": [{"index": 段下标, "source": "existing|stock|imagegen|none", "existingPath": "复用素材的完整路径", "storyUnitIndex": 动作单元下标, "sourceStartSec": 原素材起始秒, "sourceEndSec": 原素材结束秒, "continuityRole": "establish|setup|action|result|reveal|detail|proof|reaction|transition", "stockQuery": "英文搜索词", "stockType": "video|photo", "imagePrompt": "英文生图提示词"}], "bgm": {"wantMood": "epic|upbeat|calm|sad|corporate|tense", "wantEnergy": "high|mid|low"}}',
    '',
    '需要素材的片段：',
    ...segLines,
    '已有素材清单（existing 只能从这里选）：',
    ...matLines,
    `可用素材源：${sources.join('；') || '无（全部 source=none，改用零素材模板的段不需要素材）'}`,
    'bgm 可省略（用户已有 BGM 或曲库为空时）。',
    '要求：先按整部片确定动作单元的全局顺序，再分配到段落；后段不得使用早于前段的动作阶段。setup→action→result 应保持递进；同一素材可连续覆盖多个段，但必须给出不同或连续的 storyUnitIndex 与准确时间窗。素材与文案内容强相关；每段只配 1 条；能复用已有素材就不新找。',
    ...(hasLong ? ['≥60s 的长素材只分配到 1 个段（流水线随后会自动挖高光把它浓缩成主体），同一条长素材不要塞进多个段。'] : []),
  ].join('\n');
};

export interface ParseMaterialsPlanOptions {
  existing?: ExistingMaterialBrief[];
  segmentCount?: number;
}

export const parseMaterialsPlan = (text: string, options: ParseMaterialsPlanOptions = {}): {ok: true; plan: MaterialsPlan} | {ok: false; error: string} => {
  const json = extractJsonText(text);
  if (!json) return {ok: false, error: '模型输出中未找到 JSON'};
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const arr = obj.assignments;
    if (!Array.isArray(arr)) return {ok: false, error: '缺少 assignments 数组'};
    const assignments: MaterialAssignment[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const a = raw as Record<string, unknown>;
      if (typeof a.index !== 'number' || !Number.isInteger(a.index)) continue;
      const source = a.source;
      if (source !== 'existing' && source !== 'stock' && source !== 'imagegen' && source !== 'none') continue;
      if (options.segmentCount !== undefined && (a.index < 0 || a.index >= options.segmentCount)) continue;
      const existingPath = typeof a.existingPath === 'string' ? a.existingPath : undefined;
      const material = existingPath ? options.existing?.find((m) => m.path === existingPath) : undefined;
      const duration = material?.durationSec;
      const rawStart = typeof a.sourceStartSec === 'number' && Number.isFinite(a.sourceStartSec) ? a.sourceStartSec : undefined;
      const rawEnd = typeof a.sourceEndSec === 'number' && Number.isFinite(a.sourceEndSec) ? a.sourceEndSec : undefined;
      let sourceStartSec = rawStart !== undefined
        ? Math.round(Math.max(0, duration !== undefined ? Math.min(duration, rawStart) : rawStart) * 100) / 100 : rawStart;
      let sourceEndSec = rawEnd !== undefined
        ? Math.round(Math.max(0, duration !== undefined ? Math.min(duration, rawEnd) : rawEnd) * 100) / 100 : rawEnd;
      if (sourceStartSec !== undefined && sourceEndSec !== undefined && sourceEndSec <= sourceStartSec) {
        sourceStartSec = undefined;
        sourceEndSec = undefined;
      }
      const rawUnitIndex = typeof a.storyUnitIndex === 'number' && Number.isInteger(a.storyUnitIndex) && a.storyUnitIndex >= 0
        ? a.storyUnitIndex : undefined;
      const storyUnitIndex = material?.storyUnits && rawUnitIndex !== undefined && rawUnitIndex < material.storyUnits.length
        ? rawUnitIndex : (material?.storyUnits ? undefined : rawUnitIndex);
      assignments.push({
        index: a.index,
        source,
        existingPath,
        stockQuery: typeof a.stockQuery === 'string' ? a.stockQuery.slice(0, 80) : undefined,
        stockType: a.stockType === 'photo' ? 'photo' : 'video',
        imagePrompt: typeof a.imagePrompt === 'string' ? a.imagePrompt.slice(0, 600) : undefined,
        storyUnitIndex,
        sourceStartSec,
        sourceEndSec,
        continuityRole: typeof a.continuityRole === 'string' && [
          'establish', 'setup', 'action', 'result', 'reveal', 'detail', 'proof', 'reaction', 'transition',
        ].includes(a.continuityRole) ? a.continuityRole as StoryRole : undefined,
      });
    }
    if (assignments.length === 0) return {ok: false, error: '没有有效的素材配置项'};
    const bgmRaw = obj.bgm as Record<string, unknown> | undefined;
    const bgm = bgmRaw && typeof bgmRaw === 'object'
      ? {
          wantMood: typeof bgmRaw.wantMood === 'string' ? bgmRaw.wantMood : undefined,
          wantEnergy: typeof bgmRaw.wantEnergy === 'string' ? bgmRaw.wantEnergy : undefined,
        }
      : undefined;
    return {ok: true, plan: {assignments, bgm: bgm && (bgm.wantMood || bgm.wantEnergy) ? bgm : undefined}};
  } catch (err) {
    return {ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`};
  }
};

// ====== 阶段 5：审片报告 → 改稿补丁 ======

export interface ReviewIssueBrief {
  segmentIndex?: number;
  severity: string;
  problem: string;
  suggestion: string;
}

export interface AutoFixSegmentBrief {
  index: number;
  templateId: string;
  title?: string;
  subtitle?: string;
  features?: string[];
  /** 段时长（秒）——时长类问题（文字读不完/旁白溢出）的修复依据 */
  duration?: number;
  /** 该段模板的可调参数简报（paramsBriefOf 产物；给出时补丁才可带 customParams） */
  paramsBrief?: string;
}

export interface AutoFixInput {
  /** 工程体裁（切换剪辑指导人设；补丁格式与体裁无关） */
  videoType: VideoType;
  overall: number;
  verdict: string;
  issues: ReviewIssueBrief[];
  segments: AutoFixSegmentBrief[];
  /** 本地可读性体检问题（零成本规则；VLM 看不到的文案时长类问题在这里） */
  lintIssues?: ReviewIssueBrief[];
  /** 音频审片问题（响度/爆音/静音/旁白比对；文案层修不了的会如实标注） */
  audioIssues?: string[];
}

/** 改稿补丁可指定的转场类型（与 TransitionType 枚举一致，解析时校验） */
export const AUTOFIX_TRANSITION_TYPES = [
  'none', 'crossfade', 'slide', 'wipe', 'iris', 'push', 'zoom', 'rotate', 'blur', 'flash', 'zoomIn', 'zoomOut', 'whip', 'flyThrough', 'panChase', 'orbitSwipe', 'cardSweep', 'shapeBloom',
] as const;

export const buildAutoFixPrompt = (input: AutoFixInput): string => {
  const issueLines = input.issues.map((i, n) =>
    `${n + 1}. ${i.severity}｜${i.segmentIndex !== undefined ? `第 ${i.segmentIndex} 段` : '全局'}｜${i.problem}｜建议：${i.suggestion}`,
  );
  const lintLines = (input.lintIssues ?? []).map((i, n) =>
    `${n + 1}. ${i.severity}｜${i.segmentIndex !== undefined ? `第 ${i.segmentIndex} 段` : '全局'}｜${i.problem}｜建议：${i.suggestion}`,
  );
  const audioLines = (input.audioIssues ?? []).map((s, n) => `${n + 1}. ${s}`);
  const segLines = input.segments.map((s) =>
    `- 第 ${s.index} 段（${s.templateId}，${s.duration ?? '?'}s）：标题「${s.title || '无'}」 副标题「${s.subtitle || '无'}」${s.features?.length ? ` 要点：${s.features.join('／')}` : ''}${s.paramsBrief ? `｜可调参数: ${s.paramsBrief}` : ''}`,
  );
  return [
    `你是${PIPELINE_PERSONAS[input.videoType].editor}。审片发现问题，请给出最小改稿补丁，严格输出 JSON 数组（不要围栏/多余文字）：`,
    '[{"index": 段下标, "title": "新标题", "subtitle": "新副标题", "features": ["新要点"], "templateId": "换模板id", "durationSec": 新时长秒, "customParams": {"参数键": 数值}, "transitionType": "转场类型", "transitionParams": {"durationSec": 0.2-2, "direction": 0-4}}]',
    '',
    '改稿准则（按问题类型选修复手段，全部字段都可省略，只给要改的）：',
    '- 文字可读性/措辞问题 → 改 title/subtitle/features（优先缩字数）',
    '- 文字读不完、旁白比段长、节奏太赶 → 给 durationSec 延长该段（2-60 秒）',
    '- 画面单调、模板感重、动效不合适 → 换 templateId，或按该段「可调参数」给 customParams（只给清单里有的键）',
    '- 转场生硬、衔接跳戏 → 给 transitionType（可选值：' + AUTOFIX_TRANSITION_TYPES.join('/') + '），方向类转场可配 transitionParams.direction（1上2下3左4右）',
    '- 只改有问题的段，不动其他段；一轮补丁控制在 1-4 处，每处都要有明确对应的问题条目',
    '',
    `审片总分 ${input.overall}/5（${input.verdict}）。画面问题清单：`,
    ...(issueLines.length > 0 ? issueLines : ['（无具体画面问题条目）']),
    ...(lintLines.length > 0 ? ['', '本地可读性体检（规则检出，必须处理）：', ...lintLines] : []),
    ...(audioLines.length > 0 ? ['', '音频问题（文案层修不了的不要硬改，跳过即可）：', ...audioLines] : []),
    '',
    '当前故事板：',
    ...segLines,
  ].join('\n');
};

export interface AutoFixPatch {
  index: number;
  title?: string;
  subtitle?: string;
  features?: string[];
  templateId?: string;
  /** 段新时长（秒，2-60 钳制） */
  durationSec?: number;
  /** 模板参数（与现有 customParams 合并；键合法性由 update_segment 校验器兜底） */
  customParams?: Record<string, number>;
  /** 转场类型（AUTOFIX_TRANSITION_TYPES 内才收） */
  transitionType?: string;
  transitionParams?: {durationSec?: number; direction?: number};
}

const AUTOFIX_TRANSITION_SET: ReadonlySet<string> = new Set(AUTOFIX_TRANSITION_TYPES);

export const parseAutoFix = (text: string): {ok: true; patches: AutoFixPatch[]} | {ok: false; error: string} => {
  const json = extractJsonText(text);
  if (!json) return {ok: false, error: '模型输出中未找到 JSON'};
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length === 0) return {ok: false, error: '补丁数组为空'};
    const patches: AutoFixPatch[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      if (typeof p.index !== 'number' || !Number.isInteger(p.index)) continue;
      // customParams：只收数值键值，最多 8 个，防模型乱写大对象
      let customParams: Record<string, number> | undefined;
      if (p.customParams && typeof p.customParams === 'object' && !Array.isArray(p.customParams)) {
        const cleaned: Record<string, number> = {};
        for (const [k, v] of Object.entries(p.customParams as Record<string, unknown>)) {
          if (Object.keys(cleaned).length >= 8) break;
          if (typeof v === 'number' && Number.isFinite(v) && k.length <= 32) cleaned[k] = Math.max(-1000, Math.min(1000, v));
        }
        if (Object.keys(cleaned).length > 0) customParams = cleaned;
      }
      let transitionParams: AutoFixPatch['transitionParams'];
      if (p.transitionParams && typeof p.transitionParams === 'object' && !Array.isArray(p.transitionParams)) {
        const tp = p.transitionParams as Record<string, unknown>;
        const cleaned: {durationSec?: number; direction?: number} = {};
        if (typeof tp.durationSec === 'number' && Number.isFinite(tp.durationSec)) {
          cleaned.durationSec = Math.max(0.2, Math.min(2, tp.durationSec));
        }
        if (typeof tp.direction === 'number' && Number.isFinite(tp.direction)) {
          cleaned.direction = Math.max(0, Math.min(4, Math.round(tp.direction)));
        }
        if (cleaned.durationSec !== undefined || cleaned.direction !== undefined) transitionParams = cleaned;
      }
      patches.push({
        index: p.index,
        title: typeof p.title === 'string' ? p.title.trim().slice(0, 40) : undefined,
        subtitle: typeof p.subtitle === 'string' ? p.subtitle.trim().slice(0, 60) : undefined,
        features: Array.isArray(p.features) ? p.features.filter((b): b is string => typeof b === 'string').slice(0, 4) : undefined,
        templateId: typeof p.templateId === 'string' && p.templateId.trim() ? p.templateId.trim() : undefined,
        durationSec: typeof p.durationSec === 'number' && Number.isFinite(p.durationSec)
          ? Math.max(2, Math.min(60, p.durationSec)) : undefined,
        customParams,
        transitionType: typeof p.transitionType === 'string' && AUTOFIX_TRANSITION_SET.has(p.transitionType) ? p.transitionType : undefined,
        transitionParams,
      });
    }
    if (patches.length === 0) return {ok: false, error: '没有有效的补丁项'};
    return {ok: true, patches};
  } catch (err) {
    return {ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`};
  }
};

// ====== 阶段 7：发布元数据 ======

export interface MetadataGenInput {
  /** 工程体裁：标题/简介/标签的风格口径随之切换 */
  videoType: VideoType;
  brief: string;
  segments: Array<{title?: string; subtitle?: string}>;
}

export const buildMetadataPrompt = (input: MetadataGenInput): string => {
  const segLines = input.segments.map((s, i) => `- 第 ${i} 段：${s.title || '无'}${s.subtitle ? `｜${s.subtitle}` : ''}`);
  return [
    '你是短视频运营。根据视频内容写发布元数据，严格输出 JSON（不要围栏/多余文字）：',
    '{"title": "视频标题（≤18 字，有钩子）", "description": "简介（80-160 字，含行动召唤）", "tags": ["标签1", "标签2"]}',
    '标签 6-10 个不带 #，覆盖主题词+行业词+流量词。',
    `本片体裁是「${VIDEO_TYPE_LABEL[input.videoType]}」。${METADATA_STYLE[input.videoType]}`,
    '',
    `原始需求：${input.brief}`,
    '成片各段文案：',
    ...segLines,
  ].join('\n');
};

export interface MetadataGen {
  title: string;
  description: string;
  tags: string[];
}

export const parseMetadataGen = (text: string): {ok: true; meta: MetadataGen} | {ok: false; error: string} => {
  const json = extractJsonText(text);
  if (!json) return {ok: false, error: '模型输出中未找到 JSON'};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 40) : '';
    if (!title) return {ok: false, error: '缺少 title'};
    return {
      ok: true,
      meta: {
        title,
        description: typeof o.description === 'string' ? o.description.trim().slice(0, 500) : '',
        tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
      },
    };
  } catch (err) {
    return {ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`};
  }
};
