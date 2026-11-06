import assert from 'node:assert/strict';
import {buildMediaIntelligenceIndex, sanitizeMediaIntelligence, summarizeMediaIntelligence} from '../../src/shared/media-intelligence.ts';

const index = buildMediaIntelligenceIndex([{
  path: 'demo.mp4', durationSec: 10, name: 'demo.mp4',
  footage: {durationSec: 10, shots: [{startSec: 4, endSec: 7, motionScore: 0.8}, {startSec: -1, endSec: 2, motionScore: 0.2}]},
  tag: {description: '录屏', mood: '科技', scene: '教程', storyUnits: [{startSec: 1, endSec: 3, subject: '按钮', before: '未点', action: '点击', after: '已点', roles: ['action']}]},
}]);

assert.equal(index.version, 1);
assert.deepEqual(index.assets['demo.mp4'].shots.map((s) => s.startSec), [0, 4]);
assert.equal(index.assets['demo.mp4'].actions[0].action, '点击');
assert.match(summarizeMediaIntelligence(index), /点击/);

const restored = sanitizeMediaIntelligence(index);
assert.ok(restored);
assert.equal(restored.assets['demo.mp4'].actions.length, 1, '读取索引不应重复动作链');
assert.equal(restored.assets['demo.mp4'].actions[0].action, '点击');
console.log('media-intelligence tests: passed');

// ====== P0-4 转写回流 helpers ======
import {cuesToRawAsrSegments, digestTranscript, transcriptKeywords} from '../../src/shared/media-intelligence.ts';

const cues = [
  {startSec: 0, endSec: 3, text: ' 大家好 今天来试一下这个剪辑软件 '},
  {startSec: 3, endSec: 8, text: '这个软件支持自动剪辑 自动剪辑很省事'},
  {startSec: 8, endSec: 12, text: 'auto cut works well in auto mode'},
];

assert.deepEqual(cuesToRawAsrSegments(cues), [
  {start: 0, end: 3, text: '大家好 今天来试一下这个剪辑软件'},
  {start: 3, end: 8, text: '这个软件支持自动剪辑 自动剪辑很省事'},
  {start: 8, end: 12, text: 'auto cut works well in auto mode'},
], 'cue → RawAsrSegment 命名转换 + trim');
assert.deepEqual(cuesToRawAsrSegments([{startSec: 1, endSec: 2, text: '   '}]), [], '空文本 cue 被剔除');

assert.ok(digestTranscript(cues).startsWith('大家好'), '全片摘要从第一条有文字 cue 起');
assert.equal(digestTranscript(cues, undefined, 10), '大家好 今天来试一下…', '摘要超长截断加省略号');
assert.ok(digestTranscript(cues, {startSec: 8.5, endSec: 12}).startsWith('auto cut'), '区间摘要只取区间内 cue');
assert.equal(digestTranscript(cues, {startSec: 20, endSec: 30}), '', '区间无 cue → 空串');
assert.equal(digestTranscript([]), '', '无 cue → 空串');

const kws = transcriptKeywords(cues, 8);
assert.ok(kws.includes('自动剪辑'), `关键词含高频 CJK 词（实得 ${kws.join(',')}）`);
assert.ok(kws.includes('auto'), '关键词含拉丁词');
assert.ok(!kws.some((k) => k.includes('了') || k.includes('的')), '停用成分被滤除');

console.log('media-intelligence P0-4 tests: passed');
