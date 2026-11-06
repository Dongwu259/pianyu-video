/**
 * cam-ease 单测：镜头缓动三档族 / 站级微差 / 四款 3D 场景模板的 camSpeed·camEase 参数注册
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/cam-ease.test.ts
 */
import assert from 'node:assert/strict';
import {sm, smx, easeCam, stationJitter, CAM_SPEED, CAM_SPEED_TRAVEL, travelScaleOf} from '../../src/remotion/three/rig-utils.ts';
import {
  CAMERA_JOURNEY_3D_PARAMS,
  GALLERY_HALL_3D_PARAMS,
  ORBIT_CAROUSEL_3D_PARAMS,
  TIME_TUNNEL_3D_PARAMS,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('cam-ease:');

t('easeCam 三档端点：0→0、1→1（保证相位边界连续）', () => {
  for (const p of [0, 1, 2]) {
    assert.equal(easeCam(0, p), 0);
    assert.equal(easeCam(1, p), 1);
  }
});

t('easeCam 三档单调递增（不回退，无视觉抖动）', () => {
  for (const p of [0, 1, 2]) {
    let prev = -1;
    for (let k = 0; k <= 100; k++) {
      const v = easeCam(k / 100, p);
      assert.ok(v >= prev - 1e-12, `p=${p} k=${k} ${prev}→${v}`);
      prev = v;
    }
  }
});

t('缓动档起止更缓：五次(0.1) < 三次(0.1) < smoothstep(0.1)', () => {
  const cubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const quint = (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2);
  assert.ok(quint(0.1) < cubic(0.1) && cubic(0.1) < sm(0.1));
  for (const f of [cubic, quint]) {
    assert.equal(f(0), 0);
    assert.equal(f(1), 1);
  }
});

t('easeCam 档位映射：0=sm、1=三次in-out、2=五次in-out；越界钳制', () => {
  const cubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const quint = (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  for (const x of [0, 0.2, 0.5, 0.8, 1]) {
    assert.ok(near(easeCam(x, 0), sm(x)));
    assert.ok(near(easeCam(x, 1), cubic(x)));
    assert.ok(near(easeCam(x, 2), quint(x)));
    assert.ok(near(easeCam(x, -3), sm(x))); // 钳到 0
    assert.ok(near(easeCam(x, 9), quint(x))); // 钳到 2
  }
});

t('速度曲线「明显加减速」：峰值速度远超均值，起止速度近零', () => {
  const profile = (p: number): {peak: number; head: number; tail: number} => {
    const N = 300;
    const v: number[] = [];
    for (let i = 0; i < N; i++) v.push(easeCam((i + 1) / N, p) - easeCam(i / N, p));
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return {peak: Math.max(...v) / avg, head: v[0] / avg, tail: v[N - 1] / avg};
  };
  for (const p of [1, 2]) {
    const {peak, head, tail} = profile(p);
    assert.ok(peak > 2.2, `档 ${p} 峰值速度应 ≥2.2× 均值，实际 ${peak.toFixed(2)}`);
    assert.ok(head < 0.1 && tail < 0.1, `档 ${p} 起止速度应近零，实际 ${head.toFixed(3)}/${tail.toFixed(3)}`);
  }
  // 档 2 比档 1 更「慢起慢停」：同起点进度更低
  assert.ok(easeCam(0.1, 2) < easeCam(0.1, 1));
});

t('stationJitter：确定性、值域 [0,1)、随站变化', () => {
  for (let i = 0; i < 8; i++) {
    const v = stationJitter(i, 7);
    assert.equal(v, stationJitter(i, 7)); // 同参同值（逐帧渲染可复现）
    assert.ok(v >= 0 && v < 1, `i=${i} v=${v}`);
  }
  const vals = new Set(Array.from({length: 8}, (_, i) => stationJitter(i, 7)));
  assert.ok(vals.size >= 6, `8 站至少 6 个不同微差值，实际 ${vals.size}`);
  assert.notEqual(stationJitter(0, 7), stationJitter(0, 13)); // salt 区分用途
});

t('CAM_SPEED 三档递增且含标准档 1', () => {
  assert.equal(CAM_SPEED.length, 3);
  assert.equal(CAM_SPEED[1], 1);
  assert.ok(CAM_SPEED[0] < 1 && CAM_SPEED[2] > 1);
});

t('CAM_SPEED_TRAVEL 三档：舒缓档甩头时间 ×2、迅疾档 ×0.78；travelScaleOf 钳制非法值', () => {
  assert.equal(CAM_SPEED_TRAVEL.length, 3);
  assert.equal(CAM_SPEED_TRAVEL[1], 1);
  assert.ok(CAM_SPEED_TRAVEL[0] > 1 && CAM_SPEED_TRAVEL[2] < 1);
  assert.equal(travelScaleOf(0), 2);
  assert.equal(travelScaleOf(1), 1);
  assert.equal(travelScaleOf(2), 0.78);
  assert.equal(travelScaleOf(9), 0.78);
  assert.equal(travelScaleOf(-3), 2);
  assert.equal(travelScaleOf(NaN), 1);
});

t('3D 场景族（七款）均注册 camSpeed/camEase/dwellRatio（v26 默认放慢：0 舒缓 / 2 慢起慢停 / 2 长驻留）', () => {
  for (const [name, specs] of [
    ['journey', CAMERA_JOURNEY_3D_PARAMS],
    ['gallery', GALLERY_HALL_3D_PARAMS],
    ['carousel', ORBIT_CAROUSEL_3D_PARAMS],
    ['tunnel', TIME_TUNNEL_3D_PARAMS],
    ['city', CITY_SCAPE_3D_PARAMS],
    ['spiral', SPIRAL_ATRIUM_3D_PARAMS],
    ['star', STARFIELD_3D_PARAMS],
  ] as const) {
    const cs = specs.find((s) => s.key === 'camSpeed');
    const ce = specs.find((s) => s.key === 'camEase');
    const dr = specs.find((s) => s.key === 'dwellRatio');
    assert.ok(cs, `${name} 缺 camSpeed`);
    assert.ok(ce, `${name} 缺 camEase`);
    assert.ok(dr, `${name} 缺 dwellRatio`);
    assert.equal(cs?.default, 0, `${name} camSpeed 默认应为 0（舒缓，甩头时间 ×2）`);
    assert.equal(ce?.default, 2, `${name} camEase 默认应为 2（慢起慢停）`);
    assert.equal(dr?.default, 2, `${name} dwellRatio 默认应为 2（长驻留）`);
    assert.equal(cs?.min, 0);
    assert.equal(cs?.max, 2);
    assert.equal(ce?.min, 0);
    assert.equal(ce?.max, 2);
  }
});

t('四款 3D 模板场景特有参数仍在（camSpeed 注入未破坏原参数）', () => {
  assert.ok(CAMERA_JOURNEY_3D_PARAMS.some((s) => s.key === 'lineGlow'));
  assert.ok(GALLERY_HALL_3D_PARAMS.some((s) => s.key === 'spotGlow'));
  assert.ok(ORBIT_CAROUSEL_3D_PARAMS.some((s) => s.key === 'coreGlow'));
  assert.ok(TIME_TUNNEL_3D_PARAMS.some((s) => s.key === 'ringGlow'));
});

// ====== 第十二轮追加：主题色 / 标题字体 / 驻留四档 / 展板分布 ======
import {
  CITY_SCAPE_3D_PARAMS,
  SPIRAL_ATRIUM_3D_PARAMS,
  STARFIELD_3D_PARAMS,
  HERO_3D_TITLE_PARAMS,
} from '../../src/shared/template-registry.ts';
import {THEME_ACCENTS, mixHex} from '../../src/remotion/three/rig-utils.ts';
import {THREE_TITLE_FONT_LABELS} from '../../src/remotion/three/title-fonts.ts';

const ALL_3D_GROUPS = [
  ['journey', CAMERA_JOURNEY_3D_PARAMS],
  ['gallery', GALLERY_HALL_3D_PARAMS],
  ['carousel', ORBIT_CAROUSEL_3D_PARAMS],
  ['tunnel', TIME_TUNNEL_3D_PARAMS],
  ['city', CITY_SCAPE_3D_PARAMS],
  ['spiral', SPIRAL_ATRIUM_3D_PARAMS],
  ['star', STARFIELD_3D_PARAMS],
  ['hero', HERO_3D_TITLE_PARAMS],
] as const;

t('八组 3D 模板均注册 themeColor（默认 0=跟随品牌色）+ titleFont（默认 0=文楷）', () => {
  for (const [name, specs] of ALL_3D_GROUPS) {
    const tc = specs.find((s) => s.key === 'themeColor');
    const tf = specs.find((s) => s.key === 'titleFont');
    assert.ok(tc, `${name} 缺 themeColor`);
    assert.ok(tf, `${name} 缺 titleFont`);
    assert.equal(tc?.default, 0, `${name} themeColor 默认应为 0`);
    assert.equal(tf?.default, 0, `${name} titleFont 默认应为 0`);
    assert.equal(tc?.max, THEME_ACCENTS.length - 1, `${name} themeColor max 应与预设表对齐`);
    assert.equal(tf?.max, THREE_TITLE_FONT_LABELS.length - 1, `${name} titleFont max 应与字体表对齐`);
  }
});

t('THEME_ACCENTS 预设：首项占位品牌色，其余 5 色为合法 hex', () => {
  assert.equal(THEME_ACCENTS.length, 6);
  for (const hex of THEME_ACCENTS.slice(1)) assert.match(hex, /^#[0-9a-f]{6}$/i);
});

t('mixHex：中点混合与端点', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#0a0e18', '#22d3ee', 0), '#0a0e18');
  assert.equal(mixHex('#0a0e18', '#22d3ee', 1), '#22d3ee');
});

t('THREE_TITLE_FONTS：5 档字体注册表', () => {
  assert.equal(THREE_TITLE_FONT_LABELS.length, 5);
  assert.equal(THREE_TITLE_FONT_LABELS[0], '文楷'); // 档 0 兼容旧渲染
});

t('七款场景模板 dwellRatio 扩为四档（0..3），gallery/tunnel/city 注册 panelSides 且默认同侧', () => {
  for (const [name, specs] of ALL_3D_GROUPS) {
    if (name === 'hero') continue;
    const dr = specs.find((s) => s.key === 'dwellRatio');
    assert.equal(dr?.max, 3, `${name} dwellRatio max 应为 3`);
    assert.equal(dr?.default, 2, `${name} dwellRatio 默认 2（长驻留）`);
  }
  for (const [name, specs] of [
    ['gallery', GALLERY_HALL_3D_PARAMS],
    ['tunnel', TIME_TUNNEL_3D_PARAMS],
    ['city', CITY_SCAPE_3D_PARAMS],
  ] as const) {
    const ps = specs.find((s) => s.key === 'panelSides');
    assert.ok(ps, `${name} 缺 panelSides`);
    assert.equal(ps?.default, 0, `${name} panelSides 默认应为 0（同侧，防横跳眩晕）`);
    assert.equal(ps?.max, 1);
  }
  for (const [name, specs] of [
    ['journey', CAMERA_JOURNEY_3D_PARAMS],
    ['carousel', ORBIT_CAROUSEL_3D_PARAMS],
    ['spiral', SPIRAL_ATRIUM_3D_PARAMS],
    ['star', STARFIELD_3D_PARAMS],
  ] as const) {
    assert.ok(!specs.some((s) => s.key === 'panelSides'), `${name} 不应有 panelSides`);
  }
});

t('观感打磨轮：captionSize ×7 + shadowLevel ×4（gallery/city/carousel/spiral）', () => {
  const groups = new Map<string, {specs: {key: string}[]; shadow: boolean}>();
  for (const [name, specs] of ALL_3D_GROUPS) {
    groups.set(name, {specs: specs as unknown as {key: string}[], shadow: specs.some((s) => s.key === 'shadowLevel')});
  }
  for (const [name, g] of groups) {
    if (name === 'hero') continue;
    assert.ok(g.specs.some((s) => s.key === 'captionSize'), `${name} 缺 captionSize`);
  }
  for (const name of ['gallery', 'city', 'carousel', 'spiral']) {
    assert.ok(groups.get(name)?.shadow, `${name} 缺 shadowLevel`);
  }
  for (const name of ['journey', 'tunnel', 'star', 'hero']) {
    assert.ok(!groups.get(name)?.shadow, `${name} 不应有 shadowLevel`);
  }
});

console.log(`cam-ease: ${passed} 项通过`);
