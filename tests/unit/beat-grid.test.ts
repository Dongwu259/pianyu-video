/**
 * beat-grid 单测（B2 模板感知节拍契约）
 * sliceBeatGrid：无 BGM / 段界上的拍点 / 段窗口偏移 / 空 beats / bpm 透传；
 * snapFrameToBeat：吸附窗口 / 方向 / 帧取整；beatGapSec：中位间隔 / bpm 回退；
 * distributeOnBeats：一拍一个 / 每 4 拍重拍 / 半拍退化 / 均匀兜底 / 段尾不溢出。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/beat-grid.test.ts
 */
import assert from 'node:assert/strict';
import {sliceBeatGrid, snapFrameToBeat, beatGapSec, distributeOnBeats, mergeUserBeats} from '../../src/shared/beat-grid.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

const FPS = 30;

console.log('beat-grid:');

// ====== sliceBeatGrid ======

t('① 无 BGM / 空 beats → undefined（模板零影响路径）', () => {
  assert.equal(sliceBeatGrid(undefined, 124, 0, 4), undefined);
  assert.equal(sliceBeatGrid(null, 124, 0, 4), undefined);
  assert.equal(sliceBeatGrid([], 124, 0, 4), undefined);
});

t('② 段窗口偏移切片：窗内拍点减起点，bpm 透传', () => {
  const g = sliceBeatGrid([0.5, 1.0, 1.5, 2.0, 2.5, 3.0], 124, 1.5, 1.0);
  assert.ok(g);
  assert.deepEqual(g.beatsSec, [0, 0.5]); // 1.5→0，2.0→0.5
  assert.equal(g.bpm, 124);
});

t('③ 拍点在段界上：起点界归本段（相对 0），终点界归下一段', () => {
  const g = sliceBeatGrid([1.0, 2.0, 3.0], 120, 2.0, 1.0);
  assert.ok(g);
  assert.deepEqual(g.beatsSec, [0]); // 2.0→0；3.0 在终点界上 → 排除
});

t('④ 窗口内无拍点 / 段时长非法 → undefined', () => {
  assert.equal(sliceBeatGrid([0.5, 1.0], 120, 5.0, 1.0), undefined);
  assert.equal(sliceBeatGrid([0.5, 1.0], 120, 0, 0), undefined);
  assert.equal(sliceBeatGrid([0.5, 1.0], 120, 0, -1), undefined);
});

t('⑤ 无 bpm → 0（消费方不得依赖）', () => {
  const g = sliceBeatGrid([0.5], undefined, 0, 4);
  assert.ok(g);
  assert.equal(g.bpm, 0);
});

// ====== snapFrameToBeat ======

t('⑥ 空 beats → 原帧（零影响）', () => {
  assert.equal(snapFrameToBeat(17, FPS, []), 17);
});

t('⑦ 吸附最近拍点并取整到帧格', () => {
  // beats 0.5s/0.9s → 帧 15/27；frame 17 距 15 为 2 帧（< 0.25s=7.5 帧）→ 15
  assert.equal(snapFrameToBeat(17, FPS, [0.5, 0.9]), 15);
  // frame 26 距 27 为 1 帧 → 27
  assert.equal(snapFrameToBeat(26, FPS, [0.5, 0.9]), 27);
});

t('⑧ 拍点超出 maxShift → 宁可漂移不抢拍', () => {
  // frame 23 距 0.5s(帧15) 8 帧 = 0.267s > 0.25s → 原帧
  assert.equal(snapFrameToBeat(23, FPS, [0.5]), 23);
  // 显式放宽到 0.3s 则吸附
  assert.equal(snapFrameToBeat(23, FPS, [0.5], {maxShiftSec: 0.3}), 15);
});

t('⑨ direction=next 只取不早于当前帧的拍点', () => {
  // frame 20：nearest → 15（差 5 帧）；next → 27（0.9s，差 0.233s < 0.25s）
  assert.equal(snapFrameToBeat(20, FPS, [0.5, 0.9], {direction: 'nearest'}), 15);
  assert.equal(snapFrameToBeat(20, FPS, [0.5, 0.9], {direction: 'next'}), 27);
  // next 且后面没有拍点 → 原帧
  assert.equal(snapFrameToBeat(20, FPS, [0.5], {direction: 'next'}), 20);
});

// ====== beatGapSec ======

t('⑩ 拍距：≥3 拍取相邻间隔中位数', () => {
  assert.equal(beatGapSec([0.5, 1.0, 1.5, 2.0]), 0.5);
  // 异常大间隔（间奏）被忽略
  assert.equal(beatGapSec([0.5, 1.0, 1.5, 5.0]), 0.5);
});

t('⑪ 拍点不足用 bpm 回退；都无可得 → null', () => {
  assert.equal(beatGapSec([0.5, 1.0], 120), 0.5);
  assert.equal(beatGapSec([], 124)!.toFixed(4), (60 / 124).toFixed(4));
  assert.equal(beatGapSec([0.5]), null);
  assert.equal(beatGapSec([]), null);
});

// ====== distributeOnBeats ======

t('⑫ 一拍一个：count ≤ 拍点数取前 count 拍，首拍为下拍', () => {
  const d = distributeOnBeats(3, [0.5, 1.0, 1.5, 2.0, 2.5], 5, FPS);
  assert.deepEqual(d.frames, [15, 30, 45]);
  assert.deepEqual(d.accented, [true, false, false]);
});

t('⑬ 每 4 拍重拍：第 5 个元素落在第 5 拍（序号 4）→ accented', () => {
  const d = distributeOnBeats(5, [0.5, 1.0, 1.5, 2.0, 2.5, 3.0], 5, FPS);
  assert.deepEqual(d.accented, [true, false, false, false, true]);
});

t('⑭ 拍点不够退化半拍：相邻拍中点 + 首尾外推，整拍元素保留重拍标记', () => {
  // 2 拍（帧 30/60，拍距 1s → 半拍 15 帧）：网格 [15(半), 30(拍0), 45(半), 60(拍1), 75(半)]
  const d = distributeOnBeats(4, [1.0, 2.0], 3, FPS);
  assert.deepEqual(d.frames, [15, 30, 45, 60]);
  assert.deepEqual(d.accented, [false, true, false, false]);
});

t('⑮ 半拍仍不够 → 均匀分配：单调、不出段尾、无重拍', () => {
  const d = distributeOnBeats(20, [1.0, 2.0], 5, FPS);
  assert.equal(d.frames.length, 20);
  for (let i = 1; i < 20; i++) assert.ok(d.frames[i] >= d.frames[i - 1], '单调不减');
  assert.ok(d.frames[19] <= 149, `末帧 ${d.frames[19]} 不出段尾`);
  assert.ok(d.frames[19] <= 120, `末帧 ${d.frames[19]} 留尾部余量`);
  assert.ok(d.accented.every((a) => !a));
});

t('⑯ 空 beats 兜底均匀分配（beatGrid 存在但窗口拍点被滤光）', () => {
  const d = distributeOnBeats(3, [], 4, FPS);
  assert.deepEqual(d.frames, [0, 32, 64]); // tail=24，usable=96，步长 32
  assert.ok(d.accented.every((a) => !a));
});

t('⑰ 负拍点（startOffsetSec 平移场景）被过滤，不参与分配', () => {
  const d = distributeOnBeats(2, [-0.5, 0.5, 1.0], 4, FPS);
  assert.deepEqual(d.frames, [15, 30]);
});

t('⑱ 段尾不溢出：帧恒钳在 [0, totalFrames-1]', () => {
  // 拍点贴段尾：0.4839s 拍距 × 9 拍铺满 4.5s 段（124BPM 实拍网格）
  const beats = Array.from({length: 9}, (_, i) => Math.round((0.1 + i * 0.4839) * 10000) / 10000);
  const d = distributeOnBeats(9, beats, 4.5, FPS);
  assert.equal(d.frames.length, 9);
  for (const f of d.frames) {
    assert.ok(f >= 0 && f <= 134, `帧 ${f} 在 [0,134]`);
  }
  for (let i = 1; i < 9; i++) assert.ok(d.frames[i] >= d.frames[i - 1], '单调不减');
});

// ====== M3 L2：mergeUserBeats（手放节拍标记与 BGM 拍点并流，v1.4） ======
{
  // 未手放 → 原网格原样返回（零漂移：引用相等）
  const grid = {beatsSec: [1, 2, 3], bpm: 120};
  assert.equal(mergeUserBeats(grid, undefined, 8), grid, '未手放原样返回');
  assert.equal(mergeUserBeats(grid, [], 8), grid, '空手放原样返回');

  // 无 BGM：手放标记独立成网格（bpm=0 消费方不得依赖）
  const solo = mergeUserBeats(undefined, [{t: 1.5}, {t: 3.2}], 5);
  assert.deepEqual(solo, {beatsSec: [1.5, 3.2], bpm: 0});

  // 并流：合并排序 + 同值（±5ms）去重 + bpm 保留
  const merged = mergeUserBeats({beatsSec: [1, 2, 3], bpm: 120}, [{t: 1.5}, {t: 2.001}], 5);
  assert.deepEqual(merged, {beatsSec: [1, 1.5, 2, 3], bpm: 120}, '2.001 与 2 同值去重');

  // 段窗外过滤（t<0 或 ≥durationSec）
  const clipped = mergeUserBeats({beatsSec: [1], bpm: 90}, [{t: -0.5}, {t: 4.9}, {t: 5}, {t: 2}], 5);
  assert.deepEqual(clipped, {beatsSec: [1, 2, 4.9], bpm: 90}, 't=5 越窗弃、4.9 保留');

  // 手放全在窗外 → 原网格返回
  const allOut = mergeUserBeats({beatsSec: [1], bpm: 90}, [{t: 9}], 5);
  assert.deepEqual(allOut, {beatsSec: [1], bpm: 90}, '手放全在窗外 → 原网格内容不变');

  passed++;
  console.log('  ✓ mergeUserBeats（零漂移/独奏/并流去重/窗外过滤）');
}

console.log(`beat-grid: ${passed} passed${process.exitCode ? '（有失败）' : ''}`);
