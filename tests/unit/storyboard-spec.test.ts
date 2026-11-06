/**
 * LLM 故事板规格校验器单元测试
 *
 * 运行方式：node tests/unit/storyboard-spec.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import {createLlmTools, LLM_TOOL_REGISTRY, parseIndexArg, validateViewFrameArgs, validateSetTrimArgs, validateSetViewportArgs, validateSetCaptionsArgs, validateDuckingArgs, validateLogoArgs, validateAutoBeatMontageArgs, validateStabilizeClipArgs, validateSetStabilizationArgs} from '../../src/shared/llm-tools.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS} from '../../src/shared/types.ts';

// 用真实模板/枚举清单构建（与渲染端一致）
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

console.log('validateStoryboardSpec 合法输入:');
{
  const r = validateStoryboardSpec({
    segments: [
      {templateId: 'RevealSlide', duration: 8, text: {title: 'AI 智能选片', features: ['1秒筛选2000张']}},
      {templateId: 'OutroCTA', transition: 'zoom', backgroundEffect: 'particles', text: {brandName: '智影'}},
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.segments.length, 2);
    // 默认值补齐
    assert.equal(r.segments[0].transition, 'crossfade');
    assert.equal(r.segments[0].videoEffect, 'none');
    assert.equal(r.segments[0].backgroundEffect, 'none');
    assert.equal(r.segments[0].text.subtitle, '');
    assert.equal(r.segments[0].text.brandName, '');
    assert.deepEqual(r.segments[0].text.features, ['1秒筛选2000张']);
    assert.equal(r.segments[1].duration, 5); // OutroCTA 默认时长
    assert.equal(r.segments[1].transition, 'zoom');
  }
  ok('合法输入通过并补默认值');
}
{
  const r = validateStoryboardSpec({segments: [{templateId: 'KenBurns'}]});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.segments[0].duration, 6); // KenBurns 默认时长
  ok('缺省时长取模板默认值');
}

console.log('validateStoryboardSpec 非法输入:');
{
  const r = validateStoryboardSpec(null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /segments/);
  ok('非对象参数报错');
}
{
  const r = validateStoryboardSpec({segments: []});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /1-60/);
  ok('空片段数组报错');
}
{
  const r = validateStoryboardSpec({segments: new Array(13).fill({templateId: 'KenBurns'})});
  assert.equal(r.ok, true);
  ok('13 段在上限内');
}
{
  const r = validateStoryboardSpec({segments: new Array(61).fill({templateId: 'KenBurns'})});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /1-60/);
  ok('超过 60 段报错');
}
{
  const r = validateStoryboardSpec({
    segments: [
      {templateId: '不存在模板'},
      {templateId: 'RevealSlide', duration: 99},
      {templateId: 'StackCards', transition: 'teleport', videoEffect: 'matrix', backgroundEffect: 'fire'},
    ],
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    const msg = r.errors.join('\n');
    assert.match(msg, /模板 id「不存在模板」不存在/);
    assert.match(msg, /时长必须是 0.5-60/);
    assert.match(msg, /转场「teleport」不存在/);
    assert.match(msg, /视频特效「matrix」不存在/);
    assert.match(msg, /背景特效「fire」不存在/);
    // 错误带段落定位
    assert.match(msg, /第 2 段/);
    assert.match(msg, /第 3 段/);
  }
  ok('坏模板/超长时长/坏枚举全部报错且一次收集');
}
{
  const longTitle = '字'.repeat(31);
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', text: {title: longTitle}}]});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join(''), /主标题超过 30 字/);
  ok('超长标题报错');
}

console.log('textAnim / narration:');
{
  const r = validateStoryboardSpec({
    segments: [
      {templateId: 'RevealSlide', textAnim: 'fadeUp', narration: {text: '这是一段旁白'}, text: {title: '标题'}},
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.segments[0].textAnim, 'fadeUp');
    assert.deepEqual(r.segments[0].narration, {text: '这是一段旁白'});
  }
  ok('textAnim + narration 合法输入通过');
}
{
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', textAnim: 'fly'}]});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join(''), /文字动效「fly」不存在/);
  ok('非法 textAnim 报错');
}
{
  // narration.text 截断到 200 字
  const long = '字'.repeat(250);
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', narration: {text: long}}]});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.segments[0].narration!.text.length, 200);
  ok('旁白文案超长截断到 200 字');
}
{
  // 未指定 textAnim/narration 时为 undefined（不影响其余字段）
  const r = validateStoryboardSpec({segments: [{templateId: 'KenBurns'}]});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.segments[0].textAnim, undefined);
    assert.equal(r.segments[0].narration, undefined);
  }
  ok('textAnim/narration 缺省为 undefined');
}

console.log('validateSegmentPatch:');
{
  const r = validateSegmentPatch({templateId: 'MinimalFloat', duration: 5}, 2);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.templateId, 'MinimalFloat');
  ok('合法 patch 通过');
}
{
  const r = validateSegmentPatch({duration: 6}, 0, 'MinimalFloat');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.patch.templateId, 'MinimalFloat');
    assert.equal(r.patch.duration, 6);
  }
  ok('patch 缺 templateId 时沿用原模板（fallback）');
}
{
  // 执行器必传 fallback，此处防御性：无 fallback 且缺 templateId 判死
  const r = validateSegmentPatch({duration: 6}, 0);
  assert.equal(r.ok, false);
  ok('缺 templateId 且无 fallback 的 patch 报错');
}
{
  // patch 换模板：按新模板解析（paramSpecs/字幕时长上界跟随新模板）
  const r = validateSegmentPatch({templateId: '不存在模板', duration: 6}, 0, 'MinimalFloat');
  assert.equal(r.ok, false);
  ok('patch 给出不存在的 templateId 仍报错');
}

console.log('customParams 校验:');
{
  // 合法参数原样通过，notes 为空
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', customParams: {pipScale: 1.2, tiltX: -10}}]});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.segments[0].customParams, {pipScale: 1.2, tiltX: -10});
    assert.deepEqual(r.notes, []);
  }
  ok('合法 customParams 通过且无提示');
}
{
  // 越界钳制 + 未知键丢弃 + 非数字丢弃：不判死，进 notes
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', customParams: {pipScale: 99, badKey: 1, tiltX: 'x'}}]});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.segments[0].customParams, {pipScale: 1.6}, 'pipScale 钳到上限，badKey/非数字被丢弃');
    assert.equal(r.notes.length, 3);
    assert.match(r.notes.join('\n'), /pipScale.*钳制/);
    assert.match(r.notes.join('\n'), /未知参数「badKey」/);
  }
  ok('越界钳制/未知键/非数字进 notes 不判死');
}
{
  // 全部键被丢弃时 customParams 为 undefined（不落空对象）
  const r = validateSegmentPatch({templateId: 'RevealSlide', customParams: {nope: 1}}, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.customParams, undefined);
  ok('全部键无效时 customParams 归 undefined');
}
{
  // 非对象报错
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', customParams: 5}]});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join(''), /customParams 必须是/);
  ok('customParams 非对象报错');
}
{
  // 未指定时为 undefined（patch 保留原值语义不受影响）
  const r = validateSegmentPatch({templateId: 'RevealSlide'}, 0);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.customParams, undefined);
  ok('缺省为 undefined');
}
{
  // 数据驱动模板（自定义/市场）：按各自 paramSpecs 校验；无 paramSpecs 的模板整包忽略
  const llm2 = createLlmTools({
    templates: [
      {id: 'custom-x', name: '自定义模板', description: '', minVideos: 1, maxVideos: 6, defaultDuration: 8,
        paramSpecs: [{key: 'speed', label: '速度', min: 0.5, max: 2, step: 0.1, default: 1}]},
      {id: 'custom-noparams', name: '无参模板', description: '', minVideos: 1, maxVideos: 6, defaultDuration: 8},
    ],
    transitions: TRANSITION_OPTIONS.map((t) => t.value),
    videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
    backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
    textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
  });
  const r = llm2.validateStoryboardSpec({segments: [
    {templateId: 'custom-x', customParams: {speed: 3, junk: 1}},
    {templateId: 'custom-noparams', customParams: {speed: 1}},
  ]});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.segments[0].customParams, {speed: 2}, '自定义模板参数同样钳制');
    assert.equal(r.segments[1].customParams, undefined, '无 paramSpecs 模板整包忽略');
    assert.match(r.notes.join('\n'), /无可调参数/);
  }
  ok('数据驱动模板按各自 paramSpecs 校验，无参模板整包忽略');
}

console.log('字幕校验:');
{
  // 合法字幕
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', duration: 8, captions: [
    {text: '第一句', startSec: 0, endSec: 2},
    {text: '第二句', startSec: 2, endSec: 4},
  ]}]});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.segments[0].captions?.length, 2);
    assert.equal(r.segments[0].captions?.[1].text, '第二句');
  }
  ok('合法字幕通过');
}
{
  // endSec 超过段时长
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', duration: 5, captions: [
    {text: '超时', startSec: 0, endSec: 6},
  ]}]});
  assert.equal(r.ok, false);
  ok('字幕 endSec 超段时长报错');
}
{
  // endSec <= startSec
  const r = validateStoryboardSpec({segments: [{templateId: 'RevealSlide', duration: 8, captions: [
    {text: '错', startSec: 3, endSec: 3},
  ]}]});
  assert.equal(r.ok, false);
  ok('字幕 endSec 不大于 startSec 报错');
}

console.log('工具 schema:');
{
  const names = toolDefs.map((t) => t.function.name);
  // 工具清单以 LLM_TOOL_REGISTRY 为唯一事实源（新增工具无需改本测试）
  assert.deepEqual(names, LLM_TOOL_REGISTRY.map((e) => e.name));
  assert.equal(new Set(names).size, names.length, '注册表存在重复工具名');
  for (const t of toolDefs) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.description.length > 0);
    assert.ok(t.function.parameters);
  }
  ok(`${names.length} 个工具 schema 与注册表一致且结构完整`);
}

console.log('阶段二新工具校验器:');
{
  const r = parseIndexArg({index: 2});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.index, 2);
  assert.equal(parseIndexArg({index: -1}).ok, false);
  assert.equal(parseIndexArg({index: 1.5}).ok, false);
  assert.equal(parseIndexArg({}).ok, false);
  ok('parseIndexArg 整数下标校验');
}
{
  const r = validateViewFrameArgs({index: 0, videoIndex: 1, timeSec: 3.5});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.videoIndex, 1);
    assert.equal(r.args.timeSec, 3.5);
  }
  // videoIndex/timeSec 缺省
  const r2 = validateViewFrameArgs({index: 0});
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.args.videoIndex, 0);
  assert.equal(validateViewFrameArgs({index: 0, timeSec: -1}).ok, false);
  ok('validateViewFrameArgs 合法/缺省/非法');
}
{
  const r = validateSetTrimArgs({index: 0, trimStart: 2, trimEnd: 8});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.trimEnd, 8);
  assert.equal(validateSetTrimArgs({index: 0, trimStart: 8, trimEnd: 2}).ok, false); // start>=end
  assert.equal(validateSetTrimArgs({index: 0, trimStart: -1, trimEnd: 2}).ok, false);
  assert.equal(validateSetTrimArgs({index: 0, trimStart: 2}).ok, false); // 缺 trimEnd
  // trimStart 缺省 0、trimEnd 5 -> 0<5 合法
  const r3t = validateSetTrimArgs({index: 0, trimEnd: 5});
  assert.equal(r3t.ok, true);
  if (r3t.ok) assert.equal(r3t.args.trimStart, 0);
  ok('validateSetTrimArgs 区间校验');
}
{
  const r = validateSetViewportArgs({index: 0, scale: 1.5, offsetX: 0.2});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.scale, 1.5);
    assert.equal(r.args.offsetX, 0.2);
    assert.equal(r.args.offsetY, undefined);
  }
  // 越界自动钳制
  const r2 = validateSetViewportArgs({index: 0, scale: 99});
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.args.scale, 5); // 钳到上限
  const r3 = validateSetViewportArgs({index: 0, offsetX: 2});
  assert.equal(r3.ok, true);
  if (r3.ok) assert.equal(r3.args.offsetX, 0.5); // 钳到上限
  assert.equal(validateSetViewportArgs({index: -1}).ok, false);
  ok('validateSetViewportArgs 钳制与校验');
}

console.log('阶段三新工具校验器:');
{
  const r = validateSetCaptionsArgs({index: 0, captions: [{text: '嗨', startSec: 0, endSec: 1}]});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.captions.length, 1);
  // 空数组合法（表示清除）
  assert.equal(validateSetCaptionsArgs({index: 0, captions: []}).ok, true);
  assert.equal(validateSetCaptionsArgs({index: 0, captions: [{text: 'x', startSec: 1, endSec: 0}]}).ok, false); // end<=start
  assert.equal(validateSetCaptionsArgs({index: -1, captions: []}).ok, false);
  assert.equal(validateSetCaptionsArgs({index: 0}).ok, false); // 缺 captions
  ok('validateSetCaptionsArgs 校验');
}
{
  const r = validateDuckingArgs({enabled: true, amount: 0.3});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.enabled, true);
    assert.equal(r.args.amount, 0.3);
  }
  // amount 缺省 0.25
  const r2 = validateDuckingArgs({enabled: false});
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.args.amount, 0.25);
  // amount 越界钳制到 [0.1, 1]
  const r3 = validateDuckingArgs({enabled: true, amount: 5});
  assert.equal(r3.ok, true);
  if (r3.ok) assert.equal(r3.args.amount, 1);
  assert.equal(validateDuckingArgs({amount: 0.3}).ok, false); // 缺 enabled
  ok('validateDuckingArgs 校验与钳制');
}
{
  const r = validateLogoArgs({position: 'topRight', size: 0.2, opacity: 0.8});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.position, 'topRight');
    assert.equal(r.args.size, 0.2);
    assert.equal(r.args.visible, undefined);
  }
  // size 越界钳制到 [0.05, 0.4]
  const r2 = validateLogoArgs({size: 99});
  assert.equal(r2.ok, true);
  if (r2.ok) assert.equal(r2.args.size, 0.4);
  assert.equal(validateLogoArgs({position: 'middle'}).ok, false); // 非法位置
  assert.equal(validateLogoArgs({}).ok, false); // 全空
  ok('validateLogoArgs 校验与钳制');
}
{
  // 空参数合法（全缺省）
  const r0 = validateAutoBeatMontageArgs({});
  assert.equal(r0.ok, true);
  if (r0.ok) {
    assert.equal(r0.args.targetSec, undefined);
    assert.equal(r0.args.autoMoneyShot, false);
    assert.equal(r0.args.directives, undefined);
  }
  // 完整指令
  const r = validateAutoBeatMontageArgs({
    targetSec: 30,
    autoMoneyShot: true,
    directives: {
      openingShot: {source: 0, shot: 2},
      firstDropShot: {source: 1, shot: 0},
      excludeShots: [{source: 2, shot: 1}],
      slotBeats: {drop: 0.4, build: 99, bogus: 3}, // 钳制 + 未知键忽略
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.targetSec, 30);
    assert.equal(r.args.autoMoneyShot, true);
    assert.deepEqual(r.args.directives?.openingShot, {source: 0, shot: 2});
    assert.deepEqual(r.args.directives?.excludeShots, [{source: 2, shot: 1}]);
    assert.deepEqual(r.args.directives?.slotBeats, {drop: 1, build: 8});
  }
  // 非法参数
  assert.equal(validateAutoBeatMontageArgs({targetSec: -5}).ok, false);
  assert.equal(validateAutoBeatMontageArgs({directives: {openingShot: {source: -1, shot: 0}}}).ok, false);
  assert.equal(validateAutoBeatMontageArgs({directives: {excludeShots: [{source: 0}]}}).ok, false);
  assert.equal(validateAutoBeatMontageArgs({directives: {slotBeats: {drop: 'fast'}}}).ok, false);
  ok('validateAutoBeatMontageArgs 校验与钳制');
}

{
  // ===== 跟踪稳定双工具 =====
  // 注册表有条目（MCP 同源自动跟随）
  const names = new Set(LLM_TOOL_REGISTRY.map((e) => e.name));
  assert.ok(names.has('stabilize_clip') && names.has('set_stabilization'), '稳定双工具已注册');

  // stabilize_clip：segmentIndex 必填，clipIndex 缺省 0，points 缺省 = 自动选点，smoothSec 缺省 0.8
  const r1 = validateStabilizeClipArgs({segmentIndex: 2});
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.args.segmentIndex, 2);
    assert.equal(r1.args.clipIndex, 0);
    assert.equal(r1.args.points, undefined);
    assert.equal(r1.args.smoothSec, 0.8);
  }
  // smoothSec 越界钳制 + 显式双点
  const r2 = validateStabilizeClipArgs({segmentIndex: 0, clipIndex: 1, smoothSec: 99, points: [{x: 10, y: 20}, {x: 300, y: 400}]});
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.args.smoothSec, 2, 'smoothSec 钳到上限 2');
    assert.equal(r2.args.points?.length, 2);
  }
  // 非法：缺 segmentIndex / 点超 2 个 / 负坐标
  assert.equal(validateStabilizeClipArgs({}).ok, false);
  assert.equal(validateStabilizeClipArgs({segmentIndex: -1}).ok, false);
  assert.equal(validateStabilizeClipArgs({segmentIndex: 0, points: [{x: 1, y: 1}, {x: 2, y: 2}, {x: 3, y: 3}]}).ok, false);
  assert.equal(validateStabilizeClipArgs({segmentIndex: 0, points: [{x: -5, y: 10}]}).ok, false);
  ok('validateStabilizeClipArgs 默认值/钳制/非法拒绝');

  // set_stabilization：三字段全缺拒绝；enabled 非布尔拒绝；合法组合通过
  assert.equal(validateSetStabilizationArgs({segmentIndex: 0}).ok, false);
  assert.equal(validateSetStabilizationArgs({segmentIndex: 0, enabled: 'yes'}).ok, false);
  const r3 = validateSetStabilizationArgs({segmentIndex: 1, enabled: false, smoothSec: 0.1});
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.args.enabled, false);
    assert.equal(r3.args.smoothSec, 0.2, 'smoothSec 钳到下限 0.2');
    assert.equal(r3.args.points, undefined);
  }
  const r4 = validateSetStabilizationArgs({segmentIndex: 1, points: [{x: 0, y: 0}]});
  assert.equal(r4.ok, true);
  if (r4.ok) assert.equal(r4.args.points?.length, 1);
  ok('validateSetStabilizationArgs 至少一字段/类型/钳制');
}

console.log(`\n全部通过（${passed} 组断言）`);
