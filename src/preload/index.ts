/**
 * Preload 脚本 - 通过 contextBridge 安全地将主进程能力暴露给渲染进程
 */

import {contextBridge, ipcRenderer, webUtils} from 'electron';
import {IPC_CHANNELS} from '../shared/ipc-channels';
import type {VideoClip, TemplateProps, MultiSegmentProps, RenderOptions, RenderEncoderUsed, LicenseStatus, LicenseActivateResult, CaptionLine, UpdateCheckResult, UpdateStatusEvent, SfxSources, CoverConfig} from '../shared/types';
import type {CustomTemplateDef} from '../shared/custom-template';
import type {TemplatePack, MarketCatalogEntryWithStatus} from '../shared/template-pack';
import type {ProjectFileData, OpenProjectResult} from '../main/services/projectFile';
import type {LlmChatMessage, LlmChatRequest, LlmStatus, TtsStatus, TtsSynthesizeRequest, TtsSynthesizeResult} from '../shared/llm-chat';
import type {AsrStatus, AsrTranscribeRequest} from '../shared/asr';
import type {StockSearchRequest, StockDownloadRequest, StockMediaItem} from '../shared/stock-media';
import type {ImageGenRequest, ImageGenResult, ImageGenStatus} from '../shared/image-gen';
import type {ModelGenRequest, ModelGenStatus, ModelGenTaskSnapshot} from '../shared/model-gen';
import type {AudioReviewReport} from '../shared/audio-review';
import type {SourceTimeline} from '../main/services/highlightMining';
import type {CaptureSourceInfo, CaptureSaveResult, CaptureScreenshotResult, CursorClick, CursorPoint, CursorPollResult, CursorTrackFile, ElementClipRect, InputHookEvent, WindowRectSample} from '../shared/capture';
import type {UiRegionsFile} from '../shared/ui-regions';
import type {StabPoint} from '../shared/stabilization';
import type {StabAnalyzeOpts, StabAnalyzeResult, StabTrackSidecar} from '../main/services/stabilization';
import {MCP_CHANNELS} from '../shared/mcp';
import type {McpAgentId, McpAgentListResult, McpAgentInstallResult, McpBridgeRequest, McpBridgeResponse, McpServerStatus} from '../shared/mcp';
import {COMPUTER_USE_CHANNELS} from '../shared/computer-use';
import type {ComputerPlayScriptRequest, ComputerRunTaskRequest, ComputerTaskStatus, ComputerTaskStopResult, ComputerTaskSubmitResult, ComputeUseSidecarStatus} from '../shared/computer-use';

/** 保存工程 IPC 的返回结构 */
export interface SaveProjectResult {
  success: boolean;
  path?: string;
  error?: string;
  /** 用户在保存对话框点了取消 */
  canceled?: boolean;
  /** 覆盖保存前的滚动备份失败告警（保存本身已成功；见 main/services/projectBackup.ts） */
  backupWarning?: string;
}

// 暴露给 renderer 的 API 对象
const api = {
  // ====== 文件操作 ======
  selectVideos: (): Promise<(VideoClip & {codecWarning?: string; colorCurveGuessNote?: string; proxyQueued?: boolean})[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SELECT_Videos),

  selectOutputDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SELECT_OUTPUT_DIR),

  getVideoMetadata: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_GET_VIDEO_METADATA, filePath),

  /** 读取录屏素材的鼠标轨迹 sidecar（<同名>.cursor.json；缺失/损坏返回 null） */
  readCursorTrack: (videoPath: string): Promise<import('../shared/capture').CursorTrackFile | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_CURSOR_TRACK, videoPath),

  /**
   * 从 File 对象获取真实本地路径（用于拖放上传）
   * Electron 的 webUtils.getPathForFile() 可从 File 对象提取 path
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // 非 Electron 环境（浏览器 fallback）- 无法获取路径
      return '';
    }
  },

  /**
   * 将本地文件路径转换为 HTTP URL（用于 Remotion 渲染的视频源）
   * 因为 headless Chromium 阻止 file:// 协议加载媒体
   */
  getVideoHttpUrl: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('video:getHttpUrl', filePath),

  openInExplorer: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_IN_EXPLORER, path),

  /** 用系统浏览器打开外部链接 */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),

  // ====== 应用菜单动作（主进程派发：文件/关于等）======
  /** 订阅菜单动作；返回取消订阅函数 */
  onMenuAction: (cb: (action: string) => void): (() => void) => {
    const handler = (_: unknown, action: string) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => {
      ipcRenderer.off('menu:action', handler);
    };
  },
  /** 推送工作区面板显隐状态，重建视图菜单复选项 */
  setMenuWorkspace: (panels: object): Promise<void> =>
    ipcRenderer.invoke('menu:setWorkspace', panels),

  // ====== 关窗确认（有未保存更改时由渲染进程确认后放行）======
  /** 主进程拦截到关窗请求时触发；渲染进程确认后调 confirmClose 放行 */
  onCloseRequest: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on('app:close-request', handler);
    return () => {
      ipcRenderer.off('app:close-request', handler);
    };
  },
  /** 确认关闭窗口（配合 onCloseRequest 使用） */
  confirmClose: (): Promise<void> =>
    ipcRenderer.invoke('app:confirm-close'),

  /** 渲染端 React 挂载完成信号：主窗口以 show:false 启动（防白屏），
      主进程收到该信号后才显示主窗口并关闭启动画面 */
  appReady: (): void =>
    ipcRenderer.send('app:ready'),

  /** 应用信息（isPackaged 用于隐藏仅开发用的设置项；windowsStore 用于切换更新入口形态：自动安装/跳转商店） */
  getAppInfo: (): Promise<{isPackaged: boolean; version: string; windowsStore: boolean}> =>
    ipcRenderer.invoke('app:get-info'),

  // ====== 自动更新（NSIS 直链版全自动；商店版版本检查+跳转商店；渲染端按 getAppInfo 判定展示形态）======
  /** 手动检查更新（已是最新/发现新版本/已下载待安装/失败） */
  checkUpdate: (): Promise<UpdateCheckResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  /** 更新下载完成后退出并安装（重启进新版本） */
  installUpdate: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),
  /** 订阅更新状态推送（发现新版本/下载进度/下载完成）；返回取消订阅函数 */
  onUpdateStatus: (cb: (event: UpdateStatusEvent) => void): (() => void) => {
    const handler = (_: unknown, event: UpdateStatusEvent) => cb(event);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, handler);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.UPDATE_STATUS, handler);
    };
  },

  // ====== 渲染控制 ======
  startRender: (job: {compositionId: string; inputProps: TemplateProps | MultiSegmentProps; outputLocation: string; renderOptions: RenderOptions; contentFingerprint?: string}): Promise<{success: boolean; outputPath?: string; error?: string; usedFallback?: boolean; cancelled?: boolean; encoderUsed?: RenderEncoderUsed; encoderNote?: string; cacheInfo?: {hit: number; total: number}; contentFingerprint?: string}> =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDER_START, job),

  /** 取消正在进行的渲染（无进行中任务时为空操作） */
  cancelRender: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDER_CANCEL),

  /** 渲染故事板某时刻的静帧画面（AI 自检用），返回 JPEG data URL + 尺寸；失败抛中文错误 */
  renderStoryboardStill: (req: {inputProps: MultiSegmentProps; aspectRatioId: string; timeSec: number}): Promise<{dataUrl: string; width: number; height: number}> =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDER_STILL, req),

  /** 渲染封面图（全片帧 + 封面覆盖层）全分辨率落盘，返回路径 + 回看缩略图；失败抛中文错误 */
  renderCoverStill: (req: {inputProps: MultiSegmentProps; aspectRatioId: string; timeSec: number; cover: CoverConfig; outputDir: string; baseName: string; maskDataUrl?: string}): Promise<{outputPath: string; dataUrl: string; width: number; height: number}> =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDER_COVER, req),

  onRenderProgress: (callback: (data: {progress: number}) => void): (() => void) => {
    const handler = (_: unknown, data: {progress: number}) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.RENDER_PROGRESS, handler);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.RENDER_PROGRESS, handler);
    };
  },

  // ====== 代理转码（mxf/超大/4K 素材）======
  /** 请求代理（缓存命中立返 ready，否则入队后台转码）；返回 job 快照 */
  proxyPrepare: (req: {path: string; colorCurve?: string}): Promise<{sourcePath: string; status: string; proxyPath?: string; percent?: number; error?: string; note?: string}> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROXY_PREPARE, req),
  /** 全部代理 job 摘要 */
  proxyStatus: (): Promise<Array<{sourcePath: string; status: string; proxyPath?: string; percent?: number; error?: string}>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROXY_STATUS),
  onProxyProgress: (callback: (data: {sourcePath: string; status: string; proxyPath?: string; percent?: number; error?: string}) => void): (() => void) => {
    const handler = (_: unknown, data: {sourcePath: string; status: string; proxyPath?: string; percent?: number; error?: string}) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PROXY_PROGRESS, handler);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.PROXY_PROGRESS, handler);
    };
  },

  // ====== 持久化存储 ======
  getStore: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET, key),
  setStore: (key: string, value: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.STORE_SET, key, value),
  getAllStore: () => ipcRenderer.invoke(IPC_CHANNELS.STORE_GET_ALL),

  // ====== 全局设置 ======
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: object) => ipcRenderer.invoke('settings:set', settings),

  // ====== 自定义模板 ======
  listCustomTemplates: (): Promise<CustomTemplateDef[]> =>
    ipcRenderer.invoke('custom-templates:list'),
  saveCustomTemplate: (def: CustomTemplateDef): Promise<CustomTemplateDef[]> =>
    ipcRenderer.invoke('custom-templates:save', def),
  deleteCustomTemplate: (id: string): Promise<CustomTemplateDef[]> =>
    ipcRenderer.invoke('custom-templates:delete', id),
  exportCustomTemplate: (def: CustomTemplateDef): Promise<{success: boolean; path?: string; error?: string}> =>
    ipcRenderer.invoke('custom-templates:export', def),
  exportCustomTemplatePack: (
    def: CustomTemplateDef,
    meta: {description?: string; author?: string; tags?: string[]; version?: string; thumbnail?: string},
  ): Promise<{success: boolean; path?: string; packId?: string; error?: string}> =>
    ipcRenderer.invoke('custom-templates:export-pack', {def, meta}),
  importCustomTemplate: (): Promise<{success: boolean; def?: CustomTemplateDef; error?: string} | null> =>
    ipcRenderer.invoke('custom-templates:import'),

  // ====== AI 生成模板（三期 D2：扫描/编译均在主进程权威执行）======
  listGeneratedTemplates: (): Promise<import('../shared/generated-template').GeneratedTemplateDef[]> =>
    ipcRenderer.invoke('template-gen:list'),
  saveGeneratedTemplate: (
    payload: import('../main/services/templateGen').SaveGeneratedPayload,
  ): Promise<import('../main/services/templateGen').SaveGeneratedResult> =>
    ipcRenderer.invoke('template-gen:save', payload),
  compileGeneratedTemplate: (
    source: string,
  ): Promise<import('../main/services/templateGen').CompileResult> =>
    ipcRenderer.invoke('template-gen:compile', source),
  deleteGeneratedTemplate: (id: string): Promise<import('../shared/generated-template').GeneratedTemplateDef[]> =>
    ipcRenderer.invoke('template-gen:delete', id),

  // ====== AI 对话存档 ======
  /** 导出对话记录（md=人读版 / json=可再导入的往返版），弹保存对话框 */
  chatExport: (args: {content: string; defaultName: string; format: 'md' | 'json'}): Promise<{success: boolean; path?: string; error?: string}> =>
    ipcRenderer.invoke('ai-chat:export', args),
  /** 导入对话存档：弹打开对话框，返回 JSON 文本（结构校验在渲染端做） */
  chatImport: (): Promise<{success: boolean; content?: string; error?: string} | null> =>
    ipcRenderer.invoke('ai-chat:import'),

  // ====== 模板市场 ======
  marketCatalog: (forceRefresh?: boolean): Promise<{entries: MarketCatalogEntryWithStatus[]; offline: boolean}> =>
    ipcRenderer.invoke('market:catalog', forceRefresh),
  marketInstalled: (): Promise<TemplatePack[]> =>
    ipcRenderer.invoke('market:installed'),
  marketInstall: (id: string): Promise<{ok: boolean; error?: string; pack?: TemplatePack}> =>
    ipcRenderer.invoke('market:install', id),
  marketUninstall: (id: string): Promise<TemplatePack[]> =>
    ipcRenderer.invoke('market:uninstall', id),
  marketImportFile: (): Promise<{success: boolean; pack?: TemplatePack; error?: string} | null> =>
    ipcRenderer.invoke('market:import-file'),

  // ====== 工程文件（.vtproj）======
  /** 另存为：弹保存对话框，返回保存路径 */
  saveProjectAs: (name: string, data: ProjectFileData): Promise<SaveProjectResult> =>
    ipcRenderer.invoke('project:saveAs', name, data),
  /** 保存到已有路径 */
  saveProject: (path: string, name: string, data: ProjectFileData): Promise<SaveProjectResult> =>
    ipcRenderer.invoke('project:save', path, name, data),
  /** 保存到任意指定路径（MCP save_project 用；.vtproj 后缀 + 父目录须已存在） */
  saveProjectToPath: (path: string, name: string, data: ProjectFileData): Promise<SaveProjectResult> =>
    ipcRenderer.invoke('project:saveToPath', path, name, data),
  /** 打开：弹对话框选择工程文件；用户取消时返回 null */
  openProject: (): Promise<OpenProjectResult | null> =>
    ipcRenderer.invoke('project:open'),
  /** 按路径打开（最近工程列表用） */
  openProjectPath: (path: string): Promise<OpenProjectResult> =>
    ipcRenderer.invoke('project:openPath', path),
  /** 打开内置示例工程（主进程复制到 userData 并重写媒体路径后加载，无对话框） */
  openSampleProject: (): Promise<OpenProjectResult> =>
    ipcRenderer.invoke('sample:open'),
  /** 自动保存：静默写入 userData/autosave.vtproj */
  autosaveProject: (name: string, data: ProjectFileData): Promise<{success: boolean; error?: string}> =>
    ipcRenderer.invoke('project:autosave', name, data),
  /** 退出前兜底自动保存（send 同步通道）：beforeunload 阶段 invoke 的异步写不可靠，
      用 send 即发即忘，主进程收到后 writeFileSync 同步落盘；仅在窗口卸载路径使用 */
  autosaveProjectSync: (name: string, data: ProjectFileData): void =>
    ipcRenderer.send('project:autosaveSync', name, data),
  /** 读取自动保存（不存在或已损坏返回 null） */
  loadAutosave: (): Promise<OpenProjectResult | null> =>
    ipcRenderer.invoke('project:loadAutosave'),
  /** 删除自动保存文件 */
  clearAutosave: (): Promise<{success: boolean; error?: string}> =>
    ipcRenderer.invoke('project:clearAutosave'),

  // ====== 背景音乐 ======
  selectAudioFile: (): Promise<{name: string; path: string; src: string} | null> =>
    ipcRenderer.invoke('audio:select'),
  /** 分析音频：时长 + 波形峰值（UI 波形）+ 节拍网格与 BPM（卡点对齐/节拍脉冲/节拍音效共用） */
  analyzeAudio: (filePath: string): Promise<{duration: number; peaks: number[]; beats: number[]; bpm: number}> =>
    ipcRenderer.invoke('audio:analyze', filePath),
  /** 音乐结构图（剪辑大脑）：节拍 + 重拍 + 段落 + 每拍能量 */
  analyzeMusicMap: (filePath: string): Promise<import('../shared/music-map').MusicMap | null> =>
    ipcRenderer.invoke('audio:musicMap', filePath),
  /** 素材画面分析（剪辑大脑）：镜头边界 + 运动强度曲线 */
  analyzeFootage: (filePath: string): Promise<import('../main/services/footage').FootageMap | null> =>
    ipcRenderer.invoke('footage:analyze', filePath),

  // ====== 跟踪稳定 ======
  /** 跟踪稳定分析：块匹配跟踪 → 平滑求解 → 写 <同名>.stab.json sidecar，返回校正量表与 zoom；points 空数组 = 自动选点（实际用点见返回 track.points） */
  stabilizeAnalyze: (req: {videoPath: string; points: StabPoint[]; opts?: StabAnalyzeOpts}): Promise<StabAnalyzeResult> =>
    ipcRenderer.invoke('stabilization:analyze', req),
  /** 读稳定 sidecar（不存在/损坏返回 null） */
  stabilizeRead: (trackPath: string): Promise<StabTrackSidecar | null> =>
    ipcRenderer.invoke('stabilization:read', {trackPath}),

  // ====== 3D 地面追踪 ======
  /** 地面追踪分析：自动选锚 → 块匹配跟踪 → RANSAC 共面筛选 → 写 <同名>.ground.json sidecar，返回锚点轨迹与质量 */
  groundAnalyze: (req: {videoPath: string; opts?: import('../main/services/groundTracking').GroundAnalyzeOpts}): Promise<import('../main/services/groundTracking').GroundAnalyzeResult> =>
    ipcRenderer.invoke('ground:analyze', req),
  /** 读地面 sidecar（不存在/损坏返回 null） */
  groundRead: (trackPath: string): Promise<import('../shared/groundTrack').GroundTrackFile | null> =>
    ipcRenderer.invoke('ground:read', {trackPath}),

  // ====== 本地曲库 ======
  /** 弹目录选择对话框选曲库目录（用户取消返回 ''） */
  selectMusicDir: (): Promise<string> =>
    ipcRenderer.invoke('music:selectDir'),
  /** 扫描设置里的曲库目录（未设置/不存在返回 []） */
  scanMusicLibrary: (): Promise<{name: string; path: string}[]> =>
    ipcRenderer.invoke('music:scan'),
  /** 分析曲库音频（主进程磁盘缓存，命中不重复分析；返回节拍网格与 BPM） */
  analyzeMusic: (filePath: string): Promise<{duration: number; peaks: number[]; beats: number[]; bpm: number}> =>
    ipcRenderer.invoke('music:analyze', filePath),

  // ====== 内置音效库（SFX）======
  /** 音效源表：类别 → 变体 HTTP URL 列表（resources/sfx 内置库） */
  getSfxLibrary: (): Promise<SfxSources> =>
    ipcRenderer.invoke('sfx:getLibrary'),

  // ====== 内置配乐库（CC BY 4.0，需署名——成片自动附片尾署名）======
  /** 内置曲库条目表（resources/bgm；点选与本地曲库同数据路径，条目带 credit 走强制署名） */
  getBgmLibrary: (): Promise<import('../shared/bgm-credits').BgmBuiltinTrack[]> =>
    ipcRenderer.invoke('bgm:getLibrary'),

  // ====== 图片选择（Logo）======
  /** 选择一张图片（Logo）；返回 {name,path,src}，用户取消返回 null */
  selectImageFile: (): Promise<{name: string; path: string; src: string} | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SELECT_IMAGE),

  // ====== 视频抽帧（AI 助手多模态看图）======
  /** 从视频/图片抽帧，返回 JPEG data URL + 尺寸；失败抛中文错误。maxDim=长边上限（缺省 768；时间线缩略图传 192） */
  extractFrame: (filePath: string, timeSec: number, maxDim?: number): Promise<{dataUrl: string; width: number; height: number}> =>
    ipcRenderer.invoke(IPC_CHANNELS.VIDEO_EXTRACT_FRAME, filePath, timeSec, maxDim),
  /** 批量抽帧（≤4 个时间点；路径须已注册白名单），返回帧数组；失败抛中文错误 */
  extractFrames: (req: {path: string; timesSec: number[]}): Promise<{dataUrl: string; width: number; height: number}[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.VIDEO_EXTRACT_FRAMES, req),

  /** 缩略图墙：一张 cols×rows 拼图 = 全片百帧信息（返回 dataUrl + 每格时间表） */
  videoContactSheet: (req: {path: string; cells?: number}): Promise<{dataUrl: string; width: number; height: number; cols: number; rows: number; timesSec: number[]; frames: number}> =>
    ipcRenderer.invoke(IPC_CHANNELS.VIDEO_CONTACT_SHEET, req),

  /** 分析素材色彩统计（自动曝光匹配用；路径须在媒体白名单内），失败返回 null */
  analyzeMediaColor: (filePath: string): Promise<{r: number; g: number; b: number; luma: number} | null> =>
    ipcRenderer.invoke('media:analyzeColor', filePath),

  /** 收集工程素材到指定目录的 media/ 子目录（consolidate_project 工具用）：
   *  同名冲突自动改名、同内容跳过复制；返回 {map: 旧路径→新路径, missing: 缺失清单, copied: 复制数} */
  consolidateMedia: (req: {dir: string; paths: string[]}): Promise<{map: Record<string, string>; missing: string[]; copied: number}> =>
    ipcRenderer.invoke('media:consolidate', req),

  // ====== 授权 / 订阅 ======
  activateLicense: (code: string): Promise<LicenseActivateResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.LICENSE_ACTIVATE, code),
  deactivateLicense: (): Promise<{success: boolean; message?: string}> =>
    ipcRenderer.invoke(IPC_CHANNELS.LICENSE_DEACTIVATE),
  getLicenseStatus: (): Promise<LicenseStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.LICENSE_GET_STATUS),

  // ====== LLM 助手 ======
  /** 发起一轮聊天（非流式），返回 assistant 消息（含 tool_calls）；失败抛中文错误 */
  llmChat: (req: LlmChatRequest): Promise<LlmChatMessage> =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_CHAT, req),
  /** 中止进行中的 llmChat 请求（无进行中请求时为空操作） */
  llmCancel: (): Promise<void> =>
    ipcRenderer.invoke('llm:cancel'),
  /** 保存 API key（主进程 safeStorage 加密存储；空字符串 = 清除） */
  llmSetApiKey: (key: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_SET_API_KEY, key),
  /** 查询配置状态（key 永不回渲染进程） */
  llmGetStatus: (): Promise<LlmStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_STATUS),

  // ====== 屏幕录制 / 截屏 ======
  /** 枚举可采集源（整个屏幕 + 应用窗口，带缩略图） */
  captureListSources: (): Promise<CaptureSourceInfo[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_LIST_SOURCES),
  /** 保存录屏（MediaRecorder 的 webm 字节），返回落盘路径与 HTTP src；空数据抛中文错误。
   *  附带 cursorTrack 时主进程在同目录写 <同名>.cursor.json sidecar，返回值带 cursorTrackPath；
   *  选区录制时 cursorTrack 附 videoWidth/videoHeight（选区尺寸），缺省记被录屏物理像素 */
  captureSaveRecording: (bytes: ArrayBuffer, cursorTrack?: {displayId: number; points: CursorPoint[]; clicks?: CursorClick[]; videoWidth?: number; videoHeight?: number; sourceKind?: 'screen' | 'window'; windowRects?: WindowRectSample[]}): Promise<CaptureSaveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SAVE_RECORDING, bytes, cursorTrack),
  /** 截取某源当前画面（缺省主屏），返回 PNG 落盘信息 + 预览 dataURL；窗口最小化会抛中文错误 */
  captureScreenshot: (sourceId?: string): Promise<CaptureScreenshotResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SCREENSHOT, sourceId),
  /** 元素截图原图：截取本窗口内指定 DOM 区域（某底色底图，不落盘；配合元素截图模式 + 双底抠图使用） */
  captureElementRaw: (clip: ElementClipRect): Promise<{data: string; width: number; height: number}> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_ELEMENT, clip),
  /** 元素抠图 PNG 字节落盘到 captures/screenshots，返回路径与 HTTP src */
  captureSaveElement: (bytes: ArrayBuffer): Promise<CaptureSaveResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SAVE_ELEMENT, bytes),
  /** 设置下一次 getDisplayMedia 的目标源 id（系统声音录制路径用，主进程 handler 据此匹配 video 源） */
  captureSetDisplayMediaSource: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_SET_DISPLAY_MEDIA_SOURCE, sourceId),
  /** 轮询光标位置（DIP）与各屏布局（录制期鼠标轨迹采集用）；带 hwnd 时附窗口矩形（窗口录制轨迹用） */
  capturePollCursor: (hwnd?: number): Promise<CursorPollResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_CURSOR_POLL, hwnd),
  /** 读取鼠标轨迹 sidecar JSON；文件缺失/损坏/版本不符返回 null（不阻断工程加载） */
  captureReadCursorTrack: (filePath: string): Promise<CursorTrackFile | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_READ_CURSOR_TRACK, filePath),
  /** 读取 UI 区域 sidecar JSON（拆层飞出）；缺失/损坏返回 null（不阻断工程加载） */
  uiRegionsRead: (filePath: string): Promise<UiRegionsFile | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.UI_REGIONS_READ, filePath),
  /** 启动全局鼠标点击钩子（录制期点击采集）；原生模块不可用返回 false（静默降级为不采点击） */
  captureStartInputHook: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_INPUT_HOOK_START),
  /** 停止点击钩子并返回本轮事件（物理像素坐标 + Date.now() 墙钟） */
  captureStopInputHook: (): Promise<InputHookEvent[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CAPTURE_INPUT_HOOK_STOP),

  // ====== TTS 语音合成 ======
  /** 合成旁白语音（命中缓存不重复请求）；失败抛中文错误 */
  ttsSynthesize: (req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_SYNTHESIZE, req),
  /** 保存 TTS API key（主进程 safeStorage 加密存储；空字符串 = 清除） */
  ttsSetApiKey: (key: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_SET_API_KEY, key),
  /** 查询 TTS 配置状态（key 永不回渲染进程） */
  ttsGetStatus: (): Promise<TtsStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.TTS_GET_STATUS),

  // ====== ASR 语音识别 ======
  /** 转录素材语音为字幕行（时间相对段起点）；失败抛中文错误 */
  asrTranscribe: (req: AsrTranscribeRequest): Promise<CaptionLine[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.ASR_TRANSCRIBE, req),
  /** 保存 ASR API key（主进程 safeStorage 加密存储；空字符串 = 清除） */
  asrSetApiKey: (key: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.ASR_SET_API_KEY, key),
  /** 查询 ASR 配置状态（key 永不回渲染进程） */
  asrGetStatus: (): Promise<AsrStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.ASR_GET_STATUS),

  // ====== Stock 素材搜索（Pexels/Pixabay 免费商用素材） ======
  /** 聚合搜索（已配 key 的源都查）；失败抛中文错误 */
  searchStockMedia: (req: StockSearchRequest): Promise<{items: StockMediaItem[]; warnings: string[]}> =>
    ipcRenderer.invoke(IPC_CHANNELS.STOCK_SEARCH, req),
  /** 下载素材落本地缓存（域名白名单校验）；返回 {path, src} 已注册白名单 */
  downloadStockMedia: (req: StockDownloadRequest): Promise<{path: string; src: string; fileName: string; bytes: number}> =>
    ipcRenderer.invoke(IPC_CHANNELS.STOCK_DOWNLOAD, req),
  /** 缩略图代下载 -> dataUrl（失败返回空串） */
  fetchStockThumbnail: (url: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.STOCK_THUMBNAIL, url),
  /** 保存某家素材源 API key（空字符串 = 清除） */
  stockSetApiKey: (provider: 'pexels' | 'pixabay', key: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.STOCK_SET_API_KEY, provider, key),
  /** 查询已配置的素材源 */
  stockGetStatus: (): Promise<{pexels: boolean; pixabay: boolean}> =>
    ipcRenderer.invoke(IPC_CHANNELS.STOCK_GET_STATUS),

  // ====== 文生图（与 AI 助手共用端点与 Key） ======
  /** 生成图片（哈希缓存落盘 userData/imagegen）；失败抛中文错误 */
  generateImage: (req: ImageGenRequest): Promise<ImageGenResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_GENERATE, req),
  /** 查询生图配置状态（模型名 + 端点） */
  imageGenGetStatus: (): Promise<ImageGenStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_GET_STATUS),

  // ====== 文生 3D（Meshy 兼容 Text-to-3D，独立加密 Key） ======
  /** 发起 3D 生成任务（pending 单例，立即返回任务快照；之后轮询 modelGenGetStatus 直到终态）；失败抛中文错误 */
  generateModel: (req: ModelGenRequest): Promise<ModelGenTaskSnapshot> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_GEN_GENERATE, req),
  /** 查询文生 3D 配置状态 + 任务快照（进度/产物，key 永不回渲染进程） */
  modelGenGetStatus: (): Promise<ModelGenStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_GEN_GET_STATUS),
  /** 保存文生 3D API key（主进程 safeStorage 加密存储；空字符串 = 清除） */
  modelGenSetApiKey: (key: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_GEN_SET_API_KEY, key),

  // ====== 成片音频审片（纯本地 ffmpeg 探测） ======
  /** 响度/峰值/静音探测（白名单路径限定）；失败抛中文错误 */
  analyzeRenderAudio: (path: string): Promise<AudioReviewReport> =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDER_ANALYZE_AUDIO, path),

  // ====== 源素材挖矿（mine_highlights） ======
  /** 分析素材时间线：时长 + 语音窗口 + 可选 ASR 全量分段（白名单路径限定）；失败抛中文错误。
   *  opts.asrSegments 给出有效分段时复用缓存、不再重跑 ASR（P0-4 转写回流） */
  miningAnalyzeTimeline: (path: string, opts?: {asrSegments?: Array<{start: number; end: number; text: string}>}): Promise<SourceTimeline> =>
    ipcRenderer.invoke(IPC_CHANNELS.MINING_ANALYZE_TIMELINE, path, opts),

  /** 高光候选启发式预筛（场景检测+音轨能量+代表帧曝光，零模型）：top-N 候选 + 缩略图 */
  miningHighlightCandidates: (req: {path: string; topN?: number; targetSec?: number}): Promise<import('../main/services/highlightMining').HighlightCandidateBundle> =>
    ipcRenderer.invoke(IPC_CHANNELS.MINING_HIGHLIGHT_CANDIDATES, req),

  /** 精选面板用户点选记录（RLHF 留口，本地 jsonl 追加） */
  highlightRecordChoice: (req: {sourcePath: string; segmentIndex: number; videoIndex: number; candidates: unknown[]; picked: unknown[]; usedAi: boolean}): Promise<{ok: boolean; file?: string; error?: string}> =>
    ipcRenderer.invoke(IPC_CHANNELS.HIGHLIGHT_RECORD_CHOICE, req),

  /** 素材来源类型手动修正记录（启发式误判真实样本，本地 jsonl 追加） */
  sourcekindRecordChange: (req: {path: string; name: string; from: string; to: string}): Promise<{ok: boolean; file?: string; error?: string}> =>
    ipcRenderer.invoke(IPC_CHANNELS.SOURCEKIND_RECORD_CHANGE, req),

  // ====== 片语本地模型（付费版权重下载）======
  /** 电脑状态检测：显卡/显存 + llama.cpp 推理引擎/权重 + 磁盘余量 */
  localModelDetect: (): Promise<import('../main/services/localModel').LocalModelEnv> =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_MODEL_DETECT),
  /** 启动权重下载队列（立即返回快照，进度走 onLocalModelProgress 事件流） */
  localModelDownloadStart: (): Promise<import('../main/services/localModel').LocalModelDownloadState> =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_MODEL_DOWNLOAD_START),
  localModelDownloadCancel: (): Promise<import('../main/services/localModel').LocalModelDownloadState> =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_MODEL_DOWNLOAD_CANCEL),
  localModelDownloadState: (): Promise<import('../main/services/localModel').LocalModelDownloadState> =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_MODEL_DOWNLOAD_STATE),
  onLocalModelProgress: (callback: (state: import('../main/services/localModel').LocalModelDownloadState) => void): (() => void) => {
    const handler = (_: unknown, state: import('../main/services/localModel').LocalModelDownloadState) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.LOCAL_MODEL_PROGRESS, handler);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.LOCAL_MODEL_PROGRESS, handler);
    };
  },

  // ====== MCP 服务接口（第三方 agent 接入，见 shared/mcp.ts）======
  /** 订阅主进程转发的工具执行请求；返回取消订阅函数 */
  onMcpExecute: (handler: (req: McpBridgeRequest) => void): (() => void) => {
    const h = (_: unknown, req: McpBridgeRequest) => handler(req);
    ipcRenderer.on(MCP_CHANNELS.EXECUTE, h);
    return () => {
      ipcRenderer.off(MCP_CHANNELS.EXECUTE, h);
    };
  },
  /** 回传工具执行结果（与 onMcpExecute 的 callId 配对） */
  mcpExecuteResult: (resp: McpBridgeResponse): void =>
    ipcRenderer.send(MCP_CHANNELS.RESULT, resp),
  /** 查询 MCP 服务状态（含 token，仅本机展示/复制用） */
  mcpGetStatus: (): Promise<McpServerStatus> =>
    ipcRenderer.invoke(MCP_CHANNELS.GET_STATUS),
  /** 启用/停用 MCP 服务，返回最新状态 */
  mcpSetEnabled: (enabled: boolean): Promise<McpServerStatus> =>
    ipcRenderer.invoke(MCP_CHANNELS.SET_ENABLED, enabled),
  /** 修改监听端口（运行中会自动重启服务），返回最新状态 */
  mcpSetPort: (port: number): Promise<McpServerStatus> =>
    ipcRenderer.invoke(MCP_CHANNELS.SET_PORT, port),
  /** 重新生成接入 token（旧 token 立即失效），返回最新状态 */
  mcpRegenerateToken: (): Promise<McpServerStatus> =>
    ipcRenderer.invoke(MCP_CHANNELS.REGENERATE_TOKEN),
  /** 探测本机已装 agent（Kimi Code CLI / Claude Code）及其接入配置状态 */
  mcpListAgents: (): Promise<McpAgentListResult> =>
    ipcRenderer.invoke(MCP_CHANNELS.LIST_AGENTS),
  /** 一键接入：把当前 url+token 写入指定 agent 的配置文件；失败抛中文错误 */
  mcpInstallAgent: (id: McpAgentId): Promise<McpAgentInstallResult> =>
    ipcRenderer.invoke(MCP_CHANNELS.INSTALL_AGENT, id),

  // ====== Computer Use（内置电脑操作 sidecar，见 shared/computer-use.ts）======
  /** 发起 GUI 任务（懒启动 sidecar；首次调用会拉起本地引擎），返回 taskId；失败抛中文错误 */
  computerRunTask: (req: ComputerRunTaskRequest): Promise<ComputerTaskSubmitResult> =>
    ipcRenderer.invoke(COMPUTER_USE_CHANNELS.RUN_TASK, req),
  /** 查询电脑任务状态（taskId 来自 computerRunTask/computerPlayScript） */
  computerTaskStatus: (taskId: string): Promise<ComputerTaskStatus> =>
    ipcRenderer.invoke(COMPUTER_USE_CHANNELS.TASK_STATUS, taskId),
  /** 协作式停止电脑任务（当前动作完成后停下） */
  computerStopTask: (taskId: string): Promise<ComputerTaskStopResult> =>
    ipcRenderer.invoke(COMPUTER_USE_CHANNELS.STOP_TASK, taskId),
  /** 确定性回放动作脚本（script.jsonl），返回 taskId；失败抛中文错误 */
  computerPlayScript: (req: ComputerPlayScriptRequest): Promise<ComputerTaskSubmitResult> =>
    ipcRenderer.invoke(COMPUTER_USE_CHANNELS.PLAY_SCRIPT, req),
  /** 查询 sidecar 引擎状态（running/starting/stopped/not_installed） */
  computerGetSidecarStatus: (): Promise<ComputeUseSidecarStatus> =>
    ipcRenderer.invoke(COMPUTER_USE_CHANNELS.GET_SIDECAR_STATUS),
};

contextBridge.exposeInMainWorld('api', api);

// 暴露给 window 的类型声明（供 renderer 代码获取类型提示）
export type ElectronApi = typeof api;
