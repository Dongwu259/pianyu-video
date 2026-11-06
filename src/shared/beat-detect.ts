/**
 * 节拍检测（纯函数，主进程音频分析与单测共用）
 *
 * 为什么重写：旧链路把 UI 波形（固定 240 桶，3 分钟歌每桶 0.75s）当节拍源，
 * 桶中心时间天然 ±0.25~0.5s 误差，而 128 BPM 相邻拍间隔只有 0.47s——分辨率
 * 上就表示不了节拍网格，切点吸附后必然全错。本模块直接吃 PCM 采样：
 *
 * 1. 起振包络：短窗 RMS → 对数压缩 → 正差分（能量突变），再做局部均值归一化
 *    （响段落/安静段落拉平，副歌不丢拍、间奏不误报）；
 * 2. 定速：包络自相关 + 谐波加权 + 120 BPM 先验，在 70~180 BPM 里选拍周期；
 * 3. 逐拍锚定追踪（代替固定相位网格——真实拍距几乎总是非整数 hop，固定网格
 *    每拍累积漂移会把相位梳抹平）：从最强起振峰出发，向前/向后每次在
 *    ±25% 周期窗内吸最强峰，逐拍重锚定，天然容忍速度漂移与错拍；静音段
 *    （窗内无峰）跳过不硬造拍；亚帧精度由峰抛物线插值给出。
 */

export interface BeatDetection {
  /** 节拍时间（秒，升序，亚帧精度） */
  beats: number[];
  /** 由拍间隔中位数换算的 BPM */
  bpm: number;
  /** 检测置信度 0..1（梳状相位峰对比度；<0.15 建议当「没检出」处理） */
  confidence: number;
}

export const EMPTY_BEAT_DETECTION: BeatDetection = {beats: [], bpm: 0, confidence: 0};

/** 分析窗/步进（采样点）。hop=64 @8kHz = 8ms，节拍时间分辨率 ±8ms 起步 */
const WIN = 256;
const HOP = 64;
/** 低于此时长不做检测（秒） */
const MIN_DURATION = 4;
/** BPM 搜索范围 */
const MIN_BPM = 70;
const MAX_BPM = 180;
/** 拍点精修窗（秒）：预测位置 ± 此值内找真实起振峰 */
const REFINE_WINDOW = 0.07;
/** 局部均值归一化的窗长（秒） */
const WHITEN_WINDOW = 0.7;
/**
 * 起振提前量补偿（秒）：RMS 窗（32ms）前沿先碰到敲击，通量峰比真实 attack 晚窗长
 * 的位置提前——实测合成鼓机轨道上一致提前 ~26ms（与 BPM 无关）。补偿 24ms，
 * 拍点对齐到 attack 起点（鼓点的乐感位置）。
 */
const ONSET_LEAD_COMPENSATION = 0.024;

/** 短窗 RMS 能量包络（对数压缩，动态范围压平便于差分）；beat-bands 分频段包络也复用 */
export const rmsEnvelope = (samples: Float32Array): number[] => {
  const frames = Math.max(0, Math.floor((samples.length - WIN) / HOP) + 1);
  const env = new Array<number>(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP;
    let sum = 0;
    for (let i = start; i < start + WIN; i++) {
      const v = samples[i];
      sum += v * v;
    }
    env[f] = Math.log1p(50 * Math.sqrt(sum / WIN));
  }
  return env;
};

/** 起振强度 = 包络正差分，再做局部均值归一化（whitening，安静段等比放大） */
export const onsetEnvelope = (samples: Float32Array): {os: number[]; hopSec: number} => {
  const env = rmsEnvelope(samples);
  const hopSec = HOP / 8000; // 调用方约定 8kHz；采样率不同时由 detectBeatsFromSamples 换算
  // 正差分
  const flux = new Array<number>(env.length).fill(0);
  for (let i = 1; i < env.length; i++) {
    const d = env[i] - env[i - 1];
    flux[i] = d > 0 ? d : 0;
  }
  // 局部均值归一化：除以 ±WHITEN_WINDOW/2 窗内均值（+eps 防除零）
  const half = Math.max(1, Math.round((WHITEN_WINDOW / 2) / hopSec));
  const os = new Array<number>(flux.length).fill(0);
  for (let i = 0; i < flux.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(flux.length - 1, i + half); j++) {
      sum += flux[j];
      n++;
    }
    os[i] = flux[i] / (sum / n + 1e-6);
  }
  return {os, hopSec};
};

const bpmToLag = (bpm: number, hopSec: number): number => Math.round(60 / bpm / hopSec);

/** 自相关定速：谐波加权（自身 + 一半权重×2 倍周期）+ 120 BPM 对数高斯先验 */
const estimatePeriod = (os: number[], hopSec: number): {periodHops: number; acPeak: number} => {
  const n = os.length;
  const mean = os.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const centred = os.map((v) => v - mean);
  const minLag = bpmToLag(MAX_BPM, hopSec);
  const maxLag = bpmToLag(MIN_BPM, hopSec);
  // 自相关表（lag 到 2×maxLag，谐波加权要用）
  const ac = new Map<number, number>();
  const computeAc = (lag: number): number => {
    if (lag >= n) return 0;
    if (ac.has(lag)) return ac.get(lag)!;
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += centred[i] * centred[i + lag];
    const v = s / Math.max(1, n - lag);
    ac.set(lag, v);
    return v;
  };
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    // 对数高斯先验：120 BPM 处权重 1，70/180 处约 0.75（宽先验，只压明显离谱值）
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.2, 2));
    const harmonic = computeAc(lag) + 0.5 * computeAc(lag * 2);
    const score = harmonic * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return {periodHops: bestLag, acPeak: computeAc(bestLag)};
};

/** 抛物线插值：三点包络峰的亚帧位置（返回峰值索引 + 小数偏移） */
const parabolicPeak = (os: number[], k: number): {index: number; delta: number; value: number} => {
  const y1 = os[Math.max(0, k - 1)];
  const y2 = os[k];
  const y3 = os[Math.min(os.length - 1, k + 1)];
  const denom = y1 - 2 * y2 + y3;
  const delta = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (y1 - y3)) / denom));
  return {index: k, delta, value: y2};
};

const median = (arr: number[]): number => {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 逐拍锚定追踪：从最强起振峰出发，向前/向后每次在 ±25% 周期窗内吸最强峰。
 * 每步都重锚定到真实起振峰，周期的小数误差与缓慢漂移不累积；静音窗跳过。
 */
const trackBeats = (os: number[], periodHops: number, hopSec: number): number[] => {
  // 起振峰清单：严格局部极大 + 自适应门限（最亮 100 个的中位数 × 0.25）
  const topPeaks = os.slice().sort((a, b) => b - a).slice(0, 100);
  const floor = median(topPeaks) * 0.25;
  const peaks: {idx: number; value: number}[] = [];
  for (let k = 1; k < os.length - 1; k++) {
    if (os[k] >= floor && os[k] > os[k - 1] && os[k] >= os[k + 1]) {
      peaks.push({idx: k, value: os[k]});
    }
  }
  if (peaks.length === 0) return [];
  const winMin = 0.75 * periodHops;
  const winMax = 1.25 * periodHops;
  const beatsIdx: number[] = [];
  // 种子 = 最强峰
  let seed = 0;
  for (let i = 1; i < peaks.length; i++) if (peaks[i].value > peaks[seed].value) seed = i;
  beatsIdx.push(peaks[seed].idx);
  // 向前追踪（时间正方向）
  let cur = seed;
  while (true) {
    const from = peaks[cur].idx + winMin;
    const to = peaks[cur].idx + winMax;
    let next = -1;
    let nextVal = -Infinity;
    for (let i = cur + 1; i < peaks.length && peaks[i].idx <= to; i++) {
      if (peaks[i].idx >= from && peaks[i].value > nextVal) {
        nextVal = peaks[i].value;
        next = i;
      }
    }
    if (next < 0) {
      // 窗内无峰（静音/散板段）：不硬造拍，按周期推进继续找
      const skipTo = peaks[cur].idx + winMax;
      let probe = cur + 1;
      let jumped = false;
      while (probe < peaks.length && peaks[probe].idx <= skipTo) probe++;
      if (probe < peaks.length && peaks[probe].idx - peaks[cur].idx <= winMax + periodHops) {
        cur = probe;
        beatsIdx.push(peaks[probe].idx);
        jumped = true;
      }
      if (!jumped) break;
      continue;
    }
    beatsIdx.push(peaks[next].idx);
    cur = next;
  }
  // 向后追踪（时间反方向）
  cur = seed;
  while (true) {
    const from = peaks[cur].idx - winMax;
    const to = peaks[cur].idx - winMin;
    let prev = -1;
    let prevVal = -Infinity;
    for (let i = cur - 1; i >= 0 && peaks[i].idx >= from; i--) {
      if (peaks[i].idx <= to && peaks[i].value > prevVal) {
        prevVal = peaks[i].value;
        prev = i;
      }
    }
    if (prev < 0) {
      const skipTo = peaks[cur].idx - winMax;
      let probe = cur - 1;
      let jumped = false;
      while (probe >= 0 && peaks[probe].idx >= skipTo) probe--;
      if (probe >= 0 && peaks[cur].idx - peaks[probe].idx <= winMax + periodHops) {
        cur = probe;
        beatsIdx.push(peaks[probe].idx);
        jumped = true;
      }
      if (!jumped) break;
      continue;
    }
    beatsIdx.push(peaks[prev].idx);
    cur = prev;
  }
  beatsIdx.sort((a, b) => a - b);
  // 亚帧精修 + 去重（相邻 < 0.25 周期的只留强的——由峰序列保证升序，冲突留后值更强的）
  const refined: number[] = [];
  for (let i = 0; i < beatsIdx.length; i++) {
    const pk = parabolicPeak(os, beatsIdx[i]);
    const t = (pk.index + pk.delta) * hopSec + ONSET_LEAD_COMPENSATION;
    if (refined.length > 0 && t - refined[refined.length - 1] < 0.25 * periodHops * hopSec) continue;
    refined.push(t);
  }
  return refined;
};

/** 主入口：从 PCM 采样检测节拍。采样率任意（按参数换算 hop 秒数） */
export const detectBeatsFromSamples = (samples: Float32Array, sampleRate: number): BeatDetection => {
  if (!samples || samples.length < MIN_DURATION * sampleRate) return EMPTY_BEAT_DETECTION;
  // 采样率不是 8k 时线性重采样到 8k（onsetEnvelope 的窗长按 8k 标定）
  let s = samples;
  if (sampleRate !== 8000) {
    const ratio = sampleRate / 8000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = samples[Math.floor(i * ratio)];
    s = out;
  }
  // 全静音（或近静音）直接返回
  let peakAbs = 0;
  for (let i = 0; i < s.length; i += 16) {
    const a = Math.abs(s[i]);
    if (a > peakAbs) peakAbs = a;
  }
  if (peakAbs < 1e-4) return EMPTY_BEAT_DETECTION;

  const {os, hopSec} = onsetEnvelope(s);
  const {periodHops} = estimatePeriod(os, hopSec);
  const periodSec = periodHops * hopSec;
  const durationSec = s.length / 8000;

  // 逐拍锚定追踪：亚帧精度、容忍漂移、静音段跳过
  const beats = trackBeats(os, periodHops, hopSec)
    .filter((t) => t < durationSec - 0.05);
  if (beats.length < 4) return EMPTY_BEAT_DETECTION;

  // BPM：拍间隔的中位数（对偶发跳拍鲁棒）
  const gaps: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const g = beats[i] - beats[i - 1];
    if (g > 0.05 && g < 2 * periodSec) gaps.push(g); // 忽略静音跳段产生的长间隔
  }
  if (gaps.length < 3) return EMPTY_BEAT_DETECTION;
  const bpm = 60 / median(gaps);

  // 置信度：网格点上包络和 / 全体包络和 的对比度（>1 说明拍确实压在起振上）。
  // 拍点带 24ms 提前补偿，取包络值时先扣回去，落在真实起振峰上。
  let onGrid = 0;
  let total = 0;
  for (let i = 0; i < os.length; i++) total += os[i];
  for (const b of beats) {
    const idx = Math.round((b - ONSET_LEAD_COMPENSATION) / hopSec);
    if (idx >= 0 && idx < os.length) onGrid += os[idx];
  }
  const expected = (total * beats.length) / os.length; // 随机相位的期望值
  const confidence = expected > 0 ? Math.min(1, Math.max(0, (onGrid - expected) / (total - expected + 1e-9))) : 0;

  return {beats, bpm: Math.round(bpm * 10) / 10, confidence};
};
