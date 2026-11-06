/**
 * 素材录制构图（recordingLayout）纯几何单元测试 + start_screen_recording layout 参数校验
 *
 * 覆盖：
 * - 纯屏幕 / 摄像头缺失降级：输出 = 屏幕（选区）尺寸，无摄像头矩形
 * - 画中画：四角落位、三档尺寸、圆角描边标记、maxHeight 等比缩放
 * - 左右分屏：等高拼接 + 中缝 + 高度上限缩放，矩形不越界
 * - 上下分屏：等宽拼接同上
 * - 仅摄像头：输出 = 摄像头尺寸（含上限缩放），屏幕不参与
 * - validateStartRecordingArgs：layout 合法枚举透传 / 非法值报错
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/recording-layout.test.ts
 */

import assert from 'node:assert/strict';
import {
  computeRecordingLayout,
  pipPresetPosition,
  WEBCAM_SIZE_RATIO,
  RECORDING_LAYOUTS,
} from '../../src/shared/recordingLayout.ts';
import {validateStartRecordingArgs} from '../../src/shared/llm-tools.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const SCREEN = {width: 1920, height: 1080};
const CAM_16_9 = {width: 1280, height: 720};
const CAM_4_3 = {width: 640, height: 480};

/** 矩形必须完整落在输出画布内 */
const assertInsideCanvas = (r: {x: number; y: number; width: number; height: number}, w: number, h: number) => {
  assert.ok(r.x >= 0 && r.y >= 0, `矩形起点 (${r.x},${r.y}) 应在画布内`);
  assert.ok(r.x + r.width <= w, `矩形右缘 ${r.x + r.width} 越出画布宽 ${w}`);
  assert.ok(r.y + r.height <= h, `矩形下缘 ${r.y + r.height} 越出画布高 ${h}`);
};

console.log('computeRecordingLayout:');
{
  const r = computeRecordingLayout({screen: SCREEN});
  assert.equal(r.layout, 'screen');
  assert.deepEqual({width: r.outWidth, height: r.outHeight}, {width: 1920, height: 1080});
  assert.deepEqual(r.screenRect, {x: 0, y: 0, width: 1920, height: 1080});
  assert.equal(r.cameraRect, null);
  assert.equal(r.cameraRounded, false);
  ok('无构图参数 = 纯屏幕整幅');
}
{
  const r = computeRecordingLayout({layout: 'side', screen: SCREEN, camera: null});
  assert.equal(r.layout, 'screen');
  assert.equal(r.cameraRect, null);
  ok('摄像头缺失时任何构图降级纯屏幕（录制不失败）');
}
{
  // 缺省位置 = 右下预设：尺寸按摄像头宽高比、边距 3% 短边、圆角标记
  const r = computeRecordingLayout({layout: 'pip', screen: SCREEN, camera: CAM_4_3, size: 'medium'});
  assert.equal(r.layout, 'pip');
  assert.equal(r.outWidth, 1920);
  assert.equal(r.outHeight, 1080);
  assert.deepEqual(r.screenRect, {x: 0, y: 0, width: 1920, height: 1080});
  const c = r.cameraRect!;
  // 长边 = 短边 1080 × medium 比例；640×480 横向摄像头 → 宽为长边
  const pipLong = Math.round(1080 * WEBCAM_SIZE_RATIO.medium);
  assert.equal(c.width, pipLong);
  assert.equal(c.height, Math.round((pipLong * 480) / 640));
  assert.equal(c.x + c.width, 1920 - Math.round(1080 * 0.03)); // 右边缘贴右边距
  assert.equal(c.y + c.height, 1080 - Math.round(1080 * 0.03));
  assert.equal(r.cameraRounded, true);
  assertInsideCanvas(c, r.outWidth, r.outHeight);
  ok('画中画缺省右下：尺寸按摄像头宽高比、边距 3% 短边、圆角标记');
}
{
  // 自定义位置：归一化中心直接落位，小窗完整保持在画布内
  const r = computeRecordingLayout({layout: 'pip', screen: SCREEN, camera: CAM_16_9, pipPosition: {x: 0.5, y: 0.5}});
  const c = r.cameraRect!;
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  assert.ok(Math.abs(cx - 960) <= 1, `正中位置：小窗中心在画面中心（got ${cx}）`);
  assert.ok(Math.abs(cy - 540) <= 1, `正中位置：小窗中心在画面中心（got ${cy}）`);
  assertInsideCanvas(c, r.outWidth, r.outHeight);
  ok('自定义位置 {0.5,0.5}：小窗精确居中');
}
{
  // 越界位置钳回：小窗永远完整落在画布内（拖到边上/负坐标不裁切）
  const r = computeRecordingLayout({layout: 'pip', screen: SCREEN, camera: CAM_16_9, pipPosition: {x: -0.5, y: 2}});
  const c = r.cameraRect!;
  assert.equal(c.x, 0, '负横坐标钳到左缘');
  assert.equal(c.y + c.height, r.outHeight, '超出下界钳到底缘');
  assertInsideCanvas(c, r.outWidth, r.outHeight);
  ok('越界自定义位置钳回画布内');
}
{
  // 九宫格预设换算：中心精确 0.5；角/边中带 3% 短边边距；单轴约束正确
  const out = {width: 1920, height: 1080};
  const rect = {width: 259, height: 194};
  const p = (k: Parameters<typeof pipPresetPosition>[0]) => pipPresetPosition(k, out, rect);
  assert.equal(p('center').x, 0.5);
  assert.equal(p('center').y, 0.5);
  assert.ok(Math.abs(p('topCenter').x - 0.5) < 1e-9, '上中横轴居中');
  assert.ok(Math.abs(p('topCenter').y * 1080 - (32 + 97)) < 1.01, '上中纵轴贴上边距');
  assert.ok(Math.abs(p('middleLeft').y - 0.5) < 1e-9, '左中纵轴居中');
  assert.ok(Math.abs(p('middleLeft').x * 1920 - (32 + 129.5)) < 1.01, '左中横轴贴左边距');
  assert.ok(Math.abs(p('bottomRight').x * 1920 - (1920 - 32 - 129.5)) < 1.01, '右下横轴贴右边距');
  assert.ok(Math.abs(p('bottomRight').y * 1080 - (1080 - 32 - 97)) < 1.01, '右下纵轴贴下边距');
  ok('九宫格预设位置换算（角/边中/正中）');
}
{
  const r = computeRecordingLayout({layout: 'pip', screen: {width: 3840, height: 2160}, camera: CAM_16_9, maxHeight: 1080});
  assert.equal(r.outWidth, 1920);
  assert.equal(r.outHeight, 1080);
  assert.deepEqual(r.screenRect, {x: 0, y: 0, width: 1920, height: 1080});
  // 画中画几何按缩后输出算：短边 1080，1280×720 横向摄像头 → 宽为长边、高等比
  const pipLong = Math.round(1080 * WEBCAM_SIZE_RATIO.medium);
  assert.equal(r.cameraRect!.width, pipLong);
  assert.equal(r.cameraRect!.height, Math.round((pipLong * 720) / 1280));
  ok('画中画 + maxHeight：先缩屏幕再算画中画几何');
}
{
  // 源高度低于上限不放大
  const r = computeRecordingLayout({screen: {width: 1280, height: 720}, maxHeight: 1080});
  assert.equal(r.outWidth, 1280);
  assert.equal(r.outHeight, 720);
  ok('源不高于上限时不放大');
}
{
  // 16:9 屏 + 4:3 摄像头等高拼接：宽 = 1920 + 640×(1080/480) = 1920+1440 = 3360
  const r = computeRecordingLayout({layout: 'side', screen: SCREEN, camera: CAM_4_3});
  assert.equal(r.layout, 'side');
  assert.equal(r.outHeight, 1080);
  const s = r.screenRect!;
  const c = r.cameraRect!;
  assert.equal(s.x, 0);
  assert.equal(s.width, 1920);
  assert.equal(c.height, 1080);
  assert.equal(c.width, 1440);
  assert.ok(c.x > s.x + s.width, '摄像头在屏幕右侧');
  assert.ok(c.x - (s.x + s.width) >= 2, '中缝至少 2px');
  assert.equal(c.x + c.width, r.outWidth, '摄像头右缘贴画布右缘');
  assert.equal(r.cameraRounded, false);
  assertInsideCanvas(s, r.outWidth, r.outHeight);
  assertInsideCanvas(c, r.outWidth, r.outHeight);
  ok('左右分屏：等高拼接、摄像头宽按宽高比换算、矩形在画布内');
}
{
  // 超宽输出过高度上限：整体等比缩小
  const r = computeRecordingLayout({layout: 'side', screen: SCREEN, camera: CAM_4_3, maxHeight: 1080});
  assert.equal(r.outHeight, 1080); // 原始高 1080 不超上限，不变
  const r2 = computeRecordingLayout({layout: 'side', screen: {width: 3840, height: 2160}, camera: CAM_4_3, maxHeight: 1080});
  assert.equal(r2.outHeight, 1080);
  const s = r2.screenRect!;
  const c = r2.cameraRect!;
  // 两路等高拼接：屏幕与摄像头都占满输出高度
  assert.equal(s.height, r2.outHeight);
  assert.equal(c.height, r2.outHeight);
  assertInsideCanvas(s, r2.outWidth, r2.outHeight);
  assertInsideCanvas(c, r2.outWidth, r2.outHeight);
  ok('左右分屏 + maxHeight：整幅等比缩小');
}
{
  // 上下堆叠：等宽 W=1920，屏高 1080，摄像头高 = 480×(1920/640) = 1440
  const r = computeRecordingLayout({layout: 'stack', screen: SCREEN, camera: CAM_4_3});
  assert.equal(r.layout, 'stack');
  assert.equal(r.outWidth, 1920);
  const s = r.screenRect!;
  const c = r.cameraRect!;
  assert.equal(s.y, 0);
  assert.equal(s.height, 1080);
  assert.equal(c.width, 1920);
  assert.equal(c.height, 1440);
  assert.ok(c.y > s.y + s.height, '摄像头在屏幕下方');
  assert.equal(c.y + c.height, r.outHeight, '摄像头下缘贴画布下缘');
  assertInsideCanvas(s, r.outWidth, r.outHeight);
  assertInsideCanvas(c, r.outWidth, r.outHeight);
  ok('上下分屏：等宽拼接、摄像头高按宽高比换算');
}
{
  const r = computeRecordingLayout({layout: 'camera', screen: SCREEN, camera: CAM_4_3});
  assert.equal(r.layout, 'camera');
  assert.deepEqual({width: r.outWidth, height: r.outHeight}, {width: 640, height: 480});
  assert.equal(r.screenRect, null);
  assert.deepEqual(r.cameraRect, {x: 0, y: 0, width: 640, height: 480});
  assert.equal(r.cameraRounded, false);
  ok('仅摄像头：输出 = 摄像头全画幅，屏幕不参与');
}
{
  const r = computeRecordingLayout({layout: 'camera', screen: SCREEN, camera: {width: 1920, height: 1440}, maxHeight: 720});
  assert.equal(r.outHeight, 720);
  assert.equal(r.outWidth, 960);
  assert.equal(r.cameraRect!.width, 960);
  ok('仅摄像头 + maxHeight：等比缩小到上限');
}
{
  // 输出与坐标全部偶数（编码器友好）
  for (const layout of ['side', 'stack'] as const) {
    const r = computeRecordingLayout({layout, screen: {width: 1919, height: 1079}, camera: {width: 641, height: 481}, maxHeight: 721});
    assert.equal(r.outWidth % 2, 0, `${layout} outWidth 偶数`);
    assert.equal(r.outHeight % 2, 0, `${layout} outHeight 偶数`);
    for (const rect of [r.screenRect, r.cameraRect]) {
      if (!rect) continue;
      assert.equal(rect.x % 2, 0, `${layout} rect.x 偶数`);
      assert.equal(rect.width % 2, 0, `${layout} rect.width 偶数`);
      assertInsideCanvas(rect, r.outWidth, r.outHeight);
    }
  }
  ok('奇数源输入：输出与矩形仍为偶数且不越界');
}

console.log('validateStartRecordingArgs layout:');
{
  for (const layout of RECORDING_LAYOUTS) {
    const r = validateStartRecordingArgs({withMic: false, withSystemAudio: false, layout});
    assert.ok(r.ok);
    assert.equal(r.args.layout, layout);
  }
  ok('四种构图枚举全部透传');
}
{
  const r = validateStartRecordingArgs({withMic: false, withSystemAudio: false, layout: 'vertical'});
  assert.ok(!r.ok);
  assert.ok(r.errors[0].includes('layout'), `错误信息提及 layout：${r.errors[0]}`);
  ok('非法构图值报错并列出合法枚举');
}
{
  const r = validateStartRecordingArgs({withMic: false, withSystemAudio: false});
  assert.ok(r.ok);
  assert.equal(r.args.layout, undefined);
  ok('不传 layout = 纯屏幕（向后兼容）');
}

console.log(`\n全部通过：${passed} 项断言组`);
