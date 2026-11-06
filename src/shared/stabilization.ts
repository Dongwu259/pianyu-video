/**
 * 视频跟踪稳定 - 纯函数核心（零依赖，tsx 可直接跑单测）
 *
 * 方案 A（见 RESEARCH-STABILIZATION.md）：分析期在主进程把视频解成 480 宽灰度帧序列，
 * 围绕用户/自动放置的跟踪点做金字塔块匹配（NCC）逐帧跟踪，产出「每帧校正量表」；
 * 渲染期按表对视频平面施加 translate/rotate/scale——稳定是数据（变换表），不是重编码。
 *
 * ====== 方向约定（单测钉死，渲染层集成以本节为准）======
 * 原始跟踪：dx/dy = 跟踪点相对初始位置的位移，方向 = 画面内容移动方向（画面右移 dx>0）。
 * 校正量：StabCorrection 存「要施加到视频元素上」的值 = 平滑值 − 原始值：
 *   画面内容右移 dx（平滑轨迹为 0）→ cx = −dx（负值）→ CSS translateX 为负 → 画面被拉回。
 * 旋转：rot 用 atan2(dy, dx) 在「y 向下」的图像坐标系度量，正值 = 视觉顺时针，
 *   与 CSS rotate() 正方向一致，故 rotateDeg = crot 直接转角度（不换号）。
 * 缩放：cscale = 平滑距离比/原始距离比（内容变大了就缩回去），CSS scale = zoom × cscale。
 */

// ====== 类型 ======

/** 灰度帧（0..255 浮点，行主序） */
export interface FrameGray {
  data: Float32Array;
  width: number;
  height: number;
}

/** 跟踪点：用户/自动放置，视频像素坐标 */
export interface StabPoint {
  x: number;
  y: number;
}

/** 一帧的原始跟踪结果 */
export interface StabSample {
  t: number;      // 媒体秒
  dx: number;     // 跟踪点（多点取质心）相对初始位置的位移，视频像素，方向=内容移动方向
  dy: number;
  rot: number;    // 两点连线角度变化（弧度，y 向下坐标系，正=视觉顺时针；单点恒 0）
  scale: number;  // 两点距离比（以首帧/初始点为基准；单点恒 1）
  conf: number;   // 匹配置信度 0..1（NCC 峰值；跟丢帧保留低值标记）
}

/** 平滑后每帧应施加的校正量（方向约定见文件头） */
export interface StabCorrection {
  t: number;       // 媒体秒
  cx: number;      // 要施加的平移（视频像素）= 平滑dx − 原始dx
  cy: number;
  crot: number;    // 要施加的旋转（弧度）= 平滑rot − 原始rot
  cscale: number;  // 要施加的缩放比 = 平滑scale / 原始scale
}

/** sidecar 文件结构（<同名>.stab.json；服务侧另附 smoothSec/maxZoom/zoom） */
export interface StabTrackFile {
  version: 1;
  videoWidth: number;
  videoHeight: number;
  sourceFps: number;
  sampleFps: number;
  points: StabPoint[];
  samples: StabSample[];
}

/** 稳定参数（smoothSec 平滑窗口秒；maxZoom 自动缩放封顶） */
export interface StabParams {
  smoothSec: number;
  maxZoom: number;
}

/** solveStabilization 入参：缩放求解需要真实画幅（旋转项与宽高比相关） */
export interface StabSolveParams extends StabParams {
  videoWidth: number;
  videoHeight: number;
}

/** 共享默认值（服务/e2e/测试同口径） */
export const STAB_DEFAULTS = {
  patchSize: 24,
  coarseFactor: 4,
  coarseSearch: 16,
  fineSearch: 8,
  lostThreshold: 0.5,
  smoothSec: 0.8,
  maxZoom: 1.25,
  safety: 1.06,
  analyzeWidth: 480,
  analyzeFps: 15,
} as const;

// ====== 金字塔块匹配（NCC）======

export interface TrackOpts {
  patchSize?: number;    // 细层块边长（全分辨率像素），默认 24
  coarseFactor?: number; // 粗层缩放因子，默认 4
  coarseSearch?: number; // 粗层搜索半径（粗层像素），默认 16
  fineSearch?: number;   // 细层搜索半径（全分辨率像素），默认 8
  searchHint?: {x: number; y: number}; // 搜索中心外推（全分辨率像素，走动镜头大位移用；缺省 0 = 原行为）
}

/** 块 (cx,cy)±ps/2 是否完整落在帧内 */
const patchFits = (f: FrameGray, cx: number, cy: number, ps: number): boolean => {
  const h = ps / 2;
  return cx - h >= 0 && cy - h >= 0 && cx + h <= f.width && cy + h <= f.height;
};

/** 4 倍箱式降采样（金字塔粗层） */
const downsample4 = (f: FrameGray): FrameGray => {
  const w = Math.max(1, Math.floor(f.width / 4));
  const h = Math.max(1, Math.floor(f.height / 4));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          s += f.data[(y * 4 + dy) * f.width + (x * 4 + dx)];
        }
      }
      out[y * w + x] = s / 16;
    }
  }
  return {data: out, width: w, height: h};
};

/** 块的均值与去均值平方和（NCC 预计算） */
const patchMoments = (f: FrameGray, cx: number, cy: number, ps: number): {mean: number; varSum: number} => {
  const x0 = Math.round(cx - ps / 2);
  const y0 = Math.round(cy - ps / 2);
  let sum = 0;
  for (let y = 0; y < ps; y++) {
    for (let x = 0; x < ps; x++) sum += f.data[(y0 + y) * f.width + (x0 + x)];
  }
  const mean = sum / (ps * ps);
  let varSum = 0;
  for (let y = 0; y < ps; y++) {
    for (let x = 0; x < ps; x++) {
      const d = f.data[(y0 + y) * f.width + (x0 + x)] - mean;
      varSum += d * d;
    }
  }
  return {mean, varSum};
};

/**
 * 零均值归一化互相关（-1..1）：ref 固定于 prev 帧 (rx,ry)，候选块在 curr 帧 (cx,cy)。
 * 任一块方差≈0（纯色无纹理）返回 0——无法可靠匹配。
 */
const nccAt = (
  prev: FrameGray, rx: number, ry: number,
  curr: FrameGray, cx: number, cy: number,
  ps: number, refMean: number, refVarSum: number,
): number => {
  if (refVarSum < 1e-6) return 0;
  const m = patchMoments(curr, cx, cy, ps);
  if (m.varSum < 1e-6) return 0;
  const x0r = Math.round(rx - ps / 2);
  const y0r = Math.round(ry - ps / 2);
  const x0c = Math.round(cx - ps / 2);
  const y0c = Math.round(cy - ps / 2);
  let cross = 0;
  for (let y = 0; y < ps; y++) {
    for (let x = 0; x < ps; x++) {
      cross +=
        (prev.data[(y0r + y) * prev.width + (x0r + x)] - refMean) *
        (curr.data[(y0c + y) * curr.width + (x0c + x)] - m.mean);
    }
  }
  return cross / Math.sqrt(refVarSum * m.varSum);
};

/** 在整数搜索窗内找 NCC 峰值；返回 null = 窗内无可放置候选（帧太小） */
const searchBest = (
  prev: FrameGray, rx: number, ry: number,
  curr: FrameGray, cx: number, cy: number,
  radius: number, ps: number, refMean: number, refVarSum: number,
  scores?: Float32Array, // 传入时按 (dy+radius)*w + (dx+radius) 记录各位置得分（亚像素拟合用）
): {bx: number; by: number; score: number} | null => {
  let best: {bx: number; by: number; score: number} | null = null;
  const w = radius * 2 + 1;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (!patchFits(curr, px, py, ps)) continue;
      const s = nccAt(prev, rx, ry, curr, px, py, ps, refMean, refVarSum);
      if (scores) scores[(dy + radius) * w + (dx + radius)] = s;
      if (!best || s > best.score) best = {bx: px, by: py, score: s};
    }
  }
  return best;
};

/** 抛物线亚像素拟合：峰值两侧得分 → 偏移量（−1..1；分母≈0 或越界回 0） */
const subpixel = (sL: number, sC: number, sR: number): number => {
  const denom = sL - 2 * sC + sR; // 峰值处恒 ≤0
  if (denom >= -1e-9) return 0;
  const d = (0.5 * (sL - sR)) / denom;
  return Math.max(-1, Math.min(1, d));
};

/**
 * 金字塔两层块匹配：跟踪 prev 帧中 (x,y) 处的斑块在 curr 帧的位置。
 * 粗层（1/4 分辨率，搜索窗 ±coarseSearch 粗层像素）→ 细层（全分辨率，以粗层结果
 * 为中心 ±fineSearch 步长 1）→ 最佳位置抛物线拟合亚像素。
 * 返回 {nx, ny} = curr 帧中的亚像素位置；score = 细层 NCC 峰值（-1..1）。
 * 参考块在 prev 帧出界（点贴边/出画）时返回 score=-2 哨兵。
 */
export const trackPatch = (
  prev: FrameGray, curr: FrameGray, x: number, y: number, opts: TrackOpts = {},
): {nx: number; ny: number; score: number} => {
  const ps = opts.patchSize ?? STAB_DEFAULTS.patchSize;
  const factor = opts.coarseFactor ?? STAB_DEFAULTS.coarseFactor;
  const coarseR = opts.coarseSearch ?? STAB_DEFAULTS.coarseSearch;
  const fineR = opts.fineSearch ?? STAB_DEFAULTS.fineSearch;

  if (!patchFits(prev, x, y, ps)) return {nx: x, ny: y, score: -2};

  const hintX = opts.searchHint?.x ?? 0;
  const hintY = opts.searchHint?.y ?? 0;

  // ---- 粗层：1/4 分辨率粗定位（量化误差 ≤2 全分辨率像素，细层窗口 ±8 覆盖）----
  let fineCx = x + hintX;
  let fineCy = y + hintY;
  const prevC = downsample4(prev);
  const currC = downsample4(curr);
  const cps = Math.max(4, Math.round(ps / factor));
  const rx = x / factor;
  const ry = y / factor;
  if (patchFits(prevC, rx, ry, cps)) {
    const rm = patchMoments(prevC, rx, ry, cps);
    const coarse = searchBest(prevC, rx, ry, currC, rx + hintX / factor, ry + hintY / factor, coarseR, cps, rm.mean, rm.varSum);
    if (coarse) {
      fineCx = coarse.bx * factor;
      fineCy = coarse.by * factor;
    }
  }

  // ---- 细层：全分辨率，以粗层结果为中心 ±fineSearch ----
  const fm = patchMoments(prev, x, y, ps);
  const w = fineR * 2 + 1;
  const scores = new Float32Array(w * w).fill(-2);
  const fine = searchBest(prev, x, y, curr, fineCx, fineCy, fineR, ps, fm.mean, fm.varSum, scores);
  if (!fine) return {nx: x, ny: y, score: -2};

  // ---- 亚像素：x/y 两个方向各自抛物线拟合（峰值贴窗边时该方向不拟合）----
  const bx = fine.bx - fineCx + fineR;
  const by = fine.by - fineCy + fineR;
  const at = (ix: number, iy: number) => scores[iy * w + ix];
  const dxOff = bx > 0 && bx < w - 1 ? subpixel(at(bx - 1, by), at(bx, by), at(bx + 1, by)) : 0;
  const dyOff = by > 0 && by < w - 1 ? subpixel(at(bx, by - 1), at(bx, by), at(bx, by + 1)) : 0;
  return {nx: fine.bx + dxOff, ny: fine.by + dyOff, score: fine.score};
};

// ====== 自动选点 ======

export interface AutoPickOpts {
  patchSize?: number;  // 评估块边长，默认 24
  gridStep?: number;   // 网格扫描步长，默认 16
  marginPct?: number;  // 距四边缘最小比例，默认 0.1
  exclude?: {x: number; y: number; r: number}[]; // 排除区（第二自动点避开第一点用）
}

/**
 * 自动放置跟踪点：网格扫描梯度能量（简单差分 |dx|+|dy| 求和），选纹理最强的块中心。
 * 约束：距四边缘 ≥ marginPct；避开四角 25%×25% 区域（PiP 画框边角/字幕常驻区）；
 * exclude 内的候选跳过。无合法候选（帧太小）回退帧中心。
 */
export const autoPickPoint = (frame: FrameGray, opts: AutoPickOpts = {}): StabPoint => {
  const ps = opts.patchSize ?? STAB_DEFAULTS.patchSize;
  const step = opts.gridStep ?? 16;
  const marginX = Math.ceil(frame.width * (opts.marginPct ?? 0.1));
  const marginY = Math.ceil(frame.height * (opts.marginPct ?? 0.1));
  const half = ps / 2;
  let best: {x: number; y: number; energy: number} | null = null;
  for (let cy = marginY + Math.ceil(half); cy + half <= frame.height - marginY; cy += step) {
    for (let cx = marginX + Math.ceil(half); cx + half <= frame.width - marginX; cx += step) {
      // 避开四角（归一化坐标两个轴都在外侧 25% 即角落区）
      const nx = cx / frame.width;
      const ny = cy / frame.height;
      if ((nx < 0.25 || nx > 0.75) && (ny < 0.25 || ny > 0.75)) continue;
      if (opts.exclude?.some((e) => Math.hypot(cx - e.x, cy - e.y) < e.r)) continue;
      // 梯度能量：块内简单差分求和
      let energy = 0;
      const x0 = Math.round(cx - half);
      const y0 = Math.round(cy - half);
      for (let y = 0; y < ps; y++) {
        for (let x = 0; x < ps; x++) {
          const i = (y0 + y) * frame.width + (x0 + x);
          if (x + 1 < ps) energy += Math.abs(frame.data[i + 1] - frame.data[i]);
          if (y + 1 < ps) energy += Math.abs(frame.data[i + frame.width] - frame.data[i]);
        }
      }
      if (!best || energy > best.energy) best = {x: cx, y: cy, energy};
    }
  }
  return best ? {x: best.x, y: best.y} : {x: frame.width / 2, y: frame.height / 2};
};

// ====== 原始采样序列 ======

/** 跟丢帧位置填补：前后有效帧线性插值，端部钳到最近有效值；全丢回初始位置 */
const fillLost = (vals: number[], valid: boolean[], fallback: number): number[] => {
  const n = vals.length;
  const out = vals.slice();
  const validIdx: number[] = [];
  for (let i = 0; i < n; i++) if (valid[i]) validIdx.push(i);
  if (validIdx.length === 0) return out.map(() => fallback);
  for (let i = 0; i < n; i++) {
    if (valid[i]) continue;
    let lo = -1;
    let hi = -1;
    for (const v of validIdx) {
      if (v < i) lo = v;
      if (v > i) { hi = v; break; }
    }
    if (lo < 0) out[i] = out[validIdx[0]];
    else if (hi < 0) out[i] = out[validIdx[validIdx.length - 1]];
    else {
      const q = (i - lo) / (hi - lo);
      out[i] = vals[lo] + (vals[hi] - vals[lo]) * q;
    }
  }
  return out;
};

/**
 * 每点逐帧跟踪位置 → 原始稳定采样：
 * 单点：dx/dy = 该点位移，rot=0，scale=1；
 * 双点：dx/dy = 两点质心位移，rot = 连线角 − 初始连线角（卷绕到 (−π,π]），scale = 距离比；
 * 跟丢帧（conf < lostThreshold，默认 0.5）位置线性插值填补，conf 保留原始低值作标记。
 */
export const buildRawSamples = (
  tracked: {t: number; x: number; y: number}[][],
  initialPoints: StabPoint[],
  confs: number[][],
  opts: {lostThreshold?: number} = {},
): StabSample[] => {
  const threshold = opts.lostThreshold ?? STAB_DEFAULTS.lostThreshold;
  const nPts = initialPoints.length;
  const n = tracked[0]?.length ?? 0;
  if (n === 0 || nPts === 0) return [];

  // 每点：跟丢判定 + 位置填补
  const filledX: number[][] = [];
  const filledY: number[][] = [];
  for (let p = 0; p < nPts; p++) {
    const valid = tracked[p].map((_, i) => (confs[p]?.[i] ?? 0) >= threshold);
    filledX.push(fillLost(tracked[p].map((s) => s.x), valid, initialPoints[p].x));
    filledY.push(fillLost(tracked[p].map((s) => s.y), valid, initialPoints[p].y));
  }

  // 基准：初始质心、初始连线角/距离（双点）
  const c0x = initialPoints.reduce((s, p) => s + p.x, 0) / nPts;
  const c0y = initialPoints.reduce((s, p) => s + p.y, 0) / nPts;
  const two = nPts >= 2;
  const ang0 = two ? Math.atan2(initialPoints[1].y - initialPoints[0].y, initialPoints[1].x - initialPoints[0].x) : 0;
  const dist0 = two ? Math.hypot(initialPoints[1].x - initialPoints[0].x, initialPoints[1].y - initialPoints[0].y) : 1;

  const out: StabSample[] = [];
  for (let i = 0; i < n; i++) {
    const cx = filledX.reduce((s, arr) => s + arr[i], 0) / nPts;
    const cy = filledY.reduce((s, arr) => s + arr[i], 0) / nPts;
    let rot = 0;
    let scale = 1;
    if (two) {
      const ang = Math.atan2(filledY[1][i] - filledY[0][i], filledX[1][i] - filledX[0][i]);
      rot = Math.atan2(Math.sin(ang - ang0), Math.cos(ang - ang0)); // 卷绕到 (−π,π]
      const dist = Math.hypot(filledX[1][i] - filledX[0][i], filledY[1][i] - filledY[0][i]);
      scale = dist0 > 1e-6 ? dist / dist0 : 1;
    }
    out.push({
      t: tracked[0][i].t,
      dx: cx - c0x,
      dy: cy - c0y,
      rot,
      scale,
      conf: Math.min(...confs.map((c) => c?.[i] ?? 0)),
    });
  }
  return out;
};

// ====== 平滑与校正求解 ======

/**
 * 居中滑动平均（非因果，可用未来采样；前缀和 O(n)，同 followCamera.ts 姿势）平滑
 * dx/dy/rot/scale，校正量 = 平滑值 − 原始值（scale 为比值：cscale = 平滑/原始；
 * 抖动缩放在 1 附近，算术平均近似几何平均）。
 */
export const smoothTrack = (samples: StabSample[], sampleFps: number, smoothSec: number): StabCorrection[] => {
  const n = samples.length;
  if (n === 0) return [];
  const half = Math.max(0, Math.round((smoothSec * sampleFps) / 2));
  if (half === 0) {
    // 窗口=1：平滑=原始，零校正
    return samples.map((s) => ({t: s.t, cx: 0, cy: 0, crot: 0, cscale: 1}));
  }
  const sumDx: number[] = [0];
  const sumDy: number[] = [0];
  const sumRot: number[] = [0];
  const sumScale: number[] = [0];
  for (let i = 0; i < n; i++) {
    sumDx.push(sumDx[i] + samples[i].dx);
    sumDy.push(sumDy[i] + samples[i].dy);
    sumRot.push(sumRot[i] + samples[i].rot);
    sumScale.push(sumScale[i] + samples[i].scale);
  }
  return samples.map((s, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    const count = b - a + 1;
    const mDx = (sumDx[b + 1] - sumDx[a]) / count;
    const mDy = (sumDy[b + 1] - sumDy[a]) / count;
    const mRot = (sumRot[b + 1] - sumRot[a]) / count;
    const mScale = (sumScale[b + 1] - sumScale[a]) / count;
    return {
      t: s.t,
      cx: mDx - s.dx,
      cy: mDy - s.dy,
      crot: mRot - s.rot,
      cscale: Math.abs(s.scale) > 1e-6 ? mScale / s.scale : 1,
    };
  });
};

const percentileOf = (arr: number[], p: number): number => {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/**
 * 保证所有帧校正后画面仍覆盖原画幅的最小中心缩放。
 *
 * 推导：视频元素中心锚定，施加 translate(cx,cy) + rotate(crot) + scale(zoom×cscale)。
 * 覆盖条件 = 原画幅四角 (±hw,±hh) 全落在变换后的视频矩形内。把角点逆变换回视频
 * 局部坐标：L = R(−crot)·(q − (cx,cy))，覆盖 ⟺ 所有角点 |L.x| ≤ zoom×cscale×hw
 * 且 |L.y| ≤ zoom×cscale×hh。矩形是凸的，角点是最坏点，故此式精确（非保守估计）。
 * 每帧得 zoomNeed_i = max四角(|L.x|/hw, |L.y|/hh) / cscale，全片取 95 分位（偶发
 * 大校正帧不撑爆全片缩放）× safety 余量。
 */
export const requiredZoom = (
  corrections: StabCorrection[],
  videoW: number,
  videoH: number,
  safety: number = STAB_DEFAULTS.safety,
): number => {
  if (corrections.length === 0 || videoW <= 0 || videoH <= 0) return 1;
  const hw = videoW / 2;
  const hh = videoH / 2;
  const corners = [
    {x: hw, y: hh}, {x: hw, y: -hh}, {x: -hw, y: hh}, {x: -hw, y: -hh},
  ];
  const needs: number[] = corrections.map((c) => {
    const cos = Math.cos(-c.crot);
    const sin = Math.sin(-c.crot);
    let need = 1;
    for (const q of corners) {
      const vx = q.x - c.cx;
      const vy = q.y - c.cy;
      const lx = vx * cos - vy * sin;
      const ly = vx * sin + vy * cos;
      need = Math.max(need, Math.abs(lx) / hw, Math.abs(ly) / hh);
    }
    return need / Math.max(c.cscale, 0.5); // cscale<1 的帧要吃掉一部分缩放余量
  });
  const margins = needs.map((z) => Math.max(0, z - 1));
  return 1 + safety * percentileOf(margins, 95);
};

/** 缩放封顶（渲染层裁切代价上限；默认 1.25×） */
export const capZoom = (zoom: number, maxZoom: number = STAB_DEFAULTS.maxZoom): number =>
  Math.min(Math.max(zoom, 1), maxZoom);

export interface StabSolveResult {
  corrections: StabCorrection[];
  zoom: number;
  smoothSecUsed: number;
  /** true = 即使 smoothSec 降到 0.1 所需缩放仍超 maxZoom（已按 maxZoom 截断，边缘帧可能露边） */
  capped: boolean;
}

/**
 * 一站式求解：平滑 → 算所需缩放；超 maxZoom 则 smoothSec 减半重平滑，
 * 直到 zoom ≤ maxZoom 或 smoothSec 降到 0.1（仍超则封顶并标 capped）。
 */
export const solveStabilization = (
  samples: StabSample[],
  sampleFps: number,
  params: StabSolveParams,
): StabSolveResult => {
  const maxZoom = params.maxZoom > 1 ? params.maxZoom : STAB_DEFAULTS.maxZoom;
  let sec = Math.max(0.1, params.smoothSec);
  let corrections = smoothTrack(samples, sampleFps, sec);
  let zoom = requiredZoom(corrections, params.videoWidth, params.videoHeight);
  while (zoom > maxZoom && sec > 0.1) {
    sec = Math.max(0.1, sec / 2);
    corrections = smoothTrack(samples, sampleFps, sec);
    zoom = requiredZoom(corrections, params.videoWidth, params.videoHeight);
  }
  const capped = zoom > maxZoom;
  return {corrections, zoom: capZoom(zoom, maxZoom), smoothSecUsed: sec, capped};
};

/** 查表：mediaSec 处的校正量（二分定位 + 线性插值，rot/scale 同插值；超范围钳端点） */
export const sampleCorrectionAt = (corrections: StabCorrection[], mediaSec: number): StabCorrection => {
  if (corrections.length === 0) return {t: mediaSec, cx: 0, cy: 0, crot: 0, cscale: 1};
  const first = corrections[0];
  const last = corrections[corrections.length - 1];
  if (mediaSec <= first.t) return first;
  if (mediaSec >= last.t) return last;
  let lo = 0;
  let hi = corrections.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (corrections[mid].t <= mediaSec) lo = mid;
    else hi = mid;
  }
  const a = corrections[lo];
  const b = corrections[hi];
  const span = b.t - a.t;
  const q = span > 0 ? (mediaSec - a.t) / span : 0;
  return {
    t: mediaSec,
    cx: a.cx + (b.cx - a.cx) * q,
    cy: a.cy + (b.cy - a.cy) * q,
    crot: a.crot + (b.crot - a.crot) * q,
    cscale: a.cscale + (b.cscale - a.cscale) * q,
  };
};

/** CSS 变换参数（渲染层组装 transform: translate(x%,y%) rotate(deg) scale(s)，transform-origin: center） */
export interface StabCssTransform {
  translateXPct: number; // 相对元素自身盒宽的 %
  translateYPct: number; // 相对元素自身盒高的 %
  rotateDeg: number;
  scale: number;
}

/**
 * 校正量 → CSS 变换参数（方向约定见文件头）：
 * translate% = 校正像素 / 视频宽（高）× 100 —— 校正值本身已是「要施加的方向」
 *   （cx = 平滑−原始），故直接取正号；画面内容右移 dx 时 cx = −dx < 0，
 *   translateX 为负，画面被拉回原位；
 * rotateDeg = crot 弧度直接转角度（y 向下坐标系的角度正方向 = CSS 顺时针正方向）；
 * scale = zoom × cscale（zoom 为全片统一自动缩放，cscale 为逐帧缩放校正）。
 */
export const correctionToCss = (
  c: StabCorrection,
  videoW: number,
  videoH: number,
  zoom: number,
): StabCssTransform => ({
  translateXPct: (c.cx / videoW) * 100,
  translateYPct: (c.cy / videoH) * 100,
  rotateDeg: (c.crot * 180) / Math.PI,
  scale: zoom * c.cscale,
});
