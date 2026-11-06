/**
 * LLM 工具执行器 - name → executor 查表分发（从 AIAssistantPanel 的 executeTool switch 原样搬出）。
 *
 * 工具在渲染进程执行（故事板状态在 zustand，校验器在 shared/llm-tools）；
 * 工具清单见 shared/llm-tools 的 LLM_TOOL_REGISTRY——新增工具在此加一条 executor 即可。
 * 有副作用的工具（录屏/截屏/TTS）先经 ctx.requestConfirm 弹确认卡，用户同意才执行——
 * 屏幕内容会发往第三方 AI 端点、TTS 烧用户额度，不能被素材名注入等方式静默触发。
 */
import {getTemplateById, mergeTemplateMetas, templateFitsVideoType} from '../../shared/template-registry';
import {currentContentFingerprint} from '../render/contentFingerprint';
import {planMotionChain, applyMotionChain} from '../../shared/motion-chain';
import {planBeatMontage, findMoneyShot, shotEnergyPeak} from '../../shared/edit-brain';
import type {SourceShots, MontageDirectives} from '../../shared/edit-brain';
import {planMusicStructureRearrange} from '../../shared/music-structure';
import {isTemplateSlot, filterTemplatesBySlot, slotLabelsOf, TEMPLATE_SLOT_LABEL} from '../../shared/template-slots';
import {getTemplateSlotWindows, SLOT_WINDOW_TEMPLATE_IDS} from '../../shared/template-slot-windows';
import {searchTemplateCatalog, rankOnlineTemplateCatalog, enrichTemplateMeta, isTemplateStyle, isTemplateAction} from '../../shared/template-catalog';
import type {LlmTools} from '../../shared/llm-tools';
import {createImageBudget, resetImageBudget, takeImageBudget, frameBudgetKey} from '../../shared/image-budget';
import {listTransitionTemplates} from '../../shared/transition-template-registry';
import {computeTimelineLayout, clampNarrationOffsetSec, TIMELINE_FPS} from '../../shared/timeline-layout';
import {bgmStartAtSec, bgmTrimStartSec, bgmTrimEndSec, bgmLoopSpanSec, bgmTimelineBeats, normalizeBgmVolumeKeys} from '../../shared/bgm-track';
import {computeShotTimeline, shotSummary} from '../../shared/shot-timeline';
import {projectSegmentPlan, segmentPlanSummary} from '../../shared/plan-projection';
import {TEMPLATES} from '../../shared/template-registry';
import {markAgentOp, dropAgentOp} from '../store/historyUtils';
import type {ImageBudget} from '../../shared/image-budget';
import {lintStoryboardCompleteness} from '../../shared/storyboard-completeness';
import {getAppStatus} from './appStatus';
import {
  parseIndexArg,
  validateViewFrameArgs,
  validateSetTrimArgs,
  validateSetViewportArgs,
  validateSetCaptionsArgs,
  validateDuckingArgs,
  validateSetBgmPositionArgs,
  validateSetNarrationTimingArgs,
  validateReorderSegmentsArgs,
  validateGetSegmentPlanArgs,
  validateSetSegmentBeatsArgs,
  validateMoveShotArgs,
  validateColorGradeArgs,
  validateBrandStyleArgs,
  validateAlignBeatsArgs,
  validateFinePrintArgs,
  validateLogoArgs,
  validateScreenshotArgs,
  validateStartRecordingArgs,
  validateStopRecordingArgs,
  validateImportMediaArgs,
  validateSetColorspaceArgs,
  validateScanMediaArgs,
  validateViewMediaFramesArgs,
  validateSplitSegmentArgs,
  validateDeleteSegmentArgs,
  validateMoveSegmentArgs,
  validateRemoveSegmentMediaArgs,
  validateCaptureElementArgs,
  validateSetOverlayArgs,
  validateReviewRenderArgs,
  validateExportCoverArgs,
  validateSetPublishMetadataArgs,
  validateSearchStockArgs,
  validateImportStockArgs,
  validateGenerateImageArgs,
  validateGenerateModelArgs,
  validateSetBgmArgs,
  validateAnalyzeAudioArgs,
  validateRunPipelineArgs,
  validateSetVideoTypeArgs,
  validateMineHighlightsArgs,
  validateApplyCutListArgs,
  validateAutoBeatMontageArgs,
  type AutoBeatMontageArgs,
  validateScreenDemoArgs,
  type ScreenDemoArgs,
  validateTutorialArgs,
  validateGenerateTemplateArgs,
  validateReviewTemplateArgs,
  validateStabilizeClipArgs,
  validateSetStabilizationArgs,
  validateSetProjectStyleArgs,
  validateConsolidateProjectArgs,
  validateAddGroundTextArgs,
  validateAddGroundShapeArgs,
  validateUpdateGroundElementArgs,
  validateRemoveGroundElementArgs,
  validateSetGroundTrackingArgs,
} from '../../shared/llm-tools';
import {collectProjectMediaPaths} from '../../shared/consolidate';
import {codecPreviewWarning} from '../../shared/codec-preview';
import {guessColorCurveFromTags, colorCurveMeta} from '../../shared/proxy-media.ts';
import {guessSourceKind, SOURCE_KIND_LABELS} from '../../shared/source-kind';
import {STAB_DEFAULTS, solveStabilization} from '../../shared/stabilization';
import type {StabPoint} from '../../shared/stabilization';
import {instantiateGenerated} from '../../remotion/generated/instantiate';
import type {MultiSegmentProps, Segment, VideoClip, GroundElement, TemplateMeta} from '../../shared/types';
import {DEFAULT_LAYOUT} from '../../shared/types';
import {cutAt, planFrameTimes} from '../../shared/clipCuts';
import {RECORDING_LAYOUT_LABEL} from '../../shared/recordingLayout';
import {VIDEO_TYPE_LABEL, isVideoType, SFX_ENABLED_BY_VIDEO_TYPE} from '../../shared/video-type';
import {
  buildSpeechClusters, buildMiningPrompt, parseHighlightResponse,
  normalizeKeepRanges, keepRangesToTrim, sampleFrameTimes,
} from '../../shared/highlight-mining';
import {buildReviewPrompt, parseReviewReport, buildTemplateReviewPrompt, TEMPLATE_REVIEW_DIMENSIONS} from '../../shared/review-report';
import {lintReadability} from '../../shared/readability-lint';
import {lintCheckpoints} from '../../shared/template-checkpoints';
import {buildMediaTagPrompt, parseMediaTagResponse, planMediaStorySamples} from '../../shared/media-tags';
import type {MediaTag, MediaStorySample} from '../../shared/media-tags';
import {buildMediaIntelligenceIndex, buildMediaIntelligenceAsset, cuesToRawAsrSegments, digestTranscript, transcriptKeywords} from '../../shared/media-intelligence';
import type {MediaIntelligenceIndex, TranscriptCue} from '../../shared/media-intelligence';
import {liveActionStats, softSortTemplatesForLiveAction, liveActionShrinkWarning} from '../../shared/live-action-guard';
import {sanitizeEditPlan, validateEditPlan, constrainEditPlanShots} from '../../shared/edit-plan';
import {audioReviewIssues, textSimilarity, missingKeywords} from '../../shared/audio-review';
import type {AudioReviewReport} from '../../shared/audio-review';
import {classifyMusicMood, energyFromPeaks, rankMusicForMood, MOOD_LABELS} from '../../shared/music-mood';
import type {MusicCandidate} from '../../shared/music-mood';
import {runScreenDemoAuto, runTutorialAuto} from './screenDemoAuto';
import type {StockMediaItem} from '../../shared/stock-media';
import {MODEL_GEN_FRONTEND_POLL_MS} from '../../shared/model-gen';
import {startAutoPipeline, planAutoPipeline} from './autoPipeline';
import {validateComputerPlayScriptArgs, validateComputerRunTaskArgs, validateComputerTaskIdArg} from '../../shared/computer-use';
import {sanitizeCoverConfig, effectiveCoverTexts, withEffectiveTexts, applyCoverPreset, darkenHex} from '../../shared/cover-presets';
import {computeSubjectMaskFromImage} from '../utils/subjectMask';
import {PUBLISH_PLATFORMS, PLATFORM_SPECS, buildPlatformCopy, checkPlatformLimits} from '../../shared/publish';
import type {ContentPart} from '../../shared/llm-chat';
import {useProjectStore} from '../store/projectStore';
import {clipSrcToPath, pathToClipSrc} from '../utils/clipPath';
import {makeClipThumbnail} from '../utils/clipThumbnail';
import {getSfxSources} from '../sfx/sfxSources';
import {listCaptureSources, startRecording, startWithSystemAudio, stopRecording, addCaptureToSegment, getRecordingInfo, enableWebcam} from '../capture/screenCapture';
import {enterElementCaptureMode, matteTwoPass, nextFrames} from '../capture/elementCapture';

/** 工具执行结果：result 是回给模型的工具消息内容；image/images 用于「看图」后自动追加含图 user 消息 */
export interface ToolExecResult {
  result: unknown;
  /** view_segment_frame 抽到的画面，下一轮作为 image_url user 消息注入，让视觉模型看图 */
  image?: {dataUrl: string; note: string};
  /** view_media_frames 抽到的多张画面（每张各注入一条 image_url user 消息） */
  images?: {dataUrl: string; note: string}[];
}

const templateParamsBrief = (specs: TemplateMeta['paramSpecs']): string | undefined => {
  if (!specs?.length) return undefined;
  return specs.slice(0, 6).map((p) => `${p.key}(${p.min}-${p.max}默认${p.default})`).join(' ');
};

/** 执行器上下文：store 访问 / 校验器 / 渲染确认 / 副作用确认等由调用方（AIAssistantPanel）注入 */
export interface ToolExecContext {
  /** createLlmTools 产物（故事板校验器，已绑定模板/枚举清单） */
  llm: LlmTools;
  /** 取 project store 当前快照（等价于原 executeTool 入口的 useProjectStore.getState()） */
  getStore: () => ReturnType<typeof useProjectStore.getState>;
  /** request_render 触发：面板插入渲染确认卡，用户点击后才真正渲染；
   *  MCP 桥等无界面调用方可返回 {message} 自定义回执文案（缺省按「已弹出确认卡」回复模型） */
  onRequestRender: () => void | {message?: string} | Promise<void | {message?: string}>;
  /** 副作用工具的用户确认：弹卡等待点击（true=允许执行，false=拒绝） */
  requestConfirm: (label: string, detail?: string) => Promise<boolean>;
  /** 看图预算（会话级实例，panel 每次新会话重建；缺省退到模块级共享实例——MCP 桥场景）。
   *  防小模型重复抽帧烧穿上下文（见 shared/image-budget.ts），panel/MCP 两通道共用同一套闸。 */
  imageBudget?: ImageBudget;
  /** 工作草稿本（scratch_pad 工具的读写后端，随工程持久化；缺省退到模块级会话级实例） */
  scratchpad?: {read: () => string; write: (next: string) => void};
  /** 视觉中继（决策脑/看图脑分离 MVP）：非空时，EDGE 看图工具抽到的帧不回传主对话，
   *  改由中继开「看图子会话」评估后以文字结论回传——图片不再进入主上下文（大头膨胀源）。 */
  visionRelay?: (frames: {dataUrl: string; note: string}[], question: string) => Promise<string>;
}

/** 模块级共享看图预算：调用方未注入 ctx.imageBudget 时的兜底（MCP 桥的长会话场景） */
const sharedImageBudget = createImageBudget();
/** 执行器内统一取预算实例 */
const budgetOf = (ctx: ToolExecContext): ImageBudget => ctx.imageBudget ?? sharedImageBudget;
/** 模块级共享草稿本（调用方未注入 ctx.scratchpad 时的兜底；会话级——工程级持久化由 panel 用 localStorage 提供） */
const sharedScratchpad = {text: '', read: () => sharedScratchpad.text, write: (s: string) => { sharedScratchpad.text = s; }};
const scratchpadOf = (ctx: ToolExecContext) => ctx.scratchpad ?? sharedScratchpad;

/** 工具执行器签名：args 为已解析的参数对象，返回回给模型的结果（可带图） */
export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolExecContext) => Promise<ToolExecResult>;

/** Electron invoke 抛错会带前缀，剥掉只留中文正文 */
const stripIpcPrefix = (err: unknown): string =>
  String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * auto_beat_montage / get_footage_map 共用：收集故事板全部视频素材（按路径去重，
 * 保持故事板出现顺序——素材序号即 LLM 指令里的 source 下标）。
 */
const collectStoryboardVideos = (ctx: ToolExecContext): Map<string, {name: string; width: number; height: number; duration: number}> => {
  const store = ctx.getStore();
  const byPath = new Map<string, {name: string; width: number; height: number; duration: number}>();
  for (const seg of store.segments) {
    for (const v of seg.videos) {
      if (v.type !== 'video') continue;
      const p = clipSrcToPath(v.src);
      if (p && !byPath.has(p)) byPath.set(p, {name: v.name, width: v.width, height: v.height, duration: v.duration});
    }
  }
  return byPath;
};

/** 逐个素材做画面分析（footage：镜头边界/运动强度/能量曲线；主进程带缓存，连续调用第二次零成本） */
const analyzeMontageSources = async (
  byPath: Map<string, {name: string; width: number; height: number; duration: number}>,
): Promise<{sources: SourceShots[]; failed: string[]}> => {
  const sources: SourceShots[] = [];
  const failed: string[] = [];
  for (const [p, meta] of byPath) {
    const fm = await window.api.analyzeFootage(p);
    if (fm && fm.shots.length > 0) {
      sources.push({source: p, shots: fm.shots, energies: fm.energies, sampleFps: fm.sampleFps});
    } else {
      failed.push(meta.name);
    }
  }
  return {sources, failed};
};

/** LLM 指令（get_footage_map 序号制）→ edit-brain 指令（路径制）；越界引用收集警告并忽略 */
const resolveMontageDirectives = (
  args: import('../../shared/llm-tools').AutoBeatMontageArgs,
  sources: SourceShots[],
): {directives: MontageDirectives; warnings: string[]} => {
  const warnings: string[] = [];
  const ref = (r: {source: number; shot: number} | undefined, label: string): {source: string; shot: number} | undefined => {
    if (!r) return undefined;
    const s = sources[r.source];
    if (!s || r.shot >= s.shots.length) {
      warnings.push(`${label} 引用越界（素材 ${r.source} 镜头 ${r.shot} 不存在），已忽略`);
      return undefined;
    }
    return {source: s.source, shot: r.shot};
  };
  const d = args.directives;
  const directives: MontageDirectives = {
    openingShot: ref(d?.openingShot, '开篇镜'),
    closingShot: ref(d?.closingShot, '收尾镜'),
    firstDropShot: ref(d?.firstDropShot, '首drop高光镜'),
    excludeShots: d?.excludeShots
      ?.map((r, i) => ref(r, `禁镜#${i}`))
      .filter((r): r is {source: string; shot: number} => !!r),
  };
  // autoMoneyShot：自动找全场能量峰最高的镜头钉到首 drop（显式 firstDropShot 优先）
  if (args.autoMoneyShot && !directives.firstDropShot) {
    const money = findMoneyShot(sources);
    if (money) directives.firstDropShot = money;
  }
  return {directives, warnings};
};

/**
 * mine_highlights / apply_cut_list 共用的素材解析：
 * 指定 videoIndex 时按段内原始下标取（须为视频）；缺省取段内时长最长的视频素材
 * （图片没有时间线，一律跳过）。返回 null = 无可用视频素材（错误信息已含）。
 */
const resolveMiningClip = (
  seg: {videos: VideoClip[]},
  videoIndex: number | undefined,
  index: number,
): {ok: true; clip: VideoClip; videoIndex: number} | {ok: false; errors: string[]} => {
  if (videoIndex !== undefined) {
    const clip = seg.videos[videoIndex];
    if (!clip || clip.type !== 'video') {
      return {ok: false, errors: [`第 ${index + 1} 段无第 ${videoIndex} 个视频素材（图片素材没有时间线可挖）`]};
    }
    return {ok: true, clip, videoIndex};
  }
  let bestIndex = -1;
  seg.videos.forEach((v, i) => {
    if (v.type === 'video' && (bestIndex === -1 || v.duration > (seg.videos[bestIndex]?.duration ?? 0))) bestIndex = i;
  });
  const best = bestIndex >= 0 ? seg.videos[bestIndex] : undefined;
  if (!best || best.type !== 'video') {
    return {ok: false, errors: [`第 ${index + 1} 段没有视频素材（图片素材没有时间线可挖）`]};
  }
  return {ok: true, clip: best, videoIndex: bestIndex};
};

/**
 * 两个稳定工具共用的素材解析：段越界 / 素材存在 / 必须是视频 三道校验
 * （图片没有抖动可稳，直接给中文原因让模型换素材或放弃）。
 */
const resolveStabClip = (
  ctx: ToolExecContext,
  segmentIndex: number,
  clipIndex: number,
): {ok: true; clip: VideoClip} | {ok: false; errors: string[]} => {
  const store = ctx.getStore();
  const seg = store.segments[segmentIndex];
  if (!seg) return {ok: false, errors: [`下标 ${segmentIndex} 越界，共 ${store.segments.length} 段`]};
  const clip = seg.videos[clipIndex];
  if (!clip) return {ok: false, errors: [`第 ${segmentIndex + 1} 段无第 ${clipIndex} 个素材（共 ${seg.videos.length} 个）`]};
  if (clip.type !== 'video') return {ok: false, errors: [`第 ${segmentIndex + 1} 段第 ${clipIndex} 个素材是图片——图片没有抖动可稳，稳定仅对视频素材有效`]};
  return {ok: true, clip};
};

/**
 * stabilize_clip / set_stabilization(换点) 共用的分析落地链路：
 * 主进程块匹配分析（只分析 trim 后区间）→ setVideoStabilization 写回（持久化 + 内存态）→
 * LLM 友好回报（zoom=裁边依据、lostRatio>0.15 附换点建议、耗时）。
 */
const runStabAnalyze = async (
  ctx: ToolExecContext,
  segmentIndex: number,
  clipIndex: number,
  clip: VideoClip,
  points: StabPoint[] | undefined,
  smoothSec: number,
): Promise<ToolExecResult> => {
  const t0 = Date.now();
  try {
    const res = await window.api.stabilizeAnalyze({
      videoPath: clipSrcToPath(clip.src),
      points: points ?? [], // 空数组 = 自动选点（服务侧首帧 autoPickPoint）
      opts: {smoothSec, trimStart: clip.trimStart ?? 0, trimEnd: clip.trimEnd ?? clip.duration},
    });
    ctx.getStore().setVideoStabilization(clipIndex, {
      stabilization: {
        trackPath: res.trackPath,
        points: res.track.points,
        smoothSec,
        enabled: true,
        lostRatio: res.stats.lostRatio,
      },
      stabCorrections: res.corrections,
      stabZoom: res.zoom,
      stabSampleFps: res.track.sampleFps,
    }, segmentIndex);
    const zoomPct = Math.max(0, Math.round((res.zoom - 1) * 1000) / 10);
    const lostPct = Math.round(res.stats.lostRatio * 1000) / 10;
    const advice = res.stats.lostRatio > 0.15
      ? '；跟丢帧偏多，建议换跟踪点重试（set_stabilization 传 points，放静止背景、纹理强处）'
      : '';
    return {result: {
      ok: true,
      message: `第 ${segmentIndex + 1} 段素材「${clip.name}」已稳定：画面放大 ${zoomPct}%（即裁边比例），最大校正 ${res.stats.maxCorrectionPx}px，跟丢率 ${lostPct}%${advice}`,
      zoom: res.zoom,
      zoomPct,
      cropPct: zoomPct, // 裁边 ≈ 放大部分（四边合计损失的画面比例）
      lostRatio: res.stats.lostRatio,
      maxCorrectionPx: res.stats.maxCorrectionPx,
      pointsUsed: res.track.points,
      elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
    }};
  } catch (err) {
    return {result: {ok: false, errors: [`稳定分析失败：${stripIpcPrefix(err)}`]}};
  }
};

/**
 * name → executor 映射。key 与 LLM_TOOL_REGISTRY 的 name 一一对应；
 * 各 executor 体内逻辑与原 executeTool switch 的 case 分支逐行一致。
 */
// ====== 3D 地面追踪（见 shared/groundTrack.ts；一键全自动：无追踪数据先自动分析）======

/** 段/素材定位与校验（同 resolveStabClip 语义） */
const resolveGroundClip = (
  ctx: ToolExecContext, segmentIndex: number, clipIndex: number,
): {ok: true; clip: VideoClip} | {ok: false; errors: string[]} => {
  const seg = ctx.getStore().segments[segmentIndex];
  if (!seg) return {ok: false, errors: [`段 ${segmentIndex} 不存在（共 ${ctx.getStore().segments.length} 段）`]};
  const clip = seg.videos[clipIndex];
  if (!clip) return {ok: false, errors: [`段内素材下标 ${clipIndex} 不存在（共 ${seg.videos.length} 个）`]};
  if (clip.type !== 'video') return {ok: false, errors: ['3D 地面追踪仅支持视频素材']};
  return {ok: true, clip};
};

/** 确保素材有可用的地面追踪（enabled + groundData）；缺则自动分析（秒级） */
const runGroundAnalyze = async (
  ctx: ToolExecContext, segmentIndex: number, clipIndex: number, clip: VideoClip,
): Promise<{ok: true; track: NonNullable<VideoClip['groundTrack']>} | {ok: false; errors: string[]}> => {
  try {
    const res = await window.api.groundAnalyze({
      videoPath: clipSrcToPath(clip.src),
      opts: {trimStart: clip.trimStart ?? 0, trimEnd: clip.trimEnd ?? clip.duration},
    });
    const track: NonNullable<VideoClip['groundTrack']> = {
      trackPath: res.trackPath,
      enabled: true,
      keptAnchors: res.stats.keptAnchors,
      lostRatio: res.stats.lostRatio,
      meanResidualPx: res.stats.meanResidualPx,
    };
    ctx.getStore().setGroundTrack(clipIndex, {
      groundTrack: track,
      groundData: {anchors: res.track.anchors, samples: res.track.samples},
    }, segmentIndex);
    return {ok: true, track};
  } catch (err) {
    return {ok: false, errors: [stripIpcPrefix(err)]};
  }
};

const ensureGroundTrack = async (
  ctx: ToolExecContext, segmentIndex: number, clipIndex: number, clip: VideoClip,
) => runGroundAnalyze(ctx, segmentIndex, clipIndex, clip).then((r) => {
  if (r.ok) return r;
  // 已有数据则直接复用（分析失败不阻断既有效果）
  const cur = ctx.getStore().segments[segmentIndex]?.videos[clipIndex] ?? clip;
  if (cur.groundTrack?.enabled && cur.groundData?.anchors?.length && cur.groundData?.samples?.length) {
    return {ok: true as const, track: cur.groundTrack};
  }
  return r;
});

const groundQualityNote = (track: NonNullable<VideoClip['groundTrack']>): string => {
  const warn = (track.lostRatio ?? 0) > 0.15 || (track.meanResidualPx ?? 0) > 4 || (track.keptAnchors ?? 0) < 5;
  const kept = track.keptAnchors ?? '?';
  const res = track.meanResidualPx ?? '?';
  const lost = Math.round((track.lostRatio ?? 0) * 1000) / 10;
  return warn
    ? `追踪质量一般（锚点 ${kept} / 残差 ${res}px / 丢失率 ${lost}%）——建议换纹理更丰富的画面段落（set_ground_tracking reanalyze）或调整素材 trim`
    : `追踪质量正常（锚点 ${kept} / 残差 ${res}px / 丢失率 ${lost}%）`;
};

let groundElementSeq = 0;
const newGroundElementId = (): string => `ge-${Date.now().toString(36)}-${groundElementSeq++}`;


export const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  get_templates: async (args, ctx) => {
    const store = ctx.getStore();
    // 体裁过滤：显式参数优先，缺省按工程当前体裁（专属其他体裁的模板隐藏）
    const requested = isVideoType(args.videoType) ? args.videoType : store.videoType;
    const all = mergeTemplateMetas(store.customTemplates, store.marketTemplates, store.generatedTemplates);
    const genreList = all.filter((t) => templateFitsVideoType(t, requested));
    const hidden = all.length - genreList.length;
    // 叙事槽位过滤（可选）：先定每段叙事角色再拉候选，清单更短更准
    const slot = isTemplateSlot(args.slot) ? args.slot : null;
    const list = slot ? filterTemplatesBySlot(genreList, slot) : genreList;
    const notes: string[] = [];
    if (hidden > 0) notes.push(`已按体裁「${VIDEO_TYPE_LABEL[requested]}」过滤，${hidden} 个其他体裁专属模板隐藏（传 videoType 参数可查其他体裁清单）`);
    if (slot) notes.push(`已按叙事槽位「${TEMPLATE_SLOT_LABEL[slot]}」过滤：${list.length} 个候选（未分槽的市场模板不在槽位清单内，不传 slot 可见全量）`);
    // P0-2 软排序：实拍为主的工程把满幅素材类排前、文字卡靠后（不隐藏任何选项；铁律的工具层落地）
    const la = liveActionStats(store.segments);
    const ordered = la.dominant ? softSortTemplatesForLiveAction(list) : list;
    if (la.dominant) notes.push(`工程以实拍素材为主（${la.live}/${la.videos}）：已把满幅素材类模板排前，文字卡/画中画类靠后——实拍优先 Fullbleed 满幅族或 VideoCut，其他模板仍可自由选用`);
    return {
      result: {
        videoType: requested,
        videoTypeLabel: VIDEO_TYPE_LABEL[requested],
        ...(slot ? {slot, slotLabel: TEMPLATE_SLOT_LABEL[slot]} : {}),
        ...(notes.length > 0 ? {note: notes.join('；')} : {}),
        templates: ordered.map((raw) => {
          const t = enrichTemplateMeta(raw);
          return {
            id: t.id, name: t.name, description: t.description,
            minVideos: t.minVideos, maxVideos: t.maxVideos, defaultDuration: t.defaultDuration,
            defaultLayout: t.defaultLayout,
            slots: t.slots ?? [],
            slotLabels: slotLabelsOf(t),
            styles: t.styles ?? [],
            actions: t.actions ?? [],
            ...(t.searchTags?.length ? {searchTags: t.searchTags.slice(0, 12)} : {}),
            paramSpecs: t.paramSpecs,
            ...(t.textSlots ? {textSlots: t.textSlots, textNote: t.textSlots.length === 0 ? '该模板不展示文字' : 'text 只消费这些字段（其余字段保留但不显示）'} : {}),
          };
        }),
      },
    };
  },

  search_templates: async (args, ctx) => {
    const store = ctx.getStore();
    const requested = isVideoType(args.videoType) ? args.videoType : store.videoType;
    const all = mergeTemplateMetas(store.customTemplates, store.marketTemplates, store.generatedTemplates);
    const result = searchTemplateCatalog(all, {
      videoType: requested,
      ...(isTemplateSlot(args.slot) ? {slot: args.slot} : {}),
      ...(isTemplateStyle(args.style) ? {style: args.style} : {}),
      ...(isTemplateAction(args.action) ? {action: args.action} : {}),
      ...(typeof args.query === 'string' && args.query.trim() ? {query: args.query.trim().slice(0, 120)} : {}),
      ...(typeof args.needsMedia === 'boolean' ? {needsMedia: args.needsMedia} : {}),
      ...(typeof args.limit === 'number' ? {limit: args.limit} : {}),
    });
    // P0-2 软排序：实拍为主的工程把满幅素材类排前（稳定排序不打散相关性评分，不删选项）
    const la2 = liveActionStats(store.segments);
    const localSorted = la2.dominant ? softSortTemplatesForLiveAction(result.templates) : result.templates;
    const compact = localSorted.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      minVideos: t.minVideos,
      maxVideos: t.maxVideos,
      defaultDuration: t.defaultDuration,
      slots: t.slots ?? [],
      slotLabels: slotLabelsOf(t),
      styles: t.styles ?? [],
      actions: t.actions ?? [],
      ...(t.searchTags?.length ? {searchTags: t.searchTags.slice(0, 12)} : {}),
      ...(t.paramSpecs?.length ? {paramsBrief: templateParamsBrief(t.paramSpecs)} : {}),
      ...(t.textSlots ? {textSlots: t.textSlots} : {}),
    }));
    // Search the online catalog as a compact second tier. The catalog only
    // contains metadata, so remote hits are returned separately and are never
    // mistaken for locally renderable template ids until installed.
    let marketTemplates: Array<Record<string, unknown>> = [];
    let marketOffline = false;
    try {
      const remote = typeof window !== 'undefined' && window.api?.marketCatalog
        ? await window.api.marketCatalog(false)
        : {entries: [], offline: true};
      const ranked = rankOnlineTemplateCatalog(remote.entries ?? [], {
        ...(isTemplateStyle(args.style) ? {style: args.style} : {}),
        ...(isTemplateAction(args.action) ? {action: args.action} : {}),
        ...(isTemplateSlot(args.slot) ? {slot: args.slot} : {}),
        ...(typeof args.query === 'string' && args.query.trim() ? {query: args.query.trim().slice(0, 120)} : {}),
      }, typeof args.limit === 'number' ? args.limit : 8);
      marketTemplates = ranked.map((entry) => ({
        id: entry.id, name: entry.name, description: entry.description ?? '', version: entry.version,
        tags: entry.tags ?? [], downloads: entry.downloads, updatedAt: entry.updatedAt,
        installed: Boolean(entry.installedVersion), ...(entry.hasUpdate ? {hasUpdate: true} : {}),
      }));
    } catch {
      marketOffline = true;
    }
    return {result: {
      ok: true,
      videoType: requested,
      query: {
        ...(isTemplateSlot(args.slot) ? {slot: isTemplateSlot(args.slot) ? args.slot : undefined} : {}),
        ...(isTemplateStyle(args.style) ? {style: isTemplateStyle(args.style) ? args.style : undefined} : {}),
        ...(isTemplateAction(args.action) ? {action: isTemplateAction(args.action) ? args.action : undefined} : {}),
        ...(typeof args.query === 'string' && args.query.trim() ? {text: args.query.trim().slice(0, 120)} : {}),
        ...(typeof args.needsMedia === 'boolean' ? {needsMedia: args.needsMedia} : {}),
      },
      total: result.total,
      note: [
        la2.dominant ? `工程以实拍素材为主（${la2.live}/${la2.videos}）：满幅素材类已排前，文字卡/画中画类靠后——实拍优先 Fullbleed 满幅族或 VideoCut，其他模板仍可自由选用` : '',
        `已从 ${result.total} 个匹配模板中返回 ${localSorted.length} 个候选；如需更多可调整 style/action/query 或 limit（最多 20）。`,
      ].filter(Boolean).join('；'),
      templates: compact,
      ...(marketTemplates.length > 0 ? {marketTemplates, marketNote: '在线命中仅为目录元数据；先在模板市场安装后，再用该 id 调用 set_storyboard/update_segment'} : {}),
      ...(marketOffline ? {marketNote: '在线模板目录暂时不可用，已返回本地已安装模板'} : {}),
      facets: result.facets,
    }};
  },

  set_video_type: async (args, ctx) => {
    const r = validateSetVideoTypeArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const prev = store.videoType;
    const next = r.args.videoType;
    store.setVideoType(next, 'agent'); // P0-1：工具设定的体裁标记 agent——采痕卫生（自动路由仅在从未设定时触发）
    const label = VIDEO_TYPE_LABEL[next];
    // 音效默认是否随体裁变化（仅未手动改过音效时生效，见 projectStore.setVideoType）
    const sfxDefault = SFX_ENABLED_BY_VIDEO_TYPE[next];
    const sfxNote = store.sfx.enabled === sfxDefault ? '' : `自动音效默认已随体裁切换为「${sfxDefault ? '开' : '关'}」（此前未手动改过音效；可在 BGM 面板手动改，改后体裁切换不再动它）`;
    return {result: {
      ok: true,
      videoType: next,
      videoTypeLabel: label,
      message: prev === next
        ? `工程体裁已是「${label}」，未变化。`
        : `工程体裁已从「${VIDEO_TYPE_LABEL[prev]}」切换为「${label}」，随工程保存。工作流剧本与模板推荐口径已切换（get_workflow_guide 返回新分册；get_templates 已按新体裁过滤）；已有段落不受影响，继续按新剧本编排即可。${sfxNote ? ` ${sfxNote}。` : ''}`,
    }};
  },

  save_project: async (args, ctx) => {
    const store = ctx.getStore();
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined;
    const r = await store.saveProjectToPath(path);
    if (!r.ok) return {result: {ok: false, errors: [r.error ?? '保存失败']}};
    return {result: {
      ok: true,
      path: r.path,
      name: r.name,
      segments: ctx.getStore().segments.length,
      message: `工程已保存：${r.path}（${ctx.getStore().segments.length} 个片段，含素材引用/BGM/样式；素材本体不复制，移动工程文件后重新打开需素材仍在原位）`,
    }};
  },

  load_project: async (args, ctx) => {
    const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
    if (!path || !/\.vtproj$/i.test(path)) {
      return {result: {ok: false, errors: ['需要 .vtproj 工程文件的绝对路径（path 参数）']}};
    }
    const store = ctx.getStore();
    // 打开会整体替换当前工程内容：有未保存更改时走确认卡（与录屏/导入同一确认通道）
    if (store.isDirty) {
      const ok = await ctx.requestConfirm('AI 请求打开工程', `将打开「${path}」并替换当前工程内容（当前工程有未保存更改，且不会自动保存）`);
      if (!ok) return {result: {ok: false, errors: ['用户拒绝了打开工程（未保存内容已保留）']}};
    }
    const r = await store.loadProjectPath(path);
    if (!r.ok) return {result: {ok: false, errors: [r.error ?? '打开失败']}};
    const missingNote = r.missingMedia && r.missingMedia.length > 0
      ? `；${r.missingMedia.length} 个素材文件缺失（可能被移动/删除），对应段需重新导入`
      : '';
    return {result: {
      ok: true,
      name: r.name,
      path,
      segments: r.segments,
      ...(r.missingMedia && r.missingMedia.length > 0 ? {missingMedia: r.missingMedia} : {}),
      message: `已打开工程「${r.name}」（${r.segments} 个片段）${missingNote}。`,
    }};
  },

  consolidate_project: async (args, ctx) => {
    const r = validateConsolidateProjectArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    // 收集工程引用的全部本地素材路径（远程 URL/data/blob 跳过，不进包）
    const paths = collectProjectMediaPaths({segments: store.segments, bgm: store.bgm, logo: store.logo});
    if (paths.length === 0) {
      return {result: {ok: false, errors: ['工程没有引用任何本地素材，无需收集（直接 save_project 保存工程文件即可）']}};
    }
    // 复制素材 + 写工程文件是写盘副作用，走确认卡（MCP 模式自动批准）
    if (!(await ctx.requestConfirm('AI 请求收集工程素材', `将把工程引用的 ${paths.length} 个素材文件复制到「${r.args.dir}」的 media 子目录，重写工程内引用指向新位置，并把工程保存到该目录`))) {
      return {result: {ok: false, errors: ['用户拒绝了收集素材操作']}};
    }
    let res: {map: Record<string, string>; missing: string[]; copied: number};
    try {
      res = await window.api.consolidateMedia({dir: r.args.dir, paths});
    } catch (err) {
      return {result: {ok: false, errors: [`收集素材失败：${stripIpcPrefix(err)}`]}};
    }
    // 重写 store 内全部引用（clip src 会话 URL 同步重建，sidecar 路径直接替换），
    // 再把工程写到 <dir>/<工程名>.vtproj（序列化时 src 落盘的是原始路径，正常保存即可）
    const remapped = await ctx.getStore().remapMediaPaths(res.map);
    const name = ctx.getStore().projectName || '未命名工程';
    const sep = /[\\/]$/.test(r.args.dir) ? '' : '/';
    const projectFile = `${r.args.dir}${sep}${name}.vtproj`;
    const save = await ctx.getStore().saveProjectToPath(projectFile);
    if (!save.ok) {
      return {result: {ok: false, errors: [`素材已收集（新复制 ${res.copied} 个、重写引用 ${remapped} 处），但工程保存失败：${save.error ?? '未知错误'}`]}};
    }
    const missingNote = res.missing.length > 0
      ? `；${res.missing.length} 个素材源文件缺失未收集：${res.missing.slice(0, 5).join('、')}${res.missing.length > 5 ? ' 等' : ''}`
      : '';
    return {result: {
      ok: true,
      dir: r.args.dir,
      projectFile: save.path ?? projectFile,
      copied: res.copied,
      remappedRefs: remapped,
      missing: res.missing,
      missingCount: res.missing.length,
      message: `素材已收集到「${r.args.dir}」的 media 子目录（新复制 ${res.copied} 个，重写引用 ${remapped} 处），工程已保存为 ${save.path ?? projectFile}——整个目录可直接搬走/换机${missingNote}`,
    }};
  },

  get_storyboard: async (_args, ctx) => {
    const store = ctx.getStore();
    return {result: {
      note: '素材随片段走：set_storyboard 会重建全部片段并清空素材，已有素材的片段请改用 update_segment 逐段修改（保留素材）。',
      segments: store.segments.map((s, i) => ({
        index: i, templateId: s.templateId, text: s.text, duration: s.duration,
        transition: s.transition, transitionParams: s.transitionParams && Object.keys(s.transitionParams).length > 0 ? s.transitionParams : undefined, videoEffect: s.videoEffect, backgroundEffect: s.backgroundEffect,
        textAnim: s.textAnim, exitStyle: s.exitStyle, narration: s.narration ? {text: s.narration.text} : undefined,
        captions: s.captions && s.captions.length > 0 ? s.captions : undefined,
        customParams: s.customParams && Object.keys(s.customParams).length > 0 ? s.customParams : undefined,
        素材数: s.videos.length,
      })),
      editPlan: store.editPlan ? {
        version: store.editPlan.version,
        stale: store.editPlan.stale ?? false,
        ...(store.editPlan.staleReason ? {staleReason: store.editPlan.staleReason} : {}),
        beats: store.editPlan.beats?.length ?? 0,
        scenes: store.editPlan.scenes?.length ?? 0,
        shots: store.editPlan.shots?.length ?? 0,
        validation: store.editPlan.validation,
        beatSummary: (store.editPlan.beats ?? []).slice(0, 24).map((beat) => ({id: beat.id, index: beat.index, text: beat.text, startSec: beat.startSec, endSec: beat.endSec})),
        shotSummary: (store.editPlan.shots ?? []).slice(0, 32).map((shot) => ({id: shot.id, beatId: shot.beatId, sourcePath: shot.sourcePath, sourceStartSec: shot.sourceStartSec, sourceEndSec: shot.sourceEndSec, timelineStartSec: shot.timelineStartSec, timelineEndSec: shot.timelineEndSec, role: shot.role, confidence: shot.confidence})),
      } : null,
    }};
  },

  get_media_intelligence: async (args, ctx) => {
    const store = ctx.getStore();
    const index = store.mediaIntelligence;
    if (!index) return {result: {ok: true, assets: [], total: 0, note: '暂无统一索引。素材导入后调用 analyze_media_tags 生成镜头/动作理解。'}};
    const query = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase() : '';
    const role = typeof args.role === 'string' ? args.role : '';
    const limit = Math.max(1, Math.min(20, Math.floor(typeof args.limit === 'number' ? args.limit : 8)));
    const assets = Object.values(index.assets).filter((asset) => {
      if (role && !asset.actions.some((a) => a.roles.includes(role as any))) return false;
      if (!query) return true;
      const haystack = [asset.name, asset.description, asset.scene, asset.mood, asset.temporalSummary, ...asset.actions.map((a) => `${a.subject} ${a.action} ${a.after}`), ...asset.transcript.map((c) => c.text), ...asset.ocr.map((c) => c.text)].filter(Boolean).join(' ').toLocaleLowerCase();
      return haystack.includes(query);
    }).slice(0, limit).map((asset) => ({
      path: asset.path,
      name: asset.name,
      durationSec: asset.durationSec,
      description: asset.description,
      scene: asset.scene,
      mood: asset.mood,
      temporalSummary: asset.temporalSummary,
      shots: asset.shots.map((s) => ({startSec: s.startSec, endSec: s.endSec, motionScore: s.motionScore})),
      actions: asset.actions.map((a) => ({startSec: a.startSec, endSec: a.endSec, subject: a.subject, before: a.before, action: a.action, after: a.after, roles: a.roles, confidence: a.confidence})),
      transcript: asset.transcript.slice(0, 8),
      ocr: asset.ocr.slice(0, 8),
      confidence: asset.confidence,
    }));
    return {result: {ok: true, total: assets.length, assets, generatedAt: index.generatedAt}};
  },

  set_storyboard: async (args, ctx) => {
    const r = ctx.llm.validateStoryboardSpec(args);
    if (!r.ok) return {result: {ok: false, errors: r.errors}};
    // 运动连续性：相邻模板运动朝向自动对齐转场方向与下段飞入方向（显式转场的边界不动）
    const store = ctx.getStore();
    const metas = new Map(mergeTemplateMetas(store.customTemplates, store.marketTemplates, store.generatedTemplates).map((t) => [t.id, t]));
    const patches = planMotionChain(r.segments, metas);
    const chained = patches.some((p) => p.changed) ? applyMotionChain(r.segments, patches) : r.segments;
    const chainNote = patches.filter((p) => p.changed).length > 0
      ? `运动连续性：${patches.filter((p) => p.changed).length} 个段间边界已按内容运动方向自动链接（转场方向/飞入方向）`
      : null;
    let suppliedPlan = r.editPlan ? sanitizeEditPlan(r.editPlan) : null;
    if (r.editPlan && !suppliedPlan) return {result: {ok: false, errors: ['editPlan 必须是可解析的对象']}};
    if (suppliedPlan) {
      const capabilities = Object.fromEntries([...metas.entries()].map(([id, meta]) => [id, {minVideos: meta.minVideos, maxVideos: meta.maxVideos}]));
      // A beat normally corresponds to the segment at the same index. Fill
      // missing shot template ids so maxVideos can still be enforced for
      // model-authored plans that only specify beat/shot timing.
      const beatTemplate = new Map<string, string>();
      for (const [index, segment] of chained.entries()) beatTemplate.set(`beat-${index}`, segment.templateId);
      for (const beat of suppliedPlan.beats ?? []) {
        const templateId = chained[beat.index]?.templateId;
        if (templateId) beatTemplate.set(beat.id, templateId);
      }
      const withTemplates = {
        ...suppliedPlan,
        shots: suppliedPlan.shots?.map((shot) => ({
          ...shot,
          ...(shot.templateId ? {} : (beatTemplate.get(shot.beatId) ? {templateId: beatTemplate.get(shot.beatId)} : {})),
        })),
      };
      suppliedPlan = constrainEditPlanShots(withTemplates, capabilities);
      const validation = validateEditPlan(suppliedPlan, [], capabilities);
      if (!validation.ok) return {result: {ok: false, errors: validation.errors, warnings: validation.warnings}};
      suppliedPlan = {...suppliedPlan, validation};
    }
    ctx.getStore().applyAiStoryboard(chained);
    if (suppliedPlan) ctx.getStore().setEditPlan(suppliedPlan);
    // 新故事板 = 新工作会话：复位看图预算（蒸馏/多任务串跑时，此前批次的配额不应累积挤占本批）
    resetImageBudget(budgetOf(ctx));
    return {result: {ok: true, message: `故事板已整体替换为 ${chained.length} 个片段。${suppliedPlan ? `已接收正式 EditPlan（${suppliedPlan.shots?.length ?? 0} 个 shot），素材路径将在导入后校验。` : '素材均为空，提醒用户到故事板上传录屏/图片，或主动提出用录屏/截屏工具帮忙制作素材。'}${chainNote ? ` ${chainNote}。` : ''}`, ...(r.notes.length > 0 ? {notes: r.notes} : {}), ...(suppliedPlan?.validation?.warnings?.length ? {planWarnings: suppliedPlan.validation.warnings} : {})}};
  },

  update_segment: async (args, ctx) => {
    const store = ctx.getStore();
    const index = typeof args.index === 'number' ? args.index : -1;
    if (!Number.isInteger(index) || index < 0 || index >= store.segments.length) {
      return {result: {ok: false, errors: [`下标 ${String(args.index)} 越界，当前故事板共 ${store.segments.length} 段（下标 0 起）`]}};
    }
    // M2 冻结守卫（timeline-master-plan §六.4：模板升级不回写冻结段）：参数/换模板会破坏
    // paramSnapshot 语义 → 拒；文案/时长/转场等放行（不碰冻结语义；排版文案可继续经时间线/文案页编辑）
    const frozenSeg = store.segments[index];
    const rawPatch = (args.patch ?? {}) as Record<string, unknown>;
    if (frozenSeg?.frozen && (rawPatch.customParams !== undefined || rawPatch.templateId !== undefined)) {
      return {result: {ok: false, errors: [`第 ${index + 1} 段已冻结（排版时序由时间线接管，参数快照锁定）——不支持调整模板参数或更换模板；文案、时长、转场等其余字段不受影响`]}};
    }
    // patch 缺 templateId 时沿用该段现有模板
    const r = ctx.llm.validateSegmentPatch(args.patch, index, store.segments[index]?.templateId);
    if (!r.ok) return {result: {ok: false, errors: r.errors}};
    // 命令层事务（HANDOVER 122 移植根治）：before 快照+来源标即时入史。此前直写动作走
    // 500ms 防抖采集器且 agent 标在 executeLlmTool finally 被 drop——程序化调用时后台
    // 无标改动会抢栈顶、undo 弹陈旧条目；显式 source 走命令层后标记机制与本工具无耦合
    store.runTimelineCommand({kind: 'segmentUpdate', index, patch: r.patch}, {source: 'agent', opName: 'update_segment'});
    let appliedParams = r.patch.customParams ? `，参数已应用：${Object.entries(r.patch.customParams).map(([k, v]) => `${k}=${v}`).join('、')}` : '';
    if (r.patch.cursorScript !== undefined) {
      const appliedScript = ctx.getStore().segments[index]?.videos[0]?.cursorActionScript;
      appliedParams += appliedScript ? `，鼠标动作已合成：${appliedScript}` : '，鼠标动作已清除';
    }
    if (r.patch.muted !== undefined || r.patch.volume !== undefined) {
      const v0 = ctx.getStore().segments[index]?.videos[0];
      appliedParams += `，素材原声：${v0?.muted ? '静音' : `音量 ${Math.round((v0?.volume ?? 1) * 100)}%`}`;
    }
    // 回读应用后的段状态：必须从 store 取最新快照——上面的 applyAiSegmentPatch 已触发 set 产生新状态，
    // 顶部捕获的 store 引用还指向旧快照，直接读会回告「改前」的值（蒸馏 D2 批实测误导教师以为补丁未生效）
    const seg = ctx.getStore().segments[index];
    // P0-2 实拍铁律警告（不阻断）：换模板后段内实拍素材会被放进画框/缩成小窗
    const shrinkNote = rawPatch.templateId !== undefined && seg
      ? liveActionShrinkWarning(
          seg.videos,
          mergeTemplateMetas(ctx.getStore().customTemplates, ctx.getStore().marketTemplates, ctx.getStore().generatedTemplates)
            .find((t) => t.id === seg.templateId),
          index,
        )
      : null;
    const outNotes = shrinkNote ? [...r.notes, shrinkNote] : r.notes;
    return {result: {
      ok: true,
      message: `第 ${index + 1} 段已更新${appliedParams}`,
      applied: {
        templateId: seg.templateId,
        duration: seg.duration,
        text: seg.text,
        ...(seg.customParams && Object.keys(seg.customParams).length > 0 ? {customParams: seg.customParams} : {}),
        ...(seg.captions && seg.captions.length > 0 ? {captions: seg.captions} : {}),
        ...(seg.narration ? {narration: seg.narration.text} : {}),
      },
      ...(outNotes.length > 0 ? {notes: outNotes} : {}),
    }};
  },

  get_segment_media: async (args, ctx) => {
    const store = ctx.getStore();
    const r = parseIndexArg(args);
    if (!r.ok) return {result: r};
    const seg = store.segments[r.index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${r.index} 越界，共 ${store.segments.length} 段`]}};
    return {result: {
      ok: true, index: r.index, templateId: seg.templateId, 素材数: seg.videos.length,
      media: seg.videos.map((v, vi) => {
        // P0-4 转写紧凑回流：mine_highlights 回写的 ASR 转写以摘要+关键词形态回到 agent 面
        // （additive 返回字段；全文在 mediaIntelligence 里持久化，不进上下文防撑爆端侧 16k ctx）
        const cues = store.mediaIntelligence?.assets[clipSrcToPath(v.src)]?.transcript ?? [];
        const summary = digestTranscript(cues, undefined, 80);
        const keywords = transcriptKeywords(cues, 8);
        return {
          videoIndex: vi, name: v.name, type: v.type, duration: v.duration,
          width: v.width, height: v.height,
          // 素材来源类型（live-action 实拍 / screen-recording 录屏 / graphic 图形；
          // 模板选型铁律的依据：实拍优先 Fullbleed 满幅族）
          sourceKind: v.sourceKind ?? 'live-action',
          trimStart: v.trimStart ?? 0, trimEnd: v.trimEnd ?? v.duration,
          effectiveDuration: v.trimmedDuration ?? (v.trimEnd ?? v.duration) - (v.trimStart ?? 0),
          ...(v.cuts && v.cuts.length > 0 ? {cuts: v.cuts} : {}),
          viewport: v.viewport ?? null,
          // 素材说了什么（有转写时给 ≤80 字摘要 + 关键词；hasTranscript=false 表示未挖过/无语音）
          hasTranscript: cues.length > 0,
          ...(summary ? {transcriptSummary: summary} : {}),
          ...(keywords.length > 0 ? {transcriptKeywords: keywords.join('、')} : {}),
          // 声明式动作轨迹（cursorScript 设置后回显，模型可查询当前鼠标动作）
          cursorScript: v.cursorActionScript ?? null,
        };
      }),
    }};
  },

  get_template_slot_windows: async (args) => {
    const templateId = String(args.templateId ?? '');
    const w = getTemplateSlotWindows(
      templateId,
      Number(args.durationSec ?? 0),
      Number(args.panelCount ?? 0),
      {
        dwellRatio: args.dwellRatio !== undefined ? Number(args.dwellRatio) : undefined,
        focusPanel: args.focusPanel !== undefined ? Number(args.focusPanel) : undefined,
        focusBoost: args.focusBoost !== undefined ? Number(args.focusBoost) : undefined,
        camSpeed: args.camSpeed !== undefined ? Number(args.camSpeed) : undefined,
      },
    );
    if (!w) {
      return {result: {ok: false, errors: [`「${templateId || '(空)'}」不是支持槽位窗口查询的模板（七款 3D 家族：${SLOT_WINDOW_TEMPLATE_IDS.join(' / ')}），或时长/展板数非法`]}};
    }
    const maxDwell = Math.max(...w.slots.map((s) => s.dwellDurSec));
    return {
      result: {
        ok: true,
        templateId: w.templateId,
        durationSec: w.durationSec,
        panelCount: w.panelCount,
        effective: w.effective,
        openSec: w.openSec,
        outroSec: w.outroSec,
        slots: w.slots.map((s) => ({
          index: s.index,
          travelSec: `${s.travelStartSec.toFixed(2)}-${s.travelEndSec.toFixed(2)}`,
          dwellSec: `${s.dwellStartSec.toFixed(2)}-${s.dwellEndSec.toFixed(2)}`,
          dwellDurSec: s.dwellDurSec,
        })),
        note: `画中画只在各自驻留窗口播放：第 index 块板的素材从驻留开始（dwellSec 起点）播放，可见时长 = dwellDurSec。素材的精彩时刻应落在素材本地 0 ~ dwellDurSec 内（≤${maxDwell.toFixed(2)}s）。给某块板单独加时：focusPanel+focusBoost；camSpeed 舒缓档(0)拉长行进、缩短驻留。`,
      },
    };
  },

  view_segment_frame: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateViewFrameArgs(args);
    if (!r.ok) return {result: r};
    const {index, videoIndex, timeSec} = r.args;
    const seg = store.segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界，共 ${store.segments.length} 段`]}};
    const clip = seg.videos[videoIndex];
    if (!clip) return {result: {ok: false, errors: [`第 ${index + 1} 段无第 ${videoIndex} 个视频（共 ${seg.videos.length} 个）`]}};
    // timeSec 缺省(<=0) 取视频中点
    const t = timeSec > 0 ? Math.min(timeSec, clip.duration) : clip.duration / 2;
    // 落进挖段的时间点轻推到洞出口（抽到的是真实可播画面）
    const inCut = cutAt(t, clip.cuts);
    const viewT = inCut ? inCut.end : t;
    const filePath = clipSrcToPath(clip.src);
    // 看图预算：同一帧重复抽/会话图量超限时不再抽帧（省 ffmpeg + 省模型上下文），原因回告模型
    const verdict = takeImageBudget(budgetOf(ctx), frameBudgetKey(filePath, viewT));
    if (!verdict.allow) {
      return {result: {ok: true, index, videoIndex, timeSec: viewT, imageSkipped: verdict.reason,
        note: `未附图：${verdict.reason}`}};
    }
    try {
      const frame = await window.api.extractFrame(filePath, viewT);
      // 视觉中继（决策脑/看图脑分离）：帧交由看图子会话评估，文字结论回传，主上下文不进图
      if (ctx.visionRelay) {
        const question = `这是第 ${index + 1} 段视频 ${videoIndex} 在 ${viewT.toFixed(1)}s 的画面${inCut ? `（${t.toFixed(1)}s 落在挖段内取洞出口）` : ''}。请客观描述并评估：主体与构图、明暗与画质、有无缺陷（黑场/水印/糊/穿帮）、适合承载的文案情绪。120 字内。`;
        const verdict = await ctx.visionRelay([{dataUrl: frame.dataUrl, note: `第${index + 1}段 ${viewT.toFixed(1)}s`}], question);
        return {result: {ok: true, index, videoIndex, timeSec: viewT, seen: true,
          verdict, note: `第${index + 1}段视频${videoIndex}在 ${viewT.toFixed(1)}s 画面已由看图评估：见 verdict`}};
      }
      return {
        result: {ok: true, index, videoIndex, timeSec: viewT, width: frame.width, height: frame.height,
          note: `第${index + 1}段视频${videoIndex}在 ${viewT.toFixed(1)}s 的画面已附图，请查看${inCut ? `（${t.toFixed(1)}s 落在挖段内，已取洞出口画面）` : ''}`},
        image: {dataUrl: frame.dataUrl, note: `第${index + 1}段视频${videoIndex}在 ${viewT.toFixed(1)}s 的画面`},
      };
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  scratch_pad: async (args, ctx) => {
    const mode = args.mode;
    const content = typeof args.content === 'string' ? args.content : '';
    const pad = scratchpadOf(ctx);
    if (mode === 'read') {
      const text = pad.read();
      return {result: {ok: true, empty: text.length === 0, content: text || '（草稿本为空）',
        note: text ? '草稿本内容如上（已完成/待办/决策都在这里）' : '草稿本为空，建议开工时先写下计划'}};
    }
    if (mode === 'append') {
      if (!content.trim()) return {result: {ok: false, errors: ['append 需要非空 content']}};
      const prev = pad.read();
      const next = prev ? `${prev}\n${content.trim()}` : content.trim();
      pad.write(next);
      return {result: {ok: true, lines: next.split('\n').length, note: '已追加到草稿本'}};
    }
    if (mode === 'replace') {
      pad.write(content.trim());
      return {result: {ok: true, note: '草稿本已整体重写'}};
    }
    return {result: {ok: false, errors: [`未知 mode：${String(mode)}（read/append/replace）`]}};
  },

  get_transition_templates: async (args) => {
    const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined;
    const defs = listTransitionTemplates(tag ? {narrativeTag: tag} : {});
    if (defs.length === 0) {
      return {result: {ok: true, templates: [], note: `没有带「${tag}」叙事标签的转场模板（现有标签：运动连续/节奏卡点/场景切换/揭示），不传 tag 看全量`}};
    }
    return {
      result: {
        ok: true,
        count: defs.length,
        ...(tag ? {tag} : {}),
        note: '转场模板挂在「上一段」的 update_segment（transitionTemplateId + transitionTemplateParams），作用于该段到下一段的衔接；ready=false 的合成尚未上线，选了会回退内置转场效果',
        templates: defs.map((d) => ({
          id: d.id, name: d.name, desc: d.desc,
          durationSec: d.durationRange, defaultDurationSec: d.defaultDurationSec,
          inputs: d.inputs, tags: d.narrativeTags,
          ...(d.sfx ? {sfx: d.sfx} : {}),
          params: d.paramSpecs.map((p) => `${p.key}(${p.min}-${p.max}默认${p.default})`),
          ready: d.composable,
        })),
      },
    };
  },

  set_segment_trim: async (args, ctx) => {
    const r = validateSetTrimArgs(args);
    if (!r.ok) return {result: r};
    const {index, videoIndex, trimStart, trimEnd, cuts} = r.args;
    const seg = ctx.getStore().segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界`]}};
    if (!seg.videos[videoIndex]) return {result: {ok: false, errors: [`第 ${index + 1} 段无第 ${videoIndex} 个视频`]}};
    ctx.getStore().runTimelineCommand({kind: 'segmentVideoTrim', index, videoIndex, trimStart, trimEnd, cuts});
    // store 内部按 clip.duration clamp 并归一挖段，回报实存值而非请求原值，避免模型基于错误区间继续决策
    const saved = ctx.getStore().segments[index]?.videos[videoIndex];
    const ts = saved?.trimStart ?? trimStart;
    const te = saved?.trimEnd ?? trimEnd;
    const savedCuts = saved?.cuts;
    const eff = saved?.trimmedDuration ?? te - ts;
    const cutsNote = savedCuts && savedCuts.length > 0
      ? `，挖段 ${savedCuts.length} 处（${savedCuts.map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)}s`).join('、')}）`
      : '';
    return {result: {ok: true, message: `第 ${index + 1} 段视频 ${videoIndex} 已裁剪为 ${ts.toFixed(1)}-${te.toFixed(1)}s${cutsNote}，有效时长 ${eff.toFixed(1)}s`, trimStart: ts, trimEnd: te, ...(savedCuts ? {cuts: savedCuts} : {}), effectiveDuration: eff}};
  },

  mine_highlights: async (args, ctx) => {
    const r = validateMineHighlightsArgs(args);
    if (!r.ok) return {result: r};
    const {index, videoIndex, targetDurationSec, maxSegments, focus} = r.args;
    const store = ctx.getStore();
    const seg = store.segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界，共 ${store.segments.length} 段`]}};
    const picked = resolveMiningClip(seg, videoIndex, index);
    if (!picked.ok) return {result: picked};
    const clip = picked.clip;
    if (clip.duration < 20) {
      return {result: {ok: false, errors: [`素材「${clip.name}」只有 ${clip.duration.toFixed(0)}s，挖矿意义不大——直接 set_segment_trim 裁剪即可（建议 ≥60s 的长素材再挖高光）`]}};
    }

    // 1) 主进程时间线：时长 + 语音窗口 + 可选 ASR 分段（ASR 失败自动降级不阻断）
    // P0-4 转写回流：工程已存该素材转写时复用（不重跑 ASR），分析成功后回写 mediaIntelligence
    const mediaPath = clipSrcToPath(clip.src);
    const prevIndex = store.mediaIntelligence;
    const cachedAsset = prevIndex?.assets[mediaPath];
    const cachedCues = cachedAsset?.transcript ?? [];
    const canReuseCache =
      cachedCues.length > 0 &&
      Math.abs((cachedAsset?.durationSec ?? 0) - (clip.duration || 0)) <= 1.5; // 素材时长对不上视为缓存过期
    let timeline;
    try {
      timeline = await window.api.miningAnalyzeTimeline(
        mediaPath,
        canReuseCache ? {asrSegments: cuesToRawAsrSegments(cachedCues)} : undefined,
      );
    } catch (err) {
      return {result: {ok: false, errors: [`素材时间线分析失败：${stripIpcPrefix(err)}`]}};
    }
    const cues: TranscriptCue[] = timeline.asrUsed && timeline.asrSegments
      ? timeline.asrSegments.map((s) => ({startSec: s.start, endSec: s.end, text: s.text}))
      : [];
    if (cues.length > 0) {
      // transcript 字段此前无写入方（诊断 §2.5-2）——这里补上；内容没变则不写（防 updatedAt 空转）
      const same =
        cachedCues.length === cues.length &&
        cachedCues.every((c, i) => Math.abs(c.startSec - cues[i].startSec) < 0.01 && c.text === cues[i].text);
      if (!same) {
        const base: MediaIntelligenceIndex = prevIndex ?? {version: 1, generatedAt: new Date().toISOString(), assets: {}};
        const assets = {...base.assets};
        assets[mediaPath] = base.assets[mediaPath]
          ? {...base.assets[mediaPath], transcript: cues, updatedAt: new Date().toISOString()}
          : buildMediaIntelligenceAsset({path: mediaPath, name: clip.name, durationSec: timeline.durationSec, type: clip.type, transcript: cues});
        store.setMediaIntelligence({...base, assets});
      }
    }
    const digestFor = (s: number, e: number): string => digestTranscript(cues, {startSec: s, endSec: e}, 60);
    const clusters = buildSpeechClusters(timeline.asrSegments ?? []);

    // 1b) 启发式预筛（零模型 token）：场景检测 + 音轨能量 + 代表帧曝光 → top-N 候选。
    // 未配多模态模型时它就是完整产出（不再死路）；配了则作为看图精选的先验 + 精选面板数据
    let heuristic: Awaited<ReturnType<typeof window.api.miningHighlightCandidates>> | null = null;
    try {
      heuristic = await window.api.miningHighlightCandidates({
        path: clipSrcToPath(clip.src),
        topN: Math.max(5, Math.min(10, maxSegments + 2)),
        targetSec: targetDurationSec,
      });
      // 候选存 store（精选面板消费；会话态不持久化）
      store.setHighlightCandidates(index, picked.videoIndex, {
        mediaName: clip.name,
        durationSec: timeline.durationSec,
        candidates: heuristic.candidates,
        thumbnails: heuristic.thumbnails,
        usedAi: false, // 看图精选成功后回写 true
      });
    } catch {
      heuristic = null; // 预筛失败不阻断（老链路继续）
    }

    // 2) 均匀抽帧（视觉模型看整条素材的内容分布；extractFrames 单次 ≤4 帧，分批取）
    const frameCount = Math.max(4, Math.min(8, Math.round(timeline.durationSec / 30)));
    const frameTimes = sampleFrameTimes(timeline.durationSec, frameCount);
    const frames: {dataUrl: string}[] = [];
    try {
      for (let i = 0; i < frameTimes.length; i += 4) {
        const batch = await window.api.extractFrames({path: clipSrcToPath(clip.src), timesSec: frameTimes.slice(i, i + 4)});
        frames.push(...batch);
      }
    } catch (err) {
      return {result: {ok: false, errors: [`抽帧失败：${stripIpcPrefix(err)}`]}};
    }

    // 3) 多模态 LLM 选高光（帧时间戳在提示词里标注；启发式候选作为先验附上）
    const heuristicSection = heuristic && heuristic.candidates.length > 0
      ? `\n\n本地启发式预筛候选（运动/音轨/曝光信号打分，可采纳/调整/否决，也要结合画面内容判断）：\n${heuristic.candidates.map((c, i) => `${i + 1}. ${c.startSec.toFixed(1)}-${c.endSec.toFixed(1)}s（综合 ${c.score}：${c.reasons.join('、')}）`).join('\n')}`
      : '';
    const prompt = buildMiningPrompt({
      durationSec: timeline.durationSec,
      targetDurationSec,
      maxSegments,
      ...(focus ? {focus} : {}),
      clusters,
      asrUsed: timeline.asrUsed,
      frameTimes: frameTimes.slice(0, frames.length),
    }) + heuristicSection;
    const content: ContentPart[] = [
      {type: 'text', text: prompt},
      ...frames.map((f) => ({type: 'image_url' as const, image_url: {url: f.dataUrl}})),
    ];
    let assistantText = '';
    try {
      const reply = await window.api.llmChat({messages: [{role: 'user', content}]});
      assistantText = typeof reply.content === 'string' ? reply.content
        : Array.isArray(reply.content) ? reply.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        : '';
    } catch (err) {
      const msg = stripIpcPrefix(err);
      if (/未配置/.test(msg) && heuristic && heuristic.candidates.length > 0) {
        // 未配多模态：启发式候选即产出（精选面板可人工点选；配置视觉模型可看图精选提准）
        const kept = heuristic.candidates.slice(0, maxSegments);
        const keptSec = kept.reduce((sum, p) => sum + (p.endSec - p.startSec), 0);
        return {result: {
          ok: true, heuristic: true, index, videoIndex: picked.videoIndex, mediaName: clip.name,
          durationSec: timeline.durationSec,
          highlights: kept.map((p) => {
            const d = digestFor(p.startSec, p.endSec);
            return {startSec: p.startSec, endSec: p.endSec, summary: p.reasons.join('、'), reason: `启发式：运动 ${p.motion} / 音轨 ${p.audio} / 曝光 ${p.exposure}`, ...(d ? {transcriptDigest: d} : {})};
          }),
          totalKeptSec: Math.round(keptSec * 10) / 10,
          message: `未配置多模态视觉模型——已用本地启发式预筛（场景检测+音轨能量+曝光，零 token）从 ${timeline.durationSec.toFixed(0)}s 的「${clip.name}」选出 top-${kept.length} 候选共 ${keptSec.toFixed(0)}s，结果已进「高光精选」面板（素材卡打开人工点选确认）。配置视觉模型后重挖可看图精选提准；确认区间后 apply_cut_list(index=${index}, keepRanges=...) 落地。`,
        }};
      }
      if (/未配置/.test(msg)) {
        return {result: {ok: false, errors: [`${msg}。挖高光需在「设置 → AI 助手」配置多模态视觉模型（如 gpt-4o / qwen-vl / glm-4v）。`]}};
      }
      if (/image|vision|视觉|multimodal|400|422/i.test(msg)) {
        return {result: {ok: false, errors: [`当前模型可能不支持看图（${msg}）。请到「设置 → AI 助手」切换为多模态视觉模型（如 gpt-4o / qwen-vl / glm-4v）后重试。`]}};
      }
      return {result: {ok: false, errors: [`挖高光模型调用失败：${msg}`]}};
    }

    const picks = parseHighlightResponse(assistantText, timeline.durationSec);
    if (!picks) {
      return {result: {ok: false, errors: ['模型返回无法解析为高光清单（expected {"highlights": [...]} JSON）。请重试一次；若持续失败可改用 view_media_frames 逐段看画面后手动 set_segment_trim。'], raw: assistantText.slice(0, 400)}};
    }
    const keptSec = picks.reduce((sum, p) => sum + (p.endSec - p.startSec), 0);
    return {result: {
      ok: true,
      index,
      videoIndex: picked.videoIndex,
      mediaName: clip.name,
      durationSec: timeline.durationSec,
      asrUsed: timeline.asrUsed,
      ...(timeline.asrError ? {asrNote: `ASR 未参与：${timeline.asrError}（本次仅靠画面与语音窗口判断，可配置后重挖提准）`} : {}),
      highlights: picks.map((p) => {
        const d = digestFor(p.startSec, p.endSec);
        return {startSec: p.startSec, endSec: p.endSec, summary: p.summary, reason: p.reason, ...(d ? {transcriptDigest: d} : {})};
      }),
      totalKeptSec: Math.round(keptSec * 10) / 10,
      message: `从 ${timeline.durationSec.toFixed(0)}s 的「${clip.name}」挖出 ${picks.length} 段高光，共 ${keptSec.toFixed(0)}s（目标 ${targetDurationSec}s）${timeline.asrUsed ? '（含 ASR 转写线索）' : '（无 ASR 线索，纯画面判断）'}${canReuseCache && timeline.asrUsed ? '；已复用工程转写缓存（未重跑 ASR）' : ''}。高光区间带 transcriptDigest（该区间讲了什么）。确认无误后：apply_cut_list(index=${index}, keepRanges=上面各区间的 start/end) 一步浓缩落地；或对个别区间 split_segment 拆段分别包装。不满意可带 focus 重挖。`,
    }};
  },

  apply_cut_list: async (args, ctx) => {
    const r = validateApplyCutListArgs(args);
    if (!r.ok) return {result: r};
    const {index, videoIndex, keepRanges} = r.args;
    const store = ctx.getStore();
    const seg = store.segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界，共 ${store.segments.length} 段`]}};
    const picked = resolveMiningClip(seg, videoIndex, index);
    if (!picked.ok) return {result: picked};
    const clip = picked.clip;
    const keeps = normalizeKeepRanges(keepRanges, clip.duration);
    if (keeps.length === 0) {
      return {result: {ok: false, errors: [`保留区间全部无效（过短或超出素材时长 ${clip.duration.toFixed(1)}s），未做任何修改`]}};
    }
    const {trimStart, trimEnd, cuts} = keepRangesToTrim(keeps);
    store.updateSegmentVideoTrim(index, picked.videoIndex, trimStart, trimEnd, cuts);
    // 段时长自动对齐有效时长（单段上限 60s；超限截断并提示拆段）
    const saved = ctx.getStore().segments[index]?.videos[picked.videoIndex];
    const eff = saved?.trimmedDuration ?? 0;
    const fitDur = Math.max(0.5, Math.min(60, Math.round(eff * 10) / 10));
    const segNow = ctx.getStore().segments[index];
    if (segNow && Math.abs((segNow.duration ?? 0) - eff) > 0.05) {
      // 时长对齐同走命令层事务（与裁剪各自一条历史——undo 可分步回退；来源标=本工具名）
      ctx.getStore().runTimelineCommand({kind: 'segmentUpdate', index, patch: {
        templateId: segNow.templateId, duration: fitDur,
        transition: undefined, videoEffect: undefined, backgroundEffect: undefined,
        textAnim: undefined, exitStyle: undefined, narration: undefined, captions: undefined,
        text: undefined, customParams: undefined, transitionParams: undefined, cursorScript: undefined,
        muted: undefined, volume: undefined,
      }}, {source: 'agent', opName: 'apply_cut_list'});
    }
    const cappedNote = eff > 60.05 ? `；有效时长超出单段上限，段时长按 60s 截断——多余高光请 split_segment 拆成多段` : '';
    const cutsNote = cuts.length > 0 ? `，挖段 ${cuts.length} 处` : '';
    return {result: {
      ok: true,
      index,
      videoIndex: picked.videoIndex,
      keepRanges: keeps,
      trimStart, trimEnd, cuts,
      effectiveDuration: eff,
      segmentDuration: fitDur,
      message: `「${clip.name}」已浓缩：保留 ${keeps.length} 段（${keeps.map((k) => `${k.start.toFixed(1)}-${k.end.toFixed(1)}s`).join('、')}），可用区间 ${trimStart.toFixed(1)}-${trimEnd.toFixed(1)}s${cutsNote}，有效时长 ${eff.toFixed(1)}s，段时长已对齐 ${fitDur.toFixed(1)}s${cappedNote}。建议 view_segment_frame 或 preview_storyboard_frame 抽查切点。`,
    }};
  },

  set_segment_viewport: async (args, ctx) => {
    const r = validateSetViewportArgs(args);
    if (!r.ok) return {result: r};
    const {index, videoIndex, scale, offsetX, offsetY} = r.args;
    const seg = ctx.getStore().segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界`]}};
    if (!seg.videos[videoIndex]) return {result: {ok: false, errors: [`第 ${index + 1} 段无第 ${videoIndex} 个视频`]}};
    const viewport = (scale === undefined && offsetX === undefined && offsetY === undefined)
      ? undefined
      : {scale: scale ?? 1, offsetX: offsetX ?? 0, offsetY: offsetY ?? 0};
    ctx.getStore().updateSegmentVideoViewport(index, videoIndex, viewport);
    return {result: {ok: true, message: `第 ${index + 1} 段视频 ${videoIndex} 视口已更新`, viewport}};
  },

  set_segment_overlay: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateSetOverlayArgs(args);
    if (!r.ok) return {result: r};
    const seg = store.segments[r.args.index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${r.args.index} 越界，共 ${store.segments.length} 段`]}};
    if (r.args.remove) {
      store.setSegmentOverlay(r.args.index, null);
      return {result: {ok: true, message: `第 ${r.args.index + 1} 段悬浮层已移除`}};
    }
    if (!seg.overlay) {
      return {result: {ok: false, errors: [`第 ${r.args.index + 1} 段还没有悬浮层。请先用 capture_element（attachToSegment 指定该段）生成并贴附透明 PNG 素材`]}};
    }
    if (Object.keys(r.args.patch).length === 0) {
      return {result: {ok: false, errors: ['至少提供一个调整字段（x/y/scale/floatAmp/tiltX/tiltY/radius/shadow/opacity），或 remove=true 移除']}};
    }
    store.setSegmentOverlay(r.args.index, {...seg.overlay, ...r.args.patch});
    return {result: {ok: true, message: `第 ${r.args.index + 1} 段悬浮层已更新：${Object.keys(r.args.patch).join('、')}`, overlay: {...seg.overlay, ...r.args.patch}}};
  },

  synthesize_narration: async (args, ctx) => {
    const store = ctx.getStore();
    const idx = args.index;
    // 显式给了 index 就必须落在有效范围内（缺省 = 全部有文案的段），越界直接报友好错误
    if (idx !== undefined && idx !== null
      && (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= store.segments.length)) {
      return {result: {ok: false, errors: [`下标 ${String(idx)} 越界，当前故事板共 ${store.segments.length} 段（下标 0 起）`]}};
    }
    // 语速：显式传入则钳 0.5-2 并持久化到各段；缺省沿用各段已存值（首次合成 = 1）
    let speed: number | undefined;
    if (args.speed !== undefined && args.speed !== null) {
      if (typeof args.speed !== 'number' || !Number.isFinite(args.speed)) {
        return {result: {ok: false, errors: ['speed 必须是 0.5-2 的数字']}};
      }
      speed = Math.min(2, Math.max(0.5, args.speed));
    }
    // 音色：显式传入则校验并持久化；缺省沿用各段已存值（再缺省 = 设置里的默认音色）
    let voice: string | undefined;
    if (args.voice !== undefined && args.voice !== null) {
      if (typeof args.voice !== 'string' || !args.voice.trim()) {
        return {result: {ok: false, errors: ['voice 必须是非空字符串（音色名）']}};
      }
      voice = args.voice.trim().slice(0, 60);
    }
    const indices: number[] = (typeof idx === 'number' && Number.isInteger(idx))
      ? [idx]
      : store.segments.map((_, i) => i).filter((i) => (store.segments[i].narration?.text || '').trim());
    if (indices.length === 0) {
      return {result: {ok: false, errors: ['没有可合成的旁白文案（请先用 update_segment 填写 narration.text）']}};
    }
    // TTS 合成消耗用户额度，需本人确认
    if (!(await ctx.requestConfirm('AI 请求合成旁白语音', `将调用 TTS 服务为 ${indices.length} 个片段合成旁白（消耗你的 TTS 服务额度）`))) {
      return {result: {ok: false, errors: ['用户拒绝了旁白合成操作']}};
    }
    const results: unknown[] = [];
    for (const i of indices) {
      const text = (store.segments[i].narration?.text || '').trim();
      if (!text) {results.push({index: i, skipped: true, reason: '无文案'}); continue;}
      const segSpeed = speed ?? store.segments[i].narration?.speed ?? 1;
      const segVoice = voice ?? store.segments[i].narration?.voice;
      try {
        const r = await window.api.ttsSynthesize({text, speed: segSpeed, ...(segVoice ? {voice: segVoice} : {})});
        store.updateSegmentNarration(i, {
          src: r.src, path: r.path, duration: r.duration, source: 'tts', speed: segSpeed,
          ...(segVoice ? {voice: segVoice} : {}),
          volume: store.segments[i].narration?.volume ?? 1,
        });
        // 旁白时长护栏：旁白比段长会溢出重叠到下一段——把溢出事实与修复建议写进结果
        const segDur = store.segments[i].duration || 8;
        const overflowSec = Math.round((r.duration - segDur) * 100) / 100;
        results.push({
          index: i, ok: true, duration: r.duration, segmentDuration: segDur, speed: segSpeed,
          ...(segVoice ? {voice: segVoice} : {}),
          ...(overflowSec > 0.3
            ? {overflowSec, overflowNote: `旁白比段长长 ${overflowSec}s，会溢出重叠到下一段。修复：提速重合成（本工具 speed 参数，≤1.4 不伤听感），或用 update_segment 把该段 duration 延长到 ≥${(Math.round((r.duration + 0.4) * 10) / 10)}s`}
            : {}),
        });
      } catch (err) {
        const msg = stripIpcPrefix(err);
        results.push({index: i, ok: false, error: msg});
        // 未配置/解密失败等全局错误，提前返回更友好
        if (/未配置|解密失败|无法连接/.test(msg)) {
          return {result: {ok: false, errors: [msg], partial: results}};
        }
      }
    }
    return {result: {ok: true, results}};
  },

  get_project_info: async (_args, ctx) => {
    const store = ctx.getStore();
    return {result: {
      ok: true,
      videoType: store.videoType,
      videoTypeLabel: VIDEO_TYPE_LABEL[store.videoType],
      aspectRatioId: store.aspectRatioId,
      orientation: store.orientation,
      totalDuration: store.getTotalDuration(),
      segmentCount: store.segments.length,
      // 渲染状态（双模型路由：小模型渲染后常轮询本工具而非 get_app_status——把完成态带在这里它才能收尾）
      isRendering: store.isRendering,
      renderProgress: store.renderProgress,
      renderOutputPath: store.renderOutputPath || null,
      lastRenderMatchesCurrent: store.lastRenderInfo
        ? store.lastRenderInfo.fingerprint === currentContentFingerprint(store)
        : null,
      hasBgm: Boolean(store.bgm),
      bgmName: store.bgm?.name || null,
      bgmDucking: store.bgm?.ducking || null,
      hasLogo: Boolean(store.logo),
      logo: store.logo ? {position: store.logo.position, size: store.logo.size, opacity: store.logo.opacity, visible: store.logo.visible} : null,
      captionStyle: store.captionStyle,
      finePrint: store.finePrint.text.trim() ? store.finePrint : null,
      colorGrade: store.colorGrade,
      brandColor: store.brandColor,
      fontMood: store.fontMood,
      segmentsWithMedia: store.segments.filter((s) => s.videos.length > 0).length,
      segmentsWithNarration: store.segments.filter((s) => s.narration?.text?.trim()).length,
      segmentsWithCaptions: store.segments.filter((s) => s.captions && s.captions.length > 0).length,
      editPlan: store.editPlan ? {
        version: store.editPlan.version,
        stale: store.editPlan.stale ?? false,
        ...(store.editPlan.staleReason ? {staleReason: store.editPlan.staleReason} : {}),
        beats: store.editPlan.beats?.length ?? 0,
        scenes: store.editPlan.scenes?.length ?? 0,
        shots: store.editPlan.shots?.length ?? 0,
        validation: store.editPlan.validation,
      } : null,
      mediaIntelligence: store.mediaIntelligence ? {
        version: store.mediaIntelligence.version,
        generatedAt: store.mediaIntelligence.generatedAt,
        assets: Object.values(store.mediaIntelligence.assets).map((a) => ({path: a.path, name: a.name, durationSec: a.durationSec, shots: a.shots.length, actions: a.actions.length, transcriptCues: a.transcript.length, ocrCues: a.ocr.length, confidence: a.confidence})),
      } : null,
      // 素材打标（analyze_media_tags 产出，随工程保存）：文案 ↔ 素材自动对位用
      mediaTags: Object.keys(store.mediaTags).length > 0
        ? store.segments.flatMap((s, i) => s.videos.map((v) => {
            const tag = store.mediaTags[v.src];
            return tag
              ? {
                  segmentIndex: i,
                  name: v.name,
                  description: tag.description,
                  mood: tag.mood,
                  scene: tag.scene,
                  ...(tag.note ? {note: tag.note} : {}),
                  ...(tag.temporalSummary ? {temporalSummary: tag.temporalSummary} : {}),
                  ...(tag.storyUnits?.length ? {
                    storyUnits: tag.storyUnits.slice(0, 8).map((unit) => ({
                      startSec: unit.startSec,
                      endSec: unit.endSec,
                      subject: unit.subject,
                      before: unit.before,
                      action: unit.action,
                      after: unit.after,
                      roles: unit.roles,
                    })),
                  } : {}),
                }
              : {segmentIndex: i, name: v.name, note: '未打标（可先 analyze_media_tags）'};
          })).slice(0, 24)
        : [],
      mediaTagsTotal: Object.keys(store.mediaTags).length,
      publish: {
        metadata: store.publish.metadata,
        cover: store.publish.cover,
        note: '封面/发布元数据可用 export_cover 与 set_publish_metadata 工具生成或更新',
      },
    }};
  },

  set_segment_captions: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateSetCaptionsArgs(args);
    if (!r.ok) return {result: r};
    const {index, captions} = r.args;
    const seg = store.segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界，共 ${store.segments.length} 段`]}};
    const duration = seg.duration || 8;
    const overflow = captions.find((c) => c.endSec > duration + 0.01);
    if (overflow) {
      return {result: {ok: false, errors: [`字幕 endSec(${overflow.endSec}s) 超过第 ${index + 1} 段时长 ${duration}s`]}};
    }
    store.runTimelineCommand({kind: 'segmentCaptions', index, captions: captions.length > 0 ? captions : undefined});
    return {result: {ok: true, message: captions.length > 0 ? `第 ${index + 1} 段已设置 ${captions.length} 行字幕` : `第 ${index + 1} 段字幕已清除`}};
  },

  set_bgm_ducking: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateDuckingArgs(args);
    if (!r.ok) return {result: r};
    if (!store.bgm) {
      return {result: {ok: false, errors: ['尚未添加背景音乐，无法设置避让。请先让用户在背景音乐面板添加 BGM。']}};
    }
    store.setBgmDucking(r.args.enabled, r.args.amount);
    return {result: {ok: true, message: `BGM 避让已${r.args.enabled ? '开启' : '关闭'}${r.args.enabled ? `（旁白期间压到 ${Math.round(r.args.amount * 100)}%）` : ''}`}};
  },

  // ====== agent 面时间线工具（P2.5 阶段三 v3）：布局/钳制与 UI 时间轴同源 ======

  get_timeline: async (_args, ctx) => {
    const store = ctx.getStore();
    const layout = computeTimelineLayout(store.segments);
    const bgm = store.bgm;
    // shot 投影（additive 字段，schema 定稿 v1.0）：可渲染谓词与渲染端 isSegmentRenderable 同义
    const allTemplates = mergeTemplateMetas(store.customTemplates, store.marketTemplates, store.generatedTemplates);
    const shotTimeline = computeShotTimeline(store.segments, {
      isRenderable: (seg) => allTemplates.some((t) => t.id === seg.templateId),
    });
    const shots = shotSummary(shotTimeline);
    // 模板制作指导摘要（v1.3 additive；未入 plan 批次的模板不出现该键——旧消费方无感）
    const planSummaries = store.segments.map((seg) => segmentPlanSummary(seg));
    const clips = store.segments.map((seg, i) => ({
      index: i,
      templateId: seg.templateId,
      startSec: layout.clips[i].startSec,
      durationSec: layout.clips[i].durationSec,
      transition:
        i < store.segments.length - 1 && seg.transition !== 'none'
          ? {
              type: seg.transition,
              durationSec: layout.transitions[i].durationSec,
              sfx: seg.transitionSfx ?? 'auto',
            }
          : 'none',
      media: seg.videos.map((v) => ({
        name: v.name,
        type: v.type,
        ...(v.type === 'image'
          ? {}
          : {
              sourceDurationSec: v.duration,
              trimStartSec: v.trimStart ?? 0,
              trimEndSec: v.trimEnd ?? v.duration,
              ...(v.muted ? {muted: true} : {}),
              ...(v.volume !== undefined && v.volume !== 1 ? {volume: v.volume} : {}),
            }),
      })),
      ...(seg.narration?.duration && seg.narration.duration > 0
        ? {
            narration: {
              offsetSec: seg.narration.offsetSec ?? 0,
              durationSec: seg.narration.duration,
              volume: seg.narration.volume ?? 1,
            },
          }
        : {}),
      // 模板制作指导摘要（v1.3 additive；未入 plan 批次的模板不出现该键——旧消费方无感）
      ...(planSummaries[i] ? {plan: planSummaries[i]!} : {}),
      // 手放节拍标记（v1.4 additive；仅手放过的段出现。与 plan.beats（推导投影）是两回事：
      // 这是输入原语——合成时与 BGM 拍点并流成该段节拍网格供模板消费）
      ...(seg.beats && seg.beats.length > 0 ? {beats: seg.beats} : {}),
    }));
    return {
      result: {
        ok: true,
        fps: TIMELINE_FPS,
        totalSec: layout.totalSec,
        clips,
        // shot 列表（additive，v1.0 定稿）：全片有序、id 稳定（素材 shot=clip.id，纯模板=text-{segment.id}）
        shots: shotTimeline.shots,
        bgm: bgm
          ? {
              name: bgm.name,
              sourceDurationSec: bgm.duration,
              startAtSec: bgmStartAtSec(bgm),
              trimStartSec: bgmTrimStartSec(bgm),
              trimEndSec: bgmTrimEndSec(bgm),
              loopSpanSec: bgmLoopSpanSec(bgm),
              fadeInSec: bgm.fadeIn,
              fadeOutSec: bgm.fadeOut,
              volume: bgm.volume,
              volumeKeys: bgm.volumeKeys ?? [], // 音量包络（空数组 = 无包络恒定音量；additive v1.2）
              beatCount: bgmTimelineBeats(bgm).length,
              bpm: bgm.bpm ?? 0,
            }
          : null,
        sfx: store.sfx,
        message: `时间轴全景：${store.segments.length} 片段共 ${layout.totalSec.toFixed(1)}s、${shots.count} 个 shot（素材 ${shots.mediaCount} / 纯模板 ${shots.textCount}${shots.layeredSegs > 0 ? ` / 叠层段 ${shots.layeredSegs}` : ''}）${
          bgm
            ? `；BGM「${bgm.name}」起播 ${bgmStartAtSec(bgm).toFixed(1)}s、循环窗 ${bgmTrimStartSec(bgm).toFixed(1)}~${bgmTrimEndSec(bgm).toFixed(1)}s`
            : '；未设置 BGM'
        }`,
      },
    };
  },

  get_segment_plan: async (args, ctx) => {
    const r = validateGetSegmentPlanArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const seg = store.segments[r.args.segmentIndex];
    if (!seg) {
      return {result: {ok: false, errors: [`段 ${r.args.segmentIndex} 不存在（共 ${store.segments.length} 段）`]}};
    }
    const plan = projectSegmentPlan(seg);
    if (!plan) {
      // 未入 plan 批次的模板：ok:false 带已开放清单（教师/模型可改用别的段，不硬编成功）
      const open = TEMPLATES.filter((t) => t.plan).map((t) => t.id);
      return {
        result: {
          ok: false,
          errors: [`模板「${seg.templateId}」未开放制作指导投影（首批：${open.join(' / ')}）`],
        },
      };
    }
    return {
      result: {
        ok: true,
        segmentIndex: r.args.segmentIndex,
        ...plan,
        message: `第 ${r.args.segmentIndex + 1} 段「${seg.templateId}」plan 投影：${plan.beats?.length ?? 0} 节拍、${plan.captions?.length ?? 0} 文字行、${plan.mediaWindows?.length ?? 0} 素材窗（段内坐标；绝对时刻 = get_timeline startSec + 段内秒）`,
      },
    };
  },

  // v1.4（timeline-master-plan M3 L2）：手放节拍标记整组设置/清除——命令通道（一命令=一事务=一步撤销）
  set_segment_beats: async (args, ctx) => {
    const r = validateSetSegmentBeatsArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const seg = store.segments[r.args.segmentIndex];
    if (!seg) return {result: {ok: false, errors: [`下标 ${r.args.segmentIndex} 越界，共 ${store.segments.length} 段（下标 0 起）`]}};
    const duration = seg.duration || 8;
    const overflow = r.args.beats?.find((b) => b.t >= duration);
    if (overflow) {
      return {result: {ok: false, errors: [`beats t=${overflow.t}s 超出第 ${r.args.segmentIndex + 1} 段时长 ${duration}s（t 须 ∈ [0, ${duration})）`]}};
    }
    const beats = r.args.beats && r.args.beats.length > 0 ? r.args.beats : undefined;
    store.runTimelineCommand({kind: 'segmentBeats', index: r.args.segmentIndex, beats});
    const saved = ctx.getStore().segments[r.args.segmentIndex]?.beats ?? [];
    return {
      result: {
        ok: true,
        message: beats
          ? `第 ${r.args.segmentIndex + 1} 段已设置 ${saved.length} 个节拍标记（与 BGM 拍点并流供踩拍类模板消费；无 BGM 也生效）`
          : `第 ${r.args.segmentIndex + 1} 段节拍标记已清除`,
        ...(saved.length > 0 ? {beats: saved} : {}),
      },
    };
  },

  set_bgm_position: async (args, ctx) => {
    const r = validateSetBgmPositionArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    if (!store.bgm) {
      return {result: {ok: false, errors: ['尚未添加背景音乐，无法设置定位。请先让用户在「声音」面板添加 BGM，或用 set_bgm 选内置曲库。']}};
    }
    const bgm = store.bgm;
    const total = store.segments.reduce((sum, s) => sum + (s.duration || 8), 0);
    const roundTenth = (v: number) => Math.round(v * 10) / 10;
    const patch: {startAtSec?: number; trimStartSec?: number; trimEndSec?: number; fadeIn?: number; fadeOut?: number; volume?: number} = {};
    if (r.args.startAtSec !== undefined) patch.startAtSec = Math.max(0, Math.min(Math.max(0, total - 1), roundTenth(r.args.startAtSec)));
    // 截取窗与 UI 同口径钳制：start ∈ [0, dur-2]；end ∈ [生效start+2, dur]
    if (r.args.trimStartSec !== undefined) {
      patch.trimStartSec = Math.max(0, Math.min(Math.max(0, bgm.duration - 2), roundTenth(r.args.trimStartSec)));
    }
    const effTrimStart = patch.trimStartSec !== undefined ? patch.trimStartSec : bgmTrimStartSec(bgm);
    if (r.args.trimEndSec !== undefined) {
      patch.trimEndSec = Math.max(effTrimStart + 2, Math.min(Math.max(2, bgm.duration), roundTenth(r.args.trimEndSec)));
    }
    if (r.args.fadeInSec !== undefined) patch.fadeIn = Math.max(0, Math.min(8, roundTenth(r.args.fadeInSec)));
    if (r.args.fadeOutSec !== undefined) patch.fadeOut = Math.max(0, Math.min(8, roundTenth(r.args.fadeOutSec)));
    if (r.args.volume !== undefined) patch.volume = Math.max(0, Math.min(1, r.args.volume));
    // 命令通道（M1.5）：一命令=一事务=一步撤销（来源标=agent+工具名即时入史）
    store.runTimelineCommand({kind: 'bgm', patch});
    // 回读生效值（store 是调用时快照，须取最新——与 set_color_grade 同教训）
    const b2 = ctx.getStore().bgm!;
    return {
      result: {
        ok: true,
        applied: {
          startAtSec: bgmStartAtSec(b2),
          trimStartSec: bgmTrimStartSec(b2),
          trimEndSec: bgmTrimEndSec(b2),
          loopSpanSec: bgmLoopSpanSec(b2),
          fadeInSec: b2.fadeIn,
          fadeOutSec: b2.fadeOut,
          volume: b2.volume,
        },
        message: `BGM「${b2.name}」定位已更新：起播 ${bgmStartAtSec(b2).toFixed(1)}s、循环窗 ${bgmTrimStartSec(b2).toFixed(1)}~${bgmTrimEndSec(b2).toFixed(1)}s（${bgmLoopSpanSec(b2).toFixed(1)}s 循环平铺到片尾）、淡入 ${b2.fadeIn.toFixed(1)}s / 淡出 ${b2.fadeOut.toFixed(1)}s。节拍类工具会自动按新位置对齐`,
      },
    };
  },

  set_narration_timing: async (args, ctx) => {
    const r = validateSetNarrationTimingArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const seg = store.segments[r.args.segmentIndex];
    if (!seg) {
      return {result: {ok: false, errors: [`段 ${r.args.segmentIndex} 不存在（共 ${store.segments.length} 段）`]}};
    }
    const n = seg.narration;
    if (!n || !n.duration || n.duration <= 0) {
      return {result: {ok: false, errors: [`第 ${r.args.segmentIndex + 1} 段没有旁白音频（先 update_segment 写旁白文案 + synthesize_narration 合成，或用户在旁白面板导入）`]}};
    }
    const patch: {offsetSec?: number; volume?: number} = {};
    if (r.args.offsetSec !== undefined) patch.offsetSec = clampNarrationOffsetSec(r.args.offsetSec, seg.duration);
    if (r.args.volume !== undefined) patch.volume = Math.max(0, Math.min(1, r.args.volume));
    store.runTimelineCommand({kind: 'segmentNarration', index: r.args.segmentIndex, patch});
    const n2 = ctx.getStore().segments[r.args.segmentIndex].narration;
    const appliedOffset = clampNarrationOffsetSec(n2?.offsetSec ?? 0, seg.duration);
    return {
      result: {
        ok: true,
        applied: {offsetSec: appliedOffset, volume: n2?.volume ?? 1},
        message: `第 ${r.args.segmentIndex + 1} 段旁白时序已更新：段内偏移 ${appliedOffset.toFixed(1)}s 起播（该段 ${seg.duration.toFixed(1)}s），音量 ${Math.round((n2?.volume ?? 1) * 100)}%`,
      },
    };
  },

  reorder_segments: async (args, ctx) => {
    const r = validateReorderSegmentsArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const n = store.segments.length;
    if (r.args.order.length !== n || r.args.order.some((i) => i >= n)) {
      return {result: {ok: false, errors: [`order 必须恰好是 0..${n - 1} 的排列（当前片段数 ${n}，收到长度 ${r.args.order.length}）`]}};
    }
    if (r.args.order.every((v, i) => v === i)) {
      return {result: {ok: true, message: '顺序未变化（order 与当前一致），未做改动'}};
    }
    // 整体重排走命令事务（前置同步已收进命令层——sync+load 配对责任在覆盖域内退役）
    store.runTimelineCommand({kind: 'reorderSegments', order: r.args.order});
    const after = ctx.getStore().segments;
    return {
      result: {
        ok: true,
        order: r.args.order,
        templateIds: after.map((s) => s.templateId),
        message: `已重排 ${n} 段：新顺序（旧下标）= ${r.args.order.join(' → ')}；转场随片段走。可用 get_timeline 复检新时间轴`,
      },
    };
  },

  move_shot: async (args, ctx) => {
    const r = validateMoveShotArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const {fromSegmentIndex, clipIndex, toSegmentIndex, position} = r.args;
    const from = store.segments[fromSegmentIndex];
    const to = store.segments[toSegmentIndex];
    if (!from) {
      return {result: {ok: false, errors: [`源段 ${fromSegmentIndex} 不存在（共 ${store.segments.length} 段）`]}};
    }
    if (!to) {
      return {result: {ok: false, errors: [`目标段 ${toSegmentIndex} 不存在（共 ${store.segments.length} 段）`]}};
    }
    const clip = from.videos[clipIndex];
    if (!clip) {
      return {result: {ok: false, errors: [`段 ${fromSegmentIndex} 内素材下标 ${clipIndex} 不存在（共 ${from.videos.length} 个；shot 定位先看 get_timeline 的 shots[].clipIndex）`]}};
    }
    // 搬迁走命令事务（前置同步已收进命令层）
    const okMove = store.runTimelineCommand({
      kind: 'moveShot',
      fromSegment: fromSegmentIndex,
      clipIndex,
      toSegment: toSegmentIndex,
      position,
    });
    if (!okMove) {
      return {result: {ok: false, errors: ['搬移未生效（参数在执行时校验失败）']}};
    }
    const after = ctx.getStore().segments;
    const newClipIndex = after[toSegmentIndex].videos.findIndex((v) => v.id === clip.id);
    return {
      result: {
        ok: true,
        shotId: clip.id,
        moved: {toSegmentIndex, clipIndex: newClipIndex},
        message: `shot「${clip.name}」已搬移到第 ${toSegmentIndex + 1} 段第 ${newClipIndex + 1} 个素材位（裁剪窗/取景/音频设置全保留）。可用 get_timeline 复检 shots 归属`,
      },
    };
  },

  set_color_grade: async (args, ctx) => {
    const r = validateColorGradeArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    store.setColorGrade({look: r.args.look, ...(r.args.autoMatch !== undefined ? {autoMatch: r.args.autoMatch} : {})});
    // 读回必须取最新快照：store 是变更前 getState() 旧快照，字段不随 action 更新（曾致关 autoMatch 返回却显 true）
    const {look, autoMatch} = ctx.getStore().colorGrade;
    const lookLabel: Record<string, string> = {
      none: '原生', cleanCool: '清冷商业', warmFilm: '暖调胶片',
      tealOrange: '青橙大片', monoContrast: '黑白高对比', fadedRetro: '复古褪色',
    };
    return {result: {ok: true, look, autoMatch,
      message: `全片色调已设为「${lookLabel[look] ?? look}」${autoMatch ? '，自动曝光匹配开（素材亮度向全片中位数拉齐）' : '，自动曝光匹配关'}`}};
  },

  set_brand_style: async (args, ctx) => {
    const r = validateBrandStyleArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    if (r.args.brandColor !== undefined) store.setBrandColor(r.args.brandColor);
    if (r.args.fontMood !== undefined) store.setFontMood(r.args.fontMood);
    // 读回必须取最新快照：store 是变更前 getState() 旧快照，字段不随 action 更新
    const fresh = ctx.getStore();
    const colorNote = fresh.brandColor
      ? `品牌色 ${fresh.brandColor.toUpperCase()}（模板强调色/渐变/光晕全链路生效）`
      : '品牌色恢复默认蓝';
    const moodLabel: Record<string, string> = {
      sleek: '商业冷峻（MiSans）', warm: '温暖手写（霞鹜文楷）',
      tech: '科技等宽（等宽标题 + 黑体正文）', display: '英文展示（Poppins）',
    };
    const moodNote = `字体氛围 ${moodLabel[fresh.fontMood] ?? fresh.fontMood}`;
    return {result: {ok: true, brandColor: fresh.brandColor, fontMood: fresh.fontMood,
      message: `${colorNote}，${moodNote}。预览与后续渲染即时生效；如需看效果可 preview_storyboard_frame`}};
  },

  set_project_style: async (args, ctx) => {
    const r = validateSetProjectStyleArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const applied: string[] = [];
    if (r.args.captionStyle) {
      store.setCaptionStyle(r.args.captionStyle);
      applied.push('captionStyle');
    }
    if (r.args.texture !== undefined) {
      store.setTexture(r.args.texture);
      applied.push('texture');
    }
    if (r.args.beatPulse !== undefined) {
      store.setBeatPulse(r.args.beatPulse);
      applied.push('beatPulse');
    }
    if (r.args.sfx) {
      store.setSfx(r.args.sfx);
      applied.push('sfx');
    }
    if (r.args.frameBudget !== undefined) {
      store.setProjectFrameBudget(r.args.frameBudget);
      applied.push('frameBudget');
    }
    const cur = ctx.getStore();
    return {result: {
      ok: true,
      applied,
      current: {captionStyle: cur.captionStyle, texture: cur.texture, beatPulse: cur.beatPulse, sfx: cur.sfx, frameBudget: cur.frameBudget},
      message: `项目样式已更新（${applied.join('、')}），预览与后续渲染即时生效${r.args.beatPulse !== undefined && !cur.bgm ? '；当前无 BGM，节拍脉冲加了背景音乐后才生效' : ''}${r.args.frameBudget !== undefined ? `；看图预算现为 ${r.args.frameBudget === 0 ? '不限' : `${r.args.frameBudget} 帧`}` : ''}`,
    }};
  },

  align_beats: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateAlignBeatsArgs(args);
    if (!r.ok) return {result: r};
    if (!store.bgm) {
      return {result: {ok: false, errors: ['尚未添加背景音乐，无法卡点对齐。请先让用户在背景音乐面板添加 BGM。']}};
    }
    const res = store.alignSegmentsToBeats({tolerance: r.args.tolerance});
    if (!res) {
      return {result: {ok: false, errors: ['未能检出节拍（节拍不明显的纯人声/氛围乐会这样，可换鼓点清晰的曲子，或手动调各段时长）']}};
    }
    const bpmNote = res.bpm ? ` · ≈${Math.round(res.bpm)} BPM` : '';
    const parts: string[] = [];
    if (res.movedCount > 0) parts.push(`已把 ${res.movedCount} 个切点吸附到节拍上`);
    if (res.transitionMovedCount > 0) parts.push(`${res.transitionMovedCount} 个转场时长吸附到半拍网格`);
    return {result: {ok: true, movedCount: res.movedCount, transitionMovedCount: res.transitionMovedCount, beatCount: res.beatCount, bpm: res.bpm || undefined,
      message: parts.length > 0
        ? `${parts.join('，')}（真实节拍网格 ${res.beatCount} 拍${bpmNote}，容差 ${r.args.tolerance}s）`
        : `没有需要移动的切点或转场（都在容差 ${r.args.tolerance}s 内已压拍；节拍网格 ${res.beatCount} 拍${bpmNote}）`}};
  },

  align_music_structure: async (args, ctx) => {
    const store = ctx.getStore();
    if (!store.bgm?.path) {
      return {result: {ok: false, errors: ['尚未添加背景音乐，无法音乐结构重排。请先让用户在背景音乐面板添加 BGM。']}};
    }
    const a = (args || {}) as Record<string, unknown>;
    const mode = a.mode === 'all' ? 'all' as const : 'fill' as const;
    const toleranceSec = typeof a.toleranceSec === 'number' && Number.isFinite(a.toleranceSec)
      ? Math.max(0.3, Math.min(5, a.toleranceSec))
      : undefined;
    const musicMap = await window.api.analyzeMusicMap(store.bgm.path);
    if (!musicMap || (musicMap.sections?.length ?? 0) < 2) {
      return {result: {ok: false, errors: ['BGM 音乐结构分析失败或无段落结构（节奏不明显的纯人声/氛围乐会这样）。换结构感强的曲子再试。']}};
    }
    const plan = planMusicStructureRearrange(store.segments, musicMap, {transitionMode: mode, toleranceSec});
    if (!plan) {
      return {result: {ok: false, errors: ['故事板不足 2 段，无需结构重排。']}};
    }
    const sectionSummary = musicMap.sections.map((s) => `${s.label} ${s.startSec.toFixed(0)}-${s.endSec.toFixed(0)}s`).join(' / ');
    if (plan.boundaryMovedCount === 0 && plan.transitionChangedCount === 0) {
      return {result: {ok: true, movedCount: 0, transitionChangedCount: 0, sections: musicMap.sections.length, bpm: musicMap.bpm || undefined,
        message: `${plan.summary}。音乐结构：${sectionSummary}`}};
    }
    store.applyMusicStructurePlan(plan.durations, plan.transitions);
    return {result: {
      ok: true,
      movedCount: plan.boundaryMovedCount,
      transitionChangedCount: plan.transitionChangedCount,
      sections: musicMap.sections.length,
      bpm: musicMap.bpm || undefined,
      message: `${plan.summary}。音乐结构：${sectionSummary}。转场选型：${plan.notes.length > 0 ? plan.notes.join('；') : '（无变化）'}。建议再调 align_beats 把切点细吸到节拍网格（段落边界本就在重拍上，通常只差毫秒）。`,
    }};
  },

  auto_beat_montage: async (args, ctx) => {
    const store = ctx.getStore();
    if (!store.bgm?.path) {
      return {result: {ok: false, errors: ['尚未添加背景音乐，无法卡点剪辑。请先让用户在声音面板添加 BGM。']}};
    }
    const v = validateAutoBeatMontageArgs(args);
    if (!v.ok) return {result: v};
    const byPath = collectStoryboardVideos(ctx);
    if (byPath.size === 0) {
      return {result: {ok: false, errors: ['故事板没有视频素材。请先上传录屏/视频（或让 AI 用录屏工具采集），再做卡点剪辑。']}};
    }
    // 先做音乐结构（秒级），通过后再跑画面分析（分钟级）——BGM 失败不白费解码
    const musicMap = await window.api.analyzeMusicMap(store.bgm.path);
    if (!musicMap || musicMap.beats.length < 4) {
      return {result: {ok: false, errors: ['BGM 节拍检测失败（节奏不明显的纯人声/氛围乐会这样）。换鼓点清晰的曲子再试。']}};
    }
    const {sources, failed} = await analyzeMontageSources(byPath);
    if (sources.length === 0) {
      return {result: {ok: false, errors: [`全部素材分析失败（${failed.join('、')}）。文件可能损坏或格式不受支持。`]}};
    }
    const {directives, warnings} = resolveMontageDirectives(v.args, sources);
    // slotBeats 键已校验过是段落名集合
    const slotBeats = v.args.directives?.slotBeats as import('../../shared/edit-brain').EditBrainOptions['slotBeats'];
    const decision = planBeatMontage(musicMap, sources, {targetSec: v.args.targetSec, slotBeats, directives});
    if (decision.clips.length === 0) {
      return {result: {ok: false, errors: [decision.summary]}};
    }
    // 建段：一镜一段（VideoCut 全屏快切），段落切换处 whip、段内硬切
    const segments: Segment[] = [];
    for (let i = 0; i < decision.clips.length; i++) {
      const c = decision.clips[i];
      const next = decision.clips[i + 1];
      const meta = byPath.get(c.source)!;
      const src = await pathToClipSrc(c.source);
      segments.push({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        templateId: 'VideoCut',
        videos: [{
          id: `montage-${i}`,
          src,
          name: meta.name,
          width: meta.width,
          height: meta.height,
          duration: meta.duration,
          type: 'video',
          trimStart: c.startSec,
          trimEnd: c.endSec,
          trimmedDuration: c.durationSec,
          muted: true,
        }],
        text: {title: '', subtitle: '', features: [], brandName: ''},
        style: {},
        layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
        duration: c.durationSec,
        transition: next && next.section !== c.section ? 'whip' : 'none',
      } as unknown as Segment);
    }
    store.applyMontageSegments(segments);
    const sectionSummary = musicMap.sections.map((s) => `${s.label} ${s.startSec.toFixed(0)}-${s.endSec.toFixed(0)}s`).join(' / ');
    const extra = [...warnings, ...decision.notes];
    return {result: {
      ok: true,
      clipCount: segments.length,
      totalSec: Math.round(decision.totalSec * 10) / 10,
      bpm: musicMap.bpm,
      sections: musicMap.sections.length,
      ...(extra.length > 0 ? {directivesNote: extra.join('；')} : {}),
      message: `${decision.summary}。音乐结构：${sectionSummary}。故事板已重建为 ${segments.length} 个快切段（VideoCut，段内硬切、段落切换 whip）。${extra.length > 0 ? `创意指令：${extra.join('；')}。` : ''}建议预览后用 align_beats 微调转场时长或直接 review_render 审片。${failed.length > 0 ? `（${failed.length} 个素材分析失败未参与：${failed.join('、')}）` : ''}`,
    }};
  },

  auto_screen_demo: async (args, ctx) => {
    const v = validateScreenDemoArgs(args);
    if (!v.ok) return {result: v};
    const r = await runScreenDemoAuto(ctx.getStore(), v.args.path ?? null, {
      title: v.args.title,
      subtitle: v.args.subtitle,
      ctaTitle: v.args.ctaTitle,
      ctaLines: v.args.cta,
      withBgm: v.args.withBgm,
      wantMood: v.args.wantMood,
      wantEnergy: v.args.wantEnergy,
    });
    if (!r.ok) return {result: {ok: false, errors: r.errors ?? [r.message]}};
    return {result: {
      ok: true,
      segmentCount: r.segmentCount,
      shotCount: r.shotCount,
      totalSec: r.totalSec,
      bgm: r.bgmName,
      beatsMovedCount: r.beatsMovedCount,
      message: `${r.message}。建议 request_render 渲染，渲完 review_render 审片；文案在故事板「文字」页可改。`,
    }};
  },

  auto_tutorial: async (args, ctx) => {
    const r = validateTutorialArgs(args);
    if (!r.ok) return {result: r};
    const run = await runTutorialAuto(ctx.getStore(), r.args.path ?? null, {
      title: r.args.title,
      subtitle: r.args.subtitle,
      stepTitles: r.args.stepTitles,
      outroTitle: r.args.outroTitle,
      withBgm: r.args.withBgm,
      wantMood: r.args.wantMood,
      wantEnergy: r.args.wantEnergy,
    });
    if (!run.ok) return {result: {ok: false, errors: run.errors ?? [run.message]}};
    return {result: {
      ok: true,
      segmentCount: run.segmentCount,
      stepCount: run.stepCount,
      steps: run.steps,
      totalSec: run.totalSec,
      bgm: run.bgmName,
      beatsMovedCount: run.beatsMovedCount,
      message: `${run.message}`,
    }};
  },

  get_footage_map: async (_args, ctx) => {
    const byPath = collectStoryboardVideos(ctx);
    if (byPath.size === 0) {
      return {result: {ok: false, errors: ['故事板没有视频素材。请先上传录屏/视频（或让 AI 用录屏工具采集）。']}};
    }
    const {sources, failed} = await analyzeMontageSources(byPath);
    if (sources.length === 0) {
      return {result: {ok: false, errors: [`故事板视频素材全部分析失败（${failed.join('、')}）。文件可能损坏或格式不受支持。`]}};
    }
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const MAX_SHOTS_LISTED = 20; // 单素材镜头表限长，防提示词膨胀
    const money = findMoneyShot(sources);
    const moneyIdx = money ? sources.findIndex((s) => s.source === money.source) : -1;
    return {result: {
      ok: true,
      sources: sources.map((s, si) => ({
        source: si,
        name: s.source.split(/[\\/]/).pop(),
        durationSec: r1(s.shots[s.shots.length - 1]?.endSec ?? 0),
        shotCount: s.shots.length,
        shots: s.shots.slice(0, MAX_SHOTS_LISTED).map((shot, i) => ({
          shot: i,
          startSec: r1(shot.startSec),
          endSec: r1(shot.endSec),
          motionScore: shot.motionScore,
          peakSec: (() => {
            const p = shotEnergyPeak(s.energies, s.sampleFps, shot.startSec, shot.endSec);
            return p ? r1(p.sec) : null;
          })(),
        })),
        ...(s.shots.length > MAX_SHOTS_LISTED ? {note: `还有 ${s.shots.length - MAX_SHOTS_LISTED} 个镜头未列出`} : {}),
      })),
      suggestedFirstDrop: money && moneyIdx >= 0 ? {source: moneyIdx, shot: money.shot, reason: '全场能量峰最高的镜头，天然的高光镜'} : null,
      note: '排片依据：motionScore 高的镜头配 drop/高能量段，低的配信息段；peakSec 是镜头内动作最高点（取窗已自动对齐）。用 auto_beat_montage 的 directives 钉镜（openingShot/closingShot/firstDropShot）或禁镜（excludeShots），autoMoneyShot=true 可一键钉高光镜。',
      ...(failed.length > 0 ? {failed} : {}),
    }};
  },

  stabilize_clip: async (args, ctx) => {
    const r = validateStabilizeClipArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, clipIndex, points, smoothSec} = r.args;
    const picked = resolveStabClip(ctx, segmentIndex, clipIndex);
    if (!picked.ok) return {result: picked};
    return runStabAnalyze(ctx, segmentIndex, clipIndex, picked.clip, points, smoothSec);
  },

  set_stabilization: async (args, ctx) => {
    const r = validateSetStabilizationArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, clipIndex, enabled, smoothSec, points} = r.args;
    const picked = resolveStabClip(ctx, segmentIndex, clipIndex);
    if (!picked.ok) return {result: picked};
    const clip = picked.clip;
    const existing = clip.stabilization;

    // 换跟踪点 = 重跑分析（无既有稳定数据时给点，等价 stabilize_clip 手动点模式）
    if (points) {
      return runStabAnalyze(ctx, segmentIndex, clipIndex, clip, points, smoothSec ?? existing?.smoothSec ?? STAB_DEFAULTS.smoothSec);
    }
    if (!existing) {
      return {result: {ok: false, errors: ['该素材还没有稳定数据——请用 stabilize_clip 先做一次稳定（可自动选点）']}};
    }

    const notes: string[] = [];
    // 调强度：读 sidecar 原始采样重算校正表（毫秒级，不重分析）
    if (smoothSec !== undefined && smoothSec !== existing.smoothSec) {
      const track = await window.api.stabilizeRead(existing.trackPath).catch(() => null);
      if (!track || track.samples.length === 0) {
        return {result: {ok: false, errors: ['稳定轨迹文件读不到（sidecar 丢失或损坏）——请用 stabilize_clip 重新分析']}};
      }
      const solved = solveStabilization(track.samples, track.sampleFps, {
        smoothSec,
        maxZoom: STAB_DEFAULTS.maxZoom,
        videoWidth: track.videoWidth,
        videoHeight: track.videoHeight,
      });
      ctx.getStore().setVideoStabilization(clipIndex, {
        stabilization: {...existing, smoothSec},
        stabCorrections: solved.corrections,
        stabZoom: solved.zoom,
        stabSampleFps: track.sampleFps,
      }, segmentIndex);
      const zoomPct = Math.max(0, Math.round((solved.zoom - 1) * 1000) / 10);
      notes.push(`强度已调为 ${smoothSec}s（已重算，画面放大 ${zoomPct}%${solved.capped ? '，已达缩放上限' : ''}）`);
    }
    // 开关：只翻标志位，内存态数据保留（开回即恢复）
    if (enabled !== undefined && enabled !== existing.enabled) {
      const cur = ctx.getStore().segments[segmentIndex]?.videos[clipIndex]?.stabilization ?? existing;
      ctx.getStore().setVideoStabilization(clipIndex, {
        stabilization: {...cur, enabled},
      }, segmentIndex);
      notes.push(enabled ? '稳定已开启' : '稳定已关闭（数据保留，随时开回）');
    }
    const finalStab = ctx.getStore().segments[segmentIndex]?.videos[clipIndex]?.stabilization;
    return {result: {
      ok: true,
      message: notes.length > 0 ? notes.join('；') : '参数与现有设置一致，无变化',
      enabled: finalStab?.enabled ?? existing.enabled,
      smoothSec: finalStab?.smoothSec ?? existing.smoothSec,
    }};
  },

  add_ground_text: async (args, ctx) => {
    const r = validateAddGroundTextArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, text, form, clipIndex, u, v, size, yawDeg, pitchDeg, rollDeg, depth, color, entrance} = r.args;
    const picked = resolveGroundClip(ctx, segmentIndex, clipIndex);
    if (!picked.ok) return {result: picked};
    const ensured = await ensureGroundTrack(ctx, segmentIndex, clipIndex, picked.clip);
    if (!ensured.ok) return {result: {ok: false, errors: ensured.errors}};
    const el: GroundElement = {
      id: newGroundElementId(),
      kind: 'text',
      text,
      form,
      u: u ?? 0.5,
      v: v ?? (form === 'flat' ? 0.6 : form === 'extruded' ? 0.58 : 0.55),
      size: size ?? (form === 'billboard' ? 0.11 : 0.13),
      ...(yawDeg !== undefined ? {yawDeg} : {}), // 缺省不设 = 自动面向镜头
      ...(pitchDeg !== undefined ? {pitchDeg} : {}),
      ...(rollDeg !== undefined ? {rollDeg} : {}),
      ...(depth !== undefined && form === 'extruded' ? {depth} : {}),
      ...(color ? {color} : {}),
      entrance: entrance ?? 'rise',
    };
    const store = ctx.getStore();
    const cur = store.segments[segmentIndex]?.groundElements ?? [];
    store.setSegmentGroundElements(segmentIndex, [...cur, el]);
    return {result: {ok: true, message: `已在段 ${segmentIndex} 地面放置 3D 文字「${text}」（${form}）`, id: el.id, applied: el, quality: groundQualityNote(ensured.track)}};
  },

  add_ground_shape: async (args, ctx) => {
    const r = validateAddGroundShapeArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, form, clipIndex, u, v, size, yawDeg, pitchDeg, rollDeg, depth, color, entrance} = r.args;
    const picked = resolveGroundClip(ctx, segmentIndex, clipIndex);
    if (!picked.ok) return {result: picked};
    const ensured = await ensureGroundTrack(ctx, segmentIndex, clipIndex, picked.clip);
    if (!ensured.ok) return {result: {ok: false, errors: ensured.errors}};
    const el: GroundElement = {
      id: newGroundElementId(),
      kind: 'shape',
      form,
      u: u ?? 0.5,
      v: v ?? 0.55,
      size: size ?? 0.1,
      ...(yawDeg !== undefined ? {yawDeg} : {}), // 缺省不设 = 立牌自动面向镜头
      ...(pitchDeg !== undefined ? {pitchDeg} : {}),
      ...(rollDeg !== undefined ? {rollDeg} : {}),
      ...(depth !== undefined && form !== 'plate' ? {depth} : {}),
      ...(color ? {color} : {}),
      entrance: entrance ?? 'rise',
    };
    const store = ctx.getStore();
    const cur = store.segments[segmentIndex]?.groundElements ?? [];
    store.setSegmentGroundElements(segmentIndex, [...cur, el]);
    return {result: {ok: true, message: `已在段 ${segmentIndex} 地面放置 3D 形状（${form}）`, id: el.id, applied: el, quality: groundQualityNote(ensured.track)}};
  },

  update_ground_element: async (args, ctx) => {
    const r = validateUpdateGroundElementArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, id, ...patch} = r.args;
    const store = ctx.getStore();
    const seg = store.segments[segmentIndex];
    if (!seg) return {result: {ok: false, errors: [`段 ${segmentIndex} 不存在`]}};
    const els = seg.groundElements ?? [];
    const idx = els.findIndex((e) => e.id === id);
    if (idx < 0) return {result: {ok: false, errors: [`地面元素 ${id} 不存在（该段现有：${els.map((e) => e.id).join(', ') || '无'}）`]}};
    const cur = els[idx];
    const next: GroundElement = {
      ...cur,
      ...(patch.text !== undefined && cur.kind === 'text' ? {text: patch.text} : {}),
      ...(patch.u !== undefined ? {u: patch.u} : {}),
      ...(patch.v !== undefined ? {v: patch.v} : {}),
      ...(patch.size !== undefined ? {size: patch.size} : {}),
      ...(patch.yawDeg !== undefined ? {yawDeg: patch.yawDeg} : {}),
      ...(patch.pitchDeg !== undefined ? {pitchDeg: patch.pitchDeg} : {}),
      ...(patch.rollDeg !== undefined ? {rollDeg: patch.rollDeg} : {}),
      ...(patch.depth !== undefined ? {depth: patch.depth} : {}),
      ...(patch.color !== undefined ? {color: patch.color} : {}),
      ...(patch.entrance !== undefined ? {entrance: patch.entrance} : {}),
      ...(patch.opacity !== undefined ? {opacity: patch.opacity} : {}),
    };
    store.setSegmentGroundElements(segmentIndex, els.map((e, i) => (i === idx ? next : e)));
    return {result: {ok: true, message: `地面元素 ${id} 已更新`, applied: next}};
  },

  remove_ground_element: async (args, ctx) => {
    const r = validateRemoveGroundElementArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, id} = r.args;
    const store = ctx.getStore();
    const seg = store.segments[segmentIndex];
    if (!seg) return {result: {ok: false, errors: [`段 ${segmentIndex} 不存在`]}};
    const els = seg.groundElements ?? [];
    if (els.length === 0) return {result: {ok: false, errors: ['该段没有 3D 地面元素']}};
    if (!id) {
      store.setSegmentGroundElements(segmentIndex, []);
      return {result: {ok: true, message: `已清空段 ${segmentIndex} 全部 ${els.length} 个地面元素`}};
    }
    if (!els.some((e) => e.id === id)) {
      return {result: {ok: false, errors: [`地面元素 ${id} 不存在（该段现有：${els.map((e) => e.id).join(', ')}）`]}};
    }
    store.setSegmentGroundElements(segmentIndex, els.filter((e) => e.id !== id));
    return {result: {ok: true, message: `地面元素 ${id} 已删除（剩余 ${els.length - 1} 个）`}};
  },

  set_ground_tracking: async (args, ctx) => {
    const r = validateSetGroundTrackingArgs(args);
    if (!r.ok) return {result: r};
    const {segmentIndex, clipIndex, enabled, reanalyze} = r.args;
    const picked = resolveGroundClip(ctx, segmentIndex, clipIndex);
    if (!picked.ok) return {result: picked};
    const store = ctx.getStore();
    const notes: string[] = [];
    if (reanalyze) {
      const redone = await runGroundAnalyze(ctx, segmentIndex, clipIndex, picked.clip);
      if (!redone.ok) return {result: {ok: false, errors: redone.errors}};
      notes.push(`已重新分析：${groundQualityNote(redone.track)}`);
    }
    if (enabled !== undefined) {
      const gt = store.segments[segmentIndex]?.videos[clipIndex]?.groundTrack;
      if (!gt) return {result: {ok: false, errors: ['该素材还没有地面追踪数据——先 reanalyze 或 add_ground_text 自动分析']}};
      store.setGroundTrack(clipIndex, {groundTrack: {...gt, enabled}}, segmentIndex);
      notes.push(enabled ? '地面追踪已开启' : '地面追踪已关闭（数据保留，元素不再渲染）');
    }
    const final = store.segments[segmentIndex]?.videos[clipIndex]?.groundTrack;
    return {result: {ok: true, message: notes.length > 0 ? notes.join('；') : '参数与现有设置一致，无变化', enabled: final?.enabled, keptAnchors: final?.keptAnchors, quality: final ? groundQualityNote(final) : undefined}};
  },

  generate_template: async (args, ctx) => {
    const r = validateGenerateTemplateArgs(args);
    if (!r.ok) return {result: {ok: false, errors: r.errors}};
    const v = r.args;

    // 第 1 步：主进程扫描 + 编译（不落盘）——错误直接回喂 LLM 改稿
    const compiled = await window.api.compileGeneratedTemplate(v.code);
    if (!compiled.ok || !compiled.code) {
      return {result: {
        ok: false,
        errors: compiled.errors ?? ['编译失败'],
        hint: '按错误修正 code 后重新调用 generate_template；扫描命中的禁用规则必须换一种写法（规则是为了保证渲染逐帧确定、不接触宿主能力）',
      }};
    }

    // 第 2 步：渲染端冒烟实例化——编译通过 ≠ 能跑（顶层抛错/没定义 GeneratedTemplate 在此拦截），
    // 先于落盘执行，避免坏模板进库（覆盖迭代场景尤其重要：不会顶掉上一个好版本）
    const smoke = instantiateGenerated(compiled.code);
    if (!smoke) {
      return {result: {
        ok: false,
        errors: ['组件实例化失败：必须定义 const GeneratedTemplate = (props) => {...} 并返回 JSX，且组件外的顶层代码不能抛错（顶层副作用全部禁止，逻辑收进组件体内）'],
      }};
    }

    // 第 3 步：落库（主进程重新扫描+编译，权威产物为准）
    const saved = await window.api.saveGeneratedTemplate({
      ...(v.templateId ? {templateId: v.templateId} : {}),
      name: v.name,
      description: v.description,
      source: v.code,
      duration: v.defaultDuration,
      ...(v.paramSpecs ? {paramSpecs: v.paramSpecs} : {}),
      ...(v.textSlots ? {textSlots: v.textSlots} : {}),
    });
    if (!saved.ok || !saved.def || !saved.list) {
      return {result: {ok: false, errors: saved.errors ?? ['保存失败']}};
    }
    ctx.getStore().setGeneratedTemplates(saved.list);

    const isUpdate = !!v.templateId;
    // 非致命提醒（参数校验 notes + 服务层 warnings，如 textSlots 非法值被剔除）一并回告
    const extra = [...(r.notes ?? []), ...(saved.warnings ?? [])];
    return {result: {
      ok: true,
      templateId: saved.def.id,
      name: saved.def.name,
      ...(saved.def.textSlots ? {textSlots: saved.def.textSlots} : {}),
      message: `模板「${saved.def.name}」已${isUpdate ? '覆盖迭代' : '生成'}并加入模板库（id: ${saved.def.id}）。set_storyboard / update_segment 的 templateId 填 "${saved.def.id}" 即可引用，get_templates 可见。下一步建议：用 review_template(templateId: "${saved.def.id}") 审查实际渲染效果，按问题清单覆盖迭代改稿。${extra.length > 0 ? ` 注意：${extra.join('；')}。` : ''}`,
    }};
  },

  review_template: async (args, ctx) => {
    const r = validateReviewTemplateArgs(args);
    if (!r.ok) return {result: {ok: false, errors: r.errors}};
    const store = ctx.getStore();
    const def = store.generatedTemplates.find((t) => t.id === r.args.templateId);
    if (!def) {
      const available = store.generatedTemplates.map((t) => t.id);
      return {result: {ok: false, errors: [`模板 ${r.args.templateId} 不存在${available.length > 0 ? `（现有生成模板：${available.join('、')}）` : '（还没有生成模板，先用 generate_template 创建）'}`]}};
    }

    // 合成单段静帧：演示文案 + 无素材（审模板本身，不审成片叙事）
    const dur = def.duration || 8;
    const demoText = {title: def.name, subtitle: def.description || 'AI 生成模板审片', features: ['示例要点一', '示例要点二'], brandName: '品牌名'};
    const seg = {
      id: 'review-gen-seg', templateId: def.id, videos: [], text: demoText,
      style: {}, layout: {...DEFAULT_LAYOUT},
      duration: dur, transition: 'none' as const,
    };
    const inputProps = {
      segments: [seg], orientation: store.orientation,
      customTemplates: [], generatedTemplates: [def],
      bgm: null, sfx: null, texture: 'clean', beatPulse: false, cursor: false, licensed: true,
    } as MultiSegmentProps;

    const r2 = (v: number) => Math.round(v * 100) / 100;
    const shotPlan = [
      {timeSec: Math.max(0.05, r2(Math.min(0.8, dur * 0.3))), label: '入场动画完成后'},
      {timeSec: Math.max(0.05, r2(dur * 0.7)), label: '稳定段'},
    ];
    const frames: Array<{dataUrl: string; timeSec: number; note: string}> = [];
    try {
      for (const s of shotPlan) {
        const frame = await window.api.renderStoryboardStill({
          inputProps,
          aspectRatioId: store.aspectRatioId,
          timeSec: s.timeSec,
        });
        frames.push({dataUrl: frame.dataUrl, timeSec: s.timeSec, note: `第 ${s.timeSec.toFixed(1)}s（${s.label}）`});
      }
    } catch (err) {
      return {result: {ok: false, errors: [`渲染模板静帧失败（${stripIpcPrefix(err)}）。模板代码可能存在运行时错误——用 generate_template 传 templateId: "${def.id}" 覆盖迭代修复；预览中显示回退占位也说明同样的问题。`]}};
    }

    // VLM 审片（模板专用维度；与 review_render 同一通道：用户配置的多模态模型）
    const prompt = buildTemplateReviewPrompt({
      name: def.name,
      description: def.description,
      durationSec: dur,
      orientation: store.orientation,
      demoTitle: demoText.title,
      demoSubtitle: demoText.subtitle,
      frames: frames.map((f) => ({timeSec: f.timeSec, note: f.note})),
      ...(r.args.focus ? {focus: r.args.focus} : {}),
    });
    const content: ContentPart[] = [
      {type: 'text', text: prompt},
      ...frames.map((f) => ({type: 'image_url' as const, image_url: {url: f.dataUrl}})),
    ];
    let assistantText = '';
    try {
      const reply = await window.api.llmChat({messages: [{role: 'user', content}]});
      assistantText = typeof reply.content === 'string' ? reply.content
        : Array.isArray(reply.content) ? reply.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        : '';
    } catch (err) {
      const msg = stripIpcPrefix(err);
      if (/未配置/.test(msg)) {
        return {result: {ok: false, errors: [`${msg}。模板审片需在「设置 → AI 助手」配置多模态视觉模型（如 gpt-4o / qwen-vl / glm-4v）。`]}};
      }
      if (/image|vision|视觉|multimodal|400|422/i.test(msg)) {
        return {result: {ok: false, errors: [`当前模型可能不支持看图（${msg}）。请到「设置 → AI 助手」切换为多模态视觉模型后重试。`]}};
      }
      return {result: {ok: false, errors: [`审片模型调用失败：${msg}`]}};
    }

    const parsed = parseReviewReport(assistantText, TEMPLATE_REVIEW_DIMENSIONS);
    if (!parsed.ok) {
      return {
        result: {ok: true, parsed: false, templateId: def.id,
          note: '审片完成，但报告不是标准 JSON，以下为模型原文：', modelText: assistantText.slice(0, 4000)},
        images: frames.map((f) => ({dataUrl: f.dataUrl, note: f.note})),
      };
    }

    const rank = {high: 0, medium: 1, low: 2} as const;
    parsed.report.issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const highCount = parsed.report.issues.filter((i) => i.severity === 'high').length;
    const verdictLabel = parsed.report.verdict === 'pass' ? '可商用' : parsed.report.verdict === 'revise' ? '建议修改' : '需要重做';
    return {
      result: {
        ok: true,
        parsed: true,
        templateId: def.id,
        report: parsed.report,
        note: `模板「${def.name}」审片完成：总分 ${parsed.report.overall}/5（${verdictLabel}），问题 ${parsed.report.issues.length} 条（高危 ${highCount}）。` +
          `按 suggestion 用 generate_template 传 templateId: "${def.id}" 覆盖迭代修改代码，改完再用本工具复审，直到 pass。`,
      },
      images: frames.map((f) => ({dataUrl: f.dataUrl, note: f.note})),
    };
  },

  get_music_map: async (_args, ctx) => {
    const store = ctx.getStore();
    if (!store.bgm?.path) {
      return {result: {ok: false, errors: ['尚未添加背景音乐。请先让用户在声音面板添加 BGM。']}};
    }
    const m = await window.api.analyzeMusicMap(store.bgm.path);
    if (!m || m.beats.length < 4) {
      return {result: {ok: false, errors: ['节拍检测失败（节奏不明显的纯人声/氛围乐会这样，换鼓点清晰的曲子再试）']}};
    }
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {result: {
      ok: true,
      bpm: m.bpm,
      beatCount: m.beats.length,
      downbeatCount: m.downbeats.length,
      barSec: r1(m.barSec),
      durationSec: r1(m.durationSec),
      // 逐拍数组（与 beats 逐一下标对齐）：能量 + kick/snare 分频段强度，供逐拍编排
      beats: m.beats.map(r3),
      beatEnergies: m.beatEnergies.map(r2),
      beatKicks: (m.beatKicks ?? []).map(r2),
      beatSnares: (m.beatSnares ?? []).map(r2),
      sections: m.sections.map((s) => ({label: s.label, startSec: r1(s.startSec), endSec: r1(s.endSec), energy: s.energy})),
      note: '段落即排片依据：drop 段密切（一拍一刀）、build 中速、intro/outro 长镜慢镜。逐拍数组与 beats 对齐：beatKicks 高=重鼓点拍（放转场/切镜），beatSnares 高=军鼓/镲拍，两者都低=弱拍（保持）。用 auto_beat_montage 一键按此结构自动剪辑；渲好后接 review_render 审片闭环。',
    }};
  },

  transcribe_segment_captions: async (args, ctx) => {
    const store = ctx.getStore();
    const r = parseIndexArg(args);
    if (!r.ok) return {result: r};
    const seg = store.segments[r.index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${r.index} 越界，共 ${store.segments.length} 段`]}};
    // 识别目标：本段第一个视频素材（图片没有音轨）
    const clip = seg.videos.find((v) => v.type === 'video');
    if (!clip) {
      return {result: {ok: false, errors: [`第 ${r.index + 1} 段没有视频素材，无法识别语音。请先让用户上传含人声的视频素材。`]}};
    }
    // ASR 识别消耗用户额度，需本人确认
    if (!(await ctx.requestConfirm('AI 请求识别字幕', `将调用 ASR 服务识别第 ${r.index + 1} 段素材「${clip.name}」的语音（消耗你的 ASR 服务额度）`))) {
      return {result: {ok: false, errors: ['用户拒绝了语音识别操作']}};
    }
    try {
      const lines = await window.api.asrTranscribe({path: clipSrcToPath(clip.src), segmentDuration: seg.duration || 8});
      if (lines.length === 0) {
        return {result: {ok: true, count: 0, message: `第 ${r.index + 1} 段未识别到可用字幕（素材可能无人声）`}};
      }
      store.setSegmentCaptions(r.index, lines);
      return {result: {ok: true, count: lines.length, message: `第 ${r.index + 1} 段已识别并写入 ${lines.length} 行字幕（覆盖了该段原有字幕）`}};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  set_logo: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateLogoArgs(args);
    if (!r.ok) return {result: r};
    if (!store.logo) {
      return {result: {ok: false, errors: ['用户尚未上传 Logo。请提醒用户在「品牌」面板上传 Logo 图片后，再调用本工具调整位置/大小/透明度。']}};
    }
    store.updateLogo(r.args);
    return {result: {ok: true, message: `Logo 已更新：${Object.keys(r.args).join('、')}`, logo: {...store.logo, ...r.args}}};
  },

  set_fine_print: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateFinePrintArgs(args);
    if (!r.ok) return {result: r};
    if (Object.keys(r.args).length === 0) {
      return {result: {ok: false, errors: ['至少提供一个字段：text/position/opacity/sizeScale']}};
    }
    store.setFinePrint(r.args);
    const next = {...store.finePrint, ...r.args};
    return {result: {ok: true, message: next.text.trim() ? `边缘小字已更新：「${next.text.slice(0, 40)}${next.text.length > 40 ? '…' : ''}」（${next.position}）` : '边缘小字已清除', finePrint: next}};
  },

  // 2026-11-03 收编：get_app_status 此前只在 MCP 桥里实现，内置模型调用会落「未知工具」。
  // 实现抽到 appStatus.ts，与 MCP 通道共用同一份状态组装（避免回执分叉）。
  get_app_status: async () => getAppStatus(),

  request_render: async (_args, ctx) => {
    // 完整性体检（宿主护栏，非阻断）：小模型会漏收尾步骤（如全程未设转场），
    // 问题随工具结果回告模型——可修复后重渲，本次渲染照常进行
    const segments = ctx.getStore().segments;
    const lint = segments.length > 0 ? lintStoryboardCompleteness({segments}) : [];
    const ack = await ctx.onRequestRender();
    const baseMessage = ack?.message ?? '已弹出确认卡，等待用户点击「开始渲染」';
    if (lint.length === 0) return {result: {ok: true, message: baseMessage}};
    const lintNote = `完整性体检发现 ${lint.length} 项（不阻断渲染）：${lint.map((l) => l.message).join('；')}。建议按 suggestion 修复后重新渲染。`;
    return {result: {ok: true, message: `${baseMessage}。${lintNote}`, lint}};
  },

  list_capture_sources: async () => {
    try {
      const sources = await listCaptureSources();
      if (sources.length === 0) return {result: {ok: false, errors: ['未找到可录制的屏幕/窗口']}};
      return {result: {
        ok: true,
        screens: sources.filter((s) => s.kind === 'screen').map((s) => ({id: s.id, name: s.name, width: s.width, height: s.height})),
        windows: sources.filter((s) => s.kind === 'window').map((s) => ({id: s.id, name: s.name})),
      }};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  take_screenshot: async (args, ctx) => {
    const r = validateScreenshotArgs(args);
    if (!r.ok) return {result: r};
    // 截屏内容会发往第三方 AI 端点（隐私敏感），需本人确认
    if (!(await ctx.requestConfirm('AI 请求截取屏幕画面', '截图将保存到本机，并作为图片发送给你配置的 AI 服务端点用于看图分析'))) {
      return {result: {ok: false, errors: ['用户拒绝了截图操作']}};
    }
    try {
      const shot = await window.api.captureScreenshot(r.args.sourceId);
      let addedNote = '';
      if (r.args.saveToStoryboard) {
        const res = await addCaptureToSegment(shot, r.args.segmentIndex);
        addedNote = `；已作为图片素材加入第 ${res.segmentIndex + 1} 段`;
      }
      return {
        result: {ok: true, name: shot.name, width: shot.width, height: shot.height,
          savedToStoryboard: r.args.saveToStoryboard,
          note: `截图已附图，请查看${addedNote}`},
        image: {dataUrl: shot.dataUrl, note: `屏幕/窗口截图（${shot.width}×${shot.height}）`},
      };
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  capture_element: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateCaptureElementArgs(args);
    if (!r.ok) return {result: r};
    if (r.args.attachToSegment !== undefined && r.args.attachToSegment >= store.segments.length) {
      return {result: {ok: false, errors: [`attachToSegment ${r.args.attachToSegment} 越界，共 ${store.segments.length} 段`]}};
    }
    // 截图内容会发往第三方 AI 端点看图（隐私敏感），需本人确认
    if (!(await ctx.requestConfirm('AI 请求元素截图', `将把界面元素「${r.args.selector}」截成透明背景 PNG，并作为图片发送给你配置的 AI 服务端点用于看图分析（截取瞬间界面会短暂闪烁）`))) {
      return {result: {ok: false, errors: ['用户拒绝了元素截图操作']}};
    }
    const el = document.querySelector(r.args.selector);
    if (!el) {
      return {result: {ok: false, errors: [`未找到元素「${r.args.selector}」。请确认选择器正确、目标面板当前处于展开状态（面板收起时元素可能不在 DOM 中）`]}};
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) {
      return {result: {ok: false, errors: [`元素「${r.args.selector}」尺寸过小（${Math.round(rect.width)}×${Math.round(rect.height)}），可能当前不可见`]}};
    }
    // 双底抠图：白/黑两底各截一张 → 逐像素解 alpha（窗口不透明，omitBackground 拿不到真透明）。
    // 元素截图模式会冻结全局 transition（否则 visibility 变化被离散动画拖延，截取瞬间还没生效）。
    const clip = {x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: window.devicePixelRatio || 1};
    const shotWithBg = async (bg: 'white' | 'black') => {
      const restore = enterElementCaptureMode(el as HTMLElement, bg);
      try {
        await nextFrames(2);
        return await window.api.captureElementRaw(clip);
      } finally {
        restore();
      }
    };
    try {
      const whiteShot = await shotWithBg('white');
      const blackShot = await shotWithBg('black');
      const matte = await matteTwoPass(whiteShot.data, blackShot.data);
      const saved = await window.api.captureSaveElement(matte.pngBytes);
      let attachNote = '';
      if (r.args.attachToSegment !== undefined) {
        const idx = r.args.attachToSegment;
        ctx.getStore().setSegmentOverlay(idx, {
          src: saved.src, path: saved.path, name: saved.name,
          width: matte.width, height: matte.height,
          x: 0.5, y: 0.5, scale: r.args.scale,
        });
        attachNote = `；已贴附为第 ${idx + 1} 段悬浮层（居中、宽占 ${Math.round(r.args.scale * 100)}% 画宽，用 set_segment_overlay 调整）`;
      }
      return {
        result: {ok: true, name: saved.name, path: saved.path, width: matte.width, height: matte.height,
          note: `元素透明截图已附图，请查看${attachNote}`},
        image: {dataUrl: matte.previewDataUrl, note: `界面元素透明抠图（${matte.width}×${matte.height}，预览图透明区已铺白）`},
      };
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  start_screen_recording: async (args, ctx) => {
    const r = validateStartRecordingArgs(args);
    if (!r.ok) return {result: r};
    // sourceName 模糊匹配解析成具体源 id：唯一命中（含唯一精确命中）直接用，
    // 多命中报错列出候选让 agent 改用 sourceId，零命中提示先 list_capture_sources
    let sourceId = r.args.sourceId;
    let resolvedName = '';
    if (!sourceId && r.args.sourceName) {
      const sources = await listCaptureSources();
      const needle = r.args.sourceName.toLowerCase();
      const hits = sources.filter((s) => s.name.toLowerCase().includes(needle));
      if (hits.length === 0) {
        return {result: {ok: false, errors: [`没有名称包含「${r.args.sourceName}」的屏幕/窗口。请先调用 list_capture_sources 查看可用源，再用 sourceId 指定`]}};
      }
      const exact = hits.filter((s) => s.name.toLowerCase() === needle);
      const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
      if (!pick) {
        return {result: {ok: false, errors: [
          `名称「${r.args.sourceName}」匹配到 ${hits.length} 个源，无法确定录哪个。请改用 sourceId 精确指定，候选：`,
          ...hits.map((h) => `${h.kind === 'screen' ? '屏幕' : '窗口'}「${h.name}」→ sourceId: ${h.id}`),
        ]}};
      }
      sourceId = pick.id;
      resolvedName = pick.name;
    }
    // 录屏会持续采集屏幕内容（隐私敏感），需本人确认；确认卡摘要带上构图/选区与画质。
    // 带摄像头的构图同时会开启摄像头（更长确认前先开：权限被拒时别让用户白确认一轮）。
    let layoutOn = '';
    if (r.args.layout) {
      try {
        await enableWebcam(); // 幂等：已开启直接复用
        layoutOn = RECORDING_LAYOUT_LABEL[r.args.layout];
      } catch (err) {
        return {result: {ok: false, errors: [
          `无法开启摄像头（构图 ${r.args.layout} 需要摄像头画面）：${err instanceof Error ? err.message : String(err)}`,
          '请让用户在录屏弹窗「画面构成」里手动选择带摄像头的构图并允许摄像头，或去掉 layout 参数改纯屏幕录制',
        ]}};
      }
    }
    // 仅摄像头构图不录屏幕画面，选区无意义（忽略并说明，不让 agent 反复重试）
    const regionArg = r.args.layout === 'camera' ? undefined : r.args.region;
    const regionDropped = r.args.layout === 'camera' && r.args.region ? true : false;
    const qualityBits: string[] = [];
    if (layoutOn) qualityBits.push(layoutOn);
    if (regionArg) qualityBits.push(`选区 ${regionArg.width}×${regionArg.height}（起点 ${regionArg.x},${regionArg.y}）`);
    if (r.args.maxHeight) qualityBits.push(`输出 ≤${r.args.maxHeight}p`);
    if (r.args.fps) qualityBits.push(`${r.args.fps} fps`);
    const confirmDetail = `将录制${r.args.layout === 'camera' ? '摄像头画面' : `${resolvedName ? `「${resolvedName}」` : '屏幕/窗口画面'}`}${qualityBits.length > 0 ? `，${qualityBits.join('、')}` : ''}${r.args.withSystemAudio ? '，并包含系统声音' : ''}${r.args.withMic ? '，并包含麦克风声音' : '（不含麦克风）'}${regionDropped ? '（仅摄像头构图忽略选区）' : ''}`;
    if (!(await ctx.requestConfirm('AI 请求开始录屏', confirmDetail))) {
      return {result: {ok: false, errors: ['用户拒绝了录屏操作']}};
    }
    // 倒计时起录：给用户留出切到目标窗口的时间（阻塞 sleep，远低于 120s 工具超时）
    if (r.args.countdownSec && r.args.countdownSec > 0) {
      await new Promise((resolve) => setTimeout(resolve, r.args.countdownSec! * 1000));
    }
    const quality = {
      layout: r.args.layout,
      region: regionArg,
      fps: r.args.fps,
      maxHeight: r.args.maxHeight,
      bitrateMbps: r.args.bitrateMbps,
    };
    const qualityNote = `${layoutOn ? `${layoutOn}，` : ''}${r.args.maxHeight ? `输出 ≤${r.args.maxHeight}p ` : ''}${r.args.fps ?? 30}fps${regionDropped ? '（忽略选区）' : ''}`;
    try {
      if (r.args.withSystemAudio) {
        // 系统声音走 getDisplayMedia：浏览器要求真实用户手势（确认卡点击通常可满足），
        // 手势被拒时抛 GestureRequiredError，引导用户在录屏弹窗手动点击「开始录制」
        const sources = await listCaptureSources();
        const finalSourceId = sourceId ?? sources.find((s) => s.kind === 'screen')?.id ?? sources[0]?.id;
        if (!finalSourceId) return {result: {ok: false, errors: ['未找到可录制的屏幕/窗口']}};
        const {sourceName, systemAudio} = await startWithSystemAudio(finalSourceId, {withMic: r.args.withMic, ...quality});
        return {result: {ok: true, sourceName, systemAudio, ...quality,
          message: `已开始录制「${sourceName}」（${qualityNote}${regionArg ? `，选区 ${regionArg.width}×${regionArg.height}` : ''}）${systemAudio ? '（含系统声音）' : '（未获取到系统声音轨，本次为无声录像）'}。请立即用文字告诉用户「已开始录制，请开始操作，完成后说一声」，然后结束本轮回复；等用户回复完成后再调用 stop_screen_recording。你无法在单次对话中计时等待。`}};
      }
      const {sourceName} = await startRecording({sourceId, withMic: r.args.withMic, ...quality});
      return {result: {ok: true, sourceName, ...quality,
        message: `已开始录制「${sourceName}」（${qualityNote}${regionArg ? `，选区 ${regionArg.width}×${regionArg.height}` : ''}）。请立即用文字告诉用户「已开始录制，请开始操作，完成后说一声」，然后结束本轮回复；等用户回复完成后再调用 stop_screen_recording。你无法在单次对话中计时等待。`}};
    } catch (err) {
      if (err instanceof Error && err.name === 'GestureRequiredError') {
        // 浏览器手势要求：AI 无法代点，只能引导用户到录屏弹窗手动开始
        return {result: {ok: false, needsUserGesture: true, errors: [err.message],
          message: '系统声音录制需要真实用户点击手势，AI 无法代为触发。请回复用户：打开录屏弹窗，勾选「同时录制系统声音」后手动点击「开始录制」，之后你再调用 get_capture_status 确认状态。'}};
      }
      return {result: {ok: false, errors: [err instanceof Error ? err.message : String(err)]}};
    }
  },

  stop_screen_recording: async (args, ctx) => {
    const store = ctx.getStore();
    const r = validateStopRecordingArgs(args);
    if (!r.ok) return {result: r};
    // 请求帧率在停录前取：stopRecording 的 cleanup 会把模块级 recordingFps 重置回 30
    const requestedFps = getRecordingInfo().fps;
    let saved;
    try {
      saved = await stopRecording();
    } catch (err) {
      return {result: {ok: false, errors: [`保存录制失败：${stripIpcPrefix(err)}`]}};
    }
    if (!saved) return {result: {ok: false, errors: ['当前没有进行中的录制']}};
    // 段下标越界时录制成果不能丢：回退当前选中段并在结果里说明
    let idx = r.args.segmentIndex ?? store.activeSegmentIndex;
    let fallbackNote = '';
    if (idx < 0 || idx >= store.segments.length) {
      fallbackNote = `（指定段下标 ${idx} 越界，已改为当前选中段 ${store.activeSegmentIndex + 1}）`;
      idx = store.activeSegmentIndex;
    }
    try {
      const res = await addCaptureToSegment(saved, idx);
      // 可选掐头去尾：入段后直接落 trim（与 set_segment_trim 同语义，store 按素材时长 clamp，回报实存值）
      let trimNote = '';
      if (r.args.trimStartSec !== undefined || r.args.trimEndSec !== undefined) {
        const videoIndex = (ctx.getStore().segments[idx]?.videos.length ?? 1) - 1;
        ctx.getStore().updateSegmentVideoTrim(idx, videoIndex, r.args.trimStartSec ?? 0, r.args.trimEndSec ?? res.duration);
        const clip = ctx.getStore().segments[idx]?.videos[videoIndex];
        trimNote = `；已裁剪为 ${clip?.trimStart ?? r.args.trimStartSec ?? 0}-${clip?.trimEnd ?? r.args.trimEndSec ?? res.duration}s`;
      }
      // 实际帧率统计（主进程保存时已用 ffprobe 探测 nb_frames/avg_frame_rate）：
      // 优先 帧数÷实测时长（MediaRecorder 的 webm 时长元数据不可靠），读不到帧数降级 avg_frame_rate 并标注 estimated
      const fs = saved.frameStats;
      let actualFps: number | null = null;
      let estimated = false;
      if (fs) {
        const dur = res.duration > 0.05 ? res.duration : (fs.durationSec ?? 0);
        if (fs.frameCount && dur > 0.05) {
          actualFps = Math.round((fs.frameCount / dur) * 10) / 10;
        } else if (fs.avgFps) {
          actualFps = Math.round(fs.avgFps * 10) / 10;
          estimated = true;
        }
      }
      const fpsWarning = actualFps !== null && actualFps < requestedFps * 0.8
        ? `机器性能不足：实际帧率 ${actualFps}fps 明显低于请求的 ${requestedFps}fps，画面可能不流畅（可降低 fps/分辨率或关闭其他占用后重录）`
        : null;
      return {result: {ok: true, name: saved.name, duration: res.duration, width: res.width, height: res.height,
        segmentIndex: idx,
        requestedFps,
        actualFps,
        frameCount: fs?.frameCount ?? null,
        durationSec: res.duration,
        ...(estimated ? {estimated: true} : {}),
        ...(fpsWarning ? {warning: fpsWarning} : {}),
        message: `录制已保存并加入第 ${idx + 1} 段素材（${res.duration.toFixed(1)}s${trimNote}，可 view_segment_frame 看图、set_segment_trim 裁剪）${fallbackNote}${fpsWarning ? `。⚠️ ${fpsWarning}` : ''}`}};
    } catch (err) {
      return {result: {ok: false, errors: [`录制已保存到 ${saved.path}，但加入片段失败：${stripIpcPrefix(err)}`]}};
    }
  },

  get_capture_status: async () => {
    const info = getRecordingInfo();
    return {result: {ok: true, recording: info.recording,
      elapsedSec: Math.round(info.elapsedSec * 10) / 10,
      sourceName: info.sourceName || null,
      ...(info.recording ? {
        width: info.width,
        height: info.height,
        fps: info.fps,
        layout: info.layout,
        ...(info.layout !== 'screen' ? {layoutLabel: RECORDING_LAYOUT_LABEL[info.layout]} : {}),
        ...(info.region ? {region: info.region} : {}),
        withMic: info.withMic,
        withSystemAudio: info.withSystemAudio,
      } : {
        note: '未在录制。开始录制用 start_screen_recording：sourceName/sourceId 选源、region 选区（视频像素）、layout 构图（画中画/分屏/仅摄像头）、fps/maxHeight/bitrateMbps 控画质',
      })}};
  },

  import_segment_media: async (args, ctx) => {
    const r = validateImportMediaArgs(args);
    if (!r.ok) return {result: r};
    const idx = r.args.index;
    const store = ctx.getStore();
    if (!store.segments[idx]) return {result: {ok: false, errors: [`下标 ${idx} 越界，当前共 ${store.segments.length} 段`]}};
    // 读取用户指定的本地文件（隐私敏感），需本人确认
    if (!(await ctx.requestConfirm('AI 请求导入本地媒体文件', `将读取「${r.args.path}」并加入第 ${idx + 1} 段素材`))) {
      return {result: {ok: false, errors: ['用户拒绝了导入操作']}};
    }
    try {
      const meta = await window.api.getVideoMetadata(r.args.path);
      // 编码预览白名单警告（hevc/prores 等 Chromium 解不动；导出渲染走 ffmpeg 不受影响）
      const codecWarning = meta.type === 'video' ? codecPreviewWarning(meta.codec) : null;
      // 转为 HTTP URL 供 Remotion 渲染使用（与手动上传/录屏入段同口径）
      const httpUrl = await window.api.getVideoHttpUrl(r.args.path);
      const dur = Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : 0;
      // Log 曲线猜测（ffprobe 设备元数据 → 厂牌；无歧义自动填，歧义厂牌回告候选）
      const guess = meta.type === 'video' && (meta.make || meta.model)
        ? guessColorCurveFromTags(meta.make ?? '', meta.model ?? '')
        : null;
      const clip: VideoClip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        src: httpUrl,
        name: r.args.path.split(/[\\/]/).pop() || 'unknown',
        type: meta.type,
        width: meta.width,
        height: meta.height,
        duration: dur,
        trimStart: 0,
        trimEnd: dur,
        trimmedDuration: dur,
        ...(guess?.curve ? {colorCurve: guess.curve} : {}),
        sourceKind: guessSourceKind({type: meta.type, width: meta.width, height: meta.height, make: meta.make, model: meta.model, ext: r.args.path.split('.').pop() ?? ''}),
      };
      // mxf/超大/4K 素材：后台代理（同步返回——缓存命中带 proxyPath，未命中入队转码，
      // 预备好前抽帧/预览走源文件；get_app_status 的 proxyJobs 可查进度）
      let proxy: {status: string; proxyPath?: string} | null = null;
      if (meta.type === 'video' && window.api.proxyPrepare) {
        try {
          const job = await window.api.proxyPrepare({path: r.args.path, colorCurve: guess?.curve});
          if (job.status === 'ready' && job.proxyPath) {
            proxy = {status: 'ready', proxyPath: job.proxyPath};
            clip.proxyPath = job.proxyPath;
            clip.proxyStatus = 'ready';
          } else if (job.status !== 'not-needed') {
            proxy = {status: job.status};
            clip.proxyStatus = 'queued';
          }
        } catch {
          // 代理探测失败不阻塞导入（按普通素材走）
        }
      }
      // 色彩统计（自动曝光匹配用；失败静默跳过，不影响导入）
      try {
        const stats = await window.api.analyzeMediaColor(r.args.path);
        if (stats) clip.colorStats = stats;
      } catch {
        /* 分析失败不阻塞 */
      }
      // 缩略图（时间线/故事板卡片胶片条；与文件导入链路同口径，失败退文字预览）
      clip.thumbnail = await makeClipThumbnail(r.args.path, dur);
      ctx.getStore().addVideosToSegment(idx, [clip]);
      // P0-2 实拍铁律警告（不阻断）：实拍素材导入到了非满幅模板的段上（画框/画中画会缩小画面）
      const storeAfter = ctx.getStore();
      const newIsLive = clip.type === 'video' && (clip.sourceKind ?? 'live-action') === 'live-action';
      const shrinkWarn = newIsLive
        ? liveActionShrinkWarning(
            storeAfter.segments[idx]?.videos,
            mergeTemplateMetas(storeAfter.customTemplates, storeAfter.marketTemplates, storeAfter.generatedTemplates)
              .find((t) => t.id === storeAfter.segments[idx]?.templateId),
            idx,
          )
        : null;
      const proxyBits = proxy
        ? proxy.status === 'ready'
          ? `。代理已就绪（编辑/抽帧走代理，渲染回源）`
          : `。素材较大/特殊容器，后台正在生成 960 宽代理（get_app_status 的 proxyJobs 查进度；渲染不受影响）`
        : '';
      return {result: {ok: true, name: clip.name, type: meta.type, duration: dur, width: meta.width, height: meta.height,
        segmentIndex: idx,
        sourceKind: clip.sourceKind ? `${clip.sourceKind}（${SOURCE_KIND_LABELS[clip.sourceKind]}）` : undefined,
        ...(clip.colorCurve ? {colorCurve: clip.colorCurve} : {}),
        ...(guess && !guess.curve && guess.candidates ? {colorCurveCandidates: guess.candidates} : {}),
        ...(guess ? {colorCurveGuessNote: guess.note} : {}),
        ...(proxy ? {proxy} : {}),
        ...(codecWarning ? {codecWarning} : {}),
        ...(shrinkWarn ? {shrinkWarning: shrinkWarn} : {}),
        message: `已导入「${clip.name}」到第 ${idx + 1} 段（${meta.type === 'image' ? '图片' : meta.type === 'model' ? '3D 模型' : `${dur.toFixed(1)}s`}，${meta.width}×${meta.height}；${meta.type === 'model' ? '配 ModelTurntable 等 3D 模板用（裁剪/取景对模型无意义）' : '可 view_segment_frame 看图、set_segment_trim 裁剪、set_segment_viewport 取景'}）${guess ? `。${guess.note}` : ''}${codecWarning ? `。⚠️ ${codecWarning}` : ''}${shrinkWarn ? `。${shrinkWarn}` : ''}${proxyBits}`}};
    } catch (err) {
      return {result: {ok: false, errors: [`导入失败（确认路径存在且为支持的媒体格式）：${stripIpcPrefix(err)}`]}};
    }
  },

  set_media_colorspace: async (args, ctx) => {
    const r = validateSetColorspaceArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const seg = store.segments[r.args.index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${r.args.index} 越界，当前共 ${store.segments.length} 段`]}};
    const clip = seg.videos[r.args.videoIndex];
    if (!clip) return {result: {ok: false, errors: [`第 ${r.args.videoIndex} 个素材不存在（段内共 ${seg.videos.length} 个）`]}};
    if (clip.type !== 'video') return {result: {ok: false, errors: [`素材「${clip.name}」不是视频（图片/模型无色彩曲线）`]}};
    const curve = r.args.colorCurve === 'none' ? undefined : r.args.colorCurve;
    store.setSegmentVideoColorCurve(r.args.index, r.args.videoIndex, curve);
    const applied = ctx.getStore().segments[r.args.index]?.videos[r.args.videoIndex];
    // 代理按新曲线重排（缓存 key 含曲线 → 自动重转；无完整 ffmpeg 时主进程回告降级）
    let proxyNote = '';
    try {
      const srcPath = clipSrcToPath(clip.src);
      const job = await window.api.proxyPrepare({path: srcPath, colorCurve: curve});
      if (job.status === 'not-needed') proxyNote = '（素材不触发代理，仅渲染链路应用 LUT）';
      else if (job.status === 'ready' && job.proxyPath) proxyNote = '，代理已按新曲线就绪（编辑/抽帧立即恢复正常色）';
      else if (job.status === 'failed') proxyNote = `，代理重排失败（${job.error ?? '未知原因'}）`;
      else proxyNote = '，代理按新曲线重新生成中（get_app_status 的 proxyJobs 查进度）';
    } catch {
      proxyNote = '（代理重排未执行，渲染链路仍会应用 LUT）';
    }
    return {result: {ok: true, segmentIndex: r.args.index, videoIndex: r.args.videoIndex,
      colorCurve: applied?.colorCurve ?? 'none', colorCurveLabel: curve ? colorCurveMeta(curve).label : '无（普通素材）',
      message: `第 ${r.args.index + 1} 段素材「${clip.name}」色彩曲线已设为 ${curve ? colorCurveMeta(curve).label : '无'}${proxyNote}；渲染回源前将经 Log→709 技术转换 LUT 一次性转码`}};
  },

  view_media_frames: async (args, ctx) => {
    const r = validateViewMediaFramesArgs(args);
    if (!r.ok) return {result: r};
    let filePath: string;
    let label: string;
    /** 素材模式下的 clip（有效区间采样 + 段内相对秒换算用）；path 直连为 null */
    let clipForCuts: VideoClip | null = null;
    if (r.args.path !== undefined) {
      // path 直连：查看已渲染成片等文件（主进程白名单校验，未注册的路径会被拒绝）
      filePath = r.args.path;
      label = `文件「${filePath}」`;
    } else {
      const store = ctx.getStore();
      const index = r.args.index!;
      const seg = store.segments[index];
      if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界，共 ${store.segments.length} 段`]}};
      // 与 transcribe_segment_captions 同口径：取本段第一个视频素材（图片抽帧请用 view_segment_frame）
      const clip = seg.videos.find((v) => v.type === 'video');
      if (!clip) return {result: {ok: false, errors: [`第 ${index + 1} 段没有视频素材（图片素材请用 view_segment_frame 看单帧）`]}};
      filePath = clipSrcToPath(clip.src);
      label = `第 ${index + 1} 段素材「${clip.name}」`;
      clipForCuts = clip;
    }
    // 工程看图预算（缺省 12 帧；0=不限）：响应统一带剩余量提示，超支拒附图
    // （预算是「附图」口径：contact-sheet 一张拼图也记 1）
    const budgetNoteOf = (): string => {
      const st = ctx.getStore();
      if (st.frameBudget === 0) return '看图预算不限（frameBudget=0）';
      return `工程看图预算：已用 ${st.frameBudgetUsed} / ${st.frameBudget}（剩 ${Math.max(0, st.frameBudget - st.frameBudgetUsed)}）——长素材先用 mode=contact-sheet 一张扫全片，锁定时段后再高清抽 2-3 帧；预算不够用 set_project_style(frameBudget=N) 放宽`;
    };
    // contact-sheet 分支：一张拼图 + 时间表扫全片（长素材浏览首选，预算成本 1）
    if (r.args.mode === 'contact-sheet') {
      const st = ctx.getStore();
      const remaining = st.frameBudget === 0 ? Infinity : st.frameBudget - st.frameBudgetUsed;
      if (remaining < 1) {
        return {result: {ok: true, imageSkipped: ['contact-sheet（工程看图预算已用尽）'],
          note: `未附图：工程看图预算已用尽。${budgetNoteOf()}`}};
      }
      try {
        const sheet = await window.api.videoContactSheet({path: filePath, cells: r.args.cells});
        st.chargeFrameBudget(1);
        const timeTable = sheet.timesSec.map((t, i) => `第 ${i + 1} 格=${t.toFixed(1)}s`).join('，');
        return {
          result: {ok: true, mode: 'contact-sheet',
            cols: sheet.cols, rows: sheet.rows, frames: sheet.frames, timesSec: sheet.timesSec,
            note: `${label}的缩略图墙已附图（${sheet.cols}×${sheet.rows}，${sheet.frames} 格，行优先）：${timeTable}。先在这张图上锁定感兴趣的时段，再用 mode=frames 对该时段高清抽 2-3 帧确认。${budgetNoteOf()}`},
          images: [{dataUrl: sheet.dataUrl, note: `${label} contact sheet（${sheet.frames} 格缩略图墙）`}],
        };
      } catch (err) {
        return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
      }
    }
    // 采样点：显式 timesSec 优先；缺省在「实际可用区间」（trim+挖段之后）上均匀取 count 点——
    // 被裁掉的头尾与挖掉的洞不会抽到，agent 看到的每一帧都是可用画面。
    // path 直连不知时长：用 ffprobe 时间线分析拿时长（失败退化为 0s 单帧）
    let segmentSecs: number[] | null = null;
    let times: number[];
    if (r.args.timesSec) {
      times = r.args.timesSec.map((t) => {
        const inCut = clipForCuts ? cutAt(t, clipForCuts.cuts) : null;
        return inCut ? inCut.end : t;
      });
    } else if (clipForCuts) {
      const planned = planFrameTimes(clipForCuts, r.args.count ?? 4);
      times = planned.map((p) => p.mediaSec);
      segmentSecs = planned.map((p) => p.segmentSec);
    } else {
      try {
        const timeline = await window.api.miningAnalyzeTimeline(filePath);
        const count = r.args.count ?? 4;
        times = Array.from({length: count}, (_, i) =>
          Math.round(timeline.durationSec * ((i + 0.5) / count) * 100) / 100);
      } catch {
        times = [0];
      }
    }
    // 看图预算：逐采样点过闸（重复帧/超量的点不抽帧），被跳过的时间点回告模型；
    // allowed 携带原下标的段内秒，避免部分被拦后标注错位
    const budget = budgetOf(ctx);
    const allowedTimes: number[] = [];
    const allowedSegSecs: number[] = [];
    const deniedTimes: string[] = [];
    for (let i = 0; i < times.length; i++) {
      const v = takeImageBudget(budget, frameBudgetKey(filePath, times[i]));
      if (v.allow) {
        allowedTimes.push(times[i]);
        if (segmentSecs) allowedSegSecs.push(segmentSecs[i]);
      } else {
        deniedTimes.push(`${times[i].toFixed(1)}s（${v.reason}）`);
      }
    }
    const allowedSegmentSecs = segmentSecs ? allowedSegSecs : null;
    if (allowedTimes.length === 0) {
      return {result: {ok: true, timesSec: times, imageSkipped: deniedTimes,
        note: `未附图：全部采样点均被看图预算拦下——${deniedTimes.join('；')}。${budgetNoteOf()}`}};
    }
    // 工程预算闸：只附「剩余额度」内的帧（防多素材工程看图爆预算）
    const stNow = ctx.getStore();
    const projRemaining = stNow.frameBudget === 0 ? Infinity : stNow.frameBudget - stNow.frameBudgetUsed;
    if (allowedTimes.length > projRemaining) {
      const dropped = allowedTimes.splice(Math.max(0, projRemaining)).length;
      if (allowedSegmentSecs) allowedSegSecs.splice(Math.max(0, projRemaining));
      deniedTimes.unshift(`工程看图预算仅剩 ${projRemaining} 帧（截断 ${dropped} 帧）`);
    }
    if (allowedTimes.length === 0) {
      return {result: {ok: true, timesSec: times, imageSkipped: deniedTimes,
        note: `未附图：工程看图预算已用尽。${budgetNoteOf()}`}};
    }
    try {
      const frames = await window.api.extractFrames({path: filePath, timesSec: allowedTimes});
      if (frames.length > 0) ctx.getStore().chargeFrameBudget(frames.length);
      const timeLabel = allowedTimes.map((t, i) => `${t.toFixed(1)}s${allowedSegmentSecs ? `(段内 ${allowedSegmentSecs[i].toFixed(1)}s)` : ''}`).join('、');
      const frameNotes = frames.map((f, i) => ({dataUrl: f.dataUrl, note: `${label}在 ${allowedTimes[i].toFixed(1)}s 的画面${allowedSegmentSecs ? `（段内 ${allowedSegmentSecs[i].toFixed(1)}s）` : ''}`}));
      // 视觉中继（决策脑/看图脑分离）：多帧交由看图子会话逐帧评估，文字结论回传
      if (ctx.visionRelay) {
        const verdict = await ctx.visionRelay(frameNotes,
          `以下是${label}的 ${frames.length} 帧（媒体时间点：${timeLabel}）。请逐帧客观描述并评估：主体与构图、明暗与画质、有无缺陷（黑场/水印/糊/穿帮）、各帧适合承载的内容与文案情绪。总共 240 字内。`);
        return {result: {ok: true, timesSec: allowedTimes,
          ...(allowedSegmentSecs ? {segmentSec: allowedSegmentSecs} : {}),
          ...(deniedTimes.length > 0 ? {imageSkipped: deniedTimes} : {}),
          seen: true, verdict,
          note: `${label}的 ${frames.length} 帧已由看图评估：见 verdict`}};
      }
      return {
        result: {ok: true, timesSec: allowedTimes,
          ...(allowedSegmentSecs ? {segmentSec: allowedSegmentSecs} : {}),
          ...(deniedTimes.length > 0 ? {imageSkipped: deniedTimes} : {}),
          note: `${label}的 ${frames.length} 帧画面已附图（媒体时间点：${timeLabel}${allowedSegmentSecs ? '；段内相对秒已附，可直接换算 trim/字幕时间' : ''}）${deniedTimes.length > 0 ? `；另有 ${deniedTimes.length} 个时间点未附图：${deniedTimes.join('；')}` : ''}。${budgetNoteOf()}，请查看`},
        images: frameNotes,
      };
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  scan_media: async (args, ctx) => {
    const r = validateScanMediaArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const seg = store.segments[r.args.index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${r.args.index} 越界，当前共 ${store.segments.length} 段`]}};
    const videoIndex = r.args.videoIndex ?? 0;
    const clip = seg.videos[videoIndex];
    if (!clip) return {result: {ok: false, errors: [`第 ${videoIndex} 个素材不存在（段内共 ${seg.videos.length} 个）`]}};
    if (clip.type !== 'video') return {result: {ok: false, errors: [`素材「${clip.name}」不是视频（图片/模型没有镜头概念）`]}};
    const srcPath = clipSrcToPath(clip.src);
    try {
      const map = await window.api.analyzeFootage(srcPath);
      if (!map || !map.shots || map.shots.length === 0) {
        return {result: {ok: false, errors: [`场景检测失败：「${clip.name}」解码不出画面帧（文件损坏或容器不支持）`]}};
      }
      // 清单落库（随工程保存；重复调用直接复用不重分析——分析在主进程有缓存）
      store.setSegmentVideoShots(r.args.index, videoIndex, map.shots);
      const lines = map.shots.map((s, i) => {
        const dur = s.endSec - s.startSec;
        const motion = s.motionScore >= 0.6 ? '高运动' : s.motionScore >= 0.3 ? '中运动' : '低运动';
        return `${i + 1}. ${s.startSec.toFixed(1)}s → ${s.endSec.toFixed(1)}s（${dur.toFixed(1)}s，${motion} ${s.motionScore}）`;
      });
      const topMotion = [...map.shots].sort((a, b) => b.motionScore - a.motionScore).slice(0, 3)
        .map((s) => `${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}s`).join('、');
      return {result: {ok: true, segmentIndex: r.args.index, videoIndex,
        durationSec: map.durationSec, shotCount: map.shots.length, shots: map.shots,
        message: `「${clip.name}」（${map.durationSec.toFixed(1)}s）检测出 ${map.shots.length} 个镜头（已缓存进素材，随工程保存）：\n${lines.join('\n')}\n运动最强的镜头：${topMotion}（适合高光位/卡点快切）。配 view_media_frames(mode=contact-sheet) 视觉确认、set_segment_trim 按镜头边界裁剪。`}};
    } catch (err) {
      return {result: {ok: false, errors: [`场景检测失败：${stripIpcPrefix(err)}`]}};
    }
  },

  split_segment: async (args, ctx) => {
    const r = validateSplitSegmentArgs(args);
    if (!r.ok) return {result: r};
    const {index, atSec} = r.args;
    const store = ctx.getStore();
    const seg = store.segments[index];
    if (!seg) return {result: {ok: false, errors: [`下标 ${index} 越界，当前故事板共 ${store.segments.length} 段（下标 0 起）`]}};
    const duration = seg.duration || 8;
    if (!store.runTimelineCommand({kind: 'splitSegment', index, atSec})) {
      return {result: {ok: false, errors: [`第 ${index + 1} 段时长 ${duration}s，拆点 atSec 需在 0.5 ~ ${(duration - 0.5).toFixed(1)}s 之间`]}};
    }
    return {result: {ok: true, message: `第 ${index + 1} 段已拆成两段：前半 ${atSec}s（仍在下标 ${index}），后半 ${(duration - atSec).toFixed(1)}s（下标 ${index + 1}），其后的片段下标均 +1`}};
  },

  undo: async (_args, ctx) => {
    const store = ctx.getStore();
    const top = store.historyPast[store.historyPast.length - 1];
    if (!top) {
      return {result: {ok: false, errors: ['没有可撤销的历史——当前状态之后再无改动记录']}};
    }
    const label = top.opName ?? '最近一次改动';
    const source = top.source === 'agent' ? 'AI' : '用户';
    store.undo();
    return {result: {ok: true, message: `已撤销一步：${label}（${source} 的改动已回退）。用 get_storyboard 复核当前状态后再继续`}};
  },

  delete_segment: async (args, ctx) => {
    const r = validateDeleteSegmentArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    if (!store.segments[r.args.index]) {
      return {result: {ok: false, errors: [`下标 ${r.args.index} 越界，当前故事板共 ${store.segments.length} 段（下标 0 起）`]}};
    }
    if (store.segments.length <= 1) {
      return {result: {ok: false, errors: ['故事板只剩最后一段，不能删除（至少保留一段）。想换内容请用 update_segment 修改该段，想清素材可用 remove_segment_media 逐个移除后补充']}};
    }
    store.removeSegment(r.args.index);
    const remaining = ctx.getStore().segments.length;
    return {result: {ok: true, message: `已删除第 ${r.args.index + 1} 段（连同其素材与文案），当前共 ${remaining} 段，原其后的片段下标 -1`}};
  },

  move_segment: async (args, ctx) => {
    const r = validateMoveSegmentArgs(args);
    if (!r.ok) return {result: r};
    const {fromIndex, toIndex} = r.args;
    const store = ctx.getStore();
    const total = store.segments.length;
    if (fromIndex >= total) {
      return {result: {ok: false, errors: [`fromIndex ${fromIndex} 越界，当前故事板共 ${total} 段（下标 0 起）`]}};
    }
    if (toIndex >= total) {
      return {result: {ok: false, errors: [`toIndex ${toIndex} 越界，当前共 ${total} 段，目标下标最大 ${total - 1}`]}};
    }
    if (fromIndex === toIndex) {
      return {result: {ok: true, message: `第 ${fromIndex + 1} 段已在目标位置，无需移动`}};
    }
    store.reorderSegments(fromIndex, toIndex);
    return {result: {ok: true, message: `已把原第 ${fromIndex + 1} 段移动到第 ${toIndex + 1} 位（其余段顺次腾位），共 ${total} 段`}};
  },

  remove_segment_media: async (args, ctx) => {
    const r = validateRemoveSegmentMediaArgs(args);
    if (!r.ok) return {result: r};
    const {index, videoIndex} = r.args;
    const store = ctx.getStore();
    const seg = store.segments[index];
    if (!seg) {
      return {result: {ok: false, errors: [`下标 ${index} 越界，当前故事板共 ${store.segments.length} 段（下标 0 起）`]}};
    }
    if (!seg.videos[videoIndex]) {
      return {result: {ok: false, errors: [`videoIndex ${videoIndex} 越界，第 ${index + 1} 段共 ${seg.videos.length} 个素材（可先 get_segment_media 查看清单）`]}};
    }
    if (seg.videos.length <= 1) {
      // 守卫只对「确实需要画面」的模板生效：零素材模板（minVideos=0，如 KineticType 纯文字）
      // 挂载的素材只是装饰，允许移除回到纯文字态。自定义/AI 生成模板查不到元数据，保守拦截。
      const minVideos = getTemplateById(seg.templateId)?.minVideos ?? 1;
      if (minVideos > 0) {
        return {result: {ok: false, errors: [`第 ${index + 1} 段只有这 1 个素材，移除后该段将无画面。请改用 delete_segment 删整段，或先导入/录制新素材再移除旧的`]}};
      }
    }
    const removedName = seg.videos[videoIndex].name;
    store.removeVideoFromSegment(index, videoIndex);
    const remaining = ctx.getStore().segments[index]?.videos.length ?? 0;
    return {result: {ok: true, message: `已移除第 ${index + 1} 段的素材「${removedName}」（段内剩 ${remaining} 个），段落与文案保留；后续素材下标前移`}};
  },

  preview_storyboard_frame: async (args, ctx) => {
    // 与 useStartRender 同口径：先把工作副本刷入故事板，再按最新状态组装 inputProps
    ctx.getStore().syncCurrentToSegment();
    const {segments, editPlan, orientation, aspectRatioId, bgm, sfx, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood, customTemplates, marketTemplates, generatedTemplates} = ctx.getStore();
    if (segments.length === 0) return {result: {ok: false, errors: ['故事板为空，无法预览']}};
    const total = segments.reduce((sum, s) => sum + s.duration, 0);
    const a = (args || {}) as Record<string, unknown>;
    let t = 0;
    if (a.timeSec !== undefined && a.timeSec !== null) {
      if (typeof a.timeSec !== 'number' || !Number.isFinite(a.timeSec) || a.timeSec < 0) {
        return {result: {ok: false, errors: ['timeSec 必须是 ≥0 的数字']}};
      }
      // 钳在全片时长内（末尾留一帧余量，避免落到片尾淡黑之后）
      t = Math.min(a.timeSec, Math.max(0, total - 1 / 30));
    }
    try {
      // 组装口径与 startRender 完全一致（含 sfx/sfxSources/texture/beatPulse/cursor），
      // 保证静帧预览与成片所见即所得
      const sfxSources = await getSfxSources();
      const frame = await window.api.renderStoryboardStill({
        inputProps: {segments, editPlan: editPlan ?? undefined, orientation, customTemplates: [...customTemplates, ...marketTemplates.map((tpl) => tpl.def)], generatedTemplates, bgm, sfx, sfxSources, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood} as MultiSegmentProps,
        aspectRatioId,
        timeSec: t,
      });
      return {
        result: {ok: true, timeSec: t, totalDuration: total, width: frame.width, height: frame.height,
          note: `故事板第 ${t.toFixed(1)}s 的成片画面已附图（当前故事板共 ${segments.length} 段、${total.toFixed(1)}s），请查看`},
        image: {dataUrl: frame.dataUrl, note: `故事板第 ${t.toFixed(1)}s 的成片画面（全片共 ${total.toFixed(1)}s）`},
      };
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  review_render: async (args, ctx) => {
    const r = validateReviewRenderArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    // 与 preview_storyboard_frame 同口径：先把工作副本刷入故事板（审片与体检都看最新内容）
    store.syncCurrentToSegment();

    // 本地可读性体检（零 LLM 成本，纯规则）：成片有没有都可先跑
    const lintIssues = lintReadability({segments: store.segments});
    const lintWarn = lintIssues.filter((i) => i.severity === 'warn').length;
    const lintSummary = lintIssues.length > 0
      ? `本地可读性体检 ${lintIssues.length} 条（warn ${lintWarn}）：` + lintIssues.map((i) => `[${i.severity}]${i.segmentIndex !== undefined ? `第${i.segmentIndex + 1}段` : '全片'} ${i.message}`).join('；')
      : '本地可读性体检全部通过';
    // 模板自检 checkpoints（渲前纯函数断言，shared/template-checkpoints 与装配/渲染共用）
    const checkpointIssues = lintCheckpoints(store.segments);
    const checkpointSummary = checkpointIssues.length > 0
      ? `模板自检 ${checkpointIssues.length} 条：` + checkpointIssues.map((i) => `[${i.severity}]${i.message}`).join('；')
      : '模板自检全部通过';

    // 成片来源：显式 path（须已注册，主进程白名单校验）或最近一次渲染输出
    const videoPath = r.args.path || store.renderOutputPath;
    if (!videoPath) {
      // 无成片：不报错了——先返回本地体检结果（文案问题渲染前就能改）
      return {result: {
        ok: true, lintOnly: true, issues: lintIssues,
        note: `暂无成片可做视觉审片（先 request_render 渲染）。${lintSummary}。${checkpointSummary}。视觉审片需成片 + 多模态模型。`,
      }};
    }

    // 抽帧时刻：按段时间轴（与 MultiSegmentPromo contentFrames 同构，30fps），
    // 每段取「入场后」（起点 + min(0.5, 25% 段长)）与「段中点」两帧，上限 8 帧均匀截断
    const FPS = 30;
    const segments = store.segments;
    if (segments.length === 0) return {result: {ok: false, errors: ['故事板为空，先 set_storyboard 建立片段后再渲染审片']}};
    let acc = 0;
    const raw: Array<{timeSec: number; segIndex: number}> = [];
    for (let i = 0; i < segments.length; i++) {
      const dur = segments[i].duration || 8;
      const start = acc / FPS;
      const t1 = start + Math.min(0.5, dur * 0.25);
      const t2 = start + dur / 2;
      if (t1 > t2 - 0.1) raw.push({timeSec: t2, segIndex: i});
      else {raw.push({timeSec: t1, segIndex: i}); raw.push({timeSec: t2, segIndex: i});}
      acc += Math.round(dur * FPS);
    }
    const capped = raw.length <= 8
      ? raw
      : Array.from({length: 8}, (_, k) => raw[Math.round((k / 7) * (raw.length - 1))]);
    const frameTimes = capped.map((f) => Math.max(0.05, Math.round(f.timeSec * 100) / 100));

    // extractFrames IPC 单次限 1-4 个时刻，分批抽帧
    let frames: Array<{dataUrl: string}> = [];
    try {
      for (let i = 0; i < frameTimes.length; i += 4) {
        const batch = await window.api.extractFrames({path: videoPath, timesSec: frameTimes.slice(i, i + 4)});
        frames = frames.concat(batch);
      }
    } catch (err) {
      const msg = stripIpcPrefix(err);
      return {result: {ok: false, errors: [`抽帧失败（${msg}）。确认成片路径存在且是本应用渲染产物；外部路径需先导入注册。`]}};
    }
    if (frames.length === 0) {
      return {result: {ok: false, errors: ['未抽到任何帧，成片可能损坏或时长为 0']}};
    }

    // 组装审片请求：提示词 + 故事板上文 + 逐帧画面（OpenAI vision 格式）
    const prompt = buildReviewPrompt({
      segments: segments.map((s, i) => ({
        index: i, templateId: s.templateId, title: s.text?.title, subtitle: s.text?.subtitle, duration: s.duration || 8,
      })),
      frames: frames.map((_, i) => ({
        timeSec: frameTimes[i],
        note: `第 ${frameTimes[i].toFixed(1)}s（第 ${capped[i].segIndex + 1} 段内）`,
      })),
      focus: r.args.focus,
    });
    const content: ContentPart[] = [
      {type: 'text', text: prompt},
      ...frames.map((f) => ({type: 'image_url' as const, image_url: {url: f.dataUrl}})),
    ];
    let assistantText = '';
    try {
      const reply = await window.api.llmChat({messages: [{role: 'user', content}]});
      assistantText = typeof reply.content === 'string' ? reply.content
        : Array.isArray(reply.content) ? reply.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
        : '';
    } catch (err) {
      const msg = stripIpcPrefix(err);
      // LLM 未配置 / 非视觉模型（携带 image_url 报 4xx）给出针对性指引
      if (/未配置/.test(msg)) {
        return {result: {ok: false, errors: [`${msg}。审片需在「设置 → AI 助手」配置多模态视觉模型（如 gpt-4o / qwen-vl / glm-4v）。`]}};
      }
      if (/image|vision|视觉|multimodal|400|422/i.test(msg)) {
        return {result: {ok: false, errors: [`当前模型可能不支持看图（${msg}）。请到「设置 → AI 助手」切换为多模态视觉模型（如 gpt-4o / qwen-vl / glm-4v）后重试。`]}};
      }
      return {result: {ok: false, errors: [`审片模型调用失败：${msg}`]}};
    }

    const parsed = parseReviewReport(assistantText);
    if (!parsed.ok) {
      // 解析失败不阻断：把模型原文返回，调用方 agent 仍可读文本报告
      return {
        result: {ok: true, parsed: false, path: videoPath, localLint: {total: lintIssues.length, warn: lintWarn, issues: lintIssues},
          note: '审片完成，但报告不是标准 JSON，以下为模型原文：', modelText: assistantText.slice(0, 4000)},
        images: frames.map((f, i) => ({dataUrl: f.dataUrl, note: `成片第 ${frameTimes[i].toFixed(1)}s 画面`})),
      };
    }

    // 问题清单按严重度排序（high > medium > low），便于调用方按序改稿
    const rank = {high: 0, medium: 1, low: 2} as const;
    parsed.report.issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    const highCount = parsed.report.issues.filter((i) => i.severity === 'high').length;
    return {
      result: {
        ok: true,
        parsed: true,
        path: videoPath,
        report: parsed.report,
        localLint: {total: lintIssues.length, warn: lintWarn, issues: lintIssues},
        frameTimesSec: frameTimes,
        note: `审片完成：总分 ${parsed.report.overall}/5（${parsed.report.verdict === 'pass' ? '可投放' : parsed.report.verdict === 'revise' ? '建议修改后重渲' : '需要重做'}），` +
          `问题 ${parsed.report.issues.length} 条（高危 ${highCount}）。` +
          (lintIssues.length > 0 ? `${lintSummary}。` : '本地可读性体检通过。') +
          (checkpointIssues.length > 0 ? `${checkpointSummary}。` : '') +
          `按问题清单的 segmentIndex 用 update_segment/set_storyboard 局部改稿，改后重渲可再次审片。`,
      },
      images: frames.map((f, i) => ({dataUrl: f.dataUrl, note: `成片第 ${frameTimes[i].toFixed(1)}s 画面`})),
    };
  },

  export_cover: async (args, ctx) => {
    const r = validateExportCoverArgs(args);
    if (!r.ok) return {result: r};
    // 与 preview_storyboard_frame 同口径：刷工作副本 + 组装完整 inputProps
    const store = ctx.getStore();
    store.syncCurrentToSegment();
    const {segments, editPlan, orientation, aspectRatioId, bgm, sfx, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood, customTemplates, marketTemplates, generatedTemplates, publish, appSettings, renderSettings, projectName} = ctx.getStore();
    if (segments.length === 0) return {result: {ok: false, errors: ['故事板为空，无法生成封面']}};
    const total = segments.reduce((sum, s) => sum + s.duration, 0);

    // 输出目录可空：主进程 RENDER_COVER 会回落系统「视频」文件夹（未配置目录不再阻塞封面生成）
    const outputDir = appSettings.defaultOutputDir?.trim() || '';

    // 有效封面配置：已保存配置 ← preset 重排 ← 参数补丁 ← 文案缺省链补全
    let cover = sanitizeCoverConfig(publish.cover, orientation);
    if (r.args.preset) cover = applyCoverPreset(cover, r.args.preset, orientation);
    cover = {
      ...cover,
      layers: cover.layers.map((l) => {
        if (l.role === 'title' && r.args.title !== undefined) return {...l, text: r.args.title};
        if (l.role === 'subtitle' && r.args.subtitle !== undefined) return {...l, text: r.args.subtitle};
        if (l.role === 'tag' && r.args.tag !== undefined) {
          return {...l, text: r.args.tag, chipColor: r.args.tag ? (l.chipColor || '#2563EB') : ''};
        }
        return l;
      }),
      ...(r.args.scrim !== undefined ? {scrim: r.args.scrim} : {}),
      ...(r.args.format !== undefined ? {format: r.args.format} : {}),
      ...(r.args.timeSec !== undefined ? {timeSec: r.args.timeSec} : {}),
    };
    if (r.args.add3dText) {
      const t = r.args.add3dText;
      const color = t.color || '#FFFFFF';
      cover = {
        ...cover,
        layers: [...cover.layers, {
          id: `text-${Date.now() % 100000}`,
          text: t.text,
          font: 'heavy' as const,
          x: t.x ?? 0.5,
          y: t.y ?? 0.42,
          align: 'center' as const,
          size: t.size ?? 190,
          color,
          strokeColor: '',
          strokeWidth: 0,
          rotation: 0,
          depth: t.depth ?? 16,
          angle: t.angle ?? 45,
          sideColor: t.sideColor || darkenHex(color, 0.45),
          behind: t.behind !== false,
          chipColor: '',
        }].slice(0, 6),
      };
    }
    const effTexts = effectiveCoverTexts(cover, publish.metadata, segments[0]?.text);
    cover = withEffectiveTexts(cover, effTexts);
    if (!cover.layers.some((l) => l.text.trim())) {
      return {result: {ok: false, errors: ['封面没有任何文案（所有文字图层为空）：请给 title，或先用 set_publish_metadata 写标题']}};
    }
    // 首次生成（timeSec 还是默认 0.8s 或超出全片时长）时落到推荐时刻
    const timeSec = cover.timeSec > total ? Math.max(0, total - 0.2) : Math.min(cover.timeSec, Math.max(0, total - 1 / 30));

    // behind 图层需要主体遮挡 mask：抽当前帧做显著性检测（检测不可靠时降级为普通图层并提示）
    let maskDataUrl = '';
    let maskNote = '';
    if (cover.layers.some((l) => l.behind && l.text.trim())) {
      try {
        const sfxSourcesForMask = await getSfxSources();
        const frame = await window.api.renderStoryboardStill({
          inputProps: {segments, editPlan: editPlan ?? undefined, orientation, customTemplates: [...customTemplates, ...marketTemplates.map((tpl) => tpl.def)], generatedTemplates, bgm, sfx, sfxSources: sfxSourcesForMask, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood} as MultiSegmentProps,
          aspectRatioId,
          timeSec,
        });
        const mask = await computeSubjectMaskFromImage(frame.dataUrl);
        if (mask.coverage >= 0.005 && mask.coverage <= 0.75) {
          maskDataUrl = mask.maskDataUrl;
          maskNote = `主体检测覆盖 ${(mask.coverage * 100).toFixed(0)}%（behind 图层已渲染到主体后面）`;
        } else {
          maskNote = `主体检测不可靠（覆盖 ${(mask.coverage * 100).toFixed(0)}%，背景可能过乱或无明确主体），behind 图层本次按普通前景渲染`;
        }
      } catch (err) {
        maskNote = `主体检测失败（${stripIpcPrefix(err)}），behind 图层按普通前景渲染`;
      }
    }

    try {
      const sfxSources = await getSfxSources();
      const res = await window.api.renderCoverStill({
        inputProps: {segments, editPlan: editPlan ?? undefined, orientation, customTemplates: [...customTemplates, ...marketTemplates.map((tpl) => tpl.def)], generatedTemplates, bgm, sfx, sfxSources, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood} as MultiSegmentProps,
        aspectRatioId,
        timeSec,
        cover,
        outputDir,
        baseName: renderSettings.filename.trim() || projectName,
        ...(maskDataUrl ? {maskDataUrl} : {}),
      });
      // 记住本次配置（不含 mask，mask 每次按当前帧现算），下次导出/AI 调用直接复用
      ctx.getStore().setCoverConfig(cover);
      return {
        result: {
          ok: true,
          path: res.outputPath, width: res.width, height: res.height,
          layerCount: cover.layers.length, timeSec,
          ...(maskNote ? {mask: maskNote} : {}),
          note: `封面已生成（${cover.format.toUpperCase()} ${res.width}×${res.height}，第 ${timeSec.toFixed(1)}s 帧，${cover.layers.length} 个文字图层），已附图——请检查文字清晰度与主体遮挡效果${maskNote ? '；' + maskNote : ''}`,
        },
        image: {dataUrl: res.dataUrl, note: `封面图（含 ${cover.layers.filter((l) => l.text.trim()).length} 层文字）`},
      };
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  set_publish_metadata: async (args, ctx) => {
    const r = validateSetPublishMetadataArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    store.setPublishMetadata(r.args);
    const meta = ctx.getStore().publish.metadata;
    const warnings = checkPlatformLimits(meta);
    return {
      result: {
        ok: true,
        metadata: meta,
        platformCopies: PUBLISH_PLATFORMS.map((p) => ({platform: p, label: PLATFORM_SPECS[p].label, text: buildPlatformCopy(p, meta)})),
        warnings: warnings.map((w) => w.message),
        message: warnings.length === 0
          ? '发布元数据已保存（随工程文件持久化）。用户可在「渲染导出 → 封面与发布信息」按平台一键复制；配 export_cover 生成封面即完成发布物料准备'
          : `发布元数据已保存，但有 ${warnings.length} 条平台字数警告（见 warnings），建议收缩后重设`,
      },
    };
  },

  search_stock_media: async (args) => {
    const r = validateSearchStockArgs(args);
    if (!r.ok) return {result: r};
    try {
      const {items, warnings} = await window.api.searchStockMedia({
        query: r.args.query,
        type: r.args.type ?? 'video',
        ...(r.args.orientation ? {orientation: r.args.orientation} : {}),
        ...(r.args.perPage ? {perPage: r.args.perPage} : {}),
      });
      // 前 4 张缩略图代下载转 dataUrl 附回（agent 可直接看图挑，多的靠元数据）
      const withPreview = items.slice(0, 4);
      const thumbs = await Promise.all(withPreview.map((it) => window.api.fetchStockThumbnail(it.previewUrl)));
      const images = withPreview
        .map((it, i) => ({dataUrl: thumbs[i], note: `${it.provider} ${it.type} #${it.id}：${it.title}`}))
        .filter((x) => x.dataUrl);
      return {result: {
        ok: true,
        items: items.map((it: StockMediaItem) => ({
          provider: it.provider, type: it.type, id: it.id, title: it.title, author: it.author,
          durationSec: it.durationSec, width: it.width, height: it.height, downloadUrl: it.downloadUrl,
          pageUrl: it.pageUrl, tags: it.tags,
        })),
        warnings,
        message: `搜到 ${items.length} 条（${warnings.length > 0 ? `部分源失败：${warnings.join('；')}；` : ''}选中后用 import_stock_media 导入，provider/id/type/downloadUrl 原样传回）`,
      }, ...(images.length > 0 ? {images} : {})};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  import_stock_media: async (args, ctx) => {
    const r = validateImportStockArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    if (!store.segments[r.args.index]) {
      return {result: {ok: false, errors: [`下标 ${r.args.index} 越界，当前共 ${store.segments.length} 段`]}};
    }
    if (!(await ctx.requestConfirm('AI 请求下载 stock 素材', `将从 ${r.args.provider} 下载 1 条${r.args.type === 'photo' ? '图片' : '视频'}素材并加入第 ${r.args.index + 1} 段（免署名可商用）`))) {
      return {result: {ok: false, errors: ['用户拒绝了下载操作']}};
    }
    try {
      const dl = await window.api.downloadStockMedia({
        provider: r.args.provider, id: r.args.id, type: r.args.type, url: r.args.downloadUrl,
      });
      const meta = await window.api.getVideoMetadata(dl.path);
      const httpUrl = await window.api.getVideoHttpUrl(dl.path);
      const dur = Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : 0;
      const clip: VideoClip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        src: httpUrl,
        name: dl.fileName,
        type: meta.type,
        width: meta.width,
        height: meta.height,
        duration: dur,
        trimStart: 0,
        trimEnd: dur,
        trimmedDuration: dur,
      };
      try {
        const stats = await window.api.analyzeMediaColor(dl.path);
        if (stats) clip.colorStats = stats;
      } catch {
        /* 分析失败不阻塞 */
      }
      // 缩略图（时间线/故事板卡片；下载后本地文件抽帧，失败退文字预览不阻塞）
      clip.thumbnail = await makeClipThumbnail(dl.path, dur);
      ctx.getStore().addVideosToSegment(r.args.index, [clip]);
      return {result: {ok: true, name: clip.name, type: meta.type, duration: dur, width: meta.width, height: meta.height,
        segmentIndex: r.args.index,
        message: `已下载并导入「${clip.name}」到第 ${r.args.index + 1} 段（${meta.type === 'image' ? '图片' : `${dur.toFixed(1)}s`}，${meta.width}×${meta.height}；可 view_segment_frame 看图、set_segment_trim 裁剪）`}};
    } catch (err) {
      return {result: {ok: false, errors: [`素材下载/导入失败：${stripIpcPrefix(err)}`]}};
    }
  },

  generate_image: async (args, ctx) => {
    const r = validateGenerateImageArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    if (r.args.index !== undefined && !store.segments[r.args.index]) {
      return {result: {ok: false, errors: [`下标 ${r.args.index} 越界，当前共 ${store.segments.length} 段`]}};
    }
    if (!(await ctx.requestConfirm('AI 请求文生图', `将调用生图模型（消耗你的生图额度）${r.args.index !== undefined ? `，图片加入第 ${r.args.index + 1} 段` : ''}`))) {
      return {result: {ok: false, errors: ['用户拒绝了生图操作']}};
    }
    try {
      const gen = await window.api.generateImage({prompt: r.args.prompt, ...(r.args.size ? {size: r.args.size} : {})});
      if (r.args.index === undefined) {
        return {result: {ok: true, path: gen.path, src: gen.src,
          message: `图片已生成（${gen.path}）。需要入段时把该路径作为 import_segment_media 的 path 使用`}};
      }
      const meta = await window.api.getVideoMetadata(gen.path);
      const httpUrl = await window.api.getVideoHttpUrl(gen.path);
      const clip: VideoClip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        src: httpUrl,
        name: gen.path.split('\\').pop() || gen.path.split('/').pop() || 'generated',
        type: 'image',
        width: meta.width,
        height: meta.height,
        duration: 0,
      };
      // 缩略图（extractFrame 对图片=缩放自身；故事板卡只看 thumbnail，不带会误显 Film 图标）
      clip.thumbnail = await makeClipThumbnail(gen.path, 0);
      ctx.getStore().addVideosToSegment(r.args.index, [clip]);
      return {result: {ok: true, path: gen.path, segmentIndex: r.args.index, width: meta.width, height: meta.height,
        message: `图片已生成并加入第 ${r.args.index + 1} 段（${meta.width}×${meta.height}；view_segment_frame 查看效果）`}};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  generate_model: async (args, ctx) => {
    const r = validateGenerateModelArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const idx = r.args.index ?? store.activeSegmentIndex;
    if (!store.segments[idx]) {
      return {result: {ok: false, errors: [`下标 ${idx} 越界，当前共 ${store.segments.length} 段`]}};
    }
    // 未配置 Key 时直接引导去设置（不弹确认卡，省得用户白点一次）
    const configured = await window.api.modelGenGetStatus().then((s) => s.configured).catch(() => false);
    if (!configured) {
      return {result: {ok: false, errors: ['未配置文生 3D 的 API Key——请用户到「设置 → 文生 3D」保存 Key（去 meshy.ai 申请）后再试']}};
    }
    if (!(await ctx.requestConfirm('AI 请求文生 3D', `将调用 3D 生成模型（消耗你的生成额度，约 1-3 分钟），模型加入第 ${idx + 1} 段：「${r.args.prompt.slice(0, 40)}」`))) {
      return {result: {ok: false, errors: ['用户拒绝了 3D 生成操作']}};
    }
    try {
      // 命中缓存时直接是成功快照；否则按 3s 间隔轮询主进程任务快照（带进度回写）直到终态
      let task = await window.api.generateModel({prompt: r.args.prompt, ...(r.args.artStyle ? {artStyle: r.args.artStyle} : {})});
      // 前端兜底超时 10 分钟（主进程任务自身 8 分钟超时，此处只防快照卡死）
      const deadline = Date.now() + 10 * 60_000;
      while (task.state !== 'succeeded' && task.state !== 'failed') {
        if (Date.now() > deadline) {
          return {result: {ok: false, errors: [`等待 3D 生成结果超时（最后进度 ${task.progress}%）——任务可能仍在后台进行，稍后重试同提示词可命中缓存`]}};
        }
        await new Promise((r2) => setTimeout(r2, MODEL_GEN_FRONTEND_POLL_MS));
        task = (await window.api.modelGenGetStatus()).task;
      }
      if (task.state === 'failed' || !task.path || !task.src) {
        return {result: {ok: false, errors: [task.message || '3D 生成失败（无错误详情）']}};
      }
      const meta = await window.api.getVideoMetadata(task.path);
      const clip: VideoClip = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        src: task.src,
        name: `${r.args.prompt.slice(0, 24)}.glb`,
        type: 'model',
        width: meta.width,
        height: meta.height,
        duration: 0,
      };
      ctx.getStore().addVideosToSegment(idx, [clip]);
      return {result: {ok: true, path: task.path, segmentIndex: idx,
        message: `3D 模型已生成并加入第 ${idx + 1} 段（未压缩 glb；配 ModelTurntable 等 3D 模板用，裁剪/取景对模型无意义）`}};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  analyze_media_tags: async (_args, ctx) => {
    const store = ctx.getStore();
    // 收集全部段落的视频素材（图片用单帧），跳过已打标的（幂等，重跑只补新素材）
    const targets: Array<{index: number; clip: VideoClip; path: string}> = [];
    store.segments.forEach((seg, i) => {
      for (const clip of seg.videos) {
        if (store.mediaTags[clip.src]) continue;
        targets.push({index: i, clip, path: clipSrcToPath(clip.src)});
      }
    });
    if (targets.length === 0) {
      const tagged = Object.keys(store.mediaTags).length;
      return {result: {ok: true, tagged, message: tagged > 0
        ? `全部素材已有打标（${tagged} 条，见 get_project_info 的 mediaTags）`
        : '故事板里没有素材——先导入/录制/下载素材后再打标'}};
    }
    const tags: Record<string, MediaTag> = {};
    const footageByPath: Record<string, {durationSec: number; shots: Array<{startSec: number; endSec: number; motionScore: number}>}> = {};
    const failures: string[] = [];
    for (const t of targets) {
      try {
        let durationSec = Math.max(0, t.clip.duration || 0);
        let samples: MediaStorySample[] = [{timeSec: 0}];
        if (t.clip.type !== 'image') {
          // 本地镜头分析不可用时仍均匀取样，不能影响视觉打标主流程。
          let shots: Array<{startSec: number; endSec: number}> | undefined;
          try {
            const footage = await window.api.analyzeFootage(t.path);
            if (footage?.durationSec && footage.durationSec > 0) durationSec = footage.durationSec;
            shots = footage?.shots;
            if (footage) footageByPath[t.path] = footage;
          } catch {
            // 退回到 clip 元数据时长的均匀取样。
          }
          samples = planMediaStorySamples(durationSec, shots);
        }

        // extractFrames 的 IPC 对批量数有限制；保留顺序使时间说明与画面严格配对。
        const frames: Array<{dataUrl: string; width: number; height: number}> = [];
        for (let i = 0; i < samples.length; i += 4) {
          const batch = await window.api.extractFrames({
            path: t.path,
            timesSec: samples.slice(i, i + 4).map((sample) => sample.timeSec),
          });
          frames.push(...batch);
        }
        if (frames.length === 0) {failures.push(t.clip.name); continue;}
        const framePairs = frames.map((frame, index) => ({frame, sample: samples[index]})).filter((pair): pair is {frame: typeof frames[number]; sample: MediaStorySample} => Boolean(pair.sample));
        const sampleNote = framePairs.map(({sample}) =>
          `${sample.timeSec.toFixed(2)}s${sample.shotIndex === undefined ? '' : `（镜头 ${sample.shotIndex + 1}）`}`,
        ).join(' → ');
        const prompt = buildMediaTagPrompt(
          `素材「${t.clip.name}」（第 ${t.index + 1} 段，${t.clip.type === 'image' ? '图片' : `视频 ${durationSec.toFixed(1)}s`}）按时间顺序的 ${framePairs.length} 个样本：${sampleNote}`,
        );
        const content: ContentPart[] = [
          {type: 'text', text: prompt},
          ...framePairs.flatMap(({frame, sample}) => [
            {type: 'text' as const, text: `时间点 ${sample.timeSec.toFixed(2)}s${sample.shotIndex === undefined ? '' : `，镜头 ${sample.shotIndex + 1}`}：以下是此刻画面。`},
            {type: 'image_url' as const, image_url: {url: frame.dataUrl}},
          ]),
        ];
        const reply = await window.api.llmChat({messages: [{role: 'user', content}]});
        const text = typeof reply.content === 'string' ? reply.content
          : Array.isArray(reply.content) ? reply.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          : '';
        const tag = parseMediaTagResponse(text, {durationSec});
        if (tag) tags[t.clip.src] = tag;
        else failures.push(t.clip.name);
      } catch (err) {
        const msg = stripIpcPrefix(err);
        if (/未配置/.test(msg)) {
          return {result: {ok: false, errors: [`${msg}。视觉打标需在「设置 → AI 助手」配置多模态视觉模型（如 gpt-4o / qwen-vl / glm-4v）。`]}};
        }
        if (/image|vision|视觉|multimodal|400|422/i.test(msg)) {
          return {result: {ok: false, errors: [`当前模型可能不支持看图（${msg}）。请切换为多模态视觉模型后重试。`]}};
        }
        failures.push(`${t.clip.name}（${msg}）`);
      }
    }
    if (Object.keys(tags).length > 0) store.setMediaTags(tags);
    if (Object.keys(tags).length > 0) {
      const mergedTags = {...store.mediaTags, ...tags};
      const inputs = store.segments.flatMap((seg) => seg.videos.map((clip) => ({
        path: clipSrcToPath(clip.src), name: clip.name, durationSec: clip.duration || 0,
        type: clip.type, tag: mergedTags[clip.src], footage: footageByPath[clipSrcToPath(clip.src)],
      })));
      store.setMediaIntelligence(buildMediaIntelligenceIndex(inputs));
    }
    return {result: {
      ok: Object.keys(tags).length > 0,
      tagged: Object.keys(tags).length,
      failed: failures,
      tags,
      message: Object.keys(tags).length > 0
        ? `已打标 ${Object.keys(tags).length} 条素材${failures.length > 0 ? `，${failures.length} 条失败（${failures.join('、')}）` : ''}。结果已随工程记住，get_project_info 可查；写故事板/换素材时按素材的时间过程、description 和 scene 对位`
        : `全部 ${failures.length} 条素材打标失败（${failures.join('、')}）`,
    }};
  },

  set_bgm: async (args, ctx) => {
    const r = validateSetBgmArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    // 清除
    if (r.args.track === 'none') {
      store.setBgm(null);
      return {result: {ok: true, message: '已清除背景音乐'}};
    }
    // 候选池 = 内置配乐（resources/bgm 12 首 CC BY 4.0，带 credit 走强制署名）+ 用户本地曲库
    // 两层类型：track 池条目（分析前，只有路径）→ candidate（分析后补 mood/energy）
    type BgmTrackEntry = {name: string; path: string; moodLabelZh?: string; credit?: import('../../shared/bgm-credits').BgmCredit};
    type BgmPickCandidate = MusicCandidate & {credit?: import('../../shared/bgm-credits').BgmCredit};
    let tracks: BgmTrackEntry[] = [];
    try {
      const builtin = await window.api.getBgmLibrary();
      for (const t of builtin) {
        tracks.push({
          name: t.title, path: t.path, moodLabelZh: t.moodLabel,
          credit: {file: t.file, title: t.title, author: t.author, license: t.license, url: t.url},
        });
      }
    } catch {
      /* 内置库异常不阻塞本地曲库 */
    }
    try {
      const local = await window.api.scanMusicLibrary();
      for (const t of local) tracks.push({name: t.name, path: t.path});
    } catch (err) {
      return {result: {ok: false, errors: [`曲库扫描失败：${stripIpcPrefix(err)}`]}};
    }
    if (tracks.length === 0) {
      return {result: {ok: false, errors: ['内置配乐不可用且本地曲库为空（内置配乐随安装包走，异常请反馈；或在「声音 → 背景音乐」指定本地曲库目录）']}};
    }
    const candidates: BgmPickCandidate[] = [];
    for (const t of tracks.slice(0, 60)) {
      let durationSec = 0;
      let peaks: number[] | undefined;
      try {
        const a = await window.api.analyzeMusic(t.path);
        durationSec = a.duration;
        peaks = a.peaks;
      } catch {
        /* 分析失败按未知能量处理 */
      }
      const energy = energyFromPeaks(peaks);
      // 内置曲情绪取槽位标签（振奋/舒缓/…映射进 mood 表），本地曲按文件名推导
      candidates.push({name: t.name, path: t.path, credit: t.credit, durationSec, mood: classifyMusicMood(t.moodLabelZh ?? t.name), energy: energy.level, energyAvg: energy.avg});
    }
    // 纯查询（不选曲）：返回按需求排序的清单
    const wantMood = r.args.wantMood;
    const wantEnergy = r.args.wantEnergy;
    const pick = (name: string) => {
      const n = name.toLowerCase();
      return candidates.find((c) => c.name.toLowerCase().includes(n));
    };
    let chosen: BgmPickCandidate | undefined;
    if (r.args.track) {
      chosen = pick(r.args.track);
      if (!chosen) {
        return {result: {ok: false, errors: [`曲库里没有匹配「${r.args.track}」的曲目（部分匹配，区分大小写不敏感）`], library: rankMusicForMood(candidates).slice(0, 20)}};
      }
    } else if (wantMood || wantEnergy) {
      const ranked = rankMusicForMood(candidates, wantMood, wantEnergy);
      // rankMusicForMood 只重排同一批对象（generic MusicCandidate[] 返回），credit 随对象走
      chosen = ranked[0] as BgmPickCandidate;
    } else if (r.args.volumeKeys && store.bgm) {
      // 只改现有 BGM 的音量包络（不换曲）：时间轴音量线的 AI 写路径
      const keys = r.args.volumeKeys.length > 0
        ? normalizeBgmVolumeKeys(r.args.volumeKeys, 3600) // 上界只做护栏：越片尾的点采样不到，无害
        : undefined;
      store.runTimelineCommand({kind: 'bgm', patch: keys ? {volumeKeys: keys} : {volumeKeys: undefined}});
      return {result: {ok: true, message: keys
        ? `已设置 BGM「${store.bgm.name}」音量包络（${keys.length} 个关键点，线性过渡）。${r.args.volumeKeysNotes?.join('；') ?? ''}`
        : '已清除 BGM 音量包络（恢复恒定音量）'}};
    } else if (r.args.volumeKeys) {
      return {result: {ok: false, errors: ['尚未添加背景音乐，volumeKeys 需要现有 BGM（先传 track 选曲，或让用户在「声音」面板添加）']}};
    } else {
      // 既没 track 也没 want*：返回曲库清单
      return {result: {
        ok: true,
        library: rankMusicForMood(candidates).slice(0, 20).map((c) => ({
          name: c.name, durationSec: c.durationSec ? Math.round(c.durationSec) : 0,
          mood: c.mood, moodLabel: MOOD_LABELS[c.mood], energy: c.energy,
        })),
        currentBgm: store.bgm?.name || null,
        message: `曲库共 ${candidates.length} 首（内置配乐 + 本地曲库；情绪/能量自动推导）。用 track 选曲（部分匹配）或 wantMood/wantEnergy 自动挑；track="none" 清除`,
      }};
    }
    // 设置 BGM
    try {
      const httpUrl = await window.api.getVideoHttpUrl(chosen!.path);
      // 取完整分析（磁盘缓存命中，开销极小）：波形 + 节拍网格都要带上——
      // 后续 align_beats 卡点、节拍脉冲、节拍音效全依赖这里写入的 beats/bpm
      const analysis = await window.api.analyzeMusic(chosen!.path).catch(() => null);
      const duration = chosen!.durationSec || analysis?.duration || 0;
      store.setBgm({
        name: chosen!.name,
        src: httpUrl,
        path: chosen!.path,
        duration,
        volume: r.args.volume ?? 0.35,
        fadeIn: 0.5,
        fadeOut: 1.5,
        peaks: analysis?.peaks,
        beats: analysis?.beats,
        bpm: analysis?.bpm,
        // 内置 CC BY 曲带署名数据（渲染端片尾自动烧录，不可关）
        ...(chosen!.credit ? {credit: chosen!.credit} : {}),
        ...(r.args.volumeKeys && r.args.volumeKeys.length > 0
          ? {volumeKeys: normalizeBgmVolumeKeys(r.args.volumeKeys, 3600)!}
          : {}),
      });
      const bpmNote = analysis?.bpm ? `，≈${Math.round(analysis.bpm)} BPM` : '';
      const envNote = r.args.volumeKeys && r.args.volumeKeys.length > 0 ? '，音量包络已随曲写入' : '';
      const creditNote = chosen!.credit ? '，CC BY 4.0 内置曲（成片片尾自动附署名）' : '';
      return {result: {ok: true, track: chosen!.name, duration, mood: chosen!.mood, energy: chosen!.energy,
        bpm: analysis?.bpm || undefined,
        message: `已设置 BGM「${chosen!.name}」（${Math.round(duration)}s${bpmNote}，情绪 ${MOOD_LABELS[chosen!.mood]}，能量 ${chosen!.energy}${envNote}${creditNote}）。随后用 align_beats 把切点吸附到节拍上；可用 set_bgm_ducking 开启旁白避让`}};
    } catch (err) {
      return {result: {ok: false, errors: [`BGM 设置失败：${stripIpcPrefix(err)}`]}};
    }
  },

  analyze_render_audio: async (args, ctx) => {
    const r = validateAnalyzeAudioArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    const videoPath = r.args.path || store.renderOutputPath;
    if (!videoPath) {
      return {result: {ok: false, errors: ['暂无可分析的成片：请先渲染（request_render / 渲染面板），或传 path 指定已注册的成片路径']}};
    }
    // 纯本地 ffmpeg 探测
    let report: AudioReviewReport;
    try {
      report = await window.api.analyzeRenderAudio(videoPath);
    } catch (err) {
      return {result: {ok: false, errors: [`音频探测失败：${stripIpcPrefix(err)}`]}};
    }
    // ASR 转写比对（可选；需配置 ASR 且用户确认——转写内容发往第三方端点）
    if (r.args.checkTranscript !== false) {
      const narrationTexts = store.segments.map((s) => s.narration?.text?.trim()).filter(Boolean) as string[];
      if (narrationTexts.length > 0) {
        try {
          const asrStatus = await window.api.asrGetStatus();
          if (asrStatus?.configured) {
            if (await ctx.requestConfirm('AI 请求转写成片音频', '将把成片音频发往你配置的 ASR 服务做旁白比对')) {
              const lines = await window.api.asrTranscribe({path: videoPath, segmentDuration: report.durationSec});
              const transcript = lines.map((l) => l.text).join('');
              const script = narrationTexts.join(' ');
              report = {
                ...report,
                asr: {
                  transcript: transcript.slice(0, 500),
                  similarity: Math.round(textSimilarity(script, transcript) * 100) / 100,
                  missingKeywords: missingKeywords(script, transcript),
                },
              };
            }
          }
        } catch (err) {
          report = {...report, asr: undefined};
          // ASR 失败不阻断体检本身，在 note 里带一句
          report.problemSilences = report.problemSilences;
          return {result: {ok: true, ...report, issues: audioReviewIssues(report),
            note: `音频体检完成（ASR 比对失败已跳过：${stripIpcPrefix(err)}）`}};
        }
      }
    }
    const issues = audioReviewIssues(report);
    return {result: {
      ok: true,
      ...report,
      issues,
      message: issues.length === 0
        ? '音频体检通过：响度达标、无爆音、无异常静音' + (report.asr ? `，旁白与文案相似度 ${(report.asr.similarity * 100).toFixed(0)}%` : '')
        : `发现 ${issues.length} 个音频问题（见 issues，按提示修复后重渲）`,
    }};
  },

  run_auto_pipeline: async (args, ctx) => {
    const r = validateRunPipelineArgs(args);
    if (!r.ok) return {result: r};
    const store = ctx.getStore();
    // plan_only：只出成片计划（一次 LLM 调用），不执行、不改工程，无需整条流水线的额度确认
    if (r.args.planOnly) {
      return planAutoPipeline(r.args);
    }
    if (store.autoPipeline?.status === 'running') {
      return {result: {ok: false, errors: ['全自动流水线已在运行中（get_app_status 查看进度），请等它完成后再启动新的']}};
    }
    if (store.isRendering) {
      return {result: {ok: false, errors: ['当前正在渲染，请等渲染结束再启动全自动流水线']}};
    }
    // 一键确认：流水线会渲染 + 调 LLM/TTS/生图（烧额度），必须用户点头
    const genreLabel = VIDEO_TYPE_LABEL[store.videoType];
    if (!(await ctx.requestConfirm('AI 请求启动全自动流水线',
      `将按「${genreLabel}」体裁执行：写脚本建故事板 → 配素材${store.videoType === 'vlog' ? ' → 长素材挖高光' : ''} → 旁白/BGM → 渲染 → 审片${r.args.reviewRounds === 0 ? '' : ' → 自动改稿重渲'} → 封面 + 发布元数据。会消耗你的 AI 服务额度与渲染时间。需求：「${r.args.brief.slice(0, 60)}${r.args.brief.length > 60 ? '…' : ''}」`))) {
      return {result: {ok: false, errors: ['用户拒绝了全自动流水线']}};
    }
    return startAutoPipeline(r.args, ctx);
  },

  computer_run_task: async (args, ctx) => {
    const r = validateComputerRunTaskArgs(args);
    if (!r.ok) return {result: r};
    // 操控整机键鼠 + 屏幕截图持续发往 AI 端点（隐私/安全双重敏感），必须本人确认
    if (!(await ctx.requestConfirm('AI 请求操作电脑',
      `将启动内置 computer-use 引擎执行任务：「${r.args.task.slice(0, 80)}${r.args.task.length > 80 ? '…' : ''}」（最多 ${r.args.maxSteps} 步）。它会实时截取屏幕画面发往你配置的 AI 端点做看图决策，并直接操控本机鼠标键盘${r.args.filmMode ? '（拍片模式：拟人鼠标轨迹）' : ''}。执行期间请勿同时操作鼠标；随时可让它调 computer_stop 停止`))) {
      return {result: {ok: false, errors: ['用户拒绝了电脑操作任务']}};
    }
    try {
      const res = await window.api.computerRunTask({task: r.args.task, maxSteps: r.args.maxSteps, filmMode: r.args.filmMode});
      return {result: {
        ok: true,
        taskId: res.taskId,
        message: `电脑任务已启动（taskId: ${res.taskId}），正在后台异步执行（截屏→决策→操控鼠标键盘循环）。用 computer_status(taskId: "${res.taskId}") 轮询进度直到 done/error；要中途停止用 computer_stop。已提醒用户执行期间不要同时操作鼠标。`,
      }};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  computer_status: async (args, _ctx) => {
    const r = validateComputerTaskIdArg(args);
    if (!r.ok) return {result: r};
    try {
      const s = await window.api.computerTaskStatus(r.taskId);
      return {result: {
        ok: true,
        taskId: s.taskId,
        status: s.status,
        success: s.success,
        result: s.result,
        ...(s.status === 'running'
          ? {message: '任务仍在执行中，稍后再用本工具轮询（每次轮询间隔几秒，不要连续猛查）'}
          : s.status === 'done'
            ? {message: `任务已结束：${s.success ? '成功' : '未达成目标'}（结果见 result 字段）`}
            : {message: `任务出错（结果见 result 字段）`}),
      }};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  computer_stop: async (args, _ctx) => {
    const r = validateComputerTaskIdArg(args);
    if (!r.ok) return {result: r};
    try {
      const res = await window.api.computerStopTask(r.taskId);
      return {result: {
        ok: true,
        stopping: res.stopping,
        message: res.stopping
          ? '已请求停止：当前动作完成后任务即停下（协作式停止），鼠标键盘控制权立即归还用户'
          : '任务已不在运行中（可能已结束），无需停止',
      }};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },

  computer_play_script: async (args, ctx) => {
    const r = validateComputerPlayScriptArgs(args);
    if (!r.ok) return {result: r};
    // 真实移动鼠标键盘重放动作脚本，需本人确认
    if (!(await ctx.requestConfirm('AI 请求回放动作脚本',
      `将确定性回放动作脚本「${r.args.scriptPath}」——逐动作真实操控本机鼠标键盘${r.args.filmMode ? '（拍片模式：拟人鼠标轨迹）' : ''}${r.args.verify ? '，并逐步做画面校验' : ''}。执行期间请勿同时操作鼠标`))) {
      return {result: {ok: false, errors: ['用户拒绝了脚本回放']}};
    }
    try {
      const res = await window.api.computerPlayScript({scriptPath: r.args.scriptPath, verify: r.args.verify, filmMode: r.args.filmMode});
      return {result: {
        ok: true,
        taskId: res.taskId,
        message: `脚本回放已启动（taskId: ${res.taskId}），正在后台异步执行。用 computer_status(taskId: "${res.taskId}") 轮询进度与逐步校验结果；要中途停止用 computer_stop。`,
      }};
    } catch (err) {
      return {result: {ok: false, errors: [stripIpcPrefix(err)]}};
    }
  },
};

/**
 * 工具本地执行：解析参数 JSON → 查表分发（原 executeTool 的入口部分）。
 * 坏 JSON / 未知工具返回友好错误，与原 switch 的入口/default 分支一致。
 */
export const executeLlmTool = async (
  name: string,
  argsJson: string,
  ctx: ToolExecContext,
): Promise<ToolExecResult> => {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return {result: {ok: false, errors: ['工具参数不是合法 JSON']}};
  }
  const executor = TOOL_EXECUTORS[name];
  if (!executor) return {result: {ok: false, errors: [`未知工具：${name}`]}};
  // AI 事务标（基建②）：非只读工具打标，撤销历史条目可辨识 agent 来源+工具名；
  // 执行完没引起历史字段变化（校验失败/纯读副作用）则丢弃标记防串到下一串用户改动
  const readOnly = name.startsWith('get_') || name.startsWith('view_') || name.startsWith('search_') || name === 'scratch_pad';
  if (!readOnly) markAgentOp(name);
  try {
    return await executor(args, ctx);
  } finally {
    dropAgentOp();
  }
};
