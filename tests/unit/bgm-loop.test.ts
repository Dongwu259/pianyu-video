/**
 * BGM 循环平铺规划（planBgmLoop / bgmLoopEnvelopeAt）单元测试
 * v1.5：签名改为对象入参（spanSec 循环窗 + startAtSec 起播点）；缺省值路径与旧行为逐帧一致。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/bgm-loop.test.ts
 */

import assert from 'node:assert/strict';
import {
  planBgmLoop,
  bgmLoopEnvelopeAt,
  BGM_LOOP_CROSSFADE_SEC,
  BGM_LOOP_DEFAULT_FADEOUT_SEC,
} from '../../src/shared/bgm-loop.ts';

const FPS = 30;

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

console.log('planBgmLoop（BGM 循环平铺规划）:');

check('BGM 不短于成片 → 单份、无接缝、沿用工程淡出（与旧行为一致）', () => {
  const p = planBgmLoop({spanSec: 60, videoTotalSec: 30, fadeOutSec: 3, fps: FPS});
  assert.equal(p.copies, 1);
  assert.deepEqual(p.startFrames, [0]);
  assert.equal(p.crossfadeFrames, 0);
  assert.equal(p.effectiveFadeOutSec, 3);
});

check('BGM 短于成片 → 多份平铺，起始帧按 步进=份长-接缝 排布且覆盖到片尾', () => {
  // 10s BGM 配 32s 成片：接缝 0.12s≈4 帧（30fps 取整），步进 300-4=296
  const p = planBgmLoop({spanSec: 10, videoTotalSec: 32, fadeOutSec: 0, fps: FPS});
  assert.equal(p.copyFrames, 300);
  assert.equal(p.crossfadeFrames, Math.round(BGM_LOOP_CROSSFADE_SEC * FPS));
  const stride = p.copyFrames - p.crossfadeFrames;
  // 覆盖 32s=960 帧：copies = 1 + ceil((960-300)/296) = 1 + ceil(660/296) = 4
  assert.equal(p.copies, 4);
  assert.deepEqual(p.startFrames, [0, stride, stride * 2, stride * 3]);
  // 末份末尾必须覆盖到成片总帧
  assert.ok(p.startFrames[p.copies - 1] + p.copyFrames >= 32 * FPS);
  // 循环且未配淡出 → 默认 2s 片尾淡出
  assert.equal(p.effectiveFadeOutSec, BGM_LOOP_DEFAULT_FADEOUT_SEC);
});

check('循环但工程已配淡出 → 沿用工程值', () => {
  const p = planBgmLoop({spanSec: 10, videoTotalSec: 32, fadeOutSec: 2.5, fps: FPS});
  assert.ok(p.copies > 1);
  assert.equal(p.effectiveFadeOutSec, 2.5);
});

check('起播点 >0：份数按剩余时长规划、起始帧整体平移 startAt', () => {
  // 10s BGM、成片 32s、起播 8s：剩余 24s=720 帧，copies = 1 + ceil((720-300)/296) = 1+2 = 3
  const p = planBgmLoop({spanSec: 10, startAtSec: 8, videoTotalSec: 32, fadeOutSec: 0, fps: FPS});
  const startAtF = 8 * FPS;
  const stride = p.copyFrames - p.crossfadeFrames;
  assert.equal(p.copies, 3);
  assert.deepEqual(p.startFrames, [startAtF, startAtF + stride, startAtF + stride * 2]);
  assert.ok(p.startFrames[p.copies - 1] + p.copyFrames >= 32 * FPS);
});

check('起播点后剩余时长 ≤ 窗长 → 单份从 startAt 起', () => {
  const p = planBgmLoop({spanSec: 10, startAtSec: 25, videoTotalSec: 32, fadeOutSec: 1, fps: FPS});
  assert.equal(p.copies, 1);
  assert.deepEqual(p.startFrames, [25 * FPS]);
  assert.equal(p.crossfadeFrames, 0);
});

check('起播点 ≥ 成片总长 → 空规划（BGM 不进成片）', () => {
  const p = planBgmLoop({spanSec: 10, startAtSec: 40, videoTotalSec: 32, fadeOutSec: 0, fps: FPS});
  assert.equal(p.copies, 0);
  assert.deepEqual(p.startFrames, []);
});

check('循环窗 < 整曲时长（截取副歌循环）：copyFrames 按窗长算', () => {
  // 素材 60s 只用 [30,38) 8s 窗循环铺 32s 成片：copies = 1 + ceil((960-240)/236) = 1+4 = 5
  const p = planBgmLoop({spanSec: 8, startAtSec: 0, videoTotalSec: 32, fadeOutSec: 0, fps: FPS});
  assert.equal(p.copyFrames, 240);
  assert.equal(p.copies, 5);
  assert.ok(p.startFrames[p.copies - 1] + p.copyFrames >= 32 * FPS);
});

check('边界：窗长 ≤0 → 单份零长规划不炸（仍从 startAt 起）', () => {
  const p = planBgmLoop({spanSec: 0, startAtSec: 5, videoTotalSec: 30, fadeOutSec: 0, fps: FPS});
  assert.equal(p.copies, 1);
  assert.deepEqual(p.startFrames, [5 * FPS]);
});

console.log('bgmLoopEnvelopeAt（接缝交叉淡化包络）:');

check('单份（不循环）→ 恒 1', () => {
  const p = planBgmLoop({spanSec: 60, videoTotalSec: 30, fadeOutSec: 0, fps: FPS});
  assert.equal(bgmLoopEnvelopeAt(p, 0, 0), 1);
  assert.equal(bgmLoopEnvelopeAt(p, 0, p.copyFrames), 1);
});

check('首份头不淡入、尾淡出；中间份头淡入尾淡出；末份头淡入尾不淡出', () => {
  const p = planBgmLoop({spanSec: 10, videoTotalSec: 32, fadeOutSec: 0, fps: FPS});
  const cf = p.crossfadeFrames;
  // 首份：头=1，尾渐出到 0
  assert.equal(bgmLoopEnvelopeAt(p, 0, 0), 1);
  assert.equal(bgmLoopEnvelopeAt(p, 0, p.copyFrames), 0);
  assert.ok(bgmLoopEnvelopeAt(p, 0, p.copyFrames - Math.floor(cf / 2)) < 1);
  // 中间份：头渐入，尾渐出
  assert.equal(bgmLoopEnvelopeAt(p, 1, 0), 0);
  assert.equal(bgmLoopEnvelopeAt(p, 1, cf), 1);
  assert.equal(bgmLoopEnvelopeAt(p, 1, p.copyFrames), 0);
  // 末份：头渐入，尾=1（片尾淡出由全局包络负责，接缝包络不管）
  const last = p.copies - 1;
  assert.equal(bgmLoopEnvelopeAt(p, last, 0), 0);
  assert.equal(bgmLoopEnvelopeAt(p, last, cf), 1);
  assert.equal(bgmLoopEnvelopeAt(p, last, p.copyFrames), 1);
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
