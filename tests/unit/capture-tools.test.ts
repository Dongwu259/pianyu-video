/**
 * 录屏/截屏 LLM 工具参数校验器 + 选区光标映射（dipToVideoPoint）单元测试
 *
 * 运行方式：node tests/unit/capture-tools.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import {
  createLlmTools,
  LLM_TOOL_REGISTRY,
  validateScreenshotArgs,
  validateStartRecordingArgs,
  validateStopRecordingArgs,
  validateDeleteSegmentArgs,
  validateMoveSegmentArgs,
  validateRemoveSegmentMediaArgs,
} from '../../src/shared/llm-tools.ts';
import {dipToVideoPoint, computeOutputSize, estimateBitrateMbps} from '../../src/shared/capture.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 工具 schema 注册 ======

console.log('工具 schema 注册:');
{
  const {toolDefs} = createLlmTools({
    templates: TEMPLATES,
    transitions: TRANSITION_OPTIONS.map((t) => t.value),
    videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
    backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
    textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
  });
  const names = toolDefs.map((t) => t.function.name);
  // 工具清单以 LLM_TOOL_REGISTRY 为唯一事实源（新增工具无需改本测试）
  assert.deepEqual(names, LLM_TOOL_REGISTRY.map((e) => e.name));
  // 录屏/截屏工具组（注册表中按命名筛选，共 6 个）全部出现在 schema 里
  const captureNames = LLM_TOOL_REGISTRY.map((e) => e.name).filter((n) => /capture|screenshot|recording/.test(n));
  assert.equal(captureNames.length, 6, '注册表中录屏/截屏工具数量变化');
  for (const n of captureNames) {
    assert.ok(names.includes(n), `缺少工具 ${n}`);
  }
  ok('6 个录屏/截屏工具已注册');
}

// ====== validateScreenshotArgs ======

console.log('validateScreenshotArgs:');
{
  const r = validateScreenshotArgs({});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.saveToStoryboard, false);
    assert.equal(r.args.sourceId, undefined);
    assert.equal(r.args.segmentIndex, undefined);
  }
  ok('空参数通过且补默认值');
}
{
  const r = validateScreenshotArgs({sourceId: 'screen:0:0', saveToStoryboard: true, segmentIndex: 2});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.sourceId, 'screen:0:0');
    assert.equal(r.args.saveToStoryboard, true);
    assert.equal(r.args.segmentIndex, 2);
  }
  ok('完整合法参数通过');
}
{
  const r = validateScreenshotArgs(null);
  assert.equal(r.ok, true); // null 视为全缺省（模型常传 null）
  ok('null 参数按全缺省通过');
}
{
  const r = validateScreenshotArgs({sourceId: 123});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /sourceId/);
  ok('非字符串 sourceId 报错');
}
{
  const r = validateScreenshotArgs({segmentIndex: -1});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /segmentIndex/);
  ok('负数 segmentIndex 报错');
}
{
  const r = validateScreenshotArgs({saveToStoryboard: 'yes'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /saveToStoryboard/);
  ok('非布尔 saveToStoryboard 报错');
}

// ====== validateStartRecordingArgs ======

console.log('validateStartRecordingArgs:');
{
  const r = validateStartRecordingArgs({});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.withMic, false);
  ok('空参数通过且 withMic 默认 false');
}
{
  const r = validateStartRecordingArgs({sourceId: 'window:123:0', withMic: true});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.sourceId, 'window:123:0');
    assert.equal(r.args.withMic, true);
  }
  ok('窗口源 + 麦克风通过');
}
{
  const r = validateStartRecordingArgs({withMic: 1});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /withMic/);
  ok('非布尔 withMic 报错');
}
{
  const r = validateStartRecordingArgs({});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.withSystemAudio, false);
  ok('空参数 withSystemAudio 默认 false');
}
{
  const r = validateStartRecordingArgs({sourceId: 'screen:0:0', withSystemAudio: true});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.withSystemAudio, true);
  ok('withSystemAudio=true 通过');
}
{
  const r = validateStartRecordingArgs({withSystemAudio: 'yes'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /withSystemAudio/);
  ok('非布尔 withSystemAudio 报错');
}
{
  const r = validateStartRecordingArgs({countdownSec: 3});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.countdownSec, 3);
  ok('countdownSec=3 通过');
}
{
  const r = validateStartRecordingArgs({countdownSec: 0});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.countdownSec, 0);
  ok('countdownSec=0 通过（立即起录）');
}
{
  const r = validateStartRecordingArgs({countdownSec: 11});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /countdownSec/);
  ok('countdownSec>10 报错');
}
{
  const r = validateStartRecordingArgs({countdownSec: 1.5});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /countdownSec/);
  ok('非整数 countdownSec 报错');
}

// ====== validateStopRecordingArgs ======

console.log('validateStopRecordingArgs:');
{
  const r = validateStopRecordingArgs({});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.segmentIndex, undefined);
  ok('空参数通过');
}
{
  const r = validateStopRecordingArgs({segmentIndex: 0});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.segmentIndex, 0);
  ok('segmentIndex=0 通过（下标含 0）');
}
{
  const r = validateStopRecordingArgs({segmentIndex: 1.5});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /segmentIndex/);
  ok('非整数 segmentIndex 报错');
}
{
  const r = validateStopRecordingArgs({trimStartSec: 1.2, trimEndSec: 8});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.trimStartSec, 1.2);
    assert.equal(r.args.trimEndSec, 8);
  }
  ok('掐头去尾区间通过');
}
{
  const r = validateStopRecordingArgs({trimEndSec: 5});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.trimStartSec, undefined);
    assert.equal(r.args.trimEndSec, 5);
  }
  ok('仅 trimEndSec（只去尾）通过');
}
{
  const r = validateStopRecordingArgs({trimStartSec: -1});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /trimStartSec/);
  ok('负 trimStartSec 报错');
}
{
  const r = validateStopRecordingArgs({trimStartSec: 8, trimEndSec: 3});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /trimEndSec/);
  ok('trimEndSec ≤ trimStartSec 报错');
}

// ====== dipToVideoPoint（选区偏移光标映射）======

console.log('dipToVideoPoint 选区偏移:');
{
  // 无 region 保持整屏换算：视频像素 = (DIP - 屏原点) × scaleFactor
  const pt = dipToVideoPoint(150, 80, {x: 100, y: 20, scaleFactor: 2});
  assert.deepEqual(pt, {x: 100, y: 120});
  ok('无选区保持整屏换算（回归）');
}
{
  const region = {x: 400, y: 200, width: 1280, height: 720};
  // 选区内：(500×2-400, 300×2-200) = (600, 400)
  const pt = dipToVideoPoint(500, 300, {x: 0, y: 0, scaleFactor: 2}, region);
  assert.deepEqual(pt, {x: 600, y: 400});
  ok('选区内锚定选区原点');
}
{
  const region = {x: 400, y: 200, width: 1280, height: 720};
  // 选区左上角本身：(200×2-400, 100×2-200) = (0, 0)
  const pt = dipToVideoPoint(200, 100, {x: 0, y: 0, scaleFactor: 2}, region);
  assert.deepEqual(pt, {x: 0, y: 0});
  ok('选区左上角映射为 (0,0)');
}
{
  const region = {x: 400, y: 200, width: 1280, height: 720};
  // 选区外左上：钳制到 (0, 0)（钉边，不跑出裁剪画面）
  const pt = dipToVideoPoint(100, 50, {x: 0, y: 0, scaleFactor: 2}, region);
  assert.deepEqual(pt, {x: 0, y: 0});
  ok('选区外左上钳到 (0,0)');
}
{
  const region = {x: 400, y: 200, width: 1280, height: 720};
  // 选区外右下：钳制到选区边缘 (width, height)
  const pt = dipToVideoPoint(2000, 1500, {x: 0, y: 0, scaleFactor: 2}, region);
  assert.deepEqual(pt, {x: 1280, y: 720});
  ok('选区外右下钉在选区边缘');
}
{
  const region = {x: 400, y: 200, width: 1280, height: 720};
  // 屏原点非 0 + 缩放 + 选区叠加：((400-100)×2-400, 300×2-200) = (200, 400)
  const pt = dipToVideoPoint(400, 300, {x: 100, y: 0, scaleFactor: 2}, region);
  assert.deepEqual(pt, {x: 200, y: 400});
  ok('屏原点偏移与选区叠加换算');
}
{
  const region = {x: 100, y: 100, width: 1280, height: 720};
  // 小数四舍五入：50.4→50、50.6→51
  const pt = dipToVideoPoint(150.4, 150.6, {x: 0, y: 0, scaleFactor: 1}, region);
  assert.deepEqual(pt, {x: 50, y: 51});
  ok('小数坐标四舍五入');
}

// ====== validateStartRecordingArgs 新增参数（sourceName / region / fps / maxHeight / bitrateMbps）======

console.log('validateStartRecordingArgs 新增参数:');
{
  const r = validateStartRecordingArgs({sourceName: 'Chrome'});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.sourceName, 'Chrome');
    assert.equal(r.args.sourceId, undefined);
  }
  ok('sourceName 模糊选源通过');
}
{
  const r = validateStartRecordingArgs({sourceName: '  设置  '});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.sourceName, '设置');
  ok('sourceName 首尾空白被裁剪');
}
{
  const r = validateStartRecordingArgs({sourceName: '   '});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /sourceName/);
  ok('空白 sourceName 报错');
}
{
  const r = validateStartRecordingArgs({sourceId: 'window:1:0', sourceName: 'Chrome'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /二选一/);
  ok('sourceId 与 sourceName 同给报错');
}
{
  const r = validateStartRecordingArgs({region: {x: 100, y: 50, width: 1280, height: 720}});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.args.region, {x: 100, y: 50, width: 1280, height: 720});
  ok('合法选区通过');
}
{
  const r = validateStartRecordingArgs({region: {x: 0, y: 0, width: 300, height: 720}});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /320×180/);
  ok('选区小于 320×180 报错');
}
{
  const r = validateStartRecordingArgs({region: {x: -5, y: 0, width: 1280, height: 720}});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /x\/y/);
  ok('负坐标选区报错');
}
{
  const r = validateStartRecordingArgs({region: {x: 0.5, y: 0, width: 1280, height: 720}});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /整数/);
  ok('非整数选区坐标报错');
}
{
  const r = validateStartRecordingArgs({region: {y: 0, width: 1280, height: 720}});
  assert.equal(r.ok, false);
  ok('缺 x 的选区报错');
}
{
  const r = validateStartRecordingArgs({fps: 60});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.fps, 60);
  ok('fps=60 通过');
}
{
  const r = validateStartRecordingArgs({fps: 5});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /fps/);
  ok('fps<10 报错');
}
{
  const r = validateStartRecordingArgs({fps: 61});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /fps/);
  ok('fps>60 报错');
}
{
  const r = validateStartRecordingArgs({maxHeight: 720});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.maxHeight, 720);
  ok('maxHeight=720 通过');
}
{
  const r = validateStartRecordingArgs({maxHeight: 100});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /maxHeight/);
  ok('maxHeight 过小报错');
}
{
  const r = validateStartRecordingArgs({bitrateMbps: 12.5});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.bitrateMbps, 12.5);
  ok('bitrateMbps=12.5 通过（允许小数）');
}
{
  const r = validateStartRecordingArgs({bitrateMbps: 50});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /bitrateMbps/);
  ok('bitrateMbps>40 报错');
}
{
  // 全参数组合一次通过
  const r = validateStartRecordingArgs({
    sourceName: 'Visual Studio Code', withMic: true, countdownSec: 3,
    region: {x: 0, y: 0, width: 2560, height: 1200}, fps: 30, maxHeight: 1080, bitrateMbps: 10,
  });
  assert.equal(r.ok, true);
  ok('全参数组合通过');
}

// ====== 剪辑三件套校验器 ======

console.log('validateDeleteSegmentArgs / validateMoveSegmentArgs / validateRemoveSegmentMediaArgs:');
{
  const r = validateDeleteSegmentArgs({index: 2});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.index, 2);
  ok('delete_segment 合法下标通过');
}
{
  const r = validateDeleteSegmentArgs({index: -1});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /index/);
  ok('delete_segment 负下标报错');
}
{
  const r = validateDeleteSegmentArgs({});
  assert.equal(r.ok, false);
  ok('delete_segment 缺 index 报错');
}
{
  const r = validateMoveSegmentArgs({fromIndex: 0, toIndex: 2});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.fromIndex, 0);
    assert.equal(r.args.toIndex, 2);
  }
  ok('move_segment 合法参数通过');
}
{
  const r = validateMoveSegmentArgs({fromIndex: 0});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /toIndex/);
  ok('move_segment 缺 toIndex 报错');
}
{
  const r = validateMoveSegmentArgs({fromIndex: -1, toIndex: 'x'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.length, 2);
  ok('move_segment 双参数同时非法报两条');
}
{
  const r = validateRemoveSegmentMediaArgs({index: 1, videoIndex: 0});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.index, 1);
    assert.equal(r.args.videoIndex, 0);
  }
  ok('remove_segment_media 合法参数通过');
}
{
  const r = validateRemoveSegmentMediaArgs({index: 1, videoIndex: -2});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /videoIndex/);
  ok('remove_segment_media 负 videoIndex 报错');
}

// ====== computeOutputSize / estimateBitrateMbps（降采样与码率估算）======

console.log('computeOutputSize / estimateBitrateMbps:');
{
  assert.equal(computeOutputSize(1920, 1080, 1080), null);
  ok('源不高于上限返回 null（不缩放）');
}
{
  assert.equal(computeOutputSize(3840, 2160), null);
  ok('未给 maxHeight 返回 null');
}
{
  assert.deepEqual(computeOutputSize(3840, 2160, 1080), {width: 1920, height: 1080});
  ok('4K → 1080p 等比减半');
}
{
  assert.deepEqual(computeOutputSize(2560, 1440, 720), {width: 1280, height: 720});
  ok('1440p → 720p 等比减半');
}
{
  // 竖屏 1080×2400 → 高度 1080：宽 = 1080×1080/2400 = 486（偶数无需取整）
  assert.deepEqual(computeOutputSize(1080, 2400, 1080), {width: 486, height: 1080});
  ok('竖屏源等比缩放');
}
{
  // 奇数上限取偶：高度 719 → 718，宽按比例取偶
  const out = computeOutputSize(1000, 2000, 719);
  assert.equal(out?.height, 718);
  assert.equal((out?.width ?? 0) % 2, 0);
  ok('奇数上限取偶数');
}
{
  assert.equal(estimateBitrateMbps(1920, 1080, 30), 8);
  ok('1080p30 基准 = 8Mbps');
}
{
  // 720p30：8 × (1280×720)/(1920×1080) = 3.556 → 3.6
  assert.equal(estimateBitrateMbps(1280, 720, 30), 3.6);
  ok('720p30 按像素等比折算');
}
{
  assert.equal(estimateBitrateMbps(640, 360, 10), 2);
  ok('极小输出钳到下限 2Mbps');
}
{
  assert.equal(estimateBitrateMbps(3840, 2160, 60, 5), 5);
  ok('显式码率直接生效');
}

console.log(`\n共 ${passed} 项全部通过`);
