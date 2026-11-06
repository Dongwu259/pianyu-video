/**
 * 参数档位选项解析 单元测试
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/param-options.test.ts
 */

import assert from 'node:assert/strict';
import {parseLabeledOptions, cleanParamLabel, augmentParamSpecOptions, augmentTemplateParamOptions} from '../../src/shared/param-options.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {THREE_SCENES} from '../../src/shared/three-scenes.ts';
import type {TemplateParamSpec} from '../../src/shared/types.ts';

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const spec = (over: Partial<TemplateParamSpec>): TemplateParamSpec =>
  ({key: 'k', label: '参数', min: 0, max: 2, step: 1, default: 1, unit: '', ...over});

test('标准档位 label 解析：值从 0 连续、剥出干净名', () => {
  const o = parseLabeledOptions('运镜(0固定/1环绕/2推轨/3摇臂)')!;
  assert.deepEqual(o.map((x) => x.value), [0, 1, 2, 3]);
  assert.deepEqual(o.map((x) => x.label), ['固定', '环绕', '推轨', '摇臂']);
});

test('非档位形态返回 null（保护连续数值参数）', () => {
  assert.equal(parseLabeledOptions('标题大小'), null);
  assert.equal(parseLabeledOptions('重点展板序号(0-5)'), null);
  assert.equal(parseLabeledOptions('连接线数量(0-6根)'), null);
});

test('非连续整数 / 单档位 / 值缺名 → null', () => {
  assert.equal(parseLabeledOptions('推荐档(0无/1-4序号)'), null); // '1-4序号' 解不出 value==1
  assert.equal(parseLabeledOptions('节奏(0快)'), null);
});

test('cleanParamLabel 剥括注', () => {
  assert.equal(cleanParamLabel('主题色(0品牌/1青碧)'), '主题色');
  assert.equal(cleanParamLabel('驻留节奏'), '驻留节奏');
});

test('augment：min=0 且档位数==max+1 才挂 options', () => {
  const a = spec({label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 2});
  augmentParamSpecOptions(a);
  assert.equal(a.options?.length, 3);
  const b = spec({label: '速度曲线(0干脆/1标准缓动/2慢起慢停)', min: 0, max: 3}); // 档位数≠max+1
  augmentParamSpecOptions(b);
  assert.equal(b.options, undefined);
  const c = spec({label: '运镜(0固定/1环绕/2推轨/3摇臂)', min: 1, max: 3}); // min≠0
  augmentParamSpecOptions(c);
  assert.equal(c.options, undefined);
});

test('sceneStyle 特例：选项来自 THREE_SCENES 且带场景渐变色', () => {
  const s = spec({key: 'sceneStyle', label: '场景(0星空/1银河)', min: 0, max: 1});
  augmentParamSpecOptions(s);
  assert.equal(s.options?.length, THREE_SCENES.length);
  assert.equal(s.options?.[1].label, THREE_SCENES[1].label);
  assert.equal(s.options?.[1].color, THREE_SCENES[1].css ?? undefined);
});

test('themeColor 特例：档位带示意色', () => {
  const t = spec({key: 'themeColor', label: '主题色(0品牌/1青碧/2罗兰紫/3琥珀金/4玫红/5翠绿)', min: 0, max: 5});
  augmentParamSpecOptions(t);
  assert.equal(t.options?.length, 6);
  assert.equal(t.options?.[0].color, '#2563EB');
  assert.equal(t.options?.[2].color, '#7C3AED');
});

test('注册表全量增强：幂等且 3D 族关键参数都有 options', () => {
  augmentTemplateParamOptions(TEMPLATES); // 二次执行不应变化（幂等）
  const city = TEMPLATES.find((t) => t.id === 'CityScape3D')!;
  const byKey = (k: string) => city.paramSpecs!.find((s) => s.key === k);
  assert.ok(byKey('themeColor')!.options?.length === 6);
  assert.ok(byKey('titleFont')!.options?.map((o) => o.label).join() === '文楷,黄油体,小薇,毛笔楷,快乐体');
  assert.ok(byKey('dwellRatio')!.options?.length === 4);
  assert.ok(byKey('camEase')!.options?.length === 3);
  assert.ok(byKey('sceneStyle')!.options?.length === THREE_SCENES.length);
  // 连续数值参数不受影响
  assert.equal(byKey('focusBoost')!.options, undefined);
  assert.equal(byKey('captionSize')!.options, undefined);
  const hero = TEMPLATES.find((t) => t.id === 'Hero3DTitle')!;
  assert.equal(hero.paramSpecs!.find((s) => s.key === 'cameraRig')!.options?.length, 4);
  const cut = TEMPLATES.find((t) => t.id === 'VideoCut')!;
  assert.equal(cut.paramSpecs!.find((s) => s.key === 'padStyle')!.options?.length, 3);
});

console.log(`[param-options] ✓ ${passed} 项全部通过`);
