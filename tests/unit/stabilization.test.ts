/**
 * 跟踪稳定纯函数单测：块匹配跟踪、自动选点、原始采样、平滑、缩放求解、CSS 方向约定
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/stabilization.test.ts
 */
import assert from 'node:assert/strict';
import {
  autoPickPoint,
  buildRawSamples,
  capZoom,
  correctionToCss,
  requiredZoom,
  sampleCorrectionAt,
  smoothTrack,
  solveStabilization,
  trackPatch,
  type FrameGray,
  type StabCorrection,
  type StabSample,
} from '../../src/shared/stabilization.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

/** 确定性伪随机（LCG），合成纹理用 */
const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
};

/** 随机纹理帧（1/4 分辨率噪声上采样——低频纹理更接近真实画面，NCC 行为稳定） */
const noiseFrame = (w: number, h: number, seed = 42): FrameGray => {
  const rnd = lcg(seed);
  const sw = Math.ceil(w / 4);
  const sh = Math.ceil(h / 4);
  const small = new Float32Array((sw + 1) * (sh + 1));
  for (let i = 0; i < small.length; i++) small[i] = rnd() * 255;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x / 4;
      const sy = y / 4;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const at = (ix: number, iy: number) => small[iy * (sw + 1) + ix];
      data[y * w + x] = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
        at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    }
  }
  return {data, width: w, height: h};
};

/** 双线性采样（小数坐标取像素值） */
const sampleAt = (f: FrameGray, x: number, y: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ix: number, iy: number) =>
    f.data[Math.min(f.height - 1, Math.max(0, iy)) * f.width + Math.min(f.width - 1, Math.max(0, ix))];
  return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
};

/** 整帧平移（内容移动 dx,dy；边缘用背景灰填充） */
const shiftFrame = (f: FrameGray, dx: number, dy: number, bg = 128): FrameGray => {
  const out = new Float32Array(f.width * f.height).fill(bg);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sy >= 0 && sx < f.width && sy < f.height) {
        out[y * f.width + x] = sampleAt(f, sx, sy);
      }
    }
  }
  return {data: out, width: f.width, height: f.height};
};

console.log('stabilization:');

// ===== ① trackPatch：已知平移找回 =====
t('trackPatch：整体移位 3.5px 的合成帧，找回位移误差 <0.6px', () => {
  const f1 = noiseFrame(128, 128, 7);
  const f2 = shiftFrame(f1, 3.5, -2);
  const r = trackPatch(f1, f2, 64, 64);
  assert.ok(r.score > 0.9, `NCC 峰值应接近 1，实得 ${r.score}`);
  assert.ok(Math.abs(r.nx - 67.5) < 0.6, `nx 期望 67.5，实得 ${r.nx}`);
  assert.ok(Math.abs(r.ny - 62) < 0.6, `ny 期望 62，实得 ${r.ny}`);
});

t('trackPatch：大位移（粗层 ±16 粗像素覆盖）与亚像素精度', () => {
  const f1 = noiseFrame(128, 128, 9);
  const f2 = shiftFrame(f1, 10.25, 6.75);
  const r = trackPatch(f1, f2, 60, 60);
  assert.ok(Math.abs(r.nx - 70.25) < 0.6, `nx 期望 70.25，实得 ${r.nx}`);
  assert.ok(Math.abs(r.ny - 66.75) < 0.6, `ny 期望 66.75，实得 ${r.ny}`);
});

t('trackPatch：点出界返回 score=-2 哨兵；纯色块低置信', () => {
  const f1 = noiseFrame(64, 64, 11);
  const f2 = shiftFrame(f1, 1, 1);
  const oob = trackPatch(f1, f2, 2, 2); // patch 24 放不进
  assert.equal(oob.score, -2);
  const flat: FrameGray = {data: new Float32Array(64 * 64).fill(128), width: 64, height: 64};
  const r = trackPatch(flat, flat, 32, 32);
  assert.ok(r.score <= 0.01, `纯色块 NCC 应≈0，实得 ${r.score}`);
});

// ===== ② autoPickPoint：选纹理最强区，避开边缘/四角/排除区 =====
t('autoPickPoint：选中纹理块中心附近，遵守边缘/排除约束', () => {
  const flat: FrameGray = {data: new Float32Array(200 * 200).fill(100), width: 200, height: 200};
  // 在 (120, 90) 处放一块 32×32 强纹理（x 104..136，y 74..106）
  const rnd = lcg(3);
  for (let y = 74; y < 106; y++) {
    for (let x = 104; x < 136; x++) flat.data[y * 200 + x] = rnd() * 255;
  }
  const p = autoPickPoint(flat, {gridStep: 8});
  assert.ok(Math.abs(p.x - 120) <= 16 && Math.abs(p.y - 90) <= 16, `应在纹理块附近，实得 (${p.x},${p.y})`);
  assert.ok(p.x >= 20 && p.x <= 180 && p.y >= 20 && p.y <= 180, '距边缘应 ≥10%');
  // 排除纹理块后只能选别处（次强=全平，退回某个合法网格点）
  const p2 = autoPickPoint(flat, {gridStep: 8, exclude: [{x: 120, y: 90, r: 40}]});
  assert.ok(Math.hypot(p2.x - 120, p2.y - 90) >= 40 - 8, `应避开排除区，实得 (${p2.x},${p2.y})`);
});

// ===== ③ buildRawSamples：双点旋转/缩放 =====
t('buildRawSamples：单点位移；双点连线角差与距离比正确', () => {
  const init = [{x: 100, y: 100}, {x: 200, y: 100}]; // 初始连线水平，距离 100，质心 (150,100)
  const ang = Math.PI / 6; // 内容顺时针转 30°（y 向下坐标）
  // 第 2 帧：质心平移到 (160,105)，两点绕质心转 30° 且距离拉到 150（×1.5）
  const c = {x: 160, y: 105};
  const arm = 75; // 150/2
  const tracked = [
    [{t: 0, x: 100, y: 100}, {t: 1 / 15, x: c.x - arm * Math.cos(ang), y: c.y - arm * Math.sin(ang)}],
    [{t: 0, x: 200, y: 100}, {t: 1 / 15, x: c.x + arm * Math.cos(ang), y: c.y + arm * Math.sin(ang)}],
  ];
  const confs = [[1, 0.9], [1, 0.9]];
  const samples = buildRawSamples(tracked, init, confs);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].dx, 0);
  assert.equal(samples[0].rot, 0);
  assert.equal(samples[0].scale, 1);
  // 位移 (10,5)；连线角 +30°；距离 150 → 比 1.5
  assert.ok(Math.abs(samples[1].dx - 10) < 1e-9 && Math.abs(samples[1].dy - 5) < 1e-9,
    `位移期望 (10,5)，实得 (${samples[1].dx},${samples[1].dy})`);
  assert.ok(Math.abs(samples[1].rot - ang) < 1e-9, `rot 期望 ${ang}，实得 ${samples[1].rot}`);
  assert.ok(Math.abs(samples[1].scale - 1.5) < 1e-9);
});

t('buildRawSamples：跟丢帧线性插值填补，conf 保留低值标记', () => {
  const init = [{x: 50, y: 50}];
  const tracked = [[
    {t: 0, x: 50, y: 50},
    {t: 1, x: 999, y: 999}, // 跟丢（坏值应被插值替换）
    {t: 2, x: 70, y: 50},
  ]];
  const confs = [[1, 0.1, 1]];
  const samples = buildRawSamples(tracked, init, confs);
  assert.ok(Math.abs(samples[1].dx - 10) < 1e-9, `插值应得中点位移 10，实得 ${samples[1].dx}`);
  assert.equal(samples[1].conf, 0.1); // 低值标记保留
});

// ===== ④ smoothTrack：正弦抖动残余 =====
t('smoothTrack：高频正弦抖动经校正后残余振幅 <20%', () => {
  const fps = 15;
  const n = 90; // 6s
  const samples: StabSample[] = [];
  for (let i = 0; i < n; i++) {
    // 抖动：周期 4 采样（3.75Hz）振幅 10px + 低频缓动（有意运动，应保留）
    const jitter = 10 * Math.sin((i * Math.PI) / 2);
    const drift = i * 0.3;
    samples.push({t: i / fps, dx: jitter + drift, dy: 0, rot: 0, scale: 1, conf: 1});
  }
  const corrections = smoothTrack(samples, fps, 0.53); // 窗 9 采样 ≫ 抖动周期
  // 残余 = 原始 + 校正（校正值带施加方向，见 shared/stabilization.ts 头注）
  const residual = samples.map((s, i) => s.dx + corrections[i].cx);
  const amp = (arr: number[]) => (Math.max(...arr) - Math.min(...arr)) / 2;
  // 去趋势（0.3i 缓动）后量抖动振幅，避开两端截断区
  const detrended = residual.slice(15, 75).map((v, k) => v - (k + 15) * 0.3);
  const jitterOnly = samples.slice(15, 75).map((s, k) => s.dx - (k + 15) * 0.3);
  const origAmp = amp(jitterOnly);
  assert.ok(origAmp > 9, `原始抖动振幅应≈10，实得 ${origAmp}`);
  assert.ok(amp(detrended) < origAmp * 0.2, `残余振幅 ${amp(detrended)} 应 < 原始的 20%（${origAmp * 0.2}）`);
  // 低频缓动应基本保留（残余均值仍随时间上行）
  const midResid = residual.slice(15, 75);
  assert.ok(midResid[midResid.length - 1] - midResid[0] > 10, '缓动分量应保留');
});

// ===== ⑤ requiredZoom：已知校正量的覆盖缩放 =====
t('requiredZoom：纯平移校正的精确期望值 + 旋转增大需求 + safety 生效', () => {
  // 1920×1080，单帧 cx=96（半宽 960 的 10%）：覆盖需 zoom = (960+96)/960 = 1.1
  const corr: StabCorrection[] = [{t: 0, cx: 96, cy: 0, crot: 0, cscale: 1}];
  const z = requiredZoom(corr, 1920, 1080, 1.06);
  assert.ok(Math.abs(z - 1.106) < 1e-9, `期望 1.106，实得 ${z}`);
  // 加旋转后需求单调增大
  const corrRot: StabCorrection[] = [{t: 0, cx: 96, cy: 0, crot: 0.1, cscale: 1}];
  assert.ok(requiredZoom(corrRot, 1920, 1080, 1.06) > z);
  // cscale<1 的帧吃掉余量
  const corrShrink: StabCorrection[] = [{t: 0, cx: 96, cy: 0, crot: 0, cscale: 0.95}];
  assert.ok(requiredZoom(corrShrink, 1920, 1080, 1.06) > z);
  // 零校正 → zoom=1；capZoom 封顶
  assert.equal(requiredZoom([{t: 0, cx: 0, cy: 0, crot: 0, cscale: 1}], 1920, 1080), 1);
  assert.equal(capZoom(1.4, 1.25), 1.25);
  assert.equal(capZoom(0.9, 1.25), 1);
});

// ===== ⑥ sampleCorrectionAt：插值与端点钳制 =====
t('sampleCorrectionAt：二分+线性插值，端点钳制，空表回恒等', () => {
  const corr: StabCorrection[] = [
    {t: 0, cx: 0, cy: 0, crot: 0, cscale: 1},
    {t: 1, cx: 10, cy: -4, crot: 0.2, cscale: 0.9},
    {t: 2, cx: 20, cy: -8, crot: 0.4, cscale: 0.8},
  ];
  const mid = sampleCorrectionAt(corr, 0.5);
  assert.ok(Math.abs(mid.cx - 5) < 1e-9 && Math.abs(mid.cy + 2) < 1e-9);
  assert.ok(Math.abs(mid.crot - 0.1) < 1e-9 && Math.abs(mid.cscale - 0.95) < 1e-9);
  assert.deepEqual(sampleCorrectionAt(corr, -1), corr[0]);
  assert.deepEqual(sampleCorrectionAt(corr, 99), corr[2]);
  const id = sampleCorrectionAt([], 3);
  assert.deepEqual(id, {t: 3, cx: 0, cy: 0, crot: 0, cscale: 1});
});

// ===== ⑦ correctionToCss：方向约定（画面右移 → translateX 为负）=====
t('correctionToCss：画面内容右移 → translateX 负值拉回；rotate/scale 直通', () => {
  // 画面右移 dx=+19.2（平滑轨迹为 0）→ cx = 平滑−原始 = −19.2
  const css = correctionToCss({t: 0, cx: -19.2, cy: 10.8, crot: Math.PI / 2, cscale: 1.02}, 1920, 1080, 1.1);
  assert.ok(css.translateXPct < 0, '画面右移时 translateX 必须为负（把画面向左拉回）');
  assert.ok(Math.abs(css.translateXPct - -1) < 1e-9, `−19.2/1920 = −1%，实得 ${css.translateXPct}`);
  assert.ok(Math.abs(css.translateYPct - 1) < 1e-9, `10.8/1080 = +1%，实得 ${css.translateYPct}`);
  assert.ok(Math.abs(css.rotateDeg - 90) < 1e-9, 'crot 弧度直接转角度（同号）');
  assert.ok(Math.abs(css.scale - 1.1 * 1.02) < 1e-9, 'scale = zoom × cscale');
});

// ===== ⑧ solveStabilization：超限降 smoothSec / 封顶 =====
t('solveStabilization：所需 zoom 超 maxZoom 时减半 smoothSec，最终 zoom ≤ maxZoom', () => {
  const fps = 15;
  const n = 120;
  // 高频大振幅抖动（周期 4 采样，振幅 300px）：强平滑下校正量≈原始 → zoom 超限
  const mk = (amp: number): StabSample[] =>
    Array.from({length: n}, (_, i) => ({t: i / fps, dx: amp * Math.sin((i * Math.PI) / 2), dy: 0, rot: 0, scale: 1, conf: 1}));
  const solved = solveStabilization(mk(300), fps, {smoothSec: 1, maxZoom: 1.25, videoWidth: 1920, videoHeight: 1080});
  assert.ok(solved.zoom <= 1.25, `zoom ${solved.zoom} 应 ≤ maxZoom`);
  assert.ok(solved.smoothSecUsed < 1, '应发生过 smoothSec 减半');
  assert.ok(solved.smoothSecUsed >= 0.1);
  assert.equal(solved.corrections.length, n);

  // 极端：振幅大到 smoothSec=0.1 也压不进 maxZoom → capped=true 且 zoom 封顶
  const extreme = solveStabilization(mk(900), fps, {smoothSec: 1, maxZoom: 1.25, videoWidth: 1920, videoHeight: 1080});
  assert.equal(extreme.capped, true);
  assert.equal(extreme.zoom, 1.25);
  assert.equal(extreme.smoothSecUsed, 0.1);

  // 温和：直接满足，不降级不封顶
  const mild = solveStabilization(mk(20), fps, {smoothSec: 0.5, maxZoom: 1.25, videoWidth: 1920, videoHeight: 1080});
  assert.equal(mild.capped, false);
  assert.equal(mild.smoothSecUsed, 0.5);
  assert.ok(mild.zoom < 1.1, `温和抖动 zoom 应≈1，实得 ${mild.zoom}`);
});

console.log(`\n===== ${passed} 项全部通过 =====`);
