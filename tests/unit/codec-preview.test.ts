/**
 * codec-preview（导入素材预览编码白名单）单元测试
 *
 * 运行方式：node tests/unit/codec-preview.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import {codecPreviewWarning, PREVIEW_SAFE_VIDEO_CODECS} from '../../src/shared/codec-preview.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('codecPreviewWarning 白名单内编码:');
for (const c of ['h264', 'vp8', 'vp9', 'av1']) {
  assert.equal(codecPreviewWarning(c), null, `${c} 应无警告`);
  ok(`${c} → null`);
}

console.log('codecPreviewWarning 大小写与空白:');
assert.equal(codecPreviewWarning('H264'), null, '大小写不敏感');
assert.equal(codecPreviewWarning(' H265 '.replace('H265', 'vp9')), null);
ok('大小写/首尾空白归一后判定');

console.log('codecPreviewWarning 非白名单编码:');
for (const c of ['hevc', 'h265', 'prores', 'mjpeg', 'mpeg1video', 'mpeg2video', 'wmv3', 'vp6', 'theora']) {
  const w = codecPreviewWarning(c);
  assert.ok(w !== null, `${c} 应有警告`);
  assert.ok(w!.includes(c), `警告应含编码名 ${c}`);
  assert.ok(w!.includes('预览可能黑屏/无声'), '警告应说明预览影响');
  assert.ok(w!.includes('导出渲染不受影响'), '警告应说明导出不受影响');
  assert.ok(w!.includes('H.264'), '警告应建议转 H.264');
  ok(`${c} → 警告文案含编码名与建议`);
}

console.log('codecPreviewWarning 占位/未知编码不警告:');
for (const c of ['image', 'unknown', '', null, undefined]) {
  assert.equal(codecPreviewWarning(c), null, `${String(c)} 不应警告`);
  ok(`${String(c)} → null`);
}

console.log('codecPreviewWarning container 仅参与文案:');
{
  const w = codecPreviewWarning('hevc', 'mp4');
  assert.ok(w !== null && w.includes('mp4'), '给了 container 应写进文案');
  assert.equal(codecPreviewWarning('h264', 'mp4'), null, 'container 不改变白名单判定');
  ok('container 只进文案不进判定');
}

console.log('PREVIEW_SAFE_VIDEO_CODECS 清单:');
assert.deepEqual([...PREVIEW_SAFE_VIDEO_CODECS].sort(), ['av1', 'h264', 'vp8', 'vp9']);
ok('白名单恰为 h264/vp8/vp9/av1');

console.log(`\ncodec-preview：${passed} 项断言通过`);
