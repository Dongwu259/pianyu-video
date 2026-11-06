/**
 * 舞台底色容器（shared/stage-bg.ts）单元测试：Auto Accent 自动取色映射。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/stage-bg.test.ts
 */

import assert from 'node:assert/strict';

const {autoAccentPaletteIdx, STAGE_PALETTES, stageBackgroundCss, stageCardGlowShadow} = await import('../../src/shared/stage-bg.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('Auto Accent 自动取色:');
{
  assert.equal(autoAccentPaletteIdx(undefined), 6, '无统计 → 石墨兜底');
  assert.equal(autoAccentPaletteIdx({r: 128, g: 128, b: 128}), 6, '纯灰低饱和 → 石墨兜底');
  assert.equal(autoAccentPaletteIdx({r: 245, g: 245, b: 248}), 6, '近白 UI → 石墨兜底');
  ok('兜底：无统计/灰白素材 → 石墨档');

  // 暖橙素材 → 暖琥珀（glow #ffb45c hue ≈35°）
  assert.equal(autoAccentPaletteIdx({r: 214, g: 130, b: 50}), 2, '暖橙 → 暖琥珀');
  // 深蓝素材 → 深空蓝（glow #7c9cff hue ≈227°）
  assert.equal(autoAccentPaletteIdx({r: 52, g: 84, b: 200}), 0, '蓝 → 深空蓝');
  // 青碧素材 → 青碧（glow #4fd1c5 hue ≈174°）
  assert.equal(autoAccentPaletteIdx({r: 40, g: 190, b: 178}), 3, '青碧 → 青碧');
  ok('彩色素材按色相映射最近色板');

  // 返回值必须落在合法下标内（随机扰动 60 组）
  let okAll = true;
  for (let i = 0; i < 60; i++) {
    const idx = autoAccentPaletteIdx({r: Math.random() * 255, g: Math.random() * 255, b: Math.random() * 255});
    if (!Number.isInteger(idx) || idx < 0 || idx >= STAGE_PALETTES.length) okAll = false;
  }
  assert.ok(okAll, '随机扰动下返回值全部合法');
  ok('返回值恒为合法色板下标');
}

console.log('既有接口回归:');
{
  assert.equal(stageBackgroundCss(0, 3), null, 'mode 0 = 关');
  assert.ok(stageBackgroundCss(2, 3)!.includes('linear-gradient'), '渐变模式');
  assert.ok(stageCardGlowShadow(3).includes('0 0'), '辉光阴影');
  ok('stageBackgroundCss / stageCardGlowShadow 不受影响');
}

console.log(`\n共 ${passed} 项断言全部通过`);
