/**
 * 节拍检测器（shared/beat-detect）单元测试
 *
 * 用合成的鼓机轨道验证：BPM 估计、拍点时间精度（±30ms）、重拍半速歧义消除、
 * 静音/超短输入防御，并量化对比旧「波形峰值桶中心」检测器的误差差距。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/beat-detect.test.ts
 */

import assert from 'node:assert/strict';
import {detectBeatsFromSamples} from '../../src/shared/beat-detect.ts';
import {detectBeats, snapDurationsToBeats} from '../../src/shared/beat-align.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const SR = 8000;

interface Track {
  samples: Float32Array;
  beatTimes: number[];
}

/**
 * 合成鼓机轨道：每拍一个 60Hz 衰减正弦 kick（40ms），每 accentEvery 拍加强 2 倍，
 * 叠加低幅白噪声底与持续低音 pad（模拟真实音乐的非纯净包络）。
 */
const makeClickTrack = (
  bpm: number,
  durationSec: number,
  opts?: {accentEvery?: number; noise?: number; pad?: boolean},
): Track => {
  const n = Math.floor(durationSec * SR);
  const samples = new Float32Array(n);
  const interval = 60 / bpm;
  const beatTimes: number[] = [];
  let seed = 42;
  const rand = () => {
    // 确定性伪随机（同输入同输出，测试可复现）
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  const accentEvery = opts?.accentEvery ?? 4;
  const noise = opts?.noise ?? 0.02;
  for (let i = 0; i < n; i++) samples[i] = rand() * noise;
  if (opts?.pad !== false) {
    // 持续 55Hz pad（幅度 0.05）：真实音乐都有持续成分，检测器不能靠「只有静音+瞬态」作弊
    for (let i = 0; i < n; i++) samples[i] += 0.05 * Math.sin((2 * Math.PI * 55 * i) / SR);
  }
  let beatIdx = 0;
  for (let t = 0.5; t + 0.05 < durationSec; t += interval) {
    beatTimes.push(t);
    const amp = beatIdx % accentEvery === 0 ? 0.9 : 0.45;
    const start = Math.round(t * SR);
    const len = Math.round(0.04 * SR);
    for (let j = 0; j < len && start + j < n; j++) {
      const decay = Math.exp(-j / (0.008 * SR));
      samples[start + j] += amp * decay * Math.sin((2 * Math.PI * 60 * j) / SR);
    }
    beatIdx++;
  }
  return {samples, beatTimes};
};

/** 检测拍点与真实拍点的匹配率与误差中位数（±tol 内算命中） */
const matchBeats = (detected: number[], truth: number[], tol = 0.03) => {
  let matched = 0;
  const errs: number[] = [];
  for (const b of truth) {
    let best = Infinity;
    for (const d of detected) {
      const e = Math.abs(d - b);
      if (e < best) best = e;
    }
    if (best <= tol) {
      matched++;
      errs.push(best);
    }
  }
  errs.sort((a, b) => a - b);
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : Infinity;
  return {matched, total: truth.length, medianErr: med};
};

console.log('beat-detect: 基本精度');
ok('120 BPM 30s：BPM 估计 ±2、拍点 90%+ 命中 ±30ms、中位误差 <10ms', () => {
  const {samples, beatTimes} = makeClickTrack(120, 30);
  const r = detectBeatsFromSamples(samples, SR);
  assert.ok(Math.abs(r.bpm - 120) <= 2, `BPM 偏差过大：${r.bpm}`);
  assert.ok(r.beats.length >= beatTimes.length * 0.85, `检出拍数过少：${r.beats.length}/${beatTimes.length}`);
  const m = matchBeats(r.beats, beatTimes);
  assert.ok(m.matched >= beatTimes.length * 0.9, `命中不足：${m.matched}/${beatTimes.length}`);
  assert.ok(m.medianErr < 0.01, `中位误差过大：${(m.medianErr * 1000).toFixed(1)}ms`);
  assert.ok(r.confidence > 0.15, `置信度过低：${r.confidence}`);
});

ok('90 BPM 与 150 BPM：不同速度同样准确（搜索范围 70-180 内）', () => {
  for (const bpm of [90, 150]) {
    const {samples, beatTimes} = makeClickTrack(bpm, 24);
    const r = detectBeatsFromSamples(samples, SR);
    assert.ok(Math.abs(r.bpm - bpm) <= 2, `${bpm} BPM 检出 ${r.bpm}`);
    const m = matchBeats(r.beats, beatTimes);
    assert.ok(m.matched >= beatTimes.length * 0.9, `${bpm} BPM 命中 ${m.matched}/${beatTimes.length}`);
  }
});

ok('半速/倍速歧义：重拍轨道检出基速 90 而不是 180 或 45', () => {
  const {samples} = makeClickTrack(90, 30, {accentEvery: 4});
  const r = detectBeatsFromSamples(samples, SR);
  assert.ok(r.bpm >= 70 && r.bpm <= 110, `倍速歧义未消除：${r.bpm}`);
});

console.log('beat-detect: 防御');
ok('全静音 → 空结果', () => {
  const r = detectBeatsFromSamples(new Float32Array(30 * SR), SR);
  assert.equal(r.beats.length, 0);
  assert.equal(r.bpm, 0);
});

ok('短于 4s → 空结果', () => {
  const {samples} = makeClickTrack(120, 3);
  const r = detectBeatsFromSamples(samples, SR);
  assert.equal(r.beats.length, 0);
});

ok('非 8kHz 输入按参数换算（44.1k 轨道同样检出）', () => {
  const bpm = 120;
  const sr = 44100;
  const n = Math.floor(20 * sr);
  const samples = new Float32Array(n);
  const interval = 60 / bpm;
  for (let t = 0.5; t < 19.9; t += interval) {
    const start = Math.round(t * sr);
    for (let j = 0; j < Math.round(0.04 * sr); j++) {
      samples[start + j] += 0.8 * Math.exp(-j / (0.008 * sr)) * Math.sin((2 * Math.PI * 60 * j) / sr);
    }
  }
  const r = detectBeatsFromSamples(samples, sr);
  assert.ok(Math.abs(r.bpm - 120) <= 2, `44.1k 检出 ${r.bpm}`);
});

console.log('beat-detect: 对比旧检测器（升级理由的量化证明）');
ok('180s 轨道：新检测器中位误差 <30ms，旧桶中心误差 >100ms', () => {
  const {samples, beatTimes} = makeClickTrack(120, 180);
  const r = detectBeatsFromSamples(samples, SR);
  const mNew = matchBeats(r.beats, beatTimes, 0.05);
  assert.ok(mNew.medianErr < 0.03, `新检测器中位误差 ${(mNew.medianErr * 1000).toFixed(0)}ms`);

  // 旧链路：240 桶 max-abs 峰值（analyzeAudio 口径）→ detectBeats 桶中心
  const BUCKETS = 240;
  const bucketSize = Math.max(1, Math.floor(samples.length / BUCKETS));
  const peaks: number[] = [];
  for (let i = 0; i < BUCKETS; i++) {
    let max = 0;
    const start = i * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    for (let j = start; j < end; j++) max = Math.max(max, Math.abs(samples[j]));
    peaks.push(Math.min(1, max));
  }
  const oldBeats = detectBeats(peaks, samples.length / SR);
  const mOld = matchBeats(oldBeats, beatTimes, 0.5);
  console.log(`    旧检测器：${oldBeats.length} 拍，命中 ${mOld.matched}/${beatTimes.length}，中位误差 ${(mOld.medianErr === Infinity ? '∞' : (mOld.medianErr * 1000).toFixed(0) + 'ms')}`);
  assert.ok(mOld.medianErr > 0.1 || mOld.matched < beatTimes.length * 0.6, '旧检测器没有想象中差？检查对比前提');
});

console.log('beat-detect: 节拍网格用于切点吸附');
ok('真实网格上 snapDurationsToBeats 吸附后切点全部压拍', () => {
  const {samples, beatTimes} = makeClickTrack(128, 60);
  const r = detectBeatsFromSamples(samples, SR);
  // 10 段、每段 ~1.4s（略偏离 0.469s 拍距的整数倍）
  const durs = Array.from({length: 10}, (_, i) => 1.3 + (i % 3) * 0.12);
  const snap = snapDurationsToBeats(durs, r.beats, {min: 0.5, max: 60, tolerance: 0.6});
  assert.ok(snap && snap.movedCount > 0);
  let acc = 0;
  let onBeat = 0;
  const tol = 0.035; // 吸附精度应优于半帧级网格
  for (let i = 0; i < snap!.durations.length - 1; i++) {
    acc += snap!.durations[i];
    const near = r.beats.some((b) => Math.abs(b - acc) <= tol);
    if (near) onBeat++;
  }
  assert.equal(onBeat, snap!.durations.length - 1, `${snap!.durations.length - 1 - onBeat} 个切点没压上拍`);
  void beatTimes;
});

console.log(`\nbeat-detect: ${passed} 项全部通过`);
