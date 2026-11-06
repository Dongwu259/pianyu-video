/**
 * B3 转场高潮帧对拍——骑跨时间模型（shared/transition-style.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/transition-window.test.ts
 * （被测模块为纯函数、不依赖 electron）
 *
 * 三方帧级对账口径（HANDOVER 三期验收闸 #3）：
 * - 高潮帧恒等于切点（=段内容边界；拍点吸附锚的是切点，故高潮帧压拍由构造保证）；
 * - 窗口不越段界（头不超前段内容起点、尾不超后段内容终点）；
 * - 相邻窗口严格不重叠（双侧钳制的归纳不变量）；
 * - 与 computeRenderBlocks / calculateFrameRange 对账：全部窗口落在渲染帧范围内，
 *   总帧数 = Σ内容 + 末段淡黑（骑跨不增加总时长，分块数学不动）；
 * - crossfade（peak=0）与旧单侧钳制模型逐值一致（零回归锚定）。
 */

import assert from 'node:assert/strict';
import {
  TRANSITION_PEAK_PHASE,
  computeTransitionWindows,
  getTransitionFrames,
  getOutroFadeFrames,
  type TransitionWindow,
} from '../../src/shared/transition-style.ts';
import {computeRenderBlocks} from '../../src/shared/render-blocks.ts';
import type {Segment, TransitionType} from '../../src/shared/types.ts';

let passed = 0;
let failed = 0;
const ok = (name: string, detail = '') => {
  passed++;
  console.log(`  ✓ ${name}${detail ? `：${detail}` : ''}`);
};
const bad = (name: string, detail: string) => {
  failed++;
  console.error(`  ✗ ${name}：${detail}`);
};
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name, detail) : bad(name, detail));

const FPS = 30;
const ALL_TRANSITIONS: TransitionType[] = [
  'none', 'crossfade', 'slide', 'wipe', 'iris', 'push', 'velocityPush', 'zoom', 'rotate', 'blur',
  'flash', 'zoomIn', 'zoomOut', 'whip', 'flyThrough', 'panChase', 'orbitSwipe', 'cardSweep', 'shapeBloom',
];

const mkSeg = (transition: TransitionType, durationSec?: number, segDuration = 8): Segment => ({
  id: `s-${transition}-${durationSec ?? '-'}`,
  templateId: 'RevealSlide',
  videos: [],
  text: {title: '', subtitle: '', features: [], brandName: ''},
  style: {},
  layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
  duration: segDuration,
  transition,
  ...(durationSec !== undefined ? {transitionParams: {durationSec}} : {}),
}) as Segment;

console.log('TRANSITION_PEAK_PHASE 相位表：');
{
  check('覆盖全部转场类型', Object.keys(TRANSITION_PEAK_PHASE).length === ALL_TRANSITIONS.length,
    `${Object.keys(TRANSITION_PEAK_PHASE).length} 项`);
  check('取值域 [0,1]', ALL_TRANSITIONS.every((t) => TRANSITION_PEAK_PHASE[t] >= 0 && TRANSITION_PEAK_PHASE[t] <= 1));
  check('crossfade=0（不骑跨，零回归）', TRANSITION_PEAK_PHASE.crossfade === 0);
  check('zoomIn/zoomOut=0.85（到位帧）', TRANSITION_PEAK_PHASE.zoomIn === 0.85 && TRANSITION_PEAK_PHASE.zoomOut === 0.85);
  check('flash=0.25（白场平台尾=reveal 起点）', TRANSITION_PEAK_PHASE.flash === 0.25);
  check('whip/cardSweep/shapeBloom/panChase/orbitSwipe=0.5（中点峰）',
    ['whip', 'cardSweep', 'shapeBloom', 'panChase', 'orbitSwipe'].every((t) => TRANSITION_PEAK_PHASE[t as TransitionType] === 0.5));
}

console.log('computeTransitionWindows 基础骑跨数学：');
{
  // zoomIn 0.6s@30fps：W=18，peak=0.85 → head=round(15.3)=15，tail=3；高潮帧=切点
  const segs = [mkSeg('zoomIn', 0.6), mkSeg('crossfade'), mkSeg('whip')];
  const contentFrames = segs.map((s) => Math.round(s.duration * FPS));
  const w = computeTransitionWindows(segs, contentFrames, FPS);
  const cut0 = contentFrames[0]; // 段0 内容结束帧 = 240
  check('zoomIn 窗口总帧 = 18', w[0].frames === 18);
  check('zoomIn headPad=15 / tail=3', w[0].headPad === 15 && w[0].tail === 3, `head=${w[0].headPad} tail=${w[0].tail}`);
  check('zoomIn 窗口首帧 = 切点−15', w[0].startFrame === cut0 - 15);
  check('zoomIn 高潮帧 = 切点（拍点）', w[0].climaxFrame === cut0);
  check('crossfade 不骑跨：head=0', w[1].headPad === 0 && w[1].tail > 0);
  check('末段无窗口', w[2].frames === 0);
}
{
  // 硬切 / 不可渲染段 / 下一段不可渲染 → 无窗口（与旧模型一致）
  const segs = [mkSeg('whip'), mkSeg('crossfade'), mkSeg('slide'), mkSeg('push')];
  const contentFrames = [240, 0, 90, 120]; // 段1 不可渲染
  const w = computeTransitionWindows(segs, contentFrames, FPS);
  check('下一段不可渲染无窗口', w[0].frames === 0);
  check('前段不可渲染无窗口', w[1].frames === 0);
  check('正常边界有窗口', w[2].frames > 0);
  const segs2 = [mkSeg('none'), mkSeg('whip')];
  const w2 = computeTransitionWindows(segs2, [240, 240], FPS);
  check('none 无窗口', w2[0].frames === 0);
}
{
  // 双侧钳制：中段很短（1s=30 帧），两侧都是 zoomIn 0.6s（W=18）
  // 单侧钳制会让 head_2 = 15 > content_1(30) − tail_0... 构造：段0 zoomIn、段1 zoomIn、段2
  const segs = [mkSeg('zoomIn', 0.6), mkSeg('zoomIn', 0.6), mkSeg('crossfade')];
  const contentFrames = [120, 30, 120]; // 中段 1s
  const w = computeTransitionWindows(segs, contentFrames, FPS);
  // 边界0：W0 = min(18, floor(120/0.85)=141, floor(30/0.15)=200) = 18 → tail0 = 3
  // 边界1：head1 ≤ 30 − tail0 = 27 → W1 ≤ floor(27/0.85)=31 → W1 = 18（raw 钳住），head1 = 15 ≤ 27 ✓
  check('短中段两侧骑跨不重叠', w[0].endFrame <= w[1].startFrame,
    `win0=[${w[0].startFrame},${w[0].endFrame}) win1=[${w[1].startFrame},${w[1].endFrame})`);
  check('窗口头不越段起点', w[1].startFrame >= 120, `start=${w[1].startFrame}`);
}
{
  // 极端：中段极短（12 帧），两侧 zoomIn 原始 W=18 都放不下 → 头部约束收窄
  const segs = [mkSeg('zoomIn', 0.6), mkSeg('zoomIn', 0.6), mkSeg('crossfade')];
  const contentFrames = [120, 12, 120];
  const w = computeTransitionWindows(segs, contentFrames, FPS);
  // 边界0：tail0 ≤ floor(12/0.15)=80 → W0 = min(18, …) = 18, tail0 = 3
  // 边界1：head1 ≤ 12 − 3 = 9 → W1 ≤ floor(9/0.85) = 10 → W1 = 10（被钳小），head1 = round(8.5) = 9
  check('极端短段窗口被钳小', w[1].frames === 10 && w[1].headPad === 9,
    `W=${w[1].frames} head=${w[1].headPad}`);
  check('钳小后仍不重叠', w[0].endFrame <= w[1].startFrame);
}

console.log('crossfade 零回归（与旧单侧钳制逐值一致）：');
{
  const legacyOutOverlap = (seg: Segment, nextContent: number): number =>
    Math.min(getTransitionFrames(seg, FPS), Math.max(0, nextContent));
  let all = true;
  const cases: Array<[number, number]> = [[240, 240], [240, 10], [30, 5], [90, 200]];
  for (const [own, next] of cases) {
    const segs = [mkSeg('crossfade', 0.5), mkSeg('crossfade'), mkSeg('crossfade')];
    const w = computeTransitionWindows(segs, [own, next, 90], FPS);
    if (!(w[0].headPad === 0 && w[0].tail === legacyOutOverlap(segs[0], next))) {
      all = false;
      bad('crossfade 旧模型等价', `own=${own} next=${next}: head=${w[0].headPad} tail=${w[0].tail}`);
    }
  }
  if (all) ok('crossfade 旧模型等价（4 组边界场景）');
}

console.log('随机化对账（高潮帧=切点 / 不越界 / 不重叠 / 渲染范围覆盖）：');
{
  // 种子 LCG：确定性随机配置
  let seed = 20260910;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  let climaxAll = true, containAll = true, overlapAll = true, rangeAll = true, blockOk = true;
  let casesChecked = 0, windowsChecked = 0, reconciled = 0;
  for (let iter = 0; iter < 300; iter++) {
    const n = 3 + Math.floor(rand() * 6); // 3-8 段
    const segs: Segment[] = [];
    const contentFrames: number[] = [];
    for (let i = 0; i < n; i++) {
      // 10% 概率不可渲染段（0 帧）；正常段 0.4-6s（duration 与 contentFrames 同源，保证对账口径一致）
      const durSec = rand() < 0.1 ? 0 : 0.4 + rand() * 5.6;
      segs.push(mkSeg(pick(ALL_TRANSITIONS), 0.2 + rand() * 1.8, Math.round(durSec * FPS) / FPS));
      contentFrames.push(Math.round(durSec * FPS));
    }
    const windows = computeTransitionWindows(segs, contentFrames, FPS);
    // 内容边界（切点）
    const starts: number[] = [];
    let acc = 0;
    for (let i = 0; i < n; i++) { starts.push(acc); acc += contentFrames[i]; }
    const totalContent = acc;
    casesChecked++;
    for (let i = 0; i < n; i++) {
      const w = windows[i];
      if (w.frames === 0) continue;
      windowsChecked++;
      // 1) 高潮帧 = 切点
      if (w.climaxFrame !== starts[i] + contentFrames[i]) { climaxAll = false; }
      // 2) 窗口不越段界：头在前段内容内、尾在后段内容内
      if (w.startFrame < starts[i]) containAll = false;
      if (w.endFrame > starts[i + 1] + contentFrames[i + 1]) containAll = false;
      // 3) 相邻窗口不重叠
      if (i > 0 && windows[i - 1].frames > 0 && windows[i - 1].endFrame > w.startFrame) overlapAll = false;
    }
    // 4) 与 computeRenderBlocks 对账：窗口全部落在渲染帧范围内
    const renderableSegs = segs.map((s, i) => ({...s, templateId: contentFrames[i] > 0 ? 'RevealSlide' : 'ghost-tpl'}));
    const plan = computeRenderBlocks(renderableSegs, [], FPS);
    if (plan) {
      reconciled++;
      const outro = getOutroFadeFrames(FPS);
      // 骑跨不增加总时长：totalFrames = Σ内容 + 末段淡黑（末段可渲染时）
      const expectTotal = totalContent + (contentFrames[n - 1] > 0 ? outro : 0);
      if (plan.totalFrames !== expectTotal) blockOk = false;
      if (windows.some((w) => w.frames > 0 && (w.startFrame < 0 || w.endFrame > plan.totalFrames))) rangeAll = false;
    }
  }
  check('高潮帧=切点（随机 300 组）', climaxAll);
  check('窗口不越段界', containAll);
  check('相邻窗口不重叠', overlapAll);
  check('渲染范围覆盖全部窗口', rangeAll, `${reconciled} 组对账`);
  check('总帧数=Σ内容+淡黑（骑跨不加时长）', blockOk);
  console.log(`  （${casesChecked} 组配置 / ${windowsChecked} 个窗口）`);
}

console.log(`\ntransition-window: ${failed === 0 ? `✓ 全部 ${passed} 项通过` : `✗ ${failed} 项失败`}`);
if (failed > 0) process.exit(1);
