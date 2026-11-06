/**
 * content-fingerprint（渲染内容指纹）单元测试：
 * 哈希稳定性、键序无关、会话 URL 归一、挥发键剥离、变更检测
 *
 * 运行方式：node tests/unit/content-fingerprint.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import {djb2Hex, fingerprintRenderContent} from '../../src/shared/content-fingerprint.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const srv = (port: number, p: string) => `http://127.0.0.1:${port}/video?path=${encodeURIComponent(p)}`;

/** 构造一个最小内容快照（segments 一个片段 + 项目级样式） */
const makeSnapshot = (overrides: Record<string, unknown> = {}) => ({
  aspectRatioId: '16:9',
  orientation: 'landscape',
  segments: [
    {
      id: 'seg-1',
      templateId: 'RevealSlide',
      duration: 5,
      text: {title: '标题', subtitle: '', features: [], brandName: ''},
      videos: [
        {
          id: 'v1',
          src: srv(17890, 'D:\\m\\v1.mp4'),
          name: 'v1.mp4',
          type: 'video',
          duration: 10,
          trimStart: 0,
          trimEnd: 10,
          cursorTrack: 'D:\\m\\v1.cursor.json',
          cursorPoints: [{t: 0, x: 1, y: 2}], // 内存态大数组：应被剥离
        },
      ],
    },
  ],
  bgm: {name: 'bgm.mp3', path: 'D:\\m\\bgm.mp3', volume: 0.35, peaks: [0.1, 0.2, 0.3], beats: [0.5, 1.0]}, // peaks/beats 应被剥离
  captionStyle: {position: 'bottom', fontSizeScale: 1, color: '#FFFFFF', bgOpacity: 0.45},
  texture: 'film',
  beatPulse: true,
  renderSettings: {format: 'mp4', crf: 23},
  ...overrides,
});

console.log('djb2Hex 基本性质:');
{
  assert.match(djb2Hex('hello'), /^[0-9a-f]{8}$/, '输出 8 位 hex');
  assert.equal(djb2Hex('hello'), djb2Hex('hello'), '同一输入同一输出');
  assert.notEqual(djb2Hex('hello'), djb2Hex('hellp'), '一个字符之差即不同');
  ok('8 位 hex、确定性、雪崩');
}

console.log('fingerprintRenderContent 稳定性:');
{
  const a = fingerprintRenderContent(makeSnapshot());
  const b = fingerprintRenderContent(makeSnapshot());
  assert.equal(a, b, '同一内容两次计算结果一致');
  ok('同内容 → 同指纹');
}

console.log('fingerprintRenderContent 键序无关:');
{
  const x = fingerprintRenderContent({brandColor: '#FF0000', texture: 'film', beatPulse: true});
  const y = fingerprintRenderContent({beatPulse: true, texture: 'film', brandColor: '#FF0000'});
  assert.equal(x, y, '对象键序不影响指纹');
  ok('键序不同 → 同指纹');
}

console.log('fingerprintRenderContent 会话 URL 归一（跨会话可比）:');
{
  const s1 = makeSnapshot();
  const s2 = makeSnapshot();
  (s2.segments[0].videos[0] as {src: string}).src = srv(9999, 'D:\\m\\v1.mp4'); // 换端口
  assert.equal(fingerprintRenderContent(s1), fingerprintRenderContent(s2), '同一路径不同会话端口指纹一致');
  const s3 = makeSnapshot();
  (s3.segments[0].videos[0] as {src: string}).src = srv(17890, 'D:\\m\\v2.mp4'); // 换素材
  assert.notEqual(fingerprintRenderContent(s1), fingerprintRenderContent(s3), '素材换了指纹应变');
  ok('端口无关、路径相关');
}

console.log('fingerprintRenderContent 挥发键剥离:');
{
  const s1 = makeSnapshot();
  const s2 = makeSnapshot();
  const v2 = s2.segments[0].videos[0] as Record<string, unknown>;
  v2.cursorPoints = [{t: 9, x: 9, y: 9}, {t: 10, x: 10, y: 10}]; // 轨迹点内容不同
  v2.stabCorrections = [{dx: 1}];
  (s2.bgm as Record<string, unknown>).peaks = [0.9, 0.9];
  assert.equal(fingerprintRenderContent(s1), fingerprintRenderContent(s2), '内存态/派生数据不影响指纹');
  ok('cursorPoints/stabCorrections/peaks 等不参与指纹');
}

console.log('fingerprintRenderContent 变更检测:');
{
  const base = fingerprintRenderContent(makeSnapshot());
  const cases: [string, (s: ReturnType<typeof makeSnapshot>) => void][] = [
    ['改文案', (s) => { s.segments[0].text.title = '新标题'; }],
    ['改时长', (s) => { s.segments[0].duration = 6; }],
    ['改字幕样式', (s) => { (s.captionStyle as Record<string, unknown>).fontSizeScale = 1.5; }],
    ['改质感', (s) => { s.texture = 'cinema'; }],
    ['改渲染设置', (s) => { (s.renderSettings as Record<string, unknown>).crf = 18; }],
    ['加片段', (s) => { s.segments.push({...s.segments[0], id: 'seg-2'}); }],
  ];
  for (const [label, mutate] of cases) {
    const s = makeSnapshot();
    mutate(s);
    assert.notEqual(fingerprintRenderContent(s), base, `${label}应改变指纹`);
    ok(label);
  }
}

console.log('fingerprintRenderContent 边界:');
{
  assert.equal(fingerprintRenderContent({}), fingerprintRenderContent({}), '空快照稳定');
  assert.equal(
    fingerprintRenderContent({bgm: {path: 'a.mp3', src: undefined}}),
    fingerprintRenderContent({bgm: {path: 'a.mp3'}}),
    'undefined 字段不参与（与 JSON 语义一致）',
  );
  ok('空快照/undefined 字段边界');
}

console.log(`\ncontent-fingerprint：${passed} 项断言通过`);
