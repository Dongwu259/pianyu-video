import assert from 'node:assert/strict';
import {searchTemplateCatalog, browseTemplateCatalog, rankOnlineTemplateCatalog, enrichTemplateMeta, is3DTemplate} from '../../src/shared/template-catalog.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}: ${(err as Error).message}`); process.exitCode = 1; }
};

console.log('template-catalog:');

test('内置 taxonomy 补齐风格/动作/标签', () => {
  const t = enrichTemplateMeta(TEMPLATES.find((x) => x.id === 'VideoCut')!);
  assert.ok(t.styles?.includes('documentary'));
  assert.ok(t.actions?.includes('montage'));
  assert.ok(t.searchTags?.includes('快切'));
});

test('按体裁和槽位筛选并返回有限候选', () => {
  const r = searchTemplateCatalog(TEMPLATES, {videoType: 'tutorial', slot: 'story', style: 'tech', limit: 3});
  assert.ok(r.total >= r.templates.length);
  assert.ok(r.templates.length <= 3);
  for (const t of r.templates) {
    assert.ok(!t.videoTypes || t.videoTypes.includes('tutorial'));
    assert.ok(t.slots?.includes('story'));
  }
});

test('中文主题与动作语义提升相关模板', () => {
  const r = searchTemplateCatalog(TEMPLATES, {query: '前后效果对比', action: 'compare', limit: 5});
  assert.equal(r.templates[0]?.id, 'BeforeAfter');
});

test('needsMedia 优先素材或零素材模板', () => {
  const media = searchTemplateCatalog(TEMPLATES, {needsMedia: true, slot: 'media', limit: 5});
  assert.ok(media.templates.every((t) => t.minVideos > 0));
  const text = searchTemplateCatalog(TEMPLATES, {needsMedia: false, limit: 5});
  assert.ok(text.templates.every((t) => t.minVideos === 0));
});

test('limit 上限 20 且 tie-break 保持注册顺序', () => {
  const r = searchTemplateCatalog(TEMPLATES, {limit: 99});
  assert.ok(r.templates.length <= 20);
  const r2 = searchTemplateCatalog(TEMPLATES, {limit: 2});
  assert.equal(r2.templates[0]?.id, TEMPLATES[0].id);
});

test('在线目录按风格/动作/主题排序并保留安装状态', () => {
  const entries = [
    {id: 'mkt-warm', name: '温暖旅行', description: 'vlog 记录', version: '1.0.0', tags: ['warm', 'documentary', 'montage'], sha256: '', size: 1, downloads: 2, updatedAt: '', hasUpdate: false},
    {id: 'mkt-tech', name: '科技分屏', description: '产品对比展示', version: '1.0.0', tags: ['tech', 'split', 'showcase'], sha256: '', size: 1, downloads: 8, updatedAt: '', installedVersion: '1.0.0', hasUpdate: false},
    {id: 'mkt-other', name: '静态片头', description: '品牌开场', version: '1.0.0', tags: ['minimal', 'hook'], sha256: '', size: 1, downloads: 3, updatedAt: '', hasUpdate: false},
  ];
  const result = rankOnlineTemplateCatalog(entries, {style: 'tech', action: 'split', query: '产品对比'}, 2);
  assert.deepEqual(result.map((x) => x.id), ['mkt-tech']);
  assert.equal(result[0].installedVersion, '1.0.0');
});

test('在线目录无查询时稳定截断，离线空目录不抛错', () => {
  const entries = Array.from({length: 25}, (_, i) => ({id: `mkt-${i}`, name: `模板${i}`, version: '1.0.0', tags: [], sha256: '', size: 0, downloads: 0, updatedAt: '', hasUpdate: false}));
  assert.equal(rankOnlineTemplateCatalog(entries, {}, 99).length, 20);
  assert.deepEqual(rankOnlineTemplateCatalog([], {query: '不存在'}), []);
});

test('browse：默认不截断，返回全量命中', () => {
  const r = browseTemplateCatalog(TEMPLATES);
  assert.equal(r.templates.length, TEMPLATES.length);
  assert.equal(r.total, TEMPLATES.length);
  // 构造超过 20 个的模板数组，验证不受 search 的 20 上限约束
  const many = Array.from({length: 45}, (_, i) => ({...TEMPLATES[0], id: `T${i}`, name: `模板${i}`}));
  assert.equal(browseTemplateCatalog(many).templates.length, 45);
});

test('browse：显式 limit 生效但不夹 20 上限', () => {
  const many = Array.from({length: 45}, (_, i) => ({...TEMPLATES[0], id: `T${i}`, name: `模板${i}`}));
  assert.equal(browseTemplateCatalog(many, {limit: 30}).templates.length, 30);
  assert.equal(browseTemplateCatalog(TEMPLATES, {limit: 5}).templates.length, 5);
});

test('browse：与 search 同打分（query 首位一致）且槽位过滤生效', () => {
  const q = {query: '前后效果对比', action: 'compare' as const};
  assert.equal(browseTemplateCatalog(TEMPLATES, q).templates[0]?.id, searchTemplateCatalog(TEMPLATES, q).templates[0]?.id);
  const r = browseTemplateCatalog(TEMPLATES, {slot: 'data'});
  assert.ok(r.templates.length > 0);
  for (const t of r.templates) assert.ok(t.slots?.includes('data'));
});

test('browse：有关键词时只返回有命中的模板（零分不进网格）', () => {
  const r = browseTemplateCatalog(TEMPLATES, {query: '数据'});
  assert.ok(r.templates.length > 0);
  assert.ok(r.templates.length < TEMPLATES.length);
  // 命中数不超过 search 的 total（同一打分口径下的候选全集）
  assert.ok(r.templates.length <= r.total);
});

// is3DTemplate：3D 场景族 + 三件套 + 数据 3D 判 true，2D 判 false（选择器「3D」分类口径）
{
  const yes = ['Hero3DTitle', 'ModelTurntable', 'DeviceShowcase3D', 'CameraJourney3D', 'GalleryHall3D', 'OrbitCarousel3D', 'TimeTunnel3D', 'CityScape3D', 'SpiralAtrium3D', 'Starfield3D', 'GrowthBars3D', 'TrendLine3D'];
  for (const id of yes) assert.ok(is3DTemplate(id), `${id} 应判 3D`);
  for (const id of ['RevealSlide', 'StackCards', 'NeonTech', 'VlogStamp', 'KineticType']) assert.ok(!is3DTemplate(id), `${id} 不应判 3D`);
  // 注册表内 3D 模板恰为 12 款（3D 分类 chip 的口径与数量）
  assert.equal(TEMPLATES.filter((t) => is3DTemplate(t.id)).length, 12);
  passed++;
  console.log('  ✓ is3DTemplate 口径 + 3d 检索命中');
}

console.log(`\n===== ${passed} 项全部通过 =====`);
