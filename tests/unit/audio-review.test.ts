/**
 * 音频审片（ffmpeg 输出解析 + 文案比对）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/audio-review.test.ts
 */

import assert from 'node:assert/strict';
import {
  parseVolumeDetect,
  parseSilenceDetect,
  parseLoudnormTp,
  meaningfulSilences,
  parseLoudnormProbe,
  textSimilarity,
  missingKeywords,
  audioReviewIssues,
} from '../../src/shared/audio-review.ts';
import type {AudioReviewReport} from '../../src/shared/audio-review.ts';

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

console.log('parseVolumeDetect:');
check('正常解析 + 爆音判定边界', () => {
  const r = parseVolumeDetect('[Parsed_volumedetect] mean_volume: -18.2 dB / max_volume: -0.3 dB');
  assert.equal(r.meanDb, -18.2);
  assert.equal(r.maxDb, -0.3);
  assert.equal(r.clippingSuspected, true);
  const ok = parseVolumeDetect('mean_volume: -20.0 dB\nmax_volume: -1.5 dB');
  assert.equal(ok.clippingSuspected, false);
});
check('无匹配返回 null 字段', () => {
  assert.deepEqual(parseVolumeDetect('nothing here'), {meanDb: null, maxDb: null, clippingSuspected: null});
});

console.log('parseLoudnormTp（volumedetect 缺失时的峰值兜底）:');
check('提取 input_tp / 无匹配返回 null', () => {
  assert.equal(parseLoudnormTp('[Parsed_loudnorm] {"input_i": "-14.2", "input_tp": "-1.8"}'), -1.8);
  assert.equal(parseLoudnormTp('no json'), null);
});

console.log('parseSilenceDetect:');
check('多段静音配对解析', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 1.5',
    '[silencedetect @ 0x1] silence_end: 3.2 | silence_duration: 1.7',
    '[silencedetect @ 0x1] silence_start: 10',
    '[silencedetect @ 0x1] silence_end: 12.5 | silence_duration: 2.5',
  ].join('\n');
  const spans = parseSilenceDetect(stderr);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[0], {start: 1.5, end: 3.2, duration: 1.7});
  assert.deepEqual(spans[1], {start: 10, end: 12.5, duration: 2.5});
});
check('负值 start 钳 0 / 无配对 start 丢弃', () => {
  const spans = parseSilenceDetect('silence_start: -0.5\nsilence_end: 0.4 | silence_duration: 0.9\nsilence_start: 9');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[0].duration, 0.4);
});

console.log('meaningfulSilences（首尾容差 + 最短时长）:');
check('首尾 0.3s 内与 <0.8s 的不算问题', () => {
  const spans = [
    {start: 0, end: 1.5, duration: 1.5},        // 首部容差内（start <= 0.3）
    {start: 5, end: 5.5, duration: 0.5},        // 太短
    {start: 6, end: 7.2, duration: 1.2},        // 有效
    {start: 29.8, end: 31, duration: 1.2},      // 尾部容差内（end >= 30-0.3）
  ];
  const out = meaningfulSilences(spans, 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 6);
});

console.log('parseLoudnormProbe:');
check('JSON 探测值 + 达标判定（±1.5）', () => {
  const stderr = '[Parsed_loudnorm] {"input_i": "-14.2", "input_tp": "-1.8", "input_lra": "11.0"}';
  const r = parseLoudnormProbe(stderr);
  assert.equal(r.integrated, -14.2);
  assert.equal(r.ok, true);
  assert.equal(parseLoudnormProbe('{"input_i": "-18.0"}').ok, false);
  assert.deepEqual(parseLoudnormProbe('no json'), {integrated: null, target: -14, ok: null});
});

console.log('textSimilarity（中文 bigram Jaccard）:');
check('相同 = 1 / 完全不同 ≈ 0 / 局部重叠中间值', () => {
  assert.equal(textSimilarity('全新智能剪辑软件上线', '全新智能剪辑软件上线'), 1);
  assert.equal(textSimilarity('全新智能剪辑软件上线', '今天天气不错'), 0);
  const mid = textSimilarity('全新智能剪辑软件上线', '智能剪辑软件全新上线');
  assert.ok(mid > 0.4 && mid < 1);
});
check('标点空白大小写归一化', () => {
  assert.equal(textSimilarity('全新,智能 剪辑！', '全新智能剪辑'), 1);
  assert.equal(textSimilarity('AI Clip', 'ai clip'), 1);
  assert.equal(textSimilarity('', 'x'), 0);
});

console.log('missingKeywords（漏读词清单）:');
check('整词缺失 / 长词 4 字滑窗软命中不算缺', () => {
  const missing = missingKeywords('全新智能剪辑软件 一键生成字幕 4K高清导出', '全新智能剪辑软件 自动生成字幕');
  // 「4K高清导出」内容完全不在转写中 → 报缺
  assert.ok(missing.includes('4K高清导出'));
  // 「一键生成字幕」的核心内容「生成字幕」已被说出（软命中，只差「一键」二字）→ 不算缺
  assert.ok(!missing.includes('一键生成字幕'));
  // 长词局部错字（滑窗命中）不算缺
  const soft = missingKeywords('全自动智能剪辑引擎', '全自能智能剪辑引擎带动');
  assert.deepEqual(soft, []);
});
check('单字词与空串跳过 / 上限截断', () => {
  assert.deepEqual(missingKeywords('一 二 三', '一二三'), []);
  const many = missingKeywords(Array.from({length: 20}, (_, i) => `词语${i}`).join(' '), '', 8);
  assert.equal(many.length, 8);
});

console.log('audioReviewIssues（报告汇总）:');
check('四类问题各自成条 / 全部健康为空', () => {
  const bad: AudioReviewReport = {
    loudness: {integrated: -18, target: -14, ok: false},
    peak: {meanDb: -16, maxDb: -0.2, clippingSuspected: true},
    problemSilences: [{start: 6, end: 7.5, duration: 1.5}],
    durationSec: 30,
    asr: {transcript: 'x', similarity: 0.4, missingKeywords: ['一键生成']},
  };
  const issues = audioReviewIssues(bad);
  assert.equal(issues.length, 4);
  assert.ok(issues.some((i) => i.includes('响度')));
  assert.ok(issues.some((i) => i.includes('爆音')));
  assert.ok(issues.some((i) => i.includes('静音')));
  assert.ok(issues.some((i) => i.includes('相似度')));
  const good: AudioReviewReport = {
    loudness: {integrated: -14.3, target: -14, ok: true},
    peak: {meanDb: -18, maxDb: -1.5, clippingSuspected: false},
    problemSilences: [],
    durationSec: 30,
  };
  assert.deepEqual(audioReviewIssues(good), []);
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
