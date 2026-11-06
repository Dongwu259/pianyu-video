/**
 * 全局素材排片（P1）。
 *
 * 这个模块只处理数据，不读工程、不调用模型：把故事板段落和素材的
 * storyUnits 变成一条单调的动作链。没有时序标签的素材仍可作为静态候选，
 * 因而旧工程可以继续走原来的素材计划。
 */

import type {MediaStoryUnit, StoryRole} from './media-tags.ts';

export interface EditPlanBeat {
  id: string;
  index: number;
  text?: string;
  startSec: number;
  endSec: number;
}

export interface EditPlanScene {
  id: string;
  beatId: string;
  index: number;
  title?: string;
  startSec: number;
  endSec: number;
}

export interface EditPlanShot {
  id: string;
  beatId: string;
  sceneId?: string;
  sourcePath: string;
  sourceStartSec: number;
  sourceEndSec: number;
  timelineStartSec: number;
  timelineEndSec: number;
  role?: StoryRole;
  visualDuty?: string;
  entryState?: string;
  exitState?: string;
  templateId?: string;
  narrationStartSec?: number;
  narrationEndSec?: number;
  captionIds?: string[];
  transition?: {type?: string; durationSec?: number; direction?: number};
  confidence: number;
  evidence?: string[];
  alternatives?: Array<{sourcePath: string; sourceStartSec?: number; sourceEndSec?: number; score?: number}>;
}

export interface EditPlanAudioCue {
  id: string;
  type: 'narration' | 'music' | 'sfx';
  startSec: number;
  endSec: number;
  text?: string;
  sourcePath?: string;
  volume?: number;
}

export interface EditPlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** 将大纲拍的自由文本职责压缩到素材动作链可理解的角色。 */
export const inferStoryRoleFromOutline = (
  beat: {role?: string; message?: string} | undefined,
): StoryRole | undefined => {
  if (!beat) return undefined;
  const text = `${beat.role ?? ''} ${beat.message ?? ''}`.toLowerCase();
  if (/准备|开场|铺垫|引入|setup|建立/.test(text)) return 'setup';
  if (/操作|步骤|过程|执行|使用|点击|教程|action/.test(text)) return 'action';
  if (/结果|完成|总结|收尾|结论|cta|成功/.test(text)) return 'result';
  if (/证明|数据|佐证|案例|口碑|效果|proof/.test(text)) return 'proof';
  if (/反应|反馈|reaction/.test(text)) return 'reaction';
  if (/细节|特写|detail/.test(text)) return 'detail';
  if (/环境|全景|场景|establish/.test(text)) return 'establish';
  if (/展示|亮点|揭示|高光|reveal/.test(text)) return 'reveal';
  return undefined;
};

export interface EditPlanMaterial {
  name: string;
  path: string;
  durationSec: number;
  tag?: string;
  storyUnits?: MediaStoryUnit[];
}

export interface EditPlanSegment {
  index: number;
  templateId?: string;
  title?: string;
  subtitle?: string;
  /** 目标片段时长；缺省时由素材窗口推导（兼容旧调用）。 */
  durationSec?: number;
  /** 调用方已知的职责；缺省由标题/模板名推断。 */
  continuityRole?: StoryRole;
}

export interface ContinuityAssignment {
  index: number;
  source: 'existing' | 'none';
  existingPath?: string;
  storyUnitIndex?: number;
  sourceStartSec?: number;
  sourceEndSec?: number;
  continuityRole?: StoryRole;
  continuityNote?: string;
}

export interface EditPlan {
  assignments: ContinuityAssignment[];
  notes: string[];
  version?: 1;
  beats?: EditPlanBeat[];
  scenes?: EditPlanScene[];
  shots?: EditPlanShot[];
  audio?: EditPlanAudioCue[];
  validation?: EditPlanValidation;
  /** 片段被手动修改后，原 shot 时间线不再保证与故事板一致。渲染器遇到 stale 会回退到段级渲染。 */
  stale?: boolean;
  staleReason?: string;
}

const finiteOr = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Deterministic validation for a hand-edited or model-produced plan. */
export const validateEditPlan = (
  plan: Partial<EditPlan> | unknown,
  materials: EditPlanMaterial[] = [],
  templateCapabilities: Record<string, {minVideos?: number; maxVideos?: number}> = {},
): EditPlanValidation => {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!plan || typeof plan !== 'object') return {ok: false, errors: ['EditPlan 必须是对象'], warnings};
  const p = plan as Partial<EditPlan>;
  const beats = Array.isArray(p.beats) ? p.beats : [];
  const scenes = Array.isArray(p.scenes) ? p.scenes : [];
  const shots = Array.isArray(p.shots) ? p.shots : [];
  const beatIds = new Set(beats.map((b) => b?.id).filter(Boolean));
  const sceneIds = new Set(scenes.map((s) => s?.id).filter(Boolean));
  for (const [i, b] of beats.entries()) {
    if (!b?.id || !Number.isFinite(b.startSec) || !Number.isFinite(b.endSec) || b.endSec <= b.startSec || b.startSec < 0) errors.push(`beat[${i}] 时间范围非法`);
    if (i > 0 && b.startSec < beats[i - 1].startSec) errors.push(`beat[${i}] 顺序倒退`);
  }
  for (const [i, s] of scenes.entries()) {
    if (!s?.id || !beatIds.has(s.beatId)) errors.push(`scene[${i}] beatId 无效`);
    if (!Number.isFinite(s.startSec) || !Number.isFinite(s.endSec) || s.endSec <= s.startSec || s.startSec < 0) errors.push(`scene[${i}] 时间范围非法`);
    if (i > 0 && s.startSec < scenes[i - 1].startSec) errors.push(`scene[${i}] 顺序倒退`);
  }
  const materialByPath = new Map(materials.map((m) => [m.path, m]));
  let previousTimeline = -Infinity;
  for (const [i, s] of shots.entries()) {
    if (!s?.id || !s.sourcePath) errors.push(`shot[${i}] 缺少 id/sourcePath`);
    if (!s) continue;
    if (beats.length > 0 && !beatIds.has(s.beatId)) errors.push(`shot[${i}] beatId 无效`);
    if (s.sceneId && !sceneIds.has(s.sceneId)) errors.push(`shot[${i}] sceneId 无效`);
    if (!Number.isFinite(s.sourceStartSec) || !Number.isFinite(s.sourceEndSec) || s.sourceEndSec <= s.sourceStartSec || s.sourceStartSec < 0) errors.push(`shot[${i}] source 时间范围非法`);
    if (!Number.isFinite(s.timelineStartSec) || !Number.isFinite(s.timelineEndSec) || s.timelineEndSec <= s.timelineStartSec || s.timelineStartSec < 0) errors.push(`shot[${i}] timeline 时间范围非法`);
    if (s.timelineStartSec < previousTimeline) errors.push(`shot[${i}] 时间线顺序倒退`);
    previousTimeline = s.timelineStartSec;
    const mat = materialByPath.get(s.sourcePath);
    if (!mat) warnings.push(`shot[${i}] 未找到素材 ${s.sourcePath}`);
    else if (s.sourceEndSec > mat.durationSec + 0.01) errors.push(`shot[${i}] sourceEnd 超过素材时长`);
    if (s.templateId && templateCapabilities[s.templateId]?.minVideos === 0) warnings.push(`shot[${i}] 模板 ${s.templateId} 不需要素材`);
    if (s.narrationStartSec !== undefined || s.narrationEndSec !== undefined) {
      if (finiteOr(s.narrationStartSec, 0) < 0 || finiteOr(s.narrationEndSec, 0) <= finiteOr(s.narrationStartSec, 0)) errors.push(`shot[${i}] narration 时间范围非法`);
    }
    if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) warnings.push(`shot[${i}] confidence 应为 0..1`);
  }
  for (const [i, cue] of (Array.isArray(p.audio) ? p.audio : []).entries()) {
    if (!cue) { errors.push(`audio[${i}] 时间范围非法`); continue; }
    if (!Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.endSec <= cue.startSec || cue.startSec < 0) errors.push(`audio[${i}] 时间范围非法`);
  }
  if (beats.length > 0 && shots.length > 0) {
    for (const beat of beats) if (!shots.some((s) => s.timelineStartSec < beat.endSec && s.timelineEndSec > beat.startSec)) warnings.push(`beat ${beat.id} 没有 shot 覆盖`);
  }
  return {ok: errors.length === 0, errors, warnings};
};

export const sanitizeEditPlan = (value: unknown): EditPlan | null => {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<EditPlan>;
  const plan: EditPlan = {
    version: 1,
    assignments: Array.isArray(p.assignments) ? p.assignments : [],
    notes: Array.isArray(p.notes) ? p.notes.filter((x): x is string => typeof x === 'string').slice(0, 100) : [],
    beats: Array.isArray(p.beats) ? p.beats : [],
    scenes: Array.isArray(p.scenes) ? p.scenes : [],
    shots: Array.isArray(p.shots) ? p.shots : [],
    audio: Array.isArray(p.audio) ? p.audio : [],
    ...(p.stale === true ? {stale: true} : {}),
    ...(typeof p.staleReason === 'string' ? {staleReason: p.staleReason.slice(0, 200)} : {}),
  };
  const validation = validateEditPlan(plan);
  return {...plan, validation};
};

/**
 * Enforce the number of clips a template can consume per beat. Plans are
 * model-authored and may contain more shots than a template supports; keep
 * the highest-confidence shots deterministically and report the reduction.
 */
export const constrainEditPlanShots = (
  plan: EditPlan,
  templateCapabilities: Record<string, {minVideos?: number; maxVideos?: number}> = {},
): EditPlan => {
  if (!plan.shots?.length) return plan;
  const byBeat = new Map<string, EditPlanShot[]>();
  for (const shot of plan.shots) {
    const list = byBeat.get(shot.beatId) ?? [];
    list.push(shot);
    byBeat.set(shot.beatId, list);
  }
  const beatTemplate = new Map((plan.beats ?? []).map((beat) => [beat.id, beat as EditPlanBeat & {templateId?: string}]));
  const notes = [...(plan.notes ?? [])];
  const kept: EditPlanShot[] = [];
  for (const [beatId, shots] of byBeat) {
    const beat = beatTemplate.get(beatId);
    const caps = shots
      .map((shot) => shot.templateId ? templateCapabilities[shot.templateId]?.maxVideos : undefined)
      .filter((v): v is number => typeof v === 'number');
    const cap = caps.length > 0 ? Math.min(...caps) : undefined;
    if (cap === 0) {
      notes.push(`beat ${beatId} 使用零素材模板，已移除 ${shots.length} 个 shot`);
      continue;
    }
    if (cap === undefined || shots.length <= cap) {
      kept.push(...shots);
      continue;
    }
    const ranked = [...shots].sort((a, b) =>
      (b.confidence - a.confidence) || (a.timelineStartSec - b.timelineStartSec) || a.id.localeCompare(b.id));
    const selected = new Set(ranked.slice(0, Math.max(1, cap)).map((shot) => shot.id));
    kept.push(...shots.filter((shot) => selected.has(shot.id)));
    notes.push(`beat ${beatId}${beat?.text ? `（${beat.text}）` : ''} 超过模板最多 ${cap} 条素材，已保留高置信度 shot`);
  }
  kept.sort((a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id));
  const next = {...plan, shots: kept, notes};
  return {...next, validation: validateEditPlan(next)};
};

/** Convert legacy segment assignments into a minimal executable shot timeline. */
export const compileEditPlan = (
  segments: EditPlanSegment[],
  materials: EditPlanMaterial[],
  assignments = planMaterialContinuity(segments, materials).assignments,
): EditPlan => {
  const beats: EditPlanBeat[] = [];
  const scenes: EditPlanScene[] = [];
  const shots: EditPlanShot[] = [];
  let cursor = 0;
  for (const segment of [...segments].sort((a, b) => a.index - b.index)) {
    const beatId = `beat-${segment.index}`;
    const assignment = assignments.find((a) => a.index === segment.index);
    const duration = Math.max(0.5, segment.durationSec !== undefined
      ? finite(segment.durationSec, 1)
      : assignment?.sourceEndSec !== undefined && assignment.sourceStartSec !== undefined
        ? assignment.sourceEndSec - assignment.sourceStartSec
        : 1);
    beats.push({id: beatId, index: segment.index, text: segment.title, startSec: cursor, endSec: cursor + duration});
    scenes.push({id: `scene-${segment.index}`, beatId, index: segment.index, title: segment.title, startSec: cursor, endSec: cursor + duration});
    if (assignment?.source === 'existing' && assignment.existingPath) shots.push({id: `shot-${segment.index}`, beatId, sceneId: `scene-${segment.index}`, sourcePath: assignment.existingPath, sourceStartSec: assignment.sourceStartSec ?? 0, sourceEndSec: assignment.sourceEndSec ?? (materials.find((m) => m.path === assignment.existingPath)?.durationSec ?? 1), timelineStartSec: cursor, timelineEndSec: cursor + duration, role: assignment.continuityRole, visualDuty: assignment.continuityNote, templateId: segment.templateId, confidence: assignment.storyUnitIndex === undefined ? 0.45 : 0.75});
    cursor += duration;
  }
  const plan: EditPlan = {version: 1, assignments, notes: ['由旧版段级素材分配编译为 shot 时间轴'], beats, scenes, shots};
  return {...plan, validation: validateEditPlan(plan, materials)};
};

const ROLE_WORDS: Array<[StoryRole, string[]]> = [
  ['setup', ['准备', '开始', '建立', '铺垫', 'setup', '开场']],
  ['action', ['操作', '步骤', '执行', '过程', 'action', '使用', '输入', '点击']],
  ['result', ['结果', '完成', '成功', '总结', '收尾', 'result', '结论', 'cta']],
  ['reveal', ['揭示', '展示', '高光', '亮相', 'reveal', '亮点']],
  ['proof', ['证明', '数据', '佐证', '案例', 'proof', '效果']],
  ['reaction', ['反应', '反馈', 'reaction', '口碑']],
  ['detail', ['细节', '特写', 'detail']],
  ['establish', ['环境', '全景', '建立场景', 'establish']],
];

/** 从段落文案推断一个宽泛职责，供没有显式 continuityRole 的旧故事板使用。 */
export const inferContinuityRole = (segment: Pick<EditPlanSegment, 'templateId' | 'title' | 'subtitle'>): StoryRole | undefined => {
  const text = `${segment.templateId ?? ''} ${segment.title ?? ''} ${segment.subtitle ?? ''}`.toLowerCase();
  for (const [role, words] of ROLE_WORDS) if (words.some((word) => text.includes(word.toLowerCase()))) return role;
  return undefined;
};

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** 将模型给出的时间窗限制在素材时长内；逆序/过短窗口回退为整段素材。 */
export const sanitizeSourceWindow = (
  start: unknown,
  end: unknown,
  durationSec: number,
): {startSec: number; endSec: number} => {
  const duration = Math.max(0, finite(durationSec, 0));
  const s = Math.max(0, Math.min(duration, finite(start, 0)));
  const e = Math.max(0, Math.min(duration, finite(end, duration)));
  if (e - s < 0.05) return {startSec: 0, endSec: duration};
  return {startSec: Math.round(s * 100) / 100, endSec: Math.round(e * 100) / 100};
};

const roleMatch = (unit: MediaStoryUnit | undefined, role: StoryRole | undefined): number => {
  if (!unit || !role) return 0;
  if (unit.roles.includes(role)) return 4;
  // setup/action/result 是最稳定的主链，允许 reveal/proof 等职责近似匹配。
  if (role === 'reveal' && unit.roles.includes('result')) return 1.5;
  if (role === 'proof' && (unit.roles.includes('result') || unit.roles.includes('detail'))) return 1;
  return 0;
};

/**
 * 为整个故事板一次性选素材动作单元。段落按 index 排序，素材复用时动作单元
 * 只能向前推进，因此不会出现“已经看到结果又跳回准备”的倒叙拼接。
 */
export const planMaterialContinuity = (
  segments: EditPlanSegment[],
  materials: EditPlanMaterial[],
): EditPlan => {
  const ordered = [...segments].sort((a, b) => a.index - b.index);
  const lastUnitByPath = new Map<string, number>();
  const usesByPath = new Map<string, number>();
  const assignments: ContinuityAssignment[] = [];
  const notes: string[] = [];

  for (const segment of ordered) {
    const role = segment.continuityRole ?? inferContinuityRole(segment);
    let best: {material: EditPlanMaterial; unitIndex?: number; score: number} | undefined;
    for (const material of materials) {
      const units = material.storyUnits ?? [];
      const last = lastUnitByPath.get(material.path);
      const candidates = units.length > 0
        ? units.map((unit, unitIndex) => ({unit, unitIndex})).filter(({unitIndex}) => last === undefined || unitIndex >= last)
        : [{unit: undefined, unitIndex: undefined}];
      for (const candidate of candidates) {
        const unit = candidate.unit;
        const progress = last !== undefined && candidate.unitIndex !== undefined
          ? (candidate.unitIndex > last ? 0.4 : -0.25)
          : 0;
        const score = roleMatch(unit, role) + progress
          + (unit ? 1 : 0)
          - (usesByPath.get(material.path) ?? 0) * 0.35
          - (last !== undefined && candidate.unitIndex === last ? 0.15 : 0)
          - (last !== undefined && candidate.unitIndex !== undefined ? Math.max(0, candidate.unitIndex - last - 1) * 0.08 : 0);
        if (!best || score > best.score) best = {material, unitIndex: candidate.unitIndex, score};
      }
    }
    if (!best) {
      assignments.push({index: segment.index, source: 'none', continuityRole: role});
      continue;
    }
    const {material, unitIndex} = best;
    const unit = unitIndex === undefined ? undefined : material.storyUnits?.[unitIndex];
    const window = sanitizeSourceWindow(unit?.startSec ?? 0, unit?.endSec ?? material.durationSec, material.durationSec);
    const prior = lastUnitByPath.get(material.path);
    if (unitIndex !== undefined) lastUnitByPath.set(material.path, unitIndex);
    usesByPath.set(material.path, (usesByPath.get(material.path) ?? 0) + 1);
    assignments.push({
      index: segment.index,
      source: 'existing',
      existingPath: material.path,
      ...(unitIndex !== undefined ? {storyUnitIndex: unitIndex, sourceStartSec: window.startSec, sourceEndSec: window.endSec} : {}),
      ...(role ? {continuityRole: role} : {}),
      continuityNote: unit
        ? `${material.name}：${unit.action}${prior !== undefined && unitIndex !== undefined && unitIndex >= prior ? '（沿用前段动作进度）' : ''}`
        : `${material.name}：无时序标签，按整条素材使用`,
    });
  }
  if (assignments.some((a) => a.storyUnitIndex !== undefined)) notes.push('已按动作单元全局排片，复用素材的动作阶段保持单调递进');
  else if (materials.length > 0) notes.push('已有素材没有动作单元，回退静态素材排片');
  return {assignments, notes};
};
