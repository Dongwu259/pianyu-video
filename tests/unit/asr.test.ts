/**
 * ASR verbose_json 解析（segmentsToCaptions）单元测试
 *
 * 运行方式：node tests/unit/asr.test.ts
 * （被测模块 src/shared/asr.ts 不依赖 electron，可在纯 Node 跑）
 */

import assert from 'node:assert/strict';
import {segmentsToCaptions} from '../../src/shared/asr.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 基本解析 ======

console.log('基本解析:');
{
  const lines = segmentsToCaptions(
    [
      {start: 0, end: 1.5, text: ' 你好，世界 '},
      {start: 1.5, end: 3, text: '第二句'},
    ],
    10,
  );
  assert.deepEqual(lines, [
    {text: '你好，世界', startSec: 0, endSec: 1.5},
    {text: '第二句', startSec: 1.5, endSec: 3},
  ]);
  ok('正常分段解析（文案 trim）');
}
{
  // 非数组 / 空数组 / 非法 duration 一律返回 []
  assert.deepEqual(segmentsToCaptions(null, 10), []);
  assert.deepEqual(segmentsToCaptions('x', 10), []);
  assert.deepEqual(segmentsToCaptions([], 10), []);
  assert.deepEqual(segmentsToCaptions([{start: 0, end: 1, text: 'a'}], 0), []);
  assert.deepEqual(segmentsToCaptions([{start: 0, end: 1, text: 'a'}], -5), []);
  assert.deepEqual(segmentsToCaptions([{start: 0, end: 1, text: 'a'}], NaN), []);
  ok('非数组输入 / 非法时长返回空');
}

// ====== 丢弃规则 ======

console.log('丢弃规则:');
{
  const lines = segmentsToCaptions(
    [
      {start: 0, end: 1, text: '   '},          // 空文本 → 丢弃
      {start: 1, end: 2, text: '\n\t'},         // 纯空白 → 丢弃
      {start: 2, end: 3},                       // 缺 text → 丢弃
      {start: 3, end: 4, text: 42},             // text 非字符串 → 丢弃
      {start: NaN, end: 5, text: 'x'},          // start 非有限 → 丢弃
      {start: 5, end: Infinity, text: 'y'},     // end 非有限 → 丢弃
      {start: '6', end: 7, text: 'z'},          // start 非数字 → 丢弃
      'not-an-object',                          // 非对象 → 跳过
      {start: 6, end: 7.5, text: '保留'},
    ],
    10,
  );
  assert.deepEqual(lines, [{text: '保留', startSec: 6, endSec: 7.5}]);
  ok('空文本 / 非数字时间 / 非对象条目全部丢弃');
}

// ====== 越界钳制 ======

console.log('越界钳制:');
{
  const lines = segmentsToCaptions([{start: -2, end: 99, text: '全程'}], 10);
  assert.deepEqual(lines, [{text: '全程', startSec: 0, endSec: 10}]);
  ok('起 <0 钳到 0，止 >段时长钳到段尾');
}
{
  // 恰好边界：0 ~ duration 原样保留
  const lines = segmentsToCaptions([{start: 0, end: 10, text: '正好'}], 10);
  assert.deepEqual(lines, [{text: '正好', startSec: 0, endSec: 10}]);
  ok('恰好贴边界（0 与段时长）保留');
}
{
  // 整条在段尾之外：起钳到段尾后无法保证 起<止 → 丢弃
  const lines = segmentsToCaptions([{start: 12, end: 15, text: '超尾'}], 10);
  assert.deepEqual(lines, []);
  ok('整条超出段尾丢弃');
}

// ====== 起止倒置 / 相等（对齐 CaptionPanel 互钳：止最少比起晚 0.1s）======

console.log('起止倒置/相等:');
{
  const lines = segmentsToCaptions([{start: 5, end: 3, text: '倒置'}], 10);
  assert.deepEqual(lines, [{text: '倒置', startSec: 5, endSec: 5.1}]);
  ok('起止倒置钳正为 起+0.1s');
}
{
  const lines = segmentsToCaptions([{start: 3, end: 3, text: '等长'}], 10);
  assert.deepEqual(lines, [{text: '等长', startSec: 3, endSec: 3.1}]);
  ok('起=止钳正为 起+0.1s');
}
{
  // 起已贴段尾：没有 0.1s 余量可钳 → 丢弃
  const lines = segmentsToCaptions([{start: 10, end: 9, text: '贴尾'}], 10);
  assert.deepEqual(lines, []);
  ok('起贴段尾且倒置时无法钳正，丢弃');
}

// ====== 精度整理（两位小数）======

{
  const lines = segmentsToCaptions([{start: 1.23456, end: 2.34567, text: '精度'}], 10);
  assert.deepEqual(lines, [{text: '精度', startSec: 1.23, endSec: 2.35}]);
  ok('时间整理到两位小数');
}

console.log(`\nasr: ${passed} 项全部通过`);
