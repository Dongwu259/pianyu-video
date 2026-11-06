/**
 * AI 对话历史工具（纯函数，主进程/渲染进程/单测共用）
 *
 * 职责：对话存档的序列化与校验、持久化前的图片剥离、长历史压缩的安全切割、
 * 崩溃后恢复的历史修复。所有函数无副作用（strip/sanitize 返回新数组）。
 *
 * 压缩合法性约束：OpenAI 兼容 API 要求 assistant 消息带 tool_calls 时，其后必须
 * 紧跟每个 tool_call_id 对应的 role:'tool' 应答，否则后续请求一律 400。因此切割点
 * 只允许落在 role:'user' 消息上（一轮的起点），保证被移除区间内的 tool_calls 配对
 * 完整、保留部分也不以悬空 tool 消息开头。
 */

import type {LlmChatMessage, ContentPart, LlmToolCall} from './llm-chat';

/** 界面消息（与发给 API 的 apiMessages 分开维护：tool 结果不直接展示） */
export interface UiMsg {
  id: string;
  /** system = 面板自注入的系统通知（渲染结果回传等），不参与对话历史以外的逻辑 */
  role: 'user' | 'assistant' | 'system';
  /** 文本气泡（可空：纯工具调用的 assistant 消息没有文本） */
  content?: string;
  /** 本轮执行过的工具名列表（折叠小卡展示） */
  toolNames?: string[];
}

/** 对话存档 JSON 结构（版本化；导入时按 version 校验，不认识的新版本报错拒绝） */
export interface ChatArchive {
  version: 1;
  /** 导出时间（ISO 字符串） */
  savedAt: string;
  /** 导出时的视频体裁（仅作参考信息，导入后 system 提示词按当前体裁重建） */
  videoType?: string;
  uiMessages: UiMsg[];
  /** API 历史（不含 system 首条——加载时按当前体裁重建） */
  apiMessages: LlmChatMessage[];
}

/** 历史画面图占位文本（与 AIAssistantPanel 的 pruneImageMessages 同口径） */
export const HISTORY_IMAGE_PLACEHOLDER =
  '（历史画面图片已省略以节省上下文，如需再看请重新调用 view_segment_frame、view_media_frames 或 take_screenshot）';

/** 自动压缩阈值：约 12 万字符（中文约 4~6 万 token），超过后在下一轮对话结束时压缩 */
export const AUTO_COMPACT_THRESHOLD_CHARS = 120_000;

/** 压缩时至少保留的最近消息条数（保证上下文新鲜度，避免把正在讨论的内容也摘要掉） */
export const COMPACT_KEEP_RECENT = 24;

/** 导入存档的条数/体积上限（防手改巨型文件把渲染端撑爆） */
export const ARCHIVE_MAX_MESSAGES = 5_000;
export const ARCHIVE_MAX_CHARS = 5_000_000;

const isContentParts = (c: unknown): c is ContentPart[] => Array.isArray(c);

/** 持久化/入档前把 image_url 内容剥成文字占位：base64 体积大、过时后也无意义 */
export const stripImagesForStorage = (msgs: LlmChatMessage[]): LlmChatMessage[] =>
  msgs.map((m) => {
    if (!isContentParts(m.content)) return m;
    let changed = false;
    const content = m.content.map((p): ContentPart => {
      if (p.type === 'image_url') {
        changed = true;
        return {type: 'text', text: HISTORY_IMAGE_PLACEHOLDER};
      }
      return p;
    });
    return changed ? {...m, content} : m;
  });

/** 粗估历史字符量（文本 + tool_calls 参数 + 图片按 URL 长度计），用于压缩阈值判断 */
export const estimateHistoryChars = (msgs: LlmChatMessage[]): number => {
  let n = 0;
  for (const m of msgs) {
    if (typeof m.content === 'string') n += m.content.length;
    else if (isContentParts(m.content)) {
      for (const p of m.content) n += p.type === 'text' ? p.text.length : 64;
    }
    for (const c of m.tool_calls ?? []) n += c.function.name.length + c.function.arguments.length;
  }
  return n;
};

/**
 * 找压缩切割点：返回 cut，表示把 [1, cut) 区间替换为摘要、保留 [cut, msgs.length)。
 * 约束：msgs[cut].role 必须是 'user'（轮次起点，tool_calls 配对不会被切断）；
 * 保留部分条数 >= keepRecent；且移除后字符量降到 threshold 以下（做不到则取最晚的
 * 合法边界——至少移除到阈值附近）。无可压缩空间（剩余太短 / 没有合法边界）返回 -1。
 */
export const findCompactionCut = (
  msgs: LlmChatMessage[],
  opts?: {threshold?: number; keepRecent?: number},
): number => {
  const threshold = opts?.threshold ?? AUTO_COMPACT_THRESHOLD_CHARS;
  const keepRecent = opts?.keepRecent ?? COMPACT_KEEP_RECENT;
  // 候选边界：从早到晚的 user 轮次起点（跳过 index 0 的 system）
  const candidates: number[] = [];
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === 'user' && msgs.length - i >= keepRecent) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  const total = estimateHistoryChars(msgs);
  // 最早能把保留部分压到阈值以下的边界（移除最多、摘要覆盖最广）；
  // 都做不到就取最后一个候选（保留刚好 keepRecent 条，移除其余全部）
  for (const cut of candidates) {
    const kept = estimateHistoryChars([msgs[0], ...msgs.slice(cut)]);
    if (total - kept >= threshold * 0.3 && kept <= threshold) return cut;
  }
  const last = candidates[candidates.length - 1];
  // 回退也要有意义：移除的部分太小（如只有几条短消息）就不值得压缩
  const removedChars = estimateHistoryChars(msgs.slice(1, last));
  return removedChars >= 4_000 ? last : -1;
};

/** 压缩摘要的 LLM 请求消息（普通对话调用，不带 tools） */
export const buildCompactionMessages = (removed: LlmChatMessage[]): LlmChatMessage[] => [
  {
    role: 'system',
    content:
      '你是视频制作助手的一段对话归档器。把给定对话历史压缩成一份给「未来的你」看的摘要，保留全部关键信息：用户的产品/需求、已确定的方案与决定（模板、文案、参数、体裁）、已完成与未完成的事项、用户明确的偏好。用紧凑的中文条目列出，不超过 500 字。不要寒暄，直接输出摘要内容。',
  },
  {role: 'user', content: JSON.stringify(stripImagesForStorage(removed), null, 0)},
];

/** 应用压缩结果：system 首条 + 摘要（system）+ 保留部分 */
export const applyCompaction = (msgs: LlmChatMessage[], cut: number, summary: string): LlmChatMessage[] => [
  msgs[0],
  {role: 'system', content: `【此前对话摘要（${new Date().toLocaleString('zh-CN')}自动压缩）】\n${summary}`},
  ...msgs.slice(cut),
];

/** 给缺失应答的 tool_calls 补一条中止 tool 消息（应用崩溃/强杀后恢复用，保证历史对 API 合法） */
export const sanitizeRestoredHistory = (msgs: LlmChatMessage[]): LlmChatMessage[] => {
  const out: LlmChatMessage[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    const calls = m.tool_calls ?? [];
    if (m.role !== 'assistant' || calls.length === 0) continue;
    // 消费紧随其后的 tool 应答，记下已应答的 id
    const answered = new Set<string>();
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') {
      answered.add(String(msgs[j].tool_call_id));
      out.push(msgs[j]);
      j++;
    }
    // 缺的补中止消息（历史里确实存在过的 id 才补；结构残缺的 id 丢弃该 assistant 消息更安全）
    const missing = calls.filter((c) => !answered.has(c.id));
    for (const c of missing) {
      out.push({
        role: 'tool',
        tool_call_id: c.id,
        content: JSON.stringify({ok: false, errors: ['应用上次退出，该工具未执行']}),
      });
    }
    i = j - 1;
  }
  return out;
};

/** 导出 Markdown（人读版）：按角色成段，工具调用列名，不参与再导入 */
export const serializeChatMarkdown = (ui: UiMsg[], meta?: {videoTypeLabel?: string}): string => {
  const lines: string[] = ['# 片语 AI 助手对话记录'];
  if (meta?.videoTypeLabel) lines.push('', `视频体裁：${meta.videoTypeLabel}`);
  lines.push('', `导出时间：${new Date().toLocaleString('zh-CN')}`, '---', '');
  for (const m of ui) {
    const who = m.role === 'user' ? '🧑 我' : m.role === 'assistant' ? '✨ AI 助手' : '⚙️ 系统';
    if (m.content) lines.push(`**${who}**`, '', m.content, '');
    if (m.toolNames?.length) lines.push(`> 🔧 调用工具：${m.toolNames.join('、')}`, '');
  }
  return lines.join('\n');
};

/** 组装存档（导出 JSON 用）：剥图 + 时间戳 + 体裁 */
export const buildChatArchive = (args: {
  videoType?: string;
  uiMessages: UiMsg[];
  apiMessages: LlmChatMessage[];
}): ChatArchive => ({
  version: 1,
  savedAt: new Date().toISOString(),
  videoType: args.videoType,
  uiMessages: args.uiMessages,
  apiMessages: stripImagesForStorage(args.apiMessages),
});

const isString = (v: unknown): v is string => typeof v === 'string';

/** 解析导入的存档 JSON：结构/条数/体积校验，坏数据返回中文错误（不抛异常） */
export const parseChatArchive = (raw: string): {ok: true; archive: ChatArchive} | {ok: false; error: string} => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {ok: false, error: '不是合法的 JSON 文件'};
  }
  if (typeof data !== 'object' || data === null) return {ok: false, error: '存档结构不对（顶层应为对象）'};
  const a = data as Record<string, unknown>;
  if (a.version !== 1) return {ok: false, error: `不支持的存档版本：${String(a.version)}（本版本只认识 version 1）`};
  if (!Array.isArray(a.uiMessages) || !Array.isArray(a.apiMessages)) {
    return {ok: false, error: '存档缺少 uiMessages / apiMessages 数组'};
  }
  if (a.uiMessages.length > ARCHIVE_MAX_MESSAGES || a.apiMessages.length > ARCHIVE_MAX_MESSAGES) {
    return {ok: false, error: `存档消息数超限（上限 ${ARCHIVE_MAX_MESSAGES} 条）`};
  }
  if (raw.length > ARCHIVE_MAX_CHARS) return {ok: false, error: '存档文件过大（上限 5MB）'};
  const badUi = a.uiMessages.some(
    (m) =>
      typeof m !== 'object' ||
      m === null ||
      !['user', 'assistant', 'system'].includes(String((m as {role?: unknown}).role)),
  );
  if (badUi) return {ok: false, error: 'uiMessages 里存在角色不明的消息'};
  const badApi = a.apiMessages.some((m) => {
    if (typeof m !== 'object' || m === null) return true;
    const r = String((m as {role?: unknown}).role);
    if (!['system', 'user', 'assistant', 'tool'].includes(r)) return true;
    if (r === 'tool' && !isString((m as {tool_call_id?: unknown}).tool_call_id)) return true;
    return false;
  });
  if (badApi) return {ok: false, error: 'apiMessages 里存在结构不合法的消息'};
  return {
    ok: true,
    archive: {
      version: 1,
      savedAt: isString(a.savedAt) ? a.savedAt : new Date().toISOString(),
      videoType: isString(a.videoType) ? a.videoType : undefined,
      uiMessages: a.uiMessages as UiMsg[],
      apiMessages: stripImagesForStorage(sanitizeRestoredHistory(a.apiMessages as LlmChatMessage[])),
    },
  };
};

/** 供测试/调试：构造带 tool_calls 的 assistant 消息 */
export const makeToolCallMsg = (id: string, name: string, args: string): LlmChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{id, type: 'function', function: {name, arguments: args}} as LlmToolCall],
});
