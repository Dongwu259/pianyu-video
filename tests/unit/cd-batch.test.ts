/**
 * C/D 批单测：entryEase 统一时间语言 + SPRINGS 收编 + recenterFocus 收框 +
 * focusMask 条带形状 + registry 防漂移（16+2 模板 motionEase / drawSpeed / textEnter / tempo）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/cd-batch.test.ts
 */
import assert from 'node:assert/strict';
import {entryEase, SPRINGS, EASINGS} from '../../src/remotion/animations/motion.ts';
import {easeTierCurve, easeOutCubic} from '../../src/shared/easings.ts';
import {recenterFocus, focusMaskState} from '../../src/shared/click-zoom-smooth.ts';
import {
  LOWER_THIRD_PARAMS, STAT_COUNTER_PARAMS, TESTIMONIAL_PARAMS, TIMELINE_ROADMAP_PARAMS,
  PRICING_TIERS_PARAMS, COMING_SOON_PARAMS, LOGO_CLOUD_PARAMS, NEON_TECH_PARAMS,
  TEXT_SLIDE_PARAMS, GLOBE_POINTS_PARAMS, FEATURE_LIST_PARAMS, BRAND_INTRO_PARAMS,
  UI_CALLOUT_PARAMS, BEFORE_AFTER_PARAMS, CARD_CONVERGE_PARAMS, TREND_LINE_3D_PARAMS,
  HERO_3D_TITLE_PARAMS, CURSOR_FOLLOW_PARAMS,
} from '../../src/shared/template-registry.ts';
import type {TemplateParamSpec} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== entryEase（C 批核心：0 档 = 模板原曲线引用相等 = 零回归） ======
{
  assert.equal(entryEase(0), EASINGS.standard, '0 档默认 base 引用相等');
  assert.equal(entryEase(0, EASINGS.inOut), EASINGS.inOut, '0 档自定义 base 引用相等');
  assert.equal(entryEase(1), easeTierCurve(1), '1 档 = easeTierCurve(1)');
  assert.equal(entryEase(3, EASINGS.inOut), easeTierCurve(3), '3 档覆盖自定义 base');
  assert.equal(entryEase(0.4), EASINGS.standard, '0.4 取整 0 = base');
  assert.equal(entryEase(0.6), easeTierCurve(1), '0.6 取整 1');
  assert.equal(entryEase(-2), EASINGS.standard, '负值 = base');
  assert.equal(entryEase(NaN), EASINGS.standard, 'NaN = base');
  ok('entryEase：0=base 引用等价 / 1-3=档位 / 取整兜底');
}

// ====== SPRINGS 收编（C3：数值原样 = 零视觉回归） ======
{
  assert.deepEqual({...SPRINGS.chipPop}, {damping: 12, stiffness: 200, mass: 0.6});
  assert.deepEqual({...SPRINGS.resultGrow}, {damping: 14, stiffness: 170, mass: 0.7});
  assert.deepEqual({...SPRINGS.stampSettle}, {damping: 14, stiffness: 130});
  ok('SPRINGS 三新令牌与原内联数值逐字段一致');
}

// ====== recenterFocus（D4 可读性收框） ======
{
  // 贴角点击：满格时向安全盒方向收，但每轴漂移封顶 8% 画幅（1920×1080 → cap 153.6/86.4）——
  // 收框是轻推取景不是搬走兴趣点（v9 竖版反馈「放大没聚在点击处」实证后加帽）
  const corner = recenterFocus({x: 1830, y: 60}, 1, 1920, 1080);
  assert.ok(Math.abs(corner.x - (1830 - 153.6)) < 1e-9 && Math.abs(corner.y - (60 + 86.4)) < 1e-9, '贴角满格=8% 封顶漂移');
  // 中心点击：零漂移
  const center = recenterFocus({x: 960, y: 540}, 1, 1920, 1080);
  assert.equal(center.x, 960);
  assert.equal(center.y, 540);
  // amount=0 原位；amount=0.5 半程（漂移量 = 封顶后的一半）
  const half = recenterFocus({x: 1830, y: 540}, 0.5, 1920, 1080);
  assert.ok(Math.abs(half.x - (1830 - 76.8)) < 1e-9, '半程漂移量 = 封顶漂移一半');
  assert.equal(recenterFocus({x: 100, y: 100}, 0, 1920, 1080).x, 100, 'amount 0 = 原位');
  // 安全盒内的点击：漂移未触顶时仍走原线性口径
  const inside = recenterFocus({x: 1400, y: 100}, 1, 1920, 1080);
  assert.ok(Math.abs(inside.x - 1344) < 1e-9 && Math.abs(inside.y - 186.4) < 1e-9, '盒外近距=y 触顶 x 线性');
  ok('recenterFocus：8% 封顶/中心零漂/进度线性/近距线性入盒');
}

// ====== focusMaskState 条带形状（D5） ======
{
  const dim = {
    focusDimOn: 1, focusDimBlur: 6, focusDimSize: 0.38, focusDimDark: 0.18, focusDimTarget: 1,
  };
  const clickState = {amount: 1, focus: {x: 960, y: 540}};
  const cam = {scale: 1, translateX: 0, translateY: 0};
  const radial = focusMaskState(dim, clickState, cam, 1920, 1080, 1920, 1080)!;
  assert.equal(radial.shape, 'radial', '默认椭圆');
  const band = focusMaskState({...dim, focusDimShape: 1, focusDimAngle: 45}, clickState, cam, 1920, 1080, 1920, 1080)!;
  assert.equal(band.shape, 'band', 'shape=1 条带');
  assert.equal(band.angleDeg, 45, '角度透传');
  const clamped = focusMaskState({...dim, focusDimShape: 1, focusDimAngle: 200}, clickState, cam, 1920, 1080, 1920, 1080)!;
  assert.equal(clamped.angleDeg, 90, '角度钳制 ±90');
  // 老调用不传新字段（focusDimShape undefined）→ radial（存量工程零回归）
  ok('focusMaskState：默认椭圆/条带形状/角度钳制/旧调用零回归');
}

// ====== registry 防漂移（C2 16 模板 + D1-D3 参数） ======
{
  const EASED: [string, TemplateParamSpec[]][] = [
    ['LowerThird', LOWER_THIRD_PARAMS], ['StatCounter', STAT_COUNTER_PARAMS],
    ['Testimonial', TESTIMONIAL_PARAMS], ['TimelineRoadmap', TIMELINE_ROADMAP_PARAMS],
    ['PricingTiers', PRICING_TIERS_PARAMS], ['ComingSoon', COMING_SOON_PARAMS],
    ['LogoCloud', LOGO_CLOUD_PARAMS], ['NeonTech', NEON_TECH_PARAMS],
    ['TextSlide', TEXT_SLIDE_PARAMS], ['GlobePoints', GLOBE_POINTS_PARAMS],
    ['FeatureList', FEATURE_LIST_PARAMS], ['BrandIntro', BRAND_INTRO_PARAMS],
    ['UICallout', UI_CALLOUT_PARAMS], ['BeforeAfter', BEFORE_AFTER_PARAMS],
    ['CardConverge', CARD_CONVERGE_PARAMS], ['TrendLine3D', TREND_LINE_3D_PARAMS],
  ];
  for (const [name, specs] of EASED) {
    const spec = specs.find((s) => s.key === 'motionEase');
    assert.ok(spec, `${name} 含 motionEase`);
    assert.equal(spec!.default, 0, `${name} motionEase 默认 0（零回归）`);
  }
  const specOf = (specs: TemplateParamSpec[], key: string) => specs.find((s) => s.key === key)!;
  assert.equal(specOf(TREND_LINE_3D_PARAMS, 'drawSpeed').default, 1, 'drawSpeed 默认 1');
  assert.equal(specOf(HERO_3D_TITLE_PARAMS, 'textEnter').default, 1, 'textEnter 默认 1');
  assert.equal(specOf(NEON_TECH_PARAMS, 'tempo').default, 1, 'tempo 默认 1');
  assert.equal(specOf(CURSOR_FOLLOW_PARAMS, 'focusDimShape').default, 0, 'focusDimShape 默认椭圆');
  assert.equal(specOf(CURSOR_FOLLOW_PARAMS, 'focusRecenter').default, 0, 'focusRecenter 默认关');
  ok('registry：16 模板 motionEase=0 / drawSpeed·textEnter·tempo=1 / 条带·收框默认关');
}

// ====== 干脆档曲线与 EASINGS 口音并存性（档位 1 不等于站内 standard——两套手感并存） ======
{
  assert.notEqual(entryEase(1), EASINGS.standard, '1 档 ≠ 现行口音');
  assert.equal((entryEase(1) as (t: number) => number)(0.5), easeOutCubic(0.5), '1 档求值 = easeOutCubic');
  ok('档位与现行口音并存（0=口音 / 1-3=档位曲线）');
}

console.log(`\n${passed} 项通过`);
