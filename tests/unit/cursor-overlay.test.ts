/**
 * cursorOverlayState 单测：空/单点轨迹 → null、媒体像素 → 画框坐标映射、
 * 对称窗口滑动平均平滑、点击按压脉冲、startFrom 时间映射。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/cursor-overlay.test.ts
 */
import {cursorOverlayState} from '../../src/remotion/utils/cursorOverlay';
import type {CursorClick, CursorPoint} from '../../src/shared/capture';

let passed = 0;
let failed = 0;
const near = (actual: number, expected: number, msg: string, eps = 1e-6) => {
  if (Math.abs(actual - expected) <= eps) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  }
};
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

// 基准场景：视频 1920×1080，画框 1280×720，placed 恰好铺满（媒体坐标 /1.5 = 画框坐标）
const placed = {width: 1280, height: 720, translateX: 0, translateY: 0};
const base = {frame: 0, fps: 30, startFrom: 0, vw: 1920, vh: 1080, placed};

// 1. 无轨迹 / 单点轨迹 → null
ok(cursorOverlayState({...base, points: undefined, clicks: undefined}) === null, 'undefined points');
ok(cursorOverlayState({...base, points: [], clicks: undefined}) === null, 'empty points');
ok(cursorOverlayState({...base, points: [{t: 0, x: 100, y: 100}], clicks: undefined}) === null, 'single point');

// 2. 静止轨迹：窗口内采样全在同一点 → 平滑后仍是该点；坐标映射 = 媒体/1.5
const still: CursorPoint[] = [
  {t: 0, x: 960, y: 540},
  {t: 5000, x: 960, y: 540},
];
const st1 = cursorOverlayState({...base, frame: 30, points: still, clicks: undefined});
ok(st1 !== null, 'still track renders');
near(st1!.x, 640, 'still x mapped');
near(st1!.y, 360, 'still y mapped');
near(st1!.press, 0, 'no click no press');

// 3. placed 偏移与缩放折叠：placed 半宽 + 平移 100/50 → x = (960/1920)*640 + 100 = 420
const placed2 = {width: 640, height: 360, translateX: 100, translateY: 50};
const st2 = cursorOverlayState({...base, frame: 30, points: still, clicks: undefined, placed: placed2});
near(st2!.x, 420, 'placed translateX folded');
near(st2!.y, 230, 'placed translateY folded');

// 4. 平滑消抖：轨迹在基准线上下 ±30px 高频交替（30Hz 轮询抖动），
// 对称窗口平均后应显著小于原始振幅（窗口 ±60ms 覆盖 ±2 个原始点）
const jitter: CursorPoint[] = [];
for (let t = 0; t <= 4000; t += 33) {
  jitter.push({t, x: 960, y: 540 + (Math.round(t / 33) % 2 === 0 ? 30 : -30)});
}
// 媒体时间 1000ms（frame=30）：原始采样恰好落在某个抖动相位上，平滑后 |y-540| 应 < 30
const st3 = cursorOverlayState({...base, frame: 30, points: jitter, clicks: undefined});
ok(st3 !== null, 'jitter track renders');
const jitterMediaY = (st3!.y / 720) * 1080; // 反算媒体坐标
ok(Math.abs(jitterMediaY - 540) < 30, `smoothed jitter dampened (got ${jitterMediaY.toFixed(1)})`);

// 5. 匀速运动轨迹：x 从 0 → 1920 用 4s；媒体 2s 时 x ≈ 960（±平滑窗口端点截断误差外的中心区）
const moving: CursorPoint[] = [
  {t: 0, x: 0, y: 540},
  {t: 4000, x: 1920, y: 540},
];
const st4 = cursorOverlayState({...base, frame: 60, points: moving, clicks: undefined});
near(st4!.x, 640, 'moving mid x mapped', 1);

// 6. 按压脉冲：点击在媒体 1000ms；frame=30 当帧 press=1，0.15s 后 = 0.5，0.3s 后 = 0
const clicks: CursorClick[] = [{t: 1000, x: 960, y: 540, button: 1}];
near(cursorOverlayState({...base, frame: 30, points: still, clicks})!.press, 1, 'press at click frame');
const pressLater = cursorOverlayState({...base, frame: 30 + 4.5, points: still, clicks})!.press;
near(pressLater, 0.5, 'press decay 0.15s', 1e-9);
near(cursorOverlayState({...base, frame: 30 + 9, points: still, clicks})!.press, 0, 'press over');
near(cursorOverlayState({...base, frame: 0, points: still, clicks})!.press, 0, 'press before click');

// 7. startFrom 时间映射：startFrom=30（媒体从 1s 起播），frame=0 → 媒体 1000ms → 按压当帧
near(cursorOverlayState({...base, startFrom: 30, frame: 0, points: still, clicks})!.press, 1, 'startFrom shifts media time');

console.log(`cursor-overlay: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
