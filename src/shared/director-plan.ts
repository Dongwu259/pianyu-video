/**
 * 导播分析器（1.5.0「录屏即成品」M1）——共享纯逻辑，MCP 工具 / ScreenDemo 模板 / 单测共用。
 *
 * 职责：一段带光标轨迹的原始录屏 → 镜头计划（shot plan）。
 * 输入信号全部来自录屏 sidecar（capture.ts 的 CursorTrackFile）：
 * - 移动能量：轨迹相邻位移积分（归一化坐标，分辨率无关）；
 * - 点击突发：uiohook 点击事件 = 操作锚点（必落小景中心）；
 * - 停顿：能量近零 ≥1.2s = 上下文段（大景；超长停顿内大/中交替，出「缓推」感）。
 *
 * 输出规则（RESEARCH-SCREENDEMO.md §三.1，参照 FocuSee/Screen Studio 运动分析）：
 * - 相邻镜头景别必不同（同一运动样式不连续出现，画面始终在变）；
 * - 单镜头 1.2–4s（边界吸收最多外溢 0.6s，保证时间线无缝全覆盖）；
 * - 点击必落小景中心（focus = 点击点，前 0.9s 铺垫后 1.1s 看后果）；
 * - 倾斜-摆正循环：0 / -2° / 0 / +2°（模板换算弧度，相邻不重复）；
 * - 景别跨两级（大↔小）用 whoosh 过渡，其余硬切。
 *
 * 与渲染解耦：产物是可人工改的 JSON（挂 segment），ScreenDemo 模板（M2）按计划切换
 * 取景视口与倾斜；focus 为归一化坐标（0..1），各景别的缩放数值由模板映射。
 *
 * 全部纯函数，不 import 运行时依赖；实测依据（2026-09-22，真实 sidecar 三份）：
 * 采集 30.5 点/秒（33ms 中位间隔，静止也照采、静止位移精确为 0）、偶发 100-160ms 采样空洞
 * （本模块跨空洞不计移动、按静止处理）。
 */

import type {CursorPoint, CursorClick} from './capture';

/** 景别：wide=大景（全画幅上下文）/ medium=中景（半推近）/ close=小景（特写操作点） */
export type ShotScale = 'wide' | 'medium' | 'close';

/** 进入镜头的过渡：cut=硬切 / whoosh=快甩+动态模糊（景别跨两级时用） */
export type ShotTrans = 'cut' | 'whoosh';

/** 镜头划分依据（人工改计划的抓手）：click=点击锚定 / pause=停顿上下文 / energy=活动节奏 / coverage=兜底全覆盖 */
export type ShotReason = 'click' | 'pause' | 'energy' | 'coverage';

/** 单个镜头（时间线无缝衔接：shot[i+1].t0 === shot[i].t1） */
export interface DirectorShot {
  /** 起点（秒，素材时间线，含） */
  t0: number;
  /** 终点（秒，不含） */
  t1: number;
  /** 景别 */
  scale: ShotScale;
  /** 特写焦点（归一化 0..1 视频坐标）；wide 景为 null（全画幅不偏移） */
  focus: {x: number; y: number} | null;
  /** 倾斜档位（度，-2|0|+2；模板换算弧度，0 = 摆正） */
  tilt: number;
  /** 进入本镜头的过渡 */
  trans: ShotTrans;
  /** 划分依据 */
  reason: ShotReason;
  /**
   * 内容拟合建议缩放（视频像素空间，≥1；wide 恒 1 不发此字段）。
   * 按镜头跨度内光标活动包围盒（外扩 35%）算出「bbox 占画面 ~62%」的缩放——
   * 缩放随演示目标尺寸走：点小按钮=重特写、扫大面板=轻推近（替代固定档位倍率的
   * 「莫名放大」，34 轮用户审片结论）。模板端按景别档位钳制后使用。
   */
  zoomFit?: number;
}

/** 导播输入：sidecar 的轨迹/点击 + 素材元信息（坐标均为视频像素，与 CursorTrackFile 一致） */
export interface DirectorTrackInput {
  points: CursorPoint[];
  clicks?: CursorClick[];
  videoWidth: number;
  videoHeight: number;
  /** 素材总时长（秒；媒体元数据，可与轨迹末点略异，以它为准切分时间线） */
  durationSec: number;
  /**
   * 内容确认窗（素材媒体绝对秒；来源 = cue 表 .cues.json，录制期声明/人工标注）。
   * 语义约束：小景（特写）只允许落在窗内——镜头跨度 ≥60% 与窗重叠才算窗内，
   * 窗外没有已声明的精彩内容，2.6× 特写极易切到空白画布/无关区域（v10 全流程片实锤）。
   * 未声明（undefined/空表）时不约束（与历史行为一致）；窗外点击锚/能量小景降为中景，
   * 相邻景别修复同样不得把窗外镜头翻回特写。
   */
  contentWindows?: Array<{t0: number; t1: number}>;
}

/** 可调参数（默认值即推荐值；单测与调用方可局部覆盖） */
export interface DirectorPlanOptions {
  /** 单镜头最短秒数 */
  minShotSec?: number;
  /** 单镜头最长秒数（相邻镜头吸收间隙后允许外溢至 +0.6s） */
  maxShotSec?: number;
  /** 停顿判定：能量近零持续此时长才算上下文段 */
  pauseMinSec?: number;
  /** 点击小景向前铺垫秒数（观众先看到要点的位置） */
  clickPreSec?: number;
  /** 点击小景向后延续秒数（看到点击的后果） */
  clickPostSec?: number;
  /** 点击聚簇：间隔小于此的多次点击并进同一个小景 */
  clickClusterGapSec?: number;
  /** 能量统计的 bin 宽（秒） */
  binSec?: number;
  /** 每 bin 归一化位移低于此 = 静止（真实静止精确为 0；此值 ≈ 8px/100ms@2560 宽的容噪上界） */
  stillEps?: number;
  /** 每 bin 位移低于此 = 低活动（倾向大景） */
  activeEps?: number;
  /** 每 bin 位移高于此 = 高活动（倾向小景；≈ 128px/100ms@2560 宽的快速掠动） */
  closeEnergy?: number;
}

export const DIRECTOR_DEFAULTS: Required<DirectorPlanOptions> = {
  minShotSec: 1.2,
  maxShotSec: 4.0,
  pauseMinSec: 1.2,
  clickPreSec: 0.9,
  clickPostSec: 1.1,
  clickClusterGapSec: 2.2,
  binSec: 0.1,
  stillEps: 0.003,
  activeEps: 0.006,
  closeEnergy: 0.05,
};

/** 各景别的建议缩放倍率（M2 ScreenDemo 模板映射 viewport 用；wide = 原画幅） */
export const SHOT_ZOOM: Record<ShotScale, number> = {wide: 1, medium: 1.7, close: 2.6};

const SCALE_LEVEL: Record<ShotScale, number> = {wide: 0, medium: 1, close: 2};
const ALL_SCALES: ShotScale[] = ['wide', 'medium', 'close'];
/** 倾斜-摆正循环：正 → 左倾 → 摆正 → 右倾 → 摆正……相邻档位必不同 */
const TILT_CYCLE = [0, -2, 0, 2] as const;
/** focus 允许落点范围（归一化）：留 4% 边，避免特写视口越出画面 */
const FOCUS_MIN = 0.04;
const FOCUS_MAX = 0.96;

interface AnchorWindow {
  t0: number;
  t1: number;
  scale: ShotScale;
  focus: {x: number; y: number} | null;
  reason: ShotReason;
}

interface EnergyBin {
  /** 本 bin 内归一化位移总量 */
  energy: number;
  /** 位移加权的焦点累计（sx/weight, sy/weight = 活动质心） */
  sx: number;
  sy: number;
  weight: number;
  /** 本 bin 是否有轨迹点经过（无点 = 采样空洞，按静止计） */
  hasCursor: boolean;
  /** 本 bin 是否有点击 */
  hasClick: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampFocus = (f: {x: number; y: number} | null) =>
  f ? {x: clamp(f.x, FOCUS_MIN, FOCUS_MAX), y: clamp(f.y, FOCUS_MIN, FOCUS_MAX)} : null;
/**
 * 小景合法性（内容窗约束）：镜头跨度的大部分（≥60%）与内容窗重叠才允许特写。
 * 用「大部分重叠」而非「中点在窗内」：3-4s 的长镜头跨窗边缘时中点测试会漏网
 * （v10 a3 [8.7,11.5] 中点 10.1 在窗外却因跨 [5,8] 边缘被判窗内）。未声明 = 不约束。
 */
const CLOSE_IN_WINDOW_FRAC = 0.6;
const closeAllowed = (t0: number, t1: number, cw: Array<{t0: number; t1: number}> | undefined): boolean => {
  if (!cw || cw.length === 0) return true;
  let overlap = 0;
  for (const w of cw) overlap += Math.max(0, Math.min(t1, w.t1) - Math.max(t0, w.t0));
  return Math.min(overlap, t1 - t0) >= CLOSE_IN_WINDOW_FRAC * (t1 - t0);
};

/** 内容拟合取景参数：bbox 外扩比例 / 目标画面占比 / 跨度前后各看一点上下文 / bbox 最小尺寸（防小目标无限放大） */
const FIT_PAD = 0.35;
const FIT_TARGET = 0.62;
const FIT_CONTEXT_SEC = 0.25;
const FIT_MIN_SPAN_X = 0.12;
const FIT_MIN_SPAN_Y = 0.09;

/** 镜头跨度内光标包围盒 → 建议缩放（归一化坐标下可视宽高都是 1/z，双轴取更宽者）；点数不足回退 undefined */
const computeZoomFit = (
  t0: number,
  t1: number,
  pts: {t: number; x: number; y: number}[],
  dur: number,
): number | undefined => {
  const lo = Math.max(0, t0 - FIT_CONTEXT_SEC);
  const hi = Math.min(dur, t1 + FIT_CONTEXT_SEC);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
  for (const p of pts) {
    if (p.t < lo || p.t > hi) continue;
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
    n++;
  }
  if (n < 3) return undefined;
  const bw = Math.max((x1 - x0) * (1 + FIT_PAD * 2), FIT_MIN_SPAN_X);
  const bh = Math.max((y1 - y0) * (1 + FIT_PAD * 2), FIT_MIN_SPAN_Y);
  return Math.round(Math.max(1, Math.min(FIT_TARGET / bw, FIT_TARGET / bh)) * 100) / 100;
};

/**
 * 活动能量曲线：轨迹 + 点击 → 每 bin 能量与活动质心。
 * 独立导出：M1 可视化预览 / M2 模板调速 / 单测共用。
 * 跨采样空洞（>200ms 无点）不计位移（空洞期间的移动方向未知）；空洞 bin 记静止。
 */
export const buildActivityCurve = (
  points: CursorPoint[],
  clicks: CursorClick[],
  durationSec: number,
  binSec: number,
): EnergyBin[] => {
  const nBins = Math.max(1, Math.ceil(durationSec / binSec));
  const bins: EnergyBin[] = Array.from({length: nBins}, () => ({energy: 0, sx: 0, sy: 0, weight: 0, hasCursor: false, hasClick: false}));
  const norm: {t: number; x: number; y: number}[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    norm.push({t: p.t / 1000, x: p.x, y: p.y});
  }
  norm.sort((a, b) => a.t - b.t);
  for (const p of norm) {
    const b = clamp(Math.floor(p.t / binSec), 0, nBins - 1);
    bins[b].hasCursor = true;
  }
  for (const c of clicks) {
    const b = clamp(Math.floor(c.t / 1000 / binSec), 0, nBins - 1);
    bins[b].hasClick = true;
  }
  for (let i = 1; i < norm.length; i++) {
    const dt = norm[i].t - norm[i - 1].t;
    if (dt <= 0 || dt > 0.2) continue;
    const d = Math.hypot(norm[i].x - norm[i - 1].x, norm[i].y - norm[i - 1].y);
    if (d <= 0) continue;
    const b = clamp(Math.floor(norm[i].t / binSec), 0, nBins - 1);
    bins[b].energy += d;
    bins[b].sx += ((norm[i].x + norm[i - 1].x) / 2) * d;
    bins[b].sy += ((norm[i].y + norm[i - 1].y) / 2) * d;
    bins[b].weight += d;
  }
  return bins;
};

/** bin 区间 [i0,i1) 的活动质心（归一化）；无位移时回退到区间内最后一个轨迹点 */
const spanCentroid = (
  bins: EnergyBin[],
  i0: number,
  i1: number,
  points: {t: number; x: number; y: number}[],
  binSec: number,
): {x: number; y: number} | null => {
  let sx = 0;
  let sy = 0;
  let w = 0;
  for (let i = Math.max(0, i0); i < Math.min(bins.length, i1); i++) {
    if (bins[i].weight <= 0) continue;
    sx += bins[i].sx;
    sy += bins[i].sy;
    w += bins[i].weight;
  }
  if (w > 0) return {x: sx / w, y: sy / w};
  let last: {x: number; y: number} | null = null;
  for (const p of points) {
    if (p.t >= i0 * binSec && p.t < i1 * binSec) last = {x: p.x, y: p.y};
  }
  return last;
};

/** 停顿段检测：连续能量 < stillEps 且无点击的 bin 区间；短于 pauseMinSec 的丢弃 */
const detectPauseSpans = (bins: EnergyBin[], binSec: number, stillEps: number, pauseMinSec: number): [number, number][] => {
  const spans: [number, number][] = [];
  let run = -1;
  for (let i = 0; i <= bins.length; i++) {
    const still = i < bins.length && bins[i].energy < stillEps && !bins[i].hasClick;
    if (still && run < 0) run = i;
    if (!still && run >= 0) {
      spans.push([run * binSec, i * binSec]);
      run = -1;
    }
  }
  return spans.filter(([a, b]) => b - a >= pauseMinSec);
};

/** 能量驱动的自由镜头切分：均匀分成 n 份，景别按能量定、相邻强制不同 */
const splitFill = (
  a: number,
  b: number,
  prevScale: ShotScale | null,
  bins: EnergyBin[],
  points: {t: number; x: number; y: number}[],
  o: Required<DirectorPlanOptions>,
  cw: Array<{t0: number; t1: number}> | undefined,
): AnchorWindow[] => {
  const len = b - a;
  const n = Math.max(1, Math.min(Math.floor(len / o.minShotSec + 1e-9), Math.round(len / 2.6)));
  const each = len / n;
  const out: AnchorWindow[] = [];
  let prev = prevScale;
  for (let k = 0; k < n; k++) {
    const s0 = a + k * each;
    const s1 = s0 + each;
    const i0 = Math.floor(s0 / o.binSec);
    const i1 = Math.ceil(s1 / o.binSec);
    let e = 0;
    let cnt = 0;
    for (let i = Math.max(0, i0); i < Math.min(bins.length, i1); i++) {
      e += bins[i].energy;
      cnt++;
    }
    const mean = cnt > 0 ? e / cnt : 0;
    let scale: ShotScale = mean >= o.closeEnergy ? 'close' : mean >= o.activeEps ? 'medium' : 'wide';
    if (scale === 'close' && each < 1.6) scale = 'medium';
    // 能量小景也受内容窗约束：窗外活动（如划过空白区）给中景，特写留给声明过的内容
    if (scale === 'close' && !closeAllowed(s0, s1, cw)) scale = 'medium';
    if (scale === prev) {
      // 同一运动样式不连续出现：就近代换档；代换出的小景必须过内容窗
      // （否则窗外刚降级的中景会被这里硬翻回特写——v10 a3 [3,6] 实锤的泄漏点）
      const alts: ShotScale[] = scale === 'medium' ? ['close', 'wide'] : scale === 'wide' ? ['medium', 'close'] : ['medium', 'close'];
      scale = alts.find((a) => a !== 'close' || closeAllowed(s0, s1, cw)) ?? scale;
    }
    prev = scale;
    out.push({t0: s0, t1: s1, scale, focus: clampFocus(spanCentroid(bins, i0, i1, points, o.binSec)), reason: 'energy'});
  }
  return out;
};

/**
 * 主入口：轨迹 → 镜头计划。
 * 确定性输出（无随机数，同输入同输出）；产物可直接 JSON.stringify 挂到 segment 上人工改。
 */
export const planDirectorShots = (
  track: DirectorTrackInput,
  opts?: DirectorPlanOptions,
): DirectorShot[] => {
  const o: Required<DirectorPlanOptions> = {...DIRECTOR_DEFAULTS, ...opts};
  // 素材时长缺失/非法（如直接把 CursorTrackFile 当输入）时回退到轨迹末点时间
  const lastPt = (track.points || [])[track.points.length - 1];
  const dur = Number.isFinite(track.durationSec) && track.durationSec > 0
    ? track.durationSec
    : Math.max(0, (lastPt?.t ?? 0) / 1000);
  const vw = Math.max(1, track.videoWidth || 1);
  const vh = Math.max(1, track.videoHeight || 1);
  const pts = (track.points || [])
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.t >= -50 && p.t / 1000 <= dur + 0.05)
    .map((p) => ({t: p.t / 1000, x: clamp(p.x / vw, 0, 1), y: clamp(p.y / vh, 0, 1)}))
    .sort((a, b) => a.t - b.t);

  // 兜底：无轨迹 / 素材过短 → 单个全覆盖大景
  if (pts.length < 2 || dur < o.minShotSec * 0.75) {
    return [{t0: 0, t1: Math.max(dur, 0.5), scale: 'wide', focus: null, tilt: TILT_CYCLE[0], trans: 'cut', reason: 'coverage'}];
  }

  const clicks = (track.clicks || [])
    .filter((c) => Number.isFinite(c.t) && c.t / 1000 >= 0 && c.t / 1000 <= dur)
    .sort((a, b) => a.t - b.t);
  const bins = buildActivityCurve(track.points || [], clicks, dur, o.binSec);
  const cw = track.contentWindows;

  // ---- 锚点窗：点击小景优先落位，停顿大景绕开点击窗 ----
  // 点击聚簇：间隔 ≤ clickClusterGapSec 的点击并进同一个小景（focus = 最后一击：点击后的状态才是结果）
  const clickWins: AnchorWindow[] = [];
  let ci = 0;
  while (ci < clicks.length) {
    let cj = ci;
    while (cj + 1 < clicks.length && (clicks[cj + 1].t - clicks[cj].t) / 1000 <= o.clickClusterGapSec) cj++;
    const last = clicks[cj];
    clickWins.push({
      t0: Math.max(0, clicks[ci].t / 1000 - o.clickPreSec),
      t1: Math.min(dur, last.t / 1000 + o.clickPostSec),
      // 内容窗约束：窗外点击（无声明内容，如导航过渡期点击）降为中景，特写留给窗内
      scale: closeAllowed(Math.max(0, clicks[ci].t / 1000 - o.clickPreSec), Math.min(dur, last.t / 1000 + o.clickPostSec), cw) ? 'close' : 'medium',
      focus: clampFocus({x: clamp(last.x / vw, 0, 1), y: clamp(last.y / vh, 0, 1)}),
      reason: 'click',
    });
    ci = cj + 1;
  }
  clickWins.sort((a, b) => a.t0 - b.t0);
  // 边界钳位后可能相触的点击窗并成一个
  const clickMerged: AnchorWindow[] = [];
  for (const w of clickWins) {
    const last = clickMerged[clickMerged.length - 1];
    if (last && w.t0 < last.t1) last.t1 = Math.max(last.t1, w.t1);
    else clickMerged.push({...w});
  }
  // 停顿段 → 大景，减去点击窗后落位；超长停顿切成 ≤maxShot 的多段，大/中交替（静止里的「缓推」感）
  const pauseWins: AnchorWindow[] = [];
  for (const [ps, pe] of detectPauseSpans(bins, o.binSec, o.stillEps, o.pauseMinSec)) {
    let segs: [number, number][] = [[Math.max(0, ps), Math.min(dur, pe)]];
    for (const w of clickMerged) {
      const next: [number, number][] = [];
      for (const [a, b] of segs) {
        if (w.t1 <= a || w.t0 >= b) {
          next.push([a, b]);
          continue;
        }
        if (w.t0 > a) next.push([a, w.t0]);
        if (w.t1 < b) next.push([w.t1, b]);
      }
      segs = next;
    }
    for (const [a, b] of segs) {
      if (b - a < o.pauseMinSec) continue;
      const n = Math.max(1, Math.ceil((b - a) / o.maxShotSec - 1e-9));
      const each = (b - a) / n;
      for (let k = 0; k < n; k++) {
        pauseWins.push({t0: a + k * each, t1: a + (k + 1) * each, scale: k % 2 === 0 ? 'wide' : 'medium', focus: null, reason: 'pause'});
      }
    }
  }
  const anchors = [...clickMerged, ...pauseWins].sort((a, b) => a.t0 - b.t0);

  // ---- 扫描落位：锚点窗之间用能量镜头填缝，短缝由相邻镜头吸收 ----
  const shots: AnchorWindow[] = [];
  let cursor = 0;
  for (const w of anchors) {
    if (w.t0 >= dur) break;
    const t0 = Math.max(cursor, w.t0);
    const t1 = Math.min(dur, w.t1);
    if (t1 - t0 < o.minShotSec) {
      // 只抢救点击小景（被前面锚点挤短时向前一个镜头借时长）；其余丢弃，时间由填缝兜住
      if (w.reason === 'click' && shots.length > 0) {
        const prev = shots[shots.length - 1];
        const need = o.minShotSec - (t1 - t0);
        const spare = prev.t1 - prev.t0 - o.minShotSec;
        const give = Math.min(need, Math.max(0, spare));
        if (give > 0.01) {
          prev.t1 -= give;
          shots.push({...w, t0: t0 - give, t1});
          cursor = t1;
        }
      }
      continue;
    }
    // 与前一锚点之间的缝 ≥ 最短镜长 → 能量镜头填缝；否则由本窗起点自然衔接（缝在前一循环已被吸收）
    if (t0 - cursor >= o.minShotSec) {
      const prevScale = shots.length > 0 ? shots[shots.length - 1].scale : null;
      shots.push(...splitFill(cursor, t0, prevScale, bins, pts, o, cw));
    }
    shots.push({...w, t0, t1});
    cursor = t1;
  }
  // 尾缝
  if (dur - cursor >= o.minShotSec) {
    const prevScale = shots.length > 0 ? shots[shots.length - 1].scale : null;
    shots.push(...splitFill(cursor, dur, prevScale, bins, pts, o, cw));
    cursor = dur;
  }
  // 兜底：锚点全被丢弃（极端重叠）→ 至少给一个全覆盖
  if (shots.length === 0) {
    return [{t0: 0, t1: Math.max(dur, 0.5), scale: 'wide', focus: null, tilt: TILT_CYCLE[0], trans: 'cut', reason: 'coverage'}];
  }
  // 头缝 < 最短镜长：首个镜头向前扩到 0；≥ 则正常填缝
  if (shots[0].t0 > 0) {
    if (shots[0].t0 < o.minShotSec) {
      shots[0].t0 = 0;
    } else {
      shots.unshift(...splitFill(0, shots[0].t0, null, bins, pts, o, cw));
    }
  }
  // 尾缝 < 最短镜长：末个镜头向后扩到 dur
  const lastShot = shots[shots.length - 1];
  if (lastShot.t1 < dur) {
    if (dur - lastShot.t1 < o.minShotSec) {
      lastShot.t1 = dur;
    } else {
      shots.push(...splitFill(lastShot.t1, dur, lastShot.scale, bins, pts, o, cw));
    }
  }
  // 内部短缝：两侧各吸收一半（各最多外溢 0.6s）
  for (let i = 1; i < shots.length; i++) {
    const gap = shots[i].t0 - shots[i - 1].t1;
    if (gap > 0.001 && gap < o.minShotSec) {
      shots[i - 1].t1 += gap / 2;
      shots[i].t0 -= gap / 2;
    }
  }

  // ---- 相邻景别修复（规则：同一运动样式不连续出现；候选不得违反内容窗——
  //      否则窗外被降级的镜头会被「就近换档」翻回特写，约束形同虚设）----
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].scale !== shots[i - 1].scale) continue;
    // 换掉一方：候选 = 异于当前的两档，按级差最近优先，且避开另一侧邻居（防按下葫芦起了瓢）
    const pick = (from: ShotScale, avoid: ShotScale | null, t0: number, t1: number): ShotScale | null => {
      const cands = ALL_SCALES
        .filter((s) => s !== from && s !== avoid)
        .filter((s) => s !== 'close' || closeAllowed(t0, t1, cw))
        .sort((x, y) => Math.abs(SCALE_LEVEL[x] - SCALE_LEVEL[from]) - Math.abs(SCALE_LEVEL[y] - SCALE_LEVEL[from]));
      return cands[0] ?? null;
    };
    if (shots[i].reason !== 'click') {
      const nextScale = i + 1 < shots.length ? shots[i + 1].scale : null;
      const c = pick(shots[i].scale, nextScale, shots[i].t0, shots[i].t1);
      if (c) shots[i].scale = c;
    } else if (shots[i - 1].reason !== 'click') {
      const prevPrev = i > 1 ? shots[i - 2].scale : null;
      const c = pick(shots[i - 1].scale, prevPrev, shots[i - 1].t0, shots[i - 1].t1);
      if (c) shots[i - 1].scale = c;
    } else {
      // 两个点击小景相邻（聚簇钳位后的理论死角）：并成一个
      shots[i - 1].t1 = Math.max(shots[i - 1].t1, shots[i].t1);
      shots.splice(i, 1);
      i--;
    }
  }

  // ---- 倾斜循环 + 过渡分级 + 内容拟合缩放 ----
  const out: DirectorShot[] = shots.map((s, i) => {
    const zf = s.scale !== 'wide' ? computeZoomFit(s.t0, s.t1, pts, dur) : undefined;
    return {
      t0: Math.round(s.t0 * 1000) / 1000,
      t1: Math.round(s.t1 * 1000) / 1000,
      scale: s.scale,
      // 大景恒无焦点（全画幅不偏移的契约；能量镜头被内容窗降级成大景时带质心焦点，须归空）
      focus: s.scale === 'wide' ? null : s.focus ? {x: Math.round(s.focus.x * 1000) / 1000, y: Math.round(s.focus.y * 1000) / 1000} : null,
      tilt: TILT_CYCLE[i % TILT_CYCLE.length],
      trans: i === 0 ? 'cut' : Math.abs(SCALE_LEVEL[s.scale] - SCALE_LEVEL[shots[i - 1].scale]) >= 2 ? 'whoosh' : 'cut',
      reason: s.reason,
      ...(zf !== undefined ? {zoomFit: zf} : {}),
    };
  });
  return out;
};
