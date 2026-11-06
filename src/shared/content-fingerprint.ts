/**
 * 渲染内容指纹（纯函数，可单测）：确认「成片 = 哪一版内容」。
 *
 * 输入渲染相关的内容快照（segments + 项目级样式 + 画幅 + 渲染设置），
 * 归一化后稳定序列化（对象键排序）+ djb2 短哈希（8 位 hex）。
 * 归一化要点：
 * - 素材 src 会话 URL（带每会话随机端口）还原为原始路径，跨会话可比；
 * - 内存态大数组/分析派生数据（光标轨迹点、稳定校正表、波形、缩略图、色彩统计）不参与——
 *   它们由 sidecar 路径/素材本体确定性派生，已隐含在路径与参数里。
 * djb2 只做变更检测，不是安全哈希（碰撞可构造），本场景足够。
 */

/** 参与指纹的内容快照（与 startRender 组装 inputProps 的口径一致，外加画幅与渲染设置） */
export interface RenderContentSnapshot {
  aspectRatioId?: unknown;
  orientation?: unknown;
  segments?: unknown;
  bgm?: unknown;
  logo?: unknown;
  captionStyle?: unknown;
  finePrint?: unknown;
  colorGrade?: unknown;
  brandColor?: unknown;
  fontMood?: unknown;
  sfx?: unknown;
  texture?: unknown;
  beatPulse?: unknown;
  cursor?: unknown;
  renderSettings?: unknown;
}

/** 内存态/派生数据键：不进指纹（由 sidecar 或素材本体确定性派生，含大数组防序列化拖慢） */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'cursorPoints', 'cursorClicks', 'stabCorrections', 'stabZoom', 'stabSampleFps',
  'peaks', 'beats', 'bpm', 'thumbnail', 'colorStats',
]);

/** 素材会话 URL → 原始路径（与 renderer/utils/clipPath.ts 的 clipSrcToPath 同逻辑，纯函数版） */
const unwrapSrc = (src: string): string => {
  if (!src || !/^https?:\/\//i.test(src)) return src;
  try {
    const p = new URL(src).searchParams.get('path');
    if (p) return p;
  } catch {
    // 非法 URL，原样返回
  }
  return src;
};

/** 稳定序列化：对象键排序 + 剥离挥发键 + src 还原为原始路径；undefined 按 JSON 语义丢弃/转 null */
const stableStringify = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k, v]) => v !== undefined && !VOLATILE_KEYS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(k === 'src' && typeof v === 'string' ? unwrapSrc(v) : v)}`);
  return `{${entries.join(',')}}`;
};

/** djb2 字符串哈希（32 位无符号 → 8 位 hex）；变更检测用，非安全场景 */
export const djb2Hex = (input: string): string => {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0; // h*33 + c，保持 32 位无符号
  }
  return h.toString(16).padStart(8, '0');
};

/** 计算渲染内容指纹（同一内容任意时刻/会话结果一致；内容一变即变） */
export const fingerprintRenderContent = (snapshot: RenderContentSnapshot): string =>
  djb2Hex(stableStringify(snapshot));
