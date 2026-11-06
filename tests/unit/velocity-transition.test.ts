/**
 * W2 速度匹配转场（velocityPush）+ eye-trace 倾斜纪律（tiltAuto/suggestCursorTiltSign）单测
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/velocity-transition.test.ts
 */
import assert from 'node:assert/strict';
import {transitionStyle, TRANSITION_DEFAULT_SEC, TRANSITION_PEAK_PHASE, DEFAULT_TRANSITION_PRESET} from '../../src/shared/transition-style.ts';
import {TRANSITION_OPTIONS} from '../../src/shared/types.ts';
import {TRANSITION_SFX_KIND} from '../../src/shared/sfx-plan.ts';
import {CURSOR_FOLLOW_PARAMS} from '../../src/shared/template-registry.ts';
import {suggestCursorTiltSign} from '../../src/remotion/utils/cursorOverlay.ts';
import type {CursorPoint} from '../../src/shared/capture.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 从 transform 字符串抽 translateX 百分比数值（如 'translateX(-55%)' → -55） */
const txOf = (style: {transform?: string}): number => {
  const m = style.transform?.match(/translateX\((-?[\d.]+)%\)/);
  return m ? parseFloat(m[1]) : NaN;
};

// ====== velocityPush 样式数学 ======
{
  const out0 = transitionStyle('velocityPush', 'out', 0);
  const out1 = transitionStyle('velocityPush', 'out', 1);
  const in0 = transitionStyle('velocityPush', 'in', 0);
  const in1 = transitionStyle('velocityPush', 'in', 1);
  assert.equal(txOf(out0), 0, '出段起点无位移');
  assert.ok(Math.abs(txOf(out1) - (-110)) < 1e-9, `出段终点全离场（-110%），got ${txOf(out1)}`);
  assert.ok(Math.abs(txOf(in0) - 110) < 1e-9, `入段起点从对侧全幅（+110%），got ${txOf(in0)}`);
  assert.equal(txOf(in1), 0, '入段终点归位');
  // 单调：出段位移递减（向左）、入段递增（回中）
  let mono = true;
  for (let q = 0; q <= 0.9; q += 0.05) {
    const q2 = Math.min(1, Math.round((q + 0.05) * 1000) / 1000); // 浮点步进钳界：越 1 会在 easeOut 端点产生 -0 假回摆信号
    if (txOf(transitionStyle('velocityPush', 'out', q2)) >= txOf(transitionStyle('velocityPush', 'out', q))) mono = false;
    if (txOf(transitionStyle('velocityPush', 'in', q2)) >= txOf(transitionStyle('velocityPush', 'in', q))) mono = false; // in 坐标 110→0 递减（位移幅度收敛）
  }
  assert.ok(mono, '出/入段位移全程单调（加速/减速无回摆）');
  ok('velocityPush：端点/单调/110% 全程在动');
}
{
  // 切点速度连续（数值导数，对称差分）：出段末速 = 入段初速（同向同大小）
  const eps = 0.001;
  const vOut = (txOf(transitionStyle('velocityPush', 'out', 1)) - txOf(transitionStyle('velocityPush', 'out', 1 - eps))) / eps; // 前向差分到端点（与 in 同口径）
  const vIn = (txOf(transitionStyle('velocityPush', 'in', eps)) - txOf(transitionStyle('velocityPush', 'in', 0))) / eps;
  assert.ok(Math.abs(vOut - vIn) < 1e-6, `切点速度连续：出段末速 ${vOut.toFixed(2)} vs 入段初速 ${vIn.toFixed(2)}`);
  // 动力形态定量：push/whip 无曲线路径同为 easeInOut（ez）——切点两侧速度=0（中点最快端点停），
  // 靠拖影/淡出掩接缝；velocityPush 切点=加速终点峰值（3×均速）且两侧严格相等——全家族唯一切点流动
  const vPushOut = (txOf(transitionStyle('push', 'out', 1)) - txOf(transitionStyle('push', 'out', 1 - eps))) / eps;
  const vPushIn = (txOf(transitionStyle('push', 'in', eps)) - txOf(transitionStyle('push', 'in', 0))) / eps;
  assert.ok(Math.abs(vPushOut) < 1 && Math.abs(vPushIn) < 1, `push 切点速度≈0（easeInOut 端点停）：${vPushOut.toFixed(2)} / ${vPushIn.toFixed(2)}`);
  const vWhipOut = (txOf(transitionStyle('whip', 'out', 1)) - txOf(transitionStyle('whip', 'out', 1 - eps))) / eps;
  const vWhipIn = (txOf(transitionStyle('whip', 'in', eps)) - txOf(transitionStyle('whip', 'in', 0))) / eps;
  assert.ok(Math.abs(vWhipOut) < 1 && Math.abs(vWhipIn) < 1, `whip 同为切点≈0（靠 24px 拖影掩接缝）：${vWhipOut.toFixed(2)} / ${vWhipIn.toFixed(2)}`);
  assert.ok(Math.abs(vOut) > 300, `velocityPush 切点速度 ${Math.abs(vOut).toFixed(0)}%（3×均速峰值）——切点在流动而非跳停`);
  ok('velocityPush：切点速度严格连续且为动力峰值（push/whip 均≈0 跳停）');


}
{
  // 拖影剖面：中点 18px、端点 0；direction=4（右）出段向右离场
  const mid = transitionStyle('velocityPush', 'out', 0.5);
  assert.ok(Math.abs((mid.motionBlur?.x ?? 0) - 18) < 1e-9, `中点拖影 18px，got ${mid.motionBlur?.x}`);
  assert.equal(transitionStyle('velocityPush', 'out', 0).motionBlur?.x ?? 0, 0, '端点无拖影');
  assert.equal(transitionStyle('velocityPush', 'out', 1, {direction: 4}).transform, 'translate(110%, 0%)', 'direction=4 出段向右');
  assert.equal(transitionStyle('velocityPush', 'out', 1).transform, 'translateX(-110%)', '缺省向左（字符串级同族惯例）');
  ok('velocityPush：拖影剖面 18px 中峰 / direction 四向 / 缺省左零回归');
}
{
  // 曲线路径（mechanicalStyle）：p 直喂位移量（曲线掌控速度）
  const c = {points: [{x: 0, y: 0}, {x: 1, y: 1}], smoothing: 0};
  assert.equal(transitionStyle('velocityPush', 'out', 0.5, {curve: c}).transform, 'translateX(-55%)', '曲线中点 → 位移 55%');
  ok('velocityPush：曲线路径机械直喂');
}

// ====== 注册表防漂移 ======
{
  const opt = TRANSITION_OPTIONS.find((o) => o.value === 'velocityPush');
  assert.ok(opt && opt.group === '运动' && opt.label === '速度匹配', JSON.stringify(opt));
  assert.equal(TRANSITION_DEFAULT_SEC.velocityPush, 0.55);
  assert.equal(TRANSITION_PEAK_PHASE.velocityPush, 0.5);
  assert.equal(DEFAULT_TRANSITION_PRESET.velocityPush, 'easeInOut');
  assert.equal(TRANSITION_SFX_KIND.velocityPush, 'swish');
  const spec = CURSOR_FOLLOW_PARAMS.find((s) => s.key === 'tiltAuto');
  assert.ok(spec && spec.default === 0, JSON.stringify(spec));
  ok('registry 防漂移：转场选项/三表/音效映射/tiltAuto 默认关');
}

// ====== suggestCursorTiltSign（eye-trace 纪律） ======
{
  const mk = (pts: Array<[number, number, number]>): CursorPoint[] => pts.map(([t, x, y]) => ({t, x, y}));
  assert.equal(suggestCursorTiltSign(mk([[0, 100, 100], [500, 300, 110], [1000, 500, 105], [1500, 700, 120]])), 1, '持续向右 → +1');
  assert.equal(suggestCursorTiltSign(mk([[0, 700, 100], [500, 500, 110], [1000, 300, 105], [1500, 100, 120]])), -1, '持续向左 → -1');
  assert.equal(suggestCursorTiltSign(mk([[0, 100, 100], [500, 110, 300], [1000, 105, 500], [1500, 120, 700]])), 0, '纯竖直无主导 → 0');
  assert.equal(suggestCursorTiltSign(mk([[0, 100, 100], [500, 400, 100], [1000, 100, 100]])), 0, '往返回到原点 → 0（右300 左300 净零）');
  assert.equal(suggestCursorTiltSign(undefined), 0, '无轨迹 → 0');
  assert.equal(suggestCursorTiltSign(mk([[0, 100, 100]])), 0, '单点 → 0');
  // 混合但右主导：右 600px + 左 100px + 竖 200px → ratio=(600-100)/(600+100+200)≈0.56 → +1
  assert.equal(suggestCursorTiltSign(mk([[0, 100, 100], [500, 700, 150], [800, 600, 200], [1200, 500, 350]])), 1, '速度加权右主导 → +1');
  ok('suggestCursorTiltSign：主方向/无主导/往返抵消/加权混合');
}

console.log(`\n${passed} 项通过`);
