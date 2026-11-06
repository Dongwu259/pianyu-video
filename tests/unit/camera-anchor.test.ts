/**
 * 相机帧混合（锚点防漂移，B 项）单测
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/camera-anchor.test.ts
 */
import assert from 'node:assert/strict';
import {cameraFrame, blendCameraFrame} from '../../src/remotion/utils/followCamera.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const VW = 1920;
const VH = 1080;
const CW = 1920;
const CH = 1080;

// ====== 端点恒等 ======
console.log('端点:');
{
  const a = cameraFrame(500, 300, VW, VH, 1.4, CW, CH);
  const b = cameraFrame(1400, 700, VW, VH, 1.4 * 1.8, CW, CH);
  const near = (x: {scale: number; translateX: number; translateY: number}, y: typeof a) =>
    Math.abs(x.scale - y.scale) < 1e-9 &&
    Math.abs(x.translateX - y.translateX) < 1e-6 &&
    Math.abs(x.translateY - y.translateY) < 1e-6;
  assert.ok(near(blendCameraFrame(a, b, 0, VW, VH, CW, CH), a));
  assert.ok(near(blendCameraFrame(a, b, 1, VW, VH, CW, CH), b));
  ok('q=0/1 精确回到两端相机帧（浮点尾差 <1e-6px）');
}

// ====== 直线性质（无钳位区间） ======
console.log('直线性质:');
{
  // 内容点屏幕位置 = planeW/2 + scale×(p − videoW/2) + tx（followCamera 的相机变换）
  const screenX = (cam: {scale: number; translateX: number}, p: number) =>
    CW / 2 + cam.scale * (p - VW / 2) + cam.translateX;
  const a = cameraFrame(700, 400, VW, VH, 1.4, CW, CH);
  const b = cameraFrame(1500, 800, VW, VH, 2.52, CW, CH);
  // 目标兴趣点（b 的注视点）在混合相机下的屏幕位置：q 均匀采样二阶差分应≈0（直线）
  const P = 1500;
  let maxCurv = 0;
  let prev1 = screenX(blendCameraFrame(a, b, 0.3, VW, VH, CW, CH), P);
  let prev2 = screenX(blendCameraFrame(a, b, 0.2, VW, VH, CW, CH), P);
  for (let i = 4; i <= 9; i++) {
    const cur = screenX(blendCameraFrame(a, b, i / 10, VW, VH, CW, CH), P);
    maxCurv = Math.max(maxCurv, Math.abs(cur - 2 * prev1 + prev2));
    prev2 = prev1;
    prev1 = cur;
  }
  assert.ok(maxCurv < 1e-6, `二阶差分（曲率）应≈0，实际 ${maxCurv}`);
  ok(`内容点屏幕轨迹为直线（曲率 ${maxCurv.toExponential(1)}）`);
}

// ====== 兴趣点单调收敛（反例回归：旧路径外甩） ======
console.log('单调收敛:');
{
  const rawFocus = {x: 700, y: 400};
  const clickFocus = {x: 1500, y: 800};
  const zoom = 1.4;
  // 外甩条件：boost 斜率 = clickZoom（zoom 是乘性常数不改变 f 形状）。f(q)=(1−q)(1+(k−1)q)
  // 在 k>2 时 f'(0)=k−2>0 → 起步先远离再收敛。clickZoom 参数范围 1..3，取 2.8 复现。
  const k = 2.8;
  const camRaw = cameraFrame(rawFocus.x, rawFocus.y, VW, VH, zoom, CW, CH);
  const camTarget = cameraFrame(clickFocus.x, clickFocus.y, VW, VH, zoom * k, CW, CH);
  const distNew = (q: number) => {
    const cam = blendCameraFrame(camRaw, camTarget, q, VW, VH, CW, CH);
    const sx = CW / 2 + cam.scale * (clickFocus.x - VW / 2) + cam.translateX;
    const sy = CH / 2 + cam.scale * (clickFocus.y - VH / 2) + cam.translateY;
    return Math.hypot(sx - CW / 2, sy - CH / 2);
  };
  // 新路径：目标点到画布中心的距离随 q 单调不增（直线收敛）
  let monotone = true;
  for (let i = 1; i <= 20; i++) {
    if (distNew(i / 20) > distNew((i - 1) / 20) + 1e-9) monotone = false;
  }
  assert.ok(monotone, '新路径兴趣点屏幕距离应单调不增');
  ok('新路径：目标兴趣点单调直线收敛到画布中心');

  // 旧路径复现（focus 与 zoom 各自插值再 cameraFrame 乘积耦合）——证明外甩真实存在
  const distOld = (kk: number) => (q: number) => {
    const boost = 1 + (kk - 1) * q;
    const fx = rawFocus.x + (clickFocus.x - rawFocus.x) * q;
    const fy = rawFocus.y + (clickFocus.y - rawFocus.y) * q;
    const cam = cameraFrame(fx, fy, VW, VH, zoom * boost, CW, CH);
    const sx = CW / 2 + cam.scale * (clickFocus.x - VW / 2) + cam.translateX;
    const sy = CH / 2 + cam.scale * (clickFocus.y - VH / 2) + cam.translateY;
    return Math.hypot(sx - CW / 2, sy - CH / 2);
  };
  const old28 = distOld(2.8);
  let overshoot = 0;
  for (let i = 1; i <= 20; i++) overshoot = Math.max(overshoot, old28(i / 20) - old28(0));
  assert.ok(overshoot > 1, `clickZoom=2.8 旧路径起步外甩应>1px，实测 ${overshoot.toFixed(1)}px`);
  ok(`旧路径反例坐实（clickZoom=2.8）：外甩 ${overshoot.toFixed(1)}px 先远离再收敛——已修`);

  // 默认参数（clickZoom=1.8<2）旧路径无外甩但新路径同样不回归
  const old18 = distOld(1.8);
  let mono18 = true;
  for (let i = 1; i <= 20; i++) {
    if (old18(i / 20) > old18((i - 1) / 20) + 1e-9) mono18 = false;
  }
  assert.ok(mono18, '默认参数旧路径本就单调（外甩阈值 k>2）');
  ok('默认参数（clickZoom=1.8）双向都不外甩（阈值口径核对）');
}

// ====== 覆盖重钳制（中间态不露边） ======
console.log('覆盖钳制:');
{
  // 一端贴边强钳位（注视点出画面安全区）、另一端自由：混合中间态 translate 必须仍满足覆盖
  const a = cameraFrame(0, 0, VW, VH, 1.0, CW, CH);        // scale=1 全幅无平移余量
  const b = cameraFrame(1700, 900, VW, VH, 2.5, CW, CH);
  for (let i = 0; i <= 10; i++) {
    const cam = blendCameraFrame(a, b, i / 10, VW, VH, CW, CH);
    const w = VW * cam.scale;
    const h = VH * cam.scale;
    const maxTx = Math.max(0, (w - CW) / 2);
    const maxTy = Math.max(0, (h - CH) / 2);
    assert.ok(Math.abs(cam.translateX) <= maxTx + 1e-9, `q=${i / 10} X 覆盖（|tx| ${Math.abs(cam.translateX).toFixed(0)} ≤ ${maxTx.toFixed(0)}）`);
    assert.ok(Math.abs(cam.translateY) <= maxTy + 1e-9, `q=${i / 10} Y 覆盖`);
  }
  ok('混合中间态覆盖重钳制（贴边不对称两端不露背景）');
}

// ====== 出场同径返回 ======
console.log('对称性:');
{
  const camRaw = cameraFrame(700, 400, VW, VH, 1.4, CW, CH);
  const camTarget = cameraFrame(1500, 800, VW, VH, 2.52, CW, CH);
  const up = blendCameraFrame(camRaw, camTarget, 0.6, VW, VH, CW, CH);
  const down = blendCameraFrame(camRaw, camTarget, 0.4, VW, VH, CW, CH);
  // 进出场走同一直线族：任意 q 的相机只依赖 q 本身（回落路径与进场路径重合，无滞回）
  assert.ok(
    Math.abs(blendCameraFrame(camRaw, camTarget, 0.6, VW, VH, CW, CH).scale - up.scale) < 1e-9 &&
      Math.abs(blendCameraFrame(camRaw, camTarget, 0.6, VW, VH, CW, CH).translateX - up.translateX) < 1e-6,
  );
  assert.notDeepEqual(up, down);
  ok('进出场同径（相机态是 q 的单值函数，回落无滞回）');
}

console.log(`\n${passed} 项通过`);
