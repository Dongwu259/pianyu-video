/**
 * 虚拟相机连续运镜（shared/virtual-camera.ts）单元测试
 *
 * 覆盖：端点 identity（转场结束画面不跳）、位移单调性、方向镜像对称、
 * orbitSwipe 中点遮挡时刻（两段大幅侧对 + 压暗 + 拖影）、panChase 速度连续性
 * （出入段共享同一相机 ⇒ 导数处处相等）、curve 通道（曲线输出作替换缓动）。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/virtual-camera.test.ts
 */

import assert from 'node:assert/strict';
import {
  CAMERA_IDENTITY_TRANSFORM,
  cameraTrajectory,
  cameraPlanePose,
  cameraWrapperTransform,
  virtualCameraDirVec,
  virtualCameraStyle,
  isVirtualCameraTransition,
  IDENTITY_CAMERA_POSE,
  PAN_CHASE_TRAVEL,
  ORBIT_SWIPE_TRAVEL,
  ORBIT_SWIPE_SWING_DEG,
  ORBIT_SWIPE_DARKEN,
  type VirtualCameraTransition,
} from '../../src/shared/virtual-camera.ts';
import {transitionStyle} from '../../src/shared/transition-style.ts';
import {presetCurve} from '../../src/shared/easing-curve.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const TYPES: VirtualCameraTransition[] = ['panChase', 'orbitSwipe'];

/** 从 transform 字符串提取 translate3d 的 x/y/z（x/y 为 %，z 为 px）；无 translate3d 时全 0 */
const translateOf = (transform: string): {x: number; y: number; z: number} => {
  const m = transform.match(/translate3d\((-?[\d.]+)%, (-?[\d.]+)%, (-?[\d.]+)px\)/);
  if (!m) return {x: 0, y: 0, z: 0};
  return {x: Number(m[1]), y: Number(m[2]), z: Number(m[3])};
};

/** 从 transform 字符串提取某旋转函数的角度（缺省 0） */
const rotateOf = (fn: 'rotateX' | 'rotateY' | 'rotateZ', transform: string): number => {
  const m = transform.match(new RegExp(`${fn}\\((-?[\\d.]+)deg\\)`));
  return m ? Number(m[1]) : 0;
};

// ====== 1. 方向向量与类型守卫 ======

console.log('方向向量 / 类型守卫:');
{
  assert.deepEqual(virtualCameraDirVec(undefined), {x: -1, y: 0}, '缺省 = 向左（3）');
  assert.deepEqual(virtualCameraDirVec(3), {x: -1, y: 0});
  assert.deepEqual(virtualCameraDirVec(4), {x: 1, y: 0});
  assert.deepEqual(virtualCameraDirVec(1), {x: 0, y: -1});
  assert.deepEqual(virtualCameraDirVec(2), {x: 0, y: 1});
  assert.deepEqual(virtualCameraDirVec(0), {x: -1, y: 0}, '非法档位回退向左');
  ok('direction 档位 → 单位向量（缺省/非法 = 向左）');

  assert.ok(isVirtualCameraTransition('panChase') && isVirtualCameraTransition('orbitSwipe'));
  assert.ok(!isVirtualCameraTransition('flyThrough') && !isVirtualCameraTransition('push'));
  ok('isVirtualCameraTransition 只认 panChase/orbitSwipe（flyThrough 走手写分支）');
}

// ====== 2. 端点 identity：q=0 出段、q=1 入段严格归零 ======

console.log('端点 identity（转场结束画面不跳）:');
{
  for (const type of TYPES) {
    for (const direction of [undefined, 1, 2, 3, 4]) {
      const out0 = virtualCameraStyle(type, 'out', 0, {direction});
      assert.equal(out0.transform, CAMERA_IDENTITY_TRANSFORM, `${type} out q=0 dir=${direction} 应严格 identity`);
      const in1 = virtualCameraStyle(type, 'in', 1, {direction});
      assert.equal(in1.transform, CAMERA_IDENTITY_TRANSFORM, `${type} in q=1 dir=${direction} 应严格 identity`);
    }
  }
  ok('两类型 × 全方向：out(q=0) / in(q=1) 均为 perspective(900px) translateZ(0px)');

  // 端点无旋转/无位移（数值上等价 identity）：解析验证而非仅字符串
  for (const type of TYPES) {
    const t0 = translateOf(virtualCameraStyle(type, 'out', 0, {direction: 4}).transform);
    assert.deepEqual(t0, {x: 0, y: 0, z: 0});
    const t1 = translateOf(virtualCameraStyle(type, 'in', 1, {direction: 4}).transform);
    assert.deepEqual(t1, {x: 0, y: 0, z: 0});
  }
  ok('端点位移分量逐项为 0');

  // 入段平面 = 相机轨迹终点（世界位姿约定）
  for (const type of TYPES) {
    const end = cameraTrajectory(type, 1, {direction: 3});
    const plane = cameraPlanePose(type, {direction: 3});
    assert.ok(Math.abs(end.x - plane.x) < 1e-9 && Math.abs(end.y - plane.y) < 1e-9 && Math.abs(end.z - plane.z) < 1e-9,
      `${type} 相机终点位置应等于入段平面位置`);
  }
  ok('入段平面停在相机轨迹终点（旋转鼓包在 q=1 归零，只剩平移）');

  // 相机起点 = identity
  for (const type of TYPES) {
    assert.deepEqual(cameraTrajectory(type, 0, {direction: 4}), IDENTITY_CAMERA_POSE, `${type} C(0) 应为 identity`);
  }
  ok('相机轨迹起点 C(0) = identity');
}

// ====== 3. 单调性：位移随 q 单调 ======

console.log('位移单调性:');
{
  const samples = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  for (const type of TYPES) {
    // direction=3（向左）：出段 x 单调减（0 → −行程），入段 x 单调减（+行程 → 0）
    const outXs = samples.map((q) => translateOf(virtualCameraStyle(type, 'out', q, {direction: 3}).transform).x);
    const inXs = samples.map((q) => translateOf(virtualCameraStyle(type, 'in', q, {direction: 3}).transform).x);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(outXs[i] < outXs[i - 1], `${type} out x 应单调减（${outXs[i - 1]} → ${outXs[i]}）`);
      assert.ok(inXs[i] < inXs[i - 1], `${type} in x 应单调减（${inXs[i - 1]} → ${inXs[i]}）`);
    }
    assert.ok(outXs[samples.length - 1] <= -PAN_CHASE_TRAVEL * 100 + 1e-9, `${type} 出段终点完全移出左缘`);
    assert.ok(inXs[0] >= PAN_CHASE_TRAVEL * 100 - 1e-9, `${type} 入段起点完全在右缘之外`);
  }
  ok('两类型：出段单调移出、入段单调移入，行程 ≥ 一屏');

  // orbitSwipe 中段后拉：z 鼓包在 [0,1] 上先升后降、端点为 0
  const zs = samples.map((q) => cameraTrajectory('orbitSwipe', q, {direction: 3}).z);
  assert.equal(zs[0], 0);
  assert.ok(zs[1] < zs[0] && zs[3] < zs[1], '中段后拉加深');
  assert.ok(zs[5] > zs[3] && Math.abs(zs[6]) < 1e-9, '后段回拉归零');
  ok('orbitSwipe 相机 z 鼓包：0 → 谷底 → 0');
}

// ====== 4. 方向镜像：direction 3 vs 4 位移符号相反 ======

console.log('方向镜像对称:');
{
  for (const type of TYPES) {
    for (const q of [0.2, 0.5, 0.8]) {
      const l = translateOf(virtualCameraStyle(type, 'out', q, {direction: 3}).transform);
      const r = translateOf(virtualCameraStyle(type, 'out', q, {direction: 4}).transform);
      assert.ok(Math.abs(l.x + r.x) < 1e-9 && l.x !== 0, `${type} out q=${q} 左右镜像`);
      const li = translateOf(virtualCameraStyle(type, 'in', q, {direction: 3}).transform);
      const ri = translateOf(virtualCameraStyle(type, 'in', q, {direction: 4}).transform);
      assert.ok(Math.abs(li.x + ri.x) < 1e-9 && li.x !== 0, `${type} in q=${q} 左右镜像`);
      // 竖直方向同理
      const u = translateOf(virtualCameraStyle(type, 'out', q, {direction: 1}).transform);
      const d = translateOf(virtualCameraStyle(type, 'out', q, {direction: 2}).transform);
      assert.ok(Math.abs(u.y + d.y) < 1e-9 && u.y !== 0, `${type} out q=${q} 上下镜像`);
    }
  }
  ok('direction 3↔4、1↔2 位移符号相反、幅度相等');

  // 水平方向用 rotateY、竖直方向用 rotateX（摆头轴正确）
  const h = virtualCameraStyle('orbitSwipe', 'out', 0.5, {direction: 3}).transform;
  assert.ok(rotateOf('rotateY', h) !== 0 && rotateOf('rotateX', h) === 0, '水平环绕绕 Y 轴');
  const vv = virtualCameraStyle('orbitSwipe', 'out', 0.5, {direction: 1}).transform;
  assert.ok(rotateOf('rotateX', vv) !== 0 && rotateOf('rotateY', vv) === 0, '竖直环绕绕 X 轴');
  ok('摆头轴随方向选择（水平 rotateY / 竖直 rotateX）');
}

// ====== 5. orbitSwipe 遮挡时刻：q=0.5 两段大幅侧对 + 压暗 + 拖影 ======

console.log('orbitSwipe 遮挡时刻（q≈0.5）:');
{
  const outMid = virtualCameraStyle('orbitSwipe', 'out', 0.5, {direction: 3});
  const inMid = virtualCameraStyle('orbitSwipe', 'in', 0.5, {direction: 3});
  assert.ok(Math.abs(rotateOf('rotateY', outMid.transform)) >= 30, `出段中段侧对角 ${rotateOf('rotateY', outMid.transform)}°`);
  assert.ok(Math.abs(rotateOf('rotateY', inMid.transform)) >= 30, `入段中段侧对角 ${rotateOf('rotateY', inMid.transform)}°`);
  ok('q=0.5 两段都 ≥30° 侧对相机（画面边缘甩出=遮挡）');

  // 摆角峰值 = ORBIT_SWIPE_SWING_DEG（相机 +Θ ⇒ wrapper −Θ）
  assert.ok(Math.abs(Math.abs(rotateOf('rotateY', outMid.transform)) - ORBIT_SWIPE_SWING_DEG) < 1e-9);
  ok('中段摆角 = 设计峰值 42°');

  // 压暗：两段 filter 都为 brightness(1 − 0.35)，端点为 brightness(1)
  assert.equal(outMid.filter, `brightness(${1 - ORBIT_SWIPE_DARKEN})`);
  assert.equal(inMid.filter, `brightness(${1 - ORBIT_SWIPE_DARKEN})`);
  assert.equal(virtualCameraStyle('orbitSwipe', 'out', 0, {direction: 3}).filter, 'brightness(1)');
  ok('中段 brightness 压暗 0.65，端点不压暗');

  // 拖影：水平环绕只糊 x，中点达峰、端点归零（数值通道保留 sin(π) 浮点尾，渲染端按 >0.05 门限激活）
  assert.ok(outMid.motionBlur.x > 10 && outMid.motionBlur.y === 0, '中段水平拖影达峰');
  assert.ok(Math.abs(virtualCameraStyle('orbitSwipe', 'in', 0, {direction: 3}).motionBlur.x) < 1e-9);
  assert.ok(Math.abs(virtualCameraStyle('orbitSwipe', 'in', 1, {direction: 3}).motionBlur.x) < 1e-9);
  ok('拖影随摆速中段达峰、端点归零');

  // 中段两段分处屏幕两侧（甩出/旋入分离）
  const outX = translateOf(outMid.transform).x;
  const inX = translateOf(inMid.transform).x;
  assert.ok(outX < -30 && inX > 30, `中段出段在左（${outX}%）入段在右（${inX}%）`);
  ok('遮挡时刻两段分处两侧');
}

// ====== 6. panChase 速度连续性：出入段共享相机 ⇒ 导数处处相等 ======

console.log('panChase 速度连续性:');
{
  // 从 CSS 字符串解析的位移保留 3 位小数（%），数值微分取粗步长 h=0.02 规避舍入噪声
  const h = 0.02;
  for (const q of [0.25, 0.5, 0.75]) {
    const xOut = (qq: number) => translateOf(virtualCameraStyle('panChase', 'out', qq, {direction: 3}).transform).x;
    const xIn = (qq: number) => translateOf(virtualCameraStyle('panChase', 'in', qq, {direction: 3}).transform).x;
    const dOut = (xOut(q + h) - xOut(q - h)) / (2 * h);
    const dIn = (xIn(q + h) - xIn(q - h)) / (2 * h);
    assert.ok(Math.abs(dOut - dIn) < 0.5, `q=${q} 出段速度 ${dOut.toFixed(1)} ≈ 入段速度 ${dIn.toFixed(1)} (%/q)`);
  }
  ok('出入段速度曲线处处相等（共享同一相机轨迹）');

  // 余弦启停：两端速度 ≈0（出段末速 ≈ 入段初速 ≈ 0，且中点速度达峰）
  const xOut = (qq: number) => translateOf(virtualCameraStyle('panChase', 'out', qq, {direction: 3}).transform).x;
  const vStart = Math.abs(xOut(0.001) - xOut(0)) / 0.001;
  const vMid = Math.abs(xOut(0.501) - xOut(0.499)) / 0.002;
  const vEnd = Math.abs(xOut(1) - xOut(0.999)) / 0.001;
  assert.ok(vStart < vMid * 0.05 && vEnd < vMid * 0.05, `端点速度 ${vStart.toFixed(1)}/${vEnd.toFixed(1)} ≪ 中点 ${vMid.toFixed(1)}`);
  ok('速度剖面：缓起 → 中点峰值 → 缓收（出段末速 ≈ 入段初速）');

  // 运动方向 = direction 朝向：dir=3 向左（x 单调减且两段同向移动）
  const d1 = xOut(0.6) - xOut(0.4);
  const xIn = (qq: number) => translateOf(virtualCameraStyle('panChase', 'in', qq, {direction: 3}).transform).x;
  const d2 = xIn(0.6) - xIn(0.4);
  assert.ok(d1 < 0 && d2 < 0, 'direction=3 两段都向左移动');
  ok('两段运动方向一致（运动接运动）');

  // 拖影沿运动方向：水平只糊 x、竖直只糊 y
  const hMid = virtualCameraStyle('panChase', 'out', 0.5, {direction: 3});
  assert.ok(hMid.motionBlur.x > 10 && hMid.motionBlur.y === 0, '水平追拍糊 x');
  const vMidS = virtualCameraStyle('panChase', 'out', 0.5, {direction: 2});
  assert.ok(vMidS.motionBlur.y > 10 && vMidS.motionBlur.x === 0, '竖直追拍糊 y');
  ok('panChase 方向性拖影随朝向');
}

// ====== 7. 与 transition-style 集成：两条路径 + curve 通道 + 默认时长 ======

console.log('transitionStyle 集成:');
{
  // 无曲线路径端点 identity
  assert.equal(transitionStyle('panChase', 'out', 0).transform, CAMERA_IDENTITY_TRANSFORM);
  assert.equal(transitionStyle('panChase', 'in', 1).transform, CAMERA_IDENTITY_TRANSFORM);
  assert.equal(transitionStyle('orbitSwipe', 'out', 0).transform, CAMERA_IDENTITY_TRANSFORM);
  assert.equal(transitionStyle('orbitSwipe', 'in', 1).transform, CAMERA_IDENTITY_TRANSFORM);
  ok('无曲线路径端点 identity');

  // 曲线路径端点 identity（曲线钉住 0→0 / 1→1）
  const c = presetCurve('bounce');
  assert.equal(transitionStyle('panChase', 'in', 1, {curve: c}).transform, CAMERA_IDENTITY_TRANSFORM);
  assert.equal(transitionStyle('panChase', 'out', 0, {curve: c}).transform, CAMERA_IDENTITY_TRANSFORM);
  assert.equal(transitionStyle('orbitSwipe', 'in', 1, {curve: c}).transform, CAMERA_IDENTITY_TRANSFORM);
  ok('curve 路径端点同样严格 identity');

  // curve 作为替换缓动生效：easeIn 前半段进度 < 0.5 ⇒ 入段位移更大（离位更远）
  const defX = translateOf(transitionStyle('panChase', 'in', 0.5, {direction: 3}).transform!).x;
  const inX = translateOf(transitionStyle('panChase', 'in', 0.5, {direction: 3, curve: presetCurve('easeIn')}).transform!).x;
  assert.ok(inX > defX, `easeIn@0.5 入段位移 ${inX}% > 默认 ${defX}%`);
  ok('curve 输出作为替换缓动喂相机轨迹');

  // 曲线越界点不产出非法样式（blur 通道钳 [0,1]，拖影不为负）
  const over = transitionStyle('orbitSwipe', 'out', 0.85, {curve: presetCurve('anticipate'), direction: 4});
  assert.ok(over.motionBlur!.x >= 0 && over.motionBlur!.y! >= 0, '越界点拖影非负');
  ok('曲线越界时拖影/压暗通道仍钳制');

  // motionBlur 通道存在（MultiSegmentPromo 据此挂 SVG 方向拖影滤镜）
  const mb = transitionStyle('panChase', 'in', 0.5, {direction: 4});
  assert.ok(mb.motionBlur && mb.motionBlur.x > 10, 'panChase 输出 motionBlur');
  ok('transitionStyle 透传 motionBlur 通道');
}

// ====== 8. 相机位姿 → CSS 函数顺序（右先乘） ======

console.log('cameraWrapperTransform 函数顺序:');
{
  const cam = {x: 0.2, y: -0.1, z: 100, rotX: 5, rotY: -15, rotZ: 2};
  const plane = {x: -0.5, y: 0.3, z: -200, rotX: 0, rotY: 30, rotZ: 0};
  const t = cameraWrapperTransform(cam, plane);
  // perspective → 相机逆旋转（Rx⁻¹ Ry⁻¹ Rz⁻¹）→ 合并平移 T(p−c) → 平面自转（Rz Ry Rx）
  assert.equal(
    t,
    'perspective(900px) rotateX(-5deg) rotateY(15deg) rotateZ(-2deg) translate3d(-70%, 40%, -300px) rotateY(30deg)',
  );
  ok('perspective · 相机逆旋转 · 合并平移 · 平面自转');

  // 合并平移：T(-c)·T(p) = T(p−c)
  assert.ok(t.includes('translate3d(-70%, 40%, -300px)'), '平移合并为单个 translate3d');
  ok('相机逆变换末尾平移与平面开头平移相邻必合并');

  // 全零位姿 → 端点 identity 字符串
  assert.equal(cameraWrapperTransform(IDENTITY_CAMERA_POSE, IDENTITY_CAMERA_POSE), CAMERA_IDENTITY_TRANSFORM);
  ok('双 identity → perspective(900px) translateZ(0px)');

  // 浮点尾吸收：1e-16 级噪声归零
  const noisy = {x: 1e-17, y: 0, z: 1.22e-16 * 260, rotX: 0, rotY: 1.22e-16 * 42, rotZ: 0};
  assert.equal(cameraWrapperTransform(noisy, IDENTITY_CAMERA_POSE), CAMERA_IDENTITY_TRANSFORM);
  ok('sin(π) 级浮点尾被吸零');
}

console.log(`\n全部通过（${passed} 组断言）`);
