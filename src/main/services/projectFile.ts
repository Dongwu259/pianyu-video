/**
 * 工程文件（.vtproj）读写服务
 *
 * 说明:
 * - 本模块只做纯逻辑（组装 / 解析 / 校验 / 迁移 / 媒体存在性检查 / 原子写盘），
 *   不 import electron，因此可以在纯 Node 环境直接做单元测试；
 *   文件对话框等 Electron 交互在 src/main/index.ts 的 IPC 里完成。
 * - 工程文件为 UTF-8 JSON，媒体以外链原始路径引用（不打包媒体本体）。
 * - 注意: 片段素材 VideoClip.src 在内存中是本地视频服务器 URL
 *   （http://127.0.0.1:端口/video?path=...，端口每会话随机），
 *   渲染进程在序列化时已将其还原为原始路径，本模块只负责透传。
 */

import fs from 'fs';
import type {Segment, VideoClip, BgmTrack, RenderOptions, Orientation, LogoConfig, CaptionStyle, FinePrintConfig, ColorGrade, SfxConfig, TexturePreset, PublishKit, FontMoodId} from '../../shared/types';
import type {VideoType} from '../../shared/video-type';
import type {MediaTag} from '../../shared/media-tags';
import type {MediaIntelligenceIndex} from '../../shared/media-intelligence';
import type {EditPlan} from '../../shared/edit-plan';
import type {GeneratedTemplateDef} from '../../shared/generated-template';

/** 工程文件标识字段 */
export const PROJECT_FILE_APP = 'promo-video-generator';
export const PROJECT_FILE_FORMAT = 'vtproj';
/**
 * 当前工程文件格式版本（加载更高版本时报错，更低版本走迁移链）。
 * 注意：纯增量、可安全忽略的新可选字段（如 Segment.transitionParams）不升版本——
 * 旧版本软件打开新文件时忽略该字段即可，保证新旧版本互相兼容。
 */
export const PROJECT_FILE_VERSION = 1;

/** 工程文件中持久化的故事板数据 */
export interface ProjectFileData {
  aspectRatioId: string;
  orientation: Orientation;
  /** 视频体裁（AI 剧本/模板推荐口径；可选新增字段，旧版软件忽略，不升格式版本） */
  videoType?: VideoType;
  /** 体裁由谁设定（P0-1 采痕卫生：user/agent/auto；缺省 = 旧工程，加载时按 user 处理） */
  videoTypeSource?: 'user' | 'agent' | 'auto';
  segments: Segment[];
  /** 背景音乐（不含 src，加载时由 path 重建） */
  bgm: Omit<BgmTrack, 'src'> | null;
  /** 用户品牌 Logo（不含 src，加载时由 path 重建） */
  logo: Omit<LogoConfig, 'src'> | null;
  /** 字幕样式（项目级） */
  captionStyle: CaptionStyle;
  /** 边缘小字/免责声明（项目级；可选新增字段，旧版软件忽略，不升格式版本） */
  finePrint?: FinePrintConfig;
  /** 音效配置（项目级；可选新增字段，旧版软件忽略，不升格式版本） */
  sfx?: SfxConfig;
  /** 画面质感预设（项目级；可选新增字段，旧版软件忽略） */
  texture?: TexturePreset;
  /** 节拍脉冲开关（项目级；可选新增字段，旧版软件忽略） */
  beatPulse?: boolean;
  /** 美化光标开关（项目级；可选新增字段，旧版软件忽略） */
  cursor?: boolean;
  /** 色彩统一（项目级；可选新增字段，旧版软件忽略） */
  colorGrade?: ColorGrade;
  /** 品牌色（项目级 #rrggbb，null/缺省 = 默认蓝；可选新增字段，旧版软件忽略） */
  brandColor?: string | null;
  /** 字体氛围预设（项目级；可选新增字段，旧版软件忽略） */
  fontMood?: FontMoodId;
  /** 发布准备：封面配置 + 发布元数据（项目级；可选新增字段，旧版软件忽略） */
  publish?: PublishKit;
  /** 素材视觉打标（key = 素材原始路径；可选新增字段，旧版软件忽略） */
  mediaTags?: Record<string, MediaTag>;
  /** 统一素材智能索引（可选；旧工程缺省为空） */
  mediaIntelligence?: MediaIntelligenceIndex;
  /** 正式可验证的 beat/scene/shot 编辑计划（可选；旧工程缺省为空） */
  editPlan?: EditPlan;
  /**
   * AI 生成模板嵌入副本（可选；应用内不落 vtproj——生成模板是应用级资产，
   * 本字段仅供 RENDER_SAMPLE 头less渲染/工程分享时自带模板，缺省回退应用级模板库）
   */
  generatedTemplates?: GeneratedTemplateDef[];
  /** 项目素材库（全局素材池；src 为原始路径，内存态字段已剥离。可选新增字段，旧版软件忽略，不升格式版本） */
  mediaPool?: VideoClip[];
  /** 基建④ 撤销历史持久化（可选新增字段，旧版软件忽略，不升格式版本）：显式保存时由渲染端
   *  降级序列化（clip src→原始路径、内存态剥离，各栈 ≤50 条）；结构语义归渲染端
   *  projectStore/historyUtils——主进程只 verbatim 透传，读侧校验只认 segments。 */
  history?: {past: unknown[]; future: unknown[]};
  renderSettings: RenderOptions;
  activeSegmentIndex: number;
}

/** .vtproj 文件完整结构 */
export interface ProjectFilePayload {
  app: string;
  format: string;
  version: number;
  name: string;
  savedAt: string;
  data: ProjectFileData;
}

/** 打开工程的结果（主进程 IPC 返回给渲染进程） */
export interface OpenProjectResult {
  success: boolean;
  /** 工程文件路径 */
  path?: string;
  /** 工程名 */
  name?: string;
  data?: ProjectFileData;
  /** 缺失媒体的原始路径清单 */
  missingMedia?: string[];
  error?: string;
}

/** 组装带头部字段的工程文件对象 */
export const buildProjectFile = (name: string, data: ProjectFileData): ProjectFilePayload => ({
  app: PROJECT_FILE_APP,
  format: PROJECT_FILE_FORMAT,
  version: PROJECT_FILE_VERSION,
  name,
  savedAt: new Date().toISOString(),
  data,
});

/**
 * 版本迁移链：v1 为起始版本，暂无需迁移，保留脚手架。
 * 未来格式升级时在此按版本号逐级迁移，例如:
 *   if (payload.version === 1) { ...; payload.version = 2; }
 */
const migrateProject = (payload: ProjectFilePayload): ProjectFilePayload => payload;

/** 校验工程文件结构，失败时抛带中文信息的 Error */
const validatePayload = (obj: unknown): ProjectFilePayload => {
  const p = obj as Partial<ProjectFilePayload> | null;
  if (!p || typeof p !== 'object') {
    throw new Error('该文件不是本软件的工程文件');
  }
  if (p.app !== PROJECT_FILE_APP || p.format !== PROJECT_FILE_FORMAT) {
    throw new Error('该文件不是本软件的工程文件');
  }
  if (typeof p.version !== 'number') {
    throw new Error('工程文件缺少版本信息，可能已损坏');
  }
  if (p.version > PROJECT_FILE_VERSION) {
    throw new Error(`该工程由更新版本的软件创建（格式 v${p.version}），请升级软件后再打开`);
  }
  const data = p.data as ProjectFileData | undefined;
  if (!data || !Array.isArray(data.segments)) {
    throw new Error('工程文件内容不完整，片段数据缺失或已损坏');
  }
  for (const seg of data.segments) {
    if (!seg || typeof seg.templateId !== 'string' || !Array.isArray(seg.videos) || !seg.text) {
      throw new Error('工程文件内容不完整，片段数据缺失或已损坏');
    }
  }
  return p as ProjectFilePayload;
};

/** 解析工程文件文本内容（含结构校验与版本迁移），失败时抛带中文信息的 Error */
export const parseProjectFile = (raw: string): ProjectFilePayload => {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('工程文件已损坏或不是有效的 JSON 文件');
  }
  const payload = validatePayload(obj);
  if (payload.version < PROJECT_FILE_VERSION) {
    return {...migrateProject(payload), version: PROJECT_FILE_VERSION};
  }
  return payload;
};

/** 原子写入工程文件：先写 filePath + '.tmp' 再重命名，防止写一半损坏 */
export const saveProjectFile = (filePath: string, payload: ProjectFilePayload): void => {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
};

/** 读取并解析工程文件 */
export const readProjectFile = (filePath: string): ProjectFilePayload => {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseProjectFile(raw);
};

/** 收集工程数据中引用的全部媒体原始路径（片段素材 + 背景音乐 + 导入旁白） */
export const collectMediaPaths = (data: ProjectFileData): string[] => {
  const paths: string[] = [];
  for (const seg of data.segments) {
    for (const clip of seg.videos) {
      if (clip.src) paths.push(clip.src);
      // 鼠标轨迹 sidecar 一并做存在性检查（缺失走既有媒体缺失提示路径，不阻断加载）
      if (clip.cursorTrack) paths.push(clip.cursorTrack);
      // UI 区域 sidecar（拆层飞出）同机制
      if (clip.uiRegionsTrack) paths.push(clip.uiRegionsTrack);
    }
    // 仅导入型旁白参与媒体存在性检查；tts 文件在 userData 缓存，跨机不迁移
    if (seg.narration?.source === 'import' && seg.narration.path) {
      paths.push(seg.narration.path);
    }
  }
  if (data.bgm?.path) paths.push(data.bgm.path);
  if (data.logo?.path) paths.push(data.logo.path);
  // 素材库条目一并检查存在性（缺失的条目加载时静默丢弃，但样本复制/缺失检测要拿到完整清单）
  for (const clip of data.mediaPool ?? []) {
    if (clip.src) paths.push(clip.src);
  }
  return paths;
};

/** 批量检查媒体路径存在性，返回缺失路径数组 */
export const checkMediaMissing = (paths: string[]): string[] =>
  paths.filter((p) => !fs.existsSync(p));
