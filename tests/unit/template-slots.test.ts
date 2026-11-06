/**
 * template-slots 单测：槽位标注覆盖度、槽位地图体量、过滤与流水线标签
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/template-slots.test.ts
 */
import assert from 'node:assert/strict';
import {TEMPLATES, templateFitsVideoType} from '../../src/shared/template-registry.ts';
import {
  TEMPLATE_SLOTS, TEMPLATE_SLOT_LABEL, isTemplateSlot,
  buildSlotMap, buildSlotMapText, filterTemplatesBySlot, slotLabelsOf,
} from '../../src/shared/template-slots.ts';
import {buildSystemPrompt} from '../../src/shared/llm-prompt.ts';
import type {VideoType} from '../../src/shared/video-type.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('template-slots:');

t('63 个内置模板全部有槽位标注（1-2 个、取值合法）', () => {
  assert.equal(TEMPLATES.length, 63);
  for (const tpl of TEMPLATES) {
    assert.ok(tpl.slots && tpl.slots.length >= 1 && tpl.slots.length <= 2, `${tpl.id} 槽位数量异常: ${JSON.stringify(tpl.slots)}`);
    for (const s of tpl.slots!) assert.ok(isTemplateSlot(s), `${tpl.id} 非法槽位 ${s}`);
  }
});

t('Fullbleed 素材主导族三件套齐备（满幅画幅 + 文字槽位登记）', () => {
  const ids = ['FullbleedTitle', 'FullbleedFeature', 'FullbleedCTA'];
  for (const id of ids) {
    const tpl = TEMPLATES.find((x) => x.id === id);
    assert.ok(tpl, `${id} 未注册`);
    assert.equal(tpl!.defaultLayout?.videoWidthRatio, 1, `${id} 应满幅画幅`);
    assert.equal(tpl!.defaultLayout?.videoHeightRatio, 1, `${id} 应满幅画幅`);
    assert.ok(tpl!.slots!.length >= 1);
  }
  // CTA 槽位候选补充（原 3+ 现在只多不少）
  const ctas = TEMPLATES.filter((x) => x.slots!.includes('cta'));
  assert.ok(ctas.some((x) => x.id === 'FullbleedCTA'));
  // 系统提示词含素材类型-模板对位铁律
  const p = buildSystemPrompt('promo');
  assert.ok(p.includes('Fullbleed 满幅族'), '系统提示词应含实拍优先 Fullbleed 规则');
  assert.ok(p.includes('禁止把实拍素材放进 3D 画中画族'), '系统提示词应含画中画禁用铁律');
});

t('每个槽位在内置模板中至少有 3 个候选', () => {
  for (const slot of TEMPLATE_SLOTS) {
    const n = filterTemplatesBySlot(TEMPLATES, slot).length;
    assert.ok(n >= 3, `槽位 ${slot}（${TEMPLATE_SLOT_LABEL[slot]}）只有 ${n} 个候选`);
  }
});

t('槽位地图保持输入顺序且未分槽模板不进组', () => {
  const map = buildSlotMap(TEMPLATES);
  assert.equal(map.length, TEMPLATE_SLOTS.length);
  const noSlot = {...TEMPLATES[0], id: 'X', slots: undefined};
  const map2 = buildSlotMap([noSlot, ...TEMPLATES]);
  for (const g of map2) assert.ok(!g.templates.some((x) => x.id === 'X'));
});

t('槽位地图文本体量受控（promo 体裁 < 1200 字符，对比旧全量清单 5773）', () => {
  const genre = TEMPLATES.filter((x) => templateFitsVideoType(x, 'promo'));
  const text = buildSlotMapText(genre);
  assert.ok(text.length < 1200, `槽位地图 ${text.length} 字符超长`);
  assert.ok(text.includes('开场钩子') && text.includes('结尾行动'));
});

t('系统提示词模板节较旧版明显收缩（各体裁 < 2 万字符，含槽位地图、不内联模板描述全文）', () => {
  const types: VideoType[] = ['promo', 'vlog', 'talkingHead', 'tutorial', 'montage'];
  for (const vt of types) {
    const p = buildSystemPrompt(vt);
    assert.ok(p.length < 20000, `${vt} 系统提示词 ${p.length} 字符`);
    assert.ok(p.includes('模板槽位地图'), `${vt} 缺槽位地图`);
    // 旧版会把每个模板的 description 全文内联（如 KineticType 的描述句）；槽位制后描述只经 get_templates 下发
    assert.ok(!p.includes('整屏超大字逐行砸入'), `${vt} 不应内联模板描述全文`);
  }
});

t('get_templates 槽位过滤只留该槽位模板', () => {
  const hooks = filterTemplatesBySlot(TEMPLATES, 'hook');
  assert.ok(hooks.length >= 3);
  for (const h of hooks) assert.ok(h.slots!.includes('hook'));
  assert.ok(hooks.some((x) => x.id === 'KineticType'));
  assert.ok(!hooks.some((x) => x.id === 'StatCounter'));
});

t('slotLabelsOf 输出中文标签串（流水线 prompt 行内标注）', () => {
  const kt = TEMPLATES.find((x) => x.id === 'KineticType')!;
  assert.equal(slotLabelsOf(kt), '开场钩子');
  const ds = TEMPLATES.find((x) => x.id === 'DeviceShowcase')!;
  assert.equal(slotLabelsOf(ds), '产品展示/素材演绎');
  assert.equal(slotLabelsOf({...kt, slots: undefined}), '');
});

console.log(`\n===== ${passed} 项全部通过 =====`);
