/**
 * 实录素材窗口索引（管线路线图 P1-4）——选窗的数据依据（纯函数，单测锚定）
 *
 * v11 实证的选窗考古问题：rec-market「搜索 3D」窗 15.4-21.4、悬停浮卡窗 25+ 都是逐秒抽帧
 * 看出来的；22.19s 的窗外点击把聚焦蒙版包络续进整段（用户实测「完全模糊」）——这些全是
 * **数据可判、渲前可拦**的。本模块把 .cursor.json 的轨迹/点击变成装配可查的表：
 *
 * - 点击时刻表（归一化坐标 + 到候选窗边缘的距离）
 * - 悬停聚类：直接复用 hoverClusters（hoverCard 同款阈值语义——单一来源，别处不要重写）
 * - 运动强度曲线（0.5s 桶：光标速度 + 采样密度——轨迹是活动采样，密度即活跃度）
 * - 游离点击告警：给定 trim 窗，窗外 N 秒内的点击 = 包络续入风险（22.19s 事故的拦截器）
 *
 * 纪律：只产数据供人拍板，不做自动选窗/自动剪（路线图边界）。CLI 见 scripts/take-index.ts。
 */

import {hoverClusters, type HoverEvent} from './click-zoom-smooth.ts';
import type {CursorClick} from './capture.ts';

/** .cursor.json 的持久化形态（videoWidth/videoHeight/points/clicks，t 毫秒） */
export interface CursorSidecar {
  version?: number;
  videoWidth?: number;
  videoHeight?: number;
  points?: Array<{t: number; x: number; y: number}>;
  clicks?: Array<{t: number; x: number; y: number; button?: number}>;
}

export interface IndexedClick {
  tSec: number;
  x: number;
  y: number;
  /** 归一化 0-1（相对视频像素）——跨分辨率可比 */
  normX: number;
  normY: number;
  button?: number;
}

export interface IndexedHover extends HoverEvent {
  t0Sec: number;
  t1Sec: number;
  durSec: number;
}

export interface MotionBucket {
  tSec: number;
  /** 桶内平均速度（px/s；无采样的桶 = 0——轨迹活动采样，无点≈指针没动） */
  speedPxPerSec: number;
  /** 桶内轨迹点数（活跃度密度） */
  samples: number;
}

export interface TakeIndex {
  take: string;
  durationSec: number;
  width: number;
  height: number;
  clicks: IndexedClick[];
  hovers: IndexedHover[];
  motion: MotionBucket[];
  motionStepSec: number;
}

const sec = (ms: number): number => ms / 1000;

/** 点击时刻表：ms→秒 + 归一化坐标（顺带按时间排序，装配查表习惯升序） */
export const indexClicks = (side: CursorSidecar): IndexedClick[] =>
  [...(side.clicks ?? [])]
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t)
    .map((c) => {
      const w = side.videoWidth || 1;
      const h = side.videoHeight || 1;
      return {tSec: sec(c.t), x: c.x, y: c.y, normX: c.x / w, normY: c.y / h, ...(c.button !== undefined ? {button: c.button} : {})};
    });

/** 悬停聚类：hoverClusters 同款语义直通，补秒制字段（button 缺失按左键 1——uiohook 约定） */
export const indexHovers = (side: CursorSidecar): IndexedHover[] =>
  hoverClusters(side.points, (side.clicks ?? []).map((c): CursorClick => ({t: c.t, x: c.x, y: c.y, button: c.button ?? 1})), {
    videoW: side.videoWidth ?? 1920,
    videoH: side.videoHeight ?? 1080,
  }).map((e) => ({...e, t0Sec: sec(e.t0), t1Sec: sec(e.t1), durSec: sec(e.t1 - e.t0)}));

const MOTION_STEP_SEC = 0.5;

/**
 * 运动强度曲线：0.5s 桶平均速度 + 采样密度。轨迹是活动采样（指针不动不记点），
 * 无点桶速度记 0、samples 记 0——「密度」本身就是活跃度信号（悬停浏览 vs 连续扫动可分）。
 */
export const motionCurve = (side: CursorSidecar, stepSec = MOTION_STEP_SEC): MotionBucket[] => {
  const pts = [...(side.points ?? [])].filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return [];
  const lastSec = sec(pts[pts.length - 1].t);
  const nBuckets = Math.max(1, Math.ceil(lastSec / stepSec));
  const dist = new Float64Array(nBuckets);
  const samples = new Uint32Array(nBuckets);
  for (let i = 1; i < pts.length; i++) {
    const t0 = sec(pts[i - 1].t);
    const t1 = sec(pts[i].t);
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    // 跨桶段按时间均摊（长空闲段摊薄速度，不虚增后续桶）
    let b = Math.floor(t0 / stepSec);
    const bEnd = Math.floor(t1 / stepSec);
    if (b === bEnd) {
      if (b >= 0 && b < nBuckets) {dist[b] += d; if (d > 0) samples[b]++;}
    } else {
      const span = t1 - t0;
      for (; b <= bEnd && b < nBuckets; b++) {
        if (b < 0) continue;
        const inStart = Math.max(t0, b * stepSec);
        const inEnd = Math.min(t1, (b + 1) * stepSec);
        const frac = span > 0 ? (inEnd - inStart) / span : 0;
        const share = d * frac;
        dist[b] += share;
        if (share > 0) samples[b]++; // 空闲桥接段（0 位移）不计活跃度
      }
    }
  }
  const out: MotionBucket[] = [];
  for (let b = 0; b < nBuckets; b++) {
    out.push({tSec: b * stepSec, speedPxPerSec: dist[b] / stepSec, samples: samples[b]});
  }
  return out;
};

/** 单条 take 的完整索引（durationSec/w/h 由 CLI ffprobe 提供） */
export const buildTakeIndex = (take: string, side: CursorSidecar, meta: {durationSec: number; width: number; height: number}): TakeIndex => ({
  take,
  durationSec: meta.durationSec,
  width: meta.width,
  height: meta.height,
  clicks: indexClicks(side),
  hovers: indexHovers(side),
  motion: motionCurve(side),
  motionStepSec: MOTION_STEP_SEC,
});

// ===== 游离点击告警（装配 trim 窗 vs 点击表）=====

export interface TrimWindow {
  file: string;
  startSec: number;
  endSec: number;
  /** 溯源（段 id / 平台），报告用 */
  segId?: string;
  platform?: string;
  /** false = 该窗素材不带光标轨迹消费（白板视频卡等静态窗）——游离点击无包络风险，不告警 */
  withTrack?: boolean;
}

export interface OffWindowAlert {
  tSec: number;
  /** click 在窗前还是窗后（窗后 = 包络续入风险主形态：窗尾指针仍活跃，点击包络续进整段） */
  side: 'before' | 'after';
  /** 到窗缘的距离（秒） */
  distSec: number;
  x: number;
  y: number;
  normX: number;
  normY: number;
}

export interface WindowCheck {
  window: TrimWindow;
  /** 窗内点击（= 运镜节拍，装配预期的主体） */
  clicksInside: IndexedClick[];
  /** 窗外 alertSec 内的点击（= 游离点击，包络续入风险） */
  offWindowAlerts: OffWindowAlert[];
  /** 与窗重叠的悬停事件（hoverCard 段选窗依据） */
  hoversInWindow: IndexedHover[];
  /** 窗内运动强度摘要（均速 px/s + 峰值桶时刻） */
  motionAvgPxPerSec: number;
  motionPeakSec: number | null;
}

/**
 * 游离点击：窗边缘外 alertSec（缺省 2s）内的点击。clickHold 档位 0.3-3s、
 * 「指针活动中自动保持」更长，2s 是 v11 事故（22.19s 点击 vs 窗尾 21.4s，0.79s）的
 * 安全覆盖；要求更严的装配可调小。
 */
export const offWindowClickAlerts = (
  clicks: IndexedClick[],
  win: {startSec: number; endSec: number},
  alertSec = 2,
): OffWindowAlert[] =>
  clicks
    .filter((c) => c.tSec < win.startSec || c.tSec > win.endSec)
    .map((c) => {
      if (c.tSec < win.startSec) {
        return {tSec: c.tSec, side: 'before' as const, distSec: win.startSec - c.tSec, x: c.x, y: c.y, normX: c.normX, normY: c.normY};
      }
      return {tSec: c.tSec, side: 'after' as const, distSec: c.tSec - win.endSec, x: c.x, y: c.y, normX: c.normX, normY: c.normY};
    })
    .filter((a) => a.distSec <= alertSec)
    .sort((a, b) => a.distSec - b.distSec);

/** 窗检查全景：窗内点击 + 游离告警 + 窗内悬停 + 运动摘要（装配选窗一页答完） */
export const checkWindow = (index: TakeIndex, win: TrimWindow, alertSec = 2): WindowCheck => {
  const clicksInside = index.clicks.filter((c) => c.tSec >= win.startSec && c.tSec <= win.endSec);
  const hoversInWindow = index.hovers.filter((h) => h.t1Sec >= win.startSec && h.t0Sec <= win.endSec);
  const buckets = index.motion.filter((b) => b.tSec + index.motionStepSec > win.startSec && b.tSec < win.endSec);
  const avg = buckets.length > 0 ? buckets.reduce((a, b) => a + b.speedPxPerSec, 0) / buckets.length : 0;
  const peak = buckets.reduce<MotionBucket | null>((p, b) => (!p || b.speedPxPerSec > p.speedPxPerSec ? b : p), null);
  return {
    window: win,
    clicksInside,
    offWindowAlerts: win.withTrack === false ? [] : offWindowClickAlerts(index.clicks, win, alertSec),
    hoversInWindow,
    motionAvgPxPerSec: Math.round(avg),
    motionPeakSec: peak ? peak.tSec : null,
  };
};
