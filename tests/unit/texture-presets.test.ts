/**
 * 全局质感层预设（shared/texture-presets.ts）单元测试
 *
 * 运行方式：node tests/unit/texture-presets.test.ts
 */

import assert from 'node:assert/strict';
import {TEXTURE_PARAMS, isTextureEmpty} from '../../src/shared/texture-presets.ts';
import {DEFAULT_TEXTURE_PRESET, TEXTURE_PRESET_OPTIONS} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---- 三档齐全 ----
{
  assert.deepEqual(Object.keys(TEXTURE_PARAMS).sort(), ['cinema', 'clean', 'film']);
  ok('clean / film / cinema 三档预设齐全');
}

// ---- clean 完全无效果 ----
{
  assert.ok(isTextureEmpty(TEXTURE_PARAMS.clean));
  ok('clean 档无任何叠加（组件不渲染）');
}

// ---- 参数范围合法 ----
{
  for (const [name, p] of Object.entries(TEXTURE_PARAMS)) {
    for (const key of ['vignette', 'grain', 'tone'] as const) {
      assert.ok(p[key] >= 0 && p[key] <= 1, `${name}.${key} 超出 0..1: ${p[key]}`);
    }
  }
  ok('所有数值参数在 0..1 范围内');
}

// ---- 档位强度递进：cinema ≥ film ----
{
  assert.ok(TEXTURE_PARAMS.film.vignette > 0 && TEXTURE_PARAMS.film.grain > 0);
  assert.ok(TEXTURE_PARAMS.cinema.vignette > TEXTURE_PARAMS.film.vignette);
  assert.ok(TEXTURE_PARAMS.cinema.grain >= TEXTURE_PARAMS.film.grain);
  assert.ok(TEXTURE_PARAMS.cinema.lightLeak && !TEXTURE_PARAMS.film.lightLeak);
  ok('胶片档轻量、电影档更重且独有扫光');
}

// ---- 默认档与 UI 选项一致 ----
{
  assert.equal(DEFAULT_TEXTURE_PRESET, 'film');
  assert.ok(TEXTURE_PRESET_OPTIONS.some((o) => o.value === DEFAULT_TEXTURE_PRESET));
  assert.equal(TEXTURE_PRESET_OPTIONS.length, 3);
  ok('默认质感为胶片且在 UI 选项中');
}

console.log(`texture-presets: ${passed} 项通过`);
