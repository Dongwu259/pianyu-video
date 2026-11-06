/**
 * 色彩统一（shared/color-grade.ts + set_color_grade 校验）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/color-grade.test.ts
 */

import assert from 'node:assert/strict';
import {
  COLOR_LOOKS,
  getColorLook,
  DEFAULT_COLOR_GRADE,
  autoMatchFactor,
  medianTargetLuma,
  colorMatchFilter,
  lumaOf,
} from '../../src/shared/color-grade.ts';
import {validateColorGradeArgs, COLOR_GRADE_LOOK_IDS} from '../../src/shared/llm-tools.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('COLOR_LOOKS:');
{
  assert.ok(COLOR_LOOKS.length >= 5);
  assert.ok(COLOR_LOOKS.some((l) => l.id === 'none' && l.filter === ''));
  // 全部预设的 filter 是合法 CSS 片段（无换行、以函数名开头）
  for (const l of COLOR_LOOKS) {
    if (!l.filter) continue;
    assert.match(l.filter, /^(saturate|contrast|brightness|grayscale|sepia|hue-rotate)\(/);
    assert.ok(!l.filter.includes('\n'));
  }
  ok('预设齐全且 filter 片段形态合法');
  assert.deepEqual(COLOR_GRADE_LOOK_IDS, COLOR_LOOKS.map((l) => l.id));
  ok('工具枚举与预设表同源');
}
{
  assert.equal(getColorLook('warmFilm').label, '暖调胶片');
  assert.equal(getColorLook('not-exist').id, 'none');
  assert.equal(getColorLook(undefined).id, 'none');
  ok('getColorLook 命中与回退');
}

console.log('autoMatch:');
{
  assert.equal(DEFAULT_COLOR_GRADE.look, 'none');
  assert.equal(DEFAULT_COLOR_GRADE.autoMatch, true);
  ok('默认 = 原生 + 自动匹配开');
}
{
  // 偏暗素材提到基准：120 → 目标 140，140/120≈1.167（未超上限）
  assert.ok(Math.abs(autoMatchFactor(120, 140) - 1.1667) < 0.001);
  // 偏亮素材压下来：200 → 140 = 0.7 → 钳到 0.85（温和区间）
  assert.equal(autoMatchFactor(200, 140), 0.85);
  assert.equal(autoMatchFactor(100, 200), 1.18);
  // 异常输入不做处理
  assert.equal(autoMatchFactor(0, 140), 1);
  assert.equal(autoMatchFactor(140, NaN), 1);
  ok('校正系数向目标看齐并钳在 [0.85, 1.18]');
}
{
  assert.equal(medianTargetLuma([100, 140, 180]), 140);
  assert.equal(medianTargetLuma([100, 120, 180, 200]), 150); // 偶数取中间均值
  assert.equal(medianTargetLuma([100]), null); // 少于 2 路无基准（单素材无「不齐」可言）
  assert.equal(medianTargetLuma([]), null);
  assert.equal(medianTargetLuma([0, -5]), null);
  ok('基准亮度 = 有效亮度中位数；样本不足返回 null');
}
{
  assert.equal(colorMatchFilter(1), '');
  assert.equal(colorMatchFilter(1.003), '');
  assert.equal(colorMatchFilter(0.9), 'brightness(0.900)');
  assert.equal(colorMatchFilter(1.1667), 'brightness(1.167)');
  ok('系数≈1 不产生 filter，其余输出 brightness()');
}
{
  assert.ok(Math.abs(lumaOf(255, 255, 255) - 255) < 0.001);
  assert.ok(Math.abs(lumaOf(0, 255, 0) - 0.7152 * 255) < 0.001);
  ok('Rec.709 亮度加权');
}

console.log('validateColorGradeArgs:');
{
  const r = validateColorGradeArgs({look: 'tealOrange'});
  assert.ok(r.ok && r.args.look === 'tealOrange' && r.args.autoMatch === undefined);
  const r2 = validateColorGradeArgs({look: 'cleanCool', autoMatch: false});
  assert.ok(r2.ok && r2.args.autoMatch === false);
  ok('合法参数通过');
}
{
  assert.ok(!validateColorGradeArgs({}).ok);
  assert.ok(!validateColorGradeArgs({look: 'vintage'}).ok);
  assert.ok(!validateColorGradeArgs({look: 'warmFilm', autoMatch: 'yes'}).ok);
  ok('非法 look / autoMatch 类型被拒');
}

console.log(`\ncolor-grade: ${passed} 组断言全部通过`);
if (passed < 10) process.exit(1);
