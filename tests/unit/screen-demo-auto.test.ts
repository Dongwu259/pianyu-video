/**
 * 录屏即成品编排核心（shared/screen-demo-auto.ts）单元测试：
 * 故事板结构（钩子+主段+CTA）/ 尾部修剪 / 轨迹接线 / 计划统计 / 缺省文案 / 退化路径。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/screen-demo-auto.test.ts
 */

import assert from 'node:assert/strict';

const {buildScreenDemoStoryboard, trimEndForTrack} = await import('../../src/shared/screen-demo-auto.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 构造 sidecar：30Hz 匀速移动 + 可选点击（t 毫秒） */
const makeTrack = (durationSec: number, clicks: number[] = []) => {
  const points: {t: number; x: number; y: number}[] = [];
  for (let f = 0; f <= durationSec * 30; f++) {
    points.push({t: Math.round(f * 1000 / 30), x: 100 + f * 2, y: 200});
  }
  return {
    version: 2 as const,
    displayId: 0,
    videoWidth: 1000,
    videoHeight: 800,
    points,
    clicks: clicks.map((t) => ({t, x: 500, y: 400, button: 1})),
  };
};

const src = (overrides: Partial<Parameters<typeof buildScreenDemoStoryboard>[0][number]> = {}) => ({
  src: 'http://127.0.0.1:1/video?path=%2Fa.webm',
  name: 'a.webm',
  width: 1000,
  height: 800,
  duration: 12,
  track: makeTrack(12, [3000]),
  sidecarPath: 'a.cursor.json',
  ...overrides,
});

console.log('故事板结构:');
{
  const r = buildScreenDemoStoryboard([src()]);
  assert.equal(r.segments.length, 3, '钩子 + 主段 + CTA');
  assert.equal(r.segments[0].templateId, 'KineticType');
  assert.equal(r.segments[1].templateId, 'ScreenDemo');
  assert.equal(r.segments[2].templateId, 'OutroCTA');
  assert.equal(r.segments[0].transition, 'slide', '钩子出转场');
  assert.equal(r.segments[1].transition, 'zoomIn', '主段出转场进 CTA');
  assert.equal(r.segments[2].transition, 'none', 'CTA 无出转场');
  assert.deepEqual(r.segments[2].text.features, ['立即下载体验'], 'CTA 缺省行动点');
  ok('三段结构与缺省文案');
}

console.log('轨迹接线与统计:');
{
  const r = buildScreenDemoStoryboard([src()]);
  const clip = r.segments[1].videos[0];
  assert.equal(clip.cursorTrack, 'a.cursor.json', 'cursorTrack 持久化字段');
  assert.ok(clip.cursorPoints.length >= 2 && clip.cursorClicks.length === 1, '内存态轨迹/点击已挂');
  assert.ok(r.stats.shotCount >= 2, `镜头数统计 (${r.stats.shotCount})`);
  assert.equal(r.stats.clickCount, 1);
  assert.equal(r.segments[1].duration, 12, '轨迹连续到片尾 → 不修剪');
  ok('clip 轨迹字段 + 计划统计');
}

console.log('尾部修剪:');
{
  // 轨迹 8s 结束，素材 12s → 修剪到 9.5s
  assert.deepEqual(trimEndForTrack(12, makeTrack(8)), {trimEnd: 9.5, trimmed: 2.5});
  const r = buildScreenDemoStoryboard([src({duration: 12, track: makeTrack(8)})]);
  assert.ok(Math.abs(r.segments[1].duration - 9.5) < 1e-9, `主段时长 = 修剪后 (${r.segments[1].duration})`);
  assert.ok(Math.abs(r.stats.tailTrimmedSec - 2.5) < 1e-9);
  // 轨迹 1.2s 结束 → 修剪后 2.7s < MIN_MAIN_SEC 3s → 保留全长
  assert.deepEqual(trimEndForTrack(12, makeTrack(1.2)), {trimEnd: 12, trimmed: 0});
  ok('尾部按最后活动 +1.5s 修剪，短于下限保留全长');
}

console.log('退化与防御:');
{
  const r1 = buildScreenDemoStoryboard([src({track: null, sidecarPath: undefined})]);
  assert.equal(r1.segments[1].videos[0].cursorTrack, undefined, '无轨迹不挂 cursorTrack');
  assert.ok(r1.stats.shotCount === 0);
  assert.ok(r1.notes[0].includes('宽景缓推'), '缺轨迹有提示');
  assert.equal(r1.segments[1].duration, 12, '无轨迹不修剪');

  const empty = buildScreenDemoStoryboard([src({duration: 0.2})]);
  assert.equal(empty.segments.length, 0, '全无效素材 → 空故事板');
  assert.ok(empty.notes.length > 0);

  const multi = buildScreenDemoStoryboard([src(), src({name: 'b.webm', track: makeTrack(6)})]);
  assert.equal(multi.segments.length, 4, '多素材 → 多主段');
  assert.equal(multi.segments[1].transition, 'crossfade', '主段之间 crossfade（转场不花哨）');
  ok('无轨迹退化 / 无效素材 / 多素材');
}

console.log('文案覆盖:');
{
  const r = buildScreenDemoStoryboard([src()], {
    title: '三分钟做一条宣传片',
    subtitle: '片语 1.5',
    ctaTitle: '现在开始',
    ctaLines: ['官网下载', '免费试用'],
    hookSec: 2,
    ctaSec: 3,
  });
  assert.equal(r.segments[0].text.title, '三分钟做一条宣传片');
  assert.equal(r.segments[0].text.subtitle, '片语 1.5');
  assert.equal(r.segments[0].duration, 2);
  assert.equal(r.segments[2].text.title, '现在开始', 'CTA 标题可独立覆盖');
  assert.deepEqual(r.segments[2].text.features, ['官网下载', '免费试用']);
  assert.equal(r.segments[2].duration, 3);
  ok('标题/副题/CTA 全部可覆盖');
}

console.log(`\n共 ${passed} 项断言全部通过`);
