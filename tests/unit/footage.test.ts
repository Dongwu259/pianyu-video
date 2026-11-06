/**
 * footage 纯函数单测：JPEG 流切分、帧差分、镜头边界、运动强度
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/footage.test.ts
 */
import assert from 'node:assert/strict';
import {grayOfPng, frameDiffs, findShotBoundaries, buildShots} from '../../src/main/services/footage.ts';
import {planMediaStorySamples} from '../../src/shared/media-tags.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

/** 造一帧 N×M 灰度（常数或移动方块） */
const frame = (w: number, h: number, bg: number, box?: {x: number; y: number; s: number; v: number}): Float32Array => {
  const out = new Float32Array(w * h).fill(bg);
  if (box) {
    for (let y = box.y; y < Math.min(h, box.y + box.s); y++) {
      for (let x = box.x; x < Math.min(w, box.x + box.s); x++) out[y * w + x] = box.v;
    }
  }
  return out;
};

console.log('footage:');

t('grayOfPng：RGBA → 灰度（取 R 通道，白=255 黑=0）', () => {
  const white = grayOfPng(Buffer.from([255, 128, 0, 0]));
  assert.equal(white[0], 255);
  const black = grayOfPng(Buffer.from([0, 200, 100, 0]));
  assert.equal(black[0], 0);
});

t('frameDiffs：静帧 0、内容变化 > 0、整屏替换更大', () => {
  const w = 8, h = 8;
  const f1 = frame(w, h, 100);
  const f2 = frame(w, h, 100);                      // 同 f1：diff 0
  const f3 = frame(w, h, 100, {x: 2, y: 2, s: 3, v: 200}); // 小方块：小 diff
  const f4 = frame(w, h, 220);                      // 整屏变亮：大 diff
  const d = frameDiffs([f1, f2, f3, f4]);
  assert.equal(d.length, 3);
  assert.equal(d[0], 0);
  assert.ok(d[1] > 5 && d[1] < 40, `小方块 diff=${d[1]}`);
  assert.ok(d[2] > 100, `整屏 diff=${d[2]}`);
});

t('findShotBoundaries：切镜尖峰检出 + 最短镜头约束 + 全静态不碎切', () => {
  // 静(10) → 切镜尖峰 → 静(10) → 切镜 → 静(10)
  const diffs = [2, 1, 2, 1, 2, 60, 2, 1, 2, 1, 55, 2, 1, 2, 1, 2];
  const b = findShotBoundaries(diffs, 3);
  // 尖峰在 i=5/10（帧 i 与 i+1 之间）→ 边界落在采样点 i+1 = 6/11
  assert.deepEqual(b, [0, 6, 11, 16]);
  // 全静态（diff 恒 1）：threshold 有下限 8，不切
  const b2 = findShotBoundaries(new Array(20).fill(1), 3);
  assert.deepEqual(b2, [0, 20]);
});

t('buildShots：镜头区间与运动强度归一', () => {
  const diffs = [1, 1, 1, 1, 50, 6, 6, 6, 6, 1, 1];
  const b = findShotBoundaries(diffs, 2);
  const shots = buildShots(b, diffs, 6, 2);
  assert.equal(shots.length, 2);
  assert.ok(shots[0].startSec === 0 && Math.abs(shots[0].endSec - 5 / 6) < 0.01);
  assert.ok(shots[1].motionScore > shots[0].motionScore, `后段应更动: ${JSON.stringify(shots)}`);
  assert.ok(shots[1].endSec <= 2);
});

t('planMediaStorySamples：跨镜头代表帧优先，缺镜头时均匀覆盖', () => {
  const byShots = planMediaStorySamples(12, [
    {startSec: 0, endSec: 2}, {startSec: 2, endSec: 4},
    {startSec: 4, endSec: 7}, {startSec: 7, endSec: 12},
  ], 3);
  assert.deepEqual(byShots, [
    {timeSec: 1, shotIndex: 0}, {timeSec: 5.5, shotIndex: 2}, {timeSec: 9.5, shotIndex: 3},
  ]);
  assert.deepEqual(planMediaStorySamples(10, undefined, 4), [
    {timeSec: 1.25}, {timeSec: 3.75}, {timeSec: 6.25}, {timeSec: 8.75},
  ]);
  const sparseShots = planMediaStorySamples(8, [{startSec: 0, endSec: 8}], 3);
  assert.equal(sparseShots.length, 3, '单镜头素材也应补足多个时序样本');
  assert.ok(sparseShots.some((sample) => sample.shotIndex === 0), '镜头代表帧需要保留');
  assert.ok(sparseShots.every((sample, i) => i === 0 || sample.timeSec > sparseShots[i - 1].timeSec), '时间点严格升序');
});

console.log(`\n===== ${passed} 项全部通过 =====`);
