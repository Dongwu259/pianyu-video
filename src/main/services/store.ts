/**
 * 应用持久化存储 - 保存用户偏好设置（如输出目录、质量预设等）
 */

import Store from 'electron-store';
import {AppConfig} from '../../shared/types';
import type {CustomTemplateDef} from '../../shared/custom-template';
import type {GeneratedTemplateDef} from '../../shared/generated-template';
import {MCP_DEFAULT_PORT} from '../../shared/mcp';

/** 本地授权记录（token 以 safeStorage 加密后的 base64 存储，见 services/license.ts） */
export interface StoredLicense {
  code: string;             // 授权码明文（仅用于展示掩码与服务器交互）
  tokenEncrypted: string;   // safeStorage 加密后的 token（base64）；为空串表示已被服务器判定失效
  plan: string;             // 套餐标识（monthly/yearly/lifetime）
  expiresAt: number;        // 到期时间（epoch ms）
  lastVerifiedAt: number;   // 上次服务器校验时间（epoch ms）
  machineId: string;        // 激活时使用的设备指纹
  machineName: string;      // 激活时的主机名
  machinesUsed?: number;    // 激活时服务器返回的已激活机器数
  maxMachines?: number;     // 激活时服务器返回的机位上限（老本地记录缺省，展示「X / N 台」用）
  signature?: string;       // 服务端对 code/plan/expiresAt/machineId 的 Ed25519 签名（base64），验签失败 = 本地记录被篡改
}

interface StoreSchema {
  config: AppConfig;
  license: StoredLicense | null;
  machineId: string;  // 设备唯一标识（首次使用时生成，见 license.ts getOrCreateMachineId）
  licenseHighWater: number;  // 单调时间高水位（见过的最大 Date.now()），识别 lastVerifiedAt 未来值篡改
  mcpTokenEncrypted: string;  // MCP 接入 token（safeStorage 加密后的 base64，见 ipc/mcp.ts）
}

/** 匿名用量计数（services/usage.ts 维护；成功上报后清零，lastReportAt 记上报时间） */
export interface UsageStats {
  renders: number;                       // 渲染成功次数
  rendersFailed: number;                 // 渲染未完成次数（失败 + 用户取消）
  renderMs: number;                      // 成功渲染累计耗时（毫秒）
  aiChats: number;                       // AI 对话成功回复次数
  captures: number;                      // 录屏/截屏保存成功次数
  templates: Record<string, number>;     // 各模板 id 的渲染使用次数
  lastReportAt: number;                  // 上次成功上报时间（epoch ms，0 = 从未上报）
}

const defaultUsageStats: UsageStats = {
  renders: 0,
  rendersFailed: 0,
  renderMs: 0,
  aiChats: 0,
  captures: 0,
  templates: {},
  lastReportAt: 0,
};

const defaultConfig: AppConfig = {
  outputDir: '',
};

// 默认全局设置
const defaultGlobalSettings = {
  defaultOutputDir: '',
  defaultFormat: 'mp4' as const,
  defaultCrf: 23,
  autoSave: true,
  theme: 'light' as const,
  editorProMode: false,  // 专家编辑模式（默认精简：三标签页 + 隐藏高级控件，见 StoryboardEditor）
  persistUndoHistory: true,  // 基建④：显式保存时撤销历史进工程文件（关 = 不持久，可回退）
  crashReporting: false,  // 匿名崩溃报告（opt-in，默认关闭，见 services/crashReporter.ts）
  usageReporting: true,  // 匿名用量统计（默认开启，设置页可关，见 services/usage.ts）
  licenseServerUrl: '',  // 授权服务器地址（仅开发环境生效；空 = 使用内置默认值，见 license.ts）
  llmBaseUrl: '',  // AI 助手服务地址（OpenAI 兼容端点，空 = 未配置）
  llmModel: '',    // AI 助手模型名
  llmModelEdit: '', // AI 编辑模型名（双模型路由第二路，空 = 关闭）
  ttsBaseUrl: '',  // TTS 语音合成服务地址（OpenAI 兼容 /audio/speech 端点，空 = 未配置）
  ttsModel: '',    // TTS 模型名（如 tts-1 / gpt-4o-mini-tts）
  ttsVoice: '',    // TTS 音色（如 alloy / nova / 中文音色名）
  musicLibraryDir: '',  // 本地曲库目录（用户指定的文件夹，空 = 未设置）
  asrBaseUrl: '',  // ASR 语音识别服务地址（OpenAI 兼容 /audio/transcriptions 端点，空 = 未配置）
  asrModel: 'whisper-1',  // ASR 模型名（如 whisper-1）
  modelGenBaseUrl: 'https://api.meshy.ai',  // 文生 3D 服务地址（Meshy 兼容 Text-to-3D 端点）
  modelGenModel: 'meshy-4',  // 文生 3D 模型名
  mcpEnabled: false,  // MCP 服务接口（第三方 agent 接入，默认关闭，见 ipc/mcp.ts）
  mcpPort: MCP_DEFAULT_PORT,  // MCP 服务监听端口
};

export const store = new Store<StoreSchema & {globalSettings: typeof defaultGlobalSettings; customTemplates: CustomTemplateDef[]; generatedTemplates: GeneratedTemplateDef[]; llmApiKeyEncrypted: string; ttsApiKeyEncrypted: string; asrApiKeyEncrypted: string; modelGenApiKeyEncrypted: string; stockPexelsKeyEncrypted: string; stockPixabayKeyEncrypted: string; usageStats: UsageStats}>({
  defaults: {
    config: defaultConfig,
    license: null,
    machineId: '',
    licenseHighWater: 0,
    mcpTokenEncrypted: '',  // MCP 接入 token（safeStorage 加密，见 ipc/mcp.ts；空 = 未生成）
    globalSettings: defaultGlobalSettings,
    customTemplates: [],
    generatedTemplates: [],  // AI 生成模板（受限 TSX + esbuild 编译产物，见 services/templateGen.ts）
    llmApiKeyEncrypted: '',  // safeStorage 加密后的 LLM API key（见 services/llm.ts）
    ttsApiKeyEncrypted: '',  // safeStorage 加密后的 TTS API key（见 services/tts.ts）
    asrApiKeyEncrypted: '',  // safeStorage 加密后的 ASR API key（见 services/asr.ts）
    modelGenApiKeyEncrypted: '',  // safeStorage 加密后的文生 3D API key（见 services/modelGen.ts）
    stockPexelsKeyEncrypted: '',   // safeStorage 加密后的 Pexels API key（见 services/stockMedia.ts）
    stockPixabayKeyEncrypted: '', // safeStorage 加密后的 Pixabay API key（见 services/stockMedia.ts）
    usageStats: defaultUsageStats,  // 匿名用量计数（见 services/usage.ts）
  },
});

export const getConfig = (): AppConfig => {
  return store.get('config') || defaultConfig;
};

export const setConfig = (config: Partial<AppConfig>): void => {
  const current = getConfig();
  store.set('config', {...current, ...config});
};

// 全局设置（设置页面）
export interface GlobalSettings {
  defaultOutputDir: string;
  defaultFormat: 'mp4' | 'mov' | 'webm';
  defaultCrf: number;
  autoSave: boolean;
  theme?: 'light' | 'dark';  // 界面外观（渲染端 AppSettings 同名键，经 settings:set 白名单落盘）
  editorProMode?: boolean;  // 专家编辑模式（默认精简）
  persistUndoHistory?: boolean;  // 基建④：显式保存时撤销历史进工程文件
  crashReporting?: boolean;  // 匿名崩溃报告（opt-in，默认关闭，见 services/crashReporter.ts）
  usageReporting?: boolean;  // 匿名用量统计（默认开启；老用户已落盘的设置无此键，读取方按 undefined !== false 视为开启，见 services/usage.ts）
  licenseServerUrl?: string;  // 授权服务器地址（仅开发环境生效，见 license.ts getServerBaseUrl）
  llmBaseUrl?: string;  // AI 助手服务地址（OpenAI 兼容端点）
  llmModel?: string;    // AI 助手模型名
  llmModelEdit?: string; // AI 编辑模型名（双模型路由第二路）
  ttsBaseUrl?: string;  // TTS 服务地址（OpenAI 兼容 /audio/speech）
  ttsModel?: string;    // TTS 模型名
  ttsVoice?: string;    // TTS 音色
  musicLibraryDir?: string;  // 本地曲库目录（用户指定的文件夹）
  asrBaseUrl?: string;  // ASR 服务地址（OpenAI 兼容 /audio/transcriptions）
  asrModel?: string;    // ASR 模型名
  imageGenModel?: string;     // 文生图模型名（与 AI 助手共用端点与 Key，见 services/imageGen.ts）
  imageGenBaseUrl?: string;   // 文生图服务地址覆盖（空 = 用 AI 助手地址）
  modelGenBaseUrl?: string;  // 文生 3D 服务地址（Meshy 兼容 Text-to-3D 端点，见 services/modelGen.ts）
  modelGenModel?: string;    // 文生 3D 模型名（如 meshy-4）
  mcpEnabled?: boolean;  // MCP 服务接口开关（第三方 agent 接入，默认 false，见 ipc/mcp.ts）
  mcpPort?: number;      // MCP 服务监听端口（默认 17890，见 shared/mcp.ts）
}

export const getGlobalSettings = (): GlobalSettings => {
  return store.get('globalSettings') || defaultGlobalSettings;
};

export const setGlobalSettings = (settings: Partial<GlobalSettings>): void => {
  const current = getGlobalSettings();
  store.set('globalSettings', {...current, ...settings});
};

// ====== 授权 / 订阅 ======

export const getLicense = (): StoredLicense | null => {
  return store.get('license') || null;
};

export const setLicense = (license: StoredLicense | null): void => {
  store.set('license', license);
};

export const getMachineId = (): string => {
  return store.get('machineId') || '';
};

export const setMachineId = (id: string): void => {
  store.set('machineId', id);
};

/** 单调时间高水位（见 license.ts getEntitlement） */
export const getLicenseHighWater = (): number => {
  return store.get('licenseHighWater') || 0;
};

export const setLicenseHighWater = (v: number): void => {
  store.set('licenseHighWater', v);
};

// ====== 匿名用量统计（services/usage.ts；上报成功才清零）======

export const getUsageStats = (): UsageStats => {
  // 合并默认值：老版本落盘的计数没有 rendersFailed/renderMs 等新键，读取时补零
  return {...defaultUsageStats, ...(store.get('usageStats') || {})};
};

export const setUsageStats = (stats: UsageStats): void => {
  store.set('usageStats', stats);
};

// ====== 自定义模板 ======

export const getCustomTemplates = (): CustomTemplateDef[] => {
  return store.get('customTemplates') || [];
};

export const setCustomTemplates = (templates: CustomTemplateDef[]): void => {
  store.set('customTemplates', templates);
};

// ====== AI 生成模板（三期 D2：受限 TSX 源码 + esbuild 编译产物）======

export const getGeneratedTemplates = (): GeneratedTemplateDef[] => {
  return store.get('generatedTemplates') || [];
};

export const setGeneratedTemplates = (templates: GeneratedTemplateDef[]): void => {
  store.set('generatedTemplates', templates);
};

// ====== LLM 助手（API key 加密存储，见 services/llm.ts）======

export const getLlmApiKeyEncrypted = (): string => {
  return store.get('llmApiKeyEncrypted') || '';
};

export const setLlmApiKeyEncrypted = (v: string): void => {
  store.set('llmApiKeyEncrypted', v);
};

// ====== TTS 语音合成（API key 加密存储，见 services/tts.ts）======

export const getTtsApiKeyEncrypted = (): string => {
  return store.get('ttsApiKeyEncrypted') || '';
};

export const setTtsApiKeyEncrypted = (v: string): void => {
  store.set('ttsApiKeyEncrypted', v);
};

// ====== ASR 语音识别（API key 加密存储，见 services/asr.ts）======

export const getAsrApiKeyEncrypted = (): string => {
  return store.get('asrApiKeyEncrypted') || '';
};

export const setAsrApiKeyEncrypted = (v: string): void => {
  store.set('asrApiKeyEncrypted', v);
};

// ====== 文生 3D（API key 加密存储，见 services/modelGen.ts）======

export const getModelGenApiKeyEncrypted = (): string => {
  return store.get('modelGenApiKeyEncrypted') || '';
};

export const setModelGenApiKeyEncrypted = (v: string): void => {
  store.set('modelGenApiKeyEncrypted', v);
};

// ====== Stock 素材搜索（API key 加密存储，见 services/stockMedia.ts）======

export const getStockPexelsKeyEncrypted = (): string => {
  return store.get('stockPexelsKeyEncrypted') || '';
};

export const setStockPexelsKeyEncrypted = (v: string): void => {
  store.set('stockPexelsKeyEncrypted', v);
};

export const getStockPixabayKeyEncrypted = (): string => {
  return store.get('stockPixabayKeyEncrypted') || '';
};

export const setStockPixabayKeyEncrypted = (v: string): void => {
  store.set('stockPixabayKeyEncrypted', v);
};

// ====== MCP 服务接口（token 加密存储，见 ipc/mcp.ts）======

export const getMcpTokenEncrypted = (): string => {
  return store.get('mcpTokenEncrypted') || '';
};

export const setMcpTokenEncrypted = (v: string): void => {
  store.set('mcpTokenEncrypted', v);
};
