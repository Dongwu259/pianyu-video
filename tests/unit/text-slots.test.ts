/**
 * 文字槽位（textSlots）单测：
 * 静态检测 detectTextSlots / 清洗 sanitizeTextSlots / 结构校验（自定义+生成模板）/
 * generate_template 参数校验 / 三类 meta 透出 mergeTemplateMetas / 校验器 note 端到端。
 *
 * 运行：npx tsx tests/unit/text-slots.test.ts
 */

import assert from 'node:assert/strict';
import {
  createBlankCustomTemplate,
  createTextElement,
  detectTextSlots,
  sanitizeTextSlots,
  validateCustomTemplateDef,
  TEXT_SLOT_VALUES,
  TEXT_SLOT_OPTIONS,
  type CustomTemplateDef,
} from '../../src/shared/custom-template.ts';
import {
  generatedTemplateToMeta,
  validateGeneratedTemplateDef,
  type GeneratedTemplateDef,
} from '../../src/shared/generated-template.ts';
import {
  customTemplateToMeta,
  marketPackToMeta,
  mergeTemplateMetas,
  TEXT_SLOTS_BUILTIN,
} from '../../src/shared/template-registry.ts';
import type {TemplatePack} from '../../src/shared/template-pack.ts';
import {createLlmTools, validateGenerateTemplateArgs} from '../../src/shared/llm-tools.ts';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS} from '../../src/shared/types.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('text-slots 单元测试');

/** 造一个合法自定义 def：空白模板 + 指定角色的文本框 */
const defWithRoles = (roles: ('title' | 'subtitle' | 'feature' | 'brand')[], fixedRoles: typeof roles = []): CustomTemplateDef => {
  const def = createBlankCustomTemplate('landscape');
  def.elements = [
    ...roles.map((r) => createTextElement(r)),
    ...fixedRoles.map((r) => ({...createTextElement(r), fixedText: '★'})),
  ];
  return def;
};

// ====== 词汇表 ======
t('词汇表：TEXT_SLOT_VALUES 与内置登记表取值一致、标签齐全', () => {
  assert.deepEqual([...TEXT_SLOT_VALUES], ['title', 'subtitle', 'features', 'brandName']);
  assert.deepEqual(TEXT_SLOT_OPTIONS.map((o) => o.value), [...TEXT_SLOT_VALUES]);
  for (const [id, slots] of Object.entries(TEXT_SLOTS_BUILTIN)) {
    for (const s of slots) {
      assert.ok((TEXT_SLOT_VALUES as readonly string[]).includes(s), `${id} 的槽位「${s}」不在词汇表内`);
    }
  }
});

// ====== detectTextSlots ======
t('检测：角色→槽位映射，按词汇表顺序去重', () => {
  const def = defWithRoles(['brand', 'feature', 'title', 'subtitle', 'title']);
  assert.deepEqual(detectTextSlots(def), ['title', 'subtitle', 'features', 'brandName']);
});

t('检测：fixedText 元素不计入（渲染固定文案，不消费 text.*）', () => {
  const def = defWithRoles(['title'], ['brand', 'subtitle']);
  assert.deepEqual(detectTextSlots(def), ['title']);
});

t('检测：textRole 缺省按 title 计；纯画面模板 → 空数组', () => {
  const noRole = createBlankCustomTemplate('landscape');
  noRole.elements = [{...createTextElement('title'), textRole: undefined}];
  assert.deepEqual(detectTextSlots(noRole), ['title']);
  const videoOnly = createBlankCustomTemplate('landscape');
  videoOnly.elements = videoOnly.elements.filter((el) => el.type !== 'text');
  assert.deepEqual(detectTextSlots(videoOnly), []);
});

// ====== sanitizeTextSlots ======
t('清洗：合法值按词汇表排序去重；非法值/非字符串剔除并记入 dropped', () => {
  assert.deepEqual(sanitizeTextSlots(['brandName', 'title', 'title']), {slots: ['title', 'brandName'], dropped: []});
  assert.deepEqual(sanitizeTextSlots(['title', 'heading', 5, 'features']), {
    slots: ['title', 'features'],
    dropped: ['heading', '5'],
  });
  assert.deepEqual(sanitizeTextSlots([]), {slots: [], dropped: []});
  assert.deepEqual(sanitizeTextSlots(undefined), {slots: [], dropped: []});
});

// ====== 结构校验 ======
t('结构校验：自定义 def 接受合法 textSlots、拒绝非法值', () => {
  const def = defWithRoles(['title']);
  assert.deepEqual(validateCustomTemplateDef({...def, textSlots: ['title', 'features']}), []);
  assert.deepEqual(validateCustomTemplateDef({...def, textSlots: []}), []);
  assert.ok(validateCustomTemplateDef({...def, textSlots: ['heading']}).some((e) => e.includes('textSlots')));
  assert.ok(validateCustomTemplateDef({...def, textSlots: 'title'}).some((e) => e.includes('textSlots')));
});

t('结构校验：生成模板 def 接受合法 textSlots、拒绝非法值', () => {
  const good = (): GeneratedTemplateDef => ({
    id: 'gen-x1', name: 'T', description: '', source: 'const GeneratedTemplate = () => <div/>;',
    compiled: 'const x=1;', duration: 8, createdAt: 1, updatedAt: 2,
  });
  assert.deepEqual(validateGeneratedTemplateDef({...good(), textSlots: ['subtitle']}), []);
  assert.deepEqual(validateGeneratedTemplateDef({...good(), textSlots: []}), []);
  assert.ok(validateGeneratedTemplateDef({...good(), textSlots: ['body']}).some((e) => e.includes('textSlots')));
});

// ====== generate_template 参数校验 ======
t('参数校验：textSlots 透传（清洗排序）；非法值剔除并记 notes', () => {
  const code = 'const GeneratedTemplate = () => <div/>;';
  const r1 = validateGenerateTemplateArgs({name: 'X', code, textSlots: ['brandName', 'title']});
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.deepEqual(r1.args.textSlots, ['title', 'brandName']);
    assert.equal(r1.notes, undefined);
  }
  const r2 = validateGenerateTemplateArgs({name: 'X', code, textSlots: ['title', 'heading']});
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.deepEqual(r2.args.textSlots, ['title']);
    assert.ok(r2.notes?.some((n) => n.includes('heading') && n.includes('剔除')));
  }
  // 显式空数组 = 声明不展示文字，透传不丢
  const r3 = validateGenerateTemplateArgs({name: 'X', code, textSlots: []});
  assert.equal(r3.ok, true);
  if (r3.ok) assert.deepEqual(r3.args.textSlots, []);
  // 非数组判死
  assert.equal(validateGenerateTemplateArgs({name: 'X', code, textSlots: 'title'}).ok, false);
});

// ====== meta 透出（mergeTemplateMetas → get_templates / 校验器共用）======
t('meta 透出：自定义/市场/生成三类模板的 textSlots 进合并清单', () => {
  const custom = {...defWithRoles(['title', 'subtitle']), textSlots: ['title', 'subtitle']};
  const pack = {
    formatVersion: 1, id: 'mkt-test', name: '测试包', version: '1.0.0',
    def: {...defWithRoles(['brand']), id: 'mkt-test', textSlots: ['brandName']},
  } as TemplatePack;
  const gen: GeneratedTemplateDef = {
    id: 'gen-m1', name: 'G', description: '', source: 'const GeneratedTemplate = () => <div/>;',
    compiled: 'const x=1;', duration: 8, textSlots: ['features'], createdAt: 1, updatedAt: 2,
  };
  assert.deepEqual(customTemplateToMeta(custom).textSlots, ['title', 'subtitle']);
  assert.deepEqual(marketPackToMeta(pack).textSlots, ['brandName']);
  assert.deepEqual(generatedTemplateToMeta(gen).textSlots, ['features']);

  const merged = mergeTemplateMetas([custom], [pack], [gen]);
  assert.deepEqual(merged.find((m) => m.id === custom.id)?.textSlots, ['title', 'subtitle']);
  assert.deepEqual(merged.find((m) => m.id === 'mkt-test')?.textSlots, ['brandName']);
  assert.deepEqual(merged.find((m) => m.id === 'gen-m1')?.textSlots, ['features']);
  // 未声明的自定义模板：meta 不带 textSlots（= 未知，不发提示）
  const plain = mergeTemplateMetas([defWithRoles(['title'])]);
  assert.equal(plain.find((m) => m.id.startsWith('custom-'))?.textSlots, undefined);
});

// ====== 端到端：自定义模板声明槽位 → 校验器对槽位外字段发 note ======
t('端到端：自定义模板 textSlots → 校验器 note', () => {
  const custom = {...defWithRoles(['title']), id: 'custom-e2e', textSlots: ['title']};
  const meta = customTemplateToMeta(custom);
  const tools = createLlmTools({
    templates: [meta],
    transitions: TRANSITION_OPTIONS.map((x) => x.value),
    videoEffects: VIDEO_EFFECT_OPTIONS.map((x) => x.value),
    backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((x) => x.value),
    textAnims: TEXT_ANIM_OPTIONS.map((x) => x.value),
  });
  // 给了槽位外字段（brandName/features）→ note 提醒不显示
  const r1 = tools.validateStoryboardSpec({segments: [{templateId: 'custom-e2e', text: {title: '主标题', brandName: '品牌', features: ['要点']}}]});
  assert.equal(r1.ok, true);
  if (r1.ok) {
    const note = r1.notes.find((n) => n.includes(meta.name));
    assert.ok(note, `应有槽位提醒 note，实际 notes: ${JSON.stringify(r1.notes)}`);
    // 未使用字段恰为 brandName/features（title 在槽位内不得出现）
    assert.ok(note.includes('不使用 text.brandName/text.features'), note);
  }
  // 字段全部在槽位内 → 无 note
  const r2 = tools.validateStoryboardSpec({segments: [{templateId: 'custom-e2e', text: {title: '主标题'}}]});
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.notes.length, 0);
  // 显式 textSlots: []（纯画面模板）→ 提示「不展示任何文字字段」
  const tools2 = createLlmTools({
    templates: [{...meta, textSlots: []}],
    transitions: TRANSITION_OPTIONS.map((x) => x.value),
    videoEffects: VIDEO_EFFECT_OPTIONS.map((x) => x.value),
    backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((x) => x.value),
    textAnims: TEXT_ANIM_OPTIONS.map((x) => x.value),
  });
  const r3 = tools2.validateStoryboardSpec({segments: [{templateId: 'custom-e2e', text: {title: '主标题'}}]});
  assert.equal(r3.ok, true);
  if (r3.ok) assert.ok(r3.notes.some((n) => n.includes('不展示任何文字字段')), JSON.stringify(r3.notes));
});

console.log(`\n${passed} 项通过`);
if ((process.exitCode ?? 0) !== 0) process.exit(process.exitCode);
