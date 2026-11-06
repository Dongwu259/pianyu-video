/**
 * Zustand 全局状态管理 - 故事板模式
 *
 * 核心数据结构:
 * - segments: Segment[] - 故事板中的所有片段
 * - 每个片段包含自己的 templateId, videos, text
 */

import {create} from 'zustand';
import type {
  VideoClip,
  ClipViewport,
  GroundElement,
  PromoText,
  PromoStyle,
  TemplateLayout,
  Orientation,
  Segment,
  SegmentNarration,
  CaptionLine,
  CaptionStyle,
  FinePrintConfig,
  FloatingOverlay,
  LogoConfig,
  TextAnimPreset,
  SegmentExitStyle,
  TransitionType,
  TransitionParams,
  VideoEffect,
  BackgroundEffect,
  RenderOptions,
  BgmTrack,
  SfxConfig,
  SfxKind,
  SfxClip,
  TexturePreset,
  LicenseStatus,
  PublishKit,
  LastRenderInfo,
  PlanCaptionWindow,
  SegmentBeat,
} from '../../shared/types';
import {DEFAULT_RENDER_OPTIONS, DEFAULT_LAYOUT, DEFAULT_CAPTION_STYLE, DEFAULT_SFX_CONFIG, DEFAULT_TEXTURE_PRESET, DEFAULT_BEAT_PULSE, DEFAULT_CURSOR_ENABLED, DEFAULT_FINE_PRINT} from '../../shared/types';
import {clampSfxClipAtSec, clampSfxClipVolume} from '../../shared/sfx-plan';
import {DEFAULT_COVER, sanitizeCoverConfig} from '../../shared/cover-presets';
import {sanitizeTags} from '../../shared/publish';
import {DEFAULT_COLOR_GRADE, type ColorGrade} from '../../shared/color-grade';
import {normalizeBrandColor} from '../../shared/brand-color';
import {isFontMoodId, DEFAULT_FONT_MOOD_ID, type FontMoodId} from '../../shared/font-presets';
import {inferAutoVideoType} from '../../shared/live-action-guard';
import type {CustomTemplateDef} from '../../shared/custom-template';
import {migrateCustomDef} from '../../shared/custom-template';
import type {GeneratedTemplateDef} from '../../shared/generated-template';
import {sanitizeMediaTag} from '../../shared/media-tags';
import type {MediaTag} from '../../shared/media-tags';
import {sanitizeMediaIntelligence} from '../../shared/media-intelligence';
import type {MediaIntelligenceIndex} from '../../shared/media-intelligence';
import {sanitizeEditPlan} from '../../shared/edit-plan';
import type {EditPlan} from '../../shared/edit-plan';
import type {AutoPipelineState} from '../../shared/auto-pipeline';
import {PIPELINE_LOG_LIMIT} from '../../shared/auto-pipeline';
import type {TemplatePack} from '../../shared/template-pack';
import type {AppSettings} from '../../shared/settings';
import {DEFAULT_SETTINGS} from '../../shared/settings';
import {normalizeCuts, effectiveTrimmedDuration, splitCutsAt, timelineToMediaSec} from '../../shared/clipCuts';
import type {ClipCut} from '../../shared/clipCuts';
import {STAB_DEFAULTS, solveStabilization} from '../../shared/stabilization';
import type {StabCorrection} from '../../shared/stabilization';

/** setGroundTrack 的写入载荷：groundTrack 为 undefined = 移除地面追踪（连同内存态一起剥离） */
export interface GroundTrackPayload {
  groundTrack?: VideoClip['groundTrack'];
  /** 内存态锚点轨迹 {anchors, samples}（分析产出/加载重建；省略 = 保留旧值） */
  groundData?: VideoClip['groundData'];
}

/** setVideoStabilization 的写入载荷：stabilization 为 undefined = 移除稳定（连同内存态一起剥离） */
export interface VideoStabilizationPayload {
  stabilization: VideoClip['stabilization'] | undefined;
  stabCorrections?: StabCorrection[];
  stabZoom?: number;
  stabSampleFps?: number;
}

/** 施加裁剪 + 挖段并重算有效时长（cuts 未给 = 保留原挖段并按新 trim 区间重新钳制） */
const applyTrimAndCuts = (clip: VideoClip, trimStart: number, trimEnd: number, cuts?: ClipCut[]): VideoClip => {
  const ts = Math.max(0, Math.min(trimStart, clip.duration));
  const te = Math.max(ts, Math.min(trimEnd, clip.duration));
  const nextCuts = normalizeCuts(cuts !== undefined ? cuts : clip.cuts, ts, te);
  return {
    ...clip,
    trimStart: ts,
    trimEnd: te,
    cuts: nextCuts,
    trimmedDuration: effectiveTrimmedDuration(ts, te, nextCuts),
  };
};
import {getAspectRatioPreset, DEFAULT_ASPECT_RATIO_ID} from '../../shared/aspect-ratios';
import {detectBeats, snapDurationsToBeats, snapTransitionsToBeats} from '../../shared/beat-align';
import {bgmTimelineBeats} from '../../shared/bgm-track';
import {getTemplateById, GENRE_RECOMMENDED_IDS, mergeTemplateMetas} from '../../shared/template-registry';
import {allocatePoolRoundRobin, computePoolDeficits, countUnmetSegments} from '../../shared/pool-distribution';
import {generateDemoCursorClicks, generateDemoCursorTrack, parseCursorTrackScript, buildCursorTrack} from '../../shared/demo-cursor-track';
import {clipSrcToPath, pathToClipSrc} from '../utils/clipPath';
import type {ColorCurveId} from '../../shared/proxy-media.ts';
import type {MediaSourceKind} from '../../shared/types';
import type {HighlightCandidatesData} from '../../shared/highlight-heuristics';
import type {VideoType} from '../../shared/video-type';
import {DEFAULT_VIDEO_TYPE, isVideoType, SFX_ENABLED_BY_VIDEO_TYPE} from '../../shared/video-type';
import type {ProjectFileData} from '../../main/services/projectFile';
import type {HistorySnapshot, HistorySource} from './historyUtils';
import {HISTORY_LIMIT, deepClone, pushHistoryEntry, snapshotsEqual, runWithHistorySuppressed, isHistoryScopeActive, peekAgentOp, bumpCommandEpoch, beginSuppressedScope} from './historyUtils';
import {applyTimelineCommand, executeTimelineCommand, COMMAND_LABELS, shouldCoalesce, type TimelineCommand, type TimelineCommandStore} from './timeline-core';
import {solveCaptionText, solveCaptionWindow, solveMediaWindow} from '../../shared/plan-writeback';
import type {ValidatedSegmentPatch, ValidatedSegmentSpec} from '../../shared/llm-tools';

/** 默认工程名 */
export const DEFAULT_PROJECT_NAME = '未命名工程';

/** 最近工程条目（存于全局 electron-store，键 recentProjects） */
export interface RecentProject {
  path: string;
  name: string;
  savedAt: string;
}

/** 缺失媒体条目（segmentIndex === -1 表示背景音乐） */
export interface MissingMediaEntry {
  segmentIndex: number;
  videoIndex: number;
  path: string;
  name: string;
}

/** 重新链接时传入的新媒体信息 */
export interface RelinkMedia {
  src: string;        // 本地服务器 HTTP URL
  path: string;       // 原始文件路径
  name: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
}

// ====== 脏标记抑制 ======
// 加载 / 新建工程时整体 set 会改变 segments 等引用，属于「干净基线」，
// 不应被 App.tsx 的脏标记订阅置脏。action 内先调 suppressNextDirty() 再 set。
let suppressDirtyCount = 0;
export const suppressNextDirty = (): void => {
  suppressDirtyCount++;
};
/** App.tsx 订阅回调内消费一次抑制标记，返回 true 表示本次变化应跳过置脏 */
export const consumeSuppressDirty = (): boolean => {
  if (suppressDirtyCount > 0) {
    suppressDirtyCount--;
    return true;
  }
  return false;
};

// ====== 历史快照抑制 ======
// undo/redo/加载/新建工程时整体 set 会改变 segments 等引用，属于「历史栈自身的重放」，
// 不应被 App.tsx 的快照采集订阅录成新历史。action 内先调 suppressNextHistory() 再 set。
// 与脏标记抑制相互独立：undo/redo 照常置脏（属于内容变化），只是不入历史。
let suppressHistoryCount = 0;
export const suppressNextHistory = (): void => {
  suppressHistoryCount++;
};
/** App.tsx 快照订阅回调内消费一次抑制标记，返回 true 表示本次变化应跳过录制 */
export const consumeSuppressHistory = (): boolean => {
  if (suppressHistoryCount > 0) {
    suppressHistoryCount--;
    return true;
  }
  // 命令作用域（M1.5）：scope 内全部变化由命令事务自管入史，采集器整段让位（不按次消费）
  return isHistoryScopeActive();
};

/** 从给定状态采集历史快照（深拷贝，防止后续编辑串改已入栈的快照） */
export const takeSnapshot = (s: {
  segments: Segment[];
  activeSegmentIndex: number;
  templateId: string | null;
  videos: VideoClip[];
  text: PromoText;
  style: PromoStyle;
  layout: TemplateLayout;
  customParams: Record<string, number>;
  bgm: BgmTrack | null;
  sfx: SfxConfig;
  texture: TexturePreset;
  beatPulse: boolean;
  cursor: boolean;
  logo: LogoConfig | null;
  captionStyle: CaptionStyle;
  finePrint: FinePrintConfig;
  colorGrade: ColorGrade;
  brandColor: string | null;
  fontMood: FontMoodId;
  aspectRatioId: string;
  orientation: Orientation;
  publish: PublishKit;
}): HistorySnapshot =>
  deepClone({
    segments: s.segments,
    activeSegmentIndex: s.activeSegmentIndex,
    templateId: s.templateId,
    videos: s.videos,
    text: s.text,
    style: s.style,
    layout: s.layout,
    customParams: s.customParams,
    bgm: s.bgm,
    sfx: s.sfx,
    texture: s.texture,
    beatPulse: s.beatPulse,
    cursor: s.cursor,
    logo: s.logo,
    captionStyle: s.captionStyle,
    finePrint: s.finePrint,
    colorGrade: s.colorGrade,
    brandColor: s.brandColor,
    fontMood: s.fontMood,
    aspectRatioId: s.aspectRatioId,
    orientation: s.orientation,
    publish: s.publish,
  });

/** 最近工程列表在 electron-store 中的键 */
const RECENT_PROJECTS_KEY = 'recentProjects';

/** 读取最近工程列表 */
export const getRecentProjects = async (): Promise<RecentProject[]> => {
  try {
    return ((await window.api.getStore(RECENT_PROJECTS_KEY)) as RecentProject[]) || [];
  } catch {
    return [];
  }
};

/** 将一条工程记录加入最近工程列表（去重、最新在前、最多 10 条） */
const pushRecentProject = async (path: string, name: string): Promise<void> => {
  try {
    const list = await getRecentProjects();
    const next = [
      {path, name, savedAt: new Date().toISOString()},
      ...list.filter((r) => r.path !== path),
    ].slice(0, 10);
    await window.api.setStore(RECENT_PROJECTS_KEY, next);
  } catch {
    // 最近列表写失败不影响主流程
  }
};

/** 从最近工程列表移除（打开失败时调用） */
export const removeRecentProject = async (path: string): Promise<void> => {
  try {
    const list = await getRecentProjects();
    await window.api.setStore(RECENT_PROJECTS_KEY, list.filter((r) => r.path !== path));
  } catch {
    // 忽略
  }
};

/** 生成唯一 ID */
const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 手动保存 / 新建 / 打开工程成功后丢弃旧的自动保存文件（内容已落后，避免下次启动误提示恢复） */
const clearAutosaveFile = (): void => {
  window.api.clearAutosave().catch(() => {
    // 清除失败不影响主流程
  });
};

/** 空样式（全部 undefined = 使用模板默认） */
export const createEmptyStyle = (): PromoStyle => ({});

/** 默认发布准备配置（封面默认值 + 空元数据；打开旧工程无此字段时回退） */
export const createDefaultPublishKit = (): PublishKit => ({
  cover: {...DEFAULT_COVER},
  metadata: {title: '', description: '', tags: []},
});

/**
 * 建段时的布局：DEFAULT_LAYOUT（竖版画幅换竖版默认构图）叠加模板注册的
 * defaultLayout 覆盖（如全屏画幅模板）。
 * 竖版默认画框 0.86W×0.42H：横版默认 0.6W×0.5H 在 9:16 下是窄高框，
 * 16:9 素材 contain 后显示过小；竖版给宽扁框让素材占满可用宽度。
 */
export const layoutForTemplate = (templateId: string, orientation?: Orientation): TemplateLayout => ({
  ...DEFAULT_LAYOUT,
  ...(orientation === 'portrait' ? {videoWidthRatio: 0.86, videoHeightRatio: 0.42} : {}),
  ...(getTemplateById(templateId)?.defaultLayout ?? {}),
});

/** 创建空片段的工厂函数 */
export const createEmptySegment = (templateId: string = 'RevealSlide', orientation?: Orientation): Segment => ({
  id: genId(),
  templateId,
  videos: [],
  text: {title: '', subtitle: '', features: [], brandName: ''},
  style: createEmptyStyle(),
  layout: layoutForTemplate(templateId, orientation),
  duration: 8,
  transition: 'crossfade',
  videoEffect: 'none',
  backgroundEffect: 'none',
});

/**
 * 新增片段的默认模板：跟随体裁推荐（当前体裁策展列表里第一款「故事板还没用过」的模板；
 * 全用过则轮转回第一款）。替代旧的硬编码 RevealSlide——用户选了「卡点混剪」，
 * 新加的段就该是卡点向模板，而不是每段都手动开选择器重选。
 */
const nextSegmentTemplateId = (s: {videoType: VideoType; segments: Segment[]}): string => {
  const list = GENRE_RECOMMENDED_IDS[s.videoType] ?? [];
  if (list.length === 0) return 'RevealSlide';
  const used = new Set(s.segments.map((seg) => seg.templateId));
  return list.find((id) => !used.has(id)) ?? list[0];
};

interface ProjectState {
  // ====== 导航 ======
  step: 1 | 2 | 3 | 4;
  setStep: (step: 1 | 2 | 3 | 4) => void;

  // ====== 故事板核心 ======
  segments: Segment[];
  activeSegmentIndex: number;
  orientation: Orientation;
  /** 画布比例预设 id（'16-9'/'9-16'/'1-1'/'4-5'/'4-3'/'21-9'） */
  aspectRatioId: string;
  /** 视频体裁（AI 剧本/模板推荐口径；随工程持久化，缺省 promo） */
  videoType: VideoType;
  /** 体裁由谁设定（P0-1 采痕卫生）：user 手动选 / agent 工具设定 / auto 首次导入自动路由；
   *  undefined = 新工程从未设定（唯一允许自动路由的状态）。旧工程加载时补 'user'，永不自动路由 */
  videoTypeSource?: 'user' | 'agent' | 'auto';
  setVideoType: (t: VideoType, source?: 'user' | 'agent' | 'auto') => void;
  /** 首次导入素材时的体裁自动路由（P0-1）：仅从未设定过体裁的新工程触发一次，实拍占多数 → vlog。
   *  返回路由到的体裁（未触发返回 null），调用方负责可见提示（不静默改） */
  maybeAutoRouteVideoType: () => VideoType | null;

  // ====== 当前片段编辑器中的工作副本 ======
  templateId: string | null;
  videos: VideoClip[];
  text: PromoText;
  style: PromoStyle;
  layout: TemplateLayout;
  /** 当前片段的模板个性化参数工作副本（键见当前模板 paramSpecs） */
  customParams: Record<string, number>;

  // ====== 输出配置 ======
  renderSettings: RenderOptions;
  setRenderSettings: (s: Partial<RenderOptions>) => void;

  // ====== 全局设置 ======
  appSettings: AppSettings;
  setAppSettings: (s: Partial<AppSettings>) => void;

  // ====== 授权 / 订阅 ======
  /** 授权状态（null = 尚未加载） */
  licenseStatus: LicenseStatus | null;
  /** 从主进程拉取最新授权状态（启动时与激活/解绑后调用） */
  refreshLicenseStatus: () => Promise<void>;

  // ====== 自定义模板 ======
  customTemplates: CustomTemplateDef[];
  setCustomTemplates: (t: CustomTemplateDef[]) => void;
  loadCustomTemplates: () => Promise<void>;
  upsertCustomTemplate: (def: CustomTemplateDef) => Promise<void>;
  removeCustomTemplate: (id: string) => Promise<void>;
  getCustomTemplateDef: (id: string) => CustomTemplateDef | undefined;

  // ====== 市场模板（已安装的云端模板包） ======
  marketTemplates: TemplatePack[];
  setMarketTemplates: (t: TemplatePack[]) => void;
  /** 从主进程拉取已安装的市场模板（启动时与安装/卸载后调用） */
  loadMarketTemplates: () => Promise<void>;
  /** 按 id 取市场模板的 def（供渲染链路并入 customTemplates 使用） */
  getMarketTemplateDef: (id: string) => CustomTemplateDef | undefined;

  // ====== AI 生成模板（三期 D2，应用级持久化） ======
  generatedTemplates: GeneratedTemplateDef[];
  setGeneratedTemplates: (t: GeneratedTemplateDef[]) => void;
  /** 从主进程拉取 AI 生成模板（启动时与生成/删除后调用） */
  loadGeneratedTemplates: () => Promise<void>;
  getGeneratedTemplateDef: (id: string) => GeneratedTemplateDef | undefined;

  // ====== 背景音乐 ======
  bgm: BgmTrack | null;
  setBgm: (b: BgmTrack | null) => void;
  updateBgm: (partial: Partial<BgmTrack>) => void;
  /** 卡点对齐：把各片段边界吸附到 BGM 节拍上；无 BGM/无节拍返回 null。tolerance = 吸附容差（秒） */
  alignSegmentsToBeats: (opts?: {tolerance?: number}) => {movedCount: number; transitionMovedCount: number; beatCount: number; bpm?: number} | null;
  /** B4 音乐结构重排落地：批量写段时长与转场类型（align_music_structure 工具产出计划后一次写回） */
  applyMusicStructurePlan: (durations: number[], transitions: TransitionType[]) => void;

  // ====== 音效（SFX，项目级）======
  sfx: SfxConfig;
  /** 用户是否手动改过音效（true 后体裁切换不再自动覆盖音效开关；不随工程序列化） */
  sfxTouched: boolean;
  /** 合并更新音效配置（开关/音量/各放置开关）；任何手动更新都会置 sfxTouched */
  setSfx: (partial: Partial<SfxConfig>) => void;
  /** 在全片时间轴位置加一个手放音效片段（时间轴「+ 音效」；返回新 clip id） */
  addSfxClip: (kind: SfxKind, atSec: number) => string;
  /** 改手放音效片段（类别/位置/音量；位置按片长钳制） */
  updateSfxClip: (id: string, patch: Partial<Pick<SfxClip, 'kind' | 'atSec' | 'volume'>>) => void;
  /** 删手放音效片段 */
  removeSfxClip: (id: string) => void;

  // ====== 画面质感（项目级）======
  texture: TexturePreset;
  /** 设置质感预设（干净/胶片/电影） */
  setTexture: (t: TexturePreset) => void;

  // ====== 节拍脉冲（项目级；有 BGM 且检出节拍时生效）======
  beatPulse: boolean;
  /** 开关节拍脉冲（鼓点微缩放 + 光效闪动） */
  setBeatPulse: (on: boolean) => void;
  /** 工程看图预算（view_media_frames 附图总量上限；0=不限；随工程保存） */
  frameBudget: number;
  setProjectFrameBudget: (n: number) => void;
  /** 工程看图预算已用量（会话态，不持久化——加载工程清零重新记） */
  frameBudgetUsed: number;
  /** 记一笔看图消耗（返回记账后的剩余量；超支返回 0 且 note 提示） */
  chargeFrameBudget: (frames: number) => {used: number; total: number; remaining: number; exceeded: boolean};
  /** 素材场景清单落库（scan_media 分析结果；随工程保存，重复分析零成本跳过） */
  setSegmentVideoShots: (segmentIndex: number, videoIndex: number, shots: Array<{startSec: number; endSec: number; motionScore: number}> | undefined) => void;
  /** 高光精选面板数据（mine_highlights 启发式预筛结果；会话态不持久化——缩略图 dataUrl 大） */
  highlightCandidates: {segmentIndex: number; videoIndex: number; data: HighlightCandidatesData} | null;
  setHighlightCandidates: (segmentIndex: number, videoIndex: number, data: HighlightCandidatesData) => void;
  clearHighlightCandidates: () => void;
  /** 精选面板确认：选中区间一键落地挖段（单选=裁剪 trim；多选=keepRanges 挖洞 cuts） */
  applyHighlightPick: (segmentIndex: number, videoIndex: number, ranges: Array<{startSec: number; endSec: number}>) => boolean;

  // ====== 美化光标（项目级；素材带录屏轨迹时生效）======
  cursor: boolean;
  /** 开关美化光标（平滑轨迹光标 + 光晕） */
  setCursor: (on: boolean) => void;

  // ====== 品牌 Logo / 字幕 / BGM 避让（项目级）======
  logo: LogoConfig | null;
  /** 设置/替换 Logo（含 src/path/name）；传 null 移除 */
  setLogo: (logo: LogoConfig | null) => void;
  /** 合并更新 Logo 部分字段（位置/大小/透明度/显隐） */
  updateLogo: (partial: Partial<LogoConfig>) => void;
  /** 字幕样式（项目级） */
  captionStyle: CaptionStyle;
  setCaptionStyle: (style: Partial<CaptionStyle>) => void;
  /** 边缘小字/免责声明（项目级；text 空串 = 不显示） */
  finePrint: FinePrintConfig;
  setFinePrint: (partial: Partial<FinePrintConfig>) => void;
  /** 色彩统一（项目级）：色调预设 + 自动曝光匹配 */
  colorGrade: ColorGrade;
  setColorGrade: (partial: Partial<ColorGrade>) => void;
  /** 品牌色（项目级，#rrggbb；null = 默认蓝）。模板强调色/渐变/光晕全链路取此色 */
  brandColor: string | null;
  /** 设置品牌色（非法输入忽略；null = 恢复默认蓝） */
  setBrandColor: (color: string | null) => void;
  /** 字体氛围预设（项目级；缺省 sleek）。标题/正文/等宽字体栈随之切换 */
  fontMood: FontMoodId;
  setFontMood: (mood: FontMoodId) => void;
  /** 发布准备（项目级）：封面配置 + 发布元数据，随工程文件保存 */
  publish: PublishKit;
  /** 合并更新发布元数据（标题/简介/标签） */
  setPublishMetadata: (partial: Partial<PublishKit['metadata']>) => void;
  /** 合并更新封面配置（版式/文字/选帧时刻等） */
  setCoverConfig: (partial: Partial<PublishKit['cover']>) => void;
  /** 素材视觉打标（key = 素材 src；analyze_media_tags 产出，get_project_info 透出） */
  mediaTags: Record<string, MediaTag>;
  /** 批量写入素材打标（浅合并） */
  setMediaTags: (tags: Record<string, MediaTag>) => void;
  /** 统一素材智能索引（镜头/动作/ASR/OCR/质量等，可选分析产物） */
  mediaIntelligence: MediaIntelligenceIndex | null;
  setMediaIntelligence: (index: MediaIntelligenceIndex | null) => void;
  editPlan: EditPlan | null;
  setEditPlan: (plan: EditPlan | null) => void;
  /** 全自动流水线进度（瞬态运行时状态，不进工程文件/历史快照；get_app_status 透出） */
  autoPipeline: AutoPipelineState | null;
  /** 流水线 runner 专用：整体写入进度状态（含 log 截尾） */
  setAutoPipeline: (state: AutoPipelineState | null) => void;
  /** 设置 BGM 自动避让旁白（无 BGM 时忽略）；amount 0.1~1 */
  setBgmDucking: (enabled: boolean, amount: number) => void;
  /** 设置某段的字幕行（传 undefined/[] 清除） */
  setSegmentCaptions: (index: number, captions: CaptionLine[] | undefined) => void;
  /** 设置/替换某段的悬浮图片层（传 null 移除） */
  setSegmentOverlay: (index: number, overlay: FloatingOverlay | null) => void;
  /** 清除某段的字幕 */
  clearSegmentCaptions: (index: number) => void;

  // ====== 渲染状态 ======
  isRendering: boolean;
  renderProgress: number;
  renderOutputPath: string;
  startRendering: () => void;
  setProgress: (p: number) => void;
  finishRendering: (outputPath: string) => void;
  resetRendering: () => void;
  /** 最近一次渲染的结果回读（内存态，不持久化）：确认「成片对应哪版内容」，见 shared/content-fingerprint.ts */
  lastRenderInfo: LastRenderInfo | null;
  setLastRenderInfo: (info: LastRenderInfo | null) => void;

  // ====== 工程文件 ======
  /** 工程名（显示在头部菜单旁） */
  projectName: string;
  /** 当前工程文件路径（null = 尚未保存过） */
  projectFilePath: string | null;
  /** 当前工程是否是内置示例工程（故事板顶部「一键换成你的素材」提示条用；替换素材/换工程后清除） */
  isSampleProject: boolean;
  /** 是否有未保存的更改 */
  isDirty: boolean;
  /** 打开工程后检测到的缺失媒体清单（供 MissingMediaDialog 展示） */
  missingMedia: MissingMediaEntry[];
  /** 将当前状态序列化为工程文件 data（clip.src 还原为原始路径，bgm 去掉 src） */
  /** 序列化工程为可持久化数据。opts.includeHistory = 基建④：把撤销栈降级带上（仅显式保存调用方传 true；
   *  自动保存不带——用户拍板 2026-10-12；appSettings.persistUndoHistory 关时此处仍不带，双闸可回退）。 */
  serializeProject: (opts?: {includeHistory?: boolean}) => ProjectFileData;
  /** 把打开的工程数据应用到 store（重建 clip/bgm 的 src）。filePath 传 null 表示来自自动保存恢复（尚未关联磁盘文件） */
  applyLoadedProject: (name: string, data: ProjectFileData, filePath: string | null, missingPaths: string[]) => Promise<void>;
  /** 保存（无路径时自动走另存为）。返回是否保存成功 */
  saveProject: () => Promise<boolean>;
  /** 保存到指定 .vtproj 路径（无对话框；MCP save_project 用）。path 缺省 = 当前工程文件。成功后设为当前工程文件 */
  saveProjectToPath: (path?: string) => Promise<{ok: boolean; path?: string; name?: string; error?: string}>;
  /** 按路径加载工程（无对话框、无确认——调用方负责确认；MCP load_project 用）。成功后设为当前工程文件 */
  loadProjectPath: (path: string) => Promise<{ok: boolean; name?: string; segments?: number; missingMedia?: string[]; error?: string}>;
  /** 素材路径重映射（consolidate_project 用）：按 map（旧路径 → 新路径）重写工程内全部媒体引用，
   *  clip/overlay/bgm/logo/import 旁白 的 src 会话 URL 同步重建，mediaTags 键同步换；返回重写的引用数 */
  remapMediaPaths: (map: Record<string, string>) => Promise<number>;
  /** 另存为（总是弹保存对话框）。返回是否保存成功 */
  saveProjectAs: () => Promise<boolean>;
  /** 打开工程（弹对话框，含未保存确认）。返回是否成功打开 */
  openProject: () => Promise<boolean>;
  /** 按路径打开工程（最近工程用，含未保存确认；失败时自动移出最近列表） */
  openProjectPath: (filePath: string) => Promise<boolean>;
  /** 打开内置示例工程（含未保存确认）。返回是否成功打开 */
  openSampleProject: () => Promise<boolean>;
  /** 新建工程（含未保存确认，重置为初始空故事板） */
  newProject: () => void;
  /** 重新链接缺失媒体：保留原 clip 的 trim/viewport/fit，替换 src/name/宽高/时长/缩略图 */
  relinkMissingMedia: (entry: MissingMediaEntry, media: RelinkMedia) => void;
  /** 示例工程一键换素材：用户素材按顺序替换进各段（每段一条，素材不足时循环复用；纯文字段跳过）。
   *  返回替换的段数；有替换即清除 isSampleProject 标记。可 Ctrl+Z 撤销 */
  replaceSampleMedia: (clips: VideoClip[]) => number;

  // ====== 项目素材库（全局素材池）======
  /** 导入一次、全工程复用的素材池：自动配段 / 手动加段 / AI 流水线素材分配共享此源；随工程文件持久化 */
  mediaPool: VideoClip[];
  addToMediaPool: (clips: VideoClip[]) => void;
  removeFromMediaPool: (id: string) => void;
  /** 自动配段：库内素材按「缺素材的片段优先」轮流分配（不循环复用；纯文字段与已满足 minVideos 的段不动）。
   *  返回 {assigned, unmet}：assigned=分配条数，unmet=仍缺素材的片段数（素材不够时 >0） */
  distributeMediaPool: () => {assigned: number; unmet: number};
  /** 关闭缺失媒体提示（跳过剩余缺失项） */
  dismissMissingMedia: () => void;

  // ====== 撤销 / 重做 ======
  /** 撤销栈（最旧在前，栈顶是最近一次「改动前」快照） */
  historyPast: HistorySnapshot[];
  /** 重做栈（undo 时压入，任何新改动都会清空） */
  historyFuture: HistorySnapshot[];
  /** 将一条「改动前」快照压入撤销栈（cap 50，并清空重做栈）。由 App.tsx 的防抖订阅调用 */
  pushHistory: (snapshot: HistorySnapshot) => void;
  /**
   * 工程核命令层（M1.5 切片一，timeline-core）：时间线写动作唯一命令入口——
   * 一条命令 = 一条事务 = 一步撤销（before 快照 + 来源标 + 操作名即时入史）。
   * source 缺省时：AI 标记窥视（executeLlmTool 已打标）→ 兜底 user+命令人话名。
   * 返回 false = 命令无变化/显式失败（不入史）。
   */
  runTimelineCommand: (cmd: TimelineCommand, opts?: {source?: HistorySource; opName?: string; coalesceKey?: string}) => boolean;
  /**
   * 拖拽事务括号（M1.5 切片二，「ghost 释放提交」的最小实现）：pointerdown 开括号
   * （before 快照 + 作用域抑制——拖拽中的逐帧直写不进防抖历史、块照常实时渲染），
   * pointerup 收括号（内容有变 = 一笔事务入史，undo 一步撤回整次拖拽）。
   * 返回的收口函数幂等（重复调/悬挂被新括号自愈后调都安全）。
   * opName 缺省 = '拖拽编辑'；AI 驱动的拖拽（少见）走 peekAgentOp。
   */
  beginDragTransaction: (opName?: string) => () => boolean;
  /** 撤销：恢复撤销栈栈顶快照，当前状态压入重做栈 */
  undo: () => void;
  /** 重做：恢复重做栈栈顶快照，当前状态压回撤销栈 */
  redo: () => void;

  // ====== Actions ======

  // 片段管理
  addSegment: (templateId?: string) => void;
  removeSegment: (index: number) => void;
  duplicateSegment: (index: number) => void;
  /** AI 用：把片段在 atSec 秒处拆成两段（单次 set = 一步撤销；段不存在/拆点非法返回 false） */
  splitSegment: (index: number, atSec: number) => boolean;
  reorderSegments: (fromIndex: number, toIndex: number) => void;
  /** 按全排列重排片段（agent 面时间线工具 reorder_segments 用；order 必须是 0..n-1 的排列，
   *  非法输入静默不动；活动段按 id 跟随；单次 set = 一步撤销） */
  applySegmentOrder: (order: number[]) => void;
  /** shot 级跨段搬移（move_shot 工具用）：把 fromSegment 段内 clipIndex 素材整体搬到
   *  toSegment 的 position 处（缺省 = 追加末尾；from === to = 段内重排）。clip 对象整体
   *  搬迁（trim/视口/音频设置保留）。非法输入返回 false 不动；涉及活动段时工作副本同步；
   *  单次 set = 一步撤销。 */
  moveVideoAcrossSegments: (fromSegment: number, clipIndex: number, toSegment: number, position?: number) => boolean;
  setActiveSegmentIndex: (index: number) => void;
  /** 时间轴视图直写（P2.5 阶段二）：按段下标合并写入时长/转场/转场参数/转场音效，
   *  不经工作副本（这些字段本就直存段上，与 setCurrentDuration 系列同语义）。
   *  仅 UI 层使用，不改 AI 工具面（19 工具 EDGE 面与 storyboard schema v5 代冻结）。
   *  transitionSfx 传 null = 清除回自动；transitionParams 为浅合并（undefined 值的键删除）。
   *  M1.5 切片三起为命令层薄壳：内部转发 runTimelineCommand({kind:'segmentTiming'})，
   *  默认带同段合并键（coalesceKey=segment-timing-{index}）——弹层逐键输入/曲线连续编辑
   *  在 1.2s 窗口内并入一笔事务；白名单手写体退役为 writeSegmentTiming 原始写。 */
  updateSegmentDirect: (
    index: number,
    patch: {
      duration?: number;
      transition?: TransitionType;
      transitionParams?: Partial<TransitionParams>;
      transitionSfx?: SfxKind | 'off' | null;
    },
  ) => void;
  /** 段时序原始写（updateSegmentDirect 薄壳化的前身，零历史语义）——命令分发自用 +
   *  拖拽括号内逐帧直写（beginDragTransaction 管事务，逐帧不能走命令=逐帧灌史） */
  writeSegmentTiming: (
    index: number,
    patch: {
      duration?: number;
      transition?: TransitionType;
      transitionParams?: Partial<TransitionParams>;
      transitionSfx?: SfxKind | 'off' | null;
    },
  ) => void;

  // ====== M2 回写环（timeline-master-plan §五 M2；命令层专用薄动作，slover 见 shared/plan-writeback） ======
  /** 排版字幕文字回写：captionIndex 按 plan 投影序；反解成功写 text/features（永不冻结）。
   *  反解失败返回 false 不动（原因由调用方用 shared solveCaptionText 预取展示）。 */
  applySegmentPlanText: (index: number, captionIndex: number, text: string) => boolean;
  /** 排版字幕窗回写（冻结兜底路径）：反解不了 → 段记 frozen（paramSnapshot + detachedFields）
   *  + 窗真值进 materialized 覆盖层，一次 set 原子生效。失败返回 false 不动。 */
  applySegmentPlanFreeze: (index: number, captionIndex: number, startSec: number, endSec: number) => boolean;
  /** 物化字幕窗原始写（零历史语义）：拖拽括号内逐帧直写唯一落点——段必须已冻结接管。 */
  writeSegmentCaptionWindows: (index: number, windows: PlanCaptionWindow[]) => void;
  /** 素材窗回写：mediaIn/mediaOut ↔ trim 同口径反解（cuts 原样保留）；失败 false 不动。 */
  applySegmentPlanMediaWindow: (index: number, videoIndex: number, mediaInSec: number, mediaOutSec: number) => boolean;
  /** M3 L2（v1.4）：手放节拍标记整组设置/清除（beats=undefined/空 = 清除）。防御性钳制：
   *  t 收 0.1 步进并钳 [0, 段时长)、按 t 排序去重；kind 白名单外回落 mark。 */
  setSegmentBeats: (index: number, beats: SegmentBeat[] | undefined) => void;
  /** M3 L2：节拍标记原始写（零历史语义）——拖拽括号内逐帧直写唯一落点 */
  writeSegmentBeats: (index: number, beats: SegmentBeat[]) => void;

  // 当前片段编辑器
  setCurrentTemplate: (id: string) => void;
  /** 首页选择「第一个片段的模板」：同时写工作副本与第 1 段（仅写工作副本会导致段落仍显示默认模板） */
  selectFirstTemplate: (id: string) => void;
  setCurrentVideos: (videos: VideoClip[]) => void;
  addVideosToCurrent: (videos: VideoClip[]) => void;
  removeVideoFromCurrent: (index: number) => void;
  updateVideoTrim: (index: number, trimStart: number, trimEnd: number, cuts?: ClipCut[]) => void;
  updateVideoViewport: (index: number, viewport: ClipViewport | undefined) => void;
  /** 更新当前片段某视频的音频（静音/音量）；图片忽略 */
  updateVideoAudio: (index: number, muted: boolean, volume: number) => void;
  /** 时间轴跨段静音：段素材与工作副本双写（时间轴视频块静音按钮 / AI patch 同款语义） */
  updateSegmentVideoAudio: (segmentIndex: number, videoIndex: number, muted: boolean) => void;
  /** 生成/清除当前片段某视频的演示鼠标轨迹（CursorFollow 无真实轨迹时预览用；
      seed 持久化到 cursorDemoSeed，保存工程后加载时按种子确定性重建；undefined = 清除） */
  updateVideoCursorDemo: (index: number, seed: number | undefined) => void;
  /** 声明式动作轨迹：script 空串清除；返回 warnings（非法令牌等）供调用方回告 */
  updateVideoCursorTrack: (index: number, script: string) => string[];
  /** AI 用：按段下标直接裁剪某段某视频（不经工作副本）；cuts 给出即整体替换挖段列表（[] 清空），省略 = 保留并按新区间钳制 */
  updateSegmentVideoTrim: (segmentIndex: number, videoIndex: number, trimStart: number, trimEnd: number, cuts?: ClipCut[]) => void;
  /** AI 用：按段下标直接设置某段某视频的取景视口（不经工作副本） */
  updateSegmentVideoViewport: (segmentIndex: number, videoIndex: number, viewport: ClipViewport | undefined) => void;
  /** 设置素材 Log 色彩曲线（手动改/AI set_media_colorspace；代理按新曲线重排，渲染前带 LUT 转码） */
  setSegmentVideoColorCurve: (segmentIndex: number, videoIndex: number, colorCurve: ColorCurveId | undefined) => void;
  /** 设置素材来源类型（实拍/录屏/图形；AI 模板选型信号，手动改） */
  setSegmentVideoSourceKind: (segmentIndex: number, videoIndex: number, sourceKind: MediaSourceKind | undefined) => void;
  /** 代理 job 事件回写（按源路径匹配全工程素材：proxyPath/proxyStatus） */
  applyClipProxyByPath: (sourcePath: string, proxyPath: string | undefined, status: 'queued' | 'transcoding' | 'ready' | 'failed') => number;
  /** AI/录屏用：把素材追加到指定片段（若是当前活动段则同步工作副本） */
  addVideosToSegment: (segmentIndex: number, videos: VideoClip[]) => void;
  /** AI 用：按段下标移除某段的一个素材（段本身保留；若是当前活动段则同步工作副本） */
  removeVideoFromSegment: (segmentIndex: number, videoIndex: number) => void;
  /** 写入/移除某素材的跟踪稳定（segmentIndex 缺省 = 当前活动段，故事板 UI 场景；
      payload.stabilization 为 undefined = 移除稳定并剥离内存态；否则同时填内存态三字段） */
  setVideoStabilization: (clipIndex: number, payload: VideoStabilizationPayload, segmentIndex?: number) => void;
  /** 写入/移除某素材的 3D 地面追踪（segmentIndex 缺省 = 当前活动段；
      payload.groundTrack 为 undefined = 移除并剥离内存态 groundData；否则同时填内存态） */
  setGroundTrack: (clipIndex: number, payload: GroundTrackPayload, segmentIndex?: number) => void;
  /** 整体替换某段的 3D 地面元素列表（空数组 = 清空该段全部地面元素） */
  setSegmentGroundElements: (segmentIndex: number, elements: GroundElement[]) => void;
  updateCurrentText: (text: Partial<PromoText>) => void;
  updateCurrentStyle: (style: Partial<PromoStyle>) => void;
  updateCurrentLayout: (layout: Partial<TemplateLayout>) => void;
  /** 设置当前片段的某个模板个性化参数；value 为 undefined 时删除该键（回退模板默认） */
  updateCurrentCustomParam: (key: string, value: number | undefined) => void;
  setCurrentDuration: (duration: number) => void;
  /** 设置当前片段的模板播放起点（秒，0 = 从头播放） */
  setCurrentStartOffset: (offsetSec: number) => void;
  setCurrentTransition: (transition: TransitionType) => void;
  /** 合并写入当前片段的转场参数（时长/焦点/倍率）；传 undefined 的键表示清除该项回退默认 */
  setCurrentTransitionParams: (params: Partial<TransitionParams>) => void;
  setCurrentVideoEffect: (effect: VideoEffect) => void;
  setCurrentBackgroundEffect: (effect: BackgroundEffect) => void;
  /** 设置当前片段的文字入场动效（undefined = 清除，回退模板默认） */
  setCurrentTextAnim: (anim: TextAnimPreset | undefined) => void;
  /** 设置当前片段的片尾退场预设（undefined = 清除，回退 sync 同步退场） */
  setCurrentExitStyle: (exitStyle: SegmentExitStyle | undefined) => void;
  /** 设置当前片段出场转场的音效覆盖（undefined = 恢复自动；见 shared/sfx-plan.ts） */
  setCurrentTransitionSfx: (sfx: SfxKind | 'off' | undefined) => void;
  /** 合并更新某片段的旁白（patch 中的键覆盖；传 undefined 的键不处理） */
  updateSegmentNarration: (index: number, patch: Partial<SegmentNarration>) => void;
  /** 清除某片段的旁白 */
  clearSegmentNarration: (index: number) => void;

  // 从工作副本同步到 segments
  syncCurrentToSegment: () => void;

  // 从 segment 加载到工作副本
  loadSegmentToCurrent: (index: number) => void;

  // ====== AI 助手 ======
  /** 整体替换故事板（AI 搭建）。产生历史快照与置脏（用户可撤销 AI 操作），不做抑制 */
  applyAiStoryboard: (specs: ValidatedSegmentSpec[]) => void;
  /** 用带素材的片段整体替换故事板（AI 卡点剪辑用；与 applyAiStoryboard 的区别：片段素材由调用方构造好，原样落库） */
  applyMontageSegments: (segments: Segment[]) => void;
  /** 更新单段字段（AI 微调）：部分更新语义——patch 中为 undefined 的字段保留片段现有值，素材/style/layout 保留不动；customParams 给出时按键合并 */
  applyAiSegmentPatch: (index: number, patch: ValidatedSegmentPatch) => void;

  // 方向
  setOrientation: (o: Orientation) => void;
  /** 设置比例预设，同时派生 orientation */
  setAspectRatioId: (id: string) => void;

  // 派生数据
  getTotalDuration: () => number;
}

/** Mark a shot-level plan stale whenever a segment timeline contract changes. */
const staleEditPlanPatch = (
  editPlan: EditPlan | null,
  reason: string,
): {editPlan?: EditPlan | null} => {
  if (!editPlan) return {};
  if (editPlan.stale && editPlan.staleReason === reason) return {editPlan};
  const warnings = editPlan.validation?.warnings ?? [];
  const warning = `EditPlan 已因${reason}而过期`;
  return {
    editPlan: {
      ...editPlan,
      stale: true,
      staleReason: reason,
      validation: editPlan.validation
        ? {...editPlan.validation, warnings: warnings.includes(warning) ? warnings : [...warnings, warning]}
        : editPlan.validation,
    },
  };
};

// ====== 基建④ 撤销历史持久化：降级序列化（内存态→可落盘态；与 serializeProject 主数据同款降级） ======

/** 撤销栈持久深度上限（体积护栏：快照是纯配置，50 条几十 KB 级） */
export const PERSIST_UNDO_DEPTH = 50;

/** 段内 clip 的落盘形态：剥离内存态（sidecar 路径保留、加载时重建），src 会话 URL → 原始路径 */
export const persistClipForFile = (v: VideoClip): VideoClip => {
  const {cursorPoints: _cp, cursorClicks: _cc, cursorEvents: _ce, uiRegions: _ur, stabCorrections: _sc, stabZoom: _sz, stabSampleFps: _sf, groundData: _gd, proxyStatus: _ps, ...rest} = v;
  return {...rest, src: clipSrcToPath(v.src)};
};

/** 段的落盘形态（与 serializeProject 主段同款：clip 降级 + 旁白剥 src + 悬浮层 src→路径） */
export const persistSegmentForFile = (seg: Segment): Segment => ({
  ...seg,
  videos: seg.videos.map(persistClipForFile),
  narration: seg.narration
    ? seg.narration.source === 'tts'
      ? {text: seg.narration.text, source: 'tts' as const, volume: seg.narration.volume}
      : (() => {
          const {src: _src, ...rest} = seg.narration!;
          return rest as Segment['narration'];
        })()
    : seg.narration,
  overlay: seg.overlay ? {...seg.overlay, src: clipSrcToPath(seg.overlay.src)} : seg.overlay,
});

/** 历史快照的落盘形态：段/工作副本降级 + bgm/logo 剥 src（path 保留待重建）+ publish 深拷贝；其余纯配置原样 */
export const persistHistorySnapshotForFile = (snap: HistorySnapshot): HistorySnapshot => ({
  ...snap,
  segments: snap.segments.map(persistSegmentForFile),
  videos: snap.videos.map(persistClipForFile),
  bgm: snap.bgm ? (({src: _src, ...rest}) => rest)(snap.bgm) as BgmTrack : snap.bgm,
  logo: snap.logo ? (({src: _src, ...rest}) => rest)(snap.logo) as LogoConfig : snap.logo,
  publish: deepClone(snap.publish),
});

// ====== 基建④ 载入水合：降级快照 → 活会话态（与主数据装载共用一套重建，记忆化去重） ======

/** 载入重建上下文：src（IPC）与 sidecar（文件读）按唯一键记忆化——历史快照与主段大量共享
 *  同一路径/sidecar，50 条快照不放大 IO；sidecar 结果按不可变派生值共享引用（只读消费）。 */
interface LoadRebuildCtx {
  missingSet: Set<string>;
  srcMemo: Map<string, Promise<string>>;
  sidecarMemo: Map<string, Promise<unknown>>;
}

const memoPathToSrc = (path: string, ctx: LoadRebuildCtx): Promise<string> => {
  let p = ctx.srcMemo.get(path);
  if (!p) {
    p = pathToClipSrc(path);
    ctx.srcMemo.set(path, p);
  }
  return p;
};

const memoSidecar = <T>(key: string, ctx: LoadRebuildCtx, load: () => Promise<T>): Promise<T | null> => {
  let p = ctx.sidecarMemo.get(key) as Promise<T | null> | undefined;
  if (!p) {
    p = load().catch(() => null);
    ctx.sidecarMemo.set(key, p);
  }
  return p;
};

/**
 * 持久态 clip → 活会话 clip（从 applyLoadedProject 的段内重建纯提取，逻辑零变动；
 * 记忆化为唯一差异）。missing（含远程 URL——主进程 existsSync 一律判缺失）→ src 置空，
 * 不让恶意 .vtproj 借预览/渲染向任意外网拉取「媒体」。返回 missing 标记由调用方决定
 * 是否记入缺失媒体弹窗（历史水合不记——撤回到引用已删媒体的旧态与主加载同款表现）。
 */
const rebuildPersistedClip = async (
  v: VideoClip,
  ctx: LoadRebuildCtx,
): Promise<{clip: VideoClip; missing: boolean}> => {
  const missing = ctx.missingSet.has(v.src);
  const src = missing ? '' : await memoPathToSrc(v.src, ctx);
  // 鼠标轨迹 sidecar：读回采样点/点击填充内存态；读失败静默置 undefined，不阻断加载
  let cursorPoints: VideoClip['cursorPoints'];
  let cursorClicks: VideoClip['cursorClicks'];
  let cursorEvents: VideoClip['cursorEvents'];
  if (v.cursorTrack) {
    const track = await memoSidecar(`cursor:${v.cursorTrack}`, ctx, () => window.api.captureReadCursorTrack(v.cursorTrack!));
    cursorPoints = (track as {points?: VideoClip['cursorPoints']} | null)?.points;
    cursorClicks = (track as {clicks?: VideoClip['cursorClicks']} | null)?.clicks;
  }
  // UI 区域 sidecar（拆层飞出）：读回区域列表；读失败静默置 undefined，不阻断加载
  let uiRegions: VideoClip['uiRegions'];
  if (v.uiRegionsTrack) {
    const regionsFile = await memoSidecar(`uiregions:${v.uiRegionsTrack}`, ctx, () => window.api.uiRegionsRead(v.uiRegionsTrack!));
    uiRegions = (regionsFile as {regions?: VideoClip['uiRegions']} | null)?.regions;
  }
  // 声明式动作轨迹（优先级高于随机演示）：按脚本+种子确定性重建（动作数据不落盘，随脚本重生）
  if (!cursorPoints && v.cursorActionScript) {
    const parsed = parseCursorTrackScript(v.cursorActionScript);
    if (parsed.steps.length > 0) {
      const built = buildCursorTrack(parsed, {
        durationSec: v.duration,
        width: v.width,
        height: v.height,
        seed: v.cursorActionSeed,
      });
      cursorPoints = built.points;
      cursorClicks = built.clicks;
      cursorEvents = built.events;
    }
  }
  // 无真实轨迹但存了演示种子：按种子确定性重建演示轨迹与演示点击（演示数据不落盘，随种子重生）
  if (!cursorPoints && v.cursorDemoSeed !== undefined) {
    cursorPoints = generateDemoCursorTrack({
      durationSec: v.duration,
      width: v.width,
      height: v.height,
      seed: v.cursorDemoSeed,
    });
    cursorClicks = generateDemoCursorClicks(cursorPoints);
  }
  // 稳定 sidecar：读回原始采样，按持久化的 smoothSec 重算校正表填充内存态（key 含 smoothSec——
  // 校正表是它的函数；memo 载荷带 sampleFps 与原逻辑同源）；读失败/数据无效静默置空，不阻断加载
  let stabMem: {stabCorrections?: StabCorrection[]; stabZoom?: number; stabSampleFps?: number} = {};
  if (v.stabilization?.trackPath) {
    const smoothSec = v.stabilization.smoothSec ?? STAB_DEFAULTS.smoothSec;
    const entry = await memoSidecar(`stab:${v.stabilization.trackPath}|${smoothSec}`, ctx, async () => {
      const track = await window.api.stabilizeRead(v.stabilization!.trackPath);
      if (track && track.samples.length > 0 && track.sampleFps > 0) {
        return {
          solved: solveStabilization(track.samples, track.sampleFps, {
            smoothSec,
            maxZoom: STAB_DEFAULTS.maxZoom,
            videoWidth: track.videoWidth,
            videoHeight: track.videoHeight,
          }),
          sampleFps: track.sampleFps,
        };
      }
      return null;
    });
    const e = entry as {solved?: {corrections: StabCorrection[]; zoom: number}; sampleFps?: number} | null;
    if (e?.solved) {
      stabMem = {stabCorrections: e.solved.corrections, stabZoom: e.solved.zoom, stabSampleFps: e.sampleFps};
    }
  }
  // 地面追踪 sidecar：读回锚点轨迹填充内存态 groundData（渲染端逐帧解投影矩阵）；
  // 读失败/数据无效静默置空，不阻断加载（素材表现为未追踪，重开 3D 追踪弹窗可再分析）
  let groundMem: VideoClip['groundData'];
  if (v.groundTrack?.trackPath) {
    const gtrack = await memoSidecar(`ground:${v.groundTrack.trackPath}`, ctx, () => window.api.groundRead(v.groundTrack!.trackPath));
    const g = gtrack as {anchors?: unknown[]; samples?: unknown[]} | null;
    if (g && (g.anchors?.length ?? 0) >= 4 && (g.samples?.length ?? 0) > 0) {
      groundMem = {anchors: g.anchors as NonNullable<VideoClip['groundData']>['anchors'], samples: g.samples as NonNullable<VideoClip['groundData']>['samples']};
    }
  }
  // 挖段清洗：手改工程文件可能注入越界/乱序区间，加载即归一（trim 也顺带重算有效时长）
  // 顺带剥离 stab*/ground* 内存态字段（正常保存时已剥离；手改工程注入的一律改由 sidecar 重建）
  const {stabCorrections: _sc, stabZoom: _sz, stabSampleFps: _sf, groundData: _gdIn, ...rawClip} = applyTrimAndCuts(v, v.trimStart ?? 0, v.trimEnd ?? v.duration);
  return {
    missing,
    clip: {...rawClip, src, ...stabMem, ...(groundMem ? {groundData: groundMem} : {}), ...(cursorPoints ? {cursorPoints} : {}), ...(cursorClicks && cursorClicks.length > 0 ? {cursorClicks} : {}), ...(cursorEvents && cursorEvents.length > 0 ? {cursorEvents} : {}), ...(uiRegions && uiRegions.length > 0 ? {uiRegions} : {})},
  };
};

/** 历史快照的段水合（轻量：clip 全量重建 + 旁白/悬浮层 src 重建；不进缺失弹窗） */
const hydrateSnapshotSegment = async (seg: Segment, ctx: LoadRebuildCtx): Promise<Segment> => ({
  ...seg,
  videos: await Promise.all(seg.videos.map(async (v) => (await rebuildPersistedClip(v, ctx)).clip)),
  narration:
    seg.narration && seg.narration.source !== 'tts' && (seg.narration as {path?: string}).path
      ? {
          ...seg.narration,
          src: ctx.missingSet.has((seg.narration as {path: string}).path) ? '' : await memoPathToSrc((seg.narration as {path: string}).path, ctx),
        }
      : seg.narration,
  overlay:
    seg.overlay
      ? {...seg.overlay, src: ctx.missingSet.has(seg.overlay.path) ? '' : await memoPathToSrc(seg.overlay.path, ctx)}
      : seg.overlay,
});

/** 基建④：把工程文件里的降级历史水合成活会话快照（bgm/logo src 重建 + 段/工作副本重建；
 *  非法条目静默丢弃——宁少勿猜，撤销栈坏一条不炸整栈） */
const hydrateHistoryFromFile = async (
  hist: {past?: unknown[]; future?: unknown[]} | undefined,
  ctx: LoadRebuildCtx,
): Promise<{past: HistorySnapshot[]; future: HistorySnapshot[]}> => {
  const hydrateOne = async (raw: unknown): Promise<HistorySnapshot | null> => {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as {segments?: unknown}).segments)) return null;
    const snap = raw as HistorySnapshot;
    try {
      return {
        ...snap,
        segments: await Promise.all(snap.segments.map((seg) => hydrateSnapshotSegment(seg, ctx))),
        videos: await Promise.all(snap.videos.map(async (v) => (await rebuildPersistedClip(v, ctx)).clip)),
        bgm: snap.bgm && (snap.bgm as unknown as {path?: string}).path
          ? {...snap.bgm, src: ctx.missingSet.has((snap.bgm as unknown as {path: string}).path) ? '' : await memoPathToSrc((snap.bgm as unknown as {path: string}).path, ctx)} as BgmTrack
          : snap.bgm,
        logo: snap.logo && (snap.logo as unknown as {path?: string}).path
          ? {...snap.logo, src: ctx.missingSet.has((snap.logo as unknown as {path: string}).path) ? '' : await memoPathToSrc((snap.logo as unknown as {path: string}).path, ctx)} as LogoConfig
          : snap.logo,
      };
    } catch {
      return null;
    }
  };
  const run = async (list: unknown[]): Promise<HistorySnapshot[]> => {
    const out = await Promise.all(list.slice(-PERSIST_UNDO_DEPTH).map(hydrateOne));
    return out.filter((s): s is HistorySnapshot => s !== null);
  };
  return {past: await run(hist?.past ?? []), future: await run(hist?.future ?? [])};
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  // ====== 导航 ======
  step: 1,
  setStep: (step) => set({step}),

  // ====== 故事板 ======
  segments: [createEmptySegment('RevealSlide')],
  activeSegmentIndex: 0,
  orientation: 'landscape',
  aspectRatioId: DEFAULT_ASPECT_RATIO_ID,
  videoType: DEFAULT_VIDEO_TYPE,
  videoTypeSource: undefined,
  setVideoType: (t, source = 'user') =>
    set((s) => {
      // 体裁默认音效：仅在用户从未手动改过音效时跟随体裁（说话型默认关/情绪型默认开）
      if (s.sfxTouched) return {videoType: t, videoTypeSource: source};
      const enabled = SFX_ENABLED_BY_VIDEO_TYPE[t];
      return s.sfx.enabled === enabled ? {videoType: t, videoTypeSource: source} : {videoType: t, videoTypeSource: source, sfx: {...s.sfx, enabled}};
    }),
  maybeAutoRouteVideoType: () => {
    const s = get();
    // 从未设定过体裁（undefined）才路由一次：用户/agent 设过（user/agent）或已自动路由过（auto）都不再动
    if (s.videoTypeSource !== undefined) return null;
    const routed = inferAutoVideoType([...s.mediaPool, ...s.segments.flatMap((seg) => seg.videos)]);
    if (!routed || routed === s.videoType) return null;
    set({videoType: routed, videoTypeSource: 'auto'});
    return routed;
  },

  // ====== 当前工作副本 ======
  templateId: 'RevealSlide',
  videos: [],
  text: {title: '', subtitle: '', features: [], brandName: ''},
  style: createEmptyStyle(),
  layout: {...DEFAULT_LAYOUT},
  customParams: {},

  // ====== 输出 ======
  renderSettings: {...DEFAULT_RENDER_OPTIONS},
  setRenderSettings: (partial) =>
    set((s) => ({renderSettings: {...s.renderSettings, ...partial}})),

  // ====== 全局设置 ======
  appSettings: {...DEFAULT_SETTINGS},
  setAppSettings: (partial) =>
    set((s) => ({appSettings: {...s.appSettings, ...partial}})),

  // ====== 授权 / 订阅 ======
  licenseStatus: null,
  refreshLicenseStatus: async () => {
    try {
      const status = await window.api.getLicenseStatus();
      set({licenseStatus: status});
    } catch {
      // IPC 失败时保留旧状态，不打断用户操作
    }
  },

  // ====== 自定义模板 ======
  customTemplates: [],
  setCustomTemplates: (customTemplates) => set({customTemplates}),
  loadCustomTemplates: async () => {
    const list = await window.api.listCustomTemplates();
    set({customTemplates: (list || []).map(migrateCustomDef)});
  },
  upsertCustomTemplate: async (def) => {
    const list = await window.api.saveCustomTemplate(def);
    set({customTemplates: (list || []).map(migrateCustomDef)});
  },
  removeCustomTemplate: async (id) => {
    const list = await window.api.deleteCustomTemplate(id);
    set({customTemplates: list || []});
  },
  getCustomTemplateDef: (id) => get().customTemplates.find((t) => t.id === id),

  // ====== 市场模板 ======
  marketTemplates: [],
  setMarketTemplates: (marketTemplates) => set({marketTemplates}),
  loadMarketTemplates: async () => {
    try {
      const list = await window.api.marketInstalled();
      set({marketTemplates: list || []});
    } catch {
      // IPC 失败保留旧状态
    }
  },
  getMarketTemplateDef: (id) => get().marketTemplates.find((t) => t.id === id)?.def,

  // ====== AI 生成模板 ======
  generatedTemplates: [],
  setGeneratedTemplates: (generatedTemplates) => set({generatedTemplates}),
  loadGeneratedTemplates: async () => {
    try {
      const list = await window.api.listGeneratedTemplates();
      set({generatedTemplates: list || []});
    } catch {
      // IPC 失败保留旧状态
    }
  },
  getGeneratedTemplateDef: (id) => get().generatedTemplates.find((t) => t.id === id),

  // ====== 背景音乐 ======
  bgm: null,
  setBgm: (bgm) => set({bgm}),
  updateBgm: (partial) => set((s) => (s.bgm ? {bgm: {...s.bgm, ...partial}} : {})),

  // ====== 音效（SFX，项目级）======
  // enabled 初始值随缺省体裁（SFX_ENABLED_BY_VIDEO_TYPE）：说话型体裁默认关，情绪型默认开
  sfx: {...DEFAULT_SFX_CONFIG, enabled: SFX_ENABLED_BY_VIDEO_TYPE[DEFAULT_VIDEO_TYPE]},
  /** 用户是否手动改过音效：改过之后体裁切换不再覆盖（见 setVideoType） */
  sfxTouched: false,
  setSfx: (partial) =>
    set((s) => ({sfx: {...s.sfx, ...partial, volume: Math.max(0, Math.min(1, partial.volume ?? s.sfx.volume))}, sfxTouched: true})),

  addSfxClip: (kind, atSec) => {
    const s = get();
    const total = s.segments.reduce((sum, seg) => sum + (seg.duration || 8), 0);
    const id = `sfxclip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const clip: SfxClip = {id, kind, atSec: clampSfxClipAtSec(atSec, total), volume: 1};
    set({sfx: {...s.sfx, clips: [...(s.sfx.clips ?? []), clip]}, sfxTouched: true});
    return id;
  },
  updateSfxClip: (id, patch) => {
    const s = get();
    if (!(s.sfx.clips ?? []).some((c) => c.id === id)) return;
    const total = s.segments.reduce((sum, seg) => sum + (seg.duration || 8), 0);
    set({
      sfx: {
        ...s.sfx,
        clips: (s.sfx.clips ?? []).map((c) =>
          c.id === id
            ? {
                ...c,
                kind: patch.kind ?? c.kind,
                atSec: clampSfxClipAtSec(patch.atSec ?? c.atSec, total),
                volume: clampSfxClipVolume(patch.volume ?? c.volume),
              }
            : c,
        ),
      },
      sfxTouched: true,
    });
  },
  removeSfxClip: (id) => {
    const s = get();
    if (!(s.sfx.clips ?? []).some((c) => c.id === id)) return;
    set({sfx: {...s.sfx, clips: (s.sfx.clips ?? []).filter((c) => c.id !== id)}, sfxTouched: true});
  },

  // ====== 画面质感（项目级）======
  texture: DEFAULT_TEXTURE_PRESET,
  setTexture: (texture) => set({texture}),

  // ====== 节拍脉冲（项目级）======
  beatPulse: DEFAULT_BEAT_PULSE,
  setBeatPulse: (beatPulse) => set({beatPulse}),

  frameBudget: 12,
  setProjectFrameBudget: (n) => set({frameBudget: Math.max(0, Math.min(200, Math.round(n)))}),
  frameBudgetUsed: 0,
  chargeFrameBudget: (frames) => {
    const {frameBudget, frameBudgetUsed} = get();
    const unlimited = frameBudget === 0;
    const used = frameBudgetUsed + Math.max(0, frames);
    // 超支也记账（调用方拿到 exceeded 后自行拒附图），保持账实一致
    set({frameBudgetUsed: used});
    const remaining = unlimited ? Infinity : Math.max(0, frameBudget - used);
    return {used, total: frameBudget, remaining: unlimited ? -1 : remaining, exceeded: !unlimited && used > frameBudget};
  },
  setSegmentVideoShots: (segmentIndex, videoIndex, shots) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const patch = shots === undefined
        ? (() => {const {shotList: _sl, ...rest} = seg.videos[videoIndex]; return rest;})()
        : {...seg.videos[videoIndex], shotList: shots};
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === videoIndex ? patch : v))}
      );
      const videos = segmentIndex === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === videoIndex ? patch : v))
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段素材场景清单`)};
    }),

  highlightCandidates: null,
  setHighlightCandidates: (segmentIndex, videoIndex, data) => set({highlightCandidates: {segmentIndex, videoIndex, data}}),
  clearHighlightCandidates: () => set({highlightCandidates: null}),
  applyHighlightPick: (segmentIndex, videoIndex, ranges) => {
    const s = get();
    const seg = s.segments[segmentIndex];
    const clip = seg?.videos[videoIndex];
    if (!seg || !clip || ranges.length === 0) return false;
    // 归并选中区间（升序、去重叠）后落地：单段 = 直接裁剪；多段 = 区间外挖洞（keepRangesToTrim 同口径）
    const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
    const merged: Array<{startSec: number; endSec: number}> = [];
    for (const r of sorted) {
      const last = merged[merged.length - 1];
      if (last && r.startSec <= last.endSec + 0.01) last.endSec = Math.max(last.endSec, r.endSec);
      else merged.push({...r});
    }
    if (merged.length === 1) {
      s.updateSegmentVideoTrim(segmentIndex, videoIndex, merged[0].startSec, merged[0].endSec);
    } else {
      const start = merged[0].startSec;
      const end = merged[merged.length - 1].endSec;
      const cuts = merged.slice(1).map((m, i) => ({start: merged[i].endSec, end: m.startSec}));
      s.updateSegmentVideoTrim(segmentIndex, videoIndex, start, end, cuts);
    }
    return true;
  },

  // ====== 美化光标（项目级）======
  cursor: DEFAULT_CURSOR_ENABLED,
  setCursor: (cursor) => set({cursor}),

  // ====== 品牌 Logo / 字幕 / BGM 避让 ======
  logo: null,
  setLogo: (logo) => set({logo}),
  updateLogo: (partial) =>
    set((s) => (s.logo ? {logo: {...s.logo, ...partial}} : {})),
  captionStyle: {...DEFAULT_CAPTION_STYLE},
  setCaptionStyle: (style) =>
    set((s) => ({captionStyle: {...s.captionStyle, ...style}})),
  finePrint: {...DEFAULT_FINE_PRINT},
  setFinePrint: (partial) =>
    set((s) => ({finePrint: {...s.finePrint, ...partial}})),

  // ====== 色彩统一（项目级）======
  colorGrade: {...DEFAULT_COLOR_GRADE},
  setColorGrade: (partial) =>
    set((s) => ({colorGrade: {...s.colorGrade, ...partial}})),

  // ====== 品牌主题（项目级：品牌色 + 字体氛围）======
  brandColor: null,
  setBrandColor: (color) => {
    const next = color === null ? null : normalizeBrandColor(color);
    if (color !== null && !next) return; // 非法色值忽略，不产生空变更
    set({brandColor: next});
  },
  fontMood: DEFAULT_FONT_MOOD_ID,
  setFontMood: (fontMood) => {
    if (!isFontMoodId(fontMood)) return;
    set({fontMood});
  },

  // ====== 发布准备（项目级：封面 + 元数据）======
  publish: createDefaultPublishKit(),
  setPublishMetadata: (partial) =>
    set((s) => ({publish: {...s.publish, metadata: {...s.publish.metadata, ...partial}}})),
  setCoverConfig: (partial) =>
    set((s) => ({publish: {...s.publish, cover: {...s.publish.cover, ...partial}}})),
  mediaTags: {},
  setMediaTags: (tags) => set((s) => ({mediaTags: {...s.mediaTags, ...tags}})),
  mediaIntelligence: null,
  setMediaIntelligence: (index) => set({mediaIntelligence: index}),
  editPlan: null,
  setEditPlan: (plan) => set({editPlan: plan}),
  autoPipeline: null,
  setAutoPipeline: (state) => set({autoPipeline: state ? {...state, log: state.log.slice(0, PIPELINE_LOG_LIMIT)} : null}),
  setBgmDucking: (enabled, amount) =>
    set((s) => {
      if (!s.bgm) return {};
      const clamped = Math.max(0.1, Math.min(1, amount));
      return {bgm: {...s.bgm, ducking: {enabled, amount: clamped}}};
    }),
  setSegmentCaptions: (index, captions) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[index];
      if (!seg) return {segments: updated};
      const next = captions && captions.length > 0 ? captions.map((c) => ({...c})) : undefined;
      updated[index] = {...seg, captions: next};
      return {segments: updated};
    }),
  clearSegmentCaptions: (index) =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[index]) {
        updated[index] = {...updated[index], captions: undefined};
      }
      return {segments: updated};
    }),

  setSegmentOverlay: (index, overlay) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[index];
      if (!seg) return {segments: updated};
      updated[index] = {...seg, overlay};
      return {segments: updated};
    }),

  alignSegmentsToBeats: (opts) => {
    const s0 = get();
    if (!s0.bgm) return null;
    // 时间轴坐标的拍（BGM 起播点/截取映射后；缺省字段=原 getBgmBeats）
    const beats = bgmTimelineBeats(s0.bgm);
    if (beats.length === 0) return null;
    // 先把工作副本刷入 segments（抑制历史：与下方的写入合并为一条撤销记录）
    suppressNextHistory();
    get().syncCurrentToSegment();
    const r = snapDurationsToBeats(
      get().segments.map((seg) => seg.duration || 8),
      beats,
      // min 0.5：快切蒙太奇段（0.5-1.5s）也要能压拍，不再强制抬到 1s
      {min: 0.5, max: 60, tolerance: opts?.tolerance},
    );
    // 转场时长吸附半拍网格（转场与切点一样踩拍；节拍不足时为 null 跳过）
    const tSnap = snapTransitionsToBeats(get().segments, beats);
    const movedCount = r?.movedCount ?? 0;
    const transitionMoved = tSnap?.movedCount ?? 0;
    if (movedCount === 0 && transitionMoved === 0) {
      return {movedCount: 0, transitionMovedCount: 0, beatCount: beats.length, bpm: s0.bgm.bpm};
    }
    set((s) => ({
      segments: s.segments.map((seg, i) => ({
        ...seg,
        ...(r && movedCount > 0 ? {duration: r.durations[i]} : {}),
        ...(tSnap && transitionMoved > 0 && seg.transition !== 'none'
          ? {transitionParams: {...(seg.transitionParams ?? {}), durationSec: tSnap.durations[i]}}
          : {}),
      })),
      ...staleEditPlanPatch(s.editPlan, '节拍对齐修改时间线'),
    }));
    return {movedCount, transitionMovedCount: transitionMoved, beatCount: beats.length, bpm: s0.bgm.bpm};
  },

  applyMusicStructurePlan: (durations, transitions) => {
    // 与 alignSegmentsToBeats 同口径：刷工作副本 + 一条撤销记录写入
    suppressNextHistory();
    get().syncCurrentToSegment();
    set((s) => ({
      segments: s.segments.map((seg, i) => ({
        ...seg,
        ...(durations[i] !== undefined ? {duration: durations[i]} : {}),
        ...(transitions[i] !== undefined ? {transition: transitions[i]} : {}),
      })),
      ...staleEditPlanPatch(s.editPlan, '音乐结构重排修改时间线'),
    }));
  },

  // ====== 渲染 ======
  isRendering: false,
  renderProgress: 0,
  renderOutputPath: '',
  startRendering: () => set({isRendering: true, renderProgress: 0}),
  setProgress: (renderProgress) => set({renderProgress}),
  finishRendering: (renderOutputPath) =>
    set({isRendering: false, renderProgress: 100, renderOutputPath}),
  resetRendering: () =>
    set({isRendering: false, renderProgress: 0, renderOutputPath: ''}),
  lastRenderInfo: null,
  setLastRenderInfo: (lastRenderInfo) => set({lastRenderInfo}),

  // ====== 工程文件 ======
  projectName: DEFAULT_PROJECT_NAME,
  projectFilePath: null,
  isSampleProject: false,
  isDirty: false,
  missingMedia: [],

  serializeProject: (opts) => {
    const s = get();
    // 深拷贝 segments，并把每个 clip 的 src 由会话 URL 还原为原始本地路径
    const segments = s.segments.map(persistSegmentForFile);
    // bgm 不持久化 src（会话 URL），加载时由 path 重建
    const bgm = s.bgm ? (({src: _src, ...rest}) => rest)(s.bgm) : null;
    // logo 不持久化 src（会话 URL），加载时由 path 重建
    const logo = s.logo ? (({src: _src, ...rest}) => rest)(s.logo) : null;
    // 素材库同样剥离内存态、src 还原为原始路径（可选字段：旧版软件忽略）
    const mediaPool = s.mediaPool.map((c) => {
      const {cursorPoints: _cp, cursorClicks: _cc, stabCorrections: _sc, stabZoom: _sz, stabSampleFps: _sf, groundData: _gd, ...rest} = c;
      return {...rest, src: clipSrcToPath(c.src)};
    });
    return {
      aspectRatioId: s.aspectRatioId,
      orientation: s.orientation,
      videoType: s.videoType,
      videoTypeSource: s.videoTypeSource,
      segments,
      bgm,
      logo,
      mediaPool,
      captionStyle: {...s.captionStyle},
      finePrint: {...s.finePrint},
      colorGrade: {...s.colorGrade},
      brandColor: s.brandColor,
      fontMood: s.fontMood,
      sfx: {...s.sfx},
      texture: s.texture,
      beatPulse: s.beatPulse,
      cursor: s.cursor,
      renderSettings: {...s.renderSettings},
      activeSegmentIndex: s.activeSegmentIndex,
      // 发布准备（可选字段：旧版软件打开新文件时忽略）
      publish: deepClone(s.publish),
      // 素材打标（可选字段；键转成本地路径——src 带动态端口，跨会话不稳定）
      mediaTags: Object.fromEntries(
        Object.entries(s.mediaTags).map(([src, tag]) => [clipSrcToPath(src), tag]),
      ),
      mediaIntelligence: s.mediaIntelligence ?? undefined,
      editPlan: s.editPlan ?? undefined,
      // 基建④：撤销历史只在显式保存时降级带上（autosave 调用方不传 opts；设置开关再兜一道）
      ...(opts?.includeHistory && s.appSettings.persistUndoHistory
        ? {
            history: {
              past: s.historyPast.slice(-PERSIST_UNDO_DEPTH).map(persistHistorySnapshotForFile),
              future: s.historyFuture.slice(-PERSIST_UNDO_DEPTH).map(persistHistorySnapshotForFile),
            },
          }
        : {}),
    };
  },

  applyLoadedProject: async (name, data, filePath, missingPaths) => {
    const missingSet = new Set(missingPaths);
    const missingMedia: MissingMediaEntry[] = [];
    // 载入重建上下文（基建④：主段与历史快照共享 src/sidecar 记忆化——同路径只 IPC/读盘一次）
    const loadCtx: LoadRebuildCtx = {missingSet, srcMemo: new Map(), sidecarMemo: new Map()};
    // 逐 clip 用当前会话端口重建 src；data 里的 src 是原始路径；同时处理每段旁白
    // （重建逻辑提取为 rebuildPersistedClip——与历史快照水合同一套，缺失媒体在此按段/位收集）
    const segments = await Promise.all(
      data.segments.map(async (seg, segmentIndex) => ({
        ...seg,
        videos: await Promise.all(
          seg.videos.map(async (v, videoIndex) => {
            const {clip, missing} = await rebuildPersistedClip(v, loadCtx);
            if (missing) {
              missingMedia.push({segmentIndex, videoIndex, path: v.src, name: v.name});
            }
            return clip;
          })
        ),
        narration: await (async () => {
          if (!seg.narration) return undefined;
          // tts：跨机不迁移，留空待用户在旁白面板重新生成（文案已保留）
          if (seg.narration.source === 'tts' || !seg.narration.path) {
            return {text: seg.narration.text, source: seg.narration.source, volume: seg.narration.volume};
          }
          // import：按 path 重建 src；缺失则记入缺失媒体
          if (missingSet.has(seg.narration.path)) {
            missingMedia.push({
              segmentIndex,
              videoIndex: -2, // -2 = 旁白音频（区别于 -1 背景音乐）
              path: seg.narration.path,
              name: `${seg.narration.text.slice(0, 12) || '旁白'}（音频）`,
            });
            return {...seg.narration, src: ''};
          }
          return {...seg.narration, src: await pathToClipSrc(seg.narration.path)};
        })(),
        // 悬浮图片层：按 path 重建 src；缺失置空并记入缺失媒体（-4 = 悬浮层，区别于 -3 Logo）
        overlay: await (async () => {
          if (!seg.overlay) return seg.overlay ?? null;
          if (missingSet.has(seg.overlay.path)) {
            missingMedia.push({segmentIndex, videoIndex: -4, path: seg.overlay.path, name: `${seg.overlay.name}（悬浮层）`});
            return {...seg.overlay, src: ''};
          }
          return {...seg.overlay, src: await pathToClipSrc(seg.overlay.path)};
        })(),
      }))
    );
    // 素材库重建：按 path 重建 src；文件已缺失的条目静默丢弃（素材库是便利缓存，不进缺失媒体弹窗）
    const mediaPool: VideoClip[] = [];
    for (const c of data.mediaPool ?? []) {
      if (missingSet.has(c.src)) continue;
      const {stabCorrections: _sc, stabZoom: _sz, stabSampleFps: _sf, groundData: _gd, ...rawClip} = applyTrimAndCuts(c, c.trimStart ?? 0, c.trimEnd ?? c.duration);
      mediaPool.push({...rawClip, src: await pathToClipSrc(c.src)});
    }
    // bgm 同样由 path 重建 src；缺失（含远程 URL）置空，原因同 videos
    let bgm: BgmTrack | null = null;
    if (data.bgm) {
      const missing = missingSet.has(data.bgm.path);
      if (missing) {
        missingMedia.push({segmentIndex: -1, videoIndex: -1, path: data.bgm.path, name: `${data.bgm.name}（背景音乐）`});
      }
      bgm = {...data.bgm, src: missing ? '' : await pathToClipSrc(data.bgm.path)};
    }
    // logo 同样由 path 重建 src
    let logo: LogoConfig | null = null;
    if (data.logo) {
      if (missingSet.has(data.logo.path)) {
        missingMedia.push({segmentIndex: -3, videoIndex: -3, path: data.logo.path, name: `${data.logo.name}（Logo）`});
        logo = {...data.logo, src: ''};
      } else {
        logo = {...data.logo, src: await pathToClipSrc(data.logo.path)};
      }
    }
    // 字幕样式：旧工程无此字段时回退默认
    const captionStyle: CaptionStyle = {...DEFAULT_CAPTION_STYLE, ...(data.captionStyle || {})};
    // 边缘小字同理：旧工程无此字段时回退默认（空串 = 不显示）
    const finePrint: FinePrintConfig = {...DEFAULT_FINE_PRINT, ...(data.finePrint || {})};
    // 色彩统一同理：旧工程无此字段时回退默认（原生 + 自动曝光匹配开）
    const colorGrade: ColorGrade = {...DEFAULT_COLOR_GRADE, ...(data.colorGrade || {})};
    // 品牌主题同理：旧工程无此字段回退默认（默认蓝 + 商业冷峻）；非法值静默回退
    const brandColor = normalizeBrandColor(data.brandColor) ?? null;
    const fontMood: FontMoodId = isFontMoodId(data.fontMood) ? data.fontMood : DEFAULT_FONT_MOOD_ID;
    const activeIndex = Math.min(Math.max(data.activeSegmentIndex ?? 0, 0), Math.max(segments.length - 1, 0));
    // 基建④：撤销历史水合（显式保存时降级写入的快照 → 活会话态，与主段共享记忆化）。
    // 开关关 / 旧工程无历史 → 空栈（回到「加载即新起点」行为）；水合不进缺失媒体弹窗。
    const hydratedHistory = data.history
      ? await hydrateHistoryFromFile(data.history, loadCtx)
      : {past: [] as HistorySnapshot[], future: [] as HistorySnapshot[]};
    const restoredHistory =
      get().appSettings.persistUndoHistory && data.history ? hydratedHistory : {past: [] as HistorySnapshot[], future: [] as HistorySnapshot[]};
    suppressNextDirty();
    suppressNextHistory(); // 整体 set
    suppressNextHistory(); // loadSegmentToCurrent
    set({
      segments,
      aspectRatioId: data.aspectRatioId,
      orientation: data.orientation,
      // 体裁为可选新增字段：旧工程 / 手改文件里的非法值回退默认
      videoType: isVideoType(data.videoType) ? data.videoType : DEFAULT_VIDEO_TYPE,
      // P0-1：缺字段的旧工程视为用户既定选择（'user'）——历史工程永不触发导入自动路由
      videoTypeSource:
        data.videoTypeSource === 'auto' || data.videoTypeSource === 'agent' || data.videoTypeSource === 'user'
          ? data.videoTypeSource
          : 'user',
      bgm,
      logo,
      mediaPool,
      captionStyle,
      finePrint,
      colorGrade,
      brandColor,
      fontMood,
      // 音效配置合并默认值：旧版工程文件无此字段时回退默认（新增可选字段不升格式版本）
      sfx: {...DEFAULT_SFX_CONFIG, ...(data.sfx || {})},
      // 载入的工程视为「音效已被选择过」：此后切换体裁不再自动覆盖其音效开关
      sfxTouched: true,
      // 质感预设同理：旧工程无此字段时用默认（胶片）
      texture: data.texture ?? DEFAULT_TEXTURE_PRESET,
      // 节拍脉冲同理：旧工程无此字段时用默认（开）
      beatPulse: data.beatPulse ?? DEFAULT_BEAT_PULSE,
      // 美化光标同理：旧工程无此字段时用默认（开）
      cursor: data.cursor ?? DEFAULT_CURSOR_ENABLED,
      // 渲染设置合并默认值：旧版工程文件缺少后增字段（如 encoder）时回退默认
      renderSettings: {...DEFAULT_RENDER_OPTIONS, ...data.renderSettings},
      // 发布准备同理：旧工程无此字段回退默认；有则清洗兜底（防手改工程文件注入异常值）
      publish: data.publish
        ? {
            cover: sanitizeCoverConfig({...DEFAULT_COVER, ...data.publish.cover}),
            metadata: {
              title: String(data.publish.metadata?.title ?? '').slice(0, 200),
              description: String(data.publish.metadata?.description ?? '').slice(0, 2000),
              tags: sanitizeTags(data.publish.metadata?.tags),
            },
          }
        : createDefaultPublishKit(),
      // 素材打标：按路径清洗后重映射到本次会话的 src（工程文件里键是路径，src 带动态端口）
      mediaTags: (() => {
        const raw = data.mediaTags || {};
        const clean: Record<string, MediaTag> = {};
        for (const [k, v] of Object.entries(raw)) {
          const tag = sanitizeMediaTag(v);
          if (tag) clean[k] = tag;
        }
        const pathToSrc = new Map<string, string>();
        for (const seg of segments) {
          for (const v of seg.videos) pathToSrc.set(clipSrcToPath(v.src), v.src);
        }
        const out: Record<string, MediaTag> = {};
        for (const [p, tag] of Object.entries(clean)) {
          const src = pathToSrc.get(p);
          if (src) out[src] = tag;
        }
        return out;
      })(),
      mediaIntelligence: sanitizeMediaIntelligence(data.mediaIntelligence),
      editPlan: sanitizeEditPlan(data.editPlan),
      projectName: name,
      projectFilePath: filePath,
      // 打开的工程不再是示例工程（openSampleProject 随后可重新置真）
      isSampleProject: false,
      isDirty: false,
      missingMedia,
      // 撤销/重做历史：基建④起显式保存的工程带降级历史（水合后跨会话可继续 Ctrl+Z）；
      // 无历史/开关关 = 空栈（加载即新起点，旧行为）
      historyPast: restoredHistory.past,
      historyFuture: restoredHistory.future,
      // 内容整体换了，上次渲染指纹不再代表当前内容
      lastRenderInfo: null,
      // 打开工程后直接进入故事板编辑
      step: 2,
    });
    get().loadSegmentToCurrent(activeIndex);
  },

  saveProject: async () => {
    // 保存前先把工作副本刷入 segments：只改了文案/素材而未切换片段时，
    // segments 里还是旧内容，直接序列化会静默丢稿
    get().syncCurrentToSegment();
    const s = get();
    if (!s.projectFilePath) return get().saveProjectAs();
    const res = await window.api.saveProject(s.projectFilePath, s.projectName, s.serializeProject({includeHistory: true}));
    if (!res.success) {
      window.alert(`保存工程失败：${res.error || '未知错误'}`);
      return false;
    }
    set({isDirty: false});
    pushRecentProject(s.projectFilePath, s.projectName);
    clearAutosaveFile();
    return true;
  },

  saveProjectToPath: async (path) => {
    const s = get();
    const target = path ?? s.projectFilePath;
    if (!target) return {ok: false, error: '当前工程没有保存路径：请传 path 参数（以 .vtproj 结尾的绝对路径）'};
    if (!/\.vtproj$/i.test(target)) return {ok: false, error: '保存路径必须以 .vtproj 结尾'};
    // 与手动保存同口径：先同步工作副本，保证序列化的是最新编辑内容
    get().syncCurrentToSegment();
    const res = await window.api.saveProjectToPath(target, s.projectName, get().serializeProject({includeHistory: true}));
    if (!res.success) return {ok: false, error: res.error || '保存失败'};
    const base = target.replace(/\\/g, '/').split('/').pop() || s.projectName;
    set({projectFilePath: target, projectName: base.replace(/\.vtproj$/i, ''), isDirty: false});
    pushRecentProject(target, base.replace(/\.vtproj$/i, ''));
    clearAutosaveFile();
    return {ok: true, path: target, name: base.replace(/\.vtproj$/i, '')};
  },

  loadProjectPath: async (path) => {
    const res = await window.api.openProjectPath(path);
    if (!res.success || !res.data || !res.path) {
      return {ok: false, error: res.error || '打开工程失败'};
    }
    await get().applyLoadedProject(res.name || DEFAULT_PROJECT_NAME, res.data, res.path, res.missingMedia || []);
    pushRecentProject(res.path, res.name || DEFAULT_PROJECT_NAME);
    clearAutosaveFile();
    return {
      ok: true,
      name: res.name || DEFAULT_PROJECT_NAME,
      segments: get().segments.length,
      missingMedia: res.missingMedia || [],
    };
  },

  remapMediaPaths: async (map) => {
    const s = get();
    let count = 0;
    // 单个 clip 的引用重写（segments[].videos 与活动段工作副本 videos 共用同一逻辑）
    const remapClip = async (v: VideoClip): Promise<VideoClip> => {
      let next = v;
      const oldPath = clipSrcToPath(v.src);
      const newPath = map[oldPath];
      if (newPath) {
        next = {...next, src: await pathToClipSrc(newPath)};
        count++;
      }
      const newCursor = next.cursorTrack ? map[next.cursorTrack] : undefined;
      if (newCursor) {
        next = {...next, cursorTrack: newCursor};
        count++;
      }
      const stabPath = next.stabilization?.trackPath;
      const newStab = stabPath ? map[stabPath] : undefined;
      if (newStab && next.stabilization) {
        next = {...next, stabilization: {...next.stabilization, trackPath: newStab}};
        count++;
      }
      const groundPath = next.groundTrack?.trackPath;
      const newGround = groundPath ? map[groundPath] : undefined;
      if (newGround && next.groundTrack) {
        next = {...next, groundTrack: {...next.groundTrack, trackPath: newGround}};
        count++;
      }
      return next;
    };
    const segments = await Promise.all(s.segments.map(async (seg) => {
      const videos = await Promise.all(seg.videos.map(remapClip));
      // import 旁白：path 替换 + src 会话 URL 重建（tts 无本地引用，不动）
      let narration = seg.narration;
      const oldNarr = narration?.source === 'import' ? narration.path : undefined;
      const newNarr = oldNarr ? map[oldNarr] : undefined;
      if (narration && newNarr) {
        narration = {...narration, path: newNarr, src: await pathToClipSrc(newNarr)};
        count++;
      }
      let overlay = seg.overlay;
      const newOverlay = overlay?.path ? map[overlay.path] : undefined;
      if (overlay && newOverlay) {
        overlay = {...overlay, path: newOverlay, src: await pathToClipSrc(newOverlay)};
        count++;
      }
      return {...seg, videos, narration, overlay};
    }));
    // 活动段工作副本也要同步重写：否则 saveProjectToPath 的 syncCurrentToSegment
    // 会用旧 src 的工作副本盖掉 remap 后的活动段
    const currentVideos = await Promise.all(s.videos.map(remapClip));
    let bgm = s.bgm;
    const newBgm = bgm?.path ? map[bgm.path] : undefined;
    if (bgm && newBgm) {
      bgm = {...bgm, path: newBgm, src: await pathToClipSrc(newBgm)};
      count++;
    }
    let logo = s.logo;
    const newLogo = logo?.path ? map[logo.path] : undefined;
    if (logo && newLogo) {
      logo = {...logo, path: newLogo, src: await pathToClipSrc(newLogo)};
      count++;
    }
    // 素材打标的键是 clip 会话 URL：src 变了键同步换，否则打标静默丢失
    const mediaTags: typeof s.mediaTags = {};
    for (const [src, tag] of Object.entries(s.mediaTags)) {
      const p = clipSrcToPath(src);
      const np = map[p];
      mediaTags[np ? await pathToClipSrc(np) : src] = tag;
    }
    set({segments, videos: currentVideos, bgm, logo, mediaTags, ...(count > 0 ? {isDirty: true} : {})});
    return count;
  },

  saveProjectAs: async () => {
    // 同 saveProject：先同步工作副本，保证序列化的是最新编辑内容
    get().syncCurrentToSegment();
    const s = get();
    const res = await window.api.saveProjectAs(s.projectName, s.serializeProject({includeHistory: true}));
    if (!res.success || !res.path) {
      if (!res.canceled) window.alert(`保存工程失败：${res.error || '未知错误'}`);
      return false;
    }
    // 以实际保存的文件名作为工程名
    const base = res.path.replace(/\\/g, '/').split('/').pop() || s.projectName;
    const name = base.replace(/\.vtproj$/i, '');
    set({projectFilePath: res.path, projectName: name, isDirty: false});
    pushRecentProject(res.path, name);
    clearAutosaveFile();
    return true;
  },

  openProject: async () => {
    if (get().isDirty && !window.confirm('当前工程有未保存的更改，确定放弃吗？')) return false;
    const res = await window.api.openProject();
    if (!res) return false; // 用户取消
    if (!res.success || !res.data || !res.path) {
      window.alert(`打开工程失败：${res.error || '未知错误'}`);
      return false;
    }
    await get().applyLoadedProject(res.name || DEFAULT_PROJECT_NAME, res.data, res.path, res.missingMedia || []);
    pushRecentProject(res.path, res.name || DEFAULT_PROJECT_NAME);
    clearAutosaveFile();
    return true;
  },

  openProjectPath: async (filePath) => {
    if (get().isDirty && !window.confirm('当前工程有未保存的更改，确定放弃吗？')) return false;
    const res = await window.api.openProjectPath(filePath);
    if (!res.success || !res.data || !res.path) {
      // 打开失败（多为文件已被移动/删除），自动移出最近列表
      await removeRecentProject(filePath);
      window.alert(`打开工程失败：${res.error || '未知错误'}\n已将其从最近工程列表移除。`);
      return false;
    }
    await get().applyLoadedProject(res.name || DEFAULT_PROJECT_NAME, res.data, res.path, res.missingMedia || []);
    pushRecentProject(res.path, res.name || DEFAULT_PROJECT_NAME);
    clearAutosaveFile();
    return true;
  },

  openSampleProject: async () => {
    if (get().isDirty && !window.confirm('当前工程有未保存的更改，确定放弃吗？')) return false;
    const res = await window.api.openSampleProject();
    if (!res.success || !res.data || !res.path) {
      window.alert(`打开示例工程失败：${res.error || '未知错误'}`);
      return false;
    }
    await get().applyLoadedProject(res.name || DEFAULT_PROJECT_NAME, res.data, res.path, res.missingMedia || []);
    pushRecentProject(res.path, res.name || DEFAULT_PROJECT_NAME);
    clearAutosaveFile();
    // 标记示例工程身份：故事板顶部据此提示「一键换成你的素材」
    set({isSampleProject: true});
    return true;
  },

  replaceSampleMedia: (clips) => {
    if (clips.length === 0) return 0;
    let cursor = 0;
    let replaced = 0;
    const segments = get().segments.map((seg) => {
      if (seg.videos.length === 0) return seg; // 纯文字段跳过
      replaced++;
      // 每段替换为一条用户素材（素材不足时循环复用，保证每段都换上「你的素材」）
      const m = clips[cursor % clips.length];
      cursor++;
      return {...seg, videos: [{...m, id: genId()}]};
    });
    if (replaced === 0) return 0;
    set({segments, isSampleProject: false});
    // 活动段若被替换，刷新工作副本避免编辑器显示旧素材
    get().loadSegmentToCurrent(get().activeSegmentIndex);
    return replaced;
  },

  // ====== 项目素材库 ======
  mediaPool: [],
  addToMediaPool: (clips) =>
    set((s) => {
      // 按原始路径去重（同一文件重复导入只保留一条，刷新缩略图/时长取新值）
      const known = new Set(s.mediaPool.map((c) => clipSrcToPath(c.src)));
      const fresh = clips.filter((c) => !known.has(clipSrcToPath(c.src)));
      return {mediaPool: [...s.mediaPool, ...fresh.map((c) => ({...c, id: genId()}))]};
    }),
  removeFromMediaPool: (id) =>
    set((s) => ({mediaPool: s.mediaPool.filter((c) => c.id !== id)})),
  distributeMediaPool: () => {
    const s = get();
    if (s.mediaPool.length === 0) return {assigned: 0, unmet: 0};
    // 各模板的 min/max 素材数（内置 + 自定义 + 云端 + AI 生成一并查）
    const metas = mergeTemplateMetas(s.customTemplates, s.marketTemplates, s.generatedTemplates);
    const metaById = new Map(metas.map((t) => [t.id, t]));
    const deficits = computePoolDeficits(
      s.segments.map((seg) => ({templateId: seg.templateId, clipCount: seg.videos.length})),
      (id) => {
        const meta = metaById.get(id);
        return meta ? {min: meta.minVideos, max: meta.maxVideos} : undefined;
      },
    );
    const fills = allocatePoolRoundRobin(deficits, s.mediaPool.length);
    const assigned = fills.reduce((acc, f) => acc + f.length, 0);
    if (assigned === 0) return {assigned: 0, unmet: countUnmetSegments(deficits, fills)};
    const segments = s.segments.map((seg, i) => (fills[i].length === 0 ? seg : {...seg, videos: [...seg.videos, ...fills[i].map((poolIdx) => ({...s.mediaPool[poolIdx], id: genId()}))]}));
    set({segments});
    const activeIdx = get().activeSegmentIndex;
    if (fills[activeIdx]?.length > 0) get().loadSegmentToCurrent(activeIdx);
    return {assigned, unmet: countUnmetSegments(deficits, fills)};
  },

  newProject: () => {
    if (get().isDirty && !window.confirm('当前工程有未保存的更改，确定放弃吗？')) return;
    const seg = createEmptySegment('RevealSlide');
    // 设置页的默认格式/CRF 在此接线：作为新工程渲染设置的初始值（已有工程不受影响）
    const {defaultFormat, defaultCrf} = get().appSettings;
    suppressNextDirty();
    suppressNextHistory();
    set({
      segments: [seg],
      activeSegmentIndex: 0,
      aspectRatioId: DEFAULT_ASPECT_RATIO_ID,
      orientation: 'landscape',
      videoType: DEFAULT_VIDEO_TYPE,
      videoTypeSource: undefined,
      bgm: null,
      logo: null,
      mediaPool: [],
      captionStyle: {...DEFAULT_CAPTION_STYLE},
      finePrint: {...DEFAULT_FINE_PRINT},
      colorGrade: {...DEFAULT_COLOR_GRADE},
      brandColor: null,
      fontMood: DEFAULT_FONT_MOOD_ID,
      sfx: {...DEFAULT_SFX_CONFIG, enabled: SFX_ENABLED_BY_VIDEO_TYPE[DEFAULT_VIDEO_TYPE]},
      // 新工程音效未手动选择过：随体裁默认（切体裁时跟随）
      sfxTouched: false,
      texture: DEFAULT_TEXTURE_PRESET,
      beatPulse: DEFAULT_BEAT_PULSE,
      cursor: DEFAULT_CURSOR_ENABLED,
      publish: createDefaultPublishKit(),
      mediaTags: {},
      mediaIntelligence: null,
      editPlan: null,
      autoPipeline: null,
      renderSettings: {...DEFAULT_RENDER_OPTIONS, format: defaultFormat, crf: defaultCrf},
      projectName: DEFAULT_PROJECT_NAME,
      projectFilePath: null,
      isSampleProject: false,
      isDirty: false,
      missingMedia: [],
      // 新工程：上次渲染指纹不再代表当前内容
      lastRenderInfo: null,
      // 新工程是新的编辑起点，清空撤销/重做历史
      historyPast: [],
      historyFuture: [],
      // 重置工作副本与导航，回到第一步重新选择方向与模板
      step: 1,
      templateId: seg.templateId,
      videos: [],
      text: {title: '', subtitle: '', features: [], brandName: ''},
      style: createEmptyStyle(),
      layout: {...DEFAULT_LAYOUT},
      customParams: {},
    });
    clearAutosaveFile();
  },

  relinkMissingMedia: (entry, media) =>
    set((s) => {
      const remaining = s.missingMedia.filter((m) => m !== entry);
      // 背景音乐重新链接：只换 src/path/name，保留音量等设置
      if (entry.segmentIndex === -1) {
        if (!s.bgm) return {missingMedia: remaining};
        return {bgm: {...s.bgm, src: media.src, path: media.path, name: media.name}, missingMedia: remaining};
      }
      // 旁白音频重新链接（videoIndex === -2）：保留 text/source/volume，换 src/path/duration
      if (entry.videoIndex === -2) {
        const segments = s.segments.map((seg, si) =>
          si !== entry.segmentIndex || !seg.narration
            ? seg
            : {...seg, narration: {...seg.narration, src: media.src, path: media.path, duration: media.duration}}
        );
        return {segments, missingMedia: remaining};
      }
      // Logo 重新链接（segmentIndex === -3）：保留位置/大小/透明度/显隐，换 src/path/name
      if (entry.segmentIndex === -3) {
        if (!s.logo) return {missingMedia: remaining};
        return {logo: {...s.logo, src: media.src, path: media.path, name: media.name}, missingMedia: remaining};
      }
      const replaceClip = (v: VideoClip): VideoClip => {
        const duration = media.duration ?? v.duration;
        // 保留原 trim/viewport/fit/挖段；裁剪区间与挖段都钳制到新素材时长内
        const trimmed = applyTrimAndCuts(v, Math.min(v.trimStart ?? 0, duration), Math.min(v.trimEnd ?? duration, duration));
        return {
          ...trimmed,
          src: media.src,
          name: media.name,
          width: media.width ?? v.width,
          height: media.height ?? v.height,
          duration,
          thumbnail: media.thumbnail ?? v.thumbnail,
        };
      };
      const segments = s.segments.map((seg, si) =>
        si !== entry.segmentIndex
          ? seg
          : {...seg, videos: seg.videos.map((v, vi) => (vi === entry.videoIndex ? replaceClip(v) : v))}
      );
      // 若重新链接的是当前编辑片段，同步工作副本，避免编辑器显示旧数据
      const videos =
        entry.segmentIndex === s.activeSegmentIndex
          ? s.videos.map((v, vi) => (vi === entry.videoIndex ? replaceClip(v) : v))
          : s.videos;
      return {segments, videos, missingMedia: remaining, ...staleEditPlanPatch(s.editPlan, `第 ${entry.segmentIndex + 1} 段素材重新链接`)};
    }),

  dismissMissingMedia: () => set({missingMedia: []}),

  // ====== 撤销 / 重做 ======
  historyPast: [],
  historyFuture: [],

  pushHistory: (snapshot) =>
    set((s) => ({
      historyPast: pushHistoryEntry(s.historyPast, snapshot, HISTORY_LIMIT),
      historyFuture: [],
    })),

  // 命令事务（M1.5「包」阶段）：分发表只转发既有动作；before 快照+来源标即时入史，
  // 作用域豁免内执行（本命令引发的 set 不进 App.tsx 防抖采集——纪元自增让 pending 串让位）。
  // 切片三合并事务：同 coalesceKey 且栈顶条目在 1.2s 窗内 → 并入既有条目不新入史
  //（弹层 number 逐键/滑杆逐 tick 防灌史；既有条目的 before 即整串编辑起点），但照常清 redo 栈。
  runTimelineCommand: (cmd, opts) => {
    const coalesceKey = opts?.coalesceKey;
    if (coalesceKey && shouldCoalesce(get().historyPast[get().historyPast.length - 1], coalesceKey)) {
      const before = takeSnapshot(get());
      if (runWithHistorySuppressed(() => applyTimelineCommand(get() as unknown as TimelineCommandStore, cmd)) === false) return false;
      if (snapshotsEqual(before, takeSnapshot(get()))) return false;
      if (get().historyFuture.length > 0) set({historyFuture: []});
      bumpCommandEpoch();
      return true;
    }
    return executeTimelineCommand(
      {
        snapshot: () => takeSnapshot(get()),
        snapshotsEqual,
        applyInScope: (c) => runWithHistorySuppressed(() => applyTimelineCommand(get() as unknown as TimelineCommandStore, c)),
        pushHistory: (snap) => {
          get().pushHistory({
            ...snap,
            ...(coalesceKey ? {coalesceKey, coalesceAt: Date.now()} : {}),
          });
        },
        label: () => {
          if (opts?.source) return {source: opts.source, ...(opts.opName ? {opName: opts.opName} : {})};
          const agent = peekAgentOp();
          if (agent) return {source: agent.source, opName: agent.opName};
          return {source: 'user', opName: COMMAND_LABELS[cmd.kind]};
        },
        bumpEpoch: bumpCommandEpoch,
      },
      cmd,
    );
  },

  // 拖拽事务括号：开 = before 快照 + 手动作用域；收 = 判等入史（与 executeTimelineCommand 同语义）
  beginDragTransaction: (opName) => {
    const before = takeSnapshot(get());
    const endScope = beginSuppressedScope();
    let done = false;
    return () => {
      if (done) return false;
      done = true;
      endScope();
      if (snapshotsEqual(before, takeSnapshot(get()))) return false;
      const agent = peekAgentOp();
      const label = agent
        ? {source: agent.source as HistorySource, opName: agent.opName}
        : {source: 'user' as const, opName: opName ?? '拖拽编辑'};
      get().pushHistory({...before, source: label.source, ...(label.opName ? {opName: label.opName} : {})});
      bumpCommandEpoch();
      return true;
    };
  },

  undo: () => {
    if (get().historyPast.length === 0) return;
    // 先把工作副本中未同步的编辑（如打字到一半）刷入 segments，
    // 保证压入重做栈的「当前状态」快照双份一致、redo 能完整还原
    suppressNextHistory();
    get().syncCurrentToSegment();
    const s = get();
    const snap = s.historyPast[s.historyPast.length - 1];
    // 恢复后片段数可能变少，活动下标需钳制
    const newActive = Math.min(s.activeSegmentIndex, Math.max(snap.segments.length - 1, 0));
    // 快照记录的活动下标与恢复后一致时，用快照里的工作副本字段恢复工作副本
    //（保留「打字到一半」级别的撤销粒度，否则会多退一档）；
    // 不一致（快照对应别的片段）时才从恢复后的活动片段重载
    const restoreWorkingCopy = snap.activeSegmentIndex === newActive;
    suppressNextHistory();
    set({
      historyPast: s.historyPast.slice(0, -1),
      historyFuture: [...s.historyFuture, takeSnapshot(s)],
      segments: snap.segments,
      bgm: snap.bgm,
      sfx: snap.sfx,
      texture: snap.texture,
      beatPulse: snap.beatPulse,
      cursor: snap.cursor,
      logo: snap.logo,
      captionStyle: snap.captionStyle,
      finePrint: snap.finePrint,
      colorGrade: snap.colorGrade,
      brandColor: snap.brandColor,
      fontMood: snap.fontMood,
      aspectRatioId: snap.aspectRatioId,
      orientation: snap.orientation,
      publish: deepClone(snap.publish),
      activeSegmentIndex: newActive,
      ...(restoreWorkingCopy
        ? {
            templateId: snap.templateId,
            videos: snap.videos,
            text: snap.text,
            style: snap.style,
            layout: snap.layout,
            customParams: snap.customParams,
          }
        : {}),
    });
    if (!restoreWorkingCopy) {
      // 以恢复后的活动片段为准刷新工作副本，保持双份状态一致
      suppressNextHistory();
      get().loadSegmentToCurrent(newActive);
    }
  },

  redo: () => {
    if (get().historyFuture.length === 0) return;
    suppressNextHistory();
    get().syncCurrentToSegment();
    const s = get();
    const snap = s.historyFuture[s.historyFuture.length - 1];
    const newActive = Math.min(s.activeSegmentIndex, Math.max(snap.segments.length - 1, 0));
    // 与 undo 同理：快照的活动下标与恢复后一致时，直接恢复快照里的工作副本
    const restoreWorkingCopy = snap.activeSegmentIndex === newActive;
    suppressNextHistory();
    set({
      historyPast: [...s.historyPast, takeSnapshot(s)],
      historyFuture: s.historyFuture.slice(0, -1),
      segments: snap.segments,
      bgm: snap.bgm,
      sfx: snap.sfx,
      texture: snap.texture,
      beatPulse: snap.beatPulse,
      cursor: snap.cursor,
      logo: snap.logo,
      captionStyle: snap.captionStyle,
      finePrint: snap.finePrint,
      colorGrade: snap.colorGrade,
      brandColor: snap.brandColor,
      fontMood: snap.fontMood,
      aspectRatioId: snap.aspectRatioId,
      orientation: snap.orientation,
      publish: deepClone(snap.publish),
      activeSegmentIndex: newActive,
      ...(restoreWorkingCopy
        ? {
            templateId: snap.templateId,
            videos: snap.videos,
            text: snap.text,
            style: snap.style,
            layout: snap.layout,
            customParams: snap.customParams,
          }
        : {}),
    });
    if (!restoreWorkingCopy) {
      suppressNextHistory();
      get().loadSegmentToCurrent(newActive);
    }
  },

  // ====== 片段 Actions ======
  addSegment: (templateId) =>
    set((s) => {
      const newSegment = createEmptySegment(templateId || nextSegmentTemplateId(s), s.orientation);
      const newSegments = [...s.segments, newSegment];
      const newIndex = newSegments.length - 1;
      // 将新片段的空白内容加载到工作副本，避免显示前一片段的内容
      return {
        segments: newSegments,
        activeSegmentIndex: newIndex,
        templateId: newSegment.templateId,
        videos: [],
        text: {title: '', subtitle: '', features: [], brandName: ''},
        style: createEmptyStyle(),
        layout: {...newSegment.layout},
        customParams: {},
        ...staleEditPlanPatch(s.editPlan, '新增片段'),
      };
    }),

  removeSegment: (index) =>
    set((s) => {
      if (s.segments.length <= 1) return {}; // 至少保留一个
      const newSegments = s.segments.filter((_, i) => i !== index);
      // 活动下标跟随原活动片段：删的是它前面的片段时下标 -1；
      // 删的是活动片段本身或它后面的片段时原位不变（末尾则钳到新的最后一段）
      const newActive =
        index < s.activeSegmentIndex
          ? s.activeSegmentIndex - 1
          : Math.min(s.activeSegmentIndex, newSegments.length - 1);
      // 若删除的正是当前活动片段，工作副本仍持有已删除片段的数据，
      // 需重新加载新活动片段，避免编辑器/预览显示陈旧内容。
      // 删除非活动片段时工作副本仍然有效（活动片段只是被重新索引），无需重载。
      if (index === s.activeSegmentIndex) {
        const seg = newSegments[newActive];
        if (seg) {
          return {
            segments: newSegments,
            activeSegmentIndex: newActive,
            templateId: seg.templateId,
            videos: seg.videos.map((v) => ({...v})),
            text: {...seg.text, features: [...(seg.text.features || [])]},
            style: {...seg.style},
            layout: {...seg.layout},
            customParams: {...(seg.customParams ?? {})},
            ...staleEditPlanPatch(s.editPlan, '删除片段'),
          };
        }
      }
      return {segments: newSegments, activeSegmentIndex: newActive, ...staleEditPlanPatch(s.editPlan, '删除片段')};
    }),

  duplicateSegment: (index) => {
    // 复制活动片段：先把工作副本刷入 segments，保证副本包含未同步的编辑；
    // 与下方的插入同属一串改动，会被历史订阅合并为一条撤销记录
    if (index === get().activeSegmentIndex) {
      get().syncCurrentToSegment();
    }
    set((s) => {
      const newSegments = [...s.segments];
      const clone = {
        ...newSegments[index],
        id: genId(),
        videos: [...newSegments[index].videos],
        text: {...newSegments[index].text, features: [...(newSegments[index].text.features || [])]},
      };
      newSegments.splice(index + 1, 0, clone);
      if (index === s.activeSegmentIndex) {
        // 复制的是活动片段：切到副本，并从副本重载工作副本（内容与刚同步的一致，但引用独立）
        return {
          segments: newSegments,
          activeSegmentIndex: index + 1,
          templateId: clone.templateId,
          videos: clone.videos.map((v) => ({...v})),
          text: {...clone.text, features: [...(clone.text.features || [])]},
          style: {...clone.style},
          layout: {...clone.layout},
          customParams: {...(clone.customParams ?? {})},
          ...staleEditPlanPatch(s.editPlan, '复制片段'),
        };
      }
      // 复制非活动片段：保持当前编辑上下文不切 active；副本插在原活动片段之前时下标 +1
      const newActive = index < s.activeSegmentIndex ? s.activeSegmentIndex + 1 : s.activeSegmentIndex;
      return {segments: newSegments, activeSegmentIndex: newActive, ...staleEditPlanPatch(s.editPlan, '复制片段')};
    });
  },

  splitSegment: (index, atSec) => {
    let ok = false;
    // 单次 set：拆段产生的全部变化（含活动段工作副本跟随）一次提交，
    // 历史订阅只记一条快照，撤销一步即可还原
    set((s) => {
      const raw = s.segments[index];
      if (!raw) return {};
      const duration = raw.duration || 8;
      // 拆点钳制：两半各至少 0.5s，否则判定非法（不变更、返回 false）
      if (!Number.isFinite(atSec) || atSec < 0.5 || atSec > duration - 0.5) return {};
      ok = true;
      // 拆的是活动段时先按工作副本取最新段数据（与 syncCurrentToSegment 同字段），
      // 保证拆分基于未同步的编辑；本 set 末尾会同步把工作副本刷成前半段内容
      const isActive = index === s.activeSegmentIndex;
      const seg: Segment = isActive
        ? {...raw, templateId: s.templateId || 'RevealSlide', videos: s.videos, text: s.text, style: s.style, layout: s.layout, customParams: {...s.customParams}}
        : raw;
      // 前半段：时长截到 atSec；视频 clip 播到时间轴 atSec 对应的媒体时间（含挖段偏移，
      // trimEnd 截断、钳到素材时长内），挖段分给落在前半区间内的部分
      const first: Segment = {
        ...seg,
        videos: seg.videos.map((v) => {
          if (v.type !== 'video') return {...v};
          const ts0 = v.trimStart ?? 0;
          const te = Math.min(timelineToMediaSec(atSec, ts0, v.cuts), v.duration);
          const {first: cuts1} = splitCutsAt(v.cuts, te);
          const nc = normalizeCuts(cuts1, ts0, te);
          return {...v, trimEnd: te, cuts: nc, trimmedDuration: effectiveTrimmedDuration(ts0, te, nc)};
        }),
        duration: atSec,
      };
      // 后半段：新 id 插到 index+1；视频 clip 从原拆点媒体时间起播（trimEnd 不变），
      // 挖段分给落在后半区间内的部分；图片原样复制；文案/旁白/字幕/转场等深拷贝一份
      // （字幕保留原样，不做时间平移）
      const second: Segment = {
        ...seg,
        id: genId(),
        videos: seg.videos.map((v) => {
          if (v.type !== 'video') return {...v};
          const te = v.trimEnd ?? v.duration;
          const ts0 = v.trimStart ?? 0;
          const ts = Math.min(timelineToMediaSec(atSec, ts0, v.cuts), te);
          const {second: cuts2} = splitCutsAt(v.cuts, ts);
          const nc = normalizeCuts(cuts2, ts, te);
          return {...v, trimStart: ts, trimEnd: te, cuts: nc, trimmedDuration: effectiveTrimmedDuration(ts, te, nc)};
        }),
        text: {...seg.text, features: [...(seg.text.features || [])]},
        style: {...seg.style},
        layout: {...seg.layout},
        customParams: seg.customParams ? {...seg.customParams} : undefined,
        transitionParams: seg.transitionParams ? {...seg.transitionParams} : undefined,
        narration: seg.narration ? {...seg.narration} : undefined,
        captions: seg.captions ? seg.captions.map((c) => ({...c})) : undefined,
        duration: duration - atSec,
      };
      const segments = [...s.segments];
      segments.splice(index, 1, first, second);
      // 活动段在被拆段之后时下标 +1（内容不变）；被拆的是活动段本身时保持指向前半段
      const activeSegmentIndex = s.activeSegmentIndex >= index + 1 ? s.activeSegmentIndex + 1 : s.activeSegmentIndex;
      if (!isActive) return {segments, activeSegmentIndex, ...staleEditPlanPatch(s.editPlan, '拆分片段')};
      // 活动段工作副本跟随前半段（否则下次 syncCurrentToSegment 会用旧副本盖掉前半段的新裁剪）
      return {segments, activeSegmentIndex, videos: first.videos.map((v) => ({...v})), ...staleEditPlanPatch(s.editPlan, '拆分片段')};
    });
    return ok;
  },

  reorderSegments: (fromIndex, toIndex) =>
    set((s) => {
      const newSegments = [...s.segments];
      const [moved] = newSegments.splice(fromIndex, 1);
      newSegments.splice(toIndex, 0, moved);
      // 活动下标跟随原活动片段（按 id 找排序后的新位置），而非无条件跳到 toIndex
      const activeId = s.segments[s.activeSegmentIndex]?.id;
      const newActive = Math.max(0, newSegments.findIndex((seg) => seg.id === activeId));
      return {
        segments: newSegments,
        activeSegmentIndex: newActive,
        ...staleEditPlanPatch(s.editPlan, '移动片段'),
      };
    }),

  setActiveSegmentIndex: (activeSegmentIndex) => set({activeSegmentIndex}),

  applySegmentOrder: (order) =>
    set((s) => {
      const n = s.segments.length;
      const valid =
        Array.isArray(order) &&
        order.length === n &&
        order.every((i) => Number.isInteger(i) && i >= 0 && i < n) &&
        new Set(order).size === n;
      if (!valid) return {};
      const segments = order.map((i) => s.segments[i]);
      // 活动下标跟随原活动片段（与 reorderSegments 同语义）
      const activeId = s.segments[s.activeSegmentIndex]?.id;
      const activeSegmentIndex = Math.max(0, segments.findIndex((seg) => seg.id === activeId));
      return {segments, activeSegmentIndex, ...staleEditPlanPatch(s.editPlan, '移动片段')};
    }),

  moveVideoAcrossSegments: (fromSegment, clipIndex, toSegment, position) => {
    let ok = false;
    set((s) => {
      const from = s.segments[fromSegment];
      const to = s.segments[toSegment];
      if (!from || !to) return {};
      const clip = from.videos[clipIndex];
      if (!clip) return {};
      const fromVideos = from.videos.filter((_, i) => i !== clipIndex);
      const insertAt =
        position === undefined
          ? to.videos.length
          : Math.max(0, Math.min(to.videos.length, position));
      const toVideos =
        fromSegment === toSegment
          ? // 段内重排：在剔除后的数组上按 position 插入
            [...fromVideos.slice(0, insertAt), clip, ...fromVideos.slice(insertAt)]
          : [...to.videos.slice(0, insertAt), clip, ...to.videos.slice(insertAt)];
      const segments = [...s.segments];
      if (fromSegment === toSegment) {
        // 段内重排：toVideos 已是重排后的完整列表（fromVideos 是剔除中间态，不能直接落库）
        segments[toSegment] = {...to, videos: toVideos};
      } else {
        segments[fromSegment] = {...from, videos: fromVideos};
        segments[toSegment] = {...to, videos: toVideos};
      }
      ok = true;
      const patch: {segments: typeof segments; videos?: VideoClip[]} = {segments, ...staleEditPlanPatch(s.editPlan, '素材移动')};
      // 活动段被搬出/搬入：工作副本同步最新段素材，防下次 sync 用旧副本盖掉
      if (fromSegment === s.activeSegmentIndex) patch.videos = fromVideos.map((v) => ({...v}));
      if (toSegment === s.activeSegmentIndex) patch.videos = toVideos.map((v) => ({...v}));
      return patch;
    });
    return ok;
  },

  // 原始写（薄壳化前身）：零历史语义——命令分发表与拖拽括号内逐帧直写的唯一落点
  writeSegmentTiming: (index, patch) =>
    set((s) => {
      const seg = s.segments[index];
      if (!seg) return {};
      const next: Segment = {...seg};
      if (patch.duration !== undefined) {
        next.duration = Number.isFinite(patch.duration)
          ? Math.max(0.5, Math.min(60, Math.round(patch.duration * 10) / 10))
          : seg.duration;
      }
      if (patch.transition !== undefined) next.transition = patch.transition;
      if (patch.transitionParams !== undefined) {
        const merged: TransitionParams = {...seg.transitionParams};
        for (const [k, v] of Object.entries(patch.transitionParams) as [
          keyof TransitionParams,
          TransitionParams[keyof TransitionParams] | undefined,
        ][]) {
          if (v === undefined) delete merged[k];
          else (merged as Record<string, TransitionParams[keyof TransitionParams]>)[k] = v;
        }
        next.transitionParams = Object.keys(merged).length > 0 ? merged : undefined;
      }
      if (patch.transitionSfx !== undefined) {
        next.transitionSfx = patch.transitionSfx === null ? undefined : patch.transitionSfx;
      }
      if (next === seg) return {};
      const segments = [...s.segments];
      segments[index] = next;
      // 与 setCurrentDuration/setCurrentTransition 同款过期标记原因；转场参数微调沿袭其不标记
      let editPlanPatch: {editPlan?: EditPlan | null} = {};
      if (patch.duration !== undefined) {
        editPlanPatch = staleEditPlanPatch(s.editPlan, '片段时长修改');
      }
      if (patch.transition !== undefined) {
        editPlanPatch = staleEditPlanPatch(
          editPlanPatch.editPlan ?? s.editPlan,
          '片段转场修改',
        );
      }
      return {segments, ...editPlanPatch};
    }),

  // 命令层薄壳（M1.5 切片三）：所有外部段时序编辑经命令事务（默认同段合并键——
  // 弹层逐键/曲线连续编辑在窗内并入一笔，undo 一步撤整串）；拖拽括号内走 writeSegmentTiming
  updateSegmentDirect: (index, patch) => {
    get().runTimelineCommand({kind: 'segmentTiming', index, patch}, {coalesceKey: `segment-timing-${index}`});
  },

  // ====== M2 回写环薄动作（命令分发表转发目标；反解逻辑在 shared/plan-writeback 纯函数） ======

  // 排版字幕文字回写：反解 → text/features 局部写（文案永远可反解，永不冻结）
  applySegmentPlanText: (index, captionIndex, text) => {
    const seg = get().segments[index];
    if (!seg) return false;
    const r = solveCaptionText(seg, captionIndex, text);
    if (!r.ok) return false;
    set((s) => {
      const cur = s.segments[index];
      if (!cur) return {};
      const nextText: PromoText = {
        title: r.value.title ?? cur.text.title,
        subtitle: r.value.subtitle ?? cur.text.subtitle,
        features: r.value.features !== undefined ? [...r.value.features] : cur.text.features,
        brandName: r.value.brandName ?? cur.text.brandName,
      };
      const unchanged =
        nextText.title === cur.text.title &&
        nextText.subtitle === cur.text.subtitle &&
        nextText.brandName === cur.text.brandName &&
        (nextText.features ?? []).join('\u0000') === (cur.text.features ?? []).join('\u0000');
      if (unchanged) return {};
      const segments = [...s.segments];
      segments[index] = {...cur, text: nextText};
      return {
        segments,
        ...staleEditPlanPatch(s.editPlan, `第 ${index + 1} 段排版文案修改`),
      };
    });
    // 活动段文案改动同步工作副本（片段编辑器显示新文案）
    if (get().activeSegmentIndex === index) {
      suppressNextHistory();
      get().loadSegmentToCurrent(index);
    }
    return true;
  },

  // 排版字幕窗回写（冻结兜底）：frozen 记录 + materialized 覆盖层一次 set 原子生效
  applySegmentPlanFreeze: (index, captionIndex, startSec, endSec) => {
    const seg = get().segments[index];
    if (!seg) return false;
    const r = solveCaptionWindow(seg, captionIndex, startSec, endSec);
    if (!r.ok) return false;
    const {frozen, captions} = r.value;
    set((s) => {
      const cur = s.segments[index];
      if (!cur) return {};
      const materialized = {
        ...cur.materialized,
        captions: captions.map((w) => ({startSec: w.startSec, endSec: w.endSec})),
      };
      const next = {...cur, frozen, materialized};
      if (next.frozen === cur.frozen && next.materialized === cur.materialized) return {};
      const segments = [...s.segments];
      segments[index] = next;
      return {segments};
    });
    return true;
  },

  // 物化字幕窗原始写：拖拽括号内逐帧直写唯一落点（段必须已冻结接管；不判等不标记——括号收口判等）
  writeSegmentCaptionWindows: (index, windows) =>
    set((s) => {
      const seg = s.segments[index];
      if (!seg?.frozen || !seg.frozen.detachedFields.includes('captions')) return {};
      const segments = [...s.segments];
      segments[index] = {
        ...seg,
        materialized: {...seg.materialized, captions: windows.map((w) => ({startSec: w.startSec, endSec: w.endSec}))},
      };
      return {segments};
    }),

  // 素材窗回写：mediaIn/mediaOut ↔ trim（cuts 原样保留；既有 updateSegmentVideoTrim 管钳制）
  applySegmentPlanMediaWindow: (index, videoIndex, mediaInSec, mediaOutSec) => {
    const seg = get().segments[index];
    if (!seg) return false;
    const r = solveMediaWindow(seg, videoIndex, mediaInSec, mediaOutSec);
    if (!r.ok) return false;
    get().updateSegmentVideoTrim(index, videoIndex, r.value.trimStart, r.value.trimEnd, r.value.cuts);
    return true;
  },

  // ====== M3 L2 节拍层（v1.4 原语；命令分发表转发目标） ======

  // 规整：0.1 步进 + 段内钳制 + 排序去重（同值 ±5ms）；空组 = 清除（undefined）
  setSegmentBeats: (index, beats) =>
    set((s) => {
      const seg = s.segments[index];
      if (!seg) return {};
      const dur = seg.duration || 8;
      const sanitized =
        beats && beats.length > 0
          ? beats
              .map((b) => ({
                t: Math.max(0, Math.min(dur - 0.1, Math.round(b.t * 10) / 10)),
                kind: b.kind === 'accent' ? ('accent' as const) : ('mark' as const),
                ...(b.target ? {target: String(b.target).slice(0, 40)} : {}),
                ...(b.note ? {note: String(b.note).slice(0, 80)} : {}),
              }))
              .sort((a, b) => a.t - b.t)
              .filter((b, i, arr) => i === 0 || b.t - arr[i - 1].t > 0.05)
          : undefined;
      if (JSON.stringify(sanitized) === JSON.stringify(seg.beats ?? null)) return {};
      const segments = [...s.segments];
      segments[index] = {...seg, beats: sanitized};
      // 节拍影响模板动效时序（踩拍/逐拍生长），与时长同级标记 editPlan 过期
      return {segments, ...staleEditPlanPatch(s.editPlan, '节拍标记修改')};
    }),

  // 原始写（零历史语义）：拖拽括号内逐帧直写唯一落点（规整逻辑同上，复用 set 的纯规整段）
  writeSegmentBeats: (index, beats) => {
    get().setSegmentBeats(index, beats);
  },

  // ====== 工作副本 Actions ======
  setCurrentTemplate: (templateId) => set({templateId}),

  selectFirstTemplate: (id) =>
    set((s) => {
      const segments = [...s.segments];
      // 首个模板选择即建段：布局同步重置为该模板的默认（全屏画幅类模板避免转场焦点错位）
      const layout = layoutForTemplate(id, s.orientation);
      if (segments[0]) segments[0] = {...segments[0], templateId: id, layout};
      return {templateId: id, segments, layout};
    }),

  setCurrentVideos: (videos) => set((s) => ({videos, ...staleEditPlanPatch(s.editPlan, '当前片段素材替换')})),

  addVideosToCurrent: (videos) =>
    set((s) => ({videos: [...s.videos, ...videos], ...staleEditPlanPatch(s.editPlan, '当前片段新增素材')})),

  removeVideoFromCurrent: (index) =>
    set((s) => ({videos: s.videos.filter((_, i) => i !== index), ...staleEditPlanPatch(s.editPlan, '当前片段删除素材')})),

  updateVideoTrim: (index, trimStart, trimEnd, cuts) =>
    set((s) => {
      const updated = [...s.videos];
      if (updated[index]) {
        updated[index] = applyTrimAndCuts(updated[index], trimStart, trimEnd, cuts);
      }
      return {videos: updated, ...staleEditPlanPatch(s.editPlan, '素材裁剪或挖段')};
    }),

  updateVideoViewport: (index, viewport) =>
    set((s) => {
      const updated = [...s.videos];
      if (updated[index]) {
        updated[index] = {...updated[index], viewport};
      }
      return {videos: updated};
    }),

  updateVideoAudio: (index, muted, volume) =>
    set((s) => {
      const updated = [...s.videos];
      if (updated[index]) {
        updated[index] = {...updated[index], muted, volume};
      }
      return {videos: updated};
    }),

  /** 时间轴跨段静音：段素材与工作副本双写（时间轴视频块静音按钮 / AI patch 同款语义） */
  updateSegmentVideoAudio: (segmentIndex, videoIndex, muted) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const segVideos = seg.videos.map((vv, i) => (i === videoIndex ? {...vv, muted} : vv));
      const segments = [...s.segments];
      segments[segmentIndex] = {...seg, videos: segVideos};
      let videosNext = s.videos;
      if (s.activeSegmentIndex === segmentIndex && s.videos[videoIndex]?.muted !== muted) {
        videosNext = s.videos.map((vv, i) => (i === videoIndex ? {...vv, muted} : vv));
      }
      return {
        segments,
        ...(videosNext !== s.videos ? {videos: videosNext} : {}),
      };
    }),

  updateVideoCursorDemo: (index, seed) =>
    set((s) => {
      const updated = [...s.videos];
      const clip = updated[index];
      if (!clip) return {};
      if (seed === undefined) {
        // 清除演示轨迹：剥离内存态采样点/点击与持久化种子（含动作脚本态——同族互斥）
        const {cursorPoints: _p, cursorClicks: _c, cursorEvents: _e, cursorDemoSeed: _d, cursorActionScript: _a, cursorActionSeed: _s, ...rest} = clip;
        updated[index] = rest;
      } else {
        // 轨迹时长取素材原始时长：整段时长内任意裁剪窗口都有轨迹可查
        const demoPoints = generateDemoCursorTrack({
          durationSec: clip.duration,
          width: clip.width,
          height: clip.height,
          seed,
        });
        // 换演示种子时同族互斥：剥离动作脚本态（否则重载后 actionScript 优先级反超，演示被顶掉）
        const {cursorActionScript: _a, cursorActionSeed: _s, cursorEvents: _e, ...rest} = clip;
        updated[index] = {
          ...rest,
          cursorDemoSeed: seed,
          cursorPoints: demoPoints,
          cursorClicks: generateDemoCursorClicks(demoPoints),
        };
      }
      return {videos: updated};
    }),

  /** 声明式动作轨迹（update_segment cursorScript / UI 编辑动作共用入口）。
   *  script 空串/解析无步骤 = 清除；否则 buildCursorTrack 合成（同 seed 确定性，
   *  与随机演示轨迹互斥——设置时剥离 cursorDemoSeed）。返回 warnings 供调用方回告。 */
  updateVideoCursorTrack: (index, script) => {
    let warnings: string[] = [];
    set((s) => {
      const updated = [...s.videos];
      const clip = updated[index];
      if (!clip) return {};
      const trimmed = typeof script === 'string' ? script.trim() : '';
      if (trimmed === '') {
        const {cursorPoints: _p, cursorClicks: _c, cursorEvents: _e, cursorActionScript: _a, cursorActionSeed: _s, cursorDemoSeed: _d, ...rest} = clip;
        updated[index] = rest;
        return {videos: updated};
      }
      const parsed = parseCursorTrackScript(trimmed);
      warnings = parsed.warnings;
      if (parsed.steps.length === 0) return {}; // 无有效步骤：不动现有轨迹（调用方按 warnings 提示）
      const seed = Math.floor(Math.random() * 2 ** 31);
      const built = buildCursorTrack(parsed, {
        durationSec: clip.duration,
        width: clip.width,
        height: clip.height,
        seed,
      });
      warnings = built.warnings;
      const {cursorDemoSeed: _d, ...rest} = clip;
      updated[index] = {
        ...rest,
        cursorActionScript: trimmed,
        cursorActionSeed: seed,
        cursorPoints: built.points,
        cursorClicks: built.clicks,
        cursorEvents: built.events.length > 0 ? built.events : undefined,
      };
      return {videos: updated};
    });
    return warnings;
  },

  updateSegmentVideoTrim: (segmentIndex, videoIndex, trimStart, trimEnd, cuts) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const replace = applyTrimAndCuts(seg.videos[videoIndex], trimStart, trimEnd, cuts);
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === videoIndex ? replace : v))}
      );
      // 若改的正是当前活动段，同步工作副本
      const videos = segmentIndex === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === videoIndex ? replace : v))
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段素材裁剪或挖段`)};
    }),

  updateSegmentVideoViewport: (segmentIndex, videoIndex, viewport) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const replace = {...seg.videos[videoIndex], viewport};
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === videoIndex ? replace : v))}
      );
      const videos = segmentIndex === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === videoIndex ? replace : v))
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段素材视口调整`)};
    }),

  setSegmentVideoColorCurve: (segmentIndex, videoIndex, colorCurve) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const patch = colorCurve === undefined
        ? (() => {const {colorCurve: _c, ...rest} = seg.videos[videoIndex]; return rest;})()
        : {...seg.videos[videoIndex], colorCurve};
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === videoIndex ? patch : v))}
      );
      const videos = segmentIndex === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === videoIndex ? patch : v))
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段素材色彩曲线`)};
    }),

  setSegmentVideoSourceKind: (segmentIndex, videoIndex, sourceKind) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const patch = sourceKind === undefined
        ? (() => {const {sourceKind: _k, ...rest} = seg.videos[videoIndex]; return rest;})()
        : {...seg.videos[videoIndex], sourceKind};
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === videoIndex ? patch : v))}
      );
      const videos = segmentIndex === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === videoIndex ? patch : v))
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段素材来源类型`)};
    }),

  applyClipProxyByPath: (sourcePath, proxyPath, status) => {
    // 路径归一比较（渲染端 bundle 不能引 node:path，正斜杠化后比即可）
    const normalized = sourcePath.replace(/\\/g, '/').toLowerCase();
    const matches = (v: VideoClip): boolean => {
      try {
        return clipSrcToPath(v.src).replace(/\\/g, '/').toLowerCase() === normalized;
      } catch {
        return false;
      }
    };
    let touched = 0;
    set((s) => {
      const mapClip = (v: VideoClip): VideoClip => {
        if (!matches(v)) return v;
        touched++;
        return {...v, proxyPath: status === 'ready' ? proxyPath : v.proxyPath, proxyStatus: status};
      };
      const segments = s.segments.map((sg) => ({...sg, videos: sg.videos.map(mapClip)}));
      const videos = s.videos.map(mapClip);
      const mediaPool = s.mediaPool.map(mapClip);
      // 纯内存态回写（代理进度不产生撤销点、不算工程 dirty）
      return {segments, videos, mediaPool};
    });
    return touched;
  },

  addVideosToSegment: (segmentIndex, videosToAdd) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || videosToAdd.length === 0) return {};
      const appended = [...seg.videos, ...videosToAdd];
      // 「屏幕录制」模板（原样导出）：素材即成片，段时长自动对齐素材可用时长，
      // 免得默认 8s 把长录像截断（用户随后可在时间线再调）
      const onlyVideo = appended.length === 1 ? appended[0] : undefined;
      const durationPatch =
        seg.templateId === 'ScreenRecord' && onlyVideo?.type === 'video' && typeof onlyVideo.trimmedDuration === 'number'
          ? {duration: Math.max(0.5, Math.round(onlyVideo.trimmedDuration * 10) / 10)}
          : {};
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: appended, ...durationPatch}
      );
      // 若加的正是当前活动段，同步工作副本（与 updateSegmentVideoTrim 同模式）
      const videos = segmentIndex === s.activeSegmentIndex
        ? [...s.videos, ...videosToAdd]
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段新增素材`)};
    }),

  removeVideoFromSegment: (segmentIndex, videoIndex) =>
    set((s) => {
      const seg = s.segments[segmentIndex];
      if (!seg || !seg.videos[videoIndex]) return {};
      const segments = s.segments.map((sg, si) =>
        si !== segmentIndex ? sg : {...sg, videos: sg.videos.filter((_, vi) => vi !== videoIndex)}
      );
      // 若移的正是当前活动段，同步工作副本（与 addVideosToSegment 同模式）
      const videos = segmentIndex === s.activeSegmentIndex
        ? s.videos.filter((_, vi) => vi !== videoIndex)
        : s.videos;
      return {segments, videos, ...staleEditPlanPatch(s.editPlan, `第 ${segmentIndex + 1} 段删除素材`)};
    }),

  setVideoStabilization: (clipIndex, payload, segmentIndex) =>
    set((s) => {
      const si = segmentIndex ?? s.activeSegmentIndex;
      const seg = s.segments[si];
      if (!seg || !seg.videos[clipIndex]) return {};
      const clip = seg.videos[clipIndex];
      // 先剥离旧稳定数据（持久化 + 内存态），再按需写入新值——保证「移除」语义干净
      const {stabilization: _stab, stabCorrections: _c, stabZoom: _z, stabSampleFps: _f, ...rest} = clip;
      // 内存态三字段：payload 给出则覆盖，省略则保留旧值（AI 开关稳定/调强度不清数据）
      const stabCorrections = payload.stabCorrections ?? _c;
      const stabZoom = payload.stabZoom ?? _z;
      const stabSampleFps = payload.stabSampleFps ?? _f;
      const replace: VideoClip = payload.stabilization
        ? {
            ...rest,
            stabilization: payload.stabilization,
            ...(stabCorrections ? {stabCorrections} : {}),
            ...(stabZoom !== undefined ? {stabZoom} : {}),
            ...(stabSampleFps !== undefined ? {stabSampleFps} : {}),
          }
        : rest;
      const segments = s.segments.map((sg, i) =>
        i !== si ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === clipIndex ? replace : v))}
      );
      // 若改的正是当前活动段，同步工作副本（与 updateSegmentVideoTrim 同模式）
      const videos = si === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === clipIndex ? replace : v))
        : s.videos;
      return {segments, videos};
    }),

  setGroundTrack: (clipIndex, payload, segmentIndex) =>
    set((s) => {
      const si = segmentIndex ?? s.activeSegmentIndex;
      const seg = s.segments[si];
      if (!seg || !seg.videos[clipIndex]) return {};
      const clip = seg.videos[clipIndex];
      // 同 setVideoStabilization 语义：undefined = 移除；内存态省略 = 保留
      const {groundTrack: _gt, groundData: _gd, ...rest} = clip;
      const groundData = payload.groundData ?? _gd;
      const replace: VideoClip = payload.groundTrack
        ? {...rest, groundTrack: payload.groundTrack, ...(groundData ? {groundData} : {})}
        : rest;
      const segments = s.segments.map((sg, i) =>
        i !== si ? sg : {...sg, videos: sg.videos.map((v, vi) => (vi === clipIndex ? replace : v))}
      );
      const videos = si === s.activeSegmentIndex
        ? s.videos.map((v, vi) => (vi === clipIndex ? replace : v))
        : s.videos;
      return {segments, videos};
    }),

  setSegmentGroundElements: (segmentIndex, elements) =>
    set((s) => {
      const segments = s.segments.map((sg, i) =>
        i !== segmentIndex ? sg : {...sg, groundElements: elements.length > 0 ? elements : undefined}
      );
      return {segments};
    }),

  updateCurrentText: (text) =>
    set((s) => ({text: {...s.text, ...text}})),

  updateCurrentStyle: (style) =>
    set((s) => ({style: {...s.style, ...style}})),

  updateCurrentLayout: (layout) =>
    set((s) => ({layout: {...s.layout, ...layout}})),

  updateCurrentCustomParam: (key, value) =>
    set((s) => {
      const customParams = {...s.customParams};
      if (value === undefined) delete customParams[key];
      else customParams[key] = value;
      return {customParams};
    }),

  setCurrentDuration: (duration) =>
    set((s) => {
      // 钳到 0.5~60 秒（非法输入回退默认 8 秒），避免异常时长炸掉 Remotion 渲染；0.5 起步支持快切蒙太奇
      const clamped = Number.isFinite(duration) ? Math.max(0.5, Math.min(60, duration)) : 8;
      const updated = [...s.segments];
      if (updated[s.activeSegmentIndex]) {
        updated[s.activeSegmentIndex] = {...updated[s.activeSegmentIndex], duration: clamped};
      }
      return {segments: updated, ...staleEditPlanPatch(s.editPlan, '片段时长修改')};
    }),

  /** 模板播放起点（秒）；0/负数时清除字段回到从头播放 */
  setCurrentStartOffset: (offsetSec) =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[s.activeSegmentIndex]) {
        updated[s.activeSegmentIndex] = {
          ...updated[s.activeSegmentIndex],
          startOffsetSec: offsetSec > 0 ? offsetSec : undefined,
        };
      }
      return {segments: updated, ...staleEditPlanPatch(s.editPlan, '片段素材起点修改')};
    }),

  setCurrentTransition: (transition) =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[s.activeSegmentIndex]) {
        updated[s.activeSegmentIndex] = {...updated[s.activeSegmentIndex], transition};
      }
      return {segments: updated, ...staleEditPlanPatch(s.editPlan, '片段转场修改')};
    }),

  setCurrentTransitionParams: (params) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[s.activeSegmentIndex];
      if (!seg) return {segments: updated};
      const merged: TransitionParams = {...seg.transitionParams};
      for (const [k, v] of Object.entries(params) as [keyof TransitionParams, TransitionParams[keyof TransitionParams] | undefined][]) {
        if (v === undefined) delete merged[k];
        else (merged as Record<string, TransitionParams[keyof TransitionParams]>)[k] = v;
      }
      // 全部参数都被清除时移除整个字段，保持数据干净
      updated[s.activeSegmentIndex] = {
        ...seg,
        transitionParams: Object.keys(merged).length > 0 ? merged : undefined,
      };
      return {segments: updated};
    }),

  setCurrentVideoEffect: (videoEffect) =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[s.activeSegmentIndex]) {
        updated[s.activeSegmentIndex] = {...updated[s.activeSegmentIndex], videoEffect};
      }
      return {segments: updated};
    }),

  setCurrentBackgroundEffect: (backgroundEffect) =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[s.activeSegmentIndex]) {
        updated[s.activeSegmentIndex] = {...updated[s.activeSegmentIndex], backgroundEffect};
      }
      return {segments: updated};
    }),

  setCurrentTextAnim: (anim) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[s.activeSegmentIndex];
      if (!seg) return {segments: updated};
      updated[s.activeSegmentIndex] = {
        ...seg,
        textAnim: anim === undefined ? undefined : anim,
      };
      return {segments: updated};
    }),

  setCurrentExitStyle: (exitStyle) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[s.activeSegmentIndex];
      if (!seg) return {segments: updated};
      updated[s.activeSegmentIndex] = {
        ...seg,
        exitStyle: exitStyle === undefined ? undefined : exitStyle,
      };
      return {segments: updated};
    }),

  setCurrentTransitionSfx: (sfx) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[s.activeSegmentIndex];
      if (!seg) return {segments: updated};
      updated[s.activeSegmentIndex] = {...seg, transitionSfx: sfx};
      return {segments: updated};
    }),

  updateSegmentNarration: (index, patch) =>
    set((s) => {
      const updated = [...s.segments];
      const seg = updated[index];
      if (!seg) return {segments: updated};
      const prev = seg.narration || {text: ''};
      // 合并 patch；显式传 undefined 的键表示清除该键
      const next: SegmentNarration = {...prev};
      for (const [k, v] of Object.entries(patch) as [keyof SegmentNarration, SegmentNarration[keyof SegmentNarration]][]) {
        if (v === undefined) {
          delete next[k];
        } else {
          (next as unknown as Record<string, unknown>)[k] = v;
        }
      }
      updated[index] = {...seg, narration: next};
      return {segments: updated};
    }),

  clearSegmentNarration: (index) =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[index]) {
        updated[index] = {...updated[index], narration: undefined};
      }
      return {segments: updated};
    }),

  // ====== 同步工作副本 ↔ 故事板 ======
  syncCurrentToSegment: () =>
    set((s) => {
      const updated = [...s.segments];
      if (updated[s.activeSegmentIndex]) {
        updated[s.activeSegmentIndex] = {
          ...updated[s.activeSegmentIndex],
          templateId: s.templateId || 'RevealSlide',
          videos: s.videos,
          text: s.text,
          style: s.style,
          layout: s.layout,
          customParams: {...s.customParams},
        };
      }
      return {segments: updated};
    }),

  loadSegmentToCurrent: (index) => {
    if (!get().segments[index]) return;
    // 导航性重载（切换片段/加载工程/AI 改动后刷新）：工作副本被替换不代表用户编辑了
    // 内容，豁免置脏——内容变化都由伴随的 segments 变化负责置脏。必须在 set 前调用
    // （抑制标记会被紧随其后的这次 set 消费），且只在确定会 set 时调用，避免泄漏。
    suppressNextDirty();
    set((s) => {
      const seg = s.segments[index];
      if (!seg) return {};
      // 深拷贝避免引用共享
      return {
        activeSegmentIndex: index,
        templateId: seg.templateId,
        videos: seg.videos.map((v) => ({...v})),
        text: {...seg.text, features: [...(seg.text.features || [])]},
        style: {...seg.style},
        layout: {...seg.layout},
        customParams: {...(seg.customParams ?? {})},
      };
    });
  },

  // ====== AI 助手 Actions ======
  // 注意：这里【不】调 suppressNextHistory / suppressNextDirty——
  // AI 改故事板属于内容变化，应自然产生一条历史快照并置脏，用户可撤销 AI 操作。
  applyAiStoryboard: (specs) => {
    const segments: Segment[] = specs.map((spec) => ({
      id: genId(),
      templateId: spec.templateId,
      videos: [], // AI 不提供素材，由用户后续上传录屏/图片
      text: {...spec.text, features: [...spec.text.features]},
      style: createEmptyStyle(),
      layout: layoutForTemplate(spec.templateId, get().orientation),
      duration: spec.duration,
      transition: spec.transition,
      videoEffect: spec.videoEffect,
      backgroundEffect: spec.backgroundEffect,
      textAnim: spec.textAnim, // undefined = 模板默认
      exitStyle: spec.exitStyle, // undefined = sync 同步退场
      narration: spec.narration && spec.narration.text ? {text: spec.narration.text} : undefined,
      captions: spec.captions && spec.captions.length > 0 ? spec.captions.map((c) => ({...c})) : undefined,
      customParams: spec.customParams ? {...spec.customParams} : undefined, // undefined = 全走模板默认
      transitionParams: spec.transitionParams ? {...spec.transitionParams} : undefined, // undefined = 转场全走默认
    }));
    // 故事板整体被替换（AI 编排/混剪）：不再是示例工程（「一键换素材」提示条随之消失）
    set({segments, editPlan: null, isSampleProject: false});
    get().loadSegmentToCurrent(0);
  },

  applyMontageSegments: (segments) => {
    set({segments, editPlan: null, isSampleProject: false});
    get().loadSegmentToCurrent(0);
  },

  applyAiSegmentPatch: (index, patch) => {    set((s) => {
      const seg = s.segments[index];
      if (!seg) return {};
      const segments = [...s.segments];
      // 部分更新语义：patch 中为 undefined 的字段一律保留片段现有值，明确给出的字段才覆盖；
      // 素材（videos）、style、layout 始终保留不动；customParams 给出时按键合并（给出的键覆盖，其余保留）
      const patchText = patch.text;
      segments[index] = {
        ...seg,
        templateId: patch.templateId ?? seg.templateId, // patch 缺省 = 保留原模板
        customParams: patch.customParams !== undefined ? {...seg.customParams, ...patch.customParams} : seg.customParams,
        // 文案同样按子字段部分更新：缺省子字段保留原值，空串 = 显式清空
        text:
          patchText !== undefined
            ? {
                title: patchText.title ?? seg.text.title,
                subtitle: patchText.subtitle ?? seg.text.subtitle,
                features: patchText.features !== undefined ? [...patchText.features] : seg.text.features,
                brandName: patchText.brandName ?? seg.text.brandName,
              }
            : seg.text,
        duration: patch.duration ?? seg.duration,
        transition: patch.transition ?? seg.transition,
        transitionParams: patch.transitionParams !== undefined ? {...seg.transitionParams, ...patch.transitionParams} : seg.transitionParams,
        videoEffect: patch.videoEffect ?? seg.videoEffect,
        backgroundEffect: patch.backgroundEffect ?? seg.backgroundEffect,
        textAnim: patch.textAnim !== undefined ? patch.textAnim : seg.textAnim,
        exitStyle: patch.exitStyle !== undefined ? patch.exitStyle : seg.exitStyle,
        captions:
          patch.captions !== undefined
            ? patch.captions.length > 0
              ? patch.captions.map((c) => ({...c}))
              : undefined // 空数组 = 清除字幕
            : seg.captions,
        narration:
          patch.narration !== undefined
            ? patch.narration.text
              ? {text: patch.narration.text, ...(seg.narration?.src ? {src: seg.narration.src, path: seg.narration.path, duration: seg.narration.duration, source: seg.narration.source, volume: seg.narration.volume} : {})}
              : undefined // 空 text = 清除旁白
            : seg.narration,
      };
      // 鼠标动作脚本：作用于段内第一段素材（合成/清除声明式动作轨迹；与随机演示互斥）。
      // 段素材（持久化 cursorActionScript/Seed）与工作副本 videos（预览消费）双写。
      let videosNext = s.videos;
      if (patch.cursorScript !== undefined && segments[index].videos[0]) {
        const v0 = segments[index].videos[0];
        const script = patch.cursorScript.trim();
        let next0: VideoClip | null = null;
        if (script === '') {
          const {cursorPoints: _p, cursorClicks: _c, cursorEvents: _e, cursorActionScript: _a, cursorActionSeed: _s, cursorDemoSeed: _d, ...rest} = v0;
          next0 = rest;
        } else {
          const parsed = parseCursorTrackScript(script);
          if (parsed.steps.length > 0) {
            const seed = Math.floor(Math.random() * 2 ** 31);
            const built = buildCursorTrack(parsed, {durationSec: v0.duration, width: v0.width, height: v0.height, seed});
            const {cursorDemoSeed: _d, ...rest} = v0;
            next0 = {...rest, cursorActionScript: script, cursorActionSeed: seed, cursorPoints: built.points, cursorClicks: built.clicks, ...(built.events.length > 0 ? {cursorEvents: built.events} : {})};
          }
        }
        if (next0) {
          segments[index] = {...segments[index], videos: [next0, ...segments[index].videos.slice(1)]};
          if (s.activeSegmentIndex === index) {
            videosNext = s.videos[0] ? [next0, ...s.videos.slice(1)] : s.videos;
          }
        }
      }
      // 素材原声控制：muted/volume 作用于段内第一段素材（与 cursorScript 独立可同 patch）
      if ((patch.muted !== undefined || patch.volume !== undefined) && segments[index].videos[0]) {
        const v0 = segments[index].videos[0];
        const next0: VideoClip = {
          ...v0,
          ...(patch.muted !== undefined ? {muted: patch.muted} : {}),
          ...(patch.volume !== undefined ? {volume: patch.volume} : {}),
        };
        segments[index] = {...segments[index], videos: [next0, ...segments[index].videos.slice(1)]};
        const base = videosNext !== s.videos ? videosNext : s.videos;
        if (s.activeSegmentIndex === index && base[0]) {
          videosNext = [next0, ...base.slice(1)];
        }
      }
      return {
        segments,
        ...(videosNext !== s.videos ? {videos: videosNext} : {}),
        editPlan: s.editPlan
          ? {
              ...s.editPlan,
              stale: true,
              staleReason: `segment ${index} updated`,
              validation: s.editPlan.validation
                ? {
                    ...s.editPlan.validation,
                    warnings: [...s.editPlan.validation.warnings, `EditPlan 已因第 ${index + 1} 段修改而过期`],
                  }
                : s.editPlan.validation,
            }
          : s.editPlan,
      };
    });
    // 若改的是当前活动段，同步工作副本，避免编辑器显示旧数据
    if (get().activeSegmentIndex === index) {
      get().loadSegmentToCurrent(index);
    }
  },

  setOrientation: (orientation) => set({orientation}),

  setAspectRatioId: (id) => {
    const preset = getAspectRatioPreset(id);
    set({aspectRatioId: preset.id, orientation: preset.orientation});
  },

  // ====== 派生数据 ======
  getTotalDuration: () => {
    return get().segments.reduce((sum, seg) => sum + seg.duration, 0);
  },
}));
