/**
 * 指定坐标放大锚点（focusAnchorX/Y）单测：anchorZoomFocus 只覆盖「放大中心」——
 * 激活语义（任一 > 0）/像素换算/safeInset 同口径钳位/包络未激活不改语义/多包络恒定。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/focus-anchor.test.ts
 */
import assert from 'node:assert/strict';
import {
  planClickZoomEnvelopes,
  sampleClickZoom,
  anchorZoomFocus,
  focusMaskState,
} from '../../src/shared/click-zoom-smooth.ts';
import type {CursorClick, CursorPoint} from '../../src/shared/capture.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const W = 1920;
const H = 1080;
const INSET = 0.12; // 与实现 DEFAULTS.safeInset 同值（同组焦点钳位口径）
const mkClick = (t: number, x: number, y: number): CursorClick => ({t, x, y, button: 1});
const mkPoint = (t: number, x: number, y: number): CursorPoint => ({t, x, y});

// 两组点击（左上 / 右下，间隔超过分组阈值 → 两个包络），轨迹全程贯穿
const clicks = [mkClick(1500, 480, 320), mkClick(5200, 1440, 760)];
const points: CursorPoint[] = [
  mkPoint(0, 480, 320),
  mkPoint(800, 500, 340),
  mkPoint(1600, 480, 320),
  mkPoint(3000, 900, 500),
  mkPoint(4600, 1400, 740),
  mkPoint(5300, 1440, 760),
  mkPoint(7000, 1440, 760),
  mkPoint(7900, 1440, 760),
];
const envelopes = planClickZoomEnvelopes(clicks, points, W, H, {zoomScale: 1.8, holdSec: 1.2});
assert.equal(envelopes.length, 2, '前置：两次远距点击应裂为两个包络');

// 1. 缺省关（双 0）：原样返回组焦点（现状行为零变化）
{
  const st = sampleClickZoom(envelopes, 2500, clicks);
  const f = anchorZoomFocus(st, 0, 0, W, H);
  assert.ok(f && st.focus && f.x === st.focus.x && f.y === st.focus.y, '关=组焦点原样');
  ok('缺省关（0,0）→ 原样返回组焦点');
}

// 2. 激活语义：任一 > 0 即激活；安全盒内坐标 = 精确像素换算
{
  const st = sampleClickZoom(envelopes, 2500, clicks);
  assert.deepEqual(anchorZoomFocus(st, 0.6, 0.5, W, H), {x: 0.6 * W, y: 0.5 * H});
  const single = anchorZoomFocus(st, 0.6, 0, W, H); // y=0 但 x>0 激活 → y 钳到下界
  assert.equal(single!.x, 0.6 * W);
  assert.equal(single!.y, INSET * H);
  ok('任一 > 0 即激活，像素 = 归一化 × videoW/H');
}

// 3. 边界钳位（与组焦点同 safeInset 口径）：贴边锚不把放大窗顶出画面
{
  const st = sampleClickZoom(envelopes, 2500, clicks);
  const f = anchorZoomFocus(st, 1, 1, W, H);
  assert.equal(f!.x, (1 - INSET) * W);
  assert.equal(f!.y, (1 - INSET) * H);
  const g = anchorZoomFocus(st, 0, 0.5, W, H); // x=0 但 y>0 激活 → x 钳到左安全界
  assert.equal(g!.x, INSET * W);
  assert.equal(g!.y, 0.5 * H);
  ok(`边界钳位到 [${INSET}, ${1 - INSET}] 归一化安全盒`);
}

// 4. 包络未激活（focus=null）：锚点不凭空触发放大
{
  const idle = sampleClickZoom(envelopes, 200, clicks);
  assert.equal(idle.focus, null, '前置：包络前 focus=null');
  assert.equal(anchorZoomFocus(idle, 0.7, 0.4, W, H), null);
  ok('包络未激活 → null（锚点只改落点不触发）');
}

// 5. 多包络恒定：两个包络满格期 + 交接期，锚点坐标全程同一
{
  const AX = 0.72;
  const AY = 0.3;
  const times = [2500, 5800];
  for (const t of times) {
    const st = sampleClickZoom(envelopes, t, clicks);
    assert.deepEqual(anchorZoomFocus(st, AX, AY, W, H), {x: AX * W, y: AY * H});
  }
  // 交接期（若两包络相接）：sampleClickZoom 返回插值 focus，锚点版仍恒定
  const mid = sampleClickZoom(envelopes, 5100, clicks);
  if (mid.focus) {
    assert.deepEqual(anchorZoomFocus(mid, AX, AY, W, H), {x: AX * W, y: AY * H});
  }
  ok('多点击序列锚点恒定（含交接期）');
}

// 6. 蒙版隔离：focusMaskState 吃原 clickState（锚点不影响蒙版锚点两档语义）
{
  const st = sampleClickZoom(envelopes, 2500, clicks);
  const dim = {focusDimOn: 1, focusDimBlur: 6, focusDimSize: 0.38, focusDimDark: 0.18, focusDimTarget: 0, focusDimShape: 0, focusDimAngle: 0};
  const cam = {scale: 2, translateX: -300, translateY: 100};
  // focusDimTarget=0（点击档）：蒙版锚点=组焦点——即使锚点覆盖了放大中心
  const mask = focusMaskState(dim, st, cam, W, H, 1920, 1080, null);
  assert.ok(mask, '前置：蒙版激活');
  // 蒙版锚点应在组焦点附近（平面坐标 = 组焦点经相机映射），而不是锚点 (0.72W, 0.3H)
  const anchorPx = {x: 0.72 * W, y: 0.3 * H};
  const distGroup = Math.hypot(
    (mask!.cx - (1920 / 2 + cam.scale * (st.focus!.x - W / 2) + cam.translateX)),
    (mask!.cy - (1080 / 2 + cam.scale * (st.focus!.y - H / 2) + cam.translateY)),
  );
  const distAnchor = Math.hypot(
    (mask!.cx - (1920 / 2 + cam.scale * (anchorPx.x - W / 2) + cam.translateX)),
    (mask!.cy - (1080 / 2 + cam.scale * (anchorPx.y - H / 2) + cam.translateY)),
  );
  assert.ok(distGroup < 1e-6, '蒙版锚点=组焦点的相机映射（精确）');
  assert.ok(distAnchor > 50, `蒙版锚点不跟 focusAnchor 跑（距离锚点 ${distAnchor.toFixed(0)}px）`);
  ok('聚焦蒙版锚点不受 focusAnchor 影响（focusDimTarget 语义保留）');
}

console.log(`\nfocus-anchor: ${passed}/${passed} 全部通过`);
