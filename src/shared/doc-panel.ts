/**
 * 文档面板（P4 DocPanel）的文案解析（纯函数，单测锚定）
 *
 * 参考片（随变 35-40s）：纸面文档 + 选区高亮呼吸 + 配图占位格弹入。
 * 文案编码（features 行）：
 * - 普通行 = 文档段落；行内 `[[选区文本]]` 渲染为选区高亮（呼吸脉冲）
 * - `img:标签` 行 = 配图占位格（文档底部的虚线格子，逐格弹入），不计入段落
 */

export interface DocSegment {
  text: string;
  selected: boolean;
}

export interface DocParagraph {
  segments: DocSegment[];
}

/** 段落解析：`[[…]]` 拆选区段；空行过滤；封顶 maxParagraphs 段 */
export const parseDocParagraphs = (features: string[], maxParagraphs = 6): DocParagraph[] => {
  const out: DocParagraph[] = [];
  for (const raw of features ?? []) {
    const line = (raw ?? '').trim();
    if (!line || /^img\s*[:：]/i.test(line)) continue; // 占位格行不入段落
    const segments: DocSegment[] = [];
    const re = /\[\[(.+?)\]\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) segments.push({text: line.slice(last, m.index), selected: false});
      segments.push({text: m[1], selected: true});
      last = m.index + m[0].length;
      any = true;
    }
    if (last < line.length) segments.push({text: line.slice(last), selected: false});
    if (segments.some((s) => s.text.trim().length > 0)) out.push({segments});
    if (out.length >= maxParagraphs) break;
  }
  return out;
};

/** 配图占位格标签（`img:标签` 行，按序；封顶 4 格） */
export const parseDocPlaceholders = (features: string[], maxCells = 4): string[] =>
  (features ?? [])
    .map((raw) => /^img\s*[:：]\s*(.*)$/i.exec((raw ?? '').trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1].trim())
    .filter((label) => label.length > 0)
    .slice(0, maxCells);

export interface DocPanelTimeline {
  intro: number;
  step: number;
  paraEnter: (i: number) => number;
  cellEnter: (i: number) => number;
}

/** M2 冻结接管：段落窗（帧域；序 = 段落序 = plan 投影 captions 去 title 后的序） */
export interface DocParaWindow {
  startFrame: number;
  endFrame: number;
}

/**
 * 文档面板时间线（模板渲染与 SFX UI 音效放置同源——看到的段落入场 = 听到的提示）：
 * 入场 0.4s → 段落均分（占位格存在时留 0.9s 尾巴否则 0.4s）→ 占位格在末段 60% 后逐格 0.28s。
 *
 * M2 冻结接管：paraWindows 给出时段落入场改由物化层窗治理（paraEnter(i) = w_i.start；
 * intro = w_0.start；step = 窗口起点跨度均分——占位格锚点用，与原 step 同量纲）。
 * 缺省（undefined / 长度不足段数）= 均匀数学，未冻结段零漂移。
 */
export const docPanelTimeline = (
  paraCount: number,
  cellCount: number,
  totalFrames: number,
  fps: number,
  pace = 1,
  paraWindows?: DocParaWindow[],
): DocPanelTimeline => {
  // 宁少勿猜：覆盖层与段落数不齐 = 文案槽位变过，回退均匀数学
  const wins = paraWindows && paraWindows.length >= paraCount && paraCount > 0 ? paraWindows.slice(0, paraCount) : null;
  if (wins) {
    const intro = Math.max(0, Math.round(wins[0].startFrame));
    const starts = wins.map((w) => Math.round(w.startFrame));
    const lastStart = starts[starts.length - 1];
    const minStep = Math.max(1, Math.round(0.8 * fps));
    const step =
      starts.length > 1
        ? Math.max(minStep, Math.round((lastStart - intro) / (starts.length - 1)))
        : minStep;
    const cellBase = lastStart + step * 0.6;
    return {
      intro,
      step,
      paraEnter: (i) => (i < starts.length ? starts[i] : lastStart + step * (i - starts.length + 1)),
      cellEnter: (i) => Math.round(cellBase + i * 0.28 * fps),
    };
  }
  const intro = Math.round(0.4 * fps);
  const tail = cellCount > 0 ? Math.round(0.9 * fps) : Math.round(0.4 * fps);
  const step = Math.max(
    Math.round(0.8 * fps),
    Math.round(((totalFrames - intro - tail) / Math.max(1, paraCount)) / Math.max(0.1, pace)),
  );
  const cellBase = paraCount > 0 ? intro + (paraCount - 1) * step + step * 0.6 : intro;
  return {
    intro,
    step,
    paraEnter: (i) => intro + i * step,
    cellEnter: (i) => Math.round(cellBase + i * 0.28 * fps),
  };
};

/**
 * 文档内容纵向滚动偏移（P7 容器内滚动）：段落数多到会溢出纸面时，内容容器随
 * 浮现进度上移（新段落把旧段落推出视口——参考片的文档滚动语言）。
 * 行高估算：每段按 charsPerLine 折行（canvas 口径由调用方换算），可容忍误差——
 * 滚动是缓动观感不是排版保证。
 */
export const docScrollOffset = (
  paraTextLens: number[],
  opts: {charsPerLine: number; lineHeightPx: number; gapPx: number; availPx: number; progress: number},
): number => {
  const {charsPerLine, lineHeightPx, gapPx, availPx, progress} = opts;
  if (paraTextLens.length === 0) return 0;
  const lines = paraTextLens.map((len) => Math.max(1, Math.ceil(len / Math.max(1, charsPerLine))));
  const totalH = lines.reduce((a, l) => a + l * lineHeightPx, 0) + (paraTextLens.length - 1) * gapPx;
  const overflow = Math.max(0, totalH - availPx);
  if (overflow <= 0) return 0;
  const q = Math.min(1, Math.max(0, progress));
  // 缓出：前段少滚、后段追上
  return overflow * (1 - (1 - q) * (1 - q));
};
