/**
 * computeClickRipples 单测：时间窗过滤 + 视频像素 → 画框坐标映射 + 尺寸归一。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/click-ripples.test.ts
 */
import {computeClickRipples, RIPPLE_LIFE_MS} from '../../src/remotion/utils/clickRipples';
import type {CursorClick} from '../../src/shared/capture';

let passed = 0;
let failed = 0;
const eq = (actual: unknown, expected: unknown, msg: string) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${msg}: expected ${e}, got ${a}`);
  }
};
const near = (actual: number, expected: number, msg: string, eps = 1e-6) => {
  if (Math.abs(actual - expected) <= eps) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  }
};

const click = (t: number, x: number, y: number): CursorClick => ({t, x, y, button: 1});

// 基准场景：视频 1920×1080，画框 1280×720，contain 恰好铺满（placed = 1280×720 @0,0）
const placed = {width: 1280, height: 720, translateX: 0, translateY: 0};

// 1. 空/无点击 → 空列表
eq(computeClickRipples({clicks: undefined, frame: 0, fps: 30, startFrom: 0, vw: 1920, vh: 1080, placed, frameW: 1280}), [], 'undefined clicks');
eq(computeClickRipples({clicks: [], frame: 0, fps: 30, startFrom: 0, vw: 1920, vh: 1080, placed, frameW: 1280}), [], 'empty clicks');

// 2. 时间窗：点击发生在媒体时间 1000ms；fps=30，startFrom=0
//    frame=30 → 媒体时间 1000ms，dtMs=0 → 命中；frame=0（-1000ms）与 frame=57（1900ms ≥ LIFE）不命中
const clicks = [click(1000, 960, 540)];
eq(
  computeClickRipples({clicks, frame: 0, fps: 30, startFrom: 0, vw: 1920, vh: 1080, placed, frameW: 1280}).length,
  0,
  'click in future → none',
);
eq(
  computeClickRipples({clicks, frame: 57, fps: 30, startFrom: 0, vw: 1920, vh: 1080, placed, frameW: 1280}).length,
  0,
  'click expired → none',
);
const hit = computeClickRipples({clicks, frame: 45, fps: 30, startFrom: 0, vw: 1920, vh: 1080, placed, frameW: 1280});
eq(hit.length, 1, 'click in window → one');
near(hit[0].dtMs, 500, 'dtMs = 1500-1000');

// 3. 坐标映射：视频中心 (960,540) → 画框中心 (640,360)；左上 (0,0) → (0,0)
near(hit[0].x, 640, 'center x');
near(hit[0].y, 360, 'center y');
const corner = computeClickRipples({
  clicks: [click(1000, 0, 0)],
  frame: 45,
  fps: 30,
  startFrom: 0,
  vw: 1920,
  vh: 1080,
  placed,
  frameW: 1280,
});
near(corner[0].x, 0, 'corner x');
near(corner[0].y, 0, 'corner y');

// 4. cover 裁剪几何：placed 比画框大且带负平移（视频 1920×1080 cover 进 720×720 方框 → 1280×720，tx=-280）
const coverPlaced = {width: 1280, height: 720, translateX: -280, translateY: 0};
const cov = computeClickRipples({
  clicks: [click(1000, 960, 540)],
  frame: 45,
  fps: 30,
  startFrom: 0,
  vw: 1920,
  vh: 1080,
  placed: coverPlaced,
  frameW: 720,
});
near(cov[0].x, 360, 'cover center x = 640-280');
near(cov[0].y, 360, 'cover center y');

// 5. startFrom 偏移：trimStart=2s（startFrom=60 帧）→ frame=30 时媒体时间 3000ms
const trimmed = computeClickRipples({
  clicks: [click(3000, 960, 540)],
  frame: 30,
  fps: 30,
  startFrom: 60,
  vw: 1920,
  vh: 1080,
  placed,
  frameW: 1280,
});
eq(trimmed.length, 1, 'startFrom aligns media time');
near(trimmed[0].dtMs, 0, 'dtMs exact at click frame');

// 6. 尺寸归一：frameW 1920 → scale 1.5
near(hit[0].scale, 1, 'scale at 1280');
near(cov[0].scale, 720 / 1280, 'scale at 720');

// 7. 生命边界：dtMs = LIFE-ε 命中，= LIFE 不命中
const edgeIn = computeClickRipples({
  clicks: [click(1000 - (RIPPLE_LIFE_MS - 1), 960, 540)],
  frame: 30,
  fps: 30,
  startFrom: 0,
  vw: 1920,
  vh: 1080,
  placed,
  frameW: 1280,
});
eq(edgeIn.length, 1, 'dtMs just under LIFE hits');
const edgeOut = computeClickRipples({
  clicks: [click(1000 - RIPPLE_LIFE_MS, 960, 540)],
  frame: 30,
  fps: 30,
  startFrom: 0,
  vw: 1920,
  vh: 1080,
  placed,
  frameW: 1280,
});
eq(edgeOut.length, 0, 'dtMs == LIFE misses');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
