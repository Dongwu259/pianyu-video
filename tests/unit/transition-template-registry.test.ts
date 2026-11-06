/**
 * 转场模板注册表（shared/transition-template-registry.ts）单测：
 * 注册表完整性 / 列表过滤 / 参数钳制 / 引用校验 / 提示词描述。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/transition-template-registry.test.ts
 */
import {
  TRANSITION_TEMPLATE_REGISTRY,
  getTransitionTemplate,
  isTransitionTemplateId,
  listTransitionTemplates,
  clampTransitionTemplateParams,
  validateTransitionTemplateRef,
  describeTransitionTemplates,
} from '../../src/shared/transition-template-registry';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

// ====== 注册表完整性 ======
{
  const ids = TRANSITION_TEMPLATE_REGISTRY.map((d) => d.id);
  ok(ids.length >= 3, '首发至少 3 枚转场模板');
  ok(new Set(ids).size === ids.length, 'id 无重复');
  for (const d of TRANSITION_TEMPLATE_REGISTRY) {
    ok(d.durationRange[0] > 0 && d.durationRange[1] >= d.durationRange[0], `${d.id} 时长范围合法`);
    ok(d.defaultDurationSec >= d.durationRange[0] && d.defaultDurationSec <= d.durationRange[1], `${d.id} 默认时长落在范围内`);
    ok(d.narrativeTags.length > 0, `${d.id} 有叙事标签`);
    ok(d.desc.length >= 10, `${d.id} 描述非空`);
  }
}

// ====== 列表过滤 ======
{
  ok(listTransitionTemplates().length === TRANSITION_TEMPLATE_REGISTRY.length, '无条件列出全量');
  ok(listTransitionTemplates({readyOnly: true}).length === 0, 'readyOnly 过滤：占位条目（composable=false）全被滤掉');
  ok(listTransitionTemplates({narrativeTag: '运动连续'}).every((d) => d.narrativeTags.includes('运动连续')), '叙事标签过滤生效');
  ok(listTransitionTemplates({allowTextCards: true}).every((d) => d.inputs !== 'video+video'), 'allowTextCards 排除 video+video 专属条目');
}

// ====== 参数钳制 ======
{
  const def = getTransitionTemplate('WhipThrough')!;
  ok(def !== undefined, 'getTransitionTemplate 命中');
  const clamped = clampTransitionTemplateParams(def, {direction: 9, blurPeak: -1, unknownKey: 5});
  ok(clamped?.direction === 4 && clamped?.blurPeak === 0, '参数钳制到 [min,max]，未知键丢弃');
  ok(clampTransitionTemplateParams(def, undefined) === undefined, 'raw 为 undefined 返回 undefined');
  ok(clampTransitionTemplateParams(def, {unknownKey: 1}) === undefined, '全未知键返回 undefined');
  ok(isTransitionTemplateId('MorphLens') === true && isTransitionTemplateId('Nope') === false, 'isTransitionTemplateId 判定');
}

// ====== 引用校验 ======
{
  const bad = validateTransitionTemplateRef('Nope', undefined);
  ok(!bad.ok && bad.ok === false && bad.errors[0].includes('未知转场模板'), '未知 id 报错并列出可用清单');
  const badParams = validateTransitionTemplateRef('MorphLens', 'not-an-object');
  ok(!badParams.ok, 'params 非对象报错');
  const good = validateTransitionTemplateRef('MorphLens', {growPower: 99});
  ok(good.ok && good.ok === true && good.params?.growPower === 1.6, '合法引用 + 参数钳到上限');
  const defaults = validateTransitionTemplateRef('ObjectSweep', undefined);
  ok(defaults.ok && defaults.ok === true && defaults.params === undefined, 'params 未给时 undefined（应用点回退模板默认）');
}

// ====== 提示词描述 ======
{
  const text = describeTransitionTemplates(TRANSITION_TEMPLATE_REGISTRY);
  ok(text.includes('MorphLens') && text.includes('"ready":false'), '描述含 id 与 ready 标记');
  ok(text.includes('回退到内置转场'), '未上线条目带回退说明');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
