/**
 * 品牌色工具单测：hex 解析/规范化、RGB↔HSL、混合、对比度取字色、
 * 色板派生（accentDeep/accentLight/accentMuted/onAccent/accentGlow）与缺省回退。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/brand-color.test.ts
 */
import {
  DEFAULT_BRAND_COLOR,
  buildBrandPalette,
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  normalizeBrandColor,
  mixHex,
  contrastTextOn,
  alphaRgba,
  relativeLuminance,
} from '../../src/shared/brand-color';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};
const near = (actual: number, expected: number, msg: string, eps = 1e-6) => {
  if (Math.abs(actual - expected) <= eps) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  }
};
const toHsl = (hex: string): [number, number, number] => {
  const [r, g, b] = hexToRgb(hex)!;
  return rgbToHsl(r, g, b);
};

// ====== hex 解析 / 规范化 ======
ok(JSON.stringify(hexToRgb('#2563EB')) === JSON.stringify([37, 99, 235]), 'hex 6 位解析');
ok(JSON.stringify(hexToRgb('#fff')) === JSON.stringify([255, 255, 255]), 'hex 3 位解析');
ok(hexToRgb('#12345') === null, '5 位非法');
ok(hexToRgb('blue') === null, '颜色名非法');
ok(hexToRgb('  #AaBbCc ') !== null, '允许空白');
ok(normalizeBrandColor('#F97316') === '#f97316', '规范化转小写');
ok(normalizeBrandColor('f97316') === '#f97316', '无 # 前缀补全');
ok(normalizeBrandColor('#0f0') === '#00ff00', '3 位展开');
ok(normalizeBrandColor('#zzzzzz') === null, '非法字符 null');
ok(normalizeBrandColor(null) === null, 'null 透传');
ok(rgbToHex(37, 99, 235) === '#2563eb', 'rgb→hex');

// ====== HSL 往返 ======
{
  const [h, s, l] = toHsl('#2563EB');
  near(h, 221.2, '默认蓝色相', 1);
  ok(s > 0.7 && s < 0.9, `默认蓝饱和度区间 (${s.toFixed(3)})`);
  ok(l > 0.45 && l < 0.6, `默认蓝亮度区间 (${l.toFixed(3)})`);
  ok(toHsl('#808080')[1] === 0, '灰的饱和度 0');
}

// ====== 混合 ======
ok(mixHex('#000000', '#ffffff', 0) === '#000000', 'mix t=0');
ok(mixHex('#000000', '#ffffff', 1) === '#ffffff', 'mix t=1');
{
  const mid = mixHex('#000000', '#ffffff', 0.5);
  const v = parseInt(mid.slice(1, 3), 16);
  ok(Math.abs(v - 127.5) <= 0.5, `mix t=0.5 居中（${mid}）`);
}
ok(mixHex('#bbaadd', '#bbaadd', 0.3) === '#bbaadd', 'mix 同色不变');

// ====== 对比度取字色 ======
ok(contrastTextOn('#2563EB') === '#FFFFFF', '深蓝底取白字');
ok(contrastTextOn('#F59E0B') === '#111827', '琥珀底取深字');
ok(contrastTextOn('#FFFFFF') === '#111827', '纯白底取深字');
ok(contrastTextOn('#111111') === '#FFFFFF', '近黑底取白字');
near(relativeLuminance('#FFFFFF'), 1, '白亮度 1');
near(relativeLuminance('#000000'), 0, '黑亮度 0');

// ====== alphaRgba ======
ok(alphaRgba('#2563EB', 0.15) === 'rgba(37, 99, 235, 0.15)', 'rgba 字符串');
ok(alphaRgba('nope', 0.5) === 'rgba(0, 0, 0, 0.5)', '非法色回退黑');

// ====== 色板派生 ======
{
  const p = buildBrandPalette('#2563EB');
  ok(p.accent === '#2563eb', 'accent 原色');
  ok(p.accentDeep === mixHex('#2563eb', '#000000', 0.14), 'accentDeep 加深 14%');
  ok(p.accentLight === mixHex('#2563eb', '#ffffff', 0.92), 'accentLight 92% 白');
  ok(p.accentGlow === 'rgba(37, 99, 235, 0.15)', 'accentGlow');
  ok(JSON.stringify([...p.rgb]) === JSON.stringify([37, 99, 235]), 'rgb 分量');
  // 默认蓝的浅衬色接近历史版本手挑的 #EFF6FF（容差 ≤4：视觉等价的浅衬色）
  const legacy = hexToRgb('#EFF6FF')!;
  const now = hexToRgb(p.accentLight)!;
  ok(now.every((v, i) => Math.abs(v - legacy[i]) <= 4), '默认蓝 accentLight ≈ 旧版 #EFF6FF');
}
{
  const p = buildBrandPalette('#F97316'); // 活力橙
  ok(p.onAccent === '#111827', '橙底字色为深');
  const hslOrig = toHsl('#F97316');
  const hslMuted = toHsl(p.accentMuted);
  ok(hslMuted[1] < hslOrig[1], `muted 饱和度下降（${hslOrig[1].toFixed(2)} → ${hslMuted[1].toFixed(2)}）`);
  ok(Math.abs(hslMuted[0] - hslOrig[0]) < 0.5, 'muted 色相不变');
}
{
  // 非法输入回退默认蓝（调用方不必预校验）
  const p = buildBrandPalette('not-a-color');
  ok(p.accent === DEFAULT_BRAND_COLOR.toLowerCase(), '非法色回默认蓝');
}

console.log(`品牌色工具: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
