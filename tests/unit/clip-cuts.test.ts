/**
 * 挖段（clipCuts）纯函数单元测试 + set_segment_trim 挖段参数校验
 *
 * 覆盖：
 * - normalizeCuts：钳制 / 丢弃过短 / 排序 / 合并重叠与近接
 * - effectiveTrimmedDuration / cutsTotalSec / playableIntervals
 * - timelineToMediaSec：洞内跳出口、洞边界、超出有效时长线性外推
 * - cutAt：落洞判断
 * - splitCutsAt：骑拆点切段分配
 * - validateSetTrimArgs：cuts 数组校验分支
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/clip-cuts.test.ts
 */

import assert from 'node:assert/strict';
import {
  normalizeCuts,
  cutsTotalSec,
  effectiveTrimmedDuration,
  playableIntervals,
  timelineToMediaSec,
  cutAt,
  splitCutsAt,
  buildPlaybackSlices,
  buildPlaybackPlan,
  clipEndSec,
  CUT_MIN_SEC,
  CUT_MERGE_GAP_SEC,
} from '../../src/shared/clipCuts.ts';
import {validateSetTrimArgs} from '../../src/shared/llm-tools.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== normalizeCuts ======

console.log('normalizeCuts:');
{
  assert.equal(normalizeCuts(undefined, 0, 10), undefined);
  assert.equal(normalizeCuts([], 0, 10), undefined);
  ok('空输入返回 undefined');
}
{
  const r = normalizeCuts([{start: 5, end: 8}], 2, 10);
  assert.deepEqual(r, [{start: 5, end: 8}]);
  ok('区间内挖段原样保留');
}
{
  // 越界钳回 (trimStart, trimEnd)
  const r = normalizeCuts([{start: 0, end: 3}, {start: 8, end: 12}], 2, 10);
  assert.deepEqual(r, [{start: 2, end: 3}, {start: 8, end: 10}]);
  ok('越界两端钳回裁剪区间');
}
{
  const r = normalizeCuts([{start: 3, end: 3.05}], 0, 10);
  assert.equal(r, undefined, '过短段被丢弃');
  ok(`短于 ${CUT_MIN_SEC}s 的段被丢弃`);
}
{
  // 乱序输入 → 排序
  const r = normalizeCuts([{start: 6, end: 7}, {start: 2, end: 3}], 0, 10);
  assert.deepEqual(r, [{start: 2, end: 3}, {start: 6, end: 7}]);
  ok('乱序输入按起点排序');
}
{
  // 重叠合并
  const r = normalizeCuts([{start: 2, end: 4}, {start: 3, end: 6}], 0, 10);
  assert.deepEqual(r, [{start: 2, end: 6}]);
  ok('重叠段合并');
}
{
  // 近接合并（间隙 ≤ CUT_MERGE_GAP_SEC）
  const r = normalizeCuts([{start: 2, end: 4}, {start: 4 + CUT_MERGE_GAP_SEC, end: 6}], 0, 10);
  assert.deepEqual(r, [{start: 2, end: 6}]);
  ok('间隙 ≤ 阈值的近接段合并');
}
{
  const r = normalizeCuts([{start: 2, end: 4}, {start: 4.5, end: 6}], 0, 10);
  assert.equal(r?.length, 2, '正常间隙不合并');
  ok('间隙大于阈值不合并');
}

// ====== 时长与可播区间 ======

console.log('cutsTotalSec / effectiveTrimmedDuration / playableIntervals:');
{
  assert.equal(cutsTotalSec(undefined), 0);
  assert.equal(cutsTotalSec([{start: 1, end: 3}, {start: 5, end: 6}]), 3);
  ok('挖段总长累加');
}
{
  assert.equal(effectiveTrimmedDuration(2, 10, [{start: 3, end: 5}]), 6);
  assert.equal(effectiveTrimmedDuration(0, 10, undefined), 10);
  ok('有效时长 = 裁剪区间 − 挖段总长');
}
{
  assert.deepEqual(playableIntervals(0, 10, undefined), [{start: 0, end: 10}]);
  assert.deepEqual(playableIntervals(2, 12, [{start: 4, end: 6}, {start: 8, end: 9}]), [
    {start: 2, end: 4},
    {start: 6, end: 8},
    {start: 9, end: 12},
  ]);
  ok('可播区间按挖段切分');
}

// ====== timelineToMediaSec ======

console.log('timelineToMediaSec:');
{
  // 区间 [0,4) [6,∞)：时间轴 3s → 媒体 3s；3.5s（洞内起）→ 媒体 6s（洞出口）
  const cuts = [{start: 4, end: 6}];
  assert.equal(timelineToMediaSec(3, 0, cuts), 3);
  assert.equal(timelineToMediaSec(4, 0, cuts), 6);
  assert.equal(timelineToMediaSec(5.5, 0, cuts), 7.5);
  ok('洞内时间点映射到洞出口后线性推进');
}
{
  // trimStart 偏移：时间轴 0 = trimStart=2 处；洞 [5,7)：时间轴 3s 恰在洞入口 → 跳到洞出口 7
  const cuts = [{start: 5, end: 7}];
  assert.equal(timelineToMediaSec(2, 2, cuts), 4);
  assert.equal(timelineToMediaSec(3, 2, cuts), 7);
  assert.equal(timelineToMediaSec(2.5, 2, cuts), 4.5);
  ok('时间轴零点 = trimStart');
}
{
  // 超出有效时长：线性外推（洞 [4,6)，有效 8s，时间轴 9s → 媒体 10+1=11）
  const cuts = [{start: 4, end: 6}];
  assert.equal(timelineToMediaSec(9, 0, cuts), 11);
  ok('超出有效时长从末区间线性外推');
}
{
  assert.equal(timelineToMediaSec(2.5, 0, undefined), 2.5);
  ok('无挖段保持线性（回归）');
}

// ====== cutAt ======

console.log('cutAt:');
{
  const cuts = [{start: 4, end: 6}];
  assert.equal(cutAt(5, cuts)?.start, 4);
  assert.equal(cutAt(4, cuts)?.end, 6);
  assert.equal(cutAt(6, cuts), null);
  assert.equal(cutAt(3, cuts), null);
  assert.equal(cutAt(5, undefined), null);
  ok('落洞判断（含边界语义：start 闭 end 开）');
}

// ====== splitCutsAt ======

console.log('splitCutsAt:');
{
  const {first, second} = splitCutsAt([{start: 2, end: 4}, {start: 6, end: 8}], 5);
  assert.deepEqual(first, [{start: 2, end: 4}]);
  assert.deepEqual(second, [{start: 6, end: 8}]);
  ok('拆点两侧各自归属');
}
{
  const {first, second} = splitCutsAt([{start: 2, end: 6}], 4);
  assert.deepEqual(first, [{start: 2, end: 4}]);
  assert.deepEqual(second, [{start: 4, end: 6}]);
  ok('骑在拆点上的段被切开');
}
{
  const {first, second} = splitCutsAt(undefined, 4);
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  ok('无挖段返回双空');
}

// ====== validateSetTrimArgs（cuts 分支）======

console.log('validateSetTrimArgs cuts:');
{
  const r = validateSetTrimArgs({index: 0, trimStart: 1, trimEnd: 9, cuts: [{start: 3, end: 5}]});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.args.cuts, [{start: 3, end: 5}]);
  ok('合法挖段列表通过');
}
{
  const r = validateSetTrimArgs({index: 0, trimStart: 1, trimEnd: 9, cuts: []});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.args.cuts, []);
  ok('空数组 = 清空全部挖段，合法');
}
{
  const r = validateSetTrimArgs({index: 0, trimStart: 1, trimEnd: 9});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.cuts, undefined);
  ok('省略 cuts = 保留现有挖段');
}
{
  const r = validateSetTrimArgs({index: 0, trimStart: 1, trimEnd: 9, cuts: 'x'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /cuts/);
  ok('非数组 cuts 报错');
}
{
  const r = validateSetTrimArgs({index: 0, trimStart: 1, trimEnd: 9, cuts: [{start: 5}]});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /start\/end/);
  ok('缺 end 的挖段报错');
}
{
  const r = validateSetTrimArgs({index: 0, trimStart: 1, trimEnd: 9, cuts: [{start: 5, end: 5}]});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /start < end/);
  ok('end ≤ start 的挖段报错');
}

// ====== buildPlaybackSlices（渲染切片表）======

console.log('buildPlaybackSlices:');
{
  // 无 cuts：单片，从 base 起播、不封口（时间轴零点即 base）
  const s = buildPlaybackSlices(2.5, undefined, 30);
  assert.deepEqual(s, [{timelineFrom: 0, len: Infinity, mediaFrom: 75}]);
  ok('无挖段单片不封口（回归）');
}
{
  // base=0、cuts [4,6] [9,11]、30fps：片 [0,4)→时间轴 0-120 帧、[6,9)→120-210、末片 11s 起
  const s = buildPlaybackSlices(0, [{start: 9, end: 11}, {start: 4, end: 6}], 30);
  assert.deepEqual(s, [
    {timelineFrom: 0, len: 120, mediaFrom: 0},
    {timelineFrom: 120, len: 90, mediaFrom: 180},
    {timelineFrom: 210, len: Infinity, mediaFrom: 330},
  ]);
  ok('多个挖段切出连续时间轴切片，末片不封口');
}
{
  // 挖段起点低于 base（脏数据）：该段被忽略，不产生负长度切片
  const s = buildPlaybackSlices(5, [{start: 1, end: 3}, {start: 8, end: 9}], 30);
  assert.deepEqual(s, [
    {timelineFrom: 0, len: 90, mediaFrom: 150},
    {timelineFrom: 90, len: Infinity, mediaFrom: 270},
  ]);
  ok('base 之前的挖段被忽略');
}

// ====== clipEndSec（窗口尾判定）======

console.log('clipEndSec:');
{
  assert.equal(clipEndSec({duration: 10}), undefined);
  ok('未设 trimEnd = 不封口');
}
{
  assert.equal(clipEndSec({duration: 10, trimEnd: 10}), undefined);
  assert.equal(clipEndSec({duration: 10, trimEnd: 9.98}), undefined);
  ok('trimEnd ≈ 素材时长（0.05s 容差内）= 不封口（回归保护）');
}
{
  assert.equal(clipEndSec({duration: 10, trimEnd: 6.2}), 6.2);
  ok('trimEnd 显著小于时长 = 窗口尾生效（shot 出点）');
}

// ====== buildPlaybackPlan（封口播放计划）======

console.log('buildPlaybackPlan:');
{
  // 不封口：与 buildPlaybackSlices 完全一致（零回归）
  const p = buildPlaybackPlan(2.5, undefined, 30);
  assert.equal(p.playFrames, null);
  assert.deepEqual(p.slices, [{timelineFrom: 0, len: Infinity, mediaFrom: 75}]);
  ok('无 endSec = 不封口原路径');
}
{
  // endSec 不大于 baseSec（脏数据）= 不封口
  const p = buildPlaybackPlan(5, undefined, 30, 4);
  assert.equal(p.playFrames, null);
  ok('endSec ≤ baseSec 防御性不封口');
}
{
  // 无挖段封口：base 2.07、end 6.2、30fps → 单片 124 帧，playFrames 精确
  const p = buildPlaybackPlan(2.07, undefined, 30, 6.2);
  assert.equal(p.playFrames, 124);
  assert.deepEqual(p.slices, [{timelineFrom: 0, len: 124, mediaFrom: 62}]);
  // 冻结帧映射一致性：末片 timelineFrom + len === playFrames（Freeze 帧落在末片内）
  const last = p.slices[p.slices.length - 1];
  assert.equal(last.timelineFrom + last.len, p.playFrames);
  ok('无挖段封口单片，冻结帧映射无漂移');
}
{
  // 带挖段封口：base 0、cuts [4,6]、end 10、30fps → 片 [0,4) + [6,10)，总 120+120=240 帧
  const p = buildPlaybackPlan(0, [{start: 4, end: 6}], 30, 10);
  assert.equal(p.playFrames, 240);
  assert.deepEqual(p.slices, [
    {timelineFrom: 0, len: 120, mediaFrom: 0},
    {timelineFrom: 120, len: 120, mediaFrom: 180},
  ]);
  const last = p.slices[p.slices.length - 1];
  assert.equal(last.timelineFrom + last.len, p.playFrames);
  // 窗口外的挖段不影响切片（cuts [12,14] 在 end 之外）
  const p2 = buildPlaybackPlan(0, [{start: 4, end: 6}, {start: 12, end: 14}], 30, 10);
  assert.deepEqual(p2.slices, p.slices);
  ok('带挖段封口：窗口内挖洞、窗口外挖段忽略');
}
{
  // 挖段盖满整个窗口：保底 1 帧冻结画面，不产生空计划
  const p = buildPlaybackPlan(0, [{start: 0, end: 10}], 30, 10);
  assert.equal(p.playFrames, 1);
  assert.equal(p.slices.length, 1);
  ok('窗口被挖空的防御保底');
}

console.log(`\n共 ${passed} 项全部通过`);
