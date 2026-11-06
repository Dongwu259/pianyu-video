/**
 * 曲库情绪/能量推导（music-mood）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/music-mood.test.ts
 */

import assert from 'node:assert/strict';
import {
  classifyMusicMood,
  energyFromPeaks,
  rankMusicForMood,
  MOOD_LABELS,
} from '../../src/shared/music-mood.ts';
import type {MusicCandidate} from '../../src/shared/music-mood.ts';

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
};

console.log('classifyMusicMood（文件名关键词）:');
check('英文关键词命中', () => {
  assert.equal(classifyMusicMood('Epic-Trailer-Mix.mp3'), 'epic');
  assert.equal(classifyMusicMood('Upbeat-Pop.mp3'), 'upbeat');
  assert.equal(classifyMusicMood('soft-piano-lofi.wav'), 'calm');
  assert.equal(classifyMusicMood('Corporate-Tech-Intro.mp3'), 'corporate');
  assert.equal(classifyMusicMood('Dark-Tense-Build.mp3'), 'tense');
});
check('中文关键词命中', () => {
  assert.equal(classifyMusicMood('欢快轻快节奏.mp3'), 'upbeat');
  assert.equal(classifyMusicMood('安静舒缓钢琴曲.mp3'), 'calm');
  assert.equal(classifyMusicMood('史诗大片配乐.mp3'), 'epic');
  assert.equal(classifyMusicMood('商业科技正能量.wav'), 'corporate');
});
check('无关键词 unknown / 大小写不敏感', () => {
  assert.equal(classifyMusicMood('track01.mp3'), 'unknown');
  assert.equal(classifyMusicMood('XYZ.mp3'), 'unknown');
  assert.equal(classifyMusicMood('EPIC.mp3'), 'epic');
});

console.log('energyFromPeaks（波形包络）:');
check('高能量：均值高', () => {
  const r = energyFromPeaks(Array.from({length: 50}, () => 0.7));
  assert.equal(r.level, 'high');
  assert.ok(r.avg >= 0.45);
});
check('高能量：均值低但 P90 高（有爆发段）', () => {
  const peaks = [...Array(90).fill(0.1), ...Array(10).fill(0.95)];
  assert.equal(energyFromPeaks(peaks).level, 'high');
});
check('中能量 / 低能量', () => {
  assert.equal(energyFromPeaks(Array(50).fill(0.3)).level, 'mid');
  assert.equal(energyFromPeaks(Array(50).fill(0.1)).level, 'low');
});
check('样本不足 unknown（有效值 <8 个）', () => {
  assert.equal(energyFromPeaks([0.5, 0.5]).level, 'unknown');
  assert.equal(energyFromPeaks(undefined).level, 'unknown');
  assert.equal(energyFromPeaks([0.5, NaN, 0.5, 0.5, 0.5, 0.5, 0.5]).level, 'unknown');
  assert.equal(energyFromPeaks([0.5, NaN, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]).level, 'high'); // NaN 被滤掉后剩 8 个有效样本
});

console.log('rankMusicForMood（选曲排序）:');
const lib: MusicCandidate[] = [
  {name: 'calm-piano.mp3', path: '/a', mood: 'calm', energy: 'low'},
  {name: 'epic-trailer.mp3', path: '/b', mood: 'epic', energy: 'high'},
  {name: 'track01.mp3', path: '/c', mood: 'unknown', energy: 'unknown'},
  {name: 'corporate-tech.mp3', path: '/d', mood: 'corporate', energy: 'mid'},
];
check('想要史诗：同情绪+同能量排最前', () => {
  const ranked = rankMusicForMood(lib, 'epic', 'high');
  assert.equal(ranked[0].name, 'epic-trailer.mp3');
});
check('无明确要求：可识别优先、宣传片缺省商业向', () => {
  const ranked = rankMusicForMood(lib);
  assert.equal(ranked[0].name, 'corporate-tech.mp3');
  assert.equal(ranked[ranked.length - 1].name, 'track01.mp3');
});
check('MOOD_LABELS 全覆盖', () => {
  for (const k of ['epic', 'upbeat', 'calm', 'sad', 'corporate', 'tense', 'unknown'] as const) {
    assert.ok(MOOD_LABELS[k].length > 0);
  }
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
