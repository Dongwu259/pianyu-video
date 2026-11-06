/**
 * shot-timeline 单测：shot 投影层不变式（P2.5 阶段三第一片）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/shot-timeline.test.ts
 */
import assert from 'node:assert/strict';
import {computeShotTimeline, findShotsAt, shotSummary} from '../../src/shared/shot-timeline.ts';
import {computeTimelineLayout} from '../../src/shared/timeline-layout.ts';
import type {Segment, VideoClip} from '../../src/shared/types.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

const clip = (id: string, over: Partial<VideoClip> = {}): VideoClip =>
  ({id, src: '', name: `${id}.mp4`, width: 1920, height: 1080, duration: 30, type: 'video', ...over}) as VideoClip;

const seg = (id: string, duration: number, videos: VideoClip[] = [], transition: Segment['transition'] = 'none'): Segment =>
  ({id, templateId: `T-${id}`, videos, text: {title: id}, style: {}, layout: {} as Segment['layout'], duration, transition}) as Segment;

console.log('shot-timeline:');

t('纯模板段 → 单个 text shot（id=text-{segment.id}，窗=段窗）', () => {
  const tl = computeShotTimeline([seg('a', 5)]);
  assert.equal(tl.shots.length, 1);
  const s = tl.shots[0];
  assert.equal(s.kind, 'text');
  assert.equal(s.id, 'text-a');
  assert.equal(s.name, 'T-a');
  assert.deepEqual([s.startSec, s.endSec], [0, 5]);
  assert.equal(s.mediaInSec, undefined);
});

t('素材段 → 素材 shot 带 trim 窗 + cutsCount；id=clip.id 稳定', () => {
  const v = clip('c1', {trimStart: 2, trimEnd: 9, cuts: [{start: 4, end: 5} as never]});
  const tl = computeShotTimeline([seg('a', 6, [v], 'crossfade'), seg('b', 4)]);
  const s = tl.shots.find((x) => x.id === 'c1')!;
  assert.equal(s.kind, 'video');
  assert.equal(s.segIndex, 0);
  assert.equal(s.clipIndex, 0);
  assert.deepEqual([s.mediaInSec, s.mediaOutSec], [2, 9]);
  assert.equal(s.sourceDurationSec, 30);
  assert.equal(s.cutsCount, 1);
  assert.equal(s.startSec, 0);
  // text shot 归属第二段
  assert.equal(tl.shots.find((x) => x.kind === 'text')!.startSec, 6);
});

t('画中画叠层：同段多素材共享同窗（layered=true），无段内时序', () => {
  const tl = computeShotTimeline([seg('a', 5, [clip('c1'), clip('c2'), {id: 'c3', type: 'image', duration: 5} as VideoClip])]);
  assert.equal(tl.shots.length, 3);
  for (const s of tl.shots) {
    assert.equal(s.layered, true);
    assert.deepEqual([s.startSec, s.endSec], [0, 5]);
  }
  // 图片 shot 无媒体窗字段
  const img = tl.shots.find((s) => s.kind === 'image')!;
  assert.equal(img.mediaInSec, undefined);
  assert.equal(img.sourceDurationSec, undefined);
});

t('不可渲染段（模板缺失）不产 shot；坐标仍用 layout 系（clips 同系，边例差异见 schema 文档）', () => {
  const segs = [seg('a', 4), seg('dead', 6), seg('b', 6)];
  const tl = computeShotTimeline(segs, {isRenderable: (s) => s.id !== 'dead'});
  assert.equal(tl.shots.length, 2);
  assert.ok(!tl.shots.some((s) => s.segIndex === 1), '缺模板段不产 shot');
  // layout 坐标系：dead 段仍占 6s（UI 块可见），b 段 startSec 含其时长
  assert.equal(tl.shots.find((s) => s.segIndex === 2)!.startSec, 10);
  assert.equal(tl.totalSec, computeTimelineLayout(segs).totalSec);
});

t('duration 0 走渲染默认 8（|| 8 口径）——不误当零时长段', () => {
  const tl = computeShotTimeline([seg('a', 4), seg('zero', 0), seg('b', 6)]);
  assert.equal(tl.shots.length, 3);
  assert.equal(tl.shots.find((s) => s.segIndex === 1)!.durationSec, 8);
});

t('不变式：shot 窗 ⊆ [0,total]、相邻段窗首尾相接、每段 shot 数 = 段素材数或 1', () => {
  const segs = [
    seg('a', 4, [clip('c1')], 'crossfade'),
    seg('b', 6, [clip('c2'), clip('c3')]),
    seg('c', 3),
  ];
  const tl = computeShotTimeline(segs);
  const perSeg = new Map<number, number>();
  for (const s of tl.shots) {
    perSeg.set(s.segIndex, (perSeg.get(s.segIndex) ?? 0) + 1);
    assert.ok(s.startSec >= -1e-9 && s.endSec <= tl.totalSec + 1e-9);
    assert.ok(s.endSec - s.startSec > 0);
  }
  assert.deepEqual([...perSeg.entries()].sort(), [[0, 1], [1, 2], [2, 1]]);
  const b = tl.shots.filter((s) => s.segIndex === 1);
  assert.equal(b[0].startSec, 4);
  const c = tl.shots.filter((s) => s.segIndex === 2);
  assert.equal(c[0].startSec, 10);
});

t('findShotsAt：命中与叠层多返；shotSummary 计数对账', () => {
  const tl = computeShotTimeline([seg('a', 4, [clip('c1'), clip('c2')]), seg('b', 4)]);
  assert.equal(findShotsAt(tl, 2).length, 2); // 叠层段
  assert.equal(findShotsAt(tl, 5).length, 1); // text 段
  assert.equal(findShotsAt(tl, 99).length, 0);
  const sum = shotSummary(tl);
  assert.deepEqual(sum, {count: 3, mediaCount: 2, textCount: 1, layeredSegs: 1});
});

t('随机 150 组对账：shots 总数 = Σ(段素材数或 1)，窗与 layout.clips 逐段一致', () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let k = 0; k < 150; k++) {
    const n = 1 + Math.floor(rnd() * 5);
    const segs = Array.from({length: n}, (_, i) => {
      const dur = rnd() < 0.08 ? 0 : 0.5 + rnd() * 8;
      const nv = rnd() < 0.4 ? Math.floor(rnd() * 3) : 0;
      return seg(`s${i}-${k}`, dur, Array.from({length: nv}, (_, j) => clip(`c${i}-${j}`)));
    });
    const tl = computeShotTimeline(segs);
    const layout = computeTimelineLayout(segs);
    assert.equal(tl.totalSec, layout.totalSec);
    const expectCount = segs.reduce((a, s, i) => a + (layout.clips[i].durationSec <= 0 ? 0 : Math.max(1, s.videos.length)), 0);
    assert.equal(tl.shots.length, expectCount, `组 ${k}`);
    for (const s of tl.shots) {
      const c = layout.clips[s.segIndex];
      assert.ok(Math.abs(s.startSec - c.startSec) < 1e-9 && Math.abs(s.endSec - c.endSec) < 1e-9, `组 ${k} 段 ${s.segIndex} 窗漂移`);
    }
  }
});

const total = 8;
console.log(passed === total ? 'shot-timeline: ✓ 全部通过' : `shot-timeline: ${passed}/${total}`);
