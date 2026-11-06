/**
 * UI 面板视觉检测（B6 PanelFlyout 的通用能力线）
 *
 * 从单帧灰度像素里找「软件面板」的归一化矩形。设计目标：通用（任意桌面软件的录屏，
 * 不只是片语自己），Electron/web 目标另有 cdp/ax 精确线（见 shared/ui-regions.ts 头注），
 * 本模块是兜底的通用线。
 *
 * 算法（桌面 UI 的结构先验：面板=大片均匀底色，被低信息量的分割缝分开）：
 * 1. 列/行均值剖面：colMean[x] / rowMean[y]（面板底色差异反映为剖面的台阶）；
 * 2. 找「分割缝」：该列/行本身低方差（纯色缝），且两侧 ±window 列/行均值差显著；
 * 3. 候选缝合并成切割位（最多左右 2 刀 + 上下 1 刀，带间 ≥ minBand）；
 * 4. 切割位张成网格，格子按位置赋角色：左带=sidebar / 右带=panel / 中下带=timeline /
 *   最大格=main；角格并入所属列带（侧栏/属性板通常通高）。
 * 输出置信度 = 缝两侧对比度归一（低于阈值的整帧返回单 main 区域，模板仍可渲染）。
 *
 * 跨帧聚合：aggregateCuts 对多帧切割位做 2% 宽度聚类，取多数派的中位数——面板在
 * 操作过程中基本不动，闪烁的弹层/菜单被多数派滤掉。
 */

export interface DetectedRegion {
  id: string;
  role: 'sidebar' | 'panel' | 'timeline' | 'main';
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 单帧列/行剖面的切割位：pos 归一化坐标，contrast 缝两侧均差（0-255 口径） */
export interface CutCandidate {
  pos: number;
  contrast: number;
}

interface Profiles {
  colMean: Float64Array;
  rowMean: Float64Array;
  colVar: Float64Array;
  rowVar: Float64Array;
}

/** 灰度剖面（列/行均值与列/行内方差） */
export const computeProfiles = (gray: Uint8Array | Uint8ClampedArray, w: number, h: number): Profiles => {
  const colMean = new Float64Array(w);
  const rowMean = new Float64Array(h);
  const colVar = new Float64Array(w);
  const rowVar = new Float64Array(h);
  const colSum2 = new Float64Array(w);
  const rowSum2 = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[rowOff + x];
      colMean[x] += v;
      rowSum += v;
      colSum2[x] += v * v;
      rowSum2[y] += v * v;
    }
    rowMean[y] = rowSum / w;
    rowVar[y] = Math.max(0, rowSum2[y] / w - rowMean[y] * rowMean[y]);
  }
  for (let x = 0; x < w; x++) {
    colMean[x] /= h;
    colVar[x] = Math.max(0, colSum2[x] / h - colMean[x] * colMean[x]);
  }
  return {colMean, rowMean, colVar, rowVar};
};

/**
 * 剖面找切割位：位置 i 处是「缝」= 两侧平台（±win 窗的剖面均值各自低方差=平坦底色）
 * 之间存在台阶（均值差 > contrastThr），过渡带宽 ≤ 2×half。
 * 判据用剖面平台平坦度而非像素方差——剖面方差混的是另一条轴上的色带（时间轴条等），
 * 会把真缝全部误杀。
 */
export const findCuts = (
  mean: Float64Array,
  contrastThr: number,
  minBand: number,
  plateauThr = 25,
): CutCandidate[] => {
  const n = mean.length;
  const lo = Math.round(n * minBand);
  const hi = n - lo;
  const half = Math.max(2, Math.round(n * 0.006));
  const win = Math.max(4, Math.round(n * 0.03));
  const out: CutCandidate[] = [];
  const windowStats = (from: number, to: number): {mean: number; variance: number} | null => {
    const a = Math.max(0, from);
    const b = Math.min(n, to);
    if (b - a < 2) return null;
    let s = 0;
    let s2 = 0;
    for (let k = a; k < b; k++) {
      s += mean[k];
      s2 += mean[k] * mean[k];
    }
    const m = s / (b - a);
    return {mean: m, variance: Math.max(0, s2 / (b - a) - m * m)};
  };
  for (let i = lo; i < hi; i++) {
    const L = windowStats(i - half - win, i - half);
    const R = windowStats(i + half + 1, i + half + 1 + win);
    if (!L || !R) continue;
    let contrast = 0;
    if (L.variance <= plateauThr && R.variance <= plateauThr) {
      // 缝型一：台阶（两侧平台色不同）
      contrast = Math.abs(L.mean - R.mean);
    } else {
      // 缝型二：凹缝（分割线比两侧平台都暗——暗色 UI 的 1px 边框线；
      // 中点均值取 ±half 内最小，避开过渡抖动）
      let mid = Infinity;
      for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) mid = Math.min(mid, mean[k]);
      const sides = Math.min(L.mean, R.mean);
      if (mid < sides - contrastThr * 0.75) contrast = sides - mid;
    }
    if (contrast < contrastThr) continue;
    out.push({pos: i / n, contrast});
  }
  // 同一条缝的候选带宽度 = 2×half+2（L/R 平滑窗的滑程），合并距离随之推导
  const mergeDist = (2 * half + 2) / n;
  const merged: CutCandidate[] = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && c.pos - last.pos < mergeDist) {
      if (c.contrast > last.contrast) merged[merged.length - 1] = c;
    } else merged.push(c);
  }
  return merged;
};

/** 从切割位挑刀：按对比度降序贪心，保证任意两刀间距 ≥ minBand */
export const pickCuts = (cuts: CutCandidate[], maxCuts: number, minBand: number): CutCandidate[] => {
  const sorted = [...cuts].sort((a, b) => b.contrast - a.contrast);
  const picked: CutCandidate[] = [];
  for (const c of sorted) {
    if (picked.length >= maxCuts) break;
    if (picked.every((p) => Math.abs(p.pos - c.pos) >= minBand)) picked.push(c);
  }
  return picked.sort((a, b) => a.pos - b.pos);
};

/** 跨帧切割位聚合：2% 宽度聚类，出现在的帧数 ≥ 多数派阈值（≥60% 帧数）的簇取中位数 */
export const aggregateCuts = (
  cutSets: CutCandidate[][],
  minBand: number,
): CutCandidate[] => {
  const frames = cutSets.length;
  if (frames === 0) return [];
  const all: Array<{pos: number; contrast: number}> = [];
  for (const set of cutSets) for (const c of set) all.push(c);
  all.sort((a, b) => a.pos - b.pos);
  const clusters: Array<{positions: number[]}> = [];
  for (const c of all) {
    const last = clusters[clusters.length - 1];
    if (last && c.pos - last.positions[last.positions.length - 1] < 0.02) last.positions.push(c.pos);
    else clusters.push({positions: [c.pos]});
  }
  const majority = Math.max(2, Math.ceil(frames * 0.6));
  const survivors = clusters
    .filter((cl) => cl.positions.length >= majority)
    .map((cl) => {
      const sortedPos = [...cl.positions].sort((a, b) => a - b);
      const mid = sortedPos[Math.floor(sortedPos.length / 2)];
      return {pos: mid, contrast: cl.positions.length / frames};
    });
  // 冲突裁决：支持多的簇优先占位（minBand 内的弱簇让位）——真缝旁的内容边簇不再顶掉真缝
  const kept: CutCandidate[] = [];
  for (const c of [...survivors].sort((a, b) => b.contrast - a.contrast)) {
    if (kept.every((k) => Math.abs(k.pos - c.pos) >= minBand)) kept.push(c);
  }
  // 兜底中位：多数派落空（缝位随视图切换微动）但过半帧都有候选时，取全体候选中位数——
  // 估计量仍然稳健（中位数对两侧抖动不敏感），比「没有横刀=时间轴整块丢失」好得多
  if (kept.length === 0 && all.length >= Math.ceil(frames * 0.5)) {
    const allPos = all.map((c) => c.pos).sort((a, b) => a - b);
    return [{pos: allPos[Math.floor(allPos.length / 2)], contrast: all.length / frames}];
  }
  return kept.sort((a, b) => a.pos - b.pos);
};

/** 单帧检测：灰度图 → 角色化区域列表（v1 最多 sidebar/main/panel/timeline 四块） */
export const detectUiRegions = (
  gray: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  opts?: {contrastThr?: number; minBand?: number},
): DetectedRegion[] => {
  if (!(w > 0) || !(h > 0) || gray.length < w * h) return [];
  const contrastThr = opts?.contrastThr ?? 12;
  const minBand = opts?.minBand ?? 0.09;
  const {colMean, rowMean} = computeProfiles(gray, w, h);
  const vCuts = pickCuts(findCuts(colMean, contrastThr, minBand), 2, minBand);
  const hCuts = pickCuts(findCuts(rowMean, contrastThr, minBand), 1, minBand);
  return buildRegions(vCuts, hCuts);
};

/**
 * 切割位 → 角色化区域（纯函数，跨帧聚合后复用同一套角色逻辑——extract-ui-regions
 * 脚本与本检测器共用，避免两处角色规则漂移）。
 *
 * 区域模型 = 桌面软件结构先验：左右窄带（≤40%/45%）为通高侧栏/属性板，中央区被
 * 横刀切成「主区（上）+ 时间轴（下）」；无横刀则中央整块为主区。中列附加刀位 v1 不用。
 */
export const buildRegions = (vCuts: CutCandidate[], hCuts: CutCandidate[]): DetectedRegion[] => {
  const xs = [0, ...vCuts.map((c) => c.pos), 1];
  const ys = [0, ...hCuts.map((c) => c.pos), 1];
  const colCount = xs.length - 1;
  const colW = (i: number): number => xs[i + 1] - xs[i];
  const bandLeft = colCount >= 2 && colW(0) <= 0.4;
  const bandRight = colCount >= 2 && colW(colCount - 1) <= 0.45;
  const x0 = bandLeft ? xs[1] : 0;
  const x1 = bandRight ? xs[colCount - 1] : 1;
  const hasBottom = ys.length >= 3;
  const bottomY = ys[ys.length - 2];
  const regions: DetectedRegion[] = [];
  if (bandLeft) regions.push({id: 'sidebar', role: 'sidebar', x: 0, y: 0, w: xs[1], h: 1, score: clamp01(0.4 + 0.6 * colW(0))});
  if (bandRight) regions.push({id: 'panel', role: 'panel', x: xs[colCount - 1], y: 0, w: 1 - xs[colCount - 1], h: 1, score: clamp01(0.4 + 0.6 * colW(colCount - 1))});
  if (hasBottom) {
    regions.push({id: 'main', role: 'main', x: x0, y: 0, w: x1 - x0, h: bottomY, score: clamp01(0.4 + 0.6 * (x1 - x0))});
    regions.push({id: 'timeline', role: 'timeline', x: x0, y: bottomY, w: x1 - x0, h: 1 - bottomY, score: clamp01(0.4 + 0.6 * (1 - bottomY))});
  } else {
    regions.push({id: 'main', role: 'main', x: x0, y: 0, w: x1 - x0, h: 1, score: clamp01(0.4 + 0.6 * (x1 - x0))});
  }
  return regions;
};
