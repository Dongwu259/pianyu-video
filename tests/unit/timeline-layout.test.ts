/**
 * timeline-layout 单测：时间轴视图布局数学（P2.5 阶段二）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/timeline-layout.test.ts
 */
import assert from 'node:assert/strict';
import {
  computeTimelineLayout,
  findClipIndexAt,
  clampSegmentDuration,
  clampTimelineTransitionSec,
  clampNarrationOffsetSec,
  snapSecToBeats,
  snapSecMagnetic,
  medianBeatSec,
  planRulerTicks,
  formatTimelineTc,
  TIMELINE_FPS,
} from '../../src/shared/timeline-layout.ts';
import {computeTransitionWindows} from '../../src/shared/transition-style.ts';
import type {Segment} from '../../src/shared/types.ts';

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

const seg = (duration: number, transition: Segment['transition'] = 'none', durationSec?: number): Segment =>
  ({
    id: `s${Math.random().toString(36).slice(2, 8)}`,
    templateId: 'RevealSlide',
    videos: [],
    text: {title: ''},
    style: {},
    layout: {videoWidthRatio: 0.8, videoHeightRatio: 0.6, videoOffsetX: 0, videoOffsetY: 0},
    duration,
    transition,
    ...(durationSec !== undefined ? {transitionParams: {durationSec}} : {}),
  }) as Segment;

console.log('timeline-layout:');

t('片段矩形首尾相接、总时长=Σ时长（0.1s 小数按帧取整）', () => {
  const layout = computeTimelineLayout([seg(4.8), seg(2.5, 'crossfade'), seg(8)]);
  assert.ok(Math.abs(layout.clips[0].startSec - 0) < 1e-9);
  assert.ok(Math.abs(layout.clips[0].endSec - 4.8) < 1e-9);
  assert.ok(Math.abs(layout.clips[1].startSec - 4.8) < 1e-9);
  assert.ok(Math.abs(layout.clips[2].startSec - 7.3) < 1e-9);
  assert.ok(Math.abs(layout.totalSec - 15.3) < 1e-9);
});

t('duration 帧取整与渲染 contentFramesArr 同口径', () => {
  // 4.83s * 30 = 144.9 → 145 帧 = 4.8333s：布局与 MultiSegmentPromo 一样按帧对齐，不出现累积漂移
  const layout = computeTimelineLayout([seg(4.83), seg(1)]);
  const frames = [4.83, 1].map((d) => Math.round(d * TIMELINE_FPS));
  assert.ok(Math.abs(layout.clips[0].endSec - frames[0] / TIMELINE_FPS) < 1e-9);
  assert.ok(Math.abs(layout.clips[1].startSec - frames[0] / TIMELINE_FPS) < 1e-9);
  assert.ok(Math.abs(layout.totalSec - (frames[0] + frames[1]) / TIMELINE_FPS) < 1e-9);
});

t('转场块与 computeTransitionWindows 严格同源（随机 200 组对账）', () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const types: Segment['transition'][] = ['crossfade', 'slide', 'zoomIn', 'whip', 'flash', 'push', 'none', 'shapeBloom'];
  for (let k = 0; k < 200; k++) {
    const n = 2 + Math.floor(rnd() * 4);
    const segs = Array.from({length: n}, (_, i) =>
      i < n - 1
        ? seg(0.5 + rnd() * 5, types[Math.floor(rnd() * types.length)], rnd() < 0.5 ? 0.2 + rnd() * 1.8 : undefined)
        : seg(0.5 + rnd() * 5),
    );
    const layout = computeTimelineLayout(segs);
    const frames = segs.map((s) => Math.round(s.duration * TIMELINE_FPS));
    const windows = computeTransitionWindows(segs, frames, TIMELINE_FPS);
    for (let i = 0; i < n - 1; i++) {
      const w = windows[i];
      const b = layout.transitions[i];
      assert.equal(b.segIndex, i);
      assert.equal(b.type, segs[i].transition);
      assert.ok(Math.abs(b.startSec - w.startFrame / TIMELINE_FPS) < 1e-9, `startSec ${k}/${i}`);
      assert.ok(Math.abs(b.endSec - w.endFrame / TIMELINE_FPS) < 1e-9, `endSec ${k}/${i}`);
      assert.ok(Math.abs(b.cutSec - w.climaxFrame / TIMELINE_FPS) < 1e-9, `cutSec ${k}/${i}`);
      if (segs[i].transition === 'none') assert.equal(b.durationSec, 0);
    }
    // 末段边界恒为硬切占位
    assert.equal(layout.transitions[n - 1].durationSec, 0);
    assert.ok(Math.abs(layout.transitions[n - 1].cutSec - layout.totalSec) < 1e-9);
  }
});

t('转场块骑跨切点：高潮帧=切点、窗口宽≈时长（非 crossfade 类型）', () => {
  const layout = computeTimelineLayout([seg(4, 'whip', 0.8), seg(4)]);
  const b = layout.transitions[0];
  assert.ok(Math.abs(b.cutSec - 4) < 1e-9);
  // whip peakPhase=0.5：窗口 = [切点−0.4, 切点+0.4]
  assert.ok(Math.abs(b.startSec - 3.6) < 0.05, `start ${b.startSec}`);
  assert.ok(Math.abs(b.endSec - 4.4) < 0.05, `end ${b.endSec}`);
  assert.ok(b.durationSec > 0);
});

t('crossfade（peakPhase=0）不骑跨：窗口挂在切点后', () => {
  const layout = computeTimelineLayout([seg(4, 'crossfade', 0.5), seg(4)]);
  const b = layout.transitions[0];
  assert.ok(Math.abs(b.startSec - 4) < 1e-9, `start ${b.startSec}`);
  assert.ok(Math.abs(b.endSec - 4.5) < 0.05, `end ${b.endSec}`);
});

t('findClipIndexAt：命中与边界钳制', () => {
  const layout = computeTimelineLayout([seg(3), seg(5), seg(2)]);
  assert.equal(findClipIndexAt(layout, 0), 0);
  assert.equal(findClipIndexAt(layout, 2.9), 0);
  assert.equal(findClipIndexAt(layout, 3.0), 1);
  assert.equal(findClipIndexAt(layout, 8.5), 2);
  assert.equal(findClipIndexAt(layout, 99), 2);
  assert.equal(findClipIndexAt(layout, -1), 0);
  assert.equal(findClipIndexAt({totalSec: 0, clips: [], transitions: []}, 1), -1);
});

t('clampSegmentDuration：0.5-60 钳制 + 0.1 取整', () => {
  assert.equal(clampSegmentDuration(0.2), 0.5);
  assert.equal(clampSegmentDuration(100), 60);
  assert.equal(clampSegmentDuration(4.83), 4.8);
  assert.equal(clampSegmentDuration(7), 7);
  assert.equal(clampSegmentDuration(Number.NaN, 5), 5);
  assert.equal(clampTimelineTransitionSec(0.05), 0.2);
  assert.equal(clampTimelineTransitionSec(3), 2);
  assert.equal(clampTimelineTransitionSec(0.77), 0.77);
});

t('snapSecToBeats：阈值内吸附、阈值外原样、最近拍二分正确', () => {
  const beats = [1, 2, 3, 4, 5];
  assert.ok(Math.abs(snapSecToBeats(1.04, beats, 0.1) - 1) < 1e-9);
  assert.ok(Math.abs(snapSecToBeats(0.96, beats, 0.1) - 1) < 1e-9);
  assert.ok(Math.abs(snapSecToBeats(1.5, beats, 0.1) - 1.5) < 1e-9); // 中点不吸
  assert.ok(Math.abs(snapSecToBeats(4.42, beats, 0.1) - 4.42) < 1e-9); // 距最近拍 0.42 超阈原样
  assert.ok(Math.abs(snapSecToBeats(3.0, [], 0.1) - 3.0) < 1e-9); // 无拍直通
  assert.ok(Math.abs(snapSecToBeats(5.2, beats, 0.25) - 5) < 1e-9); // 越过末拍向内吸
});

t('medianBeatSec：奇偶间隔与防抖过滤', () => {
  assert.ok(Math.abs(medianBeatSec([0, 0.5, 1.0, 1.5]) - 0.5) < 1e-9);
  assert.ok(Math.abs(medianBeatSec([0, 0.4, 1.0, 1.4, 2.0]) - 0.5) < 1e-9); // gaps .4 .6 .4 .6 → 中位 .5
  assert.equal(medianBeatSec([0]), 0);
  assert.equal(medianBeatSec([]), 0);
  assert.equal(medianBeatSec([0, 0.01]), 0); // <0.05 间隔当抖动剔除
});

t('planRulerTicks：按像素密度换挡、主次刻度整数对齐', () => {
  // 60px/s、64px 标签距 → 1s 步（0.5*60=30 不够，1*60=60 也不够 64？→ 2s）
  const dense = planRulerTicks(60, 60);
  assert.equal(dense.stepSec, 2);
  const mid = planRulerTicks(60, 70); // 1*70=70 ≥ 64 → 1s
  assert.equal(mid.stepSec, 1);
  assert.ok(mid.majors.includes(5));
  assert.ok(!mid.majors.includes(0.6));
  const sparse = planRulerTicks(600, 4); // 30*4=120 ≥ 64 → 30s
  assert.equal(sparse.stepSec, 30);
  // 次刻度 = step/5
  assert.ok(Math.abs(mid.minors[0] - 0.2) < 1e-9);
});

t('formatTimelineTc：分:秒.十分位', () => {
  assert.equal(formatTimelineTc(0), '0:00.0');
  assert.equal(formatTimelineTc(9.96), '0:10.0');
  assert.equal(formatTimelineTc(75.44), '1:15.4');
  assert.equal(formatTimelineTc(-3), '0:00.0');
});

t('clampNarrationOffsetSec：[0, 段时长] 钳制 + 0.1 取整（段内偏移语义）', () => {
  assert.equal(clampNarrationOffsetSec(-1, 5), 0);
  assert.equal(clampNarrationOffsetSec(9.9, 5), 5);
  assert.equal(clampNarrationOffsetSec(2.34, 5), 2.3);
  assert.equal(clampNarrationOffsetSec(0, 0), 0); // 零时长段只能 0
  assert.equal(clampNarrationOffsetSec(Number.NaN, 5), 0);
});

t('snapSecMagnetic：阈值内取最近目标（节拍与边界同权竞争）', () => {
  // 2.0 处有片段边界，1.95 距边界 0.05、距拍 1.5 差 0.45 → 吸边界
  assert.equal(snapSecMagnetic(1.95, [1.5], [2.0], 0.1), 2.0);
  // 拍更近则拍胜：1.48 距拍 1.5 差 0.02 → 吸拍
  assert.equal(snapSecMagnetic(1.48, [1.5], [2.0], 0.1), 1.5);
  // 全部超出阈值 → 原样返回
  assert.equal(snapSecMagnetic(1.71, [1.5], [2.0], 0.1), 1.71);
});

t('snapSecMagnetic：空目标集 / 非有限值 / 零阈值 = 原样返回', () => {
  assert.equal(snapSecMagnetic(3.3, [], [], 0.5), 3.3);
  assert.equal(snapSecMagnetic(3.3, [Number.NaN], [3.4], 0.5), 3.4);
  assert.equal(snapSecMagnetic(3.3, [3.4], [3.35], 0), 3.3);
  assert.equal(snapSecMagnetic(3.3, [3.4], [3.35], -1), 3.3);
});

t('snapSecMagnetic：恰好等于阈值不吸（严格小于）；等距并列先考虑者胜（beats 在前）', () => {
  assert.equal(snapSecMagnetic(1.9, [], [2.0], 0.1), 1.9);
  // 1.7 距拍 1.5 与边界 1.9 各 0.2（都在阈值内）→ 先考虑的拍胜
  assert.equal(snapSecMagnetic(1.7, [1.5], [1.9], 0.25), 1.5);
});

const total = 15;
console.log(passed === total ? 'timeline-layout: ✓ 全部通过' : `timeline-layout: ${passed}/${total}`);
