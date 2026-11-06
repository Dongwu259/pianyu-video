/**
 * 3D 地面运动追踪 - 纯函数核心（零依赖，tsx 可直接跑单测）
 *
 * 原理：地面在现实中是平面，其在每帧画面上的投影 = 单应（homography）。
 * 在地面上跟踪 ≥4 个锚点（复用 stabilization.ts 的金字塔 NCC 块匹配），
 * 每帧解「参考帧地面 ↔ 当前帧」的单应 H_k，再把 H_k 分解成相机位姿，
 * 得到完整 3x4 投影矩阵 P_k = K·[r1 r2 n t] —— 第三列（z 列）有物理意义
 * （垂直地面向上），立牌/厚度字/几何体等立体元素的透视因此正确。
 *
 * ====== 坐标与方向约定（单测钉死，渲染层集成以本节为准）======
 * 图像坐标：x 右、y 下，原点左上；分析在灰度帧上做，结果统一换算回视频像素。
 * 地面坐标系 = 锚点参考帧（分析区间首帧）的图像位置 (g_x, g_y)：地面平面 z=0，
 * z 轴 = 单应分解出的平面法线 n，方向固定选「相机所在一侧」（向上）。
 * 参考帧 P_0 作用在 z=0 点上恒等于 identity，因此元素摆放 = CSS 定位
 * left/top 直接用参考帧屏幕位置（归一化 u,v × 视频宽高），外层每帧
 * matrix3d(P_k) 更新即可。
 * 相机约定：CV 式（x 右、y 下、z 向前），K = [f 0 cx; 0 f cy; 0 0 1]，
 * f = focalFactor × max(W,H)（缺省 0.9）。平面映射与 f 无关（H 直接由锚点解出），
 * f 只影响立起元素（z≠0）的透视方向。
 * CSS matrix3d：16 值列主序；P(3x4) 嵌入 = 第 1/2/4 列取 P 的三行，
 * 第 3 列（css z 行）取 (P 行3, 1)（保持矩阵非奇异、子元素 z 排序有意义），
 * 浏览器按第 4 行 w 自动透视除法。
 * RANSAC 随机源：固定种子 LCG（同输入同输出，sidecar 可复现）。
 */

import type {FrameGray} from './stabilization.ts';

// ====== 类型 ======

export interface Vec2 {
  x: number;
  y: number;
}

/** 一帧的锚点图像位置集（视频像素；跟丢锚点位置已插值填补） */
export interface GroundAnchorSample {
  t: number;      // 媒体秒
  pts: Vec2[];    // 各锚点图像位置（与 anchors 下标一一对应）
  conf: number;   // 该帧锚点平均置信度 0..1
  /** 每锚点该帧置信度（与 anchors 下标对应；填补帧为原始低值——渲染端据此
   *  只用该帧仍有效的锚点解单应，出画/遮挡锚点自动退出当帧求解） */
  confs?: number[];
}

/** sidecar 文件结构（<同名>.ground.json） */
export interface GroundTrackFile {
  version: 1;
  videoWidth: number;
  videoHeight: number;
  sourceFps: number;
  sampleFps: number;
  /** 锚点地面坐标 = 参考帧图像位置（视频像素，z=0） */
  anchors: Vec2[];
  /** 每锚点全程平均置信度 0..1 */
  anchorConf: number[];
  samples: GroundAnchorSample[];
  quality: {
    lostRatio: number;      // 低置信（锚点×帧）占比
    meanResidualPx: number; // 单应重投影平均残差（视频像素）
    rejected: number;       // RANSAC 剔除的锚点数（非共面/坏点）
  };
}

/** 渲染期最小数据面（Context 传这份即可） */
export interface GroundTrackData {
  anchors: Vec2[];
  samples: GroundAnchorSample[];
}

export interface Intrinsics {
  f: number;
  cx: number;
  cy: number;
}

/** 共享默认值（服务/e2e/测试同口径） */
export const GROUND_DEFAULTS = {
  candidateAnchors: 10,   // 自动候选锚点数
  minAnchors: 4,          // RANSAC 后最少幸存锚点（单应最少 4 点）
  ransacIters: 160,
  ransacThreshPx: 4,      // 分析分辨率下的内点阈值（像素）
  analyzeFps: 15,
  analyzeWidth: 640,      // 地面分析用 640 宽（稳定管道 480）：几何求解吃像素密度
  lostThreshold: 0.5,
  focalFactor: 0.9,       // f = 0.9 × max(W,H)，约 58° 水平 FOV
  yFrom: 0.35,            // 自动选点只扫画面 35% 高度以下（地面先验）
  minDistPct: 0.12,       // 候选锚点最小间距（画面宽比例）
  marginPct: 0.12,        // 候选块距边缘最小比例（走动平移下贴边锚点必出画，预防性排除）
  warnResidualPx: 4,      // 平均残差超过 → UI/AI 黄灯
  warnLostRatio: 0.15,
} as const;

// ====== 基础 3x3 / 3x4 小工具 ======

/** 3x3 矩阵乘（行主序 9 元） */
const mat3Mul = (a: number[], b: number[]): number[] => {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      out[i * 3 + j] = s;
    }
  }
  return out;
};

/** 应用单应 H（行主序 9 元）到点 p；w≈0（映到无穷远）返回 null */
export const applyH = (h: number[], p: Vec2): Vec2 | null => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-9) return null;
  return {x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w};
};

/** 3x4 投影矩阵（行主序 12 元）投影空间点 (x,y,z)；w≈0 返回 null */
export const projectPoint = (P: number[], x: number, y: number, z: number): Vec2 | null => {
  const w = P[8] * x + P[9] * y + P[10] * z + P[11];
  if (Math.abs(w) < 1e-9) return null;
  return {
    x: (P[0] * x + P[1] * y + P[2] * z + P[3]) / w,
    y: (P[4] * x + P[5] * y + P[6] * z + P[7]) / w,
  };
};

// ====== 齐次最小二乘求解（AᵀA 最小特征向量，Jacobi 特征分解）======

/**
 * 对称矩阵 Jacobi 特征分解（循环扫描，返回特征值升序）。
 * vectors[k] = 第 k 小特征值对应的单位特征向量。
 */
const jacobiEigen = (aIn: number[], n: number): {values: number[]; vectors: number[][]} => {
  const a = aIn.slice();
  const V: number[][] = Array.from({length: n}, (_, i) =>
    Array.from({length: n}, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    if (off < 1e-22) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-18) continue;
        const tau = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const tRot = Math.sign(tau || 1) / (Math.abs(tau) + Math.hypot(1, tau));
        const c = 1 / Math.hypot(1, tRot);
        const s = tRot * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = Array.from({length: n}, (_, i) => a[i * n + i]);
  const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  return {
    values: order.map(([v]) => v),
    vectors: order.map(([, i]) => V.map((row) => row[i])),
  };
};

// ====== 单应求解（归一化 DLT）======

/** Hartley 归一化参数：质心平移到原点 + 平均距离缩放到 √2 */
const normTransform = (pts: Vec2[]): {cx: number; cy: number; s: number} => {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const meanDist = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / n;
  return {cx, cy, s: meanDist > 1e-9 ? Math.SQRT2 / meanDist : 1};
};

const normApply = (p: Vec2, T: {cx: number; cy: number; s: number}): Vec2 => ({
  x: (p.x - T.cx) * T.s, y: (p.y - T.cy) * T.s,
});

/**
 * 4 点及以上对应解单应（src→dst），归一化 DLT：构造 2n×9 方程组取 AᵀA 的
 * 最小特征向量（Jacobi）——4 点精确恢复、>4 点带噪声最小二乘同一管道。
 * 退化判定：次小特征值也≈0（解不唯一，如共线点）返回 null；
 * 返回行主序 9 元，整体归一化（单应差一个全局尺度）。
 */
export const solveHomography = (src: Vec2[], dst: Vec2[]): number[] | null => {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  const Ts = normTransform(src);
  const Td = normTransform(dst);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p = normApply(src[i], Ts);
    const q = normApply(dst[i], Td);
    rows.push([-p.x, -p.y, -1, 0, 0, 0, q.x * p.x, q.x * p.y, q.x]);
    rows.push([0, 0, 0, -p.x, -p.y, -1, q.y * p.x, q.y * p.y, q.y]);
  }
  // B = AᵀA（9×9 对称）
  const B = new Array<number>(81).fill(0);
  for (const r of rows) {
    for (let i = 0; i < 9; i++) {
      if (r[i] === 0) continue;
      for (let j = 0; j < 9; j++) B[i * 9 + j] += r[i] * r[j];
    }
  }
  const eig = jacobiEigen(B, 9);
  const maxAbs = Math.max(...eig.values.map(Math.abs));
  if (maxAbs < 1e-12) return null;
  // 次小特征值也≈0 → 零空间 ≥2 维，解不唯一（退化）
  if (Math.abs(eig.values[1]) < Math.abs(maxAbs) * 1e-9) return null;
  const hn = eig.vectors[0];
  // 反归一化：H = Td⁻¹ · Hn · Ts（T = [s 0 −s·cx; 0 s −s·cy; 0 0 1]）
  const TdInv = [1 / Td.s, 0, Td.cx, 0, 1 / Td.s, Td.cy, 0, 0, 1];
  const TsMat = [Ts.s, 0, -Ts.s * Ts.cx, 0, Ts.s, -Ts.s * Ts.cy, 0, 0, 1];
  const H = mat3Mul(TdInv, mat3Mul(hn, TsMat));
  const norm = Math.hypot(...H);
  if (norm < 1e-9) return null;
  return H.map((v) => v / norm);
};

/** 单应重投影平均残差（像素）；valid 掩码缺省全真 */
export const homographyResidual = (
  h: number[], src: Vec2[], dst: Vec2[], valid?: boolean[],
): number => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    if (valid && !valid[i]) continue;
    const p = applyH(h, src[i]);
    if (!p) continue;
    sum += Math.hypot(p.x - dst[i].x, p.y - dst[i].y);
    count++;
  }
  return count > 0 ? sum / count : Infinity;
};

// ====== RANSAC 单应（共面筛选）======

/** 固定种子 LCG（RANSAC 默认随机源，保证同输入同输出） */
export const makeLcg = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

export interface RansacHomographyResult {
  h: number[];
  inliers: boolean[];
  inlierCount: number;
  residualPx: number;
}

/**
 * RANSAC 拟合单应：随机 4 点采样解 H，重投影误差 < threshPx 计内点；
 * 结束后用全部内点重拟合。有效对应 < 4 或最大内点 < 4 返回 null。
 * valid 掩码标记可信对应（跟丢帧不参与采样与计分）。
 */
export const ransacHomography = (
  src: Vec2[], dst: Vec2[],
  opts: {iters?: number; threshPx?: number; rand?: () => number; valid?: boolean[]} = {},
): RansacHomographyResult | null => {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  const iters = opts.iters ?? GROUND_DEFAULTS.ransacIters;
  const thresh = opts.threshPx ?? GROUND_DEFAULTS.ransacThreshPx;
  const rand = opts.rand ?? makeLcg(0x5eed1234);
  const valid = opts.valid ?? src.map(() => true);
  const validIdx: number[] = [];
  for (let i = 0; i < n; i++) if (valid[i]) validIdx.push(i);
  if (validIdx.length < 4) return null;

  let bestMask: boolean[] | null = null;
  let bestCount = 0;
  for (let it = 0; it < iters; it++) {
    // 无放回抽 4 个有效下标
    const pool = validIdx.slice();
    const idx: number[] = [];
    while (idx.length < 4 && pool.length > 0) {
      idx.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    if (idx.length < 4) break;
    const h = solveHomography(idx.map((i) => src[i]), idx.map((i) => dst[i]));
    if (!h) continue;
    let count = 0;
    const mask = src.map((p, i) => {
      if (!valid[i]) return false;
      const q = applyH(h, p);
      if (!q) return false;
      return Math.hypot(q.x - dst[i].x, q.y - dst[i].y) < thresh;
    });
    for (const v of mask) if (v) count++;
    if (count > bestCount) {bestCount = count; bestMask = mask;}
  }
  if (!bestMask || bestCount < 4) return null;
  const refit = solveHomography(
    src.filter((_, i) => bestMask![i]),
    dst.filter((_, i) => bestMask![i]),
  );
  const h = refit ?? solveHomography(src, dst);
  if (!h) return null;
  const inliers = src.map((p, i) => {
    if (!valid[i]) return false;
    const q = applyH(h, p);
    if (!q) return false;
    return Math.hypot(q.x - dst[i].x, q.y - dst[i].y) < thresh;
  });
  const inlierCount = inliers.filter(Boolean).length;
  if (inlierCount < 4) return null;
  return {h, inliers, inlierCount, residualPx: homographyResidual(h, src, dst, inliers)};
};

// ====== 单应分解 + 投影矩阵求解 ======

/** 相机内参：f = focalFactor × max(W,H)，主点居中（见文件头约定） */
export const makeIntrinsics = (
  videoW: number, videoH: number, focalFactor: number = GROUND_DEFAULTS.focalFactor,
): Intrinsics => ({f: focalFactor * Math.max(videoW, videoH), cx: videoW / 2, cy: videoH / 2});

interface V3 {x: number; y: number; z: number}
const v3len = (v: V3): number => Math.hypot(v.x, v.y, v.z);
const v3scale = (v: V3, s: number): V3 => ({x: v.x * s, y: v.y * s, z: v.z * s});
const v3dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const v3cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});

export interface GroundProjection {
  /** 3x4 行主序 12 元：K·[r1 r2 n t]，地面坐标（参考帧图像坐标 + z 向上）→ 图像 */
  P: number[];
  /** 锚点重投影平均残差（像素） */
  residualPx: number;
}

/**
 * 锚点对应（groundPts=参考帧图像位置, imgPts=当前帧图像位置）→ 3x4 投影矩阵。
 * 内部：DLT 解 H → M = K⁻¹H 取列 m1/m2/m3 → r1=m1/d, r2=m2/d 正交化，t=m3/d
 * （d = (|m1|+|m2|)/2）→ 符号修正：锚点深度全正（不满足则 r1/r2/t 整体反号）
 * + 相机在法线正侧（dot(n,t) < 0，不满足则 n 反号，即 z 轴向上）。
 * prevP 供跨帧符号连续（z 列与前帧点积 < 0 时翻 n；平面映射不受影响）。
 * 点不足/退化/残差发散返回 null。
 */
export const solveProjection = (
  K: Intrinsics, groundPts: Vec2[], imgPts: Vec2[],
  opts: {prevP?: number[]} = {},
): GroundProjection | null => {
  const h = solveHomography(groundPts, imgPts);
  if (!h) return null;
  // M = K⁻¹·H 的三列：m_j = ((h[j] − cx·h[6+j])/f, (h[3+j] − cy·h[6+j])/f, h[6+j])
  const colOf = (j: number): V3 => ({
    x: (h[j] - K.cx * h[6 + j]) / K.f,
    y: (h[3 + j] - K.cy * h[6 + j]) / K.f,
    z: h[6 + j],
  });
  const m1 = colOf(0);
  const m2 = colOf(1);
  const m3 = colOf(2);
  const d = (v3len(m1) + v3len(m2)) / 2;
  if (d < 1e-9) return null;
  let r1 = v3scale(m1, 1 / d);
  let r2 = v3scale(m2, 1 / d);
  let t = v3scale(m3, 1 / d);
  // Gram-Schmidt 正交化（保持 r1 方向，r2 去掉 r1 分量；噪声下 H 列非严格正交）
  const l1 = v3len(r1);
  if (l1 < 1e-9) return null;
  r1 = v3scale(r1, 1 / l1);
  r2 = {x: r2.x - v3dot(r2, r1) * r1.x, y: r2.y - v3dot(r2, r1) * r1.y, z: r2.z - v3dot(r2, r1) * r1.z};
  const l2 = v3len(r2);
  if (l2 < 1e-7) return null;
  r2 = v3scale(r2, 1 / l2);
  // 深度符号：锚点须在相机前方（depth = r1.z·X + r2.z·Y + t.z > 0），否则整体反号
  if (groundPts.some((p) => r1.z * p.x + r2.z * p.y + t.z <= 0)) {
    r1 = v3scale(r1, -1); r2 = v3scale(r2, -1); t = v3scale(t, -1);
  }
  // 法线朝相机一侧（相机中心 C 的 z 分量 = −dot(n,t) > 0 ⟺ dot(n,t) < 0）
  let n = v3cross(r1, r2);
  if (v3len(n) < 1e-9) return null;
  n = v3scale(n, 1 / v3len(n));
  if (v3dot(n, t) > 0) n = v3scale(n, -1);
  // 跨帧连续：z 列（P 第 3 列）与前帧同向
  if (opts.prevP) {
    const prevZ: V3 = {x: opts.prevP[2], y: opts.prevP[6], z: opts.prevP[10]};
    if (v3dot(n, {x: prevZ.x / K.f, y: prevZ.y / K.f, z: prevZ.z}) < 0) n = v3scale(n, -1);
  }
  // P = K·[r1 r2 n t]（列 = K·v）
  const kc = (v: V3): V3 => ({x: v.x * K.f + K.cx * v.z, y: v.y * K.f + K.cy * v.z, z: v.z});
  const c0 = kc(r1); const c1 = kc(r2); const c2 = kc(n); const c3 = kc(t);
  const P = [
    c0.x, c1.x, c2.x, c3.x,
    c0.y, c1.y, c2.y, c3.y,
    c0.z, c1.z, c2.z, c3.z,
  ];
  const residualPx = homographyResidual(h, groundPts, imgPts);
  if (!Number.isFinite(residualPx)) return null;
  return {P, residualPx};
};

// ====== 相机位置反解 / 地面单应限制 / 自动朝向 ======

/** 相机中心（地面坐标系） */
export interface CameraPos {
  x: number;
  y: number;
  z: number;
}

/**
 * 3x4 投影矩阵 → 相机中心（地面坐标）：解 M·C = −p4（M = P 前三列，Cramer 法）。
 * P = K·[R|t] 时 C = −Rᵀt（真实相机位置）。自动朝向（元素面向镜头）用它判断
 * 相机在画面的哪一侧——俯拍/绕行素材里「yaw=0 面向 +y」的默认朝向会背对镜头。
 * M 奇异（数值退化）返回 null，调用方退回固定朝向。
 */
export const cameraCenterFromP = (P: number[]): CameraPos | null => {
  const m00 = P[0], m01 = P[1], m02 = P[2];
  const m10 = P[4], m11 = P[5], m12 = P[6];
  const m20 = P[8], m21 = P[9], m22 = P[10];
  const det =
    m00 * (m11 * m22 - m12 * m21) -
    m01 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * m21 - m11 * m20);
  if (Math.abs(det) < 1e-9) return null;
  const b0 = -P[3], b1 = -P[7], b2 = -P[11];
  return {
    x: (b0 * (m11 * m22 - m12 * m21) - m01 * (b1 * m22 - m12 * b2) + m02 * (b1 * m21 - m11 * b2)) / det,
    y: (m00 * (b1 * m22 - m12 * b2) - b0 * (m10 * m22 - m12 * m20) + m02 * (m10 * b2 - b1 * m20)) / det,
    z: (m00 * (m11 * b2 - b1 * m21) - m01 * (m10 * b2 - b1 * m20) + b0 * (m10 * m21 - m11 * m20)) / det,
  };
};

/**
 * P 限制在地面 z=0 上的单应（列 1/2/4）：地面（参考帧像素）→ 当前帧图像。
 * 弹窗拖拽用它求逆把「指针图像位置」反解回地面位置，标记钉在文字实际投影处。
 */
export const homographyFromP = (P: number[]): number[] => [
  P[0], P[1], P[3],
  P[4], P[5], P[7],
  P[8], P[9], P[11],
];

/** 3x3 逆（伴随矩阵法，行主序）；奇异返回 null */
export const invertH = (h: number[]): number[] | null => {
  const det =
    h[0] * (h[4] * h[8] - h[5] * h[7]) -
    h[1] * (h[3] * h[8] - h[5] * h[6]) +
    h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (Math.abs(det) < 1e-12) return null;
  return [
    (h[4] * h[8] - h[5] * h[7]) / det, -(h[1] * h[8] - h[2] * h[7]) / det, (h[1] * h[5] - h[2] * h[4]) / det,
    -(h[3] * h[8] - h[5] * h[6]) / det, (h[0] * h[8] - h[2] * h[6]) / det, -(h[0] * h[5] - h[2] * h[3]) / det,
    (h[3] * h[7] - h[4] * h[6]) / det, -(h[0] * h[7] - h[1] * h[6]) / det, (h[0] * h[4] - h[1] * h[3]) / det,
  ];
};

/**
 * 自动朝向（度）：立起面板正面朝相机 / 躺平文字保持正立可读——两者同一公式。
 * yaw=0 的朝向基准：面板正面朝 +y（画面下方）、文字顶部朝 −y（画面上方），
 * 相机地面投影在元素下方（常规行走机位）时结果 ≈0°；俯拍（相机投影在元素
 * 上方/画面内）时翻 180°，文字与面板转成正对镜头——修「默认朝向反了」。
 */
export const autoYawTowardCamera = (cam: CameraPos, gx: number, gy: number): number =>
  (Math.atan2(gx - cam.x, cam.y - gy) * 180) / Math.PI;

/**
 * 屏幕正立朝向（度）：躺平/立体文字专用——选让「文字顶部经当前帧单应 H 后
 * 指向画面上方」的平面内旋转，相机平移/环绕/俯拍/侧滚下文字在画面里始终
 * 正立可读（AR 导航贴地文字的标准行为；与元素位置无关，同一画面统一朝向）。
 * 对 H 的整体符号（单应差全局尺度）鲁棒：先解 x 分量为零的 φ，再按 y 分量
 * 符号决定是否翻 180°。
 */
export const autoYawScreenUpright = (h: number[]): number => {
  // 符号约定：位移方向映射（A·t）只在 w>0 的单应符号下成立。由 P 导出的 H
  // 天然满足（w=深度>0）；外来 H 先按原点 w=h8 归一，避免整体反号错 180°。
  const sgn = h[8] >= 0 ? 1 : -1;
  const a0 = h[0] * sgn, a1 = h[1] * sgn, a3 = h[3] * sgn, a4 = h[4] * sgn;
  const len = Math.hypot(a0, a1);
  if (len < 1e-9) return 0;
  const phi = Math.atan2(a1, a0);
  // 文字顶部 (sinφ, −cosφ) 经 H 线性部分的实际图像 y 分量；>0 指向画面下方 → 翻 180°
  const vy = a3 * Math.sin(phi) - a4 * Math.cos(phi);
  const deg = (phi * 180) / Math.PI + (vy > 0 ? 180 : 0);
  return ((deg % 360) + 540) % 360 - 180;
};

// ====== CSS matrix3d 嵌入 ======

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * 投影矩阵 P(3x4) → CSS matrix3d 字符串（列主序 16 值）。
 * 列 1/2/4 = P 的三行（x/y/w），列 3 的 z 行取 1（保持矩阵非奇异，
 * 子元素 z 排序 ≈ 高度/深度）。浏览器按第 4 行 w 自动透视除法。
 * 6 位小数：矩阵元素可达数百，除以小 w（~0.05）再放大，4 位会引入可见偏差。
 */
export const projectionToMatrix3d = (P: number[]): string => {
  const c1 = [P[0], P[4], 0, P[8]];
  const c2 = [P[1], P[5], 0, P[9]];
  const c3 = [P[2], P[6], 1, P[10]];
  const c4 = [P[3], P[7], 0, P[11]];
  const vals = [...c1, ...c2, ...c3, ...c4].map(r6);
  return `matrix3d(${vals.join(',')})`;
};

// ====== 锚点序列插值（渲染期查表）======

/**
 * 查表：mediaSec 处的各锚点图像位置与逐锚置信度（二分定位 + 线性插值；
 * 超范围钳端点）。空表返回 null。
 */
export const interpolateGroundSample = (
  samples: GroundAnchorSample[], mediaSec: number,
): {pts: Vec2[]; confs: number[]} | null => {
  const n = samples.length;
  if (n === 0) return null;
  const at = (idx: number) => samples[idx];
  let a = at(0);
  let b = at(0);
  if (mediaSec <= samples[0].t) {a = at(0); b = at(0);}
  else if (mediaSec >= samples[n - 1].t) {a = at(n - 1); b = at(n - 1);}
  else {
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= mediaSec) lo = mid;
      else hi = mid;
    }
    a = at(lo);
    b = at(hi);
  }
  const span = b.t - a.t;
  const q = span > 0 ? (mediaSec - a.t) / span : 0;
  const nAnchors = a.pts.length;
  const pts: Vec2[] = [];
  const confs: number[] = [];
  for (let i = 0; i < nAnchors; i++) {
    pts.push({x: a.pts[i].x + (b.pts[i].x - a.pts[i].x) * q, y: a.pts[i].y + (b.pts[i].y - a.pts[i].y) * q});
    const ca = a.confs?.[i] ?? 1;
    const cb = b.confs?.[i] ?? 1;
    confs.push(ca + (cb - ca) * q);
  }
  return {pts, confs};
};

/**
 * 查表：mediaSec 处的各锚点图像位置（仅位置；见 interpolateGroundSample 全量版）。
 * 空表返回 null。
 */
export const interpolateAnchors = (samples: GroundAnchorSample[], mediaSec: number): Vec2[] | null =>
  interpolateGroundSample(samples, mediaSec)?.pts ?? null;

/**
 * 渲染帧一站式查表：插值锚点 → 过滤当帧失效锚点（conf < lostThreshold 的
 * 出画/遮挡锚点退出求解；有效 < 4 时退回全量）→ 解投影矩阵 → matrix3d。
 * prev 供跨帧符号连续（调用方逐帧串起来传）。退化返回 null（调用方隐藏 3D 层）。
 */
export const groundMatrix3dAt = (
  track: GroundTrackData,
  videoW: number,
  videoH: number,
  mediaSec: number,
  prev?: number[],
): {P: number[]; css: string} | null => {
  const sampled = interpolateGroundSample(track.samples, mediaSec);
  if (!sampled || sampled.pts.length !== track.anchors.length) return null;
  let anchors = track.anchors;
  let pts = sampled.pts;
  const validIdx: number[] = [];
  for (let i = 0; i < sampled.confs.length; i++) {
    if (sampled.confs[i] >= GROUND_DEFAULTS.lostThreshold) validIdx.push(i);
  }
  if (validIdx.length >= GROUND_DEFAULTS.minAnchors && validIdx.length < track.anchors.length) {
    anchors = validIdx.map((i) => track.anchors[i]);
    pts = validIdx.map((i) => sampled.pts[i]);
  }
  const solved = solveProjection(makeIntrinsics(videoW, videoH), anchors, pts, {prevP: prev});
  if (!solved) return null;
  return {P: solved.P, css: projectionToMatrix3d(solved.P)};
};

// ====== 自动多点选锚（地面区域先验）======

export interface AutoAnchorsOpts {
  count?: number;      // 期望锚点数，默认 10
  patchSize?: number;  // 评估块边长，默认 24
  gridStep?: number;   // 网格扫描步长，默认 16
  yFrom?: number;      // 起始高度比例（地面先验，默认 0.35）
  marginPct?: number;  // 距边缘最小比例，默认 0.06
  minDistPct?: number; // 候选最小间距（宽比例），默认 0.12
}

/**
 * 自动地面选锚：画面 yFrom 以下区域网格扫描，按「梯度能量 × 方向多样性」降序
 * 贪心选取，候选间距 ≥ minDistPct×宽（空间分散）。
 * 方向多样性 = 1 − 最大方向桶占比（水平/垂直/两对角 4 桶）：纯单向纹理
 * （长直线/木纹/门槛线）多样性→0 被压制——这类块存在孔径问题（只能沿纹路
 * 滑动，易锁到相邻周期特征上），是真实地面选锚最常见的失败模式。
 * 返回分析帧坐标下的锚点（调用方换算回视频像素）；无候选回退空数组。
 */
export const autoPickGroundAnchors = (frame: FrameGray, opts: AutoAnchorsOpts = {}): Vec2[] => {
  const count = opts.count ?? GROUND_DEFAULTS.candidateAnchors;
  const ps = opts.patchSize ?? STAB_PATCH;
  const step = opts.gridStep ?? 16;
  const yFrom = opts.yFrom ?? GROUND_DEFAULTS.yFrom;
  const marginX = Math.ceil(frame.width * (opts.marginPct ?? GROUND_DEFAULTS.marginPct));
  const marginY = Math.ceil(frame.height * (opts.marginPct ?? GROUND_DEFAULTS.marginPct));
  const minDist = frame.width * (opts.minDistPct ?? GROUND_DEFAULTS.minDistPct);
  const half = ps / 2;
  const yStart = Math.max(marginY + Math.ceil(half), Math.floor(frame.height * yFrom));
  const candidates: {x: number; y: number; score: number}[] = [];
  for (let cy = yStart; cy + half <= frame.height - marginY; cy += step) {
    for (let cx = marginX + Math.ceil(half); cx + half <= frame.width - marginX; cx += step) {
      let energy = 0;
      let gxSum = 0;
      let gySum = 0;
      let diag1 = 0;
      let diag2 = 0;
      const x0 = Math.round(cx - half);
      const y0 = Math.round(cy - half);
      for (let y = 0; y < ps; y++) {
        for (let x = 0; x < ps; x++) {
          const i = (y0 + y) * frame.width + (x0 + x);
          if (x + 1 < ps) {
            const g = Math.abs(frame.data[i + 1] - frame.data[i]);
            energy += g; gxSum += g;
          }
          if (y + 1 < ps) {
            const g = Math.abs(frame.data[i + frame.width] - frame.data[i]);
            energy += g; gySum += g;
          }
        }
      }
      // 对角差分（步长 2，捕捉斜向结构；直线纹理的对角响应约为正交的一半）
      for (let y = 0; y + 1 < ps; y += 2) {
        for (let x = 0; x + 1 < ps; x += 2) {
          const i = (y0 + y) * frame.width + (x0 + x);
          diag1 += Math.abs(frame.data[i + frame.width + 1] - frame.data[i]);
          diag2 += Math.abs(frame.data[i + frame.width - 1] - frame.data[i]);
        }
      }
      const total = gxSum + gySum + diag1 + diag2;
      const diversity = total > 0 ? 1 - Math.max(gxSum, gySum, diag1, diag2) / total : 0;
      candidates.push({x: cx, y: cy, score: energy * diversity});
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked: {x: number; y: number}[] = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < minDist)) continue;
    picked.push({x: c.x, y: c.y});
  }
  return picked;
};

const STAB_PATCH = 24;

// ====== 跟踪序列组装（RANSAC 共面筛选 + 跟丢填补 + 质量）======

/** 单序列跟丢填补：前后有效帧线性插值，端部钳最近有效值（同 stabilization 思路） */
const fillSeries = (vals: number[], valid: boolean[], fallback: number): number[] => {
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
      if (v > i) {hi = v; break;}
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

export interface AssembleGroundOpts {
  lostThreshold?: number;
  ransacIters?: number;
  ransacThreshPx?: number; // 与输入坐标同单位（分析分辨率像素）
  minAnchors?: number;
  rand?: () => number;
}

export interface AssembleGroundResult {
  anchors: Vec2[];          // 幸存锚点参考帧位置（与输入同单位）
  anchorConf: number[];     // 每锚点全程平均置信度
  samples: GroundAnchorSample[];
  rejected: number;         // RANSAC 剔除数
  meanResidualPx: number;   // 幸存锚点全程单应重投影平均残差
}

const percentileOfArr = (arr: number[], p: number): number => {
  if (arr.length === 0) return Infinity;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(p * s.length) - 1);
  return s[idx];
};

/**
 * 多锚点跟踪原始序列 → 地面跟踪数据：
 * 0) 可用率预筛：可用帧（conf ≥ 阈值）占比 < 60% 的锚点出局（贴边/出画/
 *    长遮挡；贴边跟踪位置失真但 conf 不降，靠占比暴露）；池不足 4 退回全量；
 * 1) 以「相对参考帧平均位移最大」的帧做 RANSAC 单应，剔除非共面/坏锚点
 *    （相机基本静止时位移 < 2px，RANSAC 无意义，全量保留）；
 * 2) 多帧一致性精筛（≥5 锚点才有过约束信息）：逐帧留一法（LOO）拟合单应，
 *    剔除「P90 残差 > 2×阈值」的锚点（孔径滑移锚点可能恰好骗过单帧 RANSAC，
 *    但其轨迹不合全程单应族；迭代至无剔除或仅剩 4 个）；
 * 3) 幸存锚点跟丢位置线性插值填补 + 逐帧残差统计。
 * 幸存 < minAnchors（默认 4）返回 null（无法确定地面平面）。
 */
export const assembleGroundTrack = (
  tracked: {t: number; x: number; y: number}[][],
  confs: number[][],
  opts: AssembleGroundOpts = {},
): AssembleGroundResult | null => {
  const nAnchors = tracked.length;
  const nFrames = tracked[0]?.length ?? 0;
  if (nAnchors < 4 || nFrames < 2) return null;
  const lostThreshold = opts.lostThreshold ?? GROUND_DEFAULTS.lostThreshold;
  const minAnchors = Math.max(4, opts.minAnchors ?? GROUND_DEFAULTS.minAnchors);
  const refineThresh = (opts.ransacThreshPx ?? GROUND_DEFAULTS.ransacThreshPx) * 2;

  // 可用率预筛：贴边/出画/长遮挡的锚点可用帧占比 < 60% 直接出局
  // （贴边跟踪位置失真但 conf 不降，靠占比暴露；出画锚点是走动镜头的常态）
  const usableRatio = tracked.map((_, p) =>
    (confs[p] ?? []).filter((c) => c >= lostThreshold).length / nFrames);
  const pool: number[] = [];
  for (let p = 0; p < nAnchors; p++) {
    if (usableRatio[p] >= 0.6) pool.push(p);
  }
  if (pool.length < minAnchors) {
    // 全体可用率都低（纹理差/大幅走动）：退回全量，交给 RANSAC/质量黄灯兜底
    for (let p = 0; p < nAnchors; p++) pool.push(p);
  }

  const ref = tracked.map((s) => s[0]);
  // 位移基准帧：在「锚点在场率 ≥60%」的帧里选平均位移最大者做 RANSAC 对端。
  // 直接选末帧的话，走动平移会让一批锚点出画失效，内点池塌缩、共面校验失真。
  const validCountAt = (i: number): number =>
    pool.reduce((s, p) => s + ((confs[p]?.[i] ?? 0) >= lostThreshold ? 1 : 0), 0);
  const needValid = Math.max(GROUND_DEFAULTS.minAnchors, Math.ceil(pool.length * 0.6));
  let kMax = 0;
  let maxDisp = 0;
  for (let i = 1; i < nFrames; i++) {
    if (validCountAt(i) < needValid) continue;
    let disp = 0;
    for (const p of pool) {
      disp += Math.hypot(tracked[p][i].x - ref[p].x, tracked[p][i].y - ref[p].y);
    }
    disp /= pool.length;
    if (disp > maxDisp) {maxDisp = disp; kMax = i;}
  }

  let keepIdx: number[];
  if (maxDisp < 2) {
    // 静止画面：单应≈identity，共面性无从检验，保留全部（置信度低的自然体现在质量里）
    keepIdx = pool.slice();
  } else {
    const srcPts = pool.map((p) => ({x: ref[p].x, y: ref[p].y}));
    const dstPts = pool.map((p) => ({x: tracked[p][kMax].x, y: tracked[p][kMax].y}));
    const valid = pool.map((p) => (confs[p][0] ?? 0) >= lostThreshold && (confs[p][kMax] ?? 0) >= lostThreshold);
    const ransac = ransacHomography(srcPts, dstPts, {
      iters: opts.ransacIters, threshPx: opts.ransacThreshPx, rand: opts.rand, valid,
    });
    if (!ransac) return null;
    keepIdx = ransac.inliers.map((v, j) => (v ? pool[j] : -1)).filter((i) => i >= 0);
  }
  if (keepIdx.length < minAnchors) return null;

  // 跟丢填补（fill 只依赖该锚点自身序列，后续剔除无需重算）
  const filledX = new Map<number, number[]>();
  const filledY = new Map<number, number[]>();
  const fillFor = (p: number) => {
    if (!filledX.has(p)) {
      const valid = tracked[p].map((_, i) => (confs[p]?.[i] ?? 0) >= lostThreshold);
      filledX.set(p, fillSeries(tracked[p].map((s) => s.x), valid, ref[p].x));
      filledY.set(p, fillSeries(tracked[p].map((s) => s.y), valid, ref[p].y));
    }
  };
  for (const p of keepIdx) fillFor(p);

  // ---- 多帧一致性精筛（≥5 锚点才有效：4 点总可精确拟合单应，残差无信息量）----
  // 判据用 P90 而非中位：孔径滑移锚点常「滑一段后重锁」，中位小但尾差大。
  // 残差用留一法（LOO）计算：锚点 j 的残差 = 其偏离「其余锚点拟合的单应」的
  // 程度——直接 LS 会被高杠杆离群点（如出画后贴边的锚点）带偏，离群点自身
  // 残差反而不显著。
  if (maxDisp >= 2) {
    for (let round = 0; round < 4 && keepIdx.length >= 5; round++) {
      const A = keepIdx.map((p) => ({x: ref[p].x, y: ref[p].y}));
      const perAnchor: number[][] = keepIdx.map(() => []);
      for (let i = 0; i < nFrames; i++) {
        const pts = keepIdx.map((p) => ({x: filledX.get(p)![i], y: filledY.get(p)![i]}));
        for (let j = 0; j < A.length; j++) {
          const others: Vec2[] = [];
          const othersPts: Vec2[] = [];
          for (let jj = 0; jj < A.length; jj++) {
            if (jj === j) continue;
            others.push(A[jj]);
            othersPts.push(pts[jj]);
          }
          const h = solveHomography(others, othersPts);
          if (!h) continue;
          const q = applyH(h, A[j]);
          if (q) perAnchor[j].push(Math.hypot(q.x - pts[j].x, q.y - pts[j].y));
        }
      }
      const tails = perAnchor.map((a) => percentileOfArr(a, 0.9));
      let worst = -1;
      let worstTail = 0;
      for (let j = 0; j < tails.length; j++) {
        if (tails[j] > worstTail) {worstTail = tails[j]; worst = j;}
      }
      if (worst >= 0 && worstTail > refineThresh && keepIdx.length > minAnchors) {
        keepIdx.splice(worst, 1);
      } else {
        break;
      }
    }
  }
  if (keepIdx.length < minAnchors) return null;

  // ---- 组装（只保留幸存锚点）----
  const anchors = keepIdx.map((p) => ({x: ref[p].x, y: ref[p].y}));
  const anchorConf = keepIdx.map((p) => {
    const c = confs[p] ?? [];
    const mean = c.length > 0 ? c.reduce((s, v) => s + v, 0) / c.length : 0;
    return Math.round(mean * 1000) / 1000;
  });
  const samples: GroundAnchorSample[] = [];
  for (let i = 0; i < nFrames; i++) {
    const pts = keepIdx.map((p) => ({x: filledX.get(p)![i], y: filledY.get(p)![i]}));
    const frameConfs = keepIdx.map((p) => Math.round((confs[p]?.[i] ?? 0) * 1000) / 1000);
    const conf = frameConfs.reduce((s, v) => s + v, 0) / frameConfs.length;
    samples.push({t: tracked[0][i].t, pts, conf: Math.round(conf * 1000) / 1000, confs: frameConfs});
  }

  // 逐帧单应残差（全程平均，质量信号）
  let residualSum = 0;
  for (let i = 0; i < nFrames; i++) {
    const h = solveHomography(anchors, samples[i].pts);
    if (h) residualSum += homographyResidual(h, anchors, samples[i].pts);
  }
  const meanResidualPx = Math.round((residualSum / nFrames) * 1000) / 1000;
  return {anchors, anchorConf, samples, rejected: nAnchors - keepIdx.length, meanResidualPx};
};

// ====== sidecar 读写校验（主进程调用；纯校验无 IO）======

/** 结构校验：字段齐全、锚点/采样对齐、坐标有限。损坏返回 null */
export const validateGroundTrackFile = (data: unknown): GroundTrackFile | null => {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<GroundTrackFile>;
  if (d.version !== 1) return null;
  if (
    !Number.isFinite(d.videoWidth) || !Number.isFinite(d.videoHeight) ||
    !Number.isFinite(d.sourceFps) || !Number.isFinite(d.sampleFps)
  ) return null;
  if (!Array.isArray(d.anchors) || !Array.isArray(d.samples) || d.anchors.length < 4) return null;
  if (!d.anchors.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))) return null;
  if (!d.samples.every((s) =>
    Number.isFinite(s?.t) && Array.isArray(s?.pts) &&
    s.pts.length === d.anchors!.length &&
    s.pts.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) &&
    (!s.confs || (Array.isArray(s.confs) && s.confs.length === d.anchors!.length &&
      s.confs.every((c) => Number.isFinite(c)))),
  )) return null;
  return data as GroundTrackFile;
};
