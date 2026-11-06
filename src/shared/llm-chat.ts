/**
 * LLM 聊天链路的数据结构（OpenAI 兼容协议，非流式）。
 *
 * 架构：主进程只做 HTTP 转发（API key 不出主进程），工具在渲染进程执行。
 * 本文件只含类型，主进程（services/llm.ts）、preload、渲染端（AIAssistantPanel）共用。
 */

/** 工具调用（assistant 消息中的 tool_calls 项） */
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON 字符串形式的参数 */
    arguments: string;
  };
}

/** 多模态内容片段：文本或图片（OpenAI 兼容 vision 格式） */
export type ContentPart =
  | {type: 'text'; text: string}
  | {type: 'image_url'; image_url: {url: string}};

/**
 * 聊天消息（system/user/assistant/tool 四种角色）。
 * content 支持纯文本或 ContentPart 数组（多模态：user 消息可带 image_url 让视觉模型看图）。
 * tool 消息的 content 始终为字符串（工具结果，文本）。
 */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  /** 仅 assistant 消息：模型请求的工具调用列表 */
  tool_calls?: LlmToolCall[];
  /** 仅 tool 消息：对应 assistant 消息中 tool_calls 的 id */
  tool_call_id?: string;
}

/**
 * llm:chat IPC 入参。
 * 安全约束：baseUrl/model 不在入参中——主进程自行从全局设置读取（与 tts:synthesize 同模式），
 * 防止渲染进程任意 JS 把带 Bearer key 的请求导向任意主机。
 */
export interface LlmChatRequest {
  /** 完整对话历史（首条为 system，工具结果以 role:'tool' 追加） */
  messages: LlmChatMessage[];
  /** 工具 schema（OpenAI tools 格式），缺省不传 */
  tools?: unknown[];
  /** 模型覆盖（双模型路由用）：仅当与设置中的主模型或编辑模型精确同名时生效，其余值被主进程忽略 */
  model?: string;
}

/** llm:getStatus IPC 返回（key 永不回渲染进程，只回是否已配置） */
export interface LlmStatus {
  /** API key 是否已配置 */
  configured: boolean;
  /** 当前设置中的服务地址（来自全局设置，明文设置项） */
  baseUrl?: string;
  /** 当前设置中的模型名 */
  model?: string;
  /** 当前设置中的编辑模型名（双模型路由第二路；空 = 未配置） */
  editModel?: string;
}

/** tts:getStatus IPC 返回（key 永不回渲染进程，只回是否已配置） */
export interface TtsStatus {
  /** API key 是否已配置 */
  configured: boolean;
  /** 当前设置中的 TTS 服务地址 */
  baseUrl?: string;
  /** 当前设置中的 TTS 模型名 */
  model?: string;
  /** 当前设置中的音色 */
  voice?: string;
}

/**
 * 本地推理端点判定（Ollama / llama.cpp / vLLM 自托管都在 loopback；云端 API 走公网域名）。
 * 本地端点没有计费与配额压力，且小模型 prefill 慢——超时与工具面都按此分流（见 llmTimeoutMs）。
 */
export const isLlmLoopback = (baseUrl: string): boolean =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test((baseUrl || '').trim());

/**
 * 请求超时（毫秒）：含图请求放宽（8 张 base64 帧让 VLM 推理很慢）；
 * 本地端点再放宽——端侧小模型 prefill 实测一步 5-13s（4060 8GB），云端档保持原节奏。
 * 依据：2026-09 端侧实验（scripts/.scratch/vlm-agent-bench.mjs）。
 */
export const llmTimeoutMs = (hasImage: boolean, baseUrl: string): number => {
  if (hasImage) return isLlmLoopback(baseUrl) ? 300_000 : 180_000;
  return isLlmLoopback(baseUrl) ? 120_000 : 30_000;
};

/** tts:synthesize IPC 入参 */
export interface TtsSynthesizeRequest {
  /** 要合成的旁白文案 */
  text: string;
  /** 可选音色覆盖（缺省用设置中的 ttsVoice） */
  voice?: string;
  /** 可选语速 0.5-2（缺省 1；OpenAI 兼容端点不支持时自动忽略） */
  speed?: number;
}

/** tts:synthesize IPC 返回 */
export interface TtsSynthesizeResult {
  path: string;     // 生成的音频文件路径（userData/tts 缓存）
  src: string;      // 本地视频服务器 HTTP URL（供 Remotion <Audio> 播放）
  duration: number; // 音频时长（秒）
}
