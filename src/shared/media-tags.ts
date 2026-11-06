/**
 * 素材视觉打标（analyze_media_tags）——提示词、时间采样与解析（纯函数，Node 可直跑单测）。
 *
 * 模式：先用本地镜头切分提供有代表性的时间点，再把带时间戳的连续帧交给多模态模型。
 * 模型除静态描述外还产出动作单元（前态 → 动作 → 后态），存入 store.mediaTags。
 * 这让后续排片能理解一条素材如何发展，而不是把它当作一张孤立图片。
 */

export const STORY_ROLES = [
  'establish', 'setup', 'action', 'result', 'reveal', 'detail', 'proof', 'reaction', 'transition',
] as const;

export type StoryRole = (typeof STORY_ROLES)[number];

/** 一个可被排片器消费的连续动作单元，时间均为素材原始时间线秒数。 */
export interface MediaStoryUnit {
  startSec: number;
  endSec: number;
  /** 画面中的人、物、界面区域或操作对象 */
  subject: string;
  /** 这段开始时的状态；看不出时为空字符串 */
  before: string;
  /** 期间实际发生的动作或变化 */
  action: string;
  /** 动作结束后得到的状态或结果；看不出时为空字符串 */
  after: string;
  /** 可承担的叙事职责，供脚本/排片检索 */
  roles: StoryRole[];
}

export interface MediaStorySample {
  /** 素材原始时间线秒数 */
  timeSec: number;
  /** 对应的本地镜头下标；均匀采样时为 undefined */
  shotIndex?: number;
}

export interface MediaStoryParseOptions {
  /** 已知素材时长时，钳制模型返回的动作区间，避免脏数据进入工程 */
  durationSec?: number;
}

export interface MediaTag {
  /** 素材内容一句话描述（如「城市夜景航拍，车流光轨」） */
  description: string;
  /** 画面情绪（如 现代/科技感/温暖/自然/紧张/平静） */
  mood: string;
  /** 适配的视频场景（如 产品发布/科技品牌/生活方式/数据展示/vlog 记录） */
  scene: string;
  /** 画面质量备注（如「构图稳定」「轻微抖动」「低分辨率」；无明显问题可省） */
  note?: string;
  /** 整条素材按时间发展的简要摘要；供素材检索/计划层直接阅读 */
  temporalSummary?: string;
  /** 连续动作单元；旧工程缺省，重新打标时自动补齐 */
  storyUnits?: MediaStoryUnit[];
}

export const buildMediaTagPrompt = (framesNote: string): string => [
  '你是视频素材管理师兼剪辑助理。下面是同一条素材按时间顺序抽取的画面，每张都带时间戳。',
  '必须根据时间顺序理解事情如何发展，不要把多帧各自孤立描述，也不要臆测未出现的动作。',
  '请用中文严格输出 JSON（不要围栏、不要多余文字）：',
  '{"description":"一句话内容描述（主体+场景+光线）","mood":"画面情绪（2-4字）","scene":"适配的视频场景（2-8字）","note":"质量备注，无问题可省略","temporalSummary":"整条素材的变化链，例如 打开设置→输入参数→看到生成结果","storyUnits":[{"startSec":0,"endSec":2.4,"subject":"主体/界面区域","before":"动作前状态","action":"发生的动作或变化","after":"动作后状态","roles":["setup","action"]}]}',
  'storyUnits 切成 1-8 个连续区间，覆盖有意义的变化；静态素材也返回一个区间，action 写“保持展示”。roles 只能从 establish/setup/action/result/reveal/detail/proof/reaction/transition 中选择。',
  '',
  framesNote,
].join('\n');

/**
 * 规划给视觉模型的时序样本：优先跨本地镜头边界取代表帧，镜头不足时均匀覆盖。
 * 输出严格升序，调用方可按此顺序附加「时间戳文字 + 图片」消息。
 */
export const planMediaStorySamples = (
  durationSec: number,
  shots: Array<{startSec: number; endSec: number}> | undefined,
  maxFrames = 8,
): MediaStorySample[] => {
  const duration = Math.max(0, durationSec);
  if (duration <= 0) return [{timeSec: 0}];
  // 时间以百分之一秒输出，避免极短素材产生相同时间点而破坏严格时序。
  const n = Math.min(
    Math.max(2, Math.min(8, Math.round(maxFrames))),
    Math.max(1, Math.floor(duration * 100) + 1),
  );
  const rounded = (timeSec: number) => Math.round(timeSec * 100) / 100;
  const validShots = (shots ?? [])
    .map((shot, shotIndex) => ({
      startSec: Math.max(0, Math.min(duration, shot.startSec)),
      endSec: Math.max(0, Math.min(duration, shot.endSec)),
      shotIndex,
    }))
    .filter((shot) => shot.endSec - shot.startSec > 0.05);
  if (validShots.length > 0) {
    const count = Math.min(n, validShots.length);
    const selected: MediaStorySample[] = [];
    for (let i = 0; i < count; i++) {
      const index = Math.round((i * (validShots.length - 1)) / Math.max(1, count - 1));
      const shot = validShots[index];
      selected.push({
        timeSec: rounded((shot.startSec + shot.endSec) / 2),
        shotIndex: shot.shotIndex,
      });
    }
    // 镜头不够时，优先选离已有代表帧最远的均匀候选点，令样本仍分散在整条时间线上。
    const fillUniform = (count: number) => {
      const candidates = Array.from({length: count}, (_, i) => rounded(duration * ((i + 0.5) / count)));
      while (selected.length < n) {
        const choices = candidates.filter((timeSec) => !selected.some((sample) => sample.timeSec === timeSec));
        if (choices.length === 0) break;
        const timeSec = choices.reduce((best, candidate) => {
          const distance = (value: number) => Math.min(...selected.map((sample) => Math.abs(sample.timeSec - value)));
          return distance(candidate) > distance(best) ? candidate : best;
        });
        selected.push({timeSec});
      }
    };
    fillUniform(n);
    fillUniform(n * 4);
    for (let centisecond = 0; selected.length < n; centisecond++) {
      const timeSec = rounded(Math.min(duration, centisecond / 100));
      if (!selected.some((sample) => sample.timeSec === timeSec)) selected.push({timeSec});
    }
    return selected.sort((a, b) => a.timeSec - b.timeSec);
  }
  return Array.from({length: n}, (_, i) => ({
    timeSec: rounded(duration * ((i + 0.5) / n)),
  }));
};

const textOf = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const finiteSec = (value: unknown, fallback: number, durationSec: number | undefined): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const bounded = Math.max(0, n);
  return durationSec !== undefined && durationSec > 0 ? Math.min(bounded, durationSec) : bounded;
};

const parseStoryUnits = (value: unknown, options: MediaStoryParseOptions): MediaStoryUnit[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<string>(STORY_ROLES);
  const units: MediaStoryUnit[] = [];
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const unit = raw as Record<string, unknown>;
    const startSec = finiteSec(unit.startSec, 0, options.durationSec);
    const endSec = finiteSec(unit.endSec, startSec, options.durationSec);
    const action = textOf(unit.action, 120);
    if (!action || endSec - startSec < 0.05) continue;
    const roles = Array.isArray(unit.roles)
      ? Array.from(new Set(unit.roles.filter((role): role is StoryRole => typeof role === 'string' && allowed.has(role))))
      : [];
    units.push({
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round(endSec * 100) / 100,
      subject: textOf(unit.subject, 80),
      before: textOf(unit.before, 120),
      action,
      after: textOf(unit.after, 120),
      roles,
    });
  }
  return units.length > 0 ? units.sort((a, b) => a.startSec - b.startSec) : undefined;
};

/** 清洗来自模型或工程文件的素材标签，确保两条写入链路使用相同的数据约束。 */
export const sanitizeMediaTag = (value: unknown, options: MediaStoryParseOptions = {}): MediaTag | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const description = textOf(o.description, 120);
  if (!description) return null;
  return {
    description,
    mood: textOf(o.mood, 30),
    scene: textOf(o.scene, 60),
    note: textOf(o.note, 80) || undefined,
    temporalSummary: textOf(o.temporalSummary, 240) || undefined,
    storyUnits: parseStoryUnits(o.storyUnits, options),
  };
};

/** 防御性解析：剥围栏、截取首个 JSON 对象、字段校验；失败返回 null（调用方跳过该条） */
export const parseMediaTagResponse = (text: string, options: MediaStoryParseOptions = {}): MediaTag | null => {
  if (!text || typeof text !== 'string') return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  return sanitizeMediaTag(obj, options);
};

/** 给计划层的紧凑素材摘要：优先使用模型的时间摘要，回退到动作单元串联。 */
export const mediaTagStorySummary = (tag: MediaTag | undefined, max = 280): string | undefined => {
  if (!tag) return undefined;
  const temporal = tag.temporalSummary?.trim();
  if (temporal) return temporal.slice(0, max);
  const steps = (tag.storyUnits ?? [])
    .map((unit) => `${unit.startSec.toFixed(1)}-${unit.endSec.toFixed(1)}s ${unit.action}`)
    .join(' → ');
  if (steps) return steps.slice(0, max);
  return tag.description?.trim().slice(0, max) || undefined;
};
