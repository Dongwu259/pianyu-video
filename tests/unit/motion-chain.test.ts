/**
 * motion-chain 单测：运动连续性引擎的选择规则、direction 覆盖、显式转场保护、补丁应用
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/motion-chain.test.ts
 */
import assert from 'node:assert/strict';
import {
  MOTION_TO_DIR_CODE, dirCodeToMotion,
  segEnterMotion, segExitMotion, planMotionChain, applyMotionChain,
} from '../../src/shared/motion-chain.ts';
import {transitionStyle} from '../../src/shared/transition-style.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import type {MotionDir, Segment, TemplateMeta} from '../../src/shared/types.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

const metas = new Map(TEMPLATES.map((x) => [x.id, x]));
const mkSeg = (templateId: string, extra: Partial<Segment> = {}): Pick<Segment, 'templateId' | 'transition' | 'customParams'> => ({
  templateId, transition: 'crossfade', customParams: undefined, ...extra,
});

console.log('motion-chain:');

t('档位码 ↔ MotionDir 双向映射', () => {
  assert.equal(MOTION_TO_DIR_CODE.right, 4);
  assert.equal(dirCodeToMotion(4), 'right');
  assert.equal(dirCodeToMotion(1), 'up');
  assert.equal(dirCodeToMotion(0), 'none');
  assert.equal(dirCodeToMotion(undefined), 'none');
  assert.equal(dirCodeToMotion(99), 'none');
});

t('meta 标注读取：RevealSlide 右进右出，StackCards 无方向', () => {
  assert.equal(segExitMotion(metas.get('RevealSlide')), 'right');
  assert.equal(segEnterMotion(mkSeg('RevealSlide'), metas.get('RevealSlide')), 'right');
  assert.equal(segExitMotion(metas.get('StackCards')), 'none');
  assert.equal(segEnterMotion(mkSeg('StackCards'), metas.get('StackCards')), 'none');
});

t('customParams.direction 覆盖 meta enterMotion（>0 生效，0 回退标注）', () => {
  const sc = metas.get('StackCards');
  assert.equal(segEnterMotion(mkSeg('StackCards', {customParams: {direction: 4}}), sc), 'right');
  // RevealSlide 标注 right，显式 direction=1 改为 up
  assert.equal(segEnterMotion(mkSeg('RevealSlide', {customParams: {direction: 1}}), metas.get('RevealSlide')), 'up');
  // direction=0（自动）回退 meta 标注
  assert.equal(segEnterMotion(mkSeg('RevealSlide', {customParams: {direction: 0}}), metas.get('RevealSlide')), 'right');
});

t('规则：上段有 exitMotion → velocityPush + 同向；下段有 enterMotion → slide；都无 → crossfade', () => {
  // RevealSlide(right,right) → FeatureList：velocityPush dir=4
  const p1 = planMotionChain([mkSeg('RevealSlide'), mkSeg('FeatureList')], metas);
  assert.equal(p1[0].transition, 'velocityPush');
  assert.equal(p1[0].transitionDirection, 4);
  assert.ok(p1[0].changed);
  // StackCards(none) → FeatureList(up)：slide dir=1
  const p2 = planMotionChain([mkSeg('StackCards'), mkSeg('FeatureList')], metas);
  assert.equal(p2[0].transition, 'slide');
  assert.equal(p2[0].transitionDirection, 1);
  // 两侧无方向：crossfade 不动
  const p3 = planMotionChain([mkSeg('StackCards'), mkSeg('MinimalFloat')], metas);
  assert.equal(p3[0].transition, 'crossfade');
  assert.ok(!p3[0].changed);
});

t('下段支持 direction 参数且未显式设置时补齐飞入方向', () => {
  // RevealSlide → FeatureList（支持 direction）：nextSegmentDirection=4
  const p = planMotionChain([mkSeg('RevealSlide'), mkSeg('FeatureList')], metas);
  assert.equal(p[0].nextSegmentDirection, 4);
  // 显式设了 direction=2 则不补
  const p2 = planMotionChain([mkSeg('RevealSlide'), mkSeg('FeatureList', {customParams: {direction: 2}})], metas);
  assert.equal(p2[0].nextSegmentDirection, undefined);
});

t('显式非默认转场的边界不动', () => {
  const p = planMotionChain([mkSeg('RevealSlide', {transition: 'whip'}), mkSeg('FeatureList')], metas);
  assert.equal(p[0].changed, false);
  assert.equal(p[0].transition, 'whip');
});

t('applyMotionChain：转场/方向/飞入方向写入且不丢已有 transitionParams', () => {
  const segs = [
    {...mkSeg('RevealSlide'), transitionParams: {durationSec: 0.8}},
    mkSeg('FeatureList'),
  ];
  const patches = planMotionChain(segs, metas);
  const out = applyMotionChain(segs, patches);
  assert.equal(out[0].transition, 'velocityPush');
  assert.deepEqual(out[0].transitionParams, {durationSec: 0.8, direction: 4});
  assert.deepEqual(out[1].customParams, {direction: 4});
  // 原数组未被修改（纯函数）
  assert.equal(segs[0].transition, 'crossfade');
});

t('多段链：每个边界独立决策', () => {
  const segs = [mkSeg('RevealSlide'), mkSeg('FeatureList'), mkSeg('VerticalScroll'), mkSeg('StackCards')];
  const patches = planMotionChain(segs, metas);
  assert.equal(patches.length, 3);
  assert.equal(patches[0].transition, 'velocityPush');   // RevealSlide 右出
  assert.equal(patches[1].transition, 'slide');  // FeatureList 无出 → VerticalScroll 上入
  assert.equal(patches[1].transitionDirection, 1);
  assert.equal(patches[2].transition, 'velocityPush');   // VerticalScroll 上出
  assert.equal(patches[2].transitionDirection, 1);
});

t('转场样式：direction=4（向右）push 的出入场位移与旧版默认相反', () => {
  const defIn = transitionStyle('push', 'in', 0.3);
  const rightIn = transitionStyle('push', 'in', 0.3, {direction: 4});
  assert.notEqual(defIn.transform, rightIn.transform);
  // 向右 push：入场从左侧来（负 x 起步）
  assert.ok(rightIn.transform!.includes('translate(-'));
  // 未给 direction 保持旧版字符串（字符串级零回归）；direction=3 与旧版同向同幅、仅写法换成向量形式
  assert.ok(defIn.transform!.startsWith('translateX('));
  const legacy = transitionStyle('push', 'in', 0.3, {direction: 3});
  assert.ok(legacy.transform!.endsWith('%, 0%)'));
  const num = (s: string) => parseFloat(s.replace(/^[a-zA-Z]+\(/, ''));
  assert.equal(num(legacy.transform!), num(defIn.transform!));
});

t('转场样式：wipe 四向 clip-path 正确', () => {
  assert.equal(transitionStyle('wipe', 'in', 0.5, {direction: 4}).clipPath, 'inset(0 50% 0 0)');
  assert.equal(transitionStyle('wipe', 'in', 0.5, {direction: 3}).clipPath, 'inset(0 0 0 50%)');
  assert.equal(transitionStyle('wipe', 'in', 0.5, {direction: 2}).clipPath, 'inset(0 0 50% 0)');
  assert.equal(transitionStyle('wipe', 'in', 0.5, {direction: 1}).clipPath, 'inset(50% 0 0 0)');
});

t('注册表：8 个方向性模板有运动标注，其余为 none', () => {
  const withMotion = TEMPLATES.filter((x) => (x.enterMotion && x.enterMotion !== 'none') || (x.exitMotion && x.exitMotion !== 'none'));
  assert.equal(withMotion.length, 8);
  const ids = withMotion.map((x) => x.id).sort();
  assert.deepEqual(ids, ['CodeTerminal', 'FeatureList', 'LowerThird', 'PricingTiers', 'RevealSlide', 'TextSlide', 'TimelineRoadmap', 'VerticalScroll']);
});

// ====== 虚拟相机规则（T1）：两侧同向 → panChase ======

t('规则：两侧水平同向 → panChase（方向匹配，运动接运动）', () => {
  // RevealSlide 右进右出：RevealSlide → RevealSlide 边界两侧同向向右
  const p = planMotionChain([mkSeg('RevealSlide'), mkSeg('RevealSlide')], metas);
  assert.equal(p[0].transition, 'panChase');
  assert.equal(p[0].transitionDirection, 4);
  assert.ok(p[0].changed);
  assert.ok(p[0].reason.includes('panChase'));
});

t('规则：两侧竖直同向 → panChase 竖直（1上/2下）', () => {
  // VerticalScroll 上进上出：同向向上
  const p = planMotionChain([mkSeg('VerticalScroll'), mkSeg('VerticalScroll')], metas);
  assert.equal(p[0].transition, 'panChase');
  assert.equal(p[0].transitionDirection, 1);
});

t('规则：同向边界仍补下段 direction 飞入方向（运动不间断）', () => {
  // RevealSlide 支持 direction 参数且未显式设置 → 沿追拍方向补齐
  const p = planMotionChain([mkSeg('RevealSlide'), mkSeg('RevealSlide')], metas);
  assert.equal(p[0].transition, 'panChase');
  assert.equal(p[0].nextSegmentDirection, 4);
  // 下段显式设了 direction=3 则不补（尊重显式选择）
  const p2 = planMotionChain([mkSeg('RevealSlide'), mkSeg('RevealSlide', {customParams: {direction: 3}})], metas);
  assert.equal(p2[0].transition, 'velocityPush', '下段显式向左 → 方向冲突，回落 velocityPush（上段朝向优先）');
  assert.equal(p2[0].transitionDirection, 4);
  assert.equal(p2[0].nextSegmentDirection, undefined);
});

t('规则：方向冲突/一进一出无方向 → 保持现有 push/slide/crossfade', () => {
  // 上段右出、下段上入：方向冲突 → velocityPush（上段朝向优先）
  const p = planMotionChain([mkSeg('RevealSlide'), mkSeg('VerticalScroll')], metas);
  assert.equal(p[0].transition, 'velocityPush');
  assert.equal(p[0].transitionDirection, 4);
  // 上段无出、下段有入 → slide；都无 → crossfade（既有行为不变）
  const p2 = planMotionChain([mkSeg('StackCards'), mkSeg('FeatureList')], metas);
  assert.equal(p2[0].transition, 'slide');
  const p3 = planMotionChain([mkSeg('StackCards'), mkSeg('MinimalFloat')], metas);
  assert.equal(p3[0].transition, 'crossfade');
});

t('规则：显式转场边界不动（即使两侧同向）', () => {
  const p = planMotionChain([mkSeg('RevealSlide', {transition: 'whip'}), mkSeg('RevealSlide')], metas);
  assert.equal(p[0].changed, false);
  assert.equal(p[0].transition, 'whip');
});

t('applyMotionChain：panChase 边界写入转场与方向', () => {
  const segs = [mkSeg('RevealSlide'), mkSeg('RevealSlide')];
  const patches = planMotionChain(segs, metas);
  const out = applyMotionChain(segs, patches);
  assert.equal(out[0].transition, 'panChase');
  assert.deepEqual(out[0].transitionParams, {direction: 4});
  assert.deepEqual(out[1].customParams, {direction: 4});
});

t('转场样式：panChase direction 4 与 3 位移镜像（虚拟相机接入 transitionStyle）', () => {
  const left = transitionStyle('panChase', 'out', 0.3, {direction: 3});
  const right = transitionStyle('panChase', 'out', 0.3, {direction: 4});
  assert.notEqual(left.transform, right.transform);
  assert.ok(left.transform!.includes('translate3d(-'), '向左追拍出段左移');
  // 端点 identity（详细轨迹断言在 virtual-camera.test.ts）
  assert.equal(transitionStyle('panChase', 'in', 1, {direction: 4}).transform, 'perspective(900px) translateZ(0px)');
  assert.equal(transitionStyle('orbitSwipe', 'out', 0, {direction: 4}).transform, 'perspective(900px) translateZ(0px)');
});

console.log(`\n===== ${passed} 项全部通过 =====`);
