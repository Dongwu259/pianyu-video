/**
 * 缓动档位曲线单测（A 批统一时间语言）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/ease-tiers.test.ts
 */
import assert from 'node:assert/strict';
import {
  easeTierCurve,
  easeInOutSmootherstep,
  easeOutBack,
  easeOutCubic,
} from '../../src/shared/easings.ts';
import {
  KEN_BURNS_PARAMS,
  VERTICAL_SCROLL_PARAMS,
  VIDEO_CUT_PARAMS,
  SPLIT_COMPARE_PARAMS,
  UI_CALLOUT_PARAMS,
  BEFORE_AFTER_PARAMS,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== easeInOutSmootherstep（柔和档） ======
{
  assert.equal(easeInOutSmootherstep(0), 0);
  assert.equal(easeInOutSmootherstep(1), 1);
  assert.equal(easeInOutSmootherstep(0.5), 0.5);
  // 对称：f(t) + f(1-t) = 1（慢起慢停的中心对称）
  for (const t of [0.1, 0.2, 0.35, 0.8]) {
    assert.ok(
      Math.abs(easeInOutSmootherstep(t) + easeInOutSmootherstep(1 - t) - 1) < 1e-12,
      `对称性 t=${t}`
    );
  }
  // 单调
  let prev = 0;
  for (let i = 1; i <= 100; i++) {
    const v = easeInOutSmootherstep(i / 100);
    assert.ok(v >= prev, `单调 i=${i}`);
    prev = v;
  }
  // 中段确实「慢」：四分之一处的进度低于线性（两端慢的直接体现）
  assert.ok(easeInOutSmootherstep(0.25) < 0.25);
  ok('柔和档 smootherstep：端点/中心/对称/单调/两端慢');
}

// ====== easeOutBack（弹性档） ======
{
  assert.ok(Math.abs(easeOutBack(0)) < 1e-12);
  assert.ok(Math.abs(easeOutBack(1) - 1) < 1e-12);
  let maxV = 0;
  let maxT = 0;
  for (let i = 0; i <= 100; i++) {
    const v = easeOutBack(i / 100);
    if (v > maxV) {
      maxV = v;
      maxT = i / 100;
    }
  }
  // 轻过冲：峰值超出终值 5%~15%，且出现在尾段（先冲过再回落）
  assert.ok(maxV > 1.05 && maxV < 1.15, `峰值 ${maxV.toFixed(3)} 应在 (1.05,1.15)`);
  assert.ok(maxT > 0.55 && maxT < 0.8, `峰值位置 ${maxT.toFixed(2)} 应在尾段`);
  // 前半段单调上升
  let prev = 0;
  for (let i = 1; i <= 50; i++) {
    const v = easeOutBack(i / 100);
    assert.ok(v >= prev, `前半单调 i=${i}`);
    prev = v;
  }
  ok('弹性档 easeOutBack：端点归位/轻过冲/尾段回落');
}

// ====== easeTierCurve 档位映射 ======
{
  // 0 档 = 恒等（线性模板零回归）
  const id = easeTierCurve(0);
  assert.equal(id(0.3), 0.3);
  assert.equal(id(0), 0);
  assert.equal(id(1), 1);
  ok('0 档 = 恒等（模板现状零回归）');

  // 1 档 = easeOutCubic（干脆）
  const f1 = easeTierCurve(1);
  assert.equal(f1(0.5), easeOutCubic(0.5));
  assert.ok(f1(0.5) > 0.5, '干脆档前半快于线性');
  ok('1 档 = easeOutCubic 干脆');

  // 2 档 = smootherstep（柔和）
  const f2 = easeTierCurve(2);
  assert.equal(f2, easeInOutSmootherstep);
  ok('2 档 = smootherstep 柔和');

  // 3 档 = easeOutBack（弹性）
  const f3 = easeTierCurve(3);
  assert.equal(f3, easeOutBack);
  ok('3 档 = easeOutBack 弹性');

  // 非整数四舍五入到最近档；越界/NaN 回落恒等（防参数异常崩画面）
  assert.equal(easeTierCurve(0.6)(0.5), easeOutCubic(0.5), '0.6 → 1 档');
  assert.equal(easeTierCurve(2.4)(0.5), easeInOutSmootherstep(0.5), '2.4 → 2 档');
  assert.equal(easeTierCurve(-1)(0.3), 0.3, '负值 → 恒等');
  assert.equal(easeTierCurve(9)(0.3), 0.3, '超上界 → 恒等');
  assert.equal(easeTierCurve(NaN)(0.3), 0.3, 'NaN → 恒等');
  ok('档位取整与异常兜底（四舍五入/越界/NaN）');
}

// ====== registry 规格防漂移（新参数不得被后续编辑误删，默认值保证老工程零变化） ======
{
  const keysOf = (specs: {key: string; default?: number}[]) => new Set(specs.map((s) => s.key));
  const specOf = (specs: {key: string; default?: number}[], key: string) =>
    specs.find((s) => s.key === key)!;

  for (const [name, specs] of [
    ['KenBurns', KEN_BURNS_PARAMS],
    ['VerticalScroll', VERTICAL_SCROLL_PARAMS],
    ['VideoCut', VIDEO_CUT_PARAMS],
    ['SplitCompare', SPLIT_COMPARE_PARAMS],
  ] as const) {
    assert.ok(keysOf(specs).has('motionEase'), `${name} 应含 motionEase`);
    assert.equal(specOf(specs, 'motionEase').default, 0, `${name} motionEase 默认 0`);
  }
  assert.equal(specOf(UI_CALLOUT_PARAMS, 'zoomSec').default, 0.8, 'UICallout zoomSec 默认 0.8s');
  assert.equal(specOf(BEFORE_AFTER_PARAMS, 'wipeSec').default, 0.5, 'BeforeAfter wipeSec 默认 0.5s');
  ok('registry 规格：四模板 motionEase 默认 0 / zoomSec 0.8 / wipeSec 0.5');
}

console.log(`\n${passed} 项通过`);
