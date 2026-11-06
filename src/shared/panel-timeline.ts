/**
 * PanelTimeline - 逐板驻留时间线（每板驻留粒度 / focusPanel·focusBoost 权重）
 *
 * 均匀模型（旧）：slot = (OUTRO_START-OPEN_END)/n，每板 travel (1-dwellFrac)·slot + dwell dwellFrac·slot。
 * 权重模型（新）：travel 段全部等长（保住「板间动画时间」，用户明确要求加减速有时间展开），
 * dwell 总预算 dwellFrac·span 按权重 w[i] 分配（全 1 时与均匀模型严格一致，兼容旧工程/断言）。
 * travelScale（v26）：travel 占比再乘 travelScale（camSpeed 舒缓档 = 拉长甩头时间），
 *   上限 0.72 保住驻留下限；=1 时与旧模型严格一致。
 * 边界严格连续：open → travel0 → dwell0 → travel1 → … → dwell(n-1) → outro，无缝隙无重叠。
 */

export interface PanelTimeline {
  n: number;
  /** 站 i 行进段起点（帧） */
  travelStart: number[];
  /** 行进段时长（帧；全部等长） */
  travelDur: number;
  /** 站 i 驻留段起点（帧） */
  dwellStart: number[];
  /** 站 i 驻留段时长（帧；按权重分配） */
  dwellDur: number[];
}

/** 权重钳制（防 0/负值吞掉整段，防爆表拉爆其它板） */
const clampWeight = (w: number): number => Math.min(4, Math.max(0.2, Number.isFinite(w) ? w : 1));

export const buildPanelTimeline = (
  n: number,
  totalFrames: number,
  dwellFrac: number,
  weights: number[],
  openEnd = 0.12,
  outroStart = 0.92,
  travelScale = 1,
): PanelTimeline => {
  const openF = openEnd * totalFrames;
  const span = (outroStart - openEnd) * totalFrames;
  const travelShare = Math.min(0.72, Math.max(0.1, (1 - dwellFrac) * Math.max(0.5, travelScale)));
  const travelDur = (span * travelShare) / n;
  const w = Array.from({length: n}, (_, i) => clampWeight(weights[i] ?? 1));
  const wSum = w.reduce((a, b) => a + b, 0);
  const dwellDur = w.map((wi) => (span * (1 - travelShare) * wi) / wSum);
  const travelStart: number[] = [];
  const dwellStart: number[] = [];
  let t = openF;
  for (let i = 0; i < n; i++) {
    travelStart.push(t);
    t += travelDur;
    dwellStart.push(t);
    t += dwellDur[i];
  }
  return {n, travelStart, travelDur, dwellStart, dwellDur};
};

export interface PanelPhase {
  /** 当前站下标（0 基；open/outro 时无意义） */
  i: number;
  /** true = 驻留段，false = 行进段 */
  dwell: boolean;
  /** 段内原始进度 0..1（缓动由调用方套 easeCam） */
  p: number;
}

/** 帧所处相位（帧驱动确定性；main 区外的帧钳到最近站） */
export const panelPhaseAt = (tl: PanelTimeline, frame: number): PanelPhase => {
  const last = tl.n - 1;
  for (let i = 0; i < tl.n; i++) {
    if (frame < tl.travelStart[i] + tl.travelDur) {
      return {i, dwell: false, p: Math.min(1, Math.max(0, (frame - tl.travelStart[i]) / tl.travelDur))};
    }
    if (frame < tl.dwellStart[i] + tl.dwellDur[i]) {
      const dur = Math.max(1e-6, tl.dwellDur[i]);
      return {i, dwell: true, p: Math.min(1, Math.max(0, (frame - tl.dwellStart[i]) / dur))};
    }
  }
  // 越界（帧落在 outro 附近）：钳在末站驻留末尾
  return {i: last, dwell: true, p: 1};
};

/** 权重数组构造：focusPanel（0 埧下标，钳到 n-1）× focusBoost（1 = 无变化） */
export const focusWeights = (n: number, focusPanel: number, focusBoost: number): number[] => {
  const idx = Math.min(n - 1, Math.max(0, Math.round(focusPanel)));
  const boost = Math.min(2.5, Math.max(1, focusBoost));
  return Array.from({length: n}, (_, i) => (i === idx ? boost : 1));
};

/** easeCam 三档的峰值速度因子（峰值 = 因子 × 均值；对应 rig-utils.easeCam 的导数：
 *  0 干脆 smoothstep 峰 1.5× / 1 标准三次缓动峰 3× / 2 慢起慢停五次缓动峰 1.875×） */
const EASE_PEAK_FACTOR = [1.5, 3, 1.875];

export interface PanelMotionReport {
  /** 展板数 = 甩头次数 */
  panels: number;
  /** 单次甩头（travel）时长（秒） */
  travelSec: number;
  /** 每板驻留时长（秒） */
  dwellSec: number[];
  /** 每 10 秒甩头次数 */
  switchesPer10s: number;
  /** 甩头平均角速度（度/秒；hopRad = 单次甩头视线转角弧度，按模板几何取值） */
  meanDegPerSec: number;
  /** 甩头峰值角速度（度/秒，camEase 缓动档决定峰值/均值比） */
  peakDegPerSec: number;
}

/**
 * 运动速度报告：把「镜头太快/太慢」翻译成可复核的数字——没有连续看视频的能力时，
 * 用 °/秒、切换频率、驻留秒数描述运镜。参照电影语言：舒缓横摇 5-15°/s、
 * 展示类运镜 20-40°/s、>90°/s 即成甩镜（whip pan）。
 */
export const panelMotionReport = (tl: PanelTimeline, hopRad: number, fps: number, camEase = 1): PanelMotionReport => {
  const travelSec = tl.travelDur / fps;
  const meanDegPerSec = (hopRad * 180) / Math.PI / Math.max(1e-6, travelSec);
  const peakFactor = EASE_PEAK_FACTOR[Math.min(2, Math.max(0, Math.round(camEase)))];
  const cycle = travelSec + tl.dwellDur.reduce((a, b) => a + b, 0) / Math.max(1, tl.n) / fps;
  return {
    panels: tl.n,
    travelSec,
    dwellSec: tl.dwellDur.map((d) => d / fps),
    switchesPer10s: 10 / Math.max(1e-6, cycle),
    meanDegPerSec,
    peakDegPerSec: meanDegPerSec * peakFactor,
  };
};
