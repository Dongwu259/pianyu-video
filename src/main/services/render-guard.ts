/**
 * 渲染进程层死亡防护的纯逻辑（错误分类 / 退避表 / 日志整形）。
 * 主进程 renderer.ts 消费；不 import electron，单测直跑。
 *
 * 背景：8GB 低显存机器并行渲染时，Remotion 渲染浏览器（headless Chromium）与
 * Rust 组合器（remotion.exe）会被 OOM 杀掉 / GPU 驱动重置带走——renderMedia 抛错
 * 但此前无人分类、无进程级重试、无取证日志 = 渲染静默死亡，也是 bench 噪声的
 * 最后一根源（瞬时死亡被记成整窗 FAIL）。
 *
 * 错误文案来源：@remotion/renderer 4.0.390 dist（"Page crashed!"、"Target closed"、
 * "Target closed (page disposed)"）+ puppeteer 浏览器断连 + 组合器代理 fetch 失败。
 */

export type RenderErrorKind = 'cancel' | 'process-death' | 'other';

/** 用户取消（与 renderer.ts isRenderCancelledError 同口径：文案含 "got cancelled"） */
const isCancelMessage = (m: string): boolean => m.includes('got cancelled');

/** 渲染浏览器/组合器进程层死亡的特征（大小写不敏感；命中任一即 process-death） */
const PROCESS_DEATH_PATTERNS: RegExp[] = [
  /browser (?:has )?(?:crashed|disconnected|closed)/i,
  /lost connection to (?:the )?browser/i,
  /page crashed/i,
  /target closed/i, // CDP 连接断裂：浏览器进程死亡的标准症状（含 page disposed 变体）
  /session closed/i,
  /protocol error/i,
  /renderer process .*(?:crashed|died|gone)/i,
  /compositor .*(?:crash|died|exit|unexpected|terminat)/i,
  /(?:failed to fetch|network error)[^\n]*(?:\/proxy|compositor)/i, // 组合器媒体代理失联
  /ERR_CONNECTION_REFUSED|ECONNREFUSED|EPIPE/i, // 组合器本地端口/管道断
];

export const classifyRenderError = (err: unknown): RenderErrorKind => {
  const msg = err instanceof Error ? err.message : String(err);
  if (isCancelMessage(msg)) return 'cancel';
  if (PROCESS_DEATH_PATTERNS.some((re) => re.test(msg))) return 'process-death';
  return 'other';
};

/**
 * 进程死亡重试退避表（毫秒；第 N 次失败后等多久再试）。
 * 3 次机会（1 原始 + 2 重试）：渲染参数原样重试 = 产物逐帧等价，bench 可比性不受影响；
 * 再多无益——持续性死亡（GPU/内存真的不够）继续试只会拖时间，交给上层兜底/报错。
 */
const RENDER_RETRY_DELAYS_MS = [1500, 4000] as const;

/** 第 attempt 次（0 起）失败后的退避；返回 null = 重试已用尽 */
export const renderRetryDelayMs = (attempt: number): number | null =>
  attempt < RENDER_RETRY_DELAYS_MS.length ? RENDER_RETRY_DELAYS_MS[attempt] : null;

/** 错误摘要（压成单行、去首尾空白、限长）——日志与上抛消息共用 */
export const summarizeRenderError = (err: unknown, maxChars = 300): string => {
  const msg = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > maxChars ? `${msg.slice(0, maxChars)}…` : msg;
};

/** 浏览器日志尾（环形缓冲的快照整形）：最近 maxLines 条、每条限长，超限截断标记 */
export const formatBrowserLogTail = (lines: readonly string[], maxLines = 12, maxChars = 240): string => {
  if (lines.length === 0) return '';
  const tail = lines.slice(-maxLines).map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l));
  const omitted = lines.length - Math.min(lines.length, maxLines);
  return `${omitted > 0 ? `（前 ${omitted} 条略）\n` : ''}${tail.join('\n')}`;
};

/** 环形日志缓冲上限（onBrowserLog 推入；够看清死因即可，不占内存） */
export const BROWSER_LOG_RING_CAP = 120;

/**
 * 进程死亡且重试用尽时的上抛错误（带分类与浏览器日志尾）。
 * 消息会经 IPC 走到 UI/bench 日志——"渲染静默死亡"变可诊断；cause 保留原始错误。
 */
export const buildProcessDeathError = (err: unknown, browserLogTail: string): Error =>
  new Error(
    '渲染浏览器/组合器进程死亡（自动重试后仍失败，常见于低显存机器并行渲染）: ' +
      summarizeRenderError(err) +
      (browserLogTail ? `\n浏览器日志尾:\n${browserLogTail}` : ''),
    {cause: err},
  );
