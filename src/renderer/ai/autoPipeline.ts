/**
 * 全自动流水线 runner（渲染进程，后台异步执行）。
 *
 * run_auto_pipeline 工具只负责校验 + 一次性用户确认，真正流程在这里跑：
 * brief → LLM 写脚本建故事板 → 素材计划（复用已有/stock/文生图）→ 旁白/BGM →
 * 渲染 → VLM 审片 → 高危自动改稿重渲 → 封面 + 发布元数据。
 *
 * 设计要点：
 * - 复用 executeLlmTool 调既有工具（校验/确认/错误处理同一口径）；内部上下文
 *   requestConfirm 自动通过（入口处的一次确认覆盖全程），onRequestRender 不用——
 *   渲染直接走 startRenderFromStore 后台路径（与 MCP 桥一致），await 完整渲染结果
 * - 进度写 store.autoPipeline（瞬态），get_app_status 透出给轮询方；每步带 note、
 *   详细日志倒序截尾 60 条
 * - 每步 fail-safe：素材/旁白/审片/改稿/元数据失败只降级不终止；故事板生成与
 *   首次渲染失败才终止整条流水线
 */

import {useProjectStore} from '../store/projectStore';
import {executeLlmTool} from './toolExecutors';
import type {ToolExecContext, ToolExecResult} from './toolExecutors';
import {startRenderFromStore} from '../render/startRender';
import {mergeTemplateMetas, templateFitsVideoType} from '../../shared/template-registry';
import {slotLabelsOf} from '../../shared/template-slots';
import type {TemplateMeta, VideoClip} from '../../shared/types';
import {VIDEO_TYPE_LABEL} from '../../shared/video-type.ts';
import {suggestBgmTrimStartSec} from '../../shared/bgm-track';
import type {VideoType} from '../../shared/video-type.ts';
import {clipSrcToPath} from '../utils/clipPath';
import {
  PIPELINE_STEPS,
  PIPELINE_MINING_GENRES,
  isPipelineMiningGenre,
  buildOutlinePrompt, parseOutline,
  buildStoryboardGenPrompt, parseStoryboardGen,
  buildPolishPrompt, parsePolish, applyPolishPatches,
  buildMaterialsPlanPrompt, parseMaterialsPlan,
  buildAutoFixPrompt, parseAutoFix,
  buildMetadataPrompt, parseMetadataGen,
  buildPipelinePlanText,
  paramsBriefOf,
} from '../../shared/auto-pipeline';
import type {
  AutoPipelineState, AutoPipelineStep, StoryboardTemplateInfo,
  ExistingMaterialBrief, OutlineBeat,
} from '../../shared/auto-pipeline';
import {mediaTagStorySummary} from '../../shared/media-tags';
import type {MediaTag} from '../../shared/media-tags';
import {planMaterialContinuity, inferStoryRoleFromOutline, compileEditPlan, sanitizeSourceWindow, validateEditPlan} from '../../shared/edit-plan';
import type {EditPlanMaterial, ContinuityAssignment, EditPlanSegment, EditPlanShot} from '../../shared/edit-plan';
import {buildMediaIntelligenceIndex} from '../../shared/media-intelligence';
import {searchTemplateCatalog} from '../../shared/template-catalog';
import {planNarrationFit} from '../../shared/narration-fit';
import type {RunPipelineArgs} from '../../shared/llm-tools';
import type {TemplateAction, TemplateSlot, TemplateStyle} from '../../shared/types';

/** 单步超时不做（渲染本身可达数分钟）；仅约束 LLM 文本调用由服务层超时兜底 */

const now = () => Date.now();
const fmtSec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** 读当前流水线状态（runner 生命周期内 store 不会被别的写入者清空） */
const readState = (): AutoPipelineState | null => useProjectStore.getState().autoPipeline;

const writeState = (next: AutoPipelineState): void => {
  useProjectStore.getState().setAutoPipeline(next);
};

const setStep = (key: string, status: AutoPipelineStep['status'], note?: string): void => {
  const st = readState();
  if (!st) return;
  writeState({
    ...st,
    steps: st.steps.map((s) => (s.key === key ? {...s, status, ...(note !== undefined ? {note} : {})} : s)),
  });
};

const pipelineLog = (msg: string): void => {
  const st = readState();
  if (!st) return;
  writeState({...st, log: [`[${new Date().toLocaleTimeString('zh-CN', {hour12: false})}] ${msg}`, ...st.log].slice(0, 60)});
};

/** 流水线内部工具执行：自动确认（入口一次性确认覆盖全程），错误转 note 不抛出 */
const runTool = async (name: string, args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolExecResult> => {
  const autoCtx: ToolExecContext = {...ctx, requestConfirm: () => Promise.resolve(true)};
  return executeLlmTool(name, JSON.stringify(args), autoCtx);
};

const toolOk = (r: ToolExecResult): boolean => {
  const res = r.result as {ok?: boolean} | null;
  return Boolean(res && res.ok);
};

/** 纯文本 LLM 调用（无工具）；失败抛中文错误 */
const chatText = async (prompt: string): Promise<string> => {
  const reply = await window.api.llmChat({messages: [{role: 'user', content: prompt}]});
  if (typeof reply.content === 'string') return reply.content;
  if (Array.isArray(reply.content)) {
    return reply.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  }
  throw new Error('AI 助手返回空内容');
};

/** 渲染并等待完成（后台路径，与 MCP 桥同款）；失败抛中文错误。
 *  未配置输出目录不再终止：成片落到系统「视频」文件夹（主进程可信目录）。 */
const renderAndWait = async (): Promise<string> => {
  const store = useProjectStore.getState();
  if (!store.appSettings.defaultOutputDir) {
    pipelineLog('未配置默认输出目录：成片将保存到系统「视频」文件夹（可在设置里更改）');
  }
  const res = await startRenderFromStore(store.appSettings.defaultOutputDir, undefined, {
    whenNoOutputDir: 'videos',
    confirmMissingTemplates: false,
  });
  if (!res.success) {
    throw new Error(res.cancelled ? '渲染被取消' : (res.error || '渲染失败'));
  }
  return res.outputPath || '';
};

/**
 * 旁白时长护栏（TTS 合成后调用）：旁白比段长会溢出重叠到下一段。
 * 逐段检查——适度提速（≤1.4）重合成能放下就提速，放不下就把段延长到 旁白+0.4s 气口。
 * 返回各段处置说明（流水线日志用）。
 */
const guardNarrationFit = async (ctx: ToolExecContext): Promise<string[]> => {
  const notes: string[] = [];
  const count = useProjectStore.getState().segments.length;
  for (let i = 0; i < count; i++) {
    const read = () => useProjectStore.getState().segments[i];
    const seg = read();
    const n = seg?.narration;
    if (!seg || !n?.src || !n.duration) continue;
    const plan = planNarrationFit(seg.duration || 8, n.duration, n.speed ?? 1);
    if (plan.action === 'ok') continue;
    if (plan.action === 'speed') {
      const rs = await runTool('synthesize_narration', {index: i, speed: plan.speed}, ctx);
      const seg2 = read();
      const n2 = seg2?.narration;
      const fits = toolOk(rs) && !!seg2 && !!n2?.duration
        && planNarrationFit(seg2.duration || 8, n2.duration, n2.speed ?? 1).action === 'ok';
      if (fits) {
        notes.push(`段${i}:旁白溢出${plan.overflowSec.toFixed(1)}s→提速×${(n2!.speed ?? 1).toFixed(2)}`);
        continue;
      }
      // 提速失败或提速后仍溢出 → 落回延长段
      const extendTo = Math.round((((n2?.duration ?? n.duration) || 0) + 0.4) * 10) / 10;
      const re = await runTool('update_segment', {index: i, patch: {duration: extendTo}}, ctx);
      if (toolOk(re)) notes.push(`段${i}:旁白放不下→延长至${extendTo}s`);
      continue;
    }
    const re = await runTool('update_segment', {index: i, patch: {duration: plan.extendToSec}}, ctx);
    if (toolOk(re)) notes.push(`段${i}:旁白溢出${plan.overflowSec.toFixed(1)}s→延长至${plan.extendToSec}s`);
  }
  return notes;
};

// ====== 计划层共用：工程上下文采集 + 故事板生成 ======

/** 流水线执行与 plan_only 出计划共用的工程快照（采集时刻一致，两边口径相同） */
export interface PipelineContext {
  videoType: VideoType;
  orientation: 'landscape' | 'portrait';
  aspectRatioId: string;
  /** 全量模板（素材步骤的 minVideos 查表用） */
  templates: TemplateMeta[];
  /** 按体裁过滤后的提示词模板清单 */
  templateBriefs: StoryboardTemplateInfo[];
  /** id → 模板名（计划文本展示） */
  templateNames: Record<string, string>;
  existing: ExistingMaterialBrief[];
  longestExistingSec: number;
  /** vlog + ≥60s 长素材时给提示词预告挖矿 */
  miningPlannedSec?: number;
  hasExistingMaterials: boolean;
  stockAvailable: boolean;
  imageGenAvailable: boolean;
}

export const collectPipelineContext = async (): Promise<PipelineContext> => {
  const store = useProjectStore.getState();
  // set_storyboard 会整体重建故事板丢素材，先快照已有素材供计划与复用
  const existing: ExistingMaterialBrief[] = [];
  const tagSnapshot = {...store.mediaTags};
  const tagByPath = new Map<string, MediaTag | undefined>();
  store.segments.forEach((seg) => {
    for (const clip of seg.videos) {
      tagByPath.set(clipSrcToPath(clip.src), tagSnapshot[clip.src]);
      existing.push({
        name: clip.name,
        path: clipSrcToPath(clip.src),
        durationSec: clip.duration || 0,
        tag: mediaTagStorySummary(tagSnapshot[clip.src]),
        storyUnits: tagSnapshot[clip.src]?.storyUnits,
      });
    }
  });
  // 项目素材库（全局素材池）同样计入可用素材：用户「导入一次」的素材，AI 配段可直接取用
  for (const clip of store.mediaPool) {
    tagByPath.set(clipSrcToPath(clip.src), tagSnapshot[clip.src]);
    existing.push({
      name: clip.name,
      path: clipSrcToPath(clip.src),
      durationSec: clip.duration || 0,
      tag: mediaTagStorySummary(tagSnapshot[clip.src]),
      storyUnits: tagSnapshot[clip.src]?.storyUnits,
    });
  }
  // 将已有标签统一成紧凑的索引，供计划、审片和后续 LLM 查询复用。
  if (existing.length > 0) {
    const intelligence = buildMediaIntelligenceIndex(existing.map((item) => ({
      path: item.path, name: item.name, durationSec: item.durationSec,
      tag: tagByPath.get(item.path),
    })));
    store.setMediaIntelligence(intelligence);
  }
  const templates = mergeTemplateMetas(store.customTemplates, store.marketTemplates, store.generatedTemplates);
  const genreTemplates = templates.filter((t) => templateFitsVideoType(t, store.videoType));
  const longestExistingSec = existing.reduce((m, e) => Math.max(m, e.durationSec), 0);
  const [stockStatus, imageGenStatus] = await Promise.all([
    window.api.stockGetStatus().catch(() => ({pexels: false, pixabay: false})),
    window.api.imageGenGetStatus().catch(() => ({configured: false, baseUrl: '', model: ''})),
  ]);
  return {
    videoType: store.videoType,
    orientation: store.orientation,
    aspectRatioId: store.aspectRatioId,
    templates,
    templateBriefs: genreTemplates.map((t) => ({
      id: t.id, name: t.name, description: t.description,
      minVideos: t.minVideos, maxVideos: t.maxVideos, defaultDuration: t.defaultDuration,
      slotLabels: slotLabelsOf(t),
      paramsBrief: paramsBriefOf(t.paramSpecs),
    })),
    templateNames: Object.fromEntries(templates.map((t) => [t.id, t.name])),
    existing,
    longestExistingSec,
    miningPlannedSec: isPipelineMiningGenre(store.videoType) && longestExistingSec >= 60 ? longestExistingSec : undefined,
    hasExistingMaterials: existing.length > 0,
    stockAvailable: Boolean(stockStatus.pexels || stockStatus.pixabay),
    imageGenAvailable: Boolean(imageGenStatus.configured),
  };
};

/** Rebuild the executable shot timeline from the clips that are actually in the
 * store. Material planning runs before downloads, so this second pass is needed
 * to include stock/imagegen clips and any montage/mining changes. */
const rebuildActualEditPlan = (outlineBeats?: OutlineBeat[]): void => {
  const store = useProjectStore.getState();
  const byPath = new Map<string, EditPlanMaterial>();
  const segmentPaths = new Map<number, string[]>();
  for (const [index, segment] of store.segments.entries()) {
    const paths: string[] = [];
    for (const clip of segment.videos ?? []) {
      const path = clipSrcToPath(clip.src);
      if (!path) continue;
      paths.push(path);
      const asset = store.mediaIntelligence?.assets[path];
      const tag = store.mediaTags[clip.src];
      const existing = byPath.get(path);
      const durationSec = Math.max(existing?.durationSec ?? 0, clip.duration || segment.duration || 0.1);
      byPath.set(path, {
        path,
        name: clip.name,
        durationSec,
        tag: asset?.description ?? tag?.description,
        storyUnits: asset?.actions?.length ? asset.actions : tag?.storyUnits,
      });
    }
    segmentPaths.set(index, [...new Set(paths)]);
  }
  const materials = [...byPath.values()];
  const segmentSpecs: EditPlanSegment[] = store.segments.map((segment, index) => ({
    index,
    templateId: segment.templateId,
    title: segment.text?.title,
    subtitle: segment.text?.subtitle,
    durationSec: segment.duration,
    continuityRole: outlineBeats?.[index] ? inferStoryRoleFromOutline(outlineBeats[index]) : undefined,
  }));
  const baseline = planMaterialContinuity(segmentSpecs, materials).assignments;
  const assignments: ContinuityAssignment[] = segmentSpecs.map((segment) => {
    const candidates = segmentPaths.get(segment.index) ?? [];
    if (candidates.length === 0) return {index: segment.index, source: 'none', continuityRole: segment.continuityRole};
    const planned = baseline.find((a) => a.index === segment.index);
    if (planned?.source === 'existing' && planned.existingPath && candidates.includes(planned.existingPath)) return planned;
    const path = candidates[0];
    const material = byPath.get(path);
    const role = segment.continuityRole;
    const unit = material?.storyUnits?.find((candidate) => !role || candidate.roles.includes(role)) ?? material?.storyUnits?.[0];
    const window = sanitizeSourceWindow(unit?.startSec ?? 0, unit?.endSec ?? material?.durationSec ?? 0.1, material?.durationSec ?? 0.1);
    return {
      index: segment.index,
      source: 'existing',
      existingPath: path,
      ...(unit ? {storyUnitIndex: material?.storyUnits?.indexOf(unit), sourceStartSec: window.startSec, sourceEndSec: window.endSec} : {}),
      ...(role ? {continuityRole: role} : {}),
      continuityNote: unit ? `${material?.name ?? path}：${unit.action}` : `${material?.name ?? path}：按当前片段素材使用`,
    };
  });
  const basePlan = compileEditPlan(segmentSpecs, materials, assignments);

  // A segment can contain a continuous action chain. Templates whose contract
  // accepts multiple videos (RevealSlide, VideoCut variants, montage cards,
  // etc.) can render those windows as an ordered sequence. Expand the primary
  // assignment with later action units while keeping the source progress
  // monotonic for each reused asset. The duration guard avoids turning a
  // short beat into a burst of unreadable sub-second cuts.
  const templateById = new Map(
    mergeTemplateMetas(store.customTemplates, store.marketTemplates, store.generatedTemplates)
      .map((template) => [template.id, template] as const),
  );
  const nextUnitByPath = new Map<string, number>();
  const consumedWholeAsset = new Set<string>();
  const reservedUnitIndices = new Map<string, Set<number>>();
  for (const assignment of assignments) {
    if (assignment.existingPath === undefined || assignment.storyUnitIndex === undefined) continue;
    const indices = reservedUnitIndices.get(assignment.existingPath) ?? new Set<number>();
    indices.add(assignment.storyUnitIndex);
    reservedUnitIndices.set(assignment.existingPath, indices);
  }
  const expandedShots: EditPlanShot[] = [];
  for (const segment of segmentSpecs) {
    const primary = basePlan.shots?.find((shot) => shot.beatId === `beat-${segment.index}`);
    if (!primary) continue;
    const material = byPath.get(primary.sourcePath);
    const templateMax = segment.templateId ? templateById.get(segment.templateId)?.maxVideos : undefined;
    const maxVideos = templateMax === undefined ? 1 : Math.max(0, Math.round(templateMax));
    if (maxVideos === 0) continue;
    const minimumShotSec = 0.75;
    const duration = Math.max(0.5, segment.durationSec ?? (primary.timelineEndSec - primary.timelineStartSec));
    const durationCap = Math.max(1, Math.floor(duration / minimumShotSec));
    const targetCount = Math.min(maxVideos, durationCap);
    const segmentCandidates = segmentPaths.get(segment.index) ?? [];
    const shots: EditPlanShot[] = [{...primary, templateId: segment.templateId}];
    const assignment = assignments.find((item) => item.index === segment.index);
    const primaryUnitIndex = assignment?.storyUnitIndex;
    if (assignment?.storyUnitIndex !== undefined) {
      nextUnitByPath.set(primary.sourcePath, Math.max(nextUnitByPath.get(primary.sourcePath) ?? 0, assignment.storyUnitIndex + 1));
    } else if (!material?.storyUnits?.length) {
      consumedWholeAsset.add(primary.sourcePath);
    }

    while (shots.length < targetCount) {
      let picked: {path: string; unitIndex?: number; unit?: NonNullable<EditPlanMaterial['storyUnits']>[number]} | undefined;
      for (const path of segmentCandidates) {
        if (shots.some((shot) => shot.sourcePath === path && !material?.storyUnits?.length)) continue;
        const candidateMaterial = byPath.get(path);
        if (!candidateMaterial) continue;
        const units = candidateMaterial.storyUnits ?? [];
        if (units.length === 0) {
          if (consumedWholeAsset.has(path)) continue;
          picked = {path};
          break;
        }
        const start = nextUnitByPath.get(path) ?? 0;
        const role = segment.continuityRole;
        const unitIndex = units.findIndex((unit, index) => index >= start && (!role || unit.roles.includes(role)));
        const isAvailable = (index: number) => index >= start &&
          !(reservedUnitIndices.get(path)?.has(index) && !(path === primary.sourcePath && index === primaryUnitIndex));
        const fallbackIndex = unitIndex >= 0 && isAvailable(unitIndex)
          ? unitIndex
          : units.findIndex((_unit, index) => isAvailable(index));
        if (fallbackIndex >= 0) {
          picked = {path, unitIndex: fallbackIndex, unit: units[fallbackIndex]};
          break;
        }
      }
      if (!picked) break;
      const pickedMaterial = byPath.get(picked.path)!;
      if (picked.unitIndex !== undefined && picked.unit) {
        nextUnitByPath.set(picked.path, picked.unitIndex + 1);
        const window = sanitizeSourceWindow(picked.unit.startSec, picked.unit.endSec, pickedMaterial.durationSec);
        shots.push({
          ...primary,
          id: `${primary.id}-action-${shots.length + 1}`,
          sourcePath: picked.path,
          sourceStartSec: window.startSec,
          sourceEndSec: window.endSec,
          role: segment.continuityRole,
          visualDuty: `${pickedMaterial.name}：${picked.unit.action}`,
          confidence: 0.72,
          templateId: segment.templateId,
        });
      } else {
        consumedWholeAsset.add(picked.path);
        shots.push({
          ...primary,
          id: `${primary.id}-asset-${shots.length + 1}`,
          sourcePath: picked.path,
          sourceStartSec: 0,
          sourceEndSec: pickedMaterial.durationSec,
          confidence: 0.45,
          templateId: segment.templateId,
        });
      }
    }

    // The renderer uses the segment duration to schedule template slots. Keep
    // the formal plan's shot ranges in the same order and beat window so the
    // plan remains auditable even when a template distributes slots itself.
    const beat = basePlan.beats?.find((item) => item.id === `beat-${segment.index}`);
    const beatStart = beat?.startSec ?? primary.timelineStartSec;
    const slice = duration / shots.length;
    expandedShots.push(...shots.map((shot, index) => ({
      ...shot,
      timelineStartSec: Math.round((beatStart + index * slice) * 100) / 100,
      timelineEndSec: Math.round((beatStart + (index + 1) * slice) * 100) / 100,
    })));
  }
  const planCandidate = {...basePlan, shots: expandedShots, notes: [
    ...basePlan.notes,
    ...(expandedShots.length > (basePlan.shots?.length ?? 0) ? ['已按模板素材上限展开连续动作 shot'] : []),
  ]};
  const templateCapabilities = Object.fromEntries(
    [...templateById.entries()].map(([id, template]) => [id, {minVideos: template.minVideos, maxVideos: template.maxVideos}]),
  );
  const plan = {...planCandidate, validation: validateEditPlan(planCandidate, materials, templateCapabilities)};
  store.setEditPlan(plan);
  pipelineLog(`正式 EditPlan 已按实际素材重建：${plan.shots?.length ?? 0} 个 shot，${materials.length} 条素材，校验${plan.validation?.ok ? '通过' : '需处理'}`);
};

const templateInfoOf = (t: TemplateMeta): StoryboardTemplateInfo => ({
  id: t.id, name: t.name, description: t.description,
  minVideos: t.minVideos, maxVideos: t.maxVideos, defaultDuration: t.defaultDuration,
  slotLabels: slotLabelsOf(t), paramsBrief: paramsBriefOf(t.paramSpecs),
  styles: t.styles, actions: t.actions, searchTags: t.searchTags,
});

const textHas = (text: string, words: string[]): boolean => words.some((w) => text.includes(w));

const slotForOutline = (beat: OutlineBeat): TemplateSlot => {
  const text = `${beat.role} ${beat.message}`.toLowerCase();
  if (textHas(text, ['钩子', '开场', 'hook', '痛点', '问题'])) return 'hook';
  if (textHas(text, ['数据', '指标', '数字', 'count', '统计'])) return 'data';
  if (textHas(text, ['证据', '佐证', '口碑', '案例', 'proof', '客户'])) return 'proof';
  if (textHas(text, ['步骤', '流程', '过程', '教程', '操作', 'story'])) return 'story';
  if (textHas(text, ['收尾', '结尾', 'cta', '行动', '关注'])) return 'cta';
  if (textHas(text, ['素材', '画面', '镜头', '记录', 'vlog'])) return 'media';
  return 'showcase';
};

const styleForVideoType = (videoType: VideoType): TemplateStyle => ({
  promo: 'cinematic', vlog: 'documentary', talkingHead: 'editorial', tutorial: 'tech', montage: 'bold',
}[videoType] as TemplateStyle);

const actionForOutline = (beat: OutlineBeat): TemplateAction | undefined => {
  const text = `${beat.role} ${beat.message} ${beat.mood ?? ''}`.toLowerCase();
  if (textHas(text, ['对比', '前后', 'before', 'after'])) return 'compare';
  if (textHas(text, ['数据', '数字', '指标', '%', 'count'])) return 'count';
  if (textHas(text, ['步骤', '列表', '清单', '要点', '教程'])) return 'list';
  if (textHas(text, ['时间线', '历程', '路线'])) return 'timeline';
  if (textHas(text, ['点击', '鼠标', '界面', '操作', '录屏'])) return 'cursor';
  if (textHas(text, ['快切', '卡点', '蒙太奇', '合集'])) return 'montage';
  if (textHas(text, ['推近', '特写', '聚焦'])) return 'zoom';
  if (textHas(text, ['揭示', '展示', '亮相', '开场', '钩子'])) return 'reveal';
  return undefined;
};

/** 按大纲拍检索少量候选，避免把数百个模板塞进单次 LLM 上下文。 */
const templateBriefsForStoryboard = (c: PipelineContext, beats?: OutlineBeat[]): StoryboardTemplateInfo[] => {
  const selected: TemplateMeta[] = [];
  const seen = new Set<string>();
  const add = (items: TemplateMeta[]) => {
    for (const t of items) if (!seen.has(t.id) && selected.length < 16) { seen.add(t.id); selected.push(t); }
  };
  if (beats?.length) {
    for (const beat of beats) {
      const slot = slotForOutline(beat);
      const result = searchTemplateCatalog(c.templates, {
        videoType: c.videoType, slot, style: styleForVideoType(c.videoType),
        ...(actionForOutline(beat) ? {action: actionForOutline(beat)} : {}),
        query: beat.message,
        ...(slot === 'media' ? {needsMedia: true} : {}),
        limit: 4,
      });
      add(result.templates);
      // 每拍额外保留一个零素材备选，避免候选池被素材模板占满。
      if (slot !== 'media') {
        add(searchTemplateCatalog(c.templates, {
          videoType: c.videoType, slot, style: styleForVideoType(c.videoType), needsMedia: false, limit: 1,
        }).templates);
      }
    }
  } else {
    for (const slot of ['hook', 'showcase', 'media', 'data', 'proof', 'story', 'cta'] as TemplateSlot[]) {
      add(searchTemplateCatalog(c.templates, {videoType: c.videoType, slot, style: styleForVideoType(c.videoType), limit: 2}).templates);
      if (selected.length >= 12) break;
    }
  }
  if (selected.length === 0) add(searchTemplateCatalog(c.templates, {videoType: c.videoType, limit: 12}).templates);
  return selected.map(templateInfoOf);
};

/** 故事板三阶段生成结果（outlineUsed/polished 供流水线日志与计划文本标注） */
export type PipelineStoryboardGen =
  | {ok: true; segments: Array<Record<string, unknown>>; outlineUsed: boolean; polished: boolean; outlineBeats?: OutlineBeat[]}
  | {ok: false; error: string};

/**
 * brief → 故事板片段 JSON，三阶段链路：大纲（叙事骨架）→ 分镜（逐拍落模板+参数）→ 润色（文案打磨）。
 * 大纲/润色失败自动降级（回退单次分镜 / 保留原文案），只有分镜本身失败才报错。
 * validationError 非空 = 上次分镜被校验拒绝，回喂重试（跳过大纲与润色，直接修正分镜）。
 */
export const generatePipelineStoryboard = async (
  args: Pick<RunPipelineArgs, 'brief' | 'targetDurationSec' | 'aspectRatioId'>,
  c: PipelineContext,
  validationError?: string,
): Promise<PipelineStoryboardGen> => {
  // 阶段 1：叙事大纲（校验重试时跳过——直接带错误修分镜）
  let outlineBeats: OutlineBeat[] | undefined;
  if (!validationError) {
    try {
      const outlineText = await chatText(buildOutlinePrompt({
        brief: args.brief,
        videoType: c.videoType,
        targetDurationSec: args.targetDurationSec ?? 30,
        orientation: c.orientation,
      }));
      const outline = parseOutline(outlineText);
      if (outline.ok) outlineBeats = outline.beats;
      else pipelineLog(`大纲解析失败（回退单次分镜）：${outline.error}`);
    } catch (err) {
      pipelineLog(`大纲生成失败（回退单次分镜）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 阶段 2：分镜（有大纲则逐拍落实）
  const candidateBriefs = templateBriefsForStoryboard(c, outlineBeats);
  pipelineLog(`模板目录检索：${c.templateBriefs.length} 个体裁候选 → ${candidateBriefs.length} 个分镜候选${outlineBeats?.length ? `（按 ${outlineBeats.length} 个大纲拍）` : ''}`);
  const prompt = buildStoryboardGenPrompt({
    brief: args.brief,
    videoType: c.videoType,
    orientation: c.orientation,
    aspectRatioId: args.aspectRatioId || c.aspectRatioId,
    targetDurationSec: args.targetDurationSec ?? 30,
    templates: candidateBriefs,
    hasExistingMaterials: c.hasExistingMaterials,
    stockAvailable: c.stockAvailable,
    imageGenAvailable: c.imageGenAvailable,
    ...(c.miningPlannedSec ? {miningPlannedSec: c.miningPlannedSec} : {}),
    ...(outlineBeats ? {outlineBeats} : {}),
    templateSearchSummary: outlineBeats
      ? `已按 ${outlineBeats.length} 个大纲拍分别检索，去重后提供少量候选；只能使用清单中的 templateId`
      : '未生成大纲，按体裁关键槽位检索默认候选；只能使用清单中的 templateId',
  });
  const text = await chatText(validationError
    ? `${prompt}\n\n注意：你上次的输出被校验拒绝，错误：${validationError}。请修正后重新输出。`
    : prompt);
  const parsed = parseStoryboardGen(text);
  if (!parsed.ok) return {ok: false, error: parsed.error};
  // 阶段 3：文案润色（校验重试时跳过；失败保留原文案）
  let polished = false;
  if (!validationError) {
    try {
      const polishText = await chatText(buildPolishPrompt({
        videoType: c.videoType,
        segments: parsed.segments.map((s, index) => {
          const t = (s.text ?? {}) as Record<string, unknown>;
          const n = (s.narration ?? {}) as Record<string, unknown>;
          return {
            index,
            templateId: String(s.templateId ?? ''),
            title: typeof t.title === 'string' ? t.title : undefined,
            subtitle: typeof t.subtitle === 'string' ? t.subtitle : undefined,
            features: Array.isArray(t.features) ? t.features.filter((f): f is string => typeof f === 'string') : undefined,
            narration: typeof n.text === 'string' ? n.text : undefined,
          };
        }),
      }));
      const polish = parsePolish(polishText);
      if (polish.ok) {
        parsed.segments = applyPolishPatches(parsed.segments, polish.patches);
        polished = true;
      } else {
        pipelineLog(`润色解析失败（保留原文案）：${polish.error}`);
      }
    } catch (err) {
      pipelineLog(`文案润色失败（保留原文案）：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {ok: true, segments: parsed.segments, outlineUsed: Boolean(outlineBeats), polished, ...(outlineBeats ? {outlineBeats} : {})};
};

/**
 * plan_only 出计划：一次 LLM 调用生成故事板计划，同步返回可读文本 + segments JSON。
 * 不启动流水线、不改任何工程状态、不渲染——确认/修改后再用 segments 执行。
 */
export const planAutoPipeline = async (args: RunPipelineArgs): Promise<ToolExecResult> => {
  const llmConfigured = Boolean(await window.api.llmGetStatus?.().then((s) => s.configured).catch(() => false));
  if (!llmConfigured) {
    return {result: {ok: false, errors: ['未配置 AI 助手：请先在「设置 → AI 助手」配置服务地址/模型/Key']}};
  }
  let c: PipelineContext;
  try {
    c = await collectPipelineContext();
  } catch (err) {
    return {result: {ok: false, errors: [`工程状态读取失败：${err instanceof Error ? err.message : String(err)}`]}};
  }
  let gen: Awaited<ReturnType<typeof generatePipelineStoryboard>>;
  try {
    gen = await generatePipelineStoryboard(args, c);
  } catch (err) {
    return {result: {ok: false, errors: [`计划生成调用失败：${stripIpc(err)}`]}};
  }
  if (!gen.ok) {
    return {result: {ok: false, errors: [`计划生成失败：${gen.error}（输出无法解析为 JSON，重试一次通常可解决）`]}};
  }
  const total = gen.segments.reduce((sum, s) => sum + (typeof s.duration === 'number' ? s.duration : 0), 0);
  const planText = buildPipelinePlanText({
    videoType: c.videoType,
    segments: gen.segments,
    templateNames: c.templateNames,
    targetDurationSec: args.targetDurationSec ?? 30,
    narration: args.narration ?? true,
    materials: args.materials ?? 'auto',
    ...(c.miningPlannedSec ? {miningPlannedSec: c.miningPlannedSec} : {}),
    hasExistingMaterials: c.hasExistingMaterials,
    stockAvailable: c.stockAvailable,
    imageGenAvailable: c.imageGenAvailable,
  });
  return {result: {
    ok: true,
    planOnly: true,
    plan: {segments: gen.segments, segmentCount: gen.segments.length, totalDurationSec: Math.round(total * 10) / 10},
    planText,
    message: '成片计划已生成（未执行、未修改工程）。把 planText 给用户过目：确认无误就用 run_auto_pipeline(segments=plan.segments 原样) 执行；要改哪段先改 segments 再执行（执行时校验失败会原样报错、不会自动重写，保护人工修改）。',
  }};
};

const stripIpc = (err: unknown): string => String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const startAutoPipeline = async (
  args: RunPipelineArgs,
  ctx: ToolExecContext,
): Promise<ToolExecResult> => {
  const store0 = useProjectStore.getState();
  // 前置快查（详细原因在对应步骤给）；输出目录不再前置阻断——渲染阶段自动落到系统视频文件夹
  const llmConfigured = Boolean(await window.api.llmGetStatus?.().then((s) => s.configured).catch(() => false));
  // 体裁快照：人设/结构/挖掘环节按它切换；流水线中途 set_video_type 不影响本次执行
  const videoType = store0.videoType;

  const state: AutoPipelineState = {
    status: 'running',
    brief: args.brief,
    videoType,
    options: {
      targetDurationSec: args.targetDurationSec ?? 30,
      reviewRounds: args.reviewRounds ?? 1,
      narration: args.narration ?? true,
      materials: args.materials ?? 'auto',
    },
    startedAt: now(),
    steps: PIPELINE_STEPS.map((s) => ({...s, status: 'pending' as const})),
    log: [],
  };
  writeState(state);
  pipelineLog(`流水线启动（体裁「${VIDEO_TYPE_LABEL[videoType]}」）：${args.brief.slice(0, 80)}`);

  // 异步执行：工具立即返回，进度靠 store
  void (async () => {
    const outputs: AutoPipelineState['outputs'] = {};
    try {
      if (!llmConfigured) throw new Error('未配置 AI 助手：请先在「设置 → AI 助手」配置服务地址/模型/Key');

      // ===== 阶段 1：故事板（生成，或使用已确认的 segments 计划）=====
      setStep('storyboard', 'running');
      const t1 = now();
      const c = await collectPipelineContext();
      if (c.templateBriefs.length < c.templates.length) {
        pipelineLog(`模板清单按体裁「${VIDEO_TYPE_LABEL[c.videoType]}」过滤：${c.templates.length} → ${c.templateBriefs.length}`);
      }
      // 画幅覆盖（如指定）
      if (args.aspectRatioId && args.aspectRatioId !== c.aspectRatioId) {
        try {
          useProjectStore.getState().setAspectRatioId(args.aspectRatioId);
          pipelineLog(`画幅切换为 ${args.aspectRatioId}`);
        } catch {
          pipelineLog(`画幅 ${args.aspectRatioId} 不可用，沿用 ${c.aspectRatioId}`);
        }
      }
      let planSegments: Array<Record<string, unknown>>;
      let outlineBeatsForRun: OutlineBeat[] | undefined;
      if (args.segments && args.segments.length > 0) {
        planSegments = args.segments;
        pipelineLog(`使用已确认的计划（${planSegments.length} 段；校验失败不自动重写，保护人工修改）`);
      } else {
        const gen = await generatePipelineStoryboard(args, c);
        if (!gen.ok) throw new Error(`故事板生成失败：${gen.error}`);
        planSegments = gen.segments;
        outlineBeatsForRun = gen.outlineBeats;
        pipelineLog(`故事板三阶段生成：${gen.outlineUsed ? '大纲→分镜' : '单次分镜（大纲降级）'}${gen.polished ? '→润色' : ''}`);
      }
      // 运动连续性在 set_storyboard 执行器内统一应用（转场方向/下段飞入方向自动链接）
      const sbResult = await runTool('set_storyboard', {segments: planSegments}, ctx);
      if (!toolOk(sbResult)) {
        const errJson = JSON.stringify((sbResult.result as {errors?: string[]})?.errors ?? []);
        // 带计划执行时校验失败原样报错；生成路径把校验错误回喂重试一次
        if (args.segments) {
          throw new Error(`计划未通过故事板校验（工程未被修改）：${errJson}。请修正 segments 后重试。`);
        }
        pipelineLog(`故事板校验失败，带错误重试一次：${errJson.slice(0, 160)}`);
        const retry = await generatePipelineStoryboard(args, c, errJson);
        if (!retry.ok) throw new Error(`故事板重试仍失败：${retry.error}`);
        outlineBeatsForRun = retry.outlineBeats;
        const retryResult = await runTool('set_storyboard', {segments: retry.segments}, ctx);
        if (!toolOk(retryResult)) throw new Error(`故事板应用失败：${JSON.stringify((retryResult.result as {errors?: string[]})?.errors ?? [])}`);
      }
      const segCount = useProjectStore.getState().segments.length;
      setStep('storyboard', 'done', `${segCount} 段，${fmtSec(now() - t1)}${args.segments ? '（已确认计划）' : ''}`);
      pipelineLog(`故事板就绪（${segCount} 段）`);

      // ===== 阶段 2：素材 =====
      setStep('materials', 'running');
      const t2 = now();
      const store2 = useProjectStore.getState();
      const templateById = new Map(c.templates.map((t) => [t.id, t]));
      const needMedia = store2.segments
        .map((seg, index) => ({seg, index}))
        .filter(({seg}) => (templateById.get(seg.templateId)?.minVideos ?? 0) > 0 && seg.videos.length === 0);
      let materialNotes: string[] = [];
      if (needMedia.length > 0 && (c.existing.length > 0 || c.stockAvailable || c.imageGenAvailable)) {
        // 先在本地建立整部片的动作链，给 LLM 一个可解释的连续性基线；
        // LLM 仍可选择 stock/imagegen，但 existing 分配会用该基线校正时间窗。
        const continuity = planMaterialContinuity(
          needMedia.map(({seg, index}) => ({
            index,
            templateId: seg.templateId,
            title: seg.text?.title,
            subtitle: seg.text?.subtitle,
            continuityRole: outlineBeatsForRun?.[index] ? inferStoryRoleFromOutline(outlineBeatsForRun[index]) : undefined,
          })),
          c.existing,
        );
        const formalPlan = compileEditPlan(
          needMedia.map(({seg, index}) => ({
            index,
            templateId: seg.templateId,
            title: seg.text?.title,
            subtitle: seg.text?.subtitle,
            continuityRole: outlineBeatsForRun?.[index] ? inferStoryRoleFromOutline(outlineBeatsForRun[index]) : undefined,
          })),
          c.existing,
          continuity.assignments,
        );
        useProjectStore.getState().setEditPlan(formalPlan);
        pipelineLog(`正式 EditPlan 已生成：${formalPlan.shots?.length ?? 0} 个 shot，校验${formalPlan.validation?.ok ? '通过' : '需处理'}`);
        const continuityByIndex = new Map(continuity.assignments.map((a) => [a.index, a]));
        if (continuity.notes.length > 0) pipelineLog(`全局动作排片：${continuity.notes.join('；')}`);
        const planText = await chatText(buildMaterialsPlanPrompt({
          videoType,
          segments: needMedia.map(({seg, index}) => ({
            index, templateId: seg.templateId,
            minVideos: templateById.get(seg.templateId)?.minVideos ?? 1,
            title: seg.text?.title, subtitle: seg.text?.subtitle,
          })),
          existing: c.existing,
          stockAvailable: c.stockAvailable,
          imageGenAvailable: c.imageGenAvailable,
          strategy: args.materials ?? 'auto',
        }));
        const plan = parseMaterialsPlan(planText, {existing: c.existing, segmentCount: store2.segments.length});
        if (plan.ok) {
          // 同一条已有素材跨段时沿用动作链和窗口；模型若明确选 stock/imagegen，则尊重其选择。
          const assignments = plan.plan.assignments.map((a) => {
            if (a.source !== 'existing') return a;
            const linked = continuityByIndex.get(a.index);
            return linked?.source === 'existing'
              ? {...a, existingPath: linked.existingPath, storyUnitIndex: linked.storyUnitIndex,
                sourceStartSec: linked.sourceStartSec, sourceEndSec: linked.sourceEndSec,
                continuityRole: linked.continuityRole, continuityNote: linked.continuityNote}
              : a;
          });
          const importedByPath = new Map<string, VideoClip>();
          for (const a of assignments) {
            if (a.source === 'none') continue;
            if (!useProjectStore.getState().segments[a.index]) continue;
            try {
              if (a.source === 'existing' && a.existingPath) {
                let videoIndex = -1;
                const prior = importedByPath.get(a.existingPath);
                if (prior) {
                  // 已导入过的素材直接复用 VideoClip 数据，避免重复读取/创建媒体会话 URL。
                  const clone: VideoClip = {...prior, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`};
                  const before = useProjectStore.getState().segments[a.index]?.videos.length ?? 0;
                  useProjectStore.getState().addVideosToSegment(a.index, [clone]);
                  videoIndex = before;
                  materialNotes.push(`段${a.index}:复用已导入素材`);
                } else {
                  const r = await runTool('import_segment_media', {index: a.index, path: a.existingPath}, ctx);
                  if (toolOk(r)) {
                    const current = useProjectStore.getState().segments[a.index]?.videos ?? [];
                    videoIndex = current.length - 1;
                    const imported = current[videoIndex];
                    if (imported) importedByPath.set(a.existingPath, imported);
                    materialNotes.push(`段${a.index}:复用素材`);
                  } else {
                    materialNotes.push(`段${a.index}:复用失败`);
                  }
                }
                if (videoIndex >= 0 && a.sourceStartSec !== undefined && a.sourceEndSec !== undefined && a.sourceEndSec > a.sourceStartSec) {
                  const tr = await runTool('set_segment_trim', {
                    index: a.index, videoIndex,
                    trimStart: a.sourceStartSec, trimEnd: a.sourceEndSec,
                  }, ctx);
                  if (toolOk(tr)) materialNotes.push(`段${a.index}:窗口${a.sourceStartSec.toFixed(1)}-${a.sourceEndSec.toFixed(1)}s`);
                }
              } else if (a.source === 'stock' && a.stockQuery && c.stockAvailable) {
                const sr = await runTool('search_stock_media', {query: a.stockQuery, type: a.stockType ?? 'video'}, ctx);
                const items = (sr.result as {items?: Array<{provider: string; id: string; type: string; downloadUrl: string}>})?.items ?? [];
                if (items.length > 0) {
                  const pick = items[0];
                  const ir = await runTool('import_stock_media', {
                    index: a.index, provider: pick.provider, id: pick.id, type: pick.type, downloadUrl: pick.downloadUrl,
                  }, ctx);
                  materialNotes.push(toolOk(ir) ? `段${a.index}:stock` : `段${a.index}:stock失败`);
                } else {
                  materialNotes.push(`段${a.index}:stock无结果`);
                }
              } else if (a.source === 'imagegen' && a.imagePrompt && c.imageGenAvailable) {
                const r = await runTool('generate_image', {prompt: a.imagePrompt, index: a.index}, ctx);
                materialNotes.push(toolOk(r) ? `段${a.index}:文生图` : `段${a.index}:文生图失败`);
              }
            } catch (err) {
              materialNotes.push(`段${a.index}:异常(${err instanceof Error ? err.message.slice(0, 40) : '未知'})`);
            }
          }
          // BGM（用户没配 BGM 且计划给了情绪时才动）
          if (!useProjectStore.getState().bgm && plan.plan.bgm) {
            const r = await runTool('set_bgm', {...plan.plan.bgm}, ctx);
            if (toolOk(r)) materialNotes.push('BGM已配');
            // J-cut 副歌先行（W3 默认）：按波形能量掐前奏直进主体（set_bgm 选曲不带截取，装配侧补）
            const b = useProjectStore.getState().bgm;
            if (b && b.peaks && b.peaks.length > 0 && b.trimStartSec === undefined) {
              const trim = suggestBgmTrimStartSec(b.peaks, b.duration);
              if (trim > 0) {
                useProjectStore.getState().updateBgm({trimStartSec: trim});
                materialNotes.push(`BGM掐前奏${trim.toFixed(1)}s直进主体`);
              }
            }
          }
        } else {
          pipelineLog(`素材计划解析失败（跳过配置）：${plan.error}`);
        }
      }
      // 兜底：仍缺素材的段换成零素材模板（FeatureList 有要点时，否则 KineticType）
      const store2b = useProjectStore.getState();
      const stillEmpty = store2b.segments
        .map((seg, index) => ({seg, index}))
        .filter(({seg}) => (templateById.get(seg.templateId)?.minVideos ?? 0) > 0 && seg.videos.length === 0);
      for (const {seg, index} of stillEmpty) {
        const fallbackId = templateById.has('FeatureList') && (seg.text?.features?.length ?? 0) > 0 ? 'FeatureList' : 'KineticType';
        if (templateById.has(fallbackId)) {
          const r = await runTool('update_segment', {index, patch: {templateId: fallbackId}}, ctx);
          materialNotes.push(`段${index}:无素材→换${fallbackId}${toolOk(r) ? '' : '(失败)'}`);
        }
      }
      // 兜底 2：素材数低于模板 minVideos 的段（素材计划按段只配 1 份，BeforeAfter/SplitCompare
      // 这类 minVideos≥2 的模板会缺层）——换成体裁清单内首个素材数适配的模板
      const underFilled = useProjectStore.getState().segments
        .map((seg, index) => ({seg, index}))
        .filter(({seg}) => {
          const min = templateById.get(seg.templateId)?.minVideos ?? 0;
          return seg.videos.length > 0 && seg.videos.length < min;
        });
      for (const {seg, index} of underFilled) {
        const count = seg.videos.length;
        const need = templateById.get(seg.templateId)?.minVideos ?? 0;
        const replacement = c.templateBriefs
          .map((b) => templateById.get(b.id))
          .find((t) => t && t.id !== seg.templateId && t.minVideos <= count && count <= t.maxVideos);
        if (replacement) {
          const r = await runTool('update_segment', {index, patch: {templateId: replacement.id}}, ctx);
          materialNotes.push(`段${index}:素材${count}<需${need}→换${replacement.id}${toolOk(r) ? '' : '(失败)'}`);
        }
      }
      setStep('materials', needMedia.length === 0 ? 'skipped' : 'done',
        needMedia.length === 0 ? '故事板全部为零素材模板' : materialNotes.join('，').slice(0, 200));
      pipelineLog(`素材配置完成：${materialNotes.join('；') || '无需配置'}`);

      // ===== 阶段 2.5：高光挖掘（挖矿体裁 + ≥60s 长素材 → mine_highlights → apply_cut_list）=====
      setStep('mining', 'running');
      if (!isPipelineMiningGenre(videoType)) {
        setStep('mining', 'skipped', `「${VIDEO_TYPE_LABEL[videoType]}」体裁不走自动高光挖掘（${PIPELINE_MINING_GENRES.join('/')} 专用）`);
      } else {
        // 找配完素材后时长最长的视频素材所在段（素材计划已约束长素材只进一个承载段）
        const stM = useProjectStore.getState();
        let bestIndex = -1;
        let bestDur = 0;
        stM.segments.forEach((seg, i) => {
          for (const clip of seg.videos) {
            if (clip.type === 'video' && clip.duration > bestDur) {
              bestDur = clip.duration;
              bestIndex = i;
            }
          }
        });
        if (bestIndex < 0 || bestDur < 60) {
          setStep('mining', 'skipped', bestIndex < 0 ? '无视频素材' : `最长素材 ${bestDur.toFixed(0)}s，不足 60s 无需挖掘`);
        } else {
          const tM = now();
          try {
            const mineTarget = Math.max(10, Math.min(180, args.targetDurationSec ?? 30));
            const mr = await runTool('mine_highlights', {index: bestIndex, targetDurationSec: mineTarget}, ctx);
            const mres = mr.result as {
              ok?: boolean; errors?: string[]; message?: string;
              highlights?: Array<{startSec: number; endSec: number}>;
            };
            if (!mres?.ok || !mres.highlights || mres.highlights.length === 0) {
              const why = mres?.errors?.[0] ?? mres?.message ?? JSON.stringify(mr.result).slice(0, 80);
              setStep('mining', 'skipped', `挖掘未出结果（${why}），保留原始素材`);
              pipelineLog(`高光挖掘跳过：${why}`);
            } else {
              const keepRanges = mres.highlights.map((h) => ({start: h.startSec, end: h.endSec}));
              const ar = await runTool('apply_cut_list', {index: bestIndex, keepRanges}, ctx);
              const ares = ar.result as {ok?: boolean; effectiveDuration?: number; segmentDuration?: number; message?: string};
              if (ares?.ok) {
                setStep('mining', 'done',
                  `${mres.highlights.length} 段高光浓缩入第 ${bestIndex + 1} 段（${(ares.effectiveDuration ?? 0).toFixed(0)}s），${fmtSec(now() - tM)}`);
                pipelineLog(`高光挖掘落地：${mres.highlights.length} 段共 ${(ares.effectiveDuration ?? 0).toFixed(1)}s（原素材 ${bestDur.toFixed(0)}s）`);
              } else {
                setStep('mining', 'skipped', `挖出 ${mres.highlights.length} 段但落地失败，保留原始素材`);
                pipelineLog(`apply_cut_list 失败：${JSON.stringify(ar.result).slice(0, 120)}`);
              }
            }
          } catch (err) {
            setStep('mining', 'skipped', `挖掘异常（${err instanceof Error ? err.message.slice(0, 60) : '未知'}），保留原始素材`);
            pipelineLog(`高光挖掘异常（不阻断）：${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // ===== 阶段 2.8：音乐结构重排（B4）=====
      // montage 体裁：剪辑大脑按音乐结构整板重切（VideoCut 快切特例）；其余体裁 + 有 BGM：
      // 段落边界吸附音乐段落边界 + 转场按段能量选型（保留 LLM 排片的模板/文案/素材）。
      if (videoType === 'montage') {
        setStep('montage', 'running');
        const tm = now();
        if (!useProjectStore.getState().bgm) {
          setStep('montage', 'skipped', '无 BGM，保留 LLM 排片（卡点剪辑需要音乐结构）');
        } else {
          // autoMoneyShot：全场能量峰最高的镜头自动钉到首 drop 第一拍（高光压重拍钩子）
          const r = await runTool('auto_beat_montage', {autoMoneyShot: true}, ctx);
          const res = r.result as {ok?: boolean; message?: string; errors?: string[]; clipCount?: number};
          if (res?.ok) {
            setStep('montage', 'done', `卡点剪辑 ${res.clipCount ?? '?'} 镜，${fmtSec(now() - tm)}`);
            pipelineLog(`卡点混剪：${(res.message ?? '').slice(0, 140)}`);
          } else {
            setStep('montage', 'skipped', `卡点剪辑未执行（${(res?.errors?.[0] ?? '未知').slice(0, 50)}），保留原排片`);
          }
        }
      } else if (useProjectStore.getState().bgm) {
        setStep('montage', 'running');
        const tm = now();
        // mode=all：全自动流水线的新生故事板按段能量整体选型（手动工程用工具默认 fill 保显式选择）
        const r = await runTool('align_music_structure', {mode: 'all'}, ctx);
        const res = r.result as {ok?: boolean; message?: string; errors?: string[]; movedCount?: number; transitionChangedCount?: number};
        if (res?.ok) {
          setStep('montage', 'done', `结构重排 ${res.movedCount ?? 0} 切点 / ${res.transitionChangedCount ?? 0} 转场，${fmtSec(now() - tm)}`);
          pipelineLog(`音乐结构重排：${(res.message ?? '').slice(0, 140)}`);
        } else {
          setStep('montage', 'skipped', `结构重排未执行（${(res?.errors?.[0] ?? '未知').slice(0, 50)}），保留原排片`);
        }
      } else {
        setStep('montage', 'skipped', '无 BGM，跳过音乐结构重排（需要音乐段落结构）');
      }

      // ===== 阶段 2.9：节奏对齐（有 BGM 时把切点+转场吸附到节拍网格）=====
      // montage 体裁已由剪辑大脑按音乐结构重切，跳过；其余体裁在此获得音乐节拍级 pacing，
      // 此后才合成旁白（旁白护栏看到的是吸附后的段时长，口径一致）。
      if (videoType !== 'montage' && useProjectStore.getState().bgm) {
        const ab = await runTool('align_beats', {}, ctx);
        const abres = ab.result as {ok?: boolean; movedCount?: number; transitionMovedCount?: number; message?: string};
        if (abres?.ok && ((abres.movedCount ?? 0) > 0 || (abres.transitionMovedCount ?? 0) > 0)) {
          pipelineLog(`节奏对齐：${(abres.message ?? '').slice(0, 120)}`);
        }
      }

      // ===== 阶段 3：旁白 =====
      setStep('audio', 'running');
      const t3 = now();
      if (args.narration === false) {
        setStep('audio', 'skipped', '按参数跳过旁白');
      } else {
        const tts = await window.api.ttsGetStatus().catch(() => ({configured: false}) as {configured: boolean});
        const hasText = useProjectStore.getState().segments.some((s) => s.narration?.text?.trim());
        if (!tts.configured || !hasText) {
          // 降级不阻断：没配音就 BGM+字幕出片（AI 零门槛——免费用户零配置也能拿到完整成片）
          setStep('audio', 'skipped', !hasText
            ? '无旁白文案，BGM+字幕出片'
            : 'TTS 未配置，跳过配音（BGM+字幕出片）；可在 设置 → TTS 快速填充 一键补配');
        } else {
          const r = await runTool('synthesize_narration', {}, ctx);
          const res = r.result as {ok?: boolean};
          if (res?.ok) {
            // 旁白时长护栏：溢出段自动提速/延长（P0 修复，消灭两段旁白叠念）
            const fitNotes = await guardNarrationFit(ctx);
            if (fitNotes.length > 0) pipelineLog(`旁白时长护栏：${fitNotes.join('；')}`);
            setStep('audio', 'done', `TTS 合成完成${fitNotes.length > 0 ? `，护栏处置 ${fitNotes.length} 段` : ''}，${fmtSec(now() - t3)}`);
          } else {
            setStep('audio', 'skipped', 'TTS 失败（不阻断）');
            pipelineLog(`旁白合成失败（跳过）：${JSON.stringify(r.result).slice(0, 120)}`);
          }
        }
      }

      // 素材、挖矿、卡点和节拍调整都已落地；此时重建一次完整的
      // shot-level EditPlan，确保计划指向真实可渲染的素材与时间窗。
      rebuildActualEditPlan(outlineBeatsForRun);

      // ===== 阶段 4：渲染 + 阶段 5/6：审片/改稿循环 =====
      setStep('render', 'running');
      const t4 = now();
      outputs.videoPath = await renderAndWait();
      setStep('render', 'done', `${fmtSec(now() - t4)}，${outputs.videoPath.split(/[\\/]/).pop()}`);
      pipelineLog(`渲染完成：${outputs.videoPath}`);

      let verdict = '';
      let reviewIssues: Array<{segmentIndex?: number; severity: string; problem: string; suggestion: string}> = [];
      let lintIssues: Array<{segmentIndex?: number; severity: string; problem: string; suggestion: string}> = [];
      let audioIssues: string[] = [];
      let overall = 0;
      for (let round = 0; round <= (args.reviewRounds ?? 1); round++) {
        if (round === 0) {
          setStep('review', 'running');
        } else {
          setStep('autofix', 'running', `第 ${round} 轮改稿`);
          // 改稿：画面问题 + 本地体检 + 音频问题 → 补丁（文案/时长/参数/转场）→ update_segment → 重渲
          const st = useProjectStore.getState();
          try {
            const fixText = await chatText(buildAutoFixPrompt({
              videoType,
              overall, verdict, issues: reviewIssues, lintIssues, audioIssues,
              segments: st.segments.map((seg, index) => ({
                index, templateId: seg.templateId, title: seg.text?.title, subtitle: seg.text?.subtitle, features: seg.text?.features,
                duration: seg.duration,
                paramsBrief: paramsBriefOf(templateById.get(seg.templateId)?.paramSpecs),
              })),
            }));
            const fix = parseAutoFix(fixText);
            if (fix.ok) {
              for (const p of fix.patches) {
                const text: Record<string, unknown> = {};
                if (p.title !== undefined) text.title = p.title;
                if (p.subtitle !== undefined) text.subtitle = p.subtitle;
                if (p.features !== undefined) text.features = p.features;
                const patch: Record<string, unknown> = {};
                if (Object.keys(text).length > 0) patch.text = text;
                if (p.templateId !== undefined) patch.templateId = p.templateId;
                // 画面层补丁：时长/模板参数/转场（P1 扩展，审片发现的问题不再只有文案能修）
                if (p.durationSec !== undefined) patch.duration = p.durationSec;
                if (p.customParams !== undefined) patch.customParams = p.customParams;
                if (p.transitionType !== undefined) patch.transition = p.transitionType;
                if (p.transitionParams !== undefined) patch.transitionParams = p.transitionParams;
                if (Object.keys(patch).length > 0) {
                  await runTool('update_segment', {index: p.index, patch}, ctx);
                }
              }
              pipelineLog(`第 ${round} 轮改稿：应用 ${fix.patches.length} 处补丁，重渲`);
            } else {
              pipelineLog(`改稿解析失败（结束改稿循环）：${fix.error}`);
              setStep('autofix', 'skipped', '补丁解析失败');
              break;
            }
          } catch (err) {
            pipelineLog(`改稿调用失败（结束循环）：${err instanceof Error ? err.message : String(err)}`);
            setStep('autofix', 'skipped', 'LLM 调用失败');
            break;
          }
          rebuildActualEditPlan(outlineBeatsForRun);
          const tr = now();
          outputs.videoPath = await renderAndWait();
          setStep('autofix', 'done', `第 ${round} 轮改稿重渲完成（${fmtSec(now() - tr)}）`);
          setStep('review', 'running', `第 ${round + 1} 次审片`);
        }
        // 审片（视觉模型不可用时自动跳过）；本地可读性体检随结果一并收回（零成本规则）
        const rr = await runTool('review_render', {}, ctx);
        const rres = rr.result as {
          ok?: boolean; parsed?: boolean;
          report?: {overall: number; verdict: string; issues: typeof reviewIssues};
          localLint?: {issues?: Array<{segmentIndex?: number; severity: string; message: string; suggestion: string}>};
        };
        if (rres?.ok && rres.parsed && rres.report) {
          overall = rres.report.overall;
          verdict = rres.report.verdict;
          reviewIssues = rres.report.issues;
          // lint 问题映射成改稿补丁能消费的条目（segmentIndex 统一为 0 起下标）
          lintIssues = (rres.localLint?.issues ?? []).map((i) => ({
            segmentIndex: i.segmentIndex,
            severity: i.severity,
            problem: i.message,
            suggestion: i.suggestion,
          }));
          // 音频审片：响度/爆音/中段静音/旁白比对——画面 pass 但音频有问题同样要改稿
          try {
            const ar = await runTool('analyze_render_audio', {}, ctx);
            const ares = ar.result as {ok?: boolean; issues?: string[]};
            audioIssues = ares?.ok && Array.isArray(ares.issues) ? ares.issues : [];
            if (audioIssues.length > 0) {
              outputs.audioIssues = audioIssues;
              pipelineLog(`音频审片：${audioIssues.length} 个问题（${audioIssues[0].slice(0, 60)}…）`);
            } else {
              delete outputs.audioIssues;
              pipelineLog('音频审片通过');
            }
          } catch (err) {
            audioIssues = [];
            pipelineLog(`音频审片失败（不阻断）：${err instanceof Error ? err.message : String(err)}`);
          }
          outputs.reviewOverall = overall;
          outputs.reviewVerdict = verdict;
          setStep('review', 'done', `${overall}/5（${verdict}），画面问题 ${reviewIssues.length} 条${audioIssues.length > 0 ? `，音频问题 ${audioIssues.length} 条` : ''}`);
          pipelineLog(`审片：${overall}/5（${verdict}），高危 ${reviewIssues.filter((i) => i.severity === 'high').length} 条`);
          // 通过门槛 = 画面 pass 且音频无问题；任一侧有遗留且轮数未尽就继续改稿
          if (verdict === 'pass' && audioIssues.length === 0) {
            if ((args.reviewRounds ?? 1) > 0) setStep('autofix', 'skipped', '审片通过，无需改稿');
            break;
          }
          if (round === (args.reviewRounds ?? 1)) {
            setStep('autofix', round === 0 ? 'skipped' : 'done',
              verdict === 'pass' ? `画面通过，音频遗留 ${audioIssues.length} 条（达到改稿轮数上限）` : '达到改稿轮数上限');
            break;
          }
        } else {
          setStep('review', 'skipped', '视觉模型不可用或审片失败（详见日志）');
          pipelineLog(`审片跳过：${JSON.stringify(rr.result).slice(0, 160)}`);
          setStep('autofix', 'skipped', '未审片');
          break;
        }
      }

      // ===== 阶段 7：封面 + 元数据 =====
      setStep('deliverables', 'running');
      const t7 = now();
      // 元数据（LLM 生成，失败回退首段文案）
      let title = useProjectStore.getState().segments[0]?.text?.title || args.brief.slice(0, 18);
      let description = useProjectStore.getState().segments.map((s) => s.text?.subtitle).filter(Boolean).join(' ');
      let tags: string[] = [];
      try {
        const metaText = await chatText(buildMetadataPrompt({
          videoType,
          brief: args.brief,
          segments: useProjectStore.getState().segments.map((s) => ({title: s.text?.title, subtitle: s.text?.subtitle})),
        }));
        const meta = parseMetadataGen(metaText);
        if (meta.ok) {
          title = meta.meta.title;
          description = meta.meta.description || description;
          tags = meta.meta.tags;
        }
      } catch (err) {
        pipelineLog(`元数据生成失败（用文案兜底）：${err instanceof Error ? err.message : String(err)}`);
      }
      outputs.metadataTitle = title;
      await runTool('set_publish_metadata', {title, description, ...(tags.length > 0 ? {tags} : {})}, ctx);
      // 封面（首段标题做主文案）
      const coverResult = await runTool('export_cover', {preset: 'bottomLeft', title}, ctx);
      const coverPath = (coverResult.result as {path?: string})?.path;
      if (coverPath) outputs.coverPath = coverPath;
      setStep('deliverables', 'done', `封面${coverPath ? '已生成' : '失败（可手动 export_cover）'} + 元数据，${fmtSec(now() - t7)}`);

      // ===== 完成 =====
      const st = readState();
      if (st) {
        writeState({
          ...st,
          status: 'done',
          endedAt: now(),
          outputs,
        });
        pipelineLog(`流水线完成（总耗时 ${fmtSec(now() - st.startedAt)}）：视频 ${outputs.videoPath || '无'}${outputs.coverPath ? `，封面 ${outputs.coverPath}` : ''}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLog(`流水线终止：${msg}`);
      const st = readState();
      if (st) {
        writeState({
          ...st,
          status: 'error',
          endedAt: now(),
          error: msg,
          outputs,
          steps: st.steps.map((s) => (s.status === 'running' ? {...s, status: 'failed', note: msg.slice(0, 120)} : s)),
        });
      }
    }
  })();

  return {result: {
    ok: true,
    started: true,
    message: '全自动流水线已启动（异步执行）。用 get_app_status 轮询 autoPipeline 字段：steps 为各阶段状态、log 为最近日志、outputs 为产物路径（videoPath/coverPath/metadataTitle/audioIssues）、status=done|error|running。流程：大纲→分镜→润色→素材→旁白（含时长护栏）→渲染→画面+音频双审片→改稿（文案/时长/参数/转场）→封面+元数据',
  }};
};
