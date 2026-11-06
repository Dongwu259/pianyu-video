/**
 * 发布准备（封面预设 v2 / 主体遮挡检测 / 发布元数据平台函数 / 工具参数校验）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/publish.test.ts
 */

import assert from 'node:assert/strict';
import {
  COVER_PRESET_OPTIONS,
  COVER_PRESET_IDS,
  COVER_FONTS,
  coverPresetLayers,
  applyCoverPreset,
  DEFAULT_COVER,
  sanitizeCoverConfig,
  sanitizeCoverLayer,
  defaultCoverTime,
  effectiveCoverTexts,
  withEffectiveTexts,
  darkenHex,
} from '../../src/shared/cover-presets.ts';
import {computeSubjectAlpha} from '../../src/renderer/utils/subjectMask.ts';
import {
  sanitizeTags,
  buildPlatformCopy,
  checkPlatformLimits,
  PLATFORM_SPECS,
  PUBLISH_PLATFORMS,
} from '../../src/shared/publish.ts';
import {validateExportCoverArgs, validateSetPublishMetadataArgs} from '../../src/shared/llm-tools.ts';

let passed = 0;
let failed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const bad = (name: string, err: unknown) => {
  failed++;
  console.error(`  ✗ ${name}: ${err}`);
};

const test = (name: string, fn: () => void) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
};

console.log('封面预设 v2:');
test('预设清单 4 种且 id 唯一；字体 5 种', () => {
  assert.equal(COVER_PRESET_OPTIONS.length, 4);
  assert.equal(new Set(COVER_PRESET_IDS).size, 4);
  assert.equal(COVER_FONTS.length, 5);
});

test('bottomLeft 预设生成 title/subtitle/tag 三个 role 层（横/竖 y 不同）', () => {
  const land = coverPresetLayers('bottomLeft', 'landscape', {title: 'T', subtitle: 'S', tag: 'G'});
  assert.deepEqual(land.map((l) => l.role), ['tag', 'title', 'subtitle']);
  const port = coverPresetLayers('bottomLeft', 'portrait', {title: 'T'});
  // 竖版整体上移：title y 0.70 < 横版 0.78，subtitle 避开底部 18% 安全区
  assert.ok(port[1].y < land[1].y);
  assert.ok(port[2].y * 1920 < 1920 * 0.82);
});

test('默认封面可被 sanitize 往返', () => {
  const back = sanitizeCoverConfig({...DEFAULT_COVER, layers: DEFAULT_COVER.layers.map((l) => ({...l, text: l.id === 'title' ? '片语' : l.text}))});
  assert.equal(back.scrimStyle, 'bottom');
  assert.equal(back.layers.length, 3);
  assert.equal(back.layers.find((l) => l.role === 'title')?.text, '片语');
});

test('sanitizeCoverConfig：旧版固定版式字段自动迁移为图层', () => {
  const legacy = sanitizeCoverConfig({layout: 'center', title: '旧标题', subtitle: '旧副题', tag: '新品', accent: '#7C3AED', scrim: 0.7});
  assert.equal(legacy.scrimStyle, 'full');
  assert.equal(legacy.layers.find((l) => l.role === 'title')?.text, '旧标题');
  assert.equal(legacy.layers.find((l) => l.role === 'tag')?.chipColor, '#7C3AED');
  const unknown = sanitizeCoverConfig({layout: 'sideBar'});
  assert.equal(unknown.scrimStyle, 'left');
});

test('sanitizeCoverLayer：非法值钳制、颜色回退、stroke/chip 空串语义保留', () => {
  const l = sanitizeCoverLayer({id: 'x', text: 'a'.repeat(100), x: 2, y: -1, size: 999, rotation: 90, depth: -5, angle: 999, strokeWidth: 99, color: 'bad', strokeColor: 'zz', chipColor: 'q', font: 'nope', align: 'diag'}, 0);
  assert.equal(l.text.length, 60);
  assert.equal(l.x, 0.98);
  assert.equal(l.y, 0.02);
  assert.equal(l.size, 400);
  assert.equal(l.rotation, 45);
  assert.equal(l.depth, 0);
  assert.equal(l.angle, 360);
  assert.equal(l.strokeWidth, 24);
  assert.equal(l.color, '#FFFFFF');
  assert.equal(l.strokeColor, '');
  assert.equal(l.chipColor, '');
  assert.equal(l.font, 'heavy');
  assert.equal(l.align, 'left');
});

test('sanitizeCoverConfig：图层数量上限 6', () => {
  const many = Array.from({length: 9}, (_, i) => ({id: `t${i}`, text: 'x'}));
  assert.equal(sanitizeCoverConfig({layers: many}).layers.length, 6);
});

test('applyCoverPreset：保留文案与自由图层，重排 role 层位置', () => {
  const cover = {
    ...DEFAULT_COVER,
    layers: [
      ...coverPresetLayers('bottomLeft', 'landscape', {title: '我的标题', tag: '新品', accent: '#E11D48'}),
      {id: 'free', text: '自由层', font: 'kai' as const, x: 0.8, y: 0.2, align: 'center' as const, size: 90, color: '#FFFFFF',
        strokeColor: '', strokeWidth: 0, rotation: 0, depth: 10, angle: 45, sideColor: '#111111', behind: false, chipColor: ''},
    ],
  };
  const next = applyCoverPreset(cover, 'topBand', 'landscape');
  assert.equal(next.scrimStyle, 'top');
  assert.equal(next.layers.find((l) => l.role === 'title')?.text, '我的标题');
  assert.ok(next.layers.find((l) => l.role === 'title')!.y < 0.3);
  assert.equal(next.layers.find((l) => l.role === 'tag')?.chipColor, '#E11D48');
  assert.ok(next.layers.some((l) => l.id === 'free'));
});

test('defaultCoverTime：短片落在片内且 ≥0.3s，封顶 5s', () => {
  assert.equal(defaultCoverTime(0), 0.3);
  assert.equal(defaultCoverTime(10), 1.5);
  assert.equal(defaultCoverTime(100), 5);
});

test('effectiveCoverTexts + withEffectiveTexts：role 层空文案走缺省链并写回', () => {
  const cover = coverPresetLayers ? {
    ...DEFAULT_COVER,
    layers: coverPresetLayers('bottomLeft', 'landscape', {subtitle: '自带副题'}),
  } : DEFAULT_COVER;
  const meta = {title: '元数据标题', description: '', tags: []};
  const eff = effectiveCoverTexts(cover, meta, {title: '首段标题', subtitle: '首段副题'});
  assert.equal(eff.title, '元数据标题'); // 图层空 → 元数据
  assert.equal(eff.subtitle, '自带副题'); // 图层有值优先
  const filled = withEffectiveTexts(cover, eff);
  assert.equal(filled.layers.find((l) => l.role === 'title')?.text, '元数据标题');
  const noMeta = effectiveCoverTexts(cover, undefined, {title: '首段标题', subtitle: '首段副题'});
  assert.equal(noMeta.title, '首段标题');
});

test('darkenHex：按比例变暗 / 非法回退', () => {
  assert.equal(darkenHex('#FF8800', 0.5), '#804400');
  assert.equal(darkenHex('#FFFFFF', 0), '#000000');
  assert.equal(darkenHex('oops', 0.5), '#333333');
});

console.log('主体遮挡检测（纯函数核心）:');
test('灰底中央色块：主体被检出且覆盖合理', () => {
  // 64×48 灰底(144) + 中央 24×16 深红块
  const w = 64, h = 48;
  const data: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRect = x >= 20 && x < 44 && y >= 16 && y < 32;
      data.push(inRect ? 180 : 144, inRect ? 30 : 144, inRect ? 30 : 144, 255);
    }
  }
  const {alpha, coverage} = computeSubjectAlpha(data, w, h);
  assert.ok(coverage > 0.03 && coverage < 0.6, `coverage ${coverage}`);
  // 主体中心应被判为主体（alpha 低），角落应是背景（alpha 高）
  const center = alpha[Math.floor(h / 2) * w + Math.floor(w / 2)];
  const corner = alpha[2 * w + 2];
  assert.ok(center < 80, `center alpha ${center}`);
  assert.ok(corner > 200, `corner alpha ${corner}`);
});

test('纯色画面：无主体（覆盖接近 0）', () => {
  const w = 32, h = 32;
  const data: number[] = [];
  for (let i = 0; i < w * h; i++) data.push(100, 100, 100, 255);
  const {coverage} = computeSubjectAlpha(data, w, h);
  assert.ok(coverage < 0.02, `coverage ${coverage}`);
});

console.log('标签清洗 sanitizeTags:');
test('数组输入：去 # 前缀、去空、去重、截 30 字', () => {
  const r = sanitizeTags(['#产品宣传', '产品宣传', ' ', 'AI', 'x'.repeat(40)]);
  assert.deepEqual(r, ['产品宣传', 'AI', 'x'.repeat(30)]);
});

test('字符串输入：中英文逗号/空格/井号分隔', () => {
  assert.deepEqual(sanitizeTags('a, b，c  d #e'), ['a', 'b', 'c', 'd', 'e']);
});

test('非法输入与超量截断', () => {
  assert.deepEqual(sanitizeTags(42), []);
  assert.deepEqual(sanitizeTags(undefined), []);
  const many = sanitizeTags(Array.from({length: 30}, (_, i) => `t${i}`));
  assert.equal(many.length, 20);
});

console.log('平台文案组装 buildPlatformCopy:');
const meta = {title: '一句话出片', description: 'AI 全自动宣传片', tags: ['产品宣传', 'AI 视频']};
test('抖音：标题 + # 话题', () => {
  assert.equal(buildPlatformCopy('douyin', meta), '一句话出片\n#产品宣传 #AI 视频');
});
test('B站：标题/简介/逗号标签三段', () => {
  assert.equal(buildPlatformCopy('bilibili', meta), '一句话出片\nAI 全自动宣传片\n标签：产品宣传，AI 视频');
});
test('小红书：标题/正文/# 话题', () => {
  assert.equal(buildPlatformCopy('xiaohongshu', meta), '一句话出片\nAI 全自动宣传片\n#产品宣传 #AI 视频');
});
test('YouTube：标题与描述间空行', () => {
  assert.equal(buildPlatformCopy('youtube', meta), '一句话出片\n\nAI 全自动宣传片\n\n#产品宣传 #AI 视频');
});
test('空字段跳过不拼空行', () => {
  const only = {title: '只有标题', description: '', tags: []};
  assert.equal(buildPlatformCopy('douyin', only), '只有标题');
  assert.equal(buildPlatformCopy('bilibili', only), '只有标题');
});

console.log('平台字数校验 checkPlatformLimits:');
test('超限平台给警告、未超限不给', () => {
  const long = {title: '字'.repeat(25), description: '', tags: []};
  const ws = checkPlatformLimits(long);
  const platforms = ws.map((w) => w.platform);
  assert.ok(platforms.includes('xiaohongshu'));
  assert.ok(!platforms.includes('douyin'));
  assert.ok(!platforms.includes('bilibili'));
  const xhs = ws.find((w) => w.platform === 'xiaohongshu')!;
  assert.equal(xhs.over, 5);
  assert.equal(xhs.field, 'title');
});

test('标签数超 B站/小红书上限给警告', () => {
  const ws = checkPlatformLimits({title: 't', description: '', tags: Array.from({length: 12}, (_, i) => `tag${i}`)});
  assert.ok(ws.some((w) => w.platform === 'bilibili' && w.field === 'tags' && w.over === 2));
  assert.ok(ws.some((w) => w.platform === 'xiaohongshu' && w.field === 'tags' && w.over === 2));
});

test('视频号不校验（平台无公开上限）', () => {
  const ws = checkPlatformLimits({title: '字'.repeat(300), description: 'x'.repeat(3000), tags: []});
  assert.ok(!ws.some((w) => w.platform === 'channels'));
});

test('平台清单五家齐备', () => {
  assert.deepEqual(PUBLISH_PLATFORMS, ['douyin', 'bilibili', 'xiaohongshu', 'channels', 'youtube']);
  assert.equal(PLATFORM_SPECS.douyin.titleLimit, 55);
  assert.equal(PLATFORM_SPECS.bilibili.titleLimit, 80);
  assert.equal(PLATFORM_SPECS.xiaohongshu.titleLimit, 20);
  assert.equal(PLATFORM_SPECS.youtube.titleLimit, 100);
});

console.log('export_cover 参数校验 v2:');
test('合法参数全量通过（preset + add3dText）', () => {
  const r = validateExportCoverArgs({timeSec: 3.5, preset: 'centerPoster', title: '上线', scrim: 0.4, format: 'png',
    add3dText: {text: 'AI', x: 0.5, y: 0.4, size: 200, color: '#60A5FA', depth: 20, angle: 45, behind: true}});
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.args.preset, 'centerPoster');
    assert.equal(r.args.add3dText?.behind, true);
  }
});

test('非法枚举/数值/颜色/add3dText 报中文错误', () => {
  const r = validateExportCoverArgs({preset: 'nope', timeSec: -1, scrim: 1.5, format: 'gif', add3dText: {text: ''}});
  assert.ok(!r.ok);
  if (!r.ok) assert.ok(r.errors.length >= 4);
  const bad3d = validateExportCoverArgs({add3dText: {text: 'x', color: 'blue', size: 'big'}});
  assert.ok(!bad3d.ok);
});

test('空入参合法（全走缺省）', () => {
  assert.ok(validateExportCoverArgs({}).ok);
  assert.ok(validateExportCoverArgs(undefined).ok);
});

console.log('set_publish_metadata 参数校验:');
test('部分更新合法、tags 字符串输入清洗', () => {
  const r = validateSetPublishMetadataArgs({tags: 'a, b'});
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.args.tags, ['a', 'b']);
});

test('空对象拒绝（至少给一个字段）', () => {
  const r = validateSetPublishMetadataArgs({});
  assert.ok(!r.ok);
  if (!r.ok) assert.match(r.errors[0], /至少给出/);
});

test('类型错误拒绝', () => {
  assert.ok(!validateSetPublishMetadataArgs({title: 123}).ok);
  assert.ok(!validateSetPublishMetadataArgs({tags: 42}).ok);
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0 || passed < 24) process.exit(1);
