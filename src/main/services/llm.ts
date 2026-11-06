/**
 * LLM 助手服务（主进程）
 *
 * 职责：只做 OpenAI 兼容协议的 HTTP 转发与 API key 托管，工具执行在渲染进程。
 * - API key 用 safeStorage 加密后存 electron-store，永不回传渲染进程
 * - llmChat：POST <baseUrl>/chat/completions（非流式，30s 超时）
 * - 支持任何 OpenAI 兼容端点（DeepSeek / Qwen / Kimi / OpenAI / Ollama 等）
 *
 * 网络/HTTP/格式错误统一转成中文 Error，供渲染端直接展示。
 */

import {safeStorage} from 'electron';
import {getGlobalSettings, getLlmApiKeyEncrypted, setLlmApiKeyEncrypted} from './store';
import type {LlmChatMessage, LlmChatRequest, LlmStatus} from '../../shared/llm-chat';
import {llmTimeoutMs} from '../../shared/llm-chat';

/** 请求超时基线改为 shared/llm-chat.ts 的 llmTimeoutMs 按端点自适应（云端文本 30s 基线不变） */

/** 进行中的请求（供 llm:cancel 中止；渲染端同时只跑一轮对话循环） */
let activeController: AbortController | null = null;
let activeCancelledByUser = false;

/** 中止进行中的 llmChat 请求（无进行中请求时为空操作） */
export const cancelLlmChat = (): void => {
  if (activeController) {
    activeCancelledByUser = true;
    activeController.abort();
  }
};

/** safeStorage 加密 API key；不可用时退化为 base64（与 license.ts 的 token 处理一致） */
const encryptKey = (key: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64');
  }
  return Buffer.from(key, 'utf8').toString('base64');
};

const decryptKey = (keyEncrypted: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(keyEncrypted, 'base64'));
  }
  return Buffer.from(keyEncrypted, 'base64').toString('utf8');
};

/** 保存 API key（空字符串 = 清除） */
export const setLlmApiKey = (key: string): void => {
  const trimmed = (key || '').trim();
  setLlmApiKeyEncrypted(trimmed ? encryptKey(trimmed) : '');
};

/** 读取明文 API key（仅主进程内部使用：computer-use sidecar 的大脑配置注入；永不回渲染进程） */
export const getLlmApiKey = (): string => {
  const enc = getLlmApiKeyEncrypted();
  if (!enc) return '';
  try {
    return decryptKey(enc);
  } catch {
    return '';
  }
};

/** 查询配置状态：只回 是否已配置/服务地址/模型名，key 永不回渲染进程 */
export const getLlmStatus = (): LlmStatus => {
  const settings = getGlobalSettings();
  return {
    configured: Boolean(getLlmApiKeyEncrypted()),
    baseUrl: settings.llmBaseUrl || '',
    model: settings.llmModel || '',
    editModel: settings.llmModelEdit || '',
  };
};

/**
 * 发起一轮聊天（非流式）。入参含完整对话历史与工具 schema，
 * 返回 choice.message（content 可能为 null，tool_calls 视模型输出而定）。
 * baseUrl/model 由主进程从全局设置读取（不信任渲染端入参，API key 只发向用户配置的端点）。
 * 所有失败路径抛中文 Error；用户取消时抛「请求已取消」。
 */
export const llmChat = async (req: LlmChatRequest): Promise<LlmChatMessage> => {
  const settings = getGlobalSettings();
  const baseUrl = (settings.llmBaseUrl || '').trim().replace(/\/+$/, '');
  let model = (settings.llmModel || '').trim();
  {
    // 双模型路由覆盖：渲染端可指定 model，但只认设置里配置过的名字（不信任渲染端入参——
    // 防止任意模型名经 IPC 打到端点）。编辑模型空 = 路由关闭。
    const override = (req.model || '').trim();
    const editModel = (settings.llmModelEdit || '').trim();
    if (override && (override === model || (editModel && override === editModel))) model = override;
  }
  if (!baseUrl) throw new Error('未配置 AI 服务地址，请到「设置 → AI 助手」中填写');
  if (!model) throw new Error('未配置 AI 模型名称，请到「设置 → AI 助手」中填写');
  const keyEncrypted = getLlmApiKeyEncrypted();
  if (!keyEncrypted) throw new Error('未配置 API Key，请到「设置 → AI 助手」中填写');

  let apiKey: string;
  try {
    apiKey = decryptKey(keyEncrypted);
  } catch {
    throw new Error('API Key 解密失败，请到「设置 → AI 助手」中重新保存');
  }

  const controller = new AbortController();
  activeController = controller;
  activeCancelledByUser = false;
  // 超时按端点自适应（shared/llm-chat.ts llmTimeoutMs）：云端文本 30s / 含图 180s；
  // 本地自托管端点（Ollama 等 loopback）放宽到 120s / 300s——端侧小模型 prefill 慢且无计费压力
  const hasImage = req.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  const timeoutMs = llmTimeoutMs(hasImage, baseUrl);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        ...(req.tools && req.tools.length > 0 ? {tools: req.tools} : {}),
        stream: false,
      }),
      signal: controller.signal,
    });
    // body 读取也必须在 AbortController 保护内，否则收到响应头后超时/取消失效
    text = await res.text();
  } catch (err) {
    if (controller.signal.aborted) {
      if (activeCancelledByUser) throw new Error('请求已取消');
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或服务地址后重试`);
    }
    throw new Error(`无法连接 AI 服务：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }

  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 保留 data 为 null，走下方统一报错
  }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 200) || res.statusText;
    throw new Error(`AI 服务返回错误（HTTP ${res.status}）：${msg}`);
  }
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') {
    throw new Error('AI 服务返回格式异常，请确认服务地址是 OpenAI 兼容端点');
  }
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : null,
    ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? {tool_calls: message.tool_calls as LlmChatMessage['tool_calls']}
      : {}),
  };
};
