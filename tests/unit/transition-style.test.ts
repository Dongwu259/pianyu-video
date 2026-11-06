/**
 * 转场数学（shared/transition-style.ts）纯逻辑单元测试
 *
 * 运行方式：node tests/unit/transition-style.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块无运行时依赖）
 */

import assert from 'node:assert/strict';
import {
  getTransitionFrames,
  getOutroFadeFrames,
  getAutoFocus,
  resolveFocus,
  transitionStyle,
  clampTransitionSec,
  clampZoom,
  DEFAULT_TRANSITION_SEC,
  TRANSITION_DEFAULT_SEC,
  getTransitionDefaultSec,
  snapTransitionSecToBeats,
} from '../../src/shared/transition-style.ts';
import {DEFAULT_LAYOUT} from '../../src/shared/types.ts';
import {presetCurve} from '../../src/shared/easing-curve.ts';
import {occluderState, occluderCovered, occluderSwitched} from '../../src/shared/transition-occluder.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 从 transform 字符串中提取 scale/translateX 的数值 */
const numAfter = (fn: string, transform: string): number => {
  const m = transform.match(new RegExp(`${fn}\\((-?[\\d.]+)`));
  assert.ok(m, `应在「${transform}」中找到 ${fn}()`);
  return Number(m[1]);
};

// ====== 1. 重叠帧数计算 ======

console.log('getTransitionFrames 重叠帧数:');
{
  assert.equal(getTransitionFrames({transition: 'none'}, 30), 0, '硬切无重叠');
  ok('none（硬切）→ 0 帧');

  assert.equal(getTransitionFrames({transition: 'crossfade'}, 30), 15, '默认 0.5s');
  ok('无参数 → 默认 0.5s = 15 帧');

  assert.equal(getTransitionFrames({transition: 'zoomIn', transitionParams: {durationSec: 0.8}}, 30), 24);
  ok('自定义 0.8s → 24 帧');

  assert.equal(getTransitionFrames({transition: 'whip', transitionParams: {durationSec: 5}}, 30), 60, '超上限钳到 2s');
  assert.equal(getTransitionFrames({transition: 'whip', transitionParams: {durationSec: 0.01}}, 30), 6, '低下限钳到 0.2s');
  ok('时长钳制在 0.2-2s（60/6 帧）');

  assert.equal(getOutroFadeFrames(30), 15);
  ok('末段淡黑固定 0.5s = 15 帧');
}

// ====== 2. 运镜焦点 ======

console.log('焦点推导 resolveFocus/getAutoFocus:');
{
  assert.deepEqual(getAutoFocus(undefined), {x: 0.5, y: 0.5});
  ok('无 layout → 画面中心');

  const layout = {...DEFAULT_LAYOUT, videoOffsetX: 0.1, videoOffsetY: -0.2};
  assert.deepEqual(getAutoFocus(layout), {x: 0.6, y: 0.3});
  ok('由 layout 偏移推导画框中心');

  assert.deepEqual(getAutoFocus({...DEFAULT_LAYOUT, videoOffsetX: 0.6}), {x: 1, y: 0.5}, '越界钳到 1');
  ok('极端偏移钳制在 0-1');

  // 显式参数优先；只给 X 时 Y 回落自动
  assert.deepEqual(resolveFocus({focusX: 0.2, focusY: 0.8}, layout), {x: 0.2, y: 0.8});
  ok('显式焦点优先于自动推导');
  assert.deepEqual(resolveFocus({focusX: 0.2}, layout), {x: 0.2, y: 0.3});
  ok('只给 X 时 Y 回落画框中心');
  assert.deepEqual(resolveFocus(undefined, layout), {x: 0.6, y: 0.3});
  ok('无参数时全自动');
}

// ====== 3. zoomIn（镜头推进）连续性 ======

console.log('zoomIn 运镜样式:');
{
  const focus = {x: 0.25, y: 0.75};
  const zoom = 2;

  const in0 = transitionStyle('zoomIn', 'in', 0, {focus, zoom});
  assert.equal(in0.transform, 'scale(2)', '入场起点 = 推进倍率');
  assert.equal(in0.opacity, 0);
  assert.equal(in0.transformOrigin, '25% 75%');
  assert.equal(in0.filter, 'blur(4px)');
  ok('入场 q=0：scale=zoom、透明、transformOrigin=焦点、模糊 4px');

  const in1 = transitionStyle('zoomIn', 'in', 1, {focus, zoom});
  assert.equal(in1.transform, 'scale(1)');
  assert.equal(in1.opacity, 1);
  assert.equal(in1.filter, 'blur(0px)');
  ok('入场 q=1：落定到 scale=1、全显、无模糊');

  const out0 = transitionStyle('zoomIn', 'out', 0, {focus, zoom});
  assert.equal(out0.transform, 'scale(1)');
  assert.equal(out0.opacity, 1);
  const out1 = transitionStyle('zoomIn', 'out', 1, {focus, zoom});
  assert.equal(out1.transform, 'scale(2)');
  assert.equal(out1.opacity, 0);
  assert.equal(out1.transformOrigin, '25% 75%');
  ok('出场 q=0→1：scale 1→zoom、淡出、同焦点');

  // 中点无缝：q=0.5 时两侧 scale 相等（easeInOutCubic(0.5)=0.5 → 1.5）
  const inMid = transitionStyle('zoomIn', 'in', 0.5, {focus, zoom});
  const outMid = transitionStyle('zoomIn', 'out', 0.5, {focus, zoom});
  assert.equal(numAfter('scale', inMid.transform!), numAfter('scale', outMid.transform!), '中点两侧 scale 必须相等');
  ok('中点两侧 scale 相等（1.5），变焦衔接无缝');

  // 无焦点参数时回落画面中心
  const noFocus = transitionStyle('zoomIn', 'in', 0.5);
  assert.equal(noFocus.transformOrigin, '50% 50%');
  ok('缺省焦点 → transformOrigin 为画面中心');
}

// ====== 4. zoomOut（镜头拉远）与 whip（甩镜） ======

console.log('zoomOut / whip 样式:');
{
  const in0 = transitionStyle('zoomOut', 'in', 0, {zoom: 2});
  assert.equal(in0.transform, 'scale(1.4)', '拉远入场起点 = 1+(2-1)*0.4');
  const in1 = transitionStyle('zoomOut', 'in', 1, {zoom: 2});
  assert.equal(in1.transform, 'scale(1)');
  ok('zoomOut 入场：1.4 → 1（拉远落定）');

  const out1 = transitionStyle('zoomOut', 'out', 1, {zoom: 2});
  assert.equal(out1.filter, 'blur(8px)');
  assert.equal(out1.opacity, 0);
  ok('zoomOut 出场：重模糊淡出（后退感）');

  const wIn0 = transitionStyle('whip', 'in', 0);
  assert.equal(wIn0.transform, 'translateX(100%)');
  assert.equal(wIn0.filter, undefined, '起点无滤镜（拖影通道走 motionBlur）');
  const wMid = transitionStyle('whip', 'in', 0.5);
  assert.equal(numAfter('translateX', wMid.transform!), 50);
  assert.ok(wMid.motionBlur && Math.abs(wMid.motionBlur.x - 24) < 1e-9 && wMid.motionBlur.y === 0, '中点横向拖影达峰 24px');
  const wOut1 = transitionStyle('whip', 'out', 1);
  assert.equal(wOut1.transform, 'translateX(-100%)');
  ok('whip：双片同向横移，方向性拖影在中点达峰遮接缝，无透明度变化');
  assert.equal(wIn0.opacity, undefined);
  assert.equal(wOut1.opacity, undefined);
  ok('whip 不设置 opacity（靠拖影而非淡入淡出）');
}

// ====== 4b. flyThrough（3D 穿越） ======

console.log('flyThrough 样式:');
{
  const in0 = transitionStyle('flyThrough', 'in', 0);
  assert.equal(in0.transform, 'perspective(900px) translateZ(-600px)', '入场起点在纵深 -600px');
  assert.equal(in0.opacity, 0);
  const in1 = transitionStyle('flyThrough', 'in', 1);
  assert.equal(in1.transform, 'perspective(900px) translateZ(0px)', '入场终点落定');
  assert.equal(in1.filter, 'blur(0px)');
  ok('flyThrough 入场：纵深飞来 + blur 收拢');

  const out0 = transitionStyle('flyThrough', 'out', 0);
  assert.equal(out0.transform, 'perspective(900px) translateZ(0px)');
  const out1 = transitionStyle('flyThrough', 'out', 1);
  assert.equal(out1.transform, 'perspective(900px) translateZ(420px)', '出场扎进冲过镜头');
  assert.equal(out1.opacity, 0, '出场终点完全淡出');
  assert.equal(out1.filter, 'brightness(1.7)', '出场终点曝光提亮');
  ok('flyThrough 出场：冲过镜头 + 提亮加速淡出');

  // 曲线路径同语义（mechanicalStyle 分支）
  const curved = transitionStyle('flyThrough', 'out', 1, {curve: presetCurve('easeInOut')});
  assert.equal(curved.transform, 'perspective(900px) translateZ(420px)');
  ok('curve 路径的 flyThrough 同样生效');
}

// ====== 5. 钳制与既有类型回归 ======

console.log('钳制与既有类型回归:');
{
  assert.equal(clampTransitionSec(0.05), 0.2);
  assert.equal(clampTransitionSec(9), 2);
  assert.equal(clampZoom(1), 1.2);
  assert.equal(clampZoom(10), 6.5); // T3 起上限放宽到 6.5（锚点 cover 拟合；手动参数仍由校验器/UI 钳 1.2-4）
  assert.equal(DEFAULT_TRANSITION_SEC, 0.5);
  ok('时长/倍率钳制边界正确');

  assert.deepEqual(transitionStyle('crossfade', 'in', 0.3), {opacity: 0.3});
  assert.deepEqual(transitionStyle('crossfade', 'out', 0.3), {opacity: 0.7});
  ok('crossfade 行为不变');

  const slide = transitionStyle('slide', 'in', 0);
  assert.ok(slide.transform?.startsWith('translateX('));
  assert.deepEqual(transitionStyle('slide', 'out', 0.5), {}, 'slide 前段不动');
  ok('slide 行为不变');

  assert.deepEqual(transitionStyle('none', 'in', 0.5), {});
  assert.deepEqual(transitionStyle('flash', 'out', 0.5), {});
  ok('none/flash 返回空样式');
}

// ====== 6. 缓动曲线（curve）路径 ======

console.log('缓动曲线（curve）路径:');
{
  // 无曲线：crossfade in @ q=0.5 -> opacity 0.5（线性）
  assert.equal(transitionStyle('crossfade', 'in', 0.5).opacity, 0.5);
  // 有曲线 easeIn：@0.5 进度 < 0.5 -> opacity < 0.5
  const withIn = transitionStyle('crossfade', 'in', 0.5, {curve: presetCurve('easeIn')});
  assert.ok((withIn.opacity as number) < 0.5, `easeIn@0.5 opacity=${withIn.opacity}`);
  // easeOut：@0.5 > 0.5
  const withOut = transitionStyle('crossfade', 'in', 0.5, {curve: presetCurve('easeOut')});
  assert.ok((withOut.opacity as number) > 0.5, `easeOut@0.5 opacity=${withOut.opacity}`);
  ok('curve 设置后用曲线缓动 q（easeIn<0.5 / easeOut>0.5）');
}
{
  // 曲线不改变端点值
  const c = presetCurve('bounce');
  assert.equal(transitionStyle('crossfade', 'in', 0, {curve: c}).opacity, 0);
  assert.equal(transitionStyle('crossfade', 'in', 1, {curve: c}).opacity, 1);
  ok('curve 端点 q=0->0 / q=1->1 不变');
}
{
  // 无曲线时 zoomIn 中点两侧仍相等（回归：curve 不影响默认路径）
  const inMid = transitionStyle('zoomIn', 'in', 0.5, {focus: {x: 0.5, y: 0.5}, zoom: 2});
  const outMid = transitionStyle('zoomIn', 'out', 0.5, {focus: {x: 0.5, y: 0.5}, zoom: 2});
  assert.equal(numAfter('scale', inMid.transform!), numAfter('scale', outMid.transform!));
  ok('无曲线时 zoomIn 中点衔接不变（curve 不影响默认路径）');
}

// ====== 6. P1 批次：方向性运动模糊 + 类型默认时长 + 半拍吸附 ======

console.log('P1：方向拖影 / 默认时长表 / 半拍吸附:');
{
  // push/slide：轻量横向拖影，in/out 对称（push）
  const pushIn = transitionStyle('push', 'in', 0.5)!;
  const pushOut = transitionStyle('push', 'out', 0.5)!;
  assert.ok(pushIn.motionBlur && pushIn.motionBlur.x > 5 && pushOut.motionBlur && pushOut.motionBlur.x > 5, 'push 双侧拖影 >5px');
  assert.equal(pushIn.motionBlur!.y, 0);
  const slideIn = transitionStyle('slide', 'in', 0.5)!;
  assert.ok(slideIn.motionBlur && slideIn.motionBlur.x > 3, 'slide 入场侧拖影');
  assert.deepEqual(transitionStyle('slide', 'out', 0.5), {}, 'slide 出场侧仍为空（前段不动）');
  ok('push/slide 拖影量与方向');

  // 曲线路径（mechanicalStyle）同样产出 motionBlur
  const curved = transitionStyle('whip', 'in', 0.5, {curve: presetCurve('easeInOut')});
  assert.ok(curved.motionBlur && curved.motionBlur.x > 15, '曲线路径 whip 拖影同样生效');
  ok('curve 路径的 whip 拖影');
}

{
  // 类型默认时长表：快切类短、运镜类长、none 为 0
  assert.equal(TRANSITION_DEFAULT_SEC.none, 0, 'none 默认 0');
  assert.ok(TRANSITION_DEFAULT_SEC.whip <= 0.35 && TRANSITION_DEFAULT_SEC.flash <= 0.3, 'whip/flash 缺省落在快切规格（≤0.35s）');
  assert.equal(TRANSITION_DEFAULT_SEC.crossfade, 0.5, 'crossfade 缺省 0.5s');
  assert.equal(getTransitionDefaultSec('push'), TRANSITION_DEFAULT_SEC.push, '查表函数一致');
  // getTransitionFrames 缺省按类型查表（不再一律 0.5s）
  const whipFrames = getTransitionFrames({transition: 'whip', transitionParams: undefined}, 30);
  assert.equal(whipFrames, Math.round(TRANSITION_DEFAULT_SEC.whip * 30), 'whip 缺省帧数按表');
  ok('转场类型默认时长表');
}

{
  // 半拍吸附：120BPM（拍 0.5s → 半拍 0.25s 网格）
  assert.equal(snapTransitionSecToBeats(0.35, 0.5), 0.25, '0.35 → 最近半拍 0.25');
  assert.equal(snapTransitionSecToBeats(0.47, 0.5), 0.5, '0.47 → 0.5');
  assert.equal(snapTransitionSecToBeats(1.9, 0.5), 2, '1.9 → 钳制上界 2');
  assert.equal(snapTransitionSecToBeats(0.15, 0.5), 0.25, '低于下限钳到 0.2 后向上吸到最近半拍 0.25');
  assert.equal(snapTransitionSecToBeats(0.5, 0), 0.5, '无节拍原样返回');
  ok('转场时长半拍吸附');
}

// ====== 7. 虚拟相机转场族（panChase/orbitSwipe）与 flyThrough direction ======

console.log('虚拟相机转场族（transition-style 集成面）:');
{
  // 类型默认时长表补新类型（运镜类稍长：镜头需要加速距离）
  assert.equal(TRANSITION_DEFAULT_SEC.panChase, 0.6);
  assert.equal(TRANSITION_DEFAULT_SEC.orbitSwipe, 0.8);
  assert.equal(getTransitionFrames({transition: 'panChase'}, 30), 18);
  assert.equal(getTransitionFrames({transition: 'orbitSwipe'}, 30), 24);
  ok('panChase 0.6s / orbitSwipe 0.8s 默认时长');

  // 端点 identity（详细轨迹数学见 tests/unit/virtual-camera.test.ts）
  assert.equal(transitionStyle('panChase', 'out', 0).transform, 'perspective(900px) translateZ(0px)');
  assert.equal(transitionStyle('panChase', 'in', 1).transform, 'perspective(900px) translateZ(0px)');
  assert.equal(transitionStyle('orbitSwipe', 'out', 0).transform, 'perspective(900px) translateZ(0px)');
  assert.equal(transitionStyle('orbitSwipe', 'in', 1).transform, 'perspective(900px) translateZ(0px)');
  ok('新类型端点 identity（转场结束画面不跳）');

  // 拖影通道随相机速度输出（中段达峰）
  const chaseMid = transitionStyle('panChase', 'out', 0.5, {direction: 4});
  assert.ok(chaseMid.motionBlur && chaseMid.motionBlur.x > 10 && chaseMid.motionBlur.y === 0);
  const orbitMid = transitionStyle('orbitSwipe', 'in', 0.5, {direction: 3});
  assert.ok(orbitMid.motionBlur && orbitMid.motionBlur.x > 10);
  assert.equal(orbitMid.filter, 'brightness(0.65)', 'orbitSwipe 中段压暗');
  ok('panChase/orbitSwipe motionBlur 与中段压暗');
}

console.log('flyThrough direction=2（拉远飞出）:');
{
  // 默认（缺省 / direction=1）逐像素不变——字符串级回归
  const defOut1 = transitionStyle('flyThrough', 'out', 1);
  assert.equal(defOut1.transform, 'perspective(900px) translateZ(420px)');
  const dir1Out1 = transitionStyle('flyThrough', 'out', 1, {direction: 1});
  assert.equal(dir1Out1.transform, defOut1.transform, 'direction=1 与缺省逐字一致');
  assert.equal(dir1Out1.filter, defOut1.filter);
  const dir1In0 = transitionStyle('flyThrough', 'in', 0, {direction: 1});
  assert.equal(dir1In0.transform, 'perspective(900px) translateZ(-600px)');
  ok('direction 缺省/=1 行为逐像素冻结');

  // direction=2：出段负向远去缩小变暗，入段从放大近景回落
  const out1 = transitionStyle('flyThrough', 'out', 1, {direction: 2});
  assert.equal(out1.transform, 'perspective(900px) translateZ(-640px)', '出段向纵深远去');
  assert.equal(out1.filter, 'brightness(0.55)', '远去压暗');
  assert.equal(out1.opacity, 0);
  const out0 = transitionStyle('flyThrough', 'out', 0, {direction: 2});
  assert.equal(out0.transform, 'perspective(900px) translateZ(0px)', '出段起点 identity');
  const in0 = transitionStyle('flyThrough', 'in', 0, {direction: 2});
  assert.equal(in0.transform, 'perspective(900px) translateZ(480px)', '入段从放大近景起');
  assert.equal(in0.opacity, 0);
  const in1 = transitionStyle('flyThrough', 'in', 1, {direction: 2});
  assert.equal(in1.transform, 'perspective(900px) translateZ(0px)', '入段终点 identity');
  assert.equal(in1.filter, 'blur(0px)');
  ok('direction=2 拉远飞出：出段远去、入段回落、端点归零');

  // 曲线路径同语义
  const curved = transitionStyle('flyThrough', 'out', 1, {direction: 2, curve: presetCurve('easeInOut')});
  assert.equal(curved.transform, 'perspective(900px) translateZ(-640px)');
  ok('curve 路径的 direction=2 同样生效');
}

// ====== 8. T2 遮挡物转场（cardSweep/shapeBloom）======

console.log('遮挡物转场（可见性时序 + 覆盖度切换）:');
{
  // 类型默认时长表补新类型
  assert.equal(TRANSITION_DEFAULT_SEC.cardSweep, 0.7);
  assert.equal(TRANSITION_DEFAULT_SEC.shapeBloom, 0.8);
  assert.equal(getTransitionFrames({transition: 'cardSweep'}, 30), 21);
  assert.equal(getTransitionFrames({transition: 'shapeBloom'}, 30), 24);
  ok('cardSweep 0.7s / shapeBloom 0.8s 默认时长');

  // 可见性锁存：未盖满时出段可见入段隐；首次盖满后入段就位出段隐（扫出/收拢不再切回）
  const inEarly = transitionStyle('cardSweep', 'in', 0.05);
  const outEarly = transitionStyle('cardSweep', 'out', 0.05);
  assert.equal(inEarly.opacity, 0, 'q=0.05 入段隐藏');
  assert.deepEqual(outEarly, {}, 'q=0.05 出段原样可见');
  const inCover = transitionStyle('cardSweep', 'in', 0.5);
  const outCover = transitionStyle('cardSweep', 'out', 0.5);
  assert.deepEqual(inCover, {}, 'q=0.5 盖满帧入段就位');
  assert.equal(outCover.opacity, 0, 'q=0.5 盖满帧出段隐藏');
  const inLate = transitionStyle('cardSweep', 'in', 0.85);
  const outLate = transitionStyle('cardSweep', 'out', 0.85);
  assert.deepEqual(inLate, {}, 'q=0.85（卡已扫出）入段保持就位');
  assert.equal(outLate.opacity, 0, 'q=0.85 出段保持隐藏（锁存不切回）');
  assert.ok(!occluderCovered('cardSweep', 0.85), 'q=0.85 卡片已不盖满（锁存与瞬时覆盖区分）');
  ok('cardSweep：q<cover 出段可见入段隐 / 首次盖满后入段就位出段隐（锁存）');

  const bInEarly = transitionStyle('shapeBloom', 'in', 0.2, {focus: {x: 0.7, y: 0.4}});
  const bOutEarly = transitionStyle('shapeBloom', 'out', 0.2, {focus: {x: 0.7, y: 0.4}});
  assert.equal(bInEarly.opacity, 0, 'shapeBloom q=0.2 入段仍隐');
  assert.deepEqual(bOutEarly, {}, 'shapeBloom q=0.2 出段可见');
  const bInCover = transitionStyle('shapeBloom', 'in', 0.5, {focus: {x: 0.7, y: 0.4}});
  const bOutCover = transitionStyle('shapeBloom', 'out', 0.5, {focus: {x: 0.7, y: 0.4}});
  assert.deepEqual(bInCover, {}, 'shapeBloom q=0.5 盖满帧入段就位');
  assert.equal(bOutCover.opacity, 0, 'shapeBloom q=0.5 出段隐藏');
  const bInLate = transitionStyle('shapeBloom', 'in', 0.75, {focus: {x: 0.7, y: 0.4}});
  const bOutLate = transitionStyle('shapeBloom', 'out', 0.75, {focus: {x: 0.7, y: 0.4}});
  assert.deepEqual(bInLate, {}, 'shapeBloom q=0.75（收拢中后段显露）入段就位');
  assert.equal(bOutLate.opacity, 0, 'shapeBloom q=0.75 出段保持隐藏（锁存）');
  ok('shapeBloom：同锁存时序（含焦点参数）');

  // 可见性与锁存严格同源：任意 q 都与 occluderSwitched 一致（奇数帧网格不裸切）
  for (const q of [0, 0.11, 0.23, 0.42, 0.48, 0.5, 0.55, 0.63, 0.79, 0.9, 1]) {
    for (const type of ['cardSweep', 'shapeBloom'] as const) {
      const sw = occluderSwitched(type, q, {direction: 3, focus: {x: 0.5, y: 0.5}});
      const inS = transitionStyle(type, 'in', q, {direction: 3, focus: {x: 0.5, y: 0.5}});
      const outS = transitionStyle(type, 'out', q, {direction: 3, focus: {x: 0.5, y: 0.5}});
      assert.equal(inS.opacity ?? 1, sw ? 1 : 0, `${type} in @q=${q} 应与锁存一致`);
      assert.equal(outS.opacity ?? 1, sw ? 0 : 1, `${type} out @q=${q} 应与锁存一致`);
    }
  }
  ok('in/out 可见性与 occluderSwitched 逐点一致');

  // 曲线路径同语义（mechanicalStyle 分支）
  const cOut = transitionStyle('cardSweep', 'out', 0.5, {curve: presetCurve('easeInOut')});
  assert.equal(cOut.opacity, 0, '曲线路径 cover 帧出段同样隐藏');
  const cIn = transitionStyle('shapeBloom', 'in', 0.5, {curve: presetCurve('easeInOut'), focus: {x: 0.7, y: 0.4}});
  assert.deepEqual(cIn, {}, '曲线路径 cover 帧入段同样就位');
  ok('curve 路径的可见性切换同样生效');
}

console.log('遮挡物几何端点（occluderState）:');
{
  // cardSweep：q=0 无形（完全离屏）/ q=0.5 盖满 / q=1 无形
  const s0 = occluderState('cardSweep', 0);
  assert.ok(s0.kind === 'cardSweep');
  if (s0.kind === 'cardSweep') {
    assert.ok(Math.abs(s0.card.x) > 1 && s0.card.cover < 1, 'q=0 卡片完全离屏');
  }
  const sMid = occluderState('cardSweep', 0.5);
  assert.ok(sMid.kind === 'cardSweep' && sMid.card.cover >= 1, 'q=0.5 盖满');
  if (sMid.kind === 'cardSweep') {
    assert.equal(sMid.card.x, 0, '盖满帧卡片居中');
    assert.equal(sMid.card.rotateDeg, 0, '盖满帧无倾斜');
  }
  const s1 = occluderState('cardSweep', 1);
  assert.ok(s1.kind === 'cardSweep');
  if (s1.kind === 'cardSweep') {
    assert.ok(Math.abs(s1.card.x) > 1 && s1.card.cover < 1, 'q=1 卡片完全离屏');
  }

  // direction 镜像：缺省=3（向左扫，卡从右侧扫入）；3↔4 水平镜像、1↔2 垂直镜像
  const d3 = occluderState('cardSweep', 0.25, {direction: 3});
  const d4 = occluderState('cardSweep', 0.25, {direction: 4});
  if (d3.kind === 'cardSweep' && d4.kind === 'cardSweep') {
    assert.ok(Math.abs(d3.card.x + d4.card.x) < 1e-9 && d3.card.y === 0 && d4.card.y === 0, 'direction 3/4 水平镜像');
    assert.ok(d3.card.x > 0, '向左扫（缺省）：入场时卡片在右侧');
  }
  const dDef = occluderState('cardSweep', 0.25);
  if (dDef.kind === 'cardSweep' && d3.kind === 'cardSweep') {
    assert.equal(dDef.card.x, d3.card.x, '缺省 direction = 3');
  }
  const d1 = occluderState('cardSweep', 0.25, {direction: 1});
  const d2 = occluderState('cardSweep', 0.25, {direction: 2});
  if (d1.kind === 'cardSweep' && d2.kind === 'cardSweep') {
    assert.ok(Math.abs(d1.card.y + d2.card.y) < 1e-9 && d1.card.x === 0 && d2.card.x === 0, 'direction 1/2 垂直镜像');
  }

  // shapeBloom：q=0 无形 / q=0.5 盖满 / q=1 无形；圆心 = 焦点
  const b0 = occluderState('shapeBloom', 0, {focus: {x: 0.7, y: 0.4}});
  assert.ok(b0.kind === 'shapeBloom');
  if (b0.kind === 'shapeBloom') {
    assert.equal(b0.bloom.radiusPct, 0, 'q=0 无形');
    assert.ok(b0.bloom.cover < 1);
  }
  const bMid = occluderState('shapeBloom', 0.5, {focus: {x: 0.7, y: 0.4}});
  assert.ok(bMid.kind === 'shapeBloom');
  if (bMid.kind === 'shapeBloom') {
    assert.ok(bMid.bloom.cover >= 1, 'q=0.5 盖满');
    assert.equal(bMid.bloom.cx, 0.7, '圆心 x = 焦点');
    assert.equal(bMid.bloom.cy, 0.4, '圆心 y = 焦点');
  }
  const b1 = occluderState('shapeBloom', 1, {focus: {x: 0.7, y: 0.4}});
  assert.ok(b1.kind === 'shapeBloom');
  if (b1.kind === 'shapeBloom') {
    assert.ok(b1.bloom.radiusPct < 1e-9, 'q=1 无形');
  }
  const bDef = occluderState('shapeBloom', 0.5);
  if (bDef.kind === 'shapeBloom') {
    assert.deepEqual({x: bDef.bloom.cx, y: bDef.bloom.cy}, {x: 0.5, y: 0.5}, '缺省焦点 = 画面中心');
  }
  ok('几何端点：q=0 无形 / q=0.5 盖满 / q=1 无形 + direction 镜像 + 焦点圆心');
}

console.log(`\n全部通过（${passed} 组断言）`);
