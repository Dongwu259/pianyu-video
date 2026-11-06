/**
 * beat-bands 单测：合成 PCM 验证 kick/snare 分频段逐拍强度
 * ① 纯低频冲击序列 → kick 高 snare 低；② 纯宽带噪声突发（差分高通化）→ snare 高 kick 低；
 * ③ 交替 pattern → 逐拍对应；④ 空拍/静音不产生假强度。
 * 全部确定性（LCG 伪随机，同输入同输出）。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/beat-bands.test.ts
 */
import assert from 'node:assert/strict';
import {classifyBeatBands} from '../../src/shared/beat-bands.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

const SR = 8000;
const BEAT = 0.5; // 拍距 0.5s（120 BPM），16 拍从 0.5s 起
const N_BEATS = 16;
const beats = Array.from({length: N_BEATS}, (_, i) => 0.5 + i * BEAT);
const DUR = 0.5 + N_BEATS * BEAT + 0.3;

/** kick：55Hz 指数衰减正弦短促包络（60ms） */
const addKick = (out: Float32Array, tSec: number, amp: number): void => {
  const s0 = Math.floor(tSec * SR);
  const len = Math.floor(0.06 * SR);
  for (let j = 0; j < len && s0 + j < out.length; j++) {
    out[s0 + j] += amp * Math.exp(-j / (0.012 * SR)) * Math.sin((2 * Math.PI * 55 * j) / SR);
  }
};

/**
 * snare/hat：宽带噪声突发（30ms 快衰减），做一阶差分高通化（+6dB/oct，55Hz 处衰减 ~27dB），
 * 能量集中到 1.5kHz+，模拟军鼓/镲的频谱位置。LCG 确定性伪随机。
 */
const addNoise = (out: Float32Array, tSec: number, amp: number, rand: () => number): void => {
  const s0 = Math.floor(tSec * SR);
  const len = Math.floor(0.03 * SR);
  let prev = 0;
  for (let j = 0; j < len && s0 + j < out.length; j++) {
    const r = rand();
    out[s0 + j] += amp * Math.exp(-j / (0.006 * SR)) * (r - prev);
    prev = r;
  }
};

const lcg = (seed0: number): (() => number) => {
  let seed = seed0;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
};

const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);

console.log('beat-bands:');

t('① 纯低频冲击序列（55Hz kick 每 0.5s）→ kick 高、snare 低', () => {
  const pcm = new Float32Array(Math.floor(DUR * SR));
  for (const b of beats) addKick(pcm, b, 0.9);
  const r = classifyBeatBands(pcm, beats);
  assert.equal(r.kick.length, N_BEATS);
  assert.equal(r.snare.length, N_BEATS);
  console.log(`    kick mean=${mean(r.kick).toFixed(2)} snare mean=${mean(r.snare).toFixed(2)}`);
  assert.ok(mean(r.kick) > 0.8, `kick 均值应接近 1：${mean(r.kick)}`);
  assert.ok(mean(r.snare) < 0.35, `snare 泄漏应很低：${mean(r.snare)}`);
});

t('② 纯宽带噪声突发（高通感）→ snare 高、kick 低', () => {
  const rand = lcg(42);
  const pcm = new Float32Array(Math.floor(DUR * SR));
  for (const b of beats) addNoise(pcm, b, 0.9, rand);
  const r = classifyBeatBands(pcm, beats);
  console.log(`    snare mean=${mean(r.snare).toFixed(2)} kick mean=${mean(r.kick).toFixed(2)}`);
  assert.ok(mean(r.snare) > 0.8, `snare 均值应接近 1：${mean(r.snare)}`);
  assert.ok(mean(r.kick) < 0.35, `kick 泄漏应很低：${mean(r.kick)}`);
});

t('③ 交替 pattern（偶数拍 kick、奇数拍噪声）→ 数组逐拍对应', () => {
  const rand = lcg(7);
  const pcm = new Float32Array(Math.floor(DUR * SR));
  beats.forEach((b, i) => (i % 2 === 0 ? addKick(pcm, b, 0.9) : addNoise(pcm, b, 0.9, rand)));
  const r = classifyBeatBands(pcm, beats);
  console.log(`    kick=[${r.kick.slice(0, 8).join(',')}] snare=[${r.snare.slice(0, 8).join(',')}]`);
  for (let i = 0; i < N_BEATS; i++) {
    if (i % 2 === 0) {
      assert.ok(r.kick[i] > 0.6, `拍 ${i} 应为强 kick：${r.kick[i]}`);
      assert.ok(r.kick[i] > r.snare[i] + 0.3, `拍 ${i} kick 应显著强于 snare：${r.kick[i]} vs ${r.snare[i]}`);
    } else {
      assert.ok(r.snare[i] > 0.6, `拍 ${i} 应为强 snare：${r.snare[i]}`);
      assert.ok(r.snare[i] > r.kick[i] + 0.3, `拍 ${i} snare 应显著强于 kick：${r.snare[i]} vs ${r.kick[i]}`);
    }
  }
});

t('④ 空拍/静音不产生假强度', () => {
  // 前半 8 拍有 kick、后半 8 拍纯静音
  const pcm = new Float32Array(Math.floor(DUR * SR));
  for (const b of beats.slice(0, 8)) addKick(pcm, b, 0.9);
  const r = classifyBeatBands(pcm, beats);
  for (let i = 8; i < N_BEATS; i++) {
    assert.ok(r.kick[i] < 0.1, `静音拍 ${i} kick 应为 0：${r.kick[i]}`);
    assert.ok(r.snare[i] < 0.1, `静音拍 ${i} snare 应为 0：${r.snare[i]}`);
  }
  // 全静音输入：全零、不崩
  const silent = classifyBeatBands(new Float32Array(Math.floor(DUR * SR)), beats);
  assert.ok(silent.kick.every((v) => v === 0));
  assert.ok(silent.snare.every((v) => v === 0));
  // 空拍表 → 空数组；超短 PCM → 零强度
  assert.deepEqual(classifyBeatBands(pcm, []), {kick: [], snare: []});
  const short = classifyBeatBands(new Float32Array(100), beats);
  assert.ok(short.kick.every((v) => v === 0) && short.kick.length === N_BEATS);
});

console.log(`\n===== ${passed} 项全部通过 =====`);
