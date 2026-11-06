/**
 * 鼓点分频段逐拍强度（纯函数，与 beat-detect 同一份 8kHz PCM 口径）
 *
 * 为什么分频段：beat-detect 的宽带 RMS flux 只回答「这拍有没有起振」，
 * 排片要的是「这拍是底鼓还是军鼓/镲」——重鼓点放转场/切镜、弱拍保持。
 * 8kHz PCM 上加两个双二阶（RBJ cookbook 系数）即可分离，无需 FFT：
 *
 * - kick 带：低通 150Hz（Q=0.707，二阶 Butterworth），底鼓基频 50~80Hz 全过，
 *   军鼓/镲主体（1.5kHz+）衰减 ≥40dB；
 * - snare 带：带通几何中心 √(1500×4000)≈2.45kHz，Q≈0.98（带宽覆盖 1.5~4kHz），
 *   55Hz 底鼓泄漏衰减 >30dB。
 *
 * 每带：滤波 → 短窗对数 RMS 包络（复用 beat-detect 的 rmsEnvelope，同 WIN/HOP）
 * → 正差分 log-flux（不做 onsetEnvelope 的白化——白化是尺度不变的，
 * 会把 -33dB 的跨带泄漏放大成与主带同量级，跨带比较就失效了）→ 逐拍窗内峰值。
 *
 * 归一化：两带合并采样值的 90 分位为基准（防爆），不是逐带各自归一——
 * 逐带归一会让纯底鼓轨道的 snare 带泄漏也被拉到 1，丢失「这拍没有军鼓」的信息。
 */

import {rmsEnvelope} from './beat-detect.ts';

const SR = 8000;
/** 与 beat-detect 同参数：hop=64 @8kHz = 8ms */
const HOP_SEC = 64 / SR;

/** kick 低通截止（Hz） */
const KICK_LP_HZ = 150;
/** snare 带通范围（Hz） */
const SNARE_LO_HZ = 1500;
const SNARE_HI_HZ = 4000;
const SNARE_FC_HZ = Math.sqrt(SNARE_LO_HZ * SNARE_HI_HZ);
/** 由倍频程带宽换算 Q：Q = √(2^BW) / (2^BW − 1) */
const SNARE_BW_OCT = Math.log2(SNARE_HI_HZ / SNARE_LO_HZ);
const SNARE_Q = Math.sqrt(Math.pow(2, SNARE_BW_OCT)) / (Math.pow(2, SNARE_BW_OCT) - 1);

/** 拍点采样窗（秒）：拍时间 ± 此窗内取 flux 峰值（beats 自带 ~24ms 起振提前补偿，窗中心略前移） */
const BEAT_WIN_SEC = 0.064;
const BEAT_WIN_LEAD_SEC = 0.024;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ cookbook 低通 */
const lowpass = (fc: number, q: number): Biquad => {
  const w0 = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
};

/** RBJ cookbook 带通（恒定 0dB 峰值增益） */
const bandpass = (fc: number, q: number): Biquad => {
  const w0 = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
};

/** 双二阶滤波（DF-II transposed） */
const applyBiquad = (s: Float32Array, c: Biquad): Float32Array => {
  const out = new Float32Array(s.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
};

/** 对数包络正差分（log-flux），不做白化（跨带比较要保留绝对量级差） */
const fluxOf = (env: number[]): number[] => {
  const flux = new Array<number>(env.length).fill(0);
  for (let i = 1; i < env.length; i++) {
    const d = env[i] - env[i - 1];
    flux[i] = d > 0 ? d : 0;
  }
  return flux;
};

const percentile90 = (arr: number[]): number => {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * s.length))];
};

export interface BeatBands {
  /** 每拍 kick（底鼓）强度 0..1，与 beatsSec 对齐 */
  kick: number[];
  /** 每拍 snare/hat（军鼓/镲）强度 0..1，与 beatsSec 对齐 */
  snare: number[];
}

/**
 * 主入口：8kHz PCM + 拍点时间 → 逐拍 kick/snare 强度。
 * @param beatsSec 拍点时间（秒，detectBeatsFromSamples 的输出，可带起振提前补偿）
 */
export const classifyBeatBands = (pcm: Float32Array, beatsSec: number[]): BeatBands => {
  if (beatsSec.length === 0) return {kick: [], snare: []};
  if (!pcm || pcm.length < SR) {
    return {kick: beatsSec.map(() => 0), snare: beatsSec.map(() => 0)};
  }

  const kickFlux = fluxOf(rmsEnvelope(applyBiquad(pcm, lowpass(KICK_LP_HZ, Math.SQRT1_2))));
  const snareFlux = fluxOf(rmsEnvelope(applyBiquad(pcm, bandpass(SNARE_FC_HZ, SNARE_Q))));

  // 每拍：拍点（−起振提前补偿）± BEAT_WIN 窗内取 flux 峰值
  const win = Math.round(BEAT_WIN_SEC / HOP_SEC);
  const sampleAt = (flux: number[], t: number): number => {
    const c = Math.round((t - BEAT_WIN_LEAD_SEC) / HOP_SEC);
    let peak = 0;
    for (let i = Math.max(0, c - win); i <= Math.min(flux.length - 1, c + win); i++) {
      if (flux[i] > peak) peak = flux[i];
    }
    return peak;
  };
  const kickRaw = beatsSec.map((t) => sampleAt(kickFlux, t));
  const snareRaw = beatsSec.map((t) => sampleAt(snareFlux, t));

  // 两带合并 90 分位归一（保持跨带可比）；静音/近静音时基准≈0，直接给零不除
  const norm = percentile90([...kickRaw, ...snareRaw]);
  if (norm < 1e-6) {
    return {kick: beatsSec.map(() => 0), snare: beatsSec.map(() => 0)};
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    kick: kickRaw.map((v) => r3(Math.min(1, v / norm))),
    snare: snareRaw.map((v) => r3(Math.min(1, v / norm))),
  };
};
