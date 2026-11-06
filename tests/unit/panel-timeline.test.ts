/**
 * panel-timeline 单测：每板驻留粒度（focusPanel/focusBoost 权重时间线）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/panel-timeline.test.ts
 */
import assert from 'node:assert/strict';
import {buildPanelTimeline, panelPhaseAt, focusWeights, panelMotionReport} from '../../src/shared/panel-timeline.ts';
import {
  CAMERA_JOURNEY_3D_PARAMS, GALLERY_HALL_3D_PARAMS, ORBIT_CAROUSEL_3D_PARAMS, TIME_TUNNEL_3D_PARAMS,
  CITY_SCAPE_3D_PARAMS, SPIRAL_ATRIUM_3D_PARAMS, STARFIELD_3D_PARAMS,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('panel-timeline:');

t('全 1 权重与均匀模型严格一致（兼容旧工程/既有断言）', () => {
  const n = 4, TF = 420, df = 0.58;
  const tl = buildPanelTimeline(n, TF, df, [1, 1, 1, 1]);
  const slot = ((0.92 - 0.12) * TF) / n;
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(tl.dwellStart[i] - (0.12 * TF + (i + (1 - df)) * slot)) < 1e-6, `dwellStart[${i}]`);
    assert.ok(Math.abs(tl.dwellDur[i] - slot * df) < 1e-6, `dwellDur[${i}]`);
  }
  assert.ok(Math.abs(tl.travelDur - slot * (1 - df)) < 1e-6);
});

t('权重 [1,2,1]：重点板驻留翻倍，行进等长，总时长守恒', () => {
  const n = 3, TF = 300, df = 0.7;
  const tl = buildPanelTimeline(n, TF, df, [1, 2, 1]);
  assert.ok(Math.abs(tl.dwellDur[1] - 2 * tl.dwellDur[0]) < 1e-6);
  assert.ok(Math.abs(tl.dwellDur[0] - tl.dwellDur[2]) < 1e-6);
  const total = n * tl.travelDur + tl.dwellDur.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 0.8 * TF) < 1e-6, 'open→outro 总时长不变');
});

t('phaseAt：相位序列交替、站号单调、段内进度 0→1、边界严格连续', () => {
  const n = 4, TF = 420;
  const tl = buildPanelTimeline(n, TF, 0.58, [1, 2, 1, 1]);
  let expect: 'travel' | 'dwell' = 'travel';
  let expectI = 0;
  for (let f = Math.floor(tl.travelStart[0]); f < 0.92 * TF; f++) {
    const ph = panelPhaseAt(tl, f);
    const kind = ph.dwell ? 'dwell' : 'travel';
    // 允许推进：travel_i → dwell_i → travel_{i+1}
    if (kind === 'dwell' && expect === 'travel') {assert.equal(ph.i, expectI, `f=${f}`); expect = 'dwell';}
    else if (kind === 'travel' && expect === 'dwell') {assert.equal(ph.i, expectI + 1, `f=${f}`); expectI++; expect = 'travel';}
    assert.equal(ph.i, expectI, `f=${f} 站号回退`);
    assert.ok(ph.p >= 0 && ph.p <= 1, `f=${f} p=${ph.p}`);
  }
  assert.equal(expectI, n - 1, '扫完应到末站');
  assert.equal(panelPhaseAt(tl, 0.92 * TF + 5).i, n - 1, 'outro 帧钳在末站');
});

t('phaseAt 段边界：travel 末帧进度≈1，dwell 首帧进度≈0（速度连续无跳变）', () => {
  const tl = buildPanelTimeline(4, 420, 0.58, [1, 1.8, 1, 1]);
  for (let i = 0; i < 4; i++) {
    const travelEnd = panelPhaseAt(tl, tl.travelStart[i] + tl.travelDur - 0.001);
    const dwellBeg = panelPhaseAt(tl, tl.dwellStart[i] + 0.001);
    assert.ok(travelEnd.p > 0.99 && dwellBeg.p < 0.01, `站 ${i}`);
  }
});

t('focusWeights：序号钳 n-1、倍率钳 [1,2.5]、默认无扰动', () => {
  assert.deepEqual(focusWeights(3, 0, 1), [1, 1, 1]);
  assert.deepEqual(focusWeights(3, 1, 1.8), [1, 1.8, 1]);
  assert.deepEqual(focusWeights(3, 99, 9), [1, 1, 2.5]);
  assert.deepEqual(focusWeights(3, -3, 0.2), [1, 1, 1]);
});

t('七款 3D 场景模板注册 focusPanel/focusBoost（AI 编排经 paramSpecs 自动可下发）', () => {
  const groups = [
    ['journey', CAMERA_JOURNEY_3D_PARAMS], ['gallery', GALLERY_HALL_3D_PARAMS],
    ['carousel', ORBIT_CAROUSEL_3D_PARAMS], ['tunnel', TIME_TUNNEL_3D_PARAMS],
    ['city', CITY_SCAPE_3D_PARAMS], ['spiral', SPIRAL_ATRIUM_3D_PARAMS], ['star', STARFIELD_3D_PARAMS],
  ] as const;
  for (const [name, specs] of groups) {
    const fp = specs.find((s) => s.key === 'focusPanel');
    const fb = specs.find((s) => s.key === 'focusBoost');
    assert.ok(fp, `${name} 缺 focusPanel`);
    assert.ok(fb, `${name} 缺 focusBoost`);
    assert.equal(fp?.default, 0, `${name} focusPanel 默认 0`);
    assert.equal(fb?.default, 1, `${name} focusBoost 默认 1（无扰动）`);
    assert.equal(fb?.min, 1);
    assert.equal(fb?.max, 2.5);
  }
});

t('travelScale=2（camSpeed 舒缓档）：甩头时间翻倍、总时长守恒、边界仍连续', () => {
  const n = 3, TF = 315, df = 0.7;
  const base = buildPanelTimeline(n, TF, df, [1, 1, 1]);
  const slow = buildPanelTimeline(n, TF, df, [1, 1, 1], 0.12, 0.92, 2);
  assert.ok(Math.abs(slow.travelDur - 2 * base.travelDur) < 1e-6, 'travel 时长 ×2');
  const span = 0.8 * TF;
  const total = n * slow.travelDur + slow.dwellDur.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - span) < 1e-6, 'open→outro 总时长不变');
  // travelShare = min(0.72, 0.3×2) = 0.6 → 驻留占比 0.4
  assert.ok(Math.abs(slow.dwellDur[0] - (span * 0.4) / n) < 1e-6);
  for (let f = Math.floor(slow.travelStart[0]); f < 0.92 * TF; f++) {
    const ph = panelPhaseAt(slow, f);
    assert.ok(ph.p >= 0 && ph.p <= 1, `f=${f} p=${ph.p}`);
  }
});

t('travelScale 上限 0.72：极端倍率仍保住 28% 驻留下限', () => {
  const tl = buildPanelTimeline(2, 600, 0.45, [1, 1], 0.12, 0.92, 9);
  assert.ok(Math.abs((tl.travelDur * 2) / (0.8 * 600) - 0.72) < 1e-6);
});

t('panelMotionReport：速度可描述为 °/秒 + 切换频率 + 驻留秒数', () => {
  // 宣传片 v3 中庭段实况：10.5s·30fps、3 板、dwellRatio 2、camSpeed 1 → 0.84s 甩 120° = 143°/s（甩镜级）
  const fast = panelMotionReport(buildPanelTimeline(3, 315, 0.7, [1, 1, 1]), 2.1, 30, 1);
  assert.ok(Math.abs(fast.travelSec - 0.84) < 1e-6);
  assert.ok(Math.abs(fast.meanDegPerSec - 143.2) < 0.1);
  assert.ok(fast.meanDegPerSec > 90, '旧参数确为甩镜（>90°/s）');
  assert.ok(Math.abs(fast.peakDegPerSec - fast.meanDegPerSec * 3) < 1e-6, 'camEase 1 峰值 = 3× 均值');
  assert.ok(Math.abs(fast.switchesPer10s - 10 / 2.8) < 1e-3);
  assert.ok(Math.abs(fast.dwellSec[0] - 1.96) < 1e-6);
  // v26 默认口径：16s、3 板、camSpeed 0（travel ×2）+ camEase 2 → 47°/s 均值 / 88°/s 峰值
  const calm = panelMotionReport(buildPanelTimeline(3, 480, 0.7, [1, 1, 1], 0.12, 0.92, 2), 2.1, 30, 2);
  assert.ok(Math.abs(calm.travelSec - 2.56) < 1e-6);
  assert.ok(Math.abs(calm.meanDegPerSec - 47.0) < 0.1);
  assert.ok(calm.meanDegPerSec < 60 && calm.peakDegPerSec < 100, '默认参数落在展示类运镜区间');
});

console.log(`panel-timeline: ${passed} 项通过`);
