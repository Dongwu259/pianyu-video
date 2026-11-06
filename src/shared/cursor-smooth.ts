/**
 * 光标轨迹后处理（1.6「操作视频内核」M1，纯函数，单测/渲染共用）。
 *
 * 目标：把真人手抖的录屏轨迹重定时成「脚本演示」的流畅感（Supabase 派）——
 * 不改采样时间戳、不改路径形状，只重排每个采样点在路径上的位置：
 * - 每段移动端点缓入缓出（easeInOutCubic）；落向点击的段用 easeOutCubic（减速进场）；
 * - 点击后驻留 120ms（落点停稳再走，操作感的关键）；
 * - 大跳变（>40% 视频宽的瞬移）整段旁路——缓和这种跳变会让光标「飞过全屏」而画面没动，
 *   恐怖谷；保留原始的干脆跳变。
 *
 * 与 cursorOverlay 的分工：那层做±60ms 滑动平均消采样抖动（微观），本模块做节奏重定时（宏观）。
 * 确定性：同输入同输出；点击时间对齐最近采样（≤200ms），对不上的点击忽略。
 */

import type {CursorClick, CursorPoint} from './capture';

/** 点击后驻留毫秒数（落点停稳） */
export const CURSOR_DWELL_MS = 120;
/** 跳变保护：距离超视频宽 × 该值 **且** 段时长 ≤ CURSOR_TELEPORT_MAX_MS 才算瞬移 */
export const CURSOR_TELEPORT_RATIO = 0.4;
/** 瞬移的最大段时长（毫秒）：大距离 + 近瞬时才旁路，慢速跨屏移动是正常动作 */
export const CURSOR_TELEPORT_MAX_MS = 150;
/** 点击与最近采样的最大吸附距离（毫秒），超出忽略该点击 */
const CLICK_SNAP_MS = 200;
/** 静止判定：相邻采样位移 < 视频宽 × 该值视为原地 */
const STILL_EPS_RATIO = 0.0015;
/** 静止段最短时长（毫秒）：低于此不算停顿边界 */
const STILL_MIN_MS = 140;

const easeInOutCubic = (q: number) => (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2);
const easeOutCubic = (q: number) => 1 - Math.pow(1 - q, 3);

interface TrackSegment {
  /** 采样下标区间 [i0, i1]（闭区间） */
  i0: number;
  i1: number;
  /** true = 静止段（原样保留） */
  hold: boolean;
  /** true = 瞬移段（旁路保原样） */
  tele: boolean;
  /** true = 段尾紧跟点击（减速进场） */
  endClick: boolean;
}

/**
 * 平滑光标轨迹（重定时）。
 * 返回新数组（长度与时间戳与输入一致）；无法/无需处理时返回 null（调用方沿用原轨迹）。
 */
export const smoothCursorTrack = (
  points: CursorPoint[],
  clicks: CursorClick[] | undefined,
  opts: {videoWidth: number; videoHeight: number; enabled?: boolean},
): CursorPoint[] | null => {
  const {videoWidth, videoHeight, enabled = true} = opts;
  if (!enabled || !points || points.length < 8 || !(videoWidth > 0) || !(videoHeight > 0)) return null;

  // 时间戳必须单调不减（脏数据防御）
  const pts = points.map((p) => ({...p}));
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t < pts[i - 1].t) pts[i].t = pts[i - 1].t;
  }

  const stillEps = Math.max(1.2, videoWidth * STILL_EPS_RATIO);
  const total = pts.length;

  // ---- 分段边界：点击吸附 + 快扫 run 切分 + 静止平台 ----
  const bounds = new Set<number>([0, total - 1]);
  // 连续快步（每 33ms 位移超阈值）切成独立段：段若满足「大距离+近瞬时」即瞬移旁路，
  // 否则作为正常快移动照常缓动（人手甩动不该被旁路）
  const fastStep = Math.max(24, videoWidth * 0.06);
  let runStart = -1;
  for (let i = 1; i <= total; i++) {
    const fast = i < total && Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > fastStep;
    if (fast && runStart < 0) runStart = i - 1;
    if (!fast && runStart >= 0) {
      bounds.add(runStart);
      if (i < total) bounds.add(i);
      runStart = -1;
    }
  }
  const clickIdx: number[] = [];
  for (const c of clicks ?? []) {
    let best = -1;
    let bestDt = CLICK_SNAP_MS;
    for (let i = 0; i < total; i++) {
      const dt = Math.abs(pts[i].t - c.t);
      if (dt < bestDt) {bestDt = dt; best = i;}
    }
    if (best > 0 && best < total - 1) {bounds.add(best); clickIdx.push(best);}
  }
  for (let i = 1; i < total; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    if (Math.hypot(dx, dy) < stillEps && pts[i].t - pts[i - 1].t >= 0) {
      // 找静止平台：从 i 起连续原地 ≥ STILL_MIN_MS
      let j = i;
      const t0 = pts[i - 1].t;
      while (j < total) {
        const ddx = pts[j].x - pts[i - 1].x;
        const ddy = pts[j].y - pts[i - 1].y;
        if (Math.hypot(ddx, ddy) >= stillEps) break;
        j++;
      }
      if (pts[j - 1].t - t0 >= STILL_MIN_MS) {
        bounds.add(i - 1);
        if (j < total) bounds.add(j);
      }
      i = j;
    }
  }
  const order = [...bounds].sort((a, b) => a - b);

  const clickSet = new Set(clickIdx);
  let segs: TrackSegment[];
  if (order.length <= 2) {
    // 没有节奏边界（全程一个动作）：整轨作为单段缓动，静止则不动
    const dist = Math.hypot(pts[total - 1].x - pts[0].x, pts[total - 1].y - pts[0].y);
    if (dist < stillEps * 2) return null;
    segs = [{
      i0: 0, i1: total - 1, hold: false,
      tele: dist > videoWidth * CURSOR_TELEPORT_RATIO && pts[total - 1].t - pts[0].t <= CURSOR_TELEPORT_MAX_MS,
      endClick: false,
    }];
  } else {
    segs = [];
    for (let k = 0; k < order.length - 1; k++) {
      const i0 = order[k];
      const i1 = order[k + 1];
      if (i1 <= i0) continue;
      const dist = Math.hypot(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y);
      segs.push({
        i0, i1,
        hold: dist < stillEps * 2,
        tele: dist > videoWidth * CURSOR_TELEPORT_RATIO && pts[i1].t - pts[i0].t <= CURSOR_TELEPORT_MAX_MS,
        endClick: clickSet.has(i1),
      });
    }
  }

  // ---- 逐段重定时输出 ----
  const out: CursorPoint[] = pts.map((p) => ({...p}));
  for (const seg of segs) {
    const {i0, i1, hold, tele} = seg;
    if (hold || tele || i1 - i0 < 1) continue;
    // 段内折线弧长参数化（保留人手路径形状，只重排时间）
    const arc: number[] = [0];
    for (let i = i0 + 1; i <= i1; i++) {
      arc.push(arc[arc.length - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const arcTotal = arc[arc.length - 1];
    if (arcTotal <= 0) continue;
    const t0 = pts[i0].t;
    const t1 = pts[i1].t;
    const ease = seg.endClick ? easeOutCubic : easeInOutCubic;
    for (let i = i0; i <= i1; i++) {
      const q = t1 > t0 ? (pts[i].t - t0) / (t1 - t0) : 1;
      const target = ease(Math.min(1, Math.max(0, q))) * arcTotal;
      // 弧长 → 折线上的点
      let k = 1;
      while (k < arc.length && arc[k] < target) k++;
      if (k >= arc.length) {out[i] = {...pts[i1]}; continue;}
      const segLen = arc[k] - arc[k - 1] || 1;
      const f = (target - arc[k - 1]) / segLen;
      out[i] = {
        t: pts[i].t,
        x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * f,
        y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * f,
      };
      // 端点强制贴合，避免浮点残差
      if (i === i0) {out[i].x = pts[i0].x; out[i].y = pts[i0].y;}
      if (i === i1) {out[i].x = pts[i1].x; out[i].y = pts[i1].y;}
    }
  }

  // ---- 点击驻留：点击后的 DWELL_MS 内全部钉在点击位置 ----
  for (const ci of clickIdx) {
    const tc = pts[ci].t;
    for (let i = ci + 1; i < total; i++) {
      if (pts[i].t - tc > CURSOR_DWELL_MS) break;
      out[i].x = pts[ci].x;
      out[i].y = pts[ci].y;
    }
  }
  return out;
};
