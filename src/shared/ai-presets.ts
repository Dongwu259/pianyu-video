/**
 * AI 厂商预设（AI 零门槛 P0）
 *
 * 目标：把「OpenAI 兼容端点」的裸表单（baseUrl+model+key 三项手填 × 五项服务）
 * 收敛成「点厂商 → 粘 Key → 完事」。预设只填 baseUrl/model/voice 这类公开事实，
 * Key 永远由用户自己粘贴（safeStorage 加密），本文件不涉及任何密钥。
 *
 * 为什么放 shared：SettingsModal 与 AIAssistantPanel 未配置引导都要用；
 * 且数据是纯结构，可直接进单测（Node 环境跑 URL/字段完整性断言）。
 *
 * 选型口径（2026-09，写死原因见各 note）：
 * - 全部为国内可直连或本地运行的厂商——片语的目标用户多数没有可直连 OpenAI 的网络；
 * - LLM 默认模型优先选「支持图片输入」的档位：内置助手的看图工具链
 *   （view_segment_frame / 抽帧审片 / 素材打标）依赖多模态，纯文本模型会在这几步报错；
 * - DeepSeek 是唯一例外（质量/价格好但纯文本），note 里明确标注后果；
 * - TTS/ASR/文生图只有硅基流动一家以 OpenAI 兼容路径全家桶提供，故只做它的预设；
 *   将来若接入自有托管通道（大模型登记+算法备案完成后），在此追加一个
 *   「内置通道」预设即可，UI 零改动。
 *
 * 语音/模型名是厂商公开文档里的稳定 ID，仍可能随厂商调整过期——
 * 预设只是「起点」，所有字段在 UI 里都可改，过期时用户可自行替换。
 */

export interface AiProviderPreset {
  /** 稳定 id（测试钩子/埋点用） */
  id: string;
  /** 展示名 */
  name: string;
  /** 申请 Key 的控制台地址（openExternal 打开） */
  keyUrl: string;
  /** 一句话说明（徽标旁/tooltip） */
  note: string;
  /** 推荐 LLM 模型是否支持图片输入（看图/审片工具链可用） */
  vision: boolean;
  /** 有免费档时的说明（如「glm-4v-flash 免费」，UI 显示「免费」徽标 + tooltip） */
  freeNote?: string;
  /** LLM（OpenAI 兼容 /chat/completions） */
  llm: {baseUrl: string; model: string};
  /** TTS（OpenAI 兼容 /audio/speech）；无则该厂商不给 TTS 预设 */
  tts?: {baseUrl: string; model: string; voice: string};
  /** ASR（OpenAI 兼容 /audio/transcriptions） */
  asr?: {baseUrl: string; model: string};
  /** 文生图（OpenAI 兼容 /images/generations 或 DashScope 原生，见 imageGen.ts 适配） */
  image?: {baseUrl: string; model: string};
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'zhipu',
    name: '智谱',
    keyUrl: 'https://open.bigmodel.cn',
    note: 'glm-4.6v-flash 免费且支持看图——零成本跑通全部 AI 功能（写故事板/看图审片/文生图）；glm-4.7-flash 亦免费（纯文本）',
    vision: true,
    freeNote: 'glm-4.6v-flash 免费',
    llm: {baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash'},
    image: {baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-3-flash'},
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    keyUrl: 'https://console.volcengine.com/ark',
    note: '豆包系（doubao-seed 支持看图）+ 深度思考；新模型有免费 tokens 额度，同端点可改 deepseek-v3.2 / kimi-k2 等',
    vision: true,
    llm: {baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1.6-flash'},
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com',
    note: '便宜稳定；纯文本模型——「看图审片/素材打标」等看图步骤会失败，文字成片不受影响',
    vision: false,
    llm: {baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat'},
  },
  {
    id: 'kimi',
    name: 'Kimi',
    keyUrl: 'https://platform.moonshot.cn',
    note: 'kimi-k2.5 原生多模态支持看图；若提示无权限，改成 kimi-k2-0905-preview（纯文本）即可',
    vision: true,
    llm: {baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.5'},
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    keyUrl: 'https://cloud.siliconflow.cn',
    note: '一家配齐四件：大模型 + 配音 + 字幕识别 + 文生图（推荐组合）；注册送额度，另有免费档小模型',
    vision: true,
    freeNote: '注册送额度',
    llm: {baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-32B-Instruct'},
    tts: {baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'FunAudioLLM/CosyVoice2-0.5B:alex'},
    asr: {baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall'},
    image: {baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors'},
  },
  {
    id: 'dashscope',
    name: '阿里百炼',
    keyUrl: 'https://bailian.console.aliyun.com',
    note: 'qwen-vl-plus 支持看图；文生图走 DashScope 原生适配（应用已兼容）',
    vision: true,
    llm: {baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus'},
    image: {baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-image'},
  },
  {
    id: 'pianyu-local',
    name: '片语本地模型',
    keyUrl: 'https://studio.dwphoto.top/videotool/models.html',
    note: '推荐：设置 → AI 助手 → 片语本地模型 一键下载即用（pianyu-v1-2b 端侧模型，本地不限 token）。自装 Ollama 的用户也可把服务地址指向 http://127.0.0.1:11434/v1',
    vision: true,
    freeNote: '本地免费',
    llm: {baseUrl: 'http://127.0.0.1:11435/v1', model: 'pianyu-v1-2b'},
  },
];

/** 按 id 取预设（找不到返回 undefined，调用方自行兜底） */
export const getAiProviderPreset = (id: string): AiProviderPreset | undefined =>
  AI_PROVIDER_PRESETS.find((p) => p.id === id);
