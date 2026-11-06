/**
 * 片尾退场预设（exitStyle）单元测试
 * 覆盖：trailingForExit 留白映射 / LLM 校验器枚举 / toFullSpec 缺省 / patch 透传
 *
 * 运行方式：node tests/unit/exit-style.test.ts
 */

import assert from 'node:assert/strict';
import {trailingForExit} from '../../src/remotion/utils/timing.ts';
import {createLlmTools} from '../../src/shared/llm-tools.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS, EXIT_STYLE_OPTIONS} from '../../src/shared/types.ts';

const {toolDefs, validateStoryboardSpec, validateSegmentPatch} = createLlmTools({
  templates: TEMPLATES,
  transitions: TRANSITION_OPTIONS.map((t) => t.value),
  videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
  backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
  textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
});

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('trailingForExit 留白映射:');
{
  assert.equal(trailingForExit(undefined, 45), 10);
  assert.equal(trailingForExit('sync', 45), 10);
  assert.equal(trailingForExit('fade', 60), 10);
  assert.equal(trailingForExit('stagger', 45), 45);
  assert.equal(trailingForExit('stagger', 60), 60);
  ok('sync/fade=10 帧（播到转场前），stagger=模板旧默认');
}

console.log('EXIT_STYLE_OPTIONS:');
{
  assert.deepEqual(EXIT_STYLE_OPTIONS.map((o) => o.value), ['sync', 'fade', 'stagger']);
  ok('预设三档且 sync 为首（默认）');
}

console.log('validateStoryboardSpec exitStyle:');
{
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', exitStyle: 'fade'}]});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.segments[0].exitStyle, 'fade');
  ok('合法 exitStyle 通过并透传');
}
{
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide'}]});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.segments[0].exitStyle, undefined);
  ok('缺省 exitStyle = undefined（应用层回退 sync）');
}
{
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', exitStyle: 'boom'}]});
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('退场预设')));
  ok('非法 exitStyle 报错并定位字段');
}

console.log('validateSegmentPatch exitStyle:');
{
  const r = validateSegmentPatch({templateId: 'StackCards', exitStyle: 'stagger'}, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.exitStyle, 'stagger');
  ok('patch 合法透传');
}
{
  const r = validateSegmentPatch({templateId: 'StackCards'}, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.exitStyle, undefined);
  ok('patch 缺省 = undefined（保留片段现有值）');
}

console.log('工具 schema:');
{
  const setSb = toolDefs.find((d) => d.function.name === 'set_storyboard');
  const params = JSON.stringify(setSb?.function.parameters ?? {});
  assert.ok(params.includes('"exitStyle"'), 'set_storyboard 参数缺少 exitStyle');
  assert.ok(params.includes('stagger'), 'exitStyle 枚举缺少 stagger');
  const updateSeg = toolDefs.find((d) => d.function.name === 'update_segment');
  assert.ok(JSON.stringify(updateSeg?.function.parameters ?? {}).includes('"exitStyle"'));
  ok('set_storyboard / update_segment schema 均含 exitStyle');
}

console.log(`\n全部通过（${passed} 项）`);
