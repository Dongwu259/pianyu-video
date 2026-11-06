/**
 * 应用设置（渲染端内存态 + 主进程持久化）的类型与默认值
 *
 * 放在 shared 而非 SettingsModal 组件里：projectStore 等纯逻辑模块需要引用，
 * 从组件文件 import 会把 React/CSS 依赖链带进纯逻辑（单测无法直接在 Node 跑）。
 * 主进程侧字段子集与校验见 main/index.ts 的 SETTINGS_SCHEMA（两处保持同步）。
 */

export interface AppSettings {
  defaultOutputDir: string;
  defaultFormat: 'mp4' | 'mov' | 'webm';
  defaultCrf: number;
  autoSave: boolean;
  /** 界面外观：浅色 / 深色 / 跟随系统 */
  theme: 'light' | 'dark' | 'system';
  /** 专家编辑模式（默认关 = 精简：只显示素材/文字/参数三个标签页，隐藏起点/缓动曲线等高级控件） */
  editorProMode: boolean;
  /** 基建④ undo 历史持久化：显式保存（保存/另存为/MCP save_project）时把撤销栈（各≤50 条）降级写进
   *  工程文件，重开工程可继续 Ctrl+Z 撤回上次会话的编辑；自动保存不带。关 = 回到不持久行为（总纲 §六.6 可回退） */
  persistUndoHistory: boolean;
  /** 匿名崩溃报告（opt-in，默认关闭）：仅版本号/系统平台/错误信息，见隐私政策「崩溃报告」条款 */
  crashReporting: boolean;
  /** 匿名用量统计（默认开启）：仅功能使用次数（渲染/AI 对话/录屏/模板频次），不含素材与工程内容 */
  usageReporting: boolean;
  /** 授权服务器地址（仅开发环境生效，留空使用内置默认） */
  licenseServerUrl?: string;
  /** AI 助手服务地址（OpenAI 兼容端点，如 https://api.deepseek.com，空 = 未配置） */
  llmBaseUrl: string;
  /** AI 助手模型名（如 deepseek-chat） */
  llmModel: string;
  llmModelEdit: string;
  /** TTS 语音合成服务地址（OpenAI 兼容 /audio/speech 端点，空 = 未配置） */
  ttsBaseUrl: string;
  /** TTS 模型名（如 tts-1 / gpt-4o-mini-tts） */
  ttsModel: string;
  /** TTS 音色（如 alloy / nova） */
  ttsVoice: string;
  /** 本地曲库目录（用户指定的文件夹，空 = 未设置；不内置任何音乐） */
  musicLibraryDir: string;
  /** ASR 语音识别服务地址（OpenAI 兼容 /audio/transcriptions 端点，空 = 未配置） */
  asrBaseUrl: string;
  /** ASR 模型名（如 whisper-1） */
  asrModel: string;
  /** 文生图模型名（如 dall-e-3；与 AI 助手共用端点与 Key，空 = 未配置） */
  imageGenModel: string;
  /** 文生图服务地址覆盖（空 = 用 AI 助手地址） */
  imageGenBaseUrl: string;
  /** 文生 3D 服务地址（Meshy 兼容 Text-to-3D 端点） */
  modelGenBaseUrl: string;
  /** 文生 3D 模型名（如 meshy-4） */
  modelGenModel: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultOutputDir: '',
  defaultFormat: 'mp4',
  defaultCrf: 23,
  autoSave: true,
  theme: 'light',
  editorProMode: false,
  persistUndoHistory: true,
  crashReporting: false,
  usageReporting: true,
  licenseServerUrl: '',
  llmBaseUrl: '',
  llmModel: '',
  llmModelEdit: '',
  ttsBaseUrl: '',
  ttsModel: '',
  ttsVoice: '',
  musicLibraryDir: '',
  asrBaseUrl: '',
  asrModel: 'whisper-1',
  imageGenModel: '',
  imageGenBaseUrl: '',
  modelGenBaseUrl: 'https://api.meshy.ai',
  modelGenModel: 'meshy-4',
};
