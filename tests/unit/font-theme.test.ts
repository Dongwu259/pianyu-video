/**
 * 字体氛围预设 + designTokens 品牌主题单测：
 * 预设注册表（id 唯一/回退/栈含内置族）、模块主题注入（setBrandTheme 后
 * VIDEO_DEIGN getter 取到品牌色与氛围字体栈；缺省回退历史版本视觉）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/font-theme.test.ts
 */
import {FONT_MOODS, DEFAULT_FONT_MOOD_ID, isFontMoodId, getFontMood} from '../../src/shared/font-presets';
import {VIDEO_DESIGN, setBrandTheme, getBrandPalette} from '../../src/remotion/config/designTokens';
import {DEFAULT_BRAND_COLOR} from '../../src/shared/brand-color';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

// ====== 预设注册表 ======
ok(FONT_MOODS.length === 4, `四档氛围（实际 ${FONT_MOODS.length}）`);
ok(new Set(FONT_MOODS.map((m) => m.id)).size === FONT_MOODS.length, 'id 唯一');
ok(FONT_MOODS.every((m) => m.titleFont.includes('"MiSans"') || m.titleFont.includes('"LXGW WenKai"') || m.titleFont.includes('"JetBrains Mono"') || m.titleFont.includes('"Poppins"')), '每档标题栈都以内置字体开头');
ok(FONT_MOODS.every((m) => m.titleFont.includes('"Microsoft YaHei"')), '每档栈都带中文系统回退');
ok(FONT_MOODS.every((m) => m.monoFont.startsWith('"JetBrains Mono"')), '等宽栈统一 JetBrains Mono 首选');
ok(isFontMoodId('warm') && isFontMoodId('sleek') && isFontMoodId('tech') && isFontMoodId('display'), '四个合法 id');
ok(!isFontMoodId('fancy') && !isFontMoodId(42) && !isFontMoodId(undefined), '非法 id 拒绝');
ok(getFontMood('warm').id === 'warm', '按 id 取预设');
ok(getFontMood('nope').id === DEFAULT_FONT_MOOD_ID, '非法 id 回默认');
ok(getFontMood(undefined).id === DEFAULT_FONT_MOOD_ID, '缺省回默认');
ok(getFontMood(null).id === DEFAULT_FONT_MOOD_ID, 'null 回默认（旧工程字段缺失）');

// ====== 模块主题（designTokens getter） ======
// 注意：designTokens 是模块级可变主题，测试结束后恢复默认，避免影响同进程其他套件
{
  // 1) 缺省 = 历史版本视觉（默认蓝 + MiSans）
  setBrandTheme({});
  ok(VIDEO_DESIGN.colors.accent === DEFAULT_BRAND_COLOR.toLowerCase(), '缺省 accent = 默认蓝');
  ok(VIDEO_DESIGN.titleFont.startsWith('"MiSans"'), '缺省标题栈 MiSans');
  ok(VIDEO_DESIGN.monoFont.startsWith('"JetBrains Mono"'), '等宽栈 JetBrains Mono');

  // 2) 品牌色注入：accent 系列全部跟随
  setBrandTheme({accent: '#F97316'});
  ok(VIDEO_DESIGN.colors.accent === '#f97316', 'accent 跟随品牌色');
  ok(VIDEO_DESIGN.colors.accentGlow === 'rgba(249, 115, 22, 0.15)', 'accentGlow 派生');
  ok(VIDEO_DESIGN.colors.accentLight.includes('#'), 'accentLight 派生');
  ok(getBrandPalette().onAccent === '#111827', '调色板 onAccent');

  // 3) 字体氛围注入：字体栈成套切换
  setBrandTheme({fontMood: 'warm'});
  ok(VIDEO_DESIGN.titleFont.startsWith('"LXGW WenKai"'), 'warm 标题栈文楷');
  ok(VIDEO_DESIGN.bodyFont.startsWith('"LXGW WenKai"'), 'warm 正文字栈文楷');
  setBrandTheme({fontMood: 'tech'});
  ok(VIDEO_DESIGN.titleFont.startsWith('"JetBrains Mono"'), 'tech 标题栈等宽');
  ok(VIDEO_DESIGN.bodyFont.startsWith('"MiSans"'), 'tech 正文仍黑体（可读性）');
  setBrandTheme({fontMood: 'display'});
  ok(VIDEO_DESIGN.titleFont.startsWith('"Poppins"'), 'display 标题栈 Poppins');

  // 4) 非法值静默回退（手改工程文件防线）
  setBrandTheme({accent: 'banana', fontMood: 'fancy'});
  ok(VIDEO_DESIGN.colors.accent === DEFAULT_BRAND_COLOR.toLowerCase(), '非法色回默认蓝');
  ok(VIDEO_DESIGN.titleFont.startsWith('"MiSans"'), '非法氛围回默认');

  // 5) 组合注入互不影响
  setBrandTheme({accent: '#16A34A', fontMood: 'warm'});
  ok(VIDEO_DESIGN.colors.accent === '#16a34a' && VIDEO_DESIGN.titleFont.startsWith('"LXGW WenKai"'), '组合注入');

  // 还原默认，保证后续套件（同进程）看到默认主题
  setBrandTheme({});
  ok(VIDEO_DESIGN.colors.accent === DEFAULT_BRAND_COLOR.toLowerCase(), '主题可还原默认');
}

console.log(`字体氛围与品牌主题: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
