/**
 * 对话气泡会话流（P1 ChatConversation）的文案编码与节奏数学（纯函数，单测锚定）
 *
 * 文案编码（复用 PromoText.features，零 schema 变更——与 KineticType 逐行大字、
 * AiPromptCard chips 同族约定）：每个要点行是一条对话气泡，行首角色前缀——
 * - `u:` / `u：` 用户气泡（强调色底，「品牌色=用户声音」，NOTES-ROUND6 发现#5）
 * - `a:` / `a：` AI 气泡（中性卡）
 * - 无前缀视为 AI 气泡（缺省收敛到助手侧，防手滑把用户台词放成 AI）
 */

export interface ChatLine {
  role: 'user' | 'ai';
  text: string;
}

/** 解析对话脚本：角色前缀 + 空行过滤 + 长度封顶 */
export const parseChatLines = (features: string[], maxLines = 8): ChatLine[] =>
  (features ?? [])
    .map((raw) => {
      const m = /^\s*([uaUA])\s*[:：]\s*(.*)$/.exec(raw ?? '');
      return m
        ? {role: (m[1].toLowerCase() === 'u' ? 'user' : 'ai') as ChatLine['role'], text: m[2]}
        : {role: 'ai' as const, text: raw ?? ''};
    })
    .filter((l) => l.text.trim().length > 0)
    .slice(0, maxLines);

/** 气泡入场窗（帧）：砸入+文本弹出共用的弹簧窗长 */
export const CHAT_BUBBLE_POP_FRAMES = 18;
/** AI 气泡打字三点停留（秒）：text 在 typing 结束帧替换三点，布局零跳动 */
export const CHAT_TYPING_SEC = 0.5;
/** 新气泡入场时旧气泡位移的平滑窗（帧）：布局瞬移（整列顶起一泡高）的缓动化 */
export const CHAT_PUSH_FRAMES = 12;

/**
 * 气泡文本行数估算：中文/全宽字符计 1、ASCII 计 0.55（气泡宽度 → 换行数）。
 * 可用宽收 5% 保守余量（估行数 ≥ 实际行数——泡高按此固定，补偿与布局同源才能零跳）。
 * 用于三点占位泡预留最终高度（换文零布局跳）与旧气泡推挤补偿量（入场丝滑）。
 */
export const estimateChatRows = (text: string, maxWidthPx: number, fontSizePx: number): number => {
  const t = (text ?? '').trim();
  if (!t) return 1;
  const width = Array.from(t).reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55), 0) * fontSizePx;
  return Math.max(1, Math.ceil(width / Math.max(1, maxWidthPx * 0.95)));
};

/**
 * 气泡 i 的文本落定帧：首气泡 0.5s 起，之后均分剩余段长（留 0.6s 尾巴），
 * step 有下限（0.55s——快节奏压不掉打字可读性）；pace<1 拉快 / >1 放慢由调用方除。
 */
export const bubbleEnterFrame = (
  i: number,
  count: number,
  totalFrames: number,
  fps: number,
  pace = 1,
): number => {
  const base = Math.round(0.5 * fps);
  const tail = Math.round(0.6 * fps);
  const usable = Math.max(0, totalFrames - base - tail);
  const stepMin = Math.round(0.55 * fps);
  const step = Math.max(stepMin, Math.round(usable / Math.max(1, count) / Math.max(0.1, pace)));
  return base + i * step;
};

/**
 * 连发分组（组首标记）：同角色连续行属同组——组内间距收紧（0.38×gap）、圆角阶梯
 * （组中间条上下角收紧）、时间戳只标组首。聊天 App 的分组惯例=对话的呼吸节奏，
 * 对抗「所有气泡等距排列」的平整感。纯函数（渲染/单测同源）。
 */
export const chatGroupStarts = (lines: ChatLine[]): boolean[] =>
  lines.map((l, i) => i === 0 || lines[i - 1].role !== l.role);

/** meta 行（时间戳/已读）行高系数（×fontSize）——estHeights 与渲染同源，换文零跳 */
export const CHAT_META_LINE_EM = 0.82;

/** 组首时间戳：入场秒 → m:ss（段内流逝时间，回放感） */
export const chatTimestampLabel = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
