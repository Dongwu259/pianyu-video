/**
 * B 批鼠标层单测：光标拖尾倾斜（cursorLeanDeg）+ 弹簧手感档（SPRING_TONES）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/cursor-lean.test.ts
 */
import assert from 'node:assert/strict';
import {cursorLeanDeg} from '../../src/remotion/utils/cursorOverlay.ts';
import {
  SPRING_TONES,
  springProgress,
  planClickZoomEnvelopes,
  sampleClickZoom,
} from '../../src/shared/click-zoom-smooth.ts';
import {CURSOR_FOLLOW_PARAMS, SCREEN_DEMO_PARAMS} from '../../src/shared/template-registry.ts';
import type {CursorClick, CursorPoint} from '../../src/shared/capture.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const VH = 1080;
const mkLine = (t0: number, t1: number, x0: number, y0: number, x1: number, y1: number, n = 30): CursorPoint[] => {
  const pts: CursorPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const q = i / n;
    pts.push({t: t0 + (t1 - t0) * q, x: x0 + (x1 - x0) * q, y: y0 + (y1 - y0) * q});
  }
  return pts;
};
const lean = (points: CursorPoint[], t: number, tier: number) =>
  cursorLeanDeg({points, mediaMs: t, vh: VH, leanTier: tier});

// ====== 档位与方向性 ======
{
  const right = mkLine(0, 1000, 100, 500, 500, 500); // 400px/s 向右
  assert.equal(lean(right, 950, 0), 0, '0 档 = 关（零回归）');
  ok('0 档关闭零回归');

  const l3 = lean(right, 950, 3);
  assert.ok(l3 < -1 && l3 > -7, `向右移动应逆时针负角，实测 ${l3.toFixed(2)}°`);
  // 向右 torque=0.707，强档满响应 → -9×0.707=-6.36
  assert.ok(Math.abs(l3 - (-6.36)) < 0.6, `向右 ≈ -9°×0.707=${(-6.36).toFixed(2)}，实测 ${l3.toFixed(2)}°`);
  ok('向右移动 → 逆时针负角（尾滞后向左下）');

  const diag = mkLine(0, 1000, 100, 900, 500, 500); // 右上（y 减小）
  const lDiag = lean(diag, 950, 3);
  assert.ok(lDiag < -7.5 && lDiag >= -9.01, `右上对角应接近满摆 -9°，实测 ${lDiag.toFixed(2)}°`);
  ok('右上移动 → 满摆（与尾向 (1,-1) 反向，|torque|=1）');

  const tail = mkLine(0, 1000, 100, 500, 500, 900); // 右下（与尾同向）
  const lTail = lean(tail, 950, 3);
  assert.ok(Math.abs(lTail) < 0.3, `与尾同向移动不摆尾，实测 ${lTail.toFixed(3)}°`);
  ok('右下对角（尾向）→ 0°');

  // 档位幅度递增：同轨迹 |弱| < |中| < |强|
  const a1 = Math.abs(lean(right, 950, 1));
  const a2 = Math.abs(lean(right, 950, 2));
  const a3 = Math.abs(lean(right, 950, 3));
  assert.ok(a1 < a2 && a2 < a3, `档位幅度递增 ${a1.toFixed(2)} < ${a2.toFixed(2)} < ${a3.toFixed(2)}`);
  ok('弱/中/强档幅度递增');
}

// ====== 阈值与停驻 ======
{
  const slow = mkLine(0, 1000, 100, 500, 102, 500); // 2px/s 远低于阈值
  assert.equal(lean(slow, 950, 3), 0, '慢速不摆');
  assert.equal(lean(slow, 950, 1), 0, '慢速不摆（弱档阈值更高同样不摆）');
  ok('低于起摆阈值 → 0（静止不歪）');

  // 停驻滚出：轨迹 2000ms 结束（8.3ms 网格≈真实 30Hz 密度）。停驻后速度窗自然滚出
  // + idle 衰减（180ms，DogSC 同值）：40ms 仍明显摆尾、120ms 回落过半、170ms 基本归零
  const line = mkLine(0, 2000, 100, 500, 900, 500, 120);
  const before = lean(line, 1990, 3);
  const after40 = lean(line, 2040, 3);
  const after120 = lean(line, 2120, 3);
  const after170 = lean(line, 2170, 3);
  assert.ok(before < -5, `停驻前接近满摆 ${before.toFixed(2)}°`);
  assert.ok(after40 < -1, `停驻 40ms 仍在摆尾（${after40.toFixed(2)}°）`);
  assert.ok(
    Math.abs(after120) < Math.abs(before) * 0.6,
    `停驻 120ms 回落过半（${before.toFixed(2)} → ${after120.toFixed(2)}）`
  );
  assert.ok(Math.abs(after170) < 0.3, `停驻 170ms 基本归零（${after170.toFixed(3)}）`);
  ok('停驻滚出衰减（速度窗+180ms idle），无永久歪斜');
}

// ====== 未来无关性（确定性：不偷看采样窗之外的将来） ======
{
  const A = mkLine(0, 3000, 100, 500, 900, 500);
  const B = mkLine(0, 3000, 100, 500, 900, 500).map((p) =>
    p.t > 2100 ? {t: p.t, x: 3000 - p.x, y: 100 + p.y / 3} : p
  ); // 2100ms 之后乱改
  const T = 2000; // 采样窗最深 T-220 ~ T+60，均 < 2100
  assert.equal(lean(A, T, 3), lean(B, T, 3), '未来段修改不影响当前 lean');
  ok('未来无关性：T 时刻角度只依赖 [T-220, T+60] 窗内轨迹');
}

// ====== 弹簧手感档 ======
{
  // 档 0 与旧默认逐参等价（零回归）
  const t0 = SPRING_TONES[0];
  for (const t of [0.2, 0.5, 0.8]) {
    assert.ok(
      Math.abs(springProgress(t, t0.mass, t0.stiffness, t0.damping, t0.windowSec) - springProgress(t)) < 1e-15,
      `档0=默认 t=${t}`
    );
  }
  // 轻快档起跳更快；厚重档更慢
  const t1 = SPRING_TONES[1];
  const t2 = SPRING_TONES[2];
  assert.ok(springProgress(0.25, t1.mass, t1.stiffness, t1.damping, t1.windowSec) > springProgress(0.25), '轻快 > 标准');
  assert.ok(springProgress(0.5, t2.mass, t2.stiffness, t2.damping, t2.windowSec) < springProgress(0.5), '厚重 < 标准');
  // 端点不漂（任意档 t=1 精确 1）
  for (const tone of [t1, t2]) {
    assert.equal(springProgress(1, tone.mass, tone.stiffness, tone.damping, tone.windowSec), 1);
  }
  ok('弹簧档：0=默认等价 / 1 起跳快 / 2 沉慢 / 端点不漂');

  // sampleClickZoom 吃档位：轻快档同包络上升更快
  const clicks: CursorClick[] = [{t: 1000, x: 400, y: 300, button: 1}];
  const pts = mkLine(0, 4000, 400, 300, 420, 310, 10);
  const env = planClickZoomEnvelopes(clicks, pts, 1920, 1080, {zoomScale: 1.8});
  assert.ok(env.length > 0, '包络应非空（zoomScale>1）');
  const aStd = sampleClickZoom(env, 1000 + 200, clicks, SPRING_TONES[0]).amount;
  const aFast = sampleClickZoom(env, 1000 + 200, clicks, SPRING_TONES[1]).amount;
  assert.ok(aFast > aStd, `轻快档 amount 更快（${aFast.toFixed(3)} > ${aStd.toFixed(3)}）`);
  ok('sampleClickZoom 弹簧档位接线生效');
}

// ====== registry 规格防漂移 ======
{
  const specOf = (specs: {key: string; default?: number; max?: number}[], key: string) =>
    specs.find((s) => s.key === key)!;
  const cf = specOf(CURSOR_FOLLOW_PARAMS, 'clickRipple');
  assert.equal(cf.max, 4, 'clickRipple 升四式档位 max=4');
  assert.equal(cf.default, 1, '默认仍为涟漪（旧工程观感不变）');
  assert.equal(specOf(CURSOR_FOLLOW_PARAMS, 'springTone').default, 0, 'springTone 默认 0');
  assert.equal(specOf(CURSOR_FOLLOW_PARAMS, 'cursorLean').default, 0, 'CursorFollow cursorLean 默认关');
  assert.equal(specOf(SCREEN_DEMO_PARAMS, 'cursorLean').default, 0, 'ScreenDemo cursorLean 默认关');
  ok('registry 规格：clickRipple 四式默认涟漪 / springTone、cursorLean×2 默认关');
}

console.log(`\n${passed} 项通过`);
