/**
 * 音效自动放置规划（shared/sfx-plan.ts）纯逻辑单元测试
 *
 * 运行方式：node tests/unit/sfx-plan.test.ts
 */

import assert from 'node:assert/strict';
import {
  planSfxPlacements,
  TRANSITION_SFX_KIND,
  SFX_LEAD_SEC,
  INTRO_RISER_ZONE_SEC,
} from '../../src/shared/sfx-plan.ts';
import {DEFAULT_SFX_CONFIG, type SfxKind, type TransitionType} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const FPS = 30;
const COUNTS: Record<SfxKind, number> = {whoosh: 3, swish: 3, sweep: 2, drop: 2, impact: 3, riser: 3, click: 3};

/** 构造 3 段时间线：每段 8s=240帧，前两段带 15 帧转场窗口，末段无；转场类型可指定 */
const makeTimings = (transitions: TransitionType[] = ['zoomIn', 'crossfade']) => [
  {contentStartFrame: 0, contentEndFrame: 240, outOverlap: 15, isLast: false, transition: transitions[0]},
  {contentStartFrame: 240, contentEndFrame: 480, outOverlap: 15, isLast: false, transition: transitions[1]},
  {contentStartFrame: 480, contentEndFrame: 720, outOverlap: 0, isLast: true, transition: 'none' as const},
];

/** 只取转场音效（排除片头 riser；impact 既可能来自转场也可能来自节拍，调用方需注意） */
const transitionSfx = (r: {kind: SfxKind}[]) => r.filter((p) => p.kind !== 'riser');

// ---- 总开关 ----
{
  const r = planSfxPlacements(makeTimings(), [2, 4], FPS, {...DEFAULT_SFX_CONFIG, enabled: false}, COUNTS);
  assert.equal(r.length, 0);
  ok('enabled=false 时不放任何音效');
}

// ---- 转场类型 → 音效类别映射 ----
{
  const all: TransitionType[] = [
    'crossfade', 'slide', 'wipe', 'iris', 'push', 'zoom', 'rotate', 'blur', 'flash', 'zoomIn', 'zoomOut', 'whip', 'flyThrough',
    'panChase', 'orbitSwipe', 'cardSweep', 'shapeBloom',
  ];
  for (const tr of all) {
    const r = planSfxPlacements(makeTimings([tr, 'none']), [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, COUNTS);
    assert.equal(r.length, 1, `${tr} 应有一个转场音效`);
    assert.equal(r[0].kind, TRANSITION_SFX_KIND[tr], `${tr} → ${TRANSITION_SFX_KIND[tr]}`);
  }
  ok('17 种转场各自映射到设计的音效类别');
}

// ---- 转场音效放置帧：高潮帧（B3 骑跨）或中点（crossfade）提前各类别 lead ----
{
  const r = planSfxPlacements(makeTimings(['zoomIn', 'crossfade']), [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, COUNTS);
  assert.equal(r.length, 2);
  // 第一个转场（zoomIn→drop）：peak=0.85>0 骑跨，高潮帧 = 切点 240，提前 0.26s*30=7.8 帧 → 232
  assert.equal(r[0].kind, 'drop');
  assert.equal(r[0].frame, Math.round(240 - SFX_LEAD_SEC.drop * FPS));
  // 第二个转场（crossfade→sweep）：peak=0 不骑跨，保持旧窗口中点 487.5，提前 0.3s*30=9 帧
  assert.equal(r[1].kind, 'sweep');
  assert.equal(r[1].frame, Math.round(487.5 - SFX_LEAD_SEC.sweep * FPS));
  ok('转场音效按类别提前量对齐高潮帧（crossfade 保持窗口中点）');
}

// ---- 变体按类别独立轮换 ----
{
  const r = planSfxPlacements(makeTimings(['slide', 'slide']), [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, COUNTS);
  assert.deepEqual(r.map((p) => [p.kind, p.variant]), [['swish', 0], ['swish', 1]]);
  // 混合：slide / zoom / push → swish0 / drop0 / swish1（各自类别独立计数）
  const timings3 = [
    {contentStartFrame: 0, contentEndFrame: 240, outOverlap: 15, isLast: false, transition: 'slide' as const},
    {contentStartFrame: 240, contentEndFrame: 480, outOverlap: 15, isLast: false, transition: 'zoom' as const},
    {contentStartFrame: 480, contentEndFrame: 720, outOverlap: 15, isLast: false, transition: 'push' as const},
    {contentStartFrame: 720, contentEndFrame: 960, outOverlap: 0, isLast: true, transition: 'none' as const},
  ];
  const r2 = planSfxPlacements(timings3, [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, COUNTS);
  assert.deepEqual(r2.map((p) => [p.kind, p.variant]), [['swish', 0], ['drop', 0], ['swish', 1]]);
  ok('变体按类别独立轮换（同类别相邻不重复）');
}

// ---- 映射类别缺货 → 降级 whoosh；whoosh 也缺货 → 不放 ----
{
  const noDrop = {...COUNTS, drop: 0};
  const r = planSfxPlacements(makeTimings(['zoomIn', 'none']), [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, noDrop);
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'whoosh');
  const none2 = {...COUNTS, drop: 0, whoosh: 0};
  const r2 = planSfxPlacements(makeTimings(['zoomIn', 'none']), [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, none2);
  assert.equal(r2.length, 0);
  ok('映射类别缺货降级 whoosh，都缺货则不放');
}

// ---- 硬切不放转场音效 ----
{
  const r = planSfxPlacements(makeTimings(['none', 'crossfade']), [], FPS, DEFAULT_SFX_CONFIG, COUNTS);
  assert.equal(transitionSfx(r).length, 1);
  assert.equal(transitionSfx(r)[0].kind, 'sweep');
  ok('硬切片段不放转场音效');
}

// ---- 逐段音效覆盖（transitionSfx）----
{
  // slide 转场被覆盖为 drop：类别与轮换都按覆盖走
  const timings = makeTimings(['slide', 'crossfade']).map((t, i) => (i === 0 ? {...t, sfxOverride: 'drop' as const} : t));
  const r = planSfxPlacements(timings, [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, COUNTS);
  assert.equal(transitionSfx(r)[0].kind, 'drop');
  ok('sfxOverride 指定类别：slide 转场改放 drop');
}
{
  // 覆盖为 'off'：该转场静音，且不再把邻域列入节拍排除（没有音效可堆叠）
  const timings = makeTimings(['slide', 'crossfade']).map((t, i) => (i === 0 ? {...t, sfxOverride: 'off' as const} : t));
  const r = planSfxPlacements(timings, [8.05], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false, beatImpact: true}, COUNTS);
  assert.equal(transitionSfx(r).filter((p) => p.frame < 240).length, 0);
  assert.equal(r.filter((p) => p.frame === Math.round(8.05 * FPS)).length, 1); // 邻域节拍得以放置
  ok("sfxOverride 'off'：该转场静音且邻域节拍不再被排除");
}
{
  // 覆盖类别缺货 → 降级 whoosh
  const noSweep = {...COUNTS, sweep: 0};
  const timings = makeTimings(['crossfade', 'none']).map((t, i) => (i === 0 ? {...t, sfxOverride: 'sweep' as const} : t));
  const r = planSfxPlacements(timings, [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, noSweep);
  assert.equal(transitionSfx(r)[0].kind, 'whoosh');
  ok('覆盖类别缺货降级 whoosh');
}

// ---- riser 在片头 ----
{
  const r = planSfxPlacements(makeTimings(), [], FPS, DEFAULT_SFX_CONFIG, COUNTS);
  const risers = r.filter((p) => p.kind === 'riser');
  assert.equal(risers.length, 1);
  assert.equal(risers[0].frame, 0);
  ok('introRiser 时 riser 放第 0 帧');
}
{
  const r = planSfxPlacements(makeTimings(), [], FPS, {...DEFAULT_SFX_CONFIG, introRiser: false}, COUNTS);
  assert.equal(r.filter((p) => p.kind === 'riser').length, 0);
  ok('introRiser=false 不放 riser');
}

// ---- 节拍律动（impact/click 交替）：重音每 4 拍、轻点第 2 拍、其余静默 ----
{
  // 节拍：0.5s(片头区跳过) 8.1s(转场邻域跳过,高潮帧240帧=8s) 3s 4s 5s 23.9s(片尾区跳过)
  // 有效拍：3(idx0)→impact 4(idx1)→静默 5(idx2)→click
  const beats = [0.5, 8.1, 3, 4, 5, 23.9];
  const r = planSfxPlacements(makeTimings(), beats, FPS, DEFAULT_SFX_CONFIG, COUNTS);
  const impacts = r.filter((p) => p.kind === 'impact');
  const clicks = r.filter((p) => p.kind === 'click');
  assert.deepEqual(impacts.map((p) => p.frame), [90]);
  assert.deepEqual(clicks.map((p) => p.frame), [150]);
  ok('节拍律动：重音/轻点按 4 拍节奏分布，跳过片头/转场邻域/片尾区');
}
{
  // 密集节拍：0.3s 间隔 3/3.3/3.6/4.5 → impact@3、click@3.6（不机关枪连发）
  const beats = [3, 3.3, 3.6, 4.5];
  const r = planSfxPlacements(makeTimings(), beats, FPS, DEFAULT_SFX_CONFIG, COUNTS);
  assert.deepEqual(r.filter((p) => p.kind === 'impact').map((p) => p.frame), [90]);
  assert.deepEqual(r.filter((p) => p.kind === 'click').map((p) => p.frame), [108]);
  ok('密集节拍只留重音+轻点，不再逐拍敲 impact');
}
{
  // 8 个连续有效拍：impact@idx0/idx4，click@idx2/idx6
  const beats = [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5];
  const r = planSfxPlacements(makeTimings(), beats, FPS, DEFAULT_SFX_CONFIG, COUNTS);
  assert.deepEqual(r.filter((p) => p.kind === 'impact').map((p) => p.frame), [60, 120]);
  assert.deepEqual(r.filter((p) => p.kind === 'click').map((p) => p.frame), [90, 150]);
  ok('长节拍列稳定保持 重-轻 律动（长视频不再全程咚咚咚）');
}
{
  const r = planSfxPlacements(makeTimings(), [3, 4], FPS, {...DEFAULT_SFX_CONFIG, beatImpact: false}, COUNTS);
  assert.equal(r.filter((p) => p.kind === 'impact' || p.kind === 'click').length, 0);
  ok('beatImpact=false 不放节拍音效');
}
{
  // 无 click 库存：弱拍静默，重音不受影响
  const noClick = {...COUNTS, click: 0};
  const r = planSfxPlacements(makeTimings(), [3, 4, 5, 6, 7, 8.5], FPS, DEFAULT_SFX_CONFIG, noClick);
  assert.ok(r.some((p) => p.kind === 'impact'));
  assert.equal(r.filter((p) => p.kind === 'click').length, 0);
  ok('click 缺货时弱拍静默（自动回退不敲鼓）');
}

// ---- 变体缺货类别不放 ----
{
  const counts: Record<SfxKind, number> = {whoosh: 0, swish: 0, sweep: 0, drop: 0, impact: 3, riser: 0, click: 0};
  const r = planSfxPlacements(makeTimings(), [3], FPS, DEFAULT_SFX_CONFIG, counts);
  assert.equal(transitionSfx(r).filter((p) => p.kind !== 'impact').length, 0);
  assert.equal(r.filter((p) => p.kind === 'riser').length, 0);
  assert.equal(r.filter((p) => p.kind === 'impact').length, 1);
  ok('无变体的类别不放（不影响其他类别）');
}

// ---- 结果按帧排序 ----
{
  const r = planSfxPlacements(makeTimings(), [3], FPS, DEFAULT_SFX_CONFIG, COUNTS);
  const frames = r.map((p) => p.frame);
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b));
  ok('放置表按帧升序');
}

console.log(`sfx-plan: ${passed} 项通过`);
