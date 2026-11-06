/**
 * 三维场景包注册表（three-scenes.ts）+ 模板 sceneStyle 参数接线单测
 *
 * v28 运动模板/场景解耦：七款 3D 模板 = 纯运动（相机+展板动线），环境 = 场景包。
 * 本测试锚定：注册表完整性、sceneStyle 参数挂接与每款模板的原生场景默认值
 * （老工程不带参数时观感与拆分前一致的兼容承诺）。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/three-scenes.test.ts
 */
import assert from 'node:assert/strict';
import {NATIVE_SCENE, THREE_SCENES, clampSceneIndex, sceneHallSurfaces, sceneIsLight, sceneParamLabel} from '../../src/shared/three-scenes.ts';
import {
  CAMERA_JOURNEY_3D_PARAMS,
  CITY_SCAPE_3D_PARAMS,
  GALLERY_HALL_3D_PARAMS,
  ORBIT_CAROUSEL_3D_PARAMS,
  SPIRAL_ATRIUM_3D_PARAMS,
  STARFIELD_3D_PARAMS,
  TIME_TUNNEL_3D_PARAMS,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('three-scenes:');

t('场景清单完整且 id 唯一（10 档：星空/银河/都市/乡村/古建/山水/水墨/虚空/纯净/棱镜）', () => {
  assert.deepEqual(THREE_SCENES.map((s) => s.id), ['star', 'galaxy', 'city', 'countryside', 'ancient', 'landscape', 'inkwash', 'journey', 'plain', 'prism']);
  assert.equal(new Set(THREE_SCENES.map((s) => s.id)).size, THREE_SCENES.length);
  THREE_SCENES.forEach((s) => {
    assert.ok(s.label.length > 0);
    if (s.css !== null) assert.ok(s.css.length > 8);
  });
});

t('棱镜是唯一条纹场景（追加在末档不移位老工程档位；深色底非 light）', () => {
  const prismIdx = THREE_SCENES.length - 1;
  assert.equal(THREE_SCENES[prismIdx].id, 'prism');
  const css = THREE_SCENES[prismIdx].css ?? '';
  assert.ok(css.includes('repeating-linear-gradient'), '棱镜底色应为竖向条带渐变');
  ['rgba(45,212,191', 'rgba(232,121,249', 'rgba(167,139,250'].forEach((h) => assert.ok(css.includes(h), `条带缺色 ${h}`));
  assert.ok(!THREE_SCENES[prismIdx].light);
  assert.equal(sceneIsLight(prismIdx), false);
  // 老工程兼容：前 9 档含义不变
  assert.deepEqual(THREE_SCENES.slice(0, 9).map((s) => s.id), ['star', 'galaxy', 'city', 'countryside', 'ancient', 'landscape', 'inkwash', 'journey', 'plain']);
});

t('水墨是唯一亮色场景（纸底），其余全部深色底', () => {
  assert.deepEqual(THREE_SCENES.filter((s) => s.light).map((s) => s.id), ['inkwash']);
  assert.equal(sceneIsLight(6), true);
  assert.equal(sceneIsLight(0), false);
  assert.equal(sceneIsLight(99), false); // 越界安全回退
  assert.equal(sceneIsLight(NaN), false);
});

t('clampSceneIndex：越界回 0、小数取整、非法值回 0', () => {
  assert.equal(clampSceneIndex(0), 0);
  assert.equal(clampSceneIndex(THREE_SCENES.length - 1), THREE_SCENES.length - 1);
  assert.equal(clampSceneIndex(THREE_SCENES.length), 0);
  assert.equal(clampSceneIndex(-3), 0);
  assert.equal(clampSceneIndex(2.6), 3);
  assert.equal(clampSceneIndex(NaN), 0);
});

t('档位标签由注册表拼出（单一数据源，含全部场景名）', () => {
  const label = sceneParamLabel();
  assert.ok(label.startsWith('场景(0'));
  THREE_SCENES.forEach((s, i) => assert.ok(label.includes(`${i}${s.label}`), `标签缺 ${i}${s.label}`));
});

t('原生场景映射：旅程=虚空 / 星域=星空 / 都市=城市，其余四款=纯净（封闭/自备地板）', () => {
  const idOf = (i: number) => THREE_SCENES[i].id;
  assert.equal(idOf(NATIVE_SCENE.CameraJourney3D), 'journey');
  assert.equal(idOf(NATIVE_SCENE.Starfield3D), 'star');
  assert.equal(idOf(NATIVE_SCENE.CityScape3D), 'city');
  for (const tid of ['GalleryHall3D', 'OrbitCarousel3D', 'TimeTunnel3D', 'SpiralAtrium3D']) {
    assert.equal(idOf(NATIVE_SCENE[tid]), 'plain');
  }
});

t('艺廊装潢色：水墨→纸底亮色，棱镜→紫夜底，纯净/未知→原生暗色', () => {
  const ink = sceneHallSurfaces(clampSceneIndex(THREE_SCENES.findIndex((s) => s.id === 'inkwash')));
  assert.ok(parseInt(ink.wall.slice(1, 3), 16) > 0x80);
  const prism = sceneHallSurfaces(THREE_SCENES.length - 1);
  assert.deepEqual(prism, {floor: '#140E26', wall: '#1A1233', ceiling: '#0E0A1C', endWall: '#171030'});
  const plain = sceneHallSurfaces(THREE_SCENES.findIndex((s) => s.id === 'plain'));
  assert.deepEqual(plain, {floor: '#0A0F18', wall: '#0D1320', ceiling: '#070B12', endWall: '#0B101B'});
  assert.deepEqual(sceneHallSurfaces(99), plain);
});

const SPEC_BY_TEMPLATE: Record<string, typeof CAMERA_JOURNEY_3D_PARAMS> = {
  CameraJourney3D: CAMERA_JOURNEY_3D_PARAMS,
  Starfield3D: STARFIELD_3D_PARAMS,
  CityScape3D: CITY_SCAPE_3D_PARAMS,
  GalleryHall3D: GALLERY_HALL_3D_PARAMS,
  OrbitCarousel3D: ORBIT_CAROUSEL_3D_PARAMS,
  TimeTunnel3D: TIME_TUNNEL_3D_PARAMS,
  SpiralAtrium3D: SPIRAL_ATRIUM_3D_PARAMS,
};

t('七款模板都有 sceneStyle：范围覆盖注册表、默认=原生场景、标签同源', () => {
  for (const [tid, specs] of Object.entries(SPEC_BY_TEMPLATE)) {
    const spec = specs.find((s) => s.key === 'sceneStyle');
    assert.ok(spec, `${tid} 缺 sceneStyle 参数`);
    assert.equal(spec.min, 0);
    assert.equal(spec.max, THREE_SCENES.length - 1);
    assert.equal(spec.step, 1);
    assert.equal(spec.label, sceneParamLabel());
    assert.equal(spec.default, NATIVE_SCENE[tid], `${tid} 默认档应为原生场景`);
  }
});

t('参数键名不重复（sceneStyle 挂入不破坏既有规格）', () => {
  for (const [tid, specs] of Object.entries(SPEC_BY_TEMPLATE)) {
    const keys = specs.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, `${tid} 参数键重复`);
  }
});

console.log(`three-scenes: ${passed} 项通过`);
if (process.exitCode) process.exit(process.exitCode);
