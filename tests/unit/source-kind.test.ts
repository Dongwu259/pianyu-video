/**
 * sourceKind（素材来源类型）单测：启发式分类规则（克制——不确定默认 live-action）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/source-kind.test.ts
 */

import assert from 'node:assert/strict';
import {guessSourceKind, SOURCE_KINDS, SOURCE_KIND_LABELS} from '../../src/shared/source-kind.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('source-kind（素材来源类型启发式）');

t('图片/模型 → graphic（确定信号）', () => {
  assert.equal(guessSourceKind({type: 'image', width: 800, height: 600}), 'graphic');
  assert.equal(guessSourceKind({type: 'model', width: 0, height: 0}), 'graphic');
});

t('本软件录屏（轨迹标记）/ webm → screen-recording（确定信号）', () => {
  assert.equal(guessSourceKind({type: 'video', width: 1920, height: 1080, isAppRecording: true}), 'screen-recording');
  assert.equal(guessSourceKind({type: 'video', width: 1280, height: 720, ext: 'webm'}), 'screen-recording');
});

t('相机设备元数据 → live-action（mxf 电影机/手机直出）', () => {
  assert.equal(guessSourceKind({type: 'video', width: 1920, height: 1080, make: 'SONY', ext: 'mxf'}), 'live-action');
  assert.equal(guessSourceKind({type: 'video', width: 3840, height: 2160, make: 'Apple', model: 'iPhone 17 Pro', ext: 'mov'}), 'live-action');
});

t('无元数据 + 常见桌面分辨率 → screen-recording（中置信）', () => {
  assert.equal(guessSourceKind({type: 'video', width: 2560, height: 1440, ext: 'mp4'}), 'screen-recording');
  assert.equal(guessSourceKind({type: 'video', width: 1366, height: 768, ext: 'mp4'}), 'screen-recording');
});

t('摄影分辨率（非桌面）无元数据 → live-action 缺省', () => {
  assert.equal(guessSourceKind({type: 'video', width: 4096, height: 2160, ext: 'mxf'}), 'live-action');
  assert.equal(guessSourceKind({type: 'video', width: 3840, height: 1600, ext: 'mp4'}), 'live-action');
  assert.equal(guessSourceKind({type: 'video', width: 2048, height: 1080, ext: 'mp4'}), 'live-action');
});

t('SOURCE_KINDS/标签三分类完整', () => {
  assert.deepEqual([...SOURCE_KINDS], ['live-action', 'screen-recording', 'graphic']);
  assert.equal(SOURCE_KIND_LABELS['live-action'], '实拍');
  assert.equal(SOURCE_KIND_LABELS['screen-recording'], '录屏');
  assert.equal(SOURCE_KIND_LABELS.graphic, '图形');
});

console.log(`\n${passed} 项通过`);
