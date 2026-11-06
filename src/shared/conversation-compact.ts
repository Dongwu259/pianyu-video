/**
 * 会话历史压缩（端侧上下文短板的架构对策之一）。
 *
 * 动机（2026-09-26 实机 bench 实测）：EDGE 模式下历史单调膨胀，13-20 步就撞模型 ctx 墙
 * （33k/43k/63k 三连爆）；带裁剪的同一模型能跑完全程。压缩规则与 bench 验证版同思路：
 * system 与首条 user（原始需求）永不裁，最近 N 条消息原样保留，更早的 tool 结果截断、
 * 帧图替换为占位文本（图片是膨胀大头：768px 帧 ≈1.3k token/张）。
 *
 * 与草稿本（scratch_pad）配合：压缩边界处注入草稿内容，模型无需记住每步细节也能续接工作。
 */

/** OpenAI 消息的最小结构视图（兼容 chat 通道与 bench 的消息形态） */
export interface CompactibleMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface CompactOptions {
  /** 除 system/首条 user 外，末尾原样保留的消息条数 */
  keepLast?: number;
  /** 更早的 tool 结果截断到多少字符 */
  maxToolChars?: number;
  /** 帧图占位文本 */
  imagePlaceholder?: string;
  /** 压缩边界处注入的便签（如草稿本内容）；非空时作为一条 user 消息插在保留区之前 */
  boundaryNote?: string;
}

export const DEFAULT_IMAGE_PLACEHOLDER = '[早期查看过的帧图已省略；画面结论见你的草稿与后续文案]';

const textLen = (content: unknown): number => {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n: number, c) => {
      const part = c as {type?: string; text?: string};
      return n + (part?.type === 'text' && typeof part.text === 'string' ? part.text.length : 0);
    }, 0);
  }
  return 0;
};

/** 数一遍历史里的帧图引用数（图片是 EDGE 上下文的最大膨胀源） */
export const countImages = (messages: CompactibleMessage[]): number =>
  messages.reduce((n, m) => {
    if (!Array.isArray(m.content)) return n;
    return n + (m.content as {type?: string}[]).filter((c) => c?.type === 'image_url').length;
  }, 0);

/**
 * 压缩历史。返回新数组（不改动入参）。
 * - role === 'system' 与第一条 user 永远完整保留；
 * - 末尾 keepLast 条（含）之后原样保留；
 * - 中段的 tool 消息截断到 maxToolChars；assistant（含 tool_calls）保留——清单很小且是模型自己的决策记录；
 * - 中段 user 的数组 content 里 image_url 项替换为占位文本，文本项原样保留。
 */
export const compactConversation = <T extends CompactibleMessage>(
  messages: T[],
  opts: CompactOptions = {},
): T[] => {
  const {keepLast = 8, maxToolChars = 400, imagePlaceholder = DEFAULT_IMAGE_PLACEHOLDER, boundaryNote} = opts;
  if (messages.length <= keepLast + 2) return messages;
  const cut = Math.max(2, messages.length - keepLast); // 0=system 1=首条user 之外的最早下标
  const out: T[] = [];
  let boundaryInserted = false;
  for (let i = 0; i < messages.length; i++) {
    if (i === cut && boundaryNote) {
      out.push({role: 'user', content: boundaryNote} as T);
      boundaryInserted = true;
    }
    const m = messages[i];
    if (i < 2 || i >= cut) {
      out.push(m);
      continue;
    }
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > maxToolChars) {
      out.push({...m, content: `${m.content.slice(0, maxToolChars)}…（已截断）`});
      continue;
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      let touched = false;
      const parts = (m.content as {type?: string; text?: string; image_url?: unknown}[]).map((c) => {
        if (c?.type === 'image_url') {
          touched = true;
          return {type: 'text', text: imagePlaceholder};
        }
        return c;
      });
      out.push(touched ? {...m, content: parts} : m);
      continue;
    }
    out.push(m);
  }
  if (boundaryNote && !boundaryInserted) out.push({role: 'user', content: boundaryNote} as T);
  return out;
};

/**
 * 是否该压缩：消息数超限，或帧图数超限（图片按 token 大户单独计）。
 * 阈值取保守值：EDGE 模型 32k ctx、固定头部 ≈8.4k，留给「最新帧 + 生成」的空间要足。
 */
export const shouldCompact = (messages: CompactibleMessage[], maxMessages = 26, maxImages = 10): boolean =>
  messages.length > maxMessages || countImages(messages) > maxImages;
