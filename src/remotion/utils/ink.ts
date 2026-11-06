/**
 * 墨迹形态工具 - 国风特效（墨汁滴落/喷溅/水墨山水）共用的确定性形态生成器。
 *
 * 全部为纯函数：同参数必得同 path，预览（Player）与渲染进程结果一致（WYSIWYG）。
 * path 在各自的 SVG 坐标系内生成：滴落/山水用 0..100 拉伸坐标（preserveAspectRatio="none"），
 * 喷溅用 px 坐标。需要正圆的凸头/墨点时，通过 aspect（画布宽/高）补偿拉伸畸变。
 */

export interface Pt {
  x: number;
  y: number;
}

/** 确定性伪随机 0..1（正弦 hash）。 */
export const rand = (n: number): number => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** easeOutCubic：先快后慢（墨滴生长、墨点飞出）。 */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** easeOutBack：到终点前轻微回弹（喷溅炸开）。 */
export const easeOutBack = (t: number): number => {
  const c = 1.70158;
  const u = Math.min(1, Math.max(0, t)) - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

const f = (v: number): string => v.toFixed(2);

/** 开口折线 → Catmull-Rom 平滑三次贝塞尔 path（曲线通过所有点）。 */
export const smoothOpenPath = (pts: Pt[]): string => {
  if (pts.length < 2) return '';
  let d = `M ${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2.x)},${f(p2.y)}`;
  }
  return d;
};

/** 闭合点环 → Catmull-Rom 平滑闭合 path（墨团/滴体等有机团块）。 */
export const smoothClosedPath = (pts: Pt[]): string => {
  const n = pts.length;
  if (n < 3) return '';
  let d = `M ${f(pts[0].x)},${f(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2.x)},${f(p2.y)}`;
  }
  return `${d} Z`;
};

/**
 * 墨滴带状体 path：从 (x, 0) 下垂 len，宽 w 向尖端渐缩，
 * 横向双正弦摆动，尖端带下垂滴凸头。坐标单位与调用方 SVG 一致（0..100）。
 * @param aspect 画布宽/高，用于补偿拉伸，让尖端凸头在屏幕上接近正圆
 */
export const inkDripPath = (x: number, len: number, w: number, seed: number, aspect: number): string => {
  if (len <= 0.5 || w <= 0) return '';
  const steps = Math.max(3, Math.ceil(len / 2.5));
  // 摆动幅度随深度增大：顶部锚定在墨缘，越往下越游移（避免整段"蛇形"）
  const offAt = (y: number): number => {
    const depth = y / len;
    return (Math.sin(y * 0.28 + seed * 7.1) * w * 0.55 + Math.sin(y * 0.09 + seed * 2.3) * w * 0.3) * (0.2 + 0.8 * depth);
  };
  const halfAt = (t: number): number => Math.max(0.03, (w / 2) * (1 - 0.45 * t));
  const loop: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = (i / steps) * len;
    loop.push({x: x + offAt(y) - halfAt(y / len), y});
  }
  // 尖端垂滴：底部向下凸出（y 方向按 aspect 补偿，屏幕上近圆形）
  const tipX = x + offAt(len);
  loop.push({x: tipX, y: len + Math.max(0.05, w * 0.3) * 1.2 * aspect});
  for (let i = steps; i >= 0; i--) {
    const y = (i / steps) * len;
    loop.push({x: x + offAt(y) + halfAt(y / len), y});
  }
  return smoothClosedPath(loop);
};

/**
 * 喷溅主墨团 path：半径噪声 + 偶发长刺的有机团块，Catmull-Rom 闭合平滑。
 * 在 px 坐标系生成（cx, cy 为团心，r 为基准半径）。
 */
export const inkBlotPath = (seed: number, cx: number, cy: number, r: number): string => {
  const spikes = 12 + Math.floor(rand(seed * 1.7) * 5); // 12-16 个角
  const pts: Pt[] = [];
  for (let i = 0; i < spikes; i++) {
    const ang = (i / spikes) * Math.PI * 2;
    let rr = r * (0.55 + rand(seed + i * 1.31) * 0.7); // 0.55..1.25 倍半径
    if (rand(seed * 3.1 + i * 0.77) > 0.8) rr *= 1.45; // 偶发长刺
    pts.push({x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr});
  }
  return smoothClosedPath(pts);
};

/** 喷溅拖尾（触手）：从团心沿 ang 方向甩出的细长泪滴。 */
export const inkTendrilPath = (seed: number, ang: number, len: number, w: number): string => {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const px = -dy; // 垂直方向
  const py = dx;
  const bend = (rand(seed) - 0.5) * len * 0.35; // 轻微弯曲
  const pts: Pt[] = [
    {x: dx * len * 0.1 + px * w, y: dy * len * 0.1 + py * w},
    {x: dx * len * 0.55 + px * w * 0.5 + px * bend * 0, y: dy * len * 0.55 + py * w * 0.5 + py * bend * 0},
    {x: dx * len + px * bend, y: dy * len + py * bend}, // 尾尖
    {x: dx * len * 0.55 - px * w * 0.5, y: dy * len * 0.55 - py * w * 0.5},
    {x: dx * len * 0.1 - px * w, y: dy * len * 0.1 - py * w},
  ];
  return smoothClosedPath(pts);
};

export interface MountainOptions {
  /** 粗糙度（细节谐波幅度），远山 0.5-0.7，近山 1.0-1.2 */
  rough?: number;
  fromX?: number;
  toX?: number;
  /** 填充到底部的 y（配合 preserveAspectRatio none 的 0..100 坐标） */
  bottomY?: number;
}

export interface MountainShape {
  /** 闭合 path（山脊线平滑，底部封口用于填充） */
  path: string;
  /** 山脊采样点（供皴法纹理等二次加工） */
  ridge: Pt[];
}

/**
 * 山脊形态：多频正弦谐波叠加 + 1-2 个高斯主峰，Catmull-Rom 平滑。
 * 替代原来的直线多边形，得到自然起伏的水墨山形。
 */
export const mountainPath = (seed: number, baseY: number, amp: number, opts: MountainOptions = {}): MountainShape => {
  const {rough = 1, fromX = -40, toX = 140, bottomY = 100} = opts;
  const n = 26;
  const f1 = 1.6 + rand(seed * 11.3) * 1.2; // 主波形数
  const f2 = 4.5 + rand(seed * 13.7) * 2.5;
  const f3 = 9 + rand(seed * 17.1) * 4;
  const p1 = rand(seed * 19.3) * Math.PI * 2;
  const p2 = rand(seed * 23.9) * Math.PI * 2;
  const p3 = rand(seed * 27.7) * Math.PI * 2;
  // 1-2 个主峰（位置/高度随机）
  const peakCount = 1 + Math.floor(rand(seed * 29.1) * 2);
  const peaks = Array.from({length: peakCount}, (_, k) => ({
    pos: 0.15 + rand(seed * 31.3 + k * 7.7) * 0.7,
    h: 0.5 + rand(seed * 33.9 + k * 3.1) * 0.45,
    w: 0.06 + rand(seed * 35.7 + k * 5.3) * 0.04,
  }));
  const ridge: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = fromX + t * (toX - fromX);
    // 谐波叠加（0..1），主峰为高斯凸起
    let h =
      0.5 * (0.5 + 0.5 * Math.sin(t * Math.PI * f1 * 2 + p1)) +
      0.3 * rough * (0.5 + 0.5 * Math.sin(t * Math.PI * f2 + p2)) +
      0.2 * rough * (0.5 + 0.5 * Math.sin(t * Math.PI * f3 + p3));
    for (const pk of peaks) {
      h += pk.h * Math.exp(-(((t - pk.pos) / pk.w) * ((t - pk.pos) / pk.w)));
    }
    h = 0.15 + 0.85 * Math.min(1.1, h * 0.85); // 保底起伏，避免长平线
    ridge.push({x, y: baseY - amp * h});
  }
  const path = `${smoothOpenPath(ridge)} L ${f(toX)},${f(bottomY)} L ${f(fromX)},${f(bottomY)} Z`;
  return {path, ridge};
};
