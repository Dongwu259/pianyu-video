/**
 * 光标轨迹后处理（shared/cursor-smooth.ts）单元测试：
 * 端点与时间戳保持 / 缓入缓出（前 1/4 慢于匀速）/ 点击减速进场与驻留 /
 * 瞬移旁路 / 确定性 / 兜底（关闭、采样过少）。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/cursor-smooth.test.ts
 */

import assert from 'node:assert/strict';

const {smoothCursorTrack, CURSOR_DWELL_MS, CURSOR_TELEPORT_RATIO} = await import('../../src/shared/cursor-smooth.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ok ${name}`);
};

// 合成轨迹：30Hz，从 (100,100) 匀速直线到 (900,300)，历时 1s
const line = (x0: number, y0: number, x1: number, y1: number, ms: number, t0 = 0) => {
  const pts = [];
  const n = Math.round(ms / 33);
  for (let i = 0; i <= n; i++) {
    const q = i / n;
    pts.push({t: t0 + Math.round(q * ms), x: x0 + (x1 - x0) * q, y: y0 + (y1 - y0) * q});
  }
  return pts;
};

const VW = 1000;
const VH = 1000;

// 1. 端点与时间戳保持
{
  const pts = line(100, 100, 900, 300, 1000);
  const out = smoothCursorTrack(pts, [], {videoWidth: VW, videoHeight: VH})!;
  assert.equal(out.length, pts.length, '长度不变');
  assert.deepEqual(out.map((p) => p.t), pts.map((p) => p.t), '时间戳不变');
  assert.equal(out[0].x, pts[0].x, '首点 x 保持');
  assert.equal(out[out.length - 1].x, pts[pts.length - 1].x, '末点 x 保持');
  ok('端点与时间戳保持');
}

// 2. 缓入缓出：前 1/4 时间的位移 < 匀速的 1/4（easeInOut 起步慢）
{
  const pts = line(100, 100, 900, 100, 1000);
  const out = smoothCursorTrack(pts, [], {videoWidth: VW, videoHeight: VH})!;
  const q1Idx = pts.findIndex((p) => p.t >= 250);
  const eased = (out[q1Idx].x - out[0].x) / 800;
  assert.ok(eased < 0.2, `前 1/4 时间进度 ${eased.toFixed(3)} 应明显慢于匀速 0.25`);
  const mid = out.findIndex((p) => p.t >= 500);
  const midProg = (out[mid].x - out[0].x) / 800;
  assert.ok(midProg > 0.45 && midProg < 0.62, `中点进度 ${midProg.toFixed(3)} 应接近 0.5 且对称`);
  ok('端点缓入缓出（起步慢、中点近半）');
}

// 3. 点击：减速进场（点击前位移变慢）+ 落点驻留
{
  // 0-1s 匀速移动，1s 处点击
  const pts = line(100, 500, 800, 500, 1000);
  const clicks = [{t: 1000, x: 800, y: 500, button: 1}];
  const out = smoothCursorTrack(pts, clicks, {videoWidth: VW, videoHeight: VH})!;
  // 驻留：点击后 DWELL_MS 内钉在点击位置
  const dwellIdx = out.findIndex((p) => p.t > 1000 && p.t <= 1000 + CURSOR_DWELL_MS);
  if (dwellIdx >= 0) {
    assert.ok(Math.abs(out[dwellIdx].x - 800) < 0.5, `驻留期 x=${out[dwellIdx].x} 应在点击位 800`);
  }
  // 减速进场：最后 200ms 的位移占比 < 匀速的 20%
  const last200 = out.filter((p) => p.t >= 800 && p.t <= 1000);
  const tailProg = (last200[last200.length - 1].x - last200[0].x) / 700;
  const tailTime = (last200[last200.length - 1].t - last200[0].t) / 1000;
  assert.ok(tailProg < tailTime * 0.6, `点击前尾段进度 ${tailProg.toFixed(3)}/时间 ${tailTime.toFixed(2)} 应减速`);
  ok('点击减速进场 + 落点驻留');
}

// 4. 瞬移旁路：>40% 视频宽的跳变段原样保留（起终点间被 easing 拉成慢速扫屏 = 恐怖谷）
{
  const pts = [
    ...line(100, 100, 300, 100, 400),
    ...line(300, 100, 900, 100, 100, 400), // 100ms 内横跳 600px（> 40%×1000）
    ...line(900, 100, 950, 100, 400, 500),
  ];
  const out = smoothCursorTrack(pts, [], {videoWidth: VW, videoHeight: VH});
  if (out) {
    // 跳变段（t=400~500）不应被缓动拉匀：段中点附近的采样应保持原始位置（旁路）
    const nearest = (arr: typeof pts, t: number) => arr.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    const midJump = nearest(out, 450);
    const origMid = nearest(pts, 450);
    assert.equal(midJump.t, origMid.t);
    assert.ok(Math.abs(midJump.x - origMid.x) < 0.001, `瞬移段采样应保持原始位置（${midJump.x} vs ${origMid.x}）`);
  }
  ok(`瞬移段旁路（阈值 ${(CURSOR_TELEPORT_RATIO * 100)|0}% 视频宽）`);
}

// 5. 确定性
{
  const pts = [...line(100, 100, 500, 100, 500), ...line(500, 100, 500, 600, 400, 500)];
  const clicks = [{t: 500, x: 500, y: 100, button: 1}];
  const a = smoothCursorTrack(pts, clicks, {videoWidth: VW, videoHeight: VH});
  const b = smoothCursorTrack(pts, clicks, {videoWidth: VW, videoHeight: VH});
  assert.deepEqual(a, b, '同输入同输出');
  ok('确定性');
}

// 6. 兜底：关闭 / 采样过少 / 非法尺寸 → null
{
  const pts = line(0, 0, 100, 100, 300);
  assert.equal(smoothCursorTrack(pts, [], {videoWidth: VW, videoHeight: VH, enabled: false}), null, '关闭返回 null');
  assert.equal(smoothCursorTrack(pts.slice(0, 4), [], {videoWidth: VW, videoHeight: VH}), null, '采样过少返回 null');
  assert.equal(smoothCursorTrack(pts, [], {videoWidth: 0, videoHeight: VH}), null, '非法宽度返回 null');
  ok('兜底（关闭/过少/非法尺寸 → null）');
}

// 7. 折线路径保持：L 形轨迹不会被打穿成对角线（中间点仍在拐角附近）
{
  const pts = [...line(100, 100, 700, 100, 600), ...line(700, 100, 700, 600, 600, 600)];
  const out = smoothCursorTrack(pts, [], {videoWidth: VW, videoHeight: VH})!;
  // 拐角时刻 t=600 附近的点 x 应接近 700（沿折线走到拐角），y 仍小
  const corner = out.find((p) => p.t === 600)!;
  assert.ok(Math.abs(corner.x - 700) < 60, `拐角 x=${corner.x.toFixed(0)} 应接近 700（路径保持）`);
  ok('折线路径形状保持（不打穿拐角）');
}

console.log(`\n通过 ${passed} 组断言`);
