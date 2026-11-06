/**
 * 模板包（shared/template-pack.ts）与 DSL 扩展（shared/custom-template.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/template-pack.test.ts
 */

import assert from 'node:assert/strict';
import {
  compareVersions,
  isMarketTemplateId,
  parsePack,
  serializePack,
  validateTemplatePack,
  PACK_FORMAT_VERSION,
  type TemplatePack,
} from '../../src/shared/template-pack.ts';
import {
  applyParamBinding,
  createShapeElement,
  createTextElement,
  createVideoElement,
  validateCustomTemplateDef,
  type CustomTemplateDef,
} from '../../src/shared/custom-template.ts';
import {
  customTemplateToMeta,
  marketPackToMeta,
  mergeTemplateMetas,
  findDataDrivenDef,
  isDataDrivenTemplateId,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 构造一个合法的最小 def */
const makeDef = (id = 'mkt-test-tpl'): CustomTemplateDef => ({
  id,
  name: '测试模板',
  duration: 8,
  background: '#000',
  orientation: 'landscape',
  isCustom: true,
  elements: [createVideoElement(), createTextElement('title')],
});

/** 构造一个合法的最小模板包 */
const makePack = (overrides: Partial<TemplatePack> = {}): TemplatePack => ({
  formatVersion: PACK_FORMAT_VERSION,
  id: 'mkt-test-tpl',
  name: '测试模板',
  version: '1.0.0',
  def: makeDef(),
  ...overrides,
});

// ====== 1. 版本比较 ======

console.log('compareVersions:');
{
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('1.1.9', '1.2.0'), -1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0, '缺段按 0 计');
  assert.equal(compareVersions('1.2.1', '1.2'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1, '按数字而非字符串比较');
  ok('版本排序正确（含缺段/多位数）');
}

// ====== 2. id 前缀 =====

console.log('isMarketTemplateId / isDataDrivenTemplateId:');
{
  assert.ok(isMarketTemplateId('mkt-neon-wave'));
  assert.ok(!isMarketTemplateId('custom-abc'));
  assert.ok(!isMarketTemplateId('RevealSlide'));
  assert.ok(isDataDrivenTemplateId('mkt-x'));
  assert.ok(isDataDrivenTemplateId('custom-x'));
  assert.ok(!isDataDrivenTemplateId('RevealSlide'));
  ok('前缀判断正确');
}

// ====== 3. 包校验 =====

console.log('validateTemplatePack:');
{
  assert.deepEqual(validateTemplatePack(makePack()), [], '合法包应通过');
  ok('合法包通过校验');

  assert.ok(validateTemplatePack(makePack({id: 'custom-abc'})).some((e) => e.includes('mkt-')), '非 mkt- 前缀拒绝');
  assert.ok(validateTemplatePack(makePack({id: 'mkt-UPPER'})).length > 0, '大写 id 拒绝');
  ok('非法 id 拒绝');

  assert.ok(validateTemplatePack(makePack({version: 'v1.0'})).some((e) => e.includes('version')));
  assert.ok(validateTemplatePack(makePack({version: '1.0.0.0.1'})).length > 0);
  ok('非法版本号拒绝');

  const mismatch = makePack({def: makeDef('mkt-other-id')});
  assert.ok(validateTemplatePack(mismatch).some((e) => e.includes('def.id')));
  ok('def.id 与包 id 不一致拒绝');

  const badDef = makePack({def: {...makeDef(), elements: []} as CustomTemplateDef});
  assert.ok(validateTemplatePack(badDef).some((e) => e.startsWith('def:')), 'def 校验错误应冒泡并带 def: 前缀');
  ok('def 错误冒泡');

  assert.ok(validateTemplatePack(makePack({thumbnail: 'https://evil.com/x.svg'})).some((e) => e.includes('thumbnail')), '远程 URL 缩略图拒绝');
  assert.deepEqual(
    validateTemplatePack(makePack({thumbnail: 'data:image/svg+xml;base64,PHN2Zy8+'})),
    [],
    'data-URI 缩略图放行',
  );
  ok('缩略图校验');

  assert.ok(validateTemplatePack(makePack({formatVersion: 99})).some((e) => e.includes('formatVersion')));
  ok('未知 formatVersion 拒绝');
}

// ====== 4. 序列化往返 =====

console.log('serializePack / parsePack:');
{
  const pack = makePack({description: '描述', tags: ['科技', '发布'], author: '片语'});
  const text = serializePack(pack);
  const {pack: parsed, errors} = parsePack(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(parsed, pack);
  ok('往返序列化一致');

  assert.ok(parsePack('{not json').errors.some((e) => e.includes('JSON')));
  ok('坏 JSON 报错');
}

// ====== 5. DSL：shape 元素校验 =====

console.log('validateCustomTemplateDef (shape/params):');
{
  const def = makeDef();
  def.elements.push(createShapeElement('ellipse'));
  assert.deepEqual(validateCustomTemplateDef(def), [], 'shape 元素应通过');
  ok('shape 元素通过校验');

  const bad = makeDef();
  bad.elements.push({...createShapeElement(), shape: 'triangle' as never});
  assert.ok(validateCustomTemplateDef(bad).some((e) => e.includes('shape')));
  ok('非法 shape 种类拒绝');

  const badBlur = makeDef();
  badBlur.elements.push({...createShapeElement(), blur: 5});
  assert.ok(validateCustomTemplateDef(badBlur).some((e) => e.includes('blur')));
  ok('blur 超范围拒绝');
}

// ====== 6. DSL：paramSpecs / paramBindings 校验 =====

console.log('paramSpecs / paramBindings 校验:');
{
  const vid = createVideoElement();
  const def: CustomTemplateDef = {
    ...makeDef(),
    elements: [vid],
    paramSpecs: [{key: 'size', label: '元素大小', min: 0.5, max: 2, step: 0.1, default: 1}],
    paramBindings: [{paramKey: 'size', elementId: vid.id, prop: 'scale', mode: 'multiply'}],
  };
  assert.deepEqual(validateCustomTemplateDef(def), []);
  ok('合法参数+绑定通过');

  const dup = {...def, paramSpecs: [...def.paramSpecs!, def.paramSpecs![0]]};
  assert.ok(validateCustomTemplateDef(dup).some((e) => e.includes('重复')));
  ok('参数 key 重复拒绝');

  const unknownParam = {...def, paramBindings: [{paramKey: 'nope', elementId: vid.id, prop: 'scale' as const, mode: 'multiply' as const}]};
  assert.ok(validateCustomTemplateDef(unknownParam).some((e) => e.includes('paramKey')));
  ok('绑定引用未知参数拒绝');

  const unknownEl = {...def, paramBindings: [{paramKey: 'size', elementId: 'el-ghost', prop: 'scale' as const, mode: 'multiply' as const}]};
  assert.ok(validateCustomTemplateDef(unknownEl).some((e) => e.includes('elementId')));
  ok('绑定引用未知元素拒绝');

  const badMode = {...def, paramBindings: [{paramKey: 'size', elementId: vid.id, prop: 'scale' as const, mode: 'pow' as never}]};
  assert.ok(validateCustomTemplateDef(badMode).some((e) => e.includes('mode')));
  ok('非法 mode 拒绝');
}

// ====== 7. applyParamBinding 求值 =====

console.log('applyParamBinding:');
{
  const vid = createVideoElement();
  const def: CustomTemplateDef = {
    ...makeDef(),
    elements: [vid],
    paramSpecs: [
      {key: 'size', label: '大小', min: 0.5, max: 2, step: 0.1, default: 1},
      {key: 'shift', label: '水平偏移', min: -0.2, max: 0.2, step: 0.01, default: 0},
    ],
    paramBindings: [
      {paramKey: 'size', elementId: vid.id, prop: 'scale', mode: 'multiply'},
      {paramKey: 'shift', elementId: vid.id, prop: 'x', mode: 'add'},
    ],
  };

  assert.equal(applyParamBinding(def, undefined, vid.id, 'scale', 0.8), 0.8, '无参数值时用 default=1（×1 不变）');
  ok('缺省回退 default');

  assert.equal(applyParamBinding(def, {size: 2}, vid.id, 'scale', 0.8), 1.6);
  ok('multiply 模式');

  assert.ok(Math.abs(applyParamBinding(def, {shift: 0.1}, vid.id, 'x', 0.5) - 0.6) < 1e-9);
  ok('add 模式');

  assert.equal(applyParamBinding(def, {size: 2}, vid.id, 'y', 0.5), 0.5, '未绑定的属性不受影响');
  ok('未绑定属性透传');

  assert.equal(applyParamBinding(def, {size: 2}, 'el-other', 'scale', 0.8), 0.8, '其他元素不受影响');
  ok('按元素隔离');

  const noBindings = makeDef();
  assert.equal(applyParamBinding(noBindings, {size: 2}, vid.id, 'scale', 0.8), 0.8);
  ok('无 paramBindings 直接透传');
}

// ====== 8. meta 合并 =====

console.log('meta 合并:');
{
  const pack = makePack({name: '霓虹波浪', description: '科技感'});
  const meta = marketPackToMeta(pack);
  assert.equal(meta.id, 'mkt-test-tpl');
  assert.ok(meta.name.includes('霓虹波浪'));
  assert.equal(meta.defaultDuration, 8);
  ok('marketPackToMeta 字段正确');

  const customDef = makeDef('custom-abc');
  const merged = mergeTemplateMetas([customDef], [pack]);
  assert.ok(merged.length >= 2);
  assert.ok(merged.some((t) => t.id === 'custom-abc'));
  assert.ok(merged.some((t) => t.id === 'mkt-test-tpl'));
  assert.ok(merged.some((t) => t.id === 'RevealSlide'), '内置模板在列');
  ok('mergeTemplateMetas 三方合并');

  assert.equal(findDataDrivenDef('mkt-test-tpl', [customDef], [pack])?.id, 'mkt-test-tpl');
  assert.equal(findDataDrivenDef('custom-abc', [customDef], [pack])?.id, 'custom-abc');
  assert.equal(findDataDrivenDef('ghost', [customDef], [pack]), undefined);
  ok('findDataDrivenDef 查找');

  const withParams = customTemplateToMeta({...customDef, paramSpecs: [{key: 's', label: 'S', min: 0, max: 1, step: 0.1, default: 1}]});
  assert.equal(withParams.paramSpecs?.length, 1, 'customTemplateToMeta 透传 paramSpecs');
  ok('paramSpecs 透传');
}

console.log(`\n全部通过（${passed} 项）`);
