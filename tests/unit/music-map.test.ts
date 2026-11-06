/**
 * music-map 单测：合成音轨验证能量曲线、重拍相位、段落分割与标签
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/music-map.test.ts
 */
import assert from 'node:assert/strict';
import {buildMusicMapFromSamples} from '../../src/shared/music-map.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

const SR = 8000;

/**
 * 合成 105 BPM 鼓机音轨：安静 intro（8 小节）→ 强 drop（16 小节）→ 弱 break（8 小节）→ 强 drop（16 小节）。
 * 鼓点 = 每拍 60Hz 指数衰减正弦 + 噪声 hat；drop 段鼓点振幅 3 倍 + 低频贝斯。
 */
const synthTrack = (): Float32Array => {
  const bpm = 105;
  const beat = 60 / bpm;
  const bars = [8, 16, 8, 16]; // 小节数
  const amps = [0.12, 0.5, 0.1, 0.48];
  const totalBeats = bars.reduce((a, b) => a + b, 0) * 4;
  const dur = totalBeats * beat + 1;
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  let beatIdx = 0;
  for (const [bi, barCount] of bars.entries()) {
    const amp = amps[bi];
    for (let b = 0; b < barCount * 4; b++) {
      const t0 = beatIdx * beat;
      const s0 = Math.floor(t0 * SR);
      // kick：每拍，重拍（每 4 拍）更强
      const kickAmp = amp * (beatIdx % 4 === 0 ? 1.25 : 0.9);
      for (let j = 0; j < 0.09 * SR && s0 + j < n; j++) {
        out[s0 + j] += kickAmp * Math.exp(-j / (0.018 * SR)) * Math.sin((2 * Math.PI * (58 + 30 * Math.exp(-j / (0.012 * SR))) * j) / SR);
      }
      // hat：反拍噪声
      const s1 = Math.floor((t0 + beat / 2) * SR);
      for (let j = 0; j < 0.02 * SR && s1 + j < n; j++) {
        out[s1 + j] += amp * 0.25 * Math.exp(-j / (0.005 * SR)) * rand();
      }
      // drop 段加贝斯持续音（提升段能量）
      if (amp > 0.3) {
        const s2 = Math.floor(t0 * SR);
        const len = Math.floor(beat * 0.9 * SR);
        for (let j = 0; j < len && s2 + j < n; j++) {
          out[s2 + j] += amp * 0.5 * Math.exp(-j / (0.3 * SR)) * Math.sin((2 * Math.PI * 55 * j) / SR);
        }
      }
      beatIdx++;
    }
  }
  // 峰值归一
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
};

const samples = synthTrack();
const map = buildMusicMapFromSamples(samples, SR);

console.log('music-map:');
console.log(`  (合成轨 ${map.durationSec.toFixed(1)}s，bpm=${map.bpm}，beats=${map.beats.length}，downbeats=${map.downbeats.length}，sections=${map.sections.map((s) => `${s.label}@${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}(${s.energy.toFixed(2)})`).join(' / ')})`);

t('节拍检出：BPM ≈105，拍数 ≈192', () => {
  assert.ok(Math.abs(map.bpm - 105) < 3, `bpm=${map.bpm}`);
  assert.ok(map.beats.length > 180, `beats=${map.beats.length}`);
});

t('每拍能量与 beats 对齐且在 0..1', () => {
  assert.equal(map.beatEnergies.length, map.beats.length);
  for (const e of map.beatEnergies) assert.ok(e >= 0 && e <= 1);
});

t('重拍：数量 ≈ 拍数/4，间隔 ≈ 4 拍', () => {
  assert.ok(map.downbeats.length > 40, `downbeats=${map.downbeats.length}`);
  const gaps = map.downbeats.slice(1).map((d, i) => d - map.downbeats[i]);
  const beatSec = 60 / 105;
  const ok = gaps.filter((g) => Math.abs(g - beatSec * 4) < 0.2).length;
  assert.ok(ok / gaps.length > 0.8, `重拍间隔异常: ${gaps.slice(0, 8).map((g) => g.toFixed(2))}`);
});

t('段落分割：检出 ≥3 段且 drop 能量显著高于 break/intro', () => {
  assert.ok(map.sections.length >= 3, `sections=${map.sections.length}`);
  const drops = map.sections.filter((s) => s.label === 'drop');
  assert.ok(drops.length >= 1, '没有 drop 段');
  const breaks = map.sections.filter((s) => s.label === 'break' || s.label === 'intro' || s.label === 'outro');
  assert.ok(breaks.length >= 1, '没有弱能量段');
  for (const d of drops) {
    for (const b of breaks) assert.ok(d.energy > b.energy + 0.15, `drop(${d.energy}) 未显著强于 ${b.label}(${b.energy})`);
  }
});

t('段落覆盖全曲且边界在节拍附近', () => {
  assert.ok(Math.abs(map.sections[0].startSec) < 0.01);
  assert.ok(Math.abs(map.sections[map.sections.length - 1].endSec - map.durationSec) < 0.01);
  for (let i = 1; i < map.sections.length; i++) {
    assert.ok(Math.abs(map.sections[i].startSec - map.sections[i - 1].endSec) < 0.01, '段落不连续');
    const b = map.sections[i].startSec;
    const near = map.beats.some((x) => Math.abs(x - b) < 0.15);
    assert.ok(near, `边界 ${b.toFixed(2)}s 不在节拍附近`);
  }
});

t('标签位置：首段偏 intro、末段有 drop 或 outro', () => {
  assert.ok(['intro', 'break', 'build'].includes(map.sections[0].label), `首段=${map.sections[0].label}`);
  assert.ok(['drop', 'outro', 'build'].includes(map.sections[map.sections.length - 1].label), `末段=${map.sections[map.sections.length - 1].label}`);
});

t('退化：静音输入不崩', () => {
  const m2 = buildMusicMapFromSamples(new Float32Array(SR * 10), SR);
  assert.ok(m2.sections.length >= 1);
  assert.equal(m2.beats.length, 0);
});

console.log(`\n===== ${passed} 项全部通过 =====`);
