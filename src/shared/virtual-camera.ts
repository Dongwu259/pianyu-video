/**
 * 虚拟相机连续运镜（纯函数，无运行时依赖，Node 可直跑单测）。
 *
 * 把 flyThrough 验证过的「wrapper 层 CSS 3D」泛化为虚拟相机系统（RESEARCH-TRANSITIONS.md 一期 T1）：
 * 转场窗口内，前后两段的 wrapper 是同一透视舞台上的两个平面，一台虚拟相机沿参数化轨迹
 * 运动把它们串联——出段平面固定在世界原点（identity），入段平面停在相机轨迹终点处，
 * 相机到达终点时入段恰好铺满画面（wrapper 变换逐项归零 = 严格 identity，转场结束画面不跳）。
 *
 * 位姿约定：M = T(x,y,z) · Rz · Ry · Rx（欧拉角先自转后平移）。x/y 以画布宽/高的分数
 * 为单位（输出为 translate3d 的百分比轴向），z 为 px（与 perspective(900px) 配套）。
 * wrapper 变换 = persp · C(q)⁻¹ · P_plane；CSS 右先乘，函数顺序：
 *   perspective → 相机逆旋转（Rx⁻¹ Ry⁻¹ Rz⁻¹）→ 合并平移（平面位置 − 相机位置）→ 平面自转（Rz Ry Rx）
 * 相机位姿 C(q) 的所有「鼓包」通道（摆头/拉焦）在 q=0/q=1 归零，因此入段平面 = C(1) 只剩
 * 平移；相机逆变换末尾的 T(-c) 与平面开头的 T(p) 相邻必合并成单个 translate3d(p−c)，
 * 保证 q=0 出段、q=1 入段的 wrapper 字符串严格落到 identity（`perspective(900px) translateZ(0px)`）。
 *
 * flyThrough 不走本模块：它有字符串级回归测试（tests/unit/transition-style.test.ts），
 * direction=1 默认行为逐像素冻结在 transition-style.ts 手写分支（direction=2 拉远飞出同处扩展）。
 * 本模块服务 panChase（横摇追拍）/ orbitSwipe（轨道环绕）。
 *
 * 速度连续性（panChase 核心观感）：出段屏幕位移 = +v·L·e(q)，入段 = −v·L·(1−e(q))，
 * 两者对 q 的导数同为 v·L·e′(q)——共享同一台相机 ⇒ 任意时刻两段速度严格相等，
 * 出段末速 ≈ 入段初速由 e 的余弦启停剖面（两端速度 0、中点峰值）自然成立。
 */

import {easeInOutCubic} from './easings.ts';

// ====== 位姿与档位 ======

/** 相机/平面位姿：x/y 画布分数（1 = 一屏宽/高），z 为 px，旋转为度 */
export interface CameraPose {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}

export const IDENTITY_CAMERA_POSE: CameraPose = {x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0};

/** 走虚拟相机系统的转场类型 */
export type VirtualCameraTransition = 'panChase' | 'orbitSwipe';

export const isVirtualCameraTransition = (t: string): t is VirtualCameraTransition =>
  t === 'panChase' || t === 'orbitSwipe';

export type VirtualCameraRole = 'in' | 'out';

export interface VirtualCameraOpts {
  /** 运动朝向档位：1上 2下 3左 4右；缺省 3（向左，与 slide/push/whip 同口径） */
  direction?: number;
}

/** 透视距离（与 flyThrough/rotate 的 900/1200px 同族；两段 wrapper 共用同一舞台） */
export const VIRTUAL_CAMERA_PERSPECTIVE_PX = 900;

/** direction 档位 → 内容运动朝向单位向量；非法/未给 = 向左（3），与转场方向参数同口径 */
export const virtualCameraDirVec = (direction: number | undefined): {x: number; y: number} => {
  switch (Math.round(direction ?? 3)) {
    case 1: return {x: 0, y: -1};
    case 2: return {x: 0, y: 1};
    case 4: return {x: 1, y: 0};
    default: return {x: -1, y: 0};
  }
};

/** 负零归一：-0 === 0 但 Object.is(-0, 0) = false（严格相等断言/快照会踩坑），位姿分量一律过它 */
const nz = (v: number): number => (v === 0 ? 0 : v);

// ====== 轨迹参数 ======

/** panChase 追拍行程（画布分数）：恰好一屏，中点两平面边缘在屏心闭合、端点各自完全出画 */
export const PAN_CHASE_TRAVEL = 1;
/** panChase 中段相机顺势摆头角（度；小角度 = 追拍味，不抢戏） */
export const PAN_CHASE_TILT_DEG = 10;
/** panChase 拖影峰值（px，沿运动方向） */
export const PAN_CHASE_BLUR_PX = 16;

/** orbitSwipe 相机横移行程（画布分数）：略超一屏，出段彻底甩出视野边缘 */
export const ORBIT_SWIPE_TRAVEL = 1.1;
/** orbitSwipe 中段摆角（度）：q=0.5 两段都 ≥30° 侧对相机 = 遮挡时刻 */
export const ORBIT_SWIPE_SWING_DEG = 42;
/** orbitSwipe 中段相机后拉（px）：两段平面相对推近放大，甩镜拖影更满 */
export const ORBIT_SWIPE_DOLLY_PX = 260;
/** orbitSwipe 拖影峰值（px，沿运动方向） */
export const ORBIT_SWIPE_BLUR_PX = 18;
/** orbitSwipe 中段亮度压暗量（遮挡感：摆到中点画面被模糊+暗角覆盖） */
export const ORBIT_SWIPE_DARKEN = 0.35;

// ====== 相机轨迹 ======

/**
 * 相机位姿轨迹：type × q（0..1 窗口进度，由调用方选定缓动；曲线通道的输出可越界，
 * 轨迹对越界宽容——鼓包变负/行程回走即 anticipation/overshoot）× direction → 相机位姿。
 * 端点不变量：C(0) = identity（出段 wrapper q=0 严格归零）；所有旋转/拉焦鼓包在 q=1 归零，
 * C(1) 只剩平移（= 入段平面的世界位姿，见 cameraPlanePose）。
 */
export const cameraTrajectory = (
  type: VirtualCameraTransition,
  q: number,
  opts?: VirtualCameraOpts,
): CameraPose => {
  const v = virtualCameraDirVec(opts?.direction);
  const bump = Math.sin(Math.PI * q); // 中段鼓包：q=0/1 归零，q=0.5 达峰
  if (type === 'panChase') {
    // 横摇追拍：相机垂直于运动朝向后移（truck），世界画面随之向 direction 方向流动；
    // 余弦启停剖面 e：两端速度 0、中点峰值——出入两段共享同一 e ⇒ 速度曲线处处连续。
    const e = (1 - Math.cos(Math.PI * q)) / 2;
    return {
      x: nz(-v.x * PAN_CHASE_TRAVEL * e),
      y: nz(-v.y * PAN_CHASE_TRAVEL * e),
      z: 0,
      // 中段顺势摆头：水平追拍绕 Y 轴、竖直追拍绕 X 轴
      rotX: nz(-v.y * PAN_CHASE_TILT_DEG * bump),
      rotY: nz(-v.x * PAN_CHASE_TILT_DEG * bump),
      rotZ: 0,
    };
  }
  // orbitSwipe 轨道环绕：横移 + 中段大角度摆头 + 中段后拉，摆到 q≈0.5 两段平面都
  // 大角度侧对相机（遮挡时刻），由运动模糊 + 压暗覆盖接缝。
  const e = easeInOutCubic(q);
  return {
    x: nz(-v.x * ORBIT_SWIPE_TRAVEL * e),
    y: nz(-v.y * ORBIT_SWIPE_TRAVEL * e),
    z: nz(-ORBIT_SWIPE_DOLLY_PX * bump),
    rotX: nz(-v.y * ORBIT_SWIPE_SWING_DEG * bump),
    rotY: nz(-v.x * ORBIT_SWIPE_SWING_DEG * bump),
    rotZ: 0,
  };
};

/**
 * 入段平面的世界位姿 = 相机轨迹终点 C(1)。
 * 鼓包通道（旋转/拉焦）在 q=1 归零，故只剩终点平移 —— 直接构造，避免 sin(π) 浮点尾。
 */
export const cameraPlanePose = (
  type: VirtualCameraTransition,
  opts?: VirtualCameraOpts,
): CameraPose => {
  const v = virtualCameraDirVec(opts?.direction);
  const travel = type === 'panChase' ? PAN_CHASE_TRAVEL : ORBIT_SWIPE_TRAVEL;
  return {x: nz(-v.x * travel), y: nz(-v.y * travel), z: 0, rotX: 0, rotY: 0, rotZ: 0};
};

// ====== 位姿 → CSS transform ======

/** 数值规整：保留 3 位小数并吸掉 |v|<5e-4 的浮点尾（sin(π)≈1e-16 之类），保证端点严格归零 */
const fmtNum = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return Math.abs(r) < 0.0005 ? 0 : r;
};

/** 平移函数：x/y 画布分数 → 百分比轴向，z 为 px；全零时省略（返回 null） */
const translateFn = (x: number, y: number, z: number): string | null => {
  const fx = fmtNum(x * 100);
  const fy = fmtNum(y * 100);
  const fz = fmtNum(z);
  if (fx === 0 && fy === 0 && fz === 0) return null;
  return `translate3d(${fx}%, ${fy}%, ${fz}px)`;
};

const rotateFn = (fn: 'rotateX' | 'rotateY' | 'rotateZ', deg: number): string | null => {
  const d = fmtNum(deg);
  return d === 0 ? null : `${fn}(${d}deg)`;
};

/** 端点 identity 字符串（与 flyThrough 端点写法同族；z=0 平面投影 = 画面丝毫不差） */
export const CAMERA_IDENTITY_TRANSFORM = `perspective(${VIRTUAL_CAMERA_PERSPECTIVE_PX}px) translateZ(0px)`;

/**
 * 相机 + 平面位姿 → wrapper CSS transform。
 * CSS 函数右先乘：perspective · R⁻¹(相机) · T(平面位置−相机位置) · R(平面)。
 * 相机逆变换末尾的 T(-c) 与平面位姿开头的 T(p) 相邻、无条件合并成单个 translate3d——
 * 这是端点严格 identity 的关键：q=1 时相机 = 终点 = 平面位姿，p−c 逐项归零。
 */
export const cameraWrapperTransform = (camera: CameraPose, plane: CameraPose): string => {
  const parts: string[] = [`perspective(${VIRTUAL_CAMERA_PERSPECTIVE_PX}px)`];
  const push = (s: string | null) => {
    if (s !== null) parts.push(s);
  };
  // 相机逆变换 R⁻¹：位姿约定 M = T·Rz·Ry·Rx ⇒ R⁻¹ = Rx⁻¹·Ry⁻¹·Rz⁻¹
  push(rotateFn('rotateX', -camera.rotX));
  push(rotateFn('rotateY', -camera.rotY));
  push(rotateFn('rotateZ', -camera.rotZ));
  // 合并平移 T(-c)·T(p) = T(p−c)
  push(translateFn(plane.x - camera.x, plane.y - camera.y, plane.z - camera.z));
  // 平面自转（与相机同约定 T·Rz·Ry·Rx）
  push(rotateFn('rotateZ', plane.rotZ));
  push(rotateFn('rotateY', plane.rotY));
  push(rotateFn('rotateX', plane.rotX));
  return parts.length > 1 ? parts.join(' ') : CAMERA_IDENTITY_TRANSFORM;
};

// ====== 转场样式（transform + 拖影 + 压暗） ======

/** 虚拟相机转场的样式输出（结构上兼容 transition-style.ts 的 TransitionStyle 子集） */
export interface VirtualCameraStyle {
  transform: string;
  filter?: string;
  /** 方向性运动模糊（px）：随相机速度的中段鼓包输出，端点为 0 */
  motionBlur: {x: number; y: number};
}

/**
 * 虚拟相机转场在某一方（后段入场 in / 前段出场 out）的样式。
 * q 为窗口进度（无曲线路径传原 q，轨迹内部自带缓动剖面；曲线路径传曲线输出 p，
 * 曲线即替换缓动）。blur/压暗通道用钳制到 [0,1] 的 qc（与 mechanicalStyle 的 pc 同政策），
 * transform 通道保留越界以呈现回弹/预期。
 */
export const virtualCameraStyle = (
  type: VirtualCameraTransition,
  role: VirtualCameraRole,
  q: number,
  opts?: VirtualCameraOpts,
): VirtualCameraStyle => {
  const camera = cameraTrajectory(type, q, opts);
  const plane = role === 'in' ? cameraPlanePose(type, opts) : IDENTITY_CAMERA_POSE;
  const transform = cameraWrapperTransform(camera, plane);
  const qc = Math.min(1, Math.max(0, q));
  const bump = Math.sin(Math.PI * qc);
  const v = virtualCameraDirVec(opts?.direction);
  if (type === 'panChase') {
    return {
      transform,
      motionBlur: {
        x: bump * PAN_CHASE_BLUR_PX * Math.abs(v.x),
        y: bump * PAN_CHASE_BLUR_PX * Math.abs(v.y),
      },
    };
  }
  return {
    transform,
    // 遮挡时刻压暗：摆到中点两段都侧对相机，画面由拖影 + 暗角覆盖接缝
    filter: `brightness(${fmtNum(1 - ORBIT_SWIPE_DARKEN * bump)})`,
    motionBlur: {
      x: bump * ORBIT_SWIPE_BLUR_PX * Math.abs(v.x),
      y: bump * ORBIT_SWIPE_BLUR_PX * Math.abs(v.y),
    },
  };
};
