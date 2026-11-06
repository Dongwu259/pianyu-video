/**
 * row-embed-layout - RowEmbed（逐行嵌入）的布局与节拍规划器（纯函数，零 React/Remotion 依赖）
 *
 * 设计稿：docs/template-design-row-embed.md §六（时间线）/ §七（四画幅）/ §八.1（本模块）。
 * 把「行雨 + 嵌入」拆成两层：**什么时候落**（节拍）与**落在哪**（版式），
 * 组件（src/remotion/templates/RowEmbed.tsx）只负责把这两个数变成画面。
 *
 * 节拍口径（30fps，N = 段帧数）：
 *   t0     = round(N · 0.18)                 第一行起播
 *   FLY    = max(4, round(12 / flySpeed))    单行飞行帧数（固定帧数，不随段长拉伸）
 *   step_i = round(step0 · (1 − staggerDecel·i/(rows−1)))   越落越快
 *   末行落地 ≤ 0.7·N 的硬保证：越界时压缩 step0 重算一次（§八.1）
 *
 * 行高口径（与设计稿 §七 的偏差，已记入 §十四）：
 *   §七 表列「行高 0.62×tokens.body」不能直接当行高——28px 的文字装不进 17px 的行。
 *   本模块把该系数解释为**行内上下留白**（以行文字 px 为基准），
 *   行高 = 行文字 × (1.3 行盒 + 系数)。四画幅的「更大/更扁」相对关系保持不变。
 *
 * 零依赖：不 import remotion / react / 设计 token——字号唯一事实源仍是
 * getScaledTokens（组件把 tokens.fontSize.body 传进来），避免 shared 侧复刻缩放公式。
 */

/** 行数硬上限（设计稿固定 ≤4 行） */
export const ROW_EMBED_MAX_ROWS = 4;
/** 单行文案建议上限（行内单行 + ellipsis，超出会截断；checkpoint ④ 同源） */
export const ROW_EMBED_MAX_ROW_CHARS = 24;
/** 单行飞行基准帧数（30fps 下 12f = 0.4s） */
export const ROW_EMBED_FLY_BASE = 12;
/** 第一行起播点（段长占比） */
export const ROW_EMBED_CUE_START_FRAC = 0.18;
/** 全部落地的预算（段长占比，§六 末行 55% 落点的上界） */
export const ROW_EMBED_LAND_BUDGET_FRAC = 0.7;
/** 面板高上限（画框占比，§七 checkpoint） */
export const ROW_EMBED_PANEL_MAX_FRAC = 0.86;
/** 短段阈值（秒）：低于此值时行数降到 3，保证每行都有完整飞行 */
export const ROW_EMBED_SHORT_SEG_SEC = 2.5;

// 参数规格（ROW_EMBED_PARAMS）住在 template-registry（§九.5 单一事实源），
// 本模块只消费它算版式——规划器不依赖注册表，组件/checkpoint 各自从注册表取。

/** 画幅档（§七 四画幅表） */
export type RowEmbedAspect = 'standard' | 'wide' | 'square' | 'portrait';

interface RowEmbedAspectSpec {
  /** 面板宽（画布宽占比） */
  panelWFrac: number;
  /** 行右侧视频条带宽（面板内容宽占比；0 = 竖版关闭） */
  bandFrac: number;
  /** 行数上限 */
  maxRows: number;
  /** 行文字倍率（相对 tokens.body） */
  textScale: number;
  /** 行内上下留白系数（以行文字 px 为基准，见文件头「行高口径」） */
  rowPadFactor: number;
  /** 左右最小安全边距（画布宽占比；21:9 要求 ≥10%） */
  sideMarginMin: number;
  /** camPush 参数上限（竖版 0.5） */
  camPushCap: number;
}

const ASPECT_SPECS: Record<RowEmbedAspect, RowEmbedAspectSpec> = {
  standard: {panelWFrac: 0.66, bandFrac: 0.18, maxRows: 4, textScale: 1, rowPadFactor: 0.62, sideMarginMin: 0.06, camPushCap: 1},
  wide: {panelWFrac: 0.56, bandFrac: 0.16, maxRows: 3, textScale: 1.08, rowPadFactor: 0.72, sideMarginMin: 0.1, camPushCap: 1},
  square: {panelWFrac: 0.8, bandFrac: 0.2, maxRows: 3, textScale: 1.02, rowPadFactor: 0.78, sideMarginMin: 0.06, camPushCap: 1},
  portrait: {panelWFrac: 0.88, bandFrac: 0, maxRows: 4, textScale: 0.96, rowPadFactor: 0.58, sideMarginMin: 0.06, camPushCap: 0.5},
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * 画幅档识别（只看画布比例，不依赖 remotion 常量）：
 * 竖版 = 高 > 宽；21:9 档（比例 > 1.86）与 1:1 档（比例 < 1.2）各自收窄行数与面板；
 * 其余（16:9 及 4:3/3:2 等）走基线档。
 */
export const rowEmbedAspectOf = (canvasW: number, canvasH: number): RowEmbedAspect => {
  const w = Math.max(1, finite(canvasW, 1920));
  const h = Math.max(1, finite(canvasH, 1080));
  if (h > w) return 'portrait';
  const ratio = w / h;
  if (ratio > 1.86) return 'wide';
  if (ratio < 1.2) return 'square';
  return 'standard';
};

export interface RowEmbedTimingInput {
  totalFrames: number;
  rows: number;
  flySpeed?: number;
  staggerDecel?: number;
  fps?: number;
}

export interface RowEmbedTiming {
  /** 每行起播帧 */
  cues: number[];
  /** 单行飞行帧数 */
  flyFrames: number;
  /** 每行落地帧（= cue + flyFrames） */
  landFrames: number[];
  /** 全部落地后的保持帧数 */
  holdFrames: number;
  /** 相邻行的间隔（steps[i] = cues[i+1] - cues[i]；末位为 0 占位） */
  steps: number[];
}

/**
 * 节拍规划（§六）。行数 0 时只回保持帧；行数 ≥1 时保证：
 * - cues 严格递增（每步 ≥1 帧）
 * - land_last ≤ max(0.7·N, t0 + FLY)——短段里固定飞行帧占满预算时不强压
 * - holdFrames ≥ 0
 */
export const planRowEmbedTiming = (input: RowEmbedTimingInput): RowEmbedTiming => {
  const fps = Math.max(1, finite(input.fps, 30));
  const totalFrames = Math.max(1, Math.round(finite(input.totalFrames, fps * 5)));
  const rows = clamp(Math.round(finite(input.rows, 0)), 0, ROW_EMBED_MAX_ROWS);
  const speed = clamp(finite(input.flySpeed, 1), 0.4, 3);
  const decel = clamp(finite(input.staggerDecel, 0.3), 0, 0.9);
  const flyFrames = Math.max(4, Math.round(ROW_EMBED_FLY_BASE / speed));

  if (rows === 0) {
    return {cues: [], flyFrames, landFrames: [], holdFrames: totalFrames, steps: []};
  }

  const t0 = Math.max(0, Math.round(totalFrames * ROW_EMBED_CUE_START_FRAC));
  // §六：step0 让末行大致落在 55% 处（分母含递减补偿）
  const denom = Math.max(1, rows - ((rows - 1) * decel) / 2);
  let step0 = Math.max(1, Math.round((totalFrames * 0.55 - t0) / denom));

  const stepsOf = (base: number): number[] =>
    Array.from({length: rows}, (_, i) =>
      Math.max(1, Math.round(base * (1 - (decel * i) / Math.max(1, rows - 1)))),
    );
  const cuesOf = (steps: number[]): number[] => {
    const cues: number[] = [t0];
    for (let i = 1; i < rows; i++) cues.push(cues[i - 1] + steps[i - 1]);
    return cues;
  };

  let steps = stepsOf(step0);
  let cues = cuesOf(steps);
  const landBudget = totalFrames * ROW_EMBED_LAND_BUDGET_FRAC;

  // 硬保证：末行落地 ≤ 0.7·N（压缩 step0 重算一次，不拉伸 FLY——砸进感靠固定短时长）
  if (cues[rows - 1] + flyFrames > landBudget) {
    const span = cues[rows - 1] - t0;
    const target = Math.max(0, landBudget - flyFrames - t0);
    const k = span > 0 ? clamp(target / span, 0, 1) : 0;
    step0 = Math.max(1, Math.floor(step0 * k));
    steps = stepsOf(step0);
    cues = cuesOf(steps);
  }

  const landFrames = cues.map((c) => c + flyFrames);
  const holdFrames = Math.max(0, totalFrames - landFrames[rows - 1]);
  return {cues, flyFrames, landFrames, holdFrames, steps};
};

/** 行数：受 features 条数、画幅上限、短段（<2.5s）上限三重约束 */
export const rowEmbedRowCount = (input: {
  featureCount: number;
  totalFrames: number;
  aspect: RowEmbedAspect;
  fps?: number;
}): number => {
  const fps = Math.max(1, finite(input.fps, 30));
  const cap = Math.min(
    ASPECT_SPECS[input.aspect].maxRows,
    input.totalFrames < ROW_EMBED_SHORT_SEG_SEC * fps ? 3 : ROW_EMBED_MAX_ROWS,
  );
  return clamp(Math.round(finite(input.featureCount, 0)), 0, cap);
};

export interface RowEmbedParams {
  flySpeed?: number;
  staggerDecel?: number;
  camPush?: number;
  rowMedia?: number;
  rowsTextScale?: number;
}

export interface RowEmbedPlanInput {
  canvasW: number;
  canvasH: number;
  totalFrames: number;
  featureCount: number;
  hasMedia: boolean;
  /** 当前画幅的 tokens.fontSize.body（getScaledTokens 已含竖版提升与宽幅封顶） */
  bodyFontPx: number;
  params?: RowEmbedParams;
  /** 文案槽是否存在（面板高随空槽收缩；缺省 true） */
  hasTitle?: boolean;
  hasSubtitle?: boolean;
  hasBrand?: boolean;
  /** 竖版平台安全区（组件从 utils/safeArea 取值传入；缺省 0） */
  safeTop?: number;
  safeBottom?: number;
  fps?: number;
}

export interface RowEmbedPlan {
  rows: number;
  /** 每行起播帧 */
  cues: number[];
  /** 单行飞行帧数 */
  flyFrames: number;
  /** 每行落地帧 */
  landFrames: number[];
  /** 全部落地后的保持帧数 */
  holdFrames: number;
  panelW: number;
  panelH: number;
  rowH: number;
  /** 行右侧视频条带宽（px；0 = 关闭） */
  mediaBandW: number;
  panelTop: number;
  // ====== 版式附加量（组件排版消费；不影响 §八.1 契约字段） ======
  aspect: RowEmbedAspect;
  panelLeft: number;
  /** 面板内边距 */
  padX: number;
  padY: number;
  /** 面板内容宽（= panelW − 2·padX） */
  contentW: number;
  /** 行文字实际 px（tokens.body × 画幅档 × rowsTextScale） */
  rowTextPx: number;
  titlePx: number;
  subtitlePx: number;
  brandPx: number;
  /** 面板内小间距（头部行距/行区上距/页脚上距的基准） */
  gapS: number;
  /** 面板头部/页脚占位高（rows 之前/之后） */
  headerH: number;
  footerH: number;
  /** 未压缩的自然面板高（= padY×2 + 头部 + 行区自然高 + 页脚；> 86% 画框时 checkpoint 报） */
  panelNaturalH: number;
  /** 相机推近最大 scale 增量（0.06 × camPush，竖版按 0.5 档封顶） */
  camScale: number;
}

/**
 * 规划一次 RowEmbed 段：节拍 + 四画幅版式（§六/§七/§八.1）。
 * 面板恒水平居中；垂直居中并被 safeTop/safeBottom 钳制（竖版平台安全区）。
 */
export const planRowEmbed = (input: RowEmbedPlanInput): RowEmbedPlan => {
  const fps = Math.max(1, finite(input.fps, 30));
  const canvasW = Math.max(1, finite(input.canvasW, 1920));
  const canvasH = Math.max(1, finite(input.canvasH, 1080));
  const totalFrames = Math.max(1, Math.round(finite(input.totalFrames, fps * 5)));
  const bodyPx = Math.max(8, finite(input.bodyFontPx, 28));
  const aspect = rowEmbedAspectOf(canvasW, canvasH);
  const spec = ASPECT_SPECS[aspect];
  const rowsTextScale = clamp(finite(input.params?.rowsTextScale, 1), 0.5, 2);
  const rows = rowEmbedRowCount({
    featureCount: input.featureCount,
    totalFrames,
    aspect,
    fps,
  });

  const timing = planRowEmbedTiming({
    totalFrames,
    rows,
    flySpeed: input.params?.flySpeed,
    staggerDecel: input.params?.staggerDecel,
    fps,
  });

  // ====== 版式（§七） ======
  const sideMargin = canvasW * spec.sideMarginMin;
  const panelW = Math.round(Math.min(canvasW * spec.panelWFrac, canvasW - 2 * sideMargin));
  const panelLeft = Math.round((canvasW - panelW) / 2);
  const padX = Math.round(panelW * 0.055);
  const padY = Math.round(padX * 0.85);
  const contentW = panelW - padX * 2;

  const rowTextPx = bodyPx * spec.textScale * rowsTextScale;
  const rowHNatural = Math.max(rowTextPx * 1.2, rowTextPx * (1.3 + spec.rowPadFactor));

  const titlePx = bodyPx * 1.7;
  const subtitlePx = bodyPx * 0.82;
  const brandPx = bodyPx * 0.55;
  const gapS = bodyPx * 0.45;
  const hasTitle = input.hasTitle ?? true;
  const hasSubtitle = input.hasSubtitle ?? true;
  const hasBrand = input.hasBrand ?? true;

  const headerH = Math.round(
    (hasTitle ? titlePx * 1.18 : 0) +
      (hasSubtitle ? (hasTitle ? gapS * 0.6 : 0) + subtitlePx * 1.35 : 0) +
      (rows > 0 ? gapS * 2 : 0),
  );
  const footerH = Math.round(
    hasBrand
      ? (rows > 0 || hasTitle || hasSubtitle ? gapS * 2 : 0) + brandPx * 1.4
      : 0,
  );

  // 面板高 = 头部 + 行区 + 页脚 + 内边距；超 86% 画框时压缩行高（checkpoint ③ 的兜底）
  const maxPanelH = Math.round(canvasH * ROW_EMBED_PANEL_MAX_FRAC);
  const fixedH = padY * 2 + headerH + footerH;
  const panelNaturalH = Math.round(fixedH + rows * Math.round(rowHNatural));
  let rowH = Math.round(rowHNatural);
  if (rows > 0 && fixedH + rows * rowH > maxPanelH) {
    rowH = Math.max(
      Math.round(rowTextPx * 1.15),
      Math.floor((maxPanelH - fixedH) / rows),
    );
  }
  const panelH = Math.max(
    1,
    Math.round(Math.min(maxPanelH, fixedH + rows * rowH)),
  );

  // 面板垂直位置：居中 + 安全区钳制（竖版 10%/18% 平台遮挡）
  const safeTop = Math.max(0, finite(input.safeTop, 0));
  const safeBottom = Math.max(0, finite(input.safeBottom, 0));
  const centered = (canvasH - panelH) / 2;
  const maxTop = Math.max(safeTop, canvasH - panelH - safeBottom);
  const panelTop = Math.round(clamp(centered, safeTop, maxTop));

  // 行纹理条带：无素材 / 参数关 / 竖版（§七 表 9:16 列）一律退化 0
  const rowMediaOn = finite(input.params?.rowMedia, 1) >= 0.5;
  const mediaBandW =
    rows > 0 && input.hasMedia && rowMediaOn && spec.bandFrac > 0
      ? Math.round(contentW * spec.bandFrac)
      : 0;

  const camPush = clamp(finite(input.params?.camPush, 0.7), 0, 1);
  const camScale = 0.06 * Math.min(camPush, spec.camPushCap);

  return {
    rows,
    cues: timing.cues,
    flyFrames: timing.flyFrames,
    landFrames: timing.landFrames,
    holdFrames: timing.holdFrames,
    panelW,
    panelH,
    rowH,
    mediaBandW,
    panelTop,
    aspect,
    panelLeft,
    padX,
    padY,
    contentW,
    rowTextPx,
    titlePx,
    subtitlePx,
    brandPx,
    gapS,
    headerH,
    footerH,
    panelNaturalH,
    camScale,
  };
};
