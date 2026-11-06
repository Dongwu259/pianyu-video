/**
 * IPC 通道名称常量（主进程与渲染进程通信）
 */

export const IPC_CHANNELS = {
  // 文件操作
  FILE_SELECT_Videos: 'file:select-videos',           // 打开视频文件选择对话框
  FILE_SELECT_OUTPUT_DIR: 'file:select-output-dir',   // 选择输出目录
  FILE_GET_VIDEO_METADATA: 'file:get-video-metadata', // 获取视频元数据
  FILE_READ_CURSOR_TRACK: 'file:read-cursor-track',   // 读取录屏素材的鼠标轨迹 sidecar（录屏即成品编排用）
  FILE_OPEN_IN_EXPLORER: 'file:open-in-explorer',     // 在文件管理器中打开
  FILE_SELECT_IMAGE: 'file:select-image',             // 打开图片文件选择对话框（Logo）

  // 渲染控制
  RENDER_START: 'render:start',
  RENDER_PROGRESS: 'render:progress',
  RENDER_CANCEL: 'render:cancel',
  RENDER_STILL: 'render:still', // 渲染故事板某时刻的静帧画面（AI 自检用）
  RENDER_COVER: 'render:cover', // 渲染封面图（全片帧 + 封面覆盖层，全分辨率落盘）

  // 应用状态持久化
  STORE_GET: 'store:get',
  STORE_SET: 'store:set',
  STORE_GET_ALL: 'store:get-all',

  // 系统能力
  SHELL_OPEN_EXTERNAL: 'shell:open-external', // 用系统浏览器打开外部链接（仅 http/https）

  // 授权 / 订阅
  LICENSE_ACTIVATE: 'license:activate',       // 用授权码激活
  LICENSE_DEACTIVATE: 'license:deactivate',   // 解绑当前设备
  LICENSE_GET_STATUS: 'license:getStatus',    // 查询授权状态（供 UI 展示）

  // 片语本地模型（付费版专属：8 元解锁本地不限 token；首次激活弹窗询问下载权重）
  LOCAL_MODEL_DETECT: 'localModel:detect',                // 电脑状态检测（显存/ollama/磁盘）
  LOCAL_MODEL_DOWNLOAD_START: 'localModel:downloadStart', // 启动权重下载队列（异步，事件汇报进度）
  LOCAL_MODEL_DOWNLOAD_CANCEL: 'localModel:downloadCancel',
  LOCAL_MODEL_DOWNLOAD_STATE: 'localModel:downloadState', // 轮询兜底
  LOCAL_MODEL_PROGRESS: 'localModel:progress',            // 主进程推送下载进度事件

  // LLM 助手
  LLM_CHAT: 'llm:chat',               // 转发一轮聊天到 OpenAI 兼容端点
  LLM_SET_API_KEY: 'llm:setApiKey',   // 保存/清除 API key（safeStorage 加密）
  LLM_GET_STATUS: 'llm:getStatus',    // 查询配置状态（key 不回渲染进程）

  // TTS 语音合成
  TTS_SYNTHESIZE: 'tts:synthesize',   // 合成旁白语音（OpenAI 兼容 /audio/speech，落盘缓存）
  TTS_SET_API_KEY: 'tts:setApiKey',   // 保存/清除 TTS API key（safeStorage 加密）
  TTS_GET_STATUS: 'tts:getStatus',    // 查询 TTS 配置状态（key 不回渲染进程）

  // ASR 语音识别
  ASR_TRANSCRIBE: 'asr:transcribe',   // 转录素材语音 -> 字幕行（OpenAI 兼容 /audio/transcriptions）
  ASR_SET_API_KEY: 'asr:setApiKey',   // 保存/清除 ASR API key（safeStorage 加密）
  ASR_GET_STATUS: 'asr:getStatus',    // 查询 ASR 配置状态（key 不回渲染进程）

  // Stock 素材搜索（Pexels/Pixabay 免费商用素材）
  STOCK_SEARCH: 'stock:search',           // 聚合搜索（已配 key 的源都查）-> StockMediaItem[]
  STOCK_DOWNLOAD: 'stock:download',       // 域名白名单校验后下载落盘 -> {path, src}（自动注册白名单）
  STOCK_THUMBNAIL: 'stock:thumbnail',     // 缩略图代下载 -> data URL（渲染进程不直连外网）
  STOCK_SET_API_KEY: 'stock:setApiKey',   // 保存/清除某家 API key（safeStorage 加密）
  STOCK_GET_STATUS: 'stock:getStatus',    // 查询已配置的素材源（key 不回渲染进程）

  // 文生图（OpenAI 兼容 /images/generations，与 AI 助手共用端点与 Key）
  IMAGE_GEN_GENERATE: 'imageGen:generate',   // 生成图片落盘 userData/imagegen 哈希缓存 -> {path, src}
  IMAGE_GEN_GET_STATUS: 'imageGen:getStatus', // 查询生图配置状态（模型名 + 端点，key 不回渲染进程）

  // 文生 3D（Meshy 兼容 Text-to-3D，独立加密 Key）
  MODEL_GEN_GENERATE: 'modelGen:generate',   // 发起 3D 生成任务（pending 单例）-> 任务快照（轮询见 getStatus）
  MODEL_GEN_GET_STATUS: 'modelGen:getStatus', // 查询配置状态 + 任务快照（进度/产物，key 不回渲染进程）
  MODEL_GEN_SET_API_KEY: 'modelGen:setApiKey', // 保存/清除文生 3D API key（safeStorage 加密）

  // 成片音频审片（纯本地 ffmpeg 探测，白名单路径限定）
  RENDER_ANALYZE_AUDIO: 'render:analyzeAudio', // 响度/峰值/静音探测 -> AudioReviewReport

  // 源素材挖矿时间线（mine_highlights；ASR 会把素材内容发往第三方端点，白名单校验）
  MINING_ANALYZE_TIMELINE: 'mining:analyzeTimeline', // 时长 + 语音窗口 + 可选 ASR 分段 -> SourceTimeline
  MINING_HIGHLIGHT_CANDIDATES: 'mining:highlightCandidates', // 启发式预筛（场景+音轨+曝光零模型）-> top-N 候选+缩略图
  HIGHLIGHT_RECORD_CHOICE: 'highlight:recordChoice', // 精选面板用户点选记录 -> userData/highlight-choices.jsonl（RLHF 留口）
  SOURCEKIND_RECORD_CHANGE: 'sourcekind:recordChange', // 素材来源类型手动修正记录 -> userData/sourcekind-changes.jsonl（启发式误判的真实样本）

  // 视频抽帧（AI 助手多模态看图）
  VIDEO_EXTRACT_FRAME: 'video:extractFrame',  // 从视频/图片抽帧 -> JPEG data URL
  VIDEO_EXTRACT_FRAMES: 'video:extractFrames', // 批量抽帧（≤4 个时间点，白名单校验）
  VIDEO_CONTACT_SHEET: 'video:contactSheet',   // 缩略图墙（一张拼图 = 全片百帧；看图预算友好）

  // 代理转码（mxf/超大/4K 素材后台生成 960 宽代理；Log 素材烧入技术转换 LUT）
  PROXY_PREPARE: 'proxy:prepare',   // 请求代理（缓存命中立返 ready，否则入队）-> ProxyJobInfo
  PROXY_STATUS: 'proxy:status',     // 全部 job 摘要（面板/agent 轮询）
  PROXY_PROGRESS: 'proxy:progress', // 主进程推送 job 状态变化事件

  // 屏幕录制 / 截屏
  CAPTURE_LIST_SOURCES: 'capture:listSources',     // 枚举可采集源（屏幕/窗口，带缩略图）
  CAPTURE_SAVE_RECORDING: 'capture:saveRecording', // 保存录屏 webm 到 userData/captures（可附带鼠标轨迹写 sidecar）
  CAPTURE_SCREENSHOT: 'capture:screenshot',        // 截取某源画面 -> PNG 落盘 + 预览 dataURL
  CAPTURE_ELEMENT: 'capture:element',              // 截取渲染页内指定 DOM 区域原图（双底抠图的底图，不落盘）
  CAPTURE_SAVE_ELEMENT: 'capture:saveElement',     // 元素抠图 PNG 字节落盘到 captures/screenshots
  CAPTURE_SET_DISPLAY_MEDIA_SOURCE: 'capture:setDisplayMediaSource', // 设置下一次 getDisplayMedia 的目标源 id（系统声音路径）
  CAPTURE_CURSOR_POLL: 'capture:pollCursor',       // 轮询光标位置（DIP）与各屏布局（录制期鼠标轨迹采集）
  CAPTURE_READ_CURSOR_TRACK: 'capture:readCursorTrack', // 读取鼠标轨迹 sidecar JSON（工程加载时重建 cursorPoints）
  UI_REGIONS_READ: 'uiRegions:read',               // 读取 UI 区域 sidecar JSON（工程加载时重建 uiRegions，拆层飞出用）
  CAPTURE_INPUT_HOOK_START: 'capture:startInputHook',   // 启动全局鼠标点击钩子（录制期点击采集；原生模块不可用返回 false）
  CAPTURE_INPUT_HOOK_STOP: 'capture:stopInputHook',     // 停止点击钩子并返回本轮事件

  // 自动更新（NSIS 直链版自动下载安装；商店版仅版本检查+跳转商店；dev 被主进程门禁拒绝）
  UPDATE_CHECK: 'update:check',     // 手动检查更新 -> UpdateCheckResult
  UPDATE_INSTALL: 'update:install', // NSIS：下载完成后退出并安装；商店版：打开商店「下载和更新」页
  UPDATE_STATUS: 'update:status',   // 主进程推送更新事件（发现新版本/下载进度/下载完成）
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
