/**
 * 多点缓动曲线（AE 速度图风格）- 数据模型与求值。
 *
 * 曲线 = 一组控制点 {(x,y)}：x=时间 0..1（单调递增），y=进度（可越界实现回弹/预期）。
 * 首点 (0,0)、末点 (1,1) 固定，中间点可增删拖动。求值用单调三次 Hermite（Fritsch-Carlson），
 * 保证 y 是 x 的平滑函数（无 x 回环）、可通过越界点做 overshoot。等价 d3 curveMonotoneX。
 *
 * 纯函数、无运行时依赖，Node 可直跑单测；CSS 预览与 Remotion 渲染共用，保证所见即所得。
 * 用于两处：自定义模板关键帧的段缓动 + 故事板片段间转场的进度曲线。
 */

export interface CurvePoint {
  x: number; // 时间 0..1
  y: number; // 进度（可越界）
}

export interface EasingCurve {
  points: CurvePoint[];
}

/** 默认线性曲线 */
export const DEFAULT_CURVE: EasingCurve = {points: [{x: 0, y: 0}, {x: 1, y: 1}]};

/**
 * 预设曲线。id 与旧命名 Easing（linear/easeIn/easeOut/easeInOut）对齐，便于迁移；
 * 另含 bounce（回弹 overshoot）/ anticipate（预期反向）。
 */
export const PRESET_CURVES: {id: string; label: string; curve: EasingCurve}[] = [
  {id: 'linear', label: '线性', curve: {points: [{x: 0, y: 0}, {x: 1, y: 1}]}},
  {id: 'easeIn', label: '缓入', curve: {points: [{x: 0, y: 0}, {x: 0.6, y: 0.18}, {x: 1, y: 1}]}},
  {id: 'easeOut', label: '缓出', curve: {points: [{x: 0, y: 0}, {x: 0.4, y: 0.82}, {x: 1, y: 1}]}},
  {id: 'easeInOut', label: '缓入缓出', curve: {points: [{x: 0, y: 0}, {x: 0.3, y: 0.1}, {x: 0.7, y: 0.9}, {x: 1, y: 1}]}},
  {id: 'bounce', label: '回弹', curve: {points: [{x: 0, y: 0}, {x: 0.68, y: 1.12}, {x: 0.84, y: 0.92}, {x: 1, y: 1}]}},
  {id: 'anticipate', label: '预期', curve: {points: [{x: 0, y: 0}, {x: 0.28, y: -0.12}, {x: 1, y: 1}]}},
];

/** 按 id 取预设曲线，未知 id 回退线性 */
export const presetCurve = (id: string): EasingCurve =>
  PRESET_CURVES.find((p) => p.id === id)?.curve ?? DEFAULT_CURVE;

/**
 * 旧命名 Easing -> 预设曲线（迁移用）。Easing 为字符串联合，按名匹配预设 id。
 * bounce/anticipate 无对应旧命名，仅 'linear'/'easeIn'/'easeOut'/'easeInOut' 命中。
 */
export const easingToCurve = (name: string | undefined): EasingCurve => {
  if (!name) return DEFAULT_CURVE;
  return PRESET_CURVES.find((p) => p.id === name)?.curve ?? DEFAULT_CURVE;
};

/**
 * 规整曲线：排序、首末点强制 (0,0)/(1,1)、中间点 x 钳到 (0,1) 内且严格递增。
 * 编辑器每次改动后调用，保证求值稳定。
 */
export const normalizeCurve = (pts: CurvePoint[]): EasingCurve => {
  if (!pts || pts.length < 2) return {points: [{x: 0, y: 0}, {x: 1, y: 1}]};
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const mid: CurvePoint[] = [];
  let prevX = 0;
  for (let i = 1; i < sorted.length - 1; i++) {
    let x = Math.max(0.005, Math.min(0.995, sorted[i].x));
    if (x <= prevX) x = prevX + 0.005;
    if (x >= 0.995) break; // 中间点不得挤到末点
    mid.push({x, y: sorted[i].y});
    prevX = x;
  }
  return {points: [{x: 0, y: 0}, ...mid, {x: 1, y: 1}]};
};

/** 在指定 x 处插入一个点（y 取当前曲线在该 x 的值），返回规整后的新曲线 */
export const addPoint = (curve: EasingCurve, x: number): EasingCurve => {
  const x1 = Math.max(0.005, Math.min(0.995, x));
  const y = evalEasingCurve(curve, x1);
  return normalizeCurve([...curve.points, {x: x1, y}]);
};

/** 删除指定索引的点（首末点不可删），返回规整后的新曲线 */
export const removePoint = (curve: EasingCurve, index: number): EasingCurve => {
  if (index <= 0 || index >= curve.points.length - 1) return curve;
  return normalizeCurve(curve.points.filter((_, i) => i !== index));
};

// ====== 求值（单调三次 Hermite，Fritsch-Carlson）======

/** 计算各点切线（单调保持，避免段间过冲超出相邻点 y 范围） */
const computeTangents = (pts: CurvePoint[]): number[] => {
  const n = pts.length;
  if (n === 1) return [0];
  const m: number[] = []; // 段斜率
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    m.push(dx > 0 ? (pts[i + 1].y - pts[i].y) / dx : 0);
  }
  const t = new Array<number>(n).fill(0);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // 局部极值（斜率变号）处切线置 0，保持单调
    t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  }
  // 单调钳制：段两端切线与段斜率同向且不超 3 倍
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
    } else {
      const a = t[i] / m[i];
      const b = t[i + 1] / m[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const k = 3 / h;
        t[i] = k * a * m[i];
        t[i + 1] = k * b * m[i];
      }
    }
  }
  return t;
};

/**
 * 求曲线在时间 t（0..1）处的进度值。
 * - 无曲线/点数 < 2：返回 t（线性）
 * - 越界：钳到端点 y
 * - 段内：单调三次 Hermite 插值
 */
export const evalEasingCurve = (curve: EasingCurve | undefined, t: number): number => {
  if (!curve || !curve.points || curve.points.length < 2) return t;
  const pts = curve.points;
  const n = pts.length;
  // 已排序（normalizeCurve 保证）；防御性再排一次
  const sorted = pts[0].x <= pts[n - 1].x ? pts : [...pts].sort((a, b) => a.x - b.x);
  if (t <= sorted[0].x) return sorted[0].y;
  if (t >= sorted[n - 1].x) return sorted[n - 1].y;
  // 定位段
  let i = 0;
  for (let k = 0; k < n - 1; k++) {
    if (t >= sorted[k].x && t <= sorted[k + 1].x) {
      i = k;
      break;
    }
  }
  const p0 = sorted[i];
  const p1 = sorted[i + 1];
  const dx = p1.x - p0.x;
  if (dx <= 0) return p0.y;
  const s = (t - p0.x) / dx; // 局部 0..1
  const tangents = computeTangents(sorted);
  const m0 = tangents[i];
  const m1 = tangents[i + 1];
  const s2 = s * s;
  const s3 = s2 * s;
  // Hermite 基函数
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * p0.y + h10 * dx * m0 + h01 * p1.y + h11 * dx * m1;
};
