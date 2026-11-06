/**
 * 地面追踪纯函数单测：单应求解/RANSAC/单应分解投影/matrix3d 嵌入/锚点插值/
 * 组装（共面筛选+跟丢填补）/自动选锚/sidecar 校验/方向约定
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/ground-track.test.ts
 */
import assert from 'node:assert/strict';
import {
  applyH,
  assembleGroundTrack,
  autoPickGroundAnchors,
  autoYawScreenUpright,
  autoYawTowardCamera,
  cameraCenterFromP,
  groundMatrix3dAt,
  homographyFromP,
  homographyResidual,
  interpolateAnchors,
  invertH,
  makeIntrinsics,
  projectPoint,
  projectionToMatrix3d,
  ransacHomography,
  solveHomography,
  solveProjection,
  validateGroundTrackFile,
  type GroundTrackData,
  type Vec2,
} from '../../src/shared/groundTrack.ts';
import type {FrameGray} from '../../src/shared/stabilization.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
};

const noiseFrame = (w: number, h: number, seed = 42): FrameGray => {
  const rnd = lcg(seed);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = rnd() * 255;
  return {data, width: w, height: h};
};

// ---- 合成单应工具：已知 H 生成对应点 ----
const applyKnown = (h: number[], p: Vec2): Vec2 => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return {x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w};
};

// ---- 3D 位姿工具（合成相机）----
type Mat3x3 = number[]; // 行主序 9
const rotX = (a: number): Mat3x3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Mat3x3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const mat3mul = (a: Mat3x3, b: Mat3x3): Mat3x3 => {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
    o[i * 3 + j] = s;
  }
  return o;
};

/** P = K·[R|t]（行主序 12 元），投影 (x,y,z) */
const poseProject = (K: {f: number; cx: number; cy: number}, R: Mat3x3, t: number[]) =>
  (x: number, y: number, z: number): Vec2 => {
    const cam = [R[0] * x + R[1] * y + R[2] * z + t[0], R[3] * x + R[4] * y + R[5] * z + t[1], R[6] * x + R[7] * y + R[8] * z + t[2]];
    const px = K.f * cam[0] + K.cx * cam[2];
    const py = K.f * cam[1] + K.cy * cam[2];
    return {x: px / cam[2], y: py / cam[2]};
  };

console.log('ground-track:');

// ===== ① solveHomography =====
t('solveHomography：4 点精确恢复带透视项的单应（残差 <1e-6）', () => {
  const H = [1.05, 0.002, 12, -0.001, 0.97, -8, 0.00012, -0.00008, 1];
  const src: Vec2[] = [{x: 100, y: 120}, {x: 380, y: 130}, {x: 120, y: 250}, {x: 400, y: 260}];
  const dst = src.map((p) => applyKnown(H, p));
  const got = solveHomography(src, dst);
  assert.ok(got, '应解出单应');
  const res = homographyResidual(got, src, dst);
  assert.ok(res < 1e-6, `残差 ${res}`);
});

t('solveHomography：8 点最小二乘抗小噪声（残差 <0.2px，DLT 代数误差口径）', () => {
  const H = [1.02, 0.001, 6, 0.0005, 1.01, 4, 0.00005, 0.00003, 1];
  const rnd = lcg(11);
  const src: Vec2[] = [];
  for (let i = 0; i < 8; i++) src.push({x: 80 + rnd() * 320, y: 150 + rnd() * 110});
  const dst = src.map((p) => {
    const q = applyKnown(H, p);
    return {x: q.x + (rnd() - 0.5) * 0.3, y: q.y + (rnd() - 0.5) * 0.3};
  });
  const got = solveHomography(src, dst);
  assert.ok(got, '应解出单应');
  assert.ok(homographyResidual(got, src, dst) < 0.2);
});

t('solveHomography：共线点退化返回 null', () => {
  const src: Vec2[] = [{x: 100, y: 100}, {x: 150, y: 100}, {x: 200, y: 100}, {x: 250, y: 100}];
  const dst = src.map((p) => ({x: p.x + 5, y: p.y + 3}));
  assert.equal(solveHomography(src, dst), null);
});

t('applyH：映到无穷远（w≈0）返回 null', () => {
  assert.equal(applyH([1, 0, 0, 0, 1, 0, -1 / 100, 0, 1], {x: 100, y: 50}), null);
});

// ===== ② RANSAC =====
t('ransacHomography：8 内点 + 2 离群 → 精确剔除离群', () => {
  const H = [1.06, 0.003, 14, -0.002, 0.95, -6, 0.00015, -0.0001, 1];
  const src: Vec2[] = [];
  const rnd = lcg(7);
  for (let i = 0; i < 8; i++) src.push({x: 70 + rnd() * 330, y: 140 + rnd() * 120});
  const dst = src.map((p) => applyKnown(H, p));
  // 两个离群点：不共面的运动（偏移 30px）
  src.push({x: 300, y: 160}, {x: 220, y: 240});
  dst.push({x: 330, y: 195}, {x: 245, y: 275});
  const r = ransacHomography(src, dst, {threshPx: 4});
  assert.ok(r, '应拟合成功');
  assert.equal(r.inlierCount, 8, `内点数 ${r.inlierCount}`);
  assert.equal(r.inliers[8], false);
  assert.equal(r.inliers[9], false);
  assert.ok(r.residualPx < 0.01, `残差 ${r.residualPx}`);
});

t('ransacHomography：同输入两次结果完全一致（确定性 LCG）', () => {
  const H = [1.04, 0.001, 9, -0.001, 0.98, -5, 0.0001, 0.00005, 1];
  const src: Vec2[] = [];
  const rnd = lcg(3);
  for (let i = 0; i < 6; i++) src.push({x: 90 + rnd() * 300, y: 150 + rnd() * 100});
  const dst = src.map((p) => applyKnown(H, p));
  src.push({x: 250, y: 200}); dst.push({x: 260, y: 240}); // 离群
  const a = ransacHomography(src, dst, {threshPx: 4});
  const b = ransacHomography(src, dst, {threshPx: 4});
  assert.deepEqual(a?.inliers, b?.inliers);
  assert.deepEqual(a?.h.map((v: number) => Math.round(v * 1e9)), b?.h.map((v: number) => Math.round(v * 1e9)));
});

t('ransacHomography：有效对应 <4 返回 null', () => {
  const src: Vec2[] = [{x: 1, y: 1}, {x: 2, y: 2}, {x: 3, y: 3}, {x: 4, y: 4}, {x: 5, y: 5}];
  const dst = src.map((p) => ({...p}));
  assert.equal(ransacHomography(src, dst, {valid: [true, true, true, false, false]}), null);
});

// ===== ③ solveProjection：单应分解 + 方向约定 =====
/**
 * 合成场景：相机在地面上方 300 单位、下视角约 31° 前倾（rotX(π−0.55) = 从垂直
 * 方向抬 0.55rad）+ 小侧摆；世界 z=0 为地面，地面坐标即参考帧图像坐标邻域
 * （0..640 / 0..360）。t = −R·C，相机中心 C=(255,255,300)。
 */
const buildScene = () => {
  const K = makeIntrinsics(640, 360); // f=576, cx=320, cy=180
  const R = mat3mul(rotX(Math.PI - 0.55), rotY(0.12));
  const C = [255, 255, 300];
  const t = [
    -(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]),
    -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]),
    -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2]),
  ];
  const proj = poseProject(K, R, t);
  const ground: Vec2[] = [
    {x: 140, y: 200}, {x: 320, y: 210}, {x: 500, y: 200},
    {x: 170, y: 300}, {x: 350, y: 310}, {x: 520, y: 300},
    {x: 250, y: 255}, {x: 430, y: 255},
  ];
  const img = ground.map((p) => proj(p.x, p.y, 0));
  assert.ok(img.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), '合成场景投影应有限');
  return {K, R, t, proj, ground, img};
};

t('solveProjection：平面映射精确（残差 <1e-6，投影回拍一致）', () => {
  const {K, ground, img} = buildScene();
  const got = solveProjection(K, ground, img);
  assert.ok(got, '应解出投影矩阵');
  assert.ok(got.residualPx < 1e-6, `残差 ${got.residualPx}`);
  for (let i = 0; i < ground.length; i++) {
    const p = projectPoint(got.P, ground[i].x, ground[i].y, 0);
    assert.ok(p, '投影有效');
    assert.ok(Math.abs(p.x - img[i].x) < 1e-4 && Math.abs(p.y - img[i].y) < 1e-4,
      `锚点 ${i} 回拍偏差 (${p!.x - img[i].x}, ${p!.y - img[i].y})`);
  }
});

t('solveProjection：方向约定——z 轴朝相机（各锚点上方向指向相机）+ 相机在平面上方', () => {
  const {K, ground, img} = buildScene();
  const got = solveProjection(K, ground, img)!;
  // 从 P 反解 r1/r2/n/t（去 K）
  const inv = (vx: number, vy: number, vz: number) => ({x: (vx - K.cx * vz) / K.f, y: (vy - K.cy * vz) / K.f, z: vz});
  const n = inv(got.P[2], got.P[6], got.P[10]);
  const t3 = inv(got.P[3], got.P[7], got.P[11]);
  const r1 = inv(got.P[0], got.P[4], got.P[8]);
  const r2 = inv(got.P[1], got.P[5], got.P[9]);
  // 相机中心 C = −Rᵀt：世界 z 分量 = −dot(n,t)（地面坐标系 z 向上）
  const dot = (a: {x: number; y: number; z: number}, b: {x: number; y: number; z: number}) => a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(dot(n, t3) < 0, 'dot(n,t) < 0（相机在法线正侧 = 地面上方）');
  // 每个锚点：上方向（+z）在相机坐标里指向相机（与「锚点→相机」向量同向）
  for (const g of ground) {
    const cam = {
      x: r1.x * g.x + r2.x * g.y + t3.x,
      y: r1.y * g.x + r2.y * g.y + t3.y,
      z: r1.z * g.x + r2.z * g.y + t3.z,
    };
    assert.ok(cam.z > 0, '锚点在相机前方');
    // 指向相机 = −cam；up 方向 n 与其点积 > 0
    assert.ok(dot(n, {x: -cam.x, y: -cam.y, z: -cam.z}) > 0, 'up 方向朝相机一侧');
  }
  // 深度随 z 增大而减小（升高 = 靠近相机）
  const g0 = ground[0];
  const wAt = (z: number) => got.P[8] * g0.x + got.P[9] * g0.y + got.P[10] * z + got.P[11];
  assert.ok(wAt(0.5) < wAt(0), 'z 升高 → 深度(w) 减小');
});

t('solveProjection：跨帧 prevP 符号连续（z 列不翻转）', () => {
  const {K, R, t, ground, proj} = buildScene();
  const img0 = ground.map((p) => proj(p.x, p.y, 0));
  const p0 = solveProjection(K, ground, img0)!;
  // 第二帧：相机平移
  const img1 = ground.map((p) => poseProject(K, R, [t[0] + 0.6, t[1] + 0.4, t[2] - 0.8])(p.x, p.y, 0));
  const p1 = solveProjection(K, ground, img1, {prevP: p0.P})!;
  const dot = p0.P[2] * p1.P[2] + p0.P[6] * p1.P[6] + p0.P[10] * p1.P[10];
  assert.ok(dot > 0, 'z 列跨帧同向');
});

t('solveProjection：点不足返回 null', () => {
  const K = makeIntrinsics(640, 360);
  const g: Vec2[] = [{x: 1, y: 1}, {x: 2, y: 1}, {x: 1, y: 2}];
  assert.equal(solveProjection(K, g, g), null);
});

// ===== ④ matrix3d 嵌入 =====
t('projectionToMatrix3d：列主序嵌入，模拟浏览器透视除法与 projectPoint 一致', () => {
  const {K, ground, img} = buildScene();
  const {P} = solveProjection(K, ground, img)!;
  const css = projectionToMatrix3d(P);
  assert.ok(css.startsWith('matrix3d(') && css.endsWith(')'));
  const v = css.slice(9, -1).split(',').map(Number);
  assert.equal(v.length, 16);
  // 列主序 → 4x4（行主序）
  const row = (i: number) => [v[i], v[4 + i], v[8 + i], v[12 + i]];
  const r1 = row(0); const r2 = row(1); const w = row(3);
  for (const [x, y, z] of [[320, 240, 0], [200, 300, 0.4], [480, 210, -0.2]] as const) {
    const ww = w[0] * x + w[1] * y + w[2] * z + w[3];
    const u = (r1[0] * x + r1[1] * y + r1[2] * z + r1[3]) / ww;
    const vv = (r2[0] * x + r2[1] * y + r2[2] * z + r2[3]) / ww;
    const expect = projectPoint(P, x, y, z)!;
    assert.ok(Math.abs(u - expect.x) < 0.01 && Math.abs(vv - expect.y) < 0.01,
      `(${x},${y},${z}) css=(${u},${vv}) expect=(${expect.x},${expect.y})`);
  }
});

// ===== ⑤ 插值与一站式查表 =====
t('interpolateAnchors：中点线性插值 + 端点钳位', () => {
  const samples = [
    {t: 0, pts: [{x: 10, y: 20}, {x: 100, y: 200}], conf: 1},
    {t: 0.2, pts: [{x: 30, y: 40}, {x: 120, y: 220}], conf: 1},
  ];
  const mid = interpolateAnchors(samples, 0.1)!;
  assert.deepEqual(mid, [{x: 20, y: 30}, {x: 110, y: 210}]);
  const before = interpolateAnchors(samples, -1)!;
  assert.deepEqual(before, samples[0].pts);
  const after = interpolateAnchors(samples, 9)!;
  assert.deepEqual(after, samples[1].pts);
  assert.equal(interpolateAnchors([], 0), null);
});

t('groundMatrix3dAt：参考帧（H=identity）z=0 投影恒等', () => {
  const {K, ground} = buildScene();
  // 参考帧：samples[0].pts = anchors → H = I
  const track: GroundTrackData = {
    anchors: ground,
    samples: [
      {t: 0, pts: ground.map((p) => ({...p})), conf: 1},
      {t: 0.5, pts: ground.map((p) => ({x: p.x * 1.05 + 4, y: p.y * 1.05 - 3})), conf: 1},
    ],
  };
  void K;
  const got = groundMatrix3dAt(track, 640, 360, 0);
  assert.ok(got, '参考帧应可解');
  const probe = projectPoint(got.P, 320, 180, 0)!;
  assert.ok(Math.abs(probe.x - 320) < 0.01 && Math.abs(probe.y - 180) < 0.01,
    `参考帧恒等性破坏: (${probe.x}, ${probe.y})`);
  const got2 = groundMatrix3dAt(track, 640, 360, 0.25, got.P);
  assert.ok(got2);
  const probe2 = projectPoint(got2.P, 320, 180, 0)!;
  const expectX = 320 * 1.025 + 2; // 帧族：t=0.25 处缩放 1.025 平移 2（线性插值中点）
  assert.ok(Math.abs(probe2.x - expectX) < 0.02, `插值中点 ${probe2.x} 期望 ${expectX}`);
});

// ===== ⑥ assembleGroundTrack =====
/** 精确单应运动族：帧 i 的锚点位置 = hOf(i)·a（缩放/平移线性变化 + 固定透视项） */
const hOf = (i: number) => {
  const z = 1 + 0.004 * i;
  return [z, 0.002, 1.5 * i, -0.001, z * 0.97, 0.8 * i, 0.00012, -0.00006, 1];
};

t('assembleGroundTrack：共面锚点 + 2 个非共面离群 → RANSAC 剔除，残差≈0', () => {
  const anchors: Vec2[] = [
    {x: 120, y: 180}, {x: 240, y: 170}, {x: 360, y: 175}, {x: 470, y: 185},
    {x: 160, y: 250}, {x: 300, y: 245}, {x: 430, y: 250}, {x: 300, y: 210},
  ];
  const nFrames = 12;
  const tracked = anchors.map((a) =>
    Array.from({length: nFrames}, (_, i) => {
      const q = applyKnown(hOf(i), a);
      return {t: i / 15, x: q.x, y: q.y};
    }));
  // 2 个离群锚点：运动不合单应族（方向不同 + 抖动）
  for (const base of [{x: 200, y: 300}, {x: 380, y: 300}]) {
    tracked.push(Array.from({length: nFrames}, (_, i) => ({
      t: i / 15, x: base.x + i * 3.7 + (i % 3), y: base.y - i * 1.9,
    })));
  }
  const confs = tracked.map(() => Array.from({length: nFrames}, () => 0.95));
  const r = assembleGroundTrack(tracked, confs);
  assert.ok(r, '应组装成功');
  assert.equal(r.rejected, 2, `剔除数 ${r.rejected}`);
  assert.equal(r.anchors.length, 8);
  assert.ok(r.meanResidualPx < 0.05, `残差 ${r.meanResidualPx}`);
  assert.equal(r.samples.length, nFrames);
  assert.ok(r.samples.every((s) => s.pts.length === 8));
});

t('assembleGroundTrack：跟丢帧位置线性填补 + 逐锚 conf 记录', () => {
  // 5 个 2D 展开的共面锚点（精确 hOf 族）+ 1 个离群；锚点 0 在帧 2-3 跟丢
  const anchors: Vec2[] = [
    {x: 100, y: 200}, {x: 260, y: 185}, {x: 400, y: 215}, {x: 180, y: 290}, {x: 340, y: 270},
    {x: 470, y: 320},
  ];
  const nFrames = 6;
  const tracked = anchors.map((a, p) =>
    Array.from({length: nFrames}, (_, i) => {
      const q = applyKnown(hOf(i), a);
      // 离群锚点：独立运动方向
      const off = p === 5 ? i * 2.2 : 0;
      return {t: i / 15, x: q.x + off, y: q.y - off};
    }));
  const confs = tracked.map(() => Array.from({length: nFrames}, () => 0.95));
  confs[0][2] = 0.1; confs[0][3] = 0.1;
  const r = assembleGroundTrack(tracked, confs)!;
  assert.ok(r);
  // 帧 2 的填补位置 = 帧 1 与帧 4 的线性插值（hOf 帧间近线性 → 误差极小）
  const expectX = tracked[0][1].x + (tracked[0][4].x - tracked[0][1].x) * (1 / 3);
  assert.ok(Math.abs(r.samples[2].pts[0].x - expectX) < 0.5, `填补 ${r.samples[2].pts[0].x} 期望≈${expectX}`);
  // 逐锚 conf：跟丢帧保留原始低值（渲染端据此退出当帧求解）
  const idx0 = r.anchors.findIndex((a) => a.x === tracked[0][0].x && a.y === tracked[0][0].y);
  assert.ok(idx0 >= 0, '锚点 0 应幸存');
  assert.ok(r.samples[2].confs && r.samples[2].confs[idx0] <= 0.1, '跟丢帧逐锚 conf 应为低值');
  assert.ok(r.samples[0].confs && r.samples[0].confs[idx0] >= 0.9, '有效帧逐锚 conf 应为高值');
});

t('assembleGroundTrack：参考帧/极值帧有效锚点不足 4 → RANSAC 无解返回 null', () => {
  const anchors: Vec2[] = [
    {x: 100, y: 200}, {x: 220, y: 190}, {x: 340, y: 205}, {x: 400, y: 250},
    {x: 160, y: 260}, {x: 300, y: 240},
  ];
  const nFrames = 8;
  const tracked = anchors.map((a) =>
    Array.from({length: nFrames}, (_, i) => {
      const q = applyKnown(hOf(i), a);
      return {t: i / 15, x: q.x, y: q.y};
    }));
  const confs = tracked.map(() => Array.from({length: nFrames}, () => 0.95));
  // 参考帧只有 3 个锚点可信 → 有效对应 <4 → RANSAC null → 组装失败
  confs.forEach((c) => { c[0] = 0.1; });
  confs[0][0] = 0.95; confs[1][0] = 0.95; confs[2][0] = 0.95;
  assert.equal(assembleGroundTrack(tracked, confs), null);
});

t('assembleGroundTrack：近共面污染点被保留时残差信号升高（质量黄灯依据）', () => {
  // 恰好 4 个幸存锚点时逐帧残差恒为 0（4 点总可精确拟合单应，无信息量）——
  // 残差信号只在 ≥5 锚点时有效。本用例：5 个精确共面 + 1 个偏移 ~2.5px 的
  // 近共面点（< 4px 内点阈值被保留），过约束拟合下 meanResidualPx 显著 > 0。
  const anchors: Vec2[] = [
    {x: 100, y: 200}, {x: 260, y: 185}, {x: 400, y: 215},
    {x: 180, y: 265}, {x: 330, y: 255},
    {x: 300, y: 225}, // 近共面污染点
  ];
  const nFrames = 8;
  const tracked = anchors.map((a, p) =>
    Array.from({length: nFrames}, (_, i) => {
      const q = applyKnown(hOf(i), a);
      const off = p === 5 ? 2.5 + 0.4 * Math.sin(i) : 0;
      return {t: i / 15, x: q.x + off, y: q.y + off * 0.6};
    }));
  const confs = tracked.map(() => Array.from({length: nFrames}, () => 0.95));
  const r = assembleGroundTrack(tracked, confs);
  assert.ok(r);
  assert.equal(r.rejected, 0, '偏移 <4px 的近共面点会被保留');
  assert.equal(r.anchors.length, 6);
  assert.ok(r.meanResidualPx > 0.05, `过约束残差应可见（实得 ${r.meanResidualPx}，干净场景 ~1e-9）`);
});

// ===== ⑦ 自动选锚 =====
t('autoPickGroundAnchors：只选 yFrom 以下的高纹理区，且满足最小间距', () => {
  const W = 480; const H = 270;
  const frame = noiseFrame(W, H, 5);
  // 抹平成低纹理底
  frame.data.fill(128);
  // 三块高能量纹理（y > 0.35*270 ≈ 94）+ 一块在上方（应被忽略）
  const stamp = (cx: number, cy: number, seed: number) => {
    const rnd = lcg(seed);
    for (let y = cy - 20; y < cy + 20; y++) {
      for (let x = cx - 20; x < cx + 20; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        frame.data[y * W + x] = rnd() * 255;
      }
    }
  };
  stamp(120, 160, 21); stamp(340, 190, 22); stamp(230, 225, 23); stamp(240, 60, 24); // 最后一块在上方
  const picks = autoPickGroundAnchors(frame);
  assert.ok(picks.length >= 3 && picks.length <= 10, ` picks ${picks.length}`);
  assert.ok(picks.every((p) => p.y >= Math.floor(H * 0.35) - 1), '全部位于地面区域');
  const minDist = W * 0.12;
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      assert.ok(Math.hypot(picks[i].x - picks[j].x, picks[i].y - picks[j].y) >= minDist - 1e-6,
        `锚点 ${i}/${j} 间距不足`);
    }
  }
  // 至少两个锚点落在三块纹理附近（±60px）
  const nearTextured = picks.filter((p) =>
    [{x: 120, y: 160}, {x: 340, y: 190}, {x: 230, y: 225}].some((c) => Math.hypot(p.x - c.x, p.y - c.y) < 60));
  assert.ok(nearTextured.length >= 2, `高纹理命中 ${nearTextured.length}/${picks.length}`);
});

// ===== ⑧ sidecar 校验 =====
t('validateGroundTrackFile：合法结构与各损坏变体', () => {
  const good = {
    version: 1, videoWidth: 1920, videoHeight: 1080, sourceFps: 30, sampleFps: 15,
    anchors: [{x: 1, y: 2}, {x: 3, y: 4}, {x: 5, y: 6}, {x: 7, y: 8}],
    anchorConf: [0.9, 0.9, 0.8, 0.7],
    samples: [{t: 0, pts: [{x: 1, y: 2}, {x: 3, y: 4}, {x: 5, y: 6}, {x: 7, y: 8}], conf: 1, confs: [1, 1, 1, 1]}],
    quality: {lostRatio: 0, meanResidualPx: 0.5, rejected: 0},
  };
  assert.ok(validateGroundTrackFile(good));
  assert.equal(validateGroundTrackFile({...good, version: 2}), null);
  assert.equal(validateGroundTrackFile({...good, anchors: [{x: 1, y: 2}]}), null);
  assert.equal(validateGroundTrackFile({...good, samples: [{t: 0, pts: [{x: 1, y: 2}], conf: 1}]}), null);
  assert.equal(validateGroundTrackFile({...good, samples: [{t: 0, pts: [{x: NaN, y: 2}, {x: 3, y: 4}, {x: 5, y: 6}, {x: 7, y: 8}], conf: 1}]}), null);
  assert.equal(validateGroundTrackFile({...good, samples: [{t: 0, pts: good.samples[0].pts, conf: 1, confs: [1, 1, 1]}]}), null, 'confs 长度须与 anchors 对齐');
  assert.equal(validateGroundTrackFile('junk'), null);
});

// ===== ⑨ 端到端小闭环：合成帧序列 → 模拟跟踪（解析运动）→ 组装 → 查表 =====
t('闭环：合成缩放+平移运动下 groundMatrix3dAt 全程可解且锚点钉住', () => {
  const anchors: Vec2[] = [
    {x: 100, y: 200}, {x: 220, y: 190}, {x: 340, y: 200}, {x: 460, y: 195},
    {x: 160, y: 250}, {x: 300, y: 255}, {x: 420, y: 250},
  ];
  const nFrames = 10;
  const mk = (i: number) => {
    const z = 1 + i * 0.01;
    const pan = i * 2.5;
    return anchors.map((a) => ({x: a.x * z + pan, y: a.y * z - i * 1.0}));
  };
  const samples = Array.from({length: nFrames}, (_, i) => ({t: i / 15, pts: mk(i), conf: 0.95}));
  const track: GroundTrackData = {anchors, samples};
  let prev: number[] | undefined;
  for (let i = 0; i < nFrames; i++) {
    const got = groundMatrix3dAt(track, 1920, 1080, i / 15, prev);
    assert.ok(got, `帧 ${i} 应可解`);
    prev = got.P;
    // 平面锚点应精确映射回当前帧位置
    for (let p = 0; p < anchors.length; p++) {
      const q = projectPoint(got.P, anchors[p].x, anchors[p].y, 0)!;
      const expect = mk(i)[p];
      assert.ok(Math.hypot(q.x - expect.x, q.y - expect.y) < 0.02,
        `帧 ${i} 锚点 ${p} 偏差 ${Math.hypot(q.x - expect.x, q.y - expect.y)}`);
    }
  }
});

// ===== ⑩ 相机位置反解 / 地面单应限制与逆 / 自动朝向（UI 拖拽 + 朝向修复依据）=====
t('cameraCenterFromP：从解出的 P 反解真实相机中心 C=−Rᵀt（合成场景逐分量一致）', () => {
  const {K, ground, img} = buildScene(); // 相机中心 C=(255,255,300)
  const {P} = solveProjection(K, ground, img)!;
  const C = cameraCenterFromP(P)!;
  assert.ok(Math.hypot(C.x - 255, C.y - 255, C.z - 300) < 1e-6, `C=(${C.x},${C.y},${C.z})`);
  // 奇异（z 行全零）返回 null
  assert.equal(cameraCenterFromP([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]), null);
});

t('homographyFromP + invertH：z=0 限制前向一致，H⁻¹ 图像→地面往返还原', () => {
  const {K, ground, img} = buildScene();
  const {P} = solveProjection(K, ground, img)!;
  const H = homographyFromP(P);
  for (let i = 0; i < ground.length; i++) {
    const q = applyH(H, ground[i])!;
    assert.ok(Math.hypot(q.x - img[i].x, q.y - img[i].y) < 1e-4, `前向 ${i}`);
    const g = applyH(invertH(H)!, img[i])!;
    assert.ok(Math.hypot(g.x - ground[i].x, g.y - ground[i].y) < 1e-4, `回程 ${i}`);
  }
  assert.equal(invertH([1, 2, 3, 2, 4, 6, 3, 6, 9]), null, '奇异矩阵返回 null');
});

t('autoYawTowardCamera：行走机位 0° / 俯拍(相机投影在元素上方)翻 180° / 相机在右侧 −90°', () => {
  const walk = autoYawTowardCamera({x: 320, y: 700, z: 300}, 320, 430);
  assert.ok(Math.abs(walk) < 1e-9, `${walk}`);
  const topDown = autoYawTowardCamera({x: 320, y: 180, z: 300}, 320, 430);
  assert.ok(Math.abs(Math.abs(topDown) - 180) < 1e-9, `${topDown}`);
  const right = autoYawTowardCamera({x: 900, y: 430, z: 300}, 320, 430);
  assert.ok(Math.abs(right + 90) < 1e-9, `${right}`);
});

t('autoYawTowardCamera：随机位姿面板正面恒朝相机（front·(cam−el) > 0，200 组）', () => {
  const rnd = lcg(99);
  for (let i = 0; i < 200; i++) {
    const cam = {x: rnd() * 1280, y: rnd() * 720, z: 100};
    const gx = rnd() * 1280;
    const gy = rnd() * 720;
    const rad = (autoYawTowardCamera(cam, gx, gy) * Math.PI) / 180;
    // yaw=0 面板正面朝 +y（画面下方）→ rotateZ 后 front = (−sin, cos)
    const front = {x: -Math.sin(rad), y: Math.cos(rad)};
    assert.ok(front.x * (cam.x - gx) + front.y * (cam.y - gy) > 0, `i=${i}`);
  }
});

t('autoYawScreenUpright：恒等 0° / 纯旋转反补偿 −θ / 符号翻转与 180° 翻转鲁棒', () => {
  assert.equal(autoYawScreenUpright([1, 0, 0, 0, 1, 0, 0, 0, 1]), 0);
  for (const th of [0.3, -0.8, 1.9]) {
    const c = Math.cos(th), s = Math.sin(th);
    // 相机绕竖轴转 θ：H 线性部分 = R(θ) → 文字反补偿 −θ 后画面内正立
    const yaw = autoYawScreenUpright([c, -s, 0, s, c, 0, 0, 0, 1]);
    assert.ok(Math.abs(yaw + (th * 180) / Math.PI) < 1e-9, `θ=${th} → ${yaw}`);
  }
  // H 整体反号（单应差全局尺度）：符号归一后结果不变
  const H = [0.9, 0.2, 5, -0.1, 1.1, -3, 1e-4, -5e-5, 1];
  const a = autoYawScreenUpright(H);
  const b = autoYawScreenUpright(H.map((v) => -v));
  assert.ok(Math.abs(((a - b + 540) % 360) - 180) < 1e-9, `${a} vs ${b}`);
  // 验证语义：文字顶部经 H 后指向画面上方（y 分量 < 0）
  const verify = (h: number[], yawDeg: number) => {
    const r = (yawDeg * Math.PI) / 180;
    const top = {x: Math.sin(r), y: -Math.cos(r)};
    const vy = h[3] * top.x + h[4] * top.y;
    const vx = h[0] * top.x + h[1] * top.y;
    assert.ok(vy < 0 && Math.abs(vx) < 1e-6, `yaw=${yawDeg} v=(${vx},${vy})`);
  };
  verify(H, a);
  verify([0, 1, 0, -1, 0, 0, 0, 0, 1], autoYawScreenUpright([0, 1, 0, -1, 0, 0, 0, 0, 1]));
});

console.log(`===== ground-track ${passed} 项全部通过 =====`);

// ====== 地面元素工具参数校验（三轴姿态/厚度字段）======
import {
  validateAddGroundTextArgs,
  validateAddGroundShapeArgs,
  validateUpdateGroundElementArgs,
} from '../../src/shared/llm-tools.ts';

t('地面元素工具校验：pitch/roll/depth 合法透传与钳制', () => {
  const ok = validateAddGroundTextArgs({
    segmentIndex: 0, text: '片语', form: 'extruded',
    yawDeg: 30, pitchDeg: 45, rollDeg: -15, depth: 2, color: '#A0B1C2',
  });
  assert.ok(ok.ok, JSON.stringify(ok));
  if (ok.ok) {
    assert.equal(ok.args.pitchDeg, 45);
    assert.equal(ok.args.rollDeg, -15);
    assert.equal(ok.args.depth, 2);
    assert.equal(ok.args.color, '#a0b1c2');
  }
  // 超范围钳制
  const clamped = validateAddGroundShapeArgs({
    segmentIndex: 0, form: 'box', pitchDeg: 120, rollDeg: 270, depth: 9,
  });
  assert.ok(clamped.ok, JSON.stringify(clamped));
  if (clamped.ok) {
    assert.equal(clamped.args.pitchDeg, 90);
    assert.equal(clamped.args.rollDeg, 180);
    assert.equal(clamped.args.depth, 3);
  }
  // 非数字报错
  const bad = validateAddGroundTextArgs({segmentIndex: 0, text: 'x', form: 'flat', pitchDeg: 'tilt'});
  assert.ok(!bad.ok && bad.errors.some((e) => e.includes('pitchDeg')), JSON.stringify(bad));
  const badDepth = validateAddGroundShapeArgs({segmentIndex: 0, form: 'cone', depth: '厚'});
  assert.ok(!badDepth.ok && badDepth.errors.some((e) => e.includes('depth')), JSON.stringify(badDepth));
  // update：仅传新字段也算有效 patch
  const upd = validateUpdateGroundElementArgs({segmentIndex: 0, id: 'ge-1', pitchDeg: 10});
  assert.ok(upd.ok, JSON.stringify(upd));
  const updEmpty = validateUpdateGroundElementArgs({segmentIndex: 0, id: 'ge-1'});
  assert.ok(!updEmpty.ok, '空 patch 应报错');
});
