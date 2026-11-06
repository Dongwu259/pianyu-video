/**
 * 退场扫光（B4，exit-shine）与 AI 提示卡素材拖入（B2，prompt-drag）时间线单元测试
 *
 * 覆盖：
 * - exitShineProgress：窗口起点/中点/末尾钳制/短段不打扰/自定义窗长/非法输入
 * - dragIn：飞行起止与 smoothstep 中点/chip 弹簧窗/打字顺延/贝塞尔端点与中点
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/exit-shine-prompt-drag.test.ts
 */

import assert from 'node:assert/strict';
import {exitShineProgress} from '../../src/shared/exit-shine.ts';
import {DRAG_START_FRAME, DRAG_FLY_SEC, dragInFlyQ, dragInChipPop, dragInTypingStartFrame, quadBezier} from '../../src/shared/prompt-drag.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('exitShineProgress:');
{
  const fps = 30;
  const total = 150; // 5s 段；窗 0.9s = 27 帧 → start = 123
  assert.equal(exitShineProgress(0, total, fps), 0, '段首为 0');
  assert.equal(exitShineProgress(122, total, fps), 0, '窗前为 0');
  const mid = exitShineProgress(136, total, fps);
  assert.ok(Math.abs(mid - 0.48) < 0.05, `半窗进度≈0.5，实际 ${mid}`);
  assert.equal(exitShineProgress(150, total, fps), 1, '段尾=1');
  assert.equal(exitShineProgress(200, total, fps), 1, '越尾钳 1');
  assert.equal(exitShineProgress(10, 20, fps), 0, '段长不足窗口→整段 0 不打扰');
  assert.ok(Math.abs(exitShineProgress(145, 150, fps, 0.5) - 0.6667) < 0.01, '自定义窗长');
  assert.equal(exitShineProgress(10, 0, fps), 0, '非法总帧');
  ok('窗口起点/中点/末尾钳制/短段不打扰/自定义窗长/非法输入');
}

console.log('dragIn:');
{
  const fps = 30;
  const flyFrames = Math.round(DRAG_FLY_SEC * fps);
  assert.equal(dragInFlyQ(DRAG_START_FRAME - 1, fps), 0, '起飞前为 0');
  assert.equal(dragInFlyQ(DRAG_START_FRAME, fps), 0, '起飞帧为 0');
  const mid = dragInFlyQ(DRAG_START_FRAME + flyFrames / 2, fps);
  assert.ok(Math.abs(mid - 0.5) < 0.001, `smoothstep 中点=0.5，实际 ${mid}`);
  assert.equal(dragInFlyQ(DRAG_START_FRAME + flyFrames, fps), 1, '落定帧=1');
  assert.equal(dragInFlyQ(DRAG_START_FRAME + flyFrames + 100, fps), 1, '越尾钳 1');
  assert.equal(dragInChipPop(DRAG_START_FRAME + flyFrames - 1, fps), 0, '落定前 chip=0');
  const chipMid = dragInChipPop(DRAG_START_FRAME + flyFrames + 11, fps);
  assert.ok(chipMid > 0.3 && chipMid < 1.3, `chip 弹窗中段在过冲区，实际 ${chipMid}`);
  assert.ok(Math.abs(dragInChipPop(DRAG_START_FRAME + flyFrames + 100, fps) - 1) < 1e-9, 'chip 弹簧收尾=1');
  assert.equal(dragInTypingStartFrame(fps, false), 8, '关=模板原 8 帧');
  assert.equal(dragInTypingStartFrame(fps, true), DRAG_START_FRAME + flyFrames + 6, '开=落定后顺延');
  const p = quadBezier({x: 0, y: 0}, {x: 50, y: 100}, {x: 100, y: 0}, 0.5);
  assert.ok(Math.abs(p.x - 50) < 1e-9 && Math.abs(p.y - 50) < 1e-9, '贝塞尔中点');
  const s = quadBezier({x: 0, y: 0}, {x: 10, y: 10}, {x: 20, y: 0}, 0);
  assert.equal(s.x, 0);
  assert.equal(s.y, 0);
  ok('飞行起止/中点/chip 弹窗与收尾/打字顺延/贝塞尔端点与中点');
}

console.log(`\n共 ${passed} 项全部通过`);
