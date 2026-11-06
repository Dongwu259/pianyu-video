/**
 * scene-dress 单测：v27 观感升级的纯函数部分——连接对挑选 / 弧线中点 / 旅程路径曲率 /
 * 三款模板 linkLines 参数注册。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/scene-dress.test.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {pickLinkPairs, arcMid, arcTubeGeometry, journeyControlPoints} from '../../src/remotion/three/scene-dress.tsx';
import {
  CAMERA_JOURNEY_3D_PARAMS,
  CITY_SCAPE_3D_PARAMS,
  STARFIELD_3D_PARAMS,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('scene-dress:');

t('pickLinkPairs：相邻优先，count 钳制，确定性', () => {
  assert.deepEqual(pickLinkPairs(4, 3), [[0, 1], [1, 2], [2, 3]]);
  assert.deepEqual(pickLinkPairs(4, 4), [[0, 1], [1, 2], [2, 3], [0, 2]]);
  assert.deepEqual(pickLinkPairs(4, 99), [[0, 1], [1, 2], [2, 3], [0, 2], [1, 3], [0, 3]]);
  assert.deepEqual(pickLinkPairs(4, 0), []);
  assert.deepEqual(pickLinkPairs(1, 5), []);
  assert.deepEqual(pickLinkPairs(2, 5), [[0, 1]]);
  // 确定性：同参数两次一致
  assert.deepEqual(pickLinkPairs(6, 8), pickLinkPairs(6, 8));
});

t('arcMid / arcTubeGeometry：弧线真的弓出去（不落回弦上）', () => {
  const a = new THREE.Vector3(0, 0, 0);
  const b = new THREE.Vector3(10, 0, 0);
  const ctrl = arcMid(a, b, new THREE.Vector3(0, 3, 0));
  assert.equal(ctrl.y, 3, '控制点 = 弦中点 + bow');
  const geom = arcTubeGeometry(a, b, new THREE.Vector3(0, 3, 0), 0.02, 24, 6);
  const pos = geom.getAttribute('position');
  let maxY = 0;
  for (let k = 0; k < pos.count; k++) maxY = Math.max(maxY, pos.getY(k));
  // 对称二次贝塞尔中点到达 bow 的一半（1.5），显著高于弦（y=0）
  assert.ok(maxY > 1.2 && maxY < 1.8, `管顶应在 1.5 附近（maxY=${maxY.toFixed(2)}）`);
  geom.dispose();
});

t('journeyControlPoints：确定性 + 板间必弯（相邻站位弦偏差 > 0.3）', () => {
  // 多组种子都验证「任意相邻站位之间路径偏离弦」（用户点名：板间不能是直线）
  for (const seed of [1, 42, 20260914, 987654]) {
    const pts = journeyControlPoints(seed, 1, 1);
    assert.equal(pts.length, 9); // 9 控制点
    const again = journeyControlPoints(seed, 1, 1);
    pts.forEach((p, k) => assert.ok(p.equals(again[k]), `种子 ${seed} 确定性`));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const us = [0.12, 0.32, 0.5, 0.68, 0.88]; // 相邻站位曲线参数
    for (let k = 0; k < us.length - 1; k++) {
      const a = curve.getPointAt(us[k]);
      const b = curve.getPointAt(us[k + 1]);
      const chord = b.clone().sub(a);
      let maxDev = 0;
      for (let s = 1; s < 24; s++) {
        const p = curve.getPointAt(us[k] + ((us[k + 1] - us[k]) * s) / 24);
        const dev = p.clone().sub(a).sub(chord.clone().multiplyScalar(s / 24)).length();
        maxDev = Math.max(maxDev, dev);
      }
      assert.ok(maxDev > 0.3, `种子 ${seed} 第 ${k} 板间弦偏差仅 ${maxDev.toFixed(3)}（<0.3 近似直线）`);
    }
  }
});

t('旅程路径：wind 越大弯曲越明显（档位间单调不回退）', () => {
  const devOf = (wind: number): number => {
    const curve = new THREE.CatmullRomCurve3(journeyControlPoints(77, wind, 1), false, 'centripetal');
    const a = curve.getPointAt(0.2);
    const b = curve.getPointAt(0.8);
    const chord = b.clone().sub(a);
    let maxDev = 0;
    for (let s = 1; s < 32; s++) {
      const p = curve.getPointAt(0.2 + (0.6 * s) / 32);
      maxDev = Math.max(maxDev, p.clone().sub(a).sub(chord.clone().multiplyScalar(s / 32)).length());
    }
    return maxDev;
  };
  assert.ok(devOf(2) > devOf(0), '大摆档弯曲幅度应大于平缓档');
});

t('linkLines 参数注册：旅程/城市/星域均有（0-6，默认 3）', () => {
  for (const [name, specs] of [
    ['journey', CAMERA_JOURNEY_3D_PARAMS],
    ['city', CITY_SCAPE_3D_PARAMS],
    ['star', STARFIELD_3D_PARAMS],
  ] as const) {
    const ll = specs.find((s) => s.key === 'linkLines');
    assert.ok(ll, `${name} 缺 linkLines`);
    assert.equal(ll?.default, 3, `${name} linkLines 默认 3`);
    assert.equal(ll?.min, 0);
    assert.equal(ll?.max, 6);
  }
});

console.log(`scene-dress: ${passed} 项通过`);
