/**
 * Media Intelligence Layer: normalize all media understanding signals into one
 * compact, time ordered index. Analysis providers are optional; missing
 * signals are represented explicitly instead of being guessed.
 */

import type {MediaTag, MediaStoryUnit} from './media-tags.ts';
/** Structural subset of FootageMap kept here to avoid a shared -> main import. */
export interface FootageMapLike {
  durationSec: number;
  shots: Array<{startSec: number; endSec: number; motionScore: number}>;
}

export interface IntelligenceShot {
  id: string;
  startSec: number;
  endSec: number;
  motionScore?: number;
  evidence?: number[];
  confidence: number;
}

export interface IntelligenceActionUnit extends MediaStoryUnit {
  id: string;
  confidence: number;
  evidence?: number[];
}

export interface TrackedEntity {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
  confidence: number;
  boxes?: Array<{timeSec: number; x: number; y: number; width: number; height: number}>;
}

export interface TranscriptCue {
  startSec: number;
  endSec: number;
  text: string;
  confidence?: number;
}

export interface OcrCue {
  startSec: number;
  endSec: number;
  text: string;
  confidence?: number;
  box?: {x: number; y: number; width: number; height: number};
}

export interface MediaQualityMetrics {
  blur?: number;
  exposure?: number;
  shake?: number;
  audioLufs?: number;
  resolution?: {width: number; height: number};
  confidence?: number;
}

export interface EmbeddingRef {
  provider: string;
  model: string;
  vectorId?: string;
  dimensions?: number;
}

export interface MediaIntelligenceAsset {
  path: string;
  name: string;
  durationSec: number;
  type?: 'video' | 'image' | 'audio' | 'model';
  description?: string;
  mood?: string;
  scene?: string;
  temporalSummary?: string;
  shots: IntelligenceShot[];
  actions: IntelligenceActionUnit[];
  entities: TrackedEntity[];
  transcript: TranscriptCue[];
  ocr: OcrCue[];
  quality?: MediaQualityMetrics;
  embedding?: EmbeddingRef;
  confidence: number;
  updatedAt?: string;
}

export interface MediaIntelligenceIndex {
  version: 1;
  generatedAt: string;
  assets: Record<string, MediaIntelligenceAsset>;
}

const finite = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export const normalizeRange = (start: unknown, end: unknown, durationSec: number) => {
  const duration = Math.max(0, finite(durationSec, 0));
  const s = Math.max(0, Math.min(duration, finite(start, 0)));
  const e = Math.max(0, Math.min(duration, finite(end, duration)));
  return e > s ? {startSec: Math.round(s * 100) / 100, endSec: Math.round(e * 100) / 100} : null;
};

const normalizeShots = (shots: Array<Partial<IntelligenceShot>> | undefined, durationSec: number): IntelligenceShot[] => {
  const out: IntelligenceShot[] = [];
  for (const [i, raw] of (shots ?? []).entries()) {
    const range = normalizeRange(raw.startSec, raw.endSec, durationSec);
    if (!range) continue;
    out.push({id: raw.id || `shot-${i + 1}`, ...range, motionScore: raw.motionScore === undefined ? undefined : Math.max(0, Math.min(1, finite(raw.motionScore, 0))), evidence: raw.evidence?.filter((x): x is number => Number.isFinite(x)), confidence: Math.max(0, Math.min(1, finite(raw.confidence, 0.5)))});
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
};

const actionsFromTag = (tag: MediaTag | undefined, durationSec: number): IntelligenceActionUnit[] =>
  (tag?.storyUnits ?? []).flatMap((unit, i) => {
    const range = normalizeRange(unit.startSec, unit.endSec, durationSec);
    if (!range || !unit.action) return [];
    return [{...unit, ...range, id: `action-${i + 1}`, confidence: 0.65}];
  });

const shotsFromFootage = (map: FootageMapLike | undefined, durationSec: number): IntelligenceShot[] =>
  (map?.shots ?? []).flatMap((shot, i) => {
    const range = normalizeRange(shot.startSec, shot.endSec, durationSec);
    return range ? [{id: `shot-${i + 1}`, ...range, motionScore: Math.max(0, Math.min(1, finite(shot.motionScore, 0))), confidence: 0.9}] : [];
  });

export interface MediaAssetInput {
  path: string;
  name?: string;
  durationSec: number;
  type?: MediaIntelligenceAsset['type'];
  tag?: MediaTag;
  footage?: FootageMapLike;
  actions?: Array<Partial<IntelligenceActionUnit>>;
  entities?: TrackedEntity[];
  transcript?: TranscriptCue[];
  ocr?: OcrCue[];
  quality?: MediaQualityMetrics;
  embedding?: EmbeddingRef;
}

export const buildMediaIntelligenceAsset = (input: MediaAssetInput): MediaIntelligenceAsset => {
  const durationSec = Math.max(0, finite(input.durationSec, 0));
  const actions: IntelligenceActionUnit[] = [...actionsFromTag(input.tag, durationSec), ...(input.actions ?? []).flatMap((raw, i) => {
    const range = normalizeRange(raw.startSec, raw.endSec, durationSec);
    if (!range || !raw.action) return [];
    return [{subject: raw.subject ?? '', before: raw.before ?? '', action: raw.action, after: raw.after ?? '', roles: raw.roles ?? [], ...range, id: raw.id || `action-${i + 1}`, confidence: Math.max(0, Math.min(1, finite(raw.confidence, 0.5))), evidence: raw.evidence}];
  })].sort((a, b) => a.startSec - b.startSec);
  const shots = normalizeShots(shotsFromFootage(input.footage, durationSec).length ? shotsFromFootage(input.footage, durationSec) : undefined, durationSec);
  return {
    path: input.path,
    name: input.name ?? input.path.split(/[\\/]/).pop() ?? input.path,
    durationSec,
    type: input.type,
    description: input.tag?.description,
    mood: input.tag?.mood,
    scene: input.tag?.scene,
    temporalSummary: input.tag?.temporalSummary,
    shots,
    actions,
    entities: input.entities ?? [],
    transcript: input.transcript ?? [],
    ocr: input.ocr ?? [],
    quality: input.quality,
    embedding: input.embedding,
    confidence: Math.max(0, Math.min(1, input.tag || input.footage ? 0.8 : 0.25)),
  };
};

export const buildMediaIntelligenceIndex = (inputs: MediaAssetInput[], generatedAt = new Date().toISOString()): MediaIntelligenceIndex => ({
  version: 1,
  generatedAt,
  assets: Object.fromEntries(inputs.filter((x) => x.path).map((x) => [x.path, buildMediaIntelligenceAsset(x)])),
});

export const sanitizeMediaIntelligence = (value: unknown): MediaIntelligenceIndex | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {assets?: Record<string, unknown>; generatedAt?: unknown};
  if (!raw.assets || typeof raw.assets !== 'object') return null;
  const assets: Record<string, MediaIntelligenceAsset> = {};
  for (const [path, item] of Object.entries(raw.assets)) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Partial<MediaIntelligenceAsset>;
    if (!path || typeof a.durationSec !== 'number') continue;
    // `actions` is the canonical normalized action chain. Do not also expose it
    // through the legacy MediaTag.storyUnits field, otherwise rebuilding an
    // index after loading a project duplicates every action unit.
    const input: MediaAssetInput = {path, name: a.name, durationSec: a.durationSec, type: a.type, tag: a.description ? {description: a.description, mood: a.mood ?? '', scene: a.scene ?? '', temporalSummary: a.temporalSummary} : undefined, actions: a.actions, entities: a.entities, transcript: a.transcript, ocr: a.ocr, quality: a.quality, embedding: a.embedding};
    const normalized = buildMediaIntelligenceAsset(input);
    assets[path] = {...normalized, shots: normalizeShots(a.shots, normalized.durationSec), updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : undefined};
  }
  return {version: 1, generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date().toISOString(), assets};
};

/** LLM context friendly representation; never sends all frame data or embeddings. */
export const summarizeMediaIntelligence = (index: MediaIntelligenceIndex, maxAssets = 24, maxChars = 6000): string => {
  const rows = Object.values(index.assets).slice(0, Math.max(0, maxAssets)).map((a) => {
    const shots = a.shots.map((s) => `${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s${s.motionScore === undefined ? '' : ` m${s.motionScore.toFixed(2)}`}`).join(', ');
    const actions = a.actions.map((u) => `${u.startSec.toFixed(1)}-${u.endSec.toFixed(1)} ${u.action}`).join(' -> ');
    const transcript = a.transcript.map((c) => c.text).join(' ').slice(0, 180);
    return `${a.name} | ${a.description ?? ''} | timeline: ${a.temporalSummary ?? (actions || 'unknown')} | shots: ${shots || 'unknown'}${transcript ? ` | asr: ${transcript}` : ''}`;
  });
  return rows.join('\n').slice(0, Math.max(200, maxChars));
};

// ====== 转写回流（P0-4，docs/real-footage-genre-diagnosis.md）======
// 此前 mine_highlights 的 ASR 分段只进当次挖矿提示词，不回写 mediaIntelligence、
// 不随工程持久化也不返回给 agent——agent 永远看不到素材说了什么，每次挖矿重跑 ASR。
// 以下纯函数供挖矿执行器（复用/回写）与 get_segment_media（紧凑摘要）共用。

/** TranscriptCue → RawAsrSegment 命名转换（{startSec,endSec,text} → {start,end,text}），供挖矿时间线复用缓存 */
export const cuesToRawAsrSegments = (cues: TranscriptCue[]): Array<{start: number; end: number; text: string}> =>
  cues
    .filter((c) => c && typeof c.text === 'string' && c.text.trim() && Number.isFinite(c.startSec) && Number.isFinite(c.endSec))
    .map((c) => ({start: c.startSec, end: c.endSec, text: c.text.trim()}));

/** 转写摘要：区间内（缺省全片）cue 文本拼接，超长截断加省略号；空返回 '' */
export const digestTranscript = (
  cues: TranscriptCue[],
  range?: {startSec: number; endSec: number},
  maxChars = 80,
): string => {
  const inRange = range
    ? cues.filter((c) => c.endSec > range.startSec + 0.01 && c.startSec < range.endSec - 0.01)
    : cues;
  const text = inRange.map((c) => c.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
};

/** 转写关键词启发式（频次法）：拉丁词 + CJK 2-4 元组，滤停用成分；短 n-gram 与包含它的
 *  长 n-gram 同频时丢弃短的（「自动剪辑」×2 时不再同时报「自动/动剪/剪辑」的碎片），取前 max 个；确定性 */
const CJK_STOP_CHARS = new Set('的了是在和与有就也很到我们去你说他她它这那个都不没还又被让把上下中大小好以及为什么怎么'.split(''));
export const transcriptKeywords = (cues: TranscriptCue[], max = 8): string[] => {
  const text = cues.map((c) => c.text).join(' ');
  if (!text.trim()) return [];
  const freq = new Map<string, number>();
  const bump = (w: string) => freq.set(w, (freq.get(w) ?? 0) + 1);
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) bump(w);
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const gram = run.slice(i, i + n);
        if ([...gram].some((ch) => CJK_STOP_CHARS.has(ch))) continue;
        bump(gram);
      }
    }
  }
  // 最长频繁词优先：g 与某包含它的 g+1 元组同频 → g 是该长词的碎片，丢弃
  const entries = [...freq.entries()].filter(([w, n]) => n >= 2 && w.length >= 2);
  const kept = entries.filter(
    ([g, n]) => !entries.some(([h, m]) => m === n && h.length === g.length + 1 && h.includes(g)),
  );
  return kept
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
};
