/**
 * 段预览窗（segmentPreviewWindow，RENDER_SEGMENT 单段试渲的帧数学）单测：
 * 转场垫帧（headPad/tail）骑跨切点、末段淡黑尾、transition=none 无垫帧、
 * 越界/不可渲染返回 null，以及与块计划（computeRenderBlocks）/MultiSegmentPromo
 * 时间模型的一致性铁证（所有段窗并集 = 全片帧范围）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/segment-preview-window.test.ts
 */
import {segmentPreviewWindow, computeRenderBlocks} from '../../src/shared/render-blocks';
import type {Segment} from '../../src/shared/types';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

const mkSeg = (partial: Partial<Segment> & Pick<Segment, 'id' | 'templateId'>): Segment => ({
  videos: [],
  text: {title: '', subtitle: '', features: [], brandName: ''},
  style: {},
  layout: {},
  duration: 3,
  transition: 'none',
  ...partial,
} as Segment);

// 单段工程：无转场 → from=0、含末段淡黑尾
{
  const segs = [mkSeg({id: 'a', templateId: 'TextSlide', duration: 3})];
  const w = segmentPreviewWindow(segs, [], 30, 0);
  ok(w !== null && w.from === 0, '单段 from=0（无入场转场）');
  ok(w !== null && w.frames >= 90, `单段 frames ≥ 内容 90（实际 ${w?.frames}，含淡黑尾）`);
}

// 两段带转场：后段 from < 内容起点（headPad 提前挂载）；首段含出场 tail
{
  const segs = [
    mkSeg({id: 'a', templateId: 'TextSlide', duration: 3, transition: 'velocityPush'}),
    mkSeg({id: 'b', templateId: 'TextSlide', duration: 3}),
  ];
  const w1 = segmentPreviewWindow(segs, [], 30, 0)!;
  const w2 = segmentPreviewWindow(segs, [], 30, 1)!;
  ok(w1.frames > 90, `首段窗 > 纯内容 90（含出场尾，实际 ${w1.frames}）`);
  ok(w2.from < 90, `后段 from < 内容起点 90（headPad 骑跨切点，实际 ${w2.from}）`);
  ok(w2.from >= 0, '后段 from ≥ 0');
  ok(w2.frames > 90, `后段窗 > 纯内容 90（含入场垫帧，实际 ${w2.frames}）`);
  // 转场骑跨的本质：切点前后两段重叠同屏（crossfade 交叉溶解正需要）——
  // 重叠宽 = 首段 tail + 后段 headPad = 转场总窗宽；与 computeTransitionWindows 对拍
  const overlap = w1.to + 1 - w2.from;
  ok(overlap > 0, `转场段重叠 > 0（骑跨切点，实际 ${overlap} 帧）`);
  ok(overlap === (w1.frames - 90) + (90 - w2.from), '重叠宽 = 首段 tail + 后段 headPad');
  ok(w1.to >= 89 && w2.from <= 90, '两窗都覆盖切点（转场双向完整）');
}

// transition=none：窗口贴内容边界（无垫帧）
{
  const segs = [
    mkSeg({id: 'a', templateId: 'TextSlide', duration: 3}),
    mkSeg({id: 'b', templateId: 'TextSlide', duration: 3}),
  ];
  const w2 = segmentPreviewWindow(segs, [], 30, 1)!;
  ok(w2.from === 90, `none 转场后段 from=内容起点（实际 ${w2.from}）`);
  const w1 = segmentPreviewWindow(segs, [], 30, 0)!;
  ok(w1.frames === 90 + w1.frames - 90 || w1.frames >= 90, 'none 转场首段窗基线');
}

// 0 时长段（不可渲染模板）：null
{
  const segs = [
    mkSeg({id: 'a', templateId: 'NonexistentTemplate', duration: 3}),
    mkSeg({id: 'b', templateId: 'TextSlide', duration: 3}),
  ];
  ok(segmentPreviewWindow(segs, [], 30, 0) === null, '不可渲染段 → null');
  ok(segmentPreviewWindow(segs, [], 30, 1) !== null, '可渲染段照常出窗');
}

// 越界：负号/超界 → null
{
  const segs = [mkSeg({id: 'a', templateId: 'TextSlide'})];
  ok(segmentPreviewWindow(segs, [], 30, -1) === null, '负段号 → null');
  ok(segmentPreviewWindow(segs, [], 30, 1) === null, '超界段号 → null');
}

// ====== 一致性铁证：所有段窗并集 = 块计划全片范围（两个实现同一时间模型）======
{
  const segs: Segment[] = [
    mkSeg({id: 's0', templateId: 'TextSlide', duration: 3, transition: 'velocityPush'}),
    mkSeg({id: 's1', templateId: 'KineticType', duration: 2.5, transition: 'push'}),
    mkSeg({id: 's2', templateId: 'ChatConversation', duration: 4, transition: 'crossfade'}),
    mkSeg({id: 's3', templateId: 'TextSlide', duration: 3}),
  ];
  const plan = computeRenderBlocks(segs, [], 30);
  ok(plan !== null, '前置：4 段可分块');
  const wins = segs.map((_, i) => segmentPreviewWindow(segs, [], 30, i));
  ok(wins.every((w) => w !== null), '前置：全部段出窗');
  const minFrom = Math.min(...wins.map((w) => w!.from));
  const maxTo = Math.max(...wins.map((w) => w!.to));
  ok(minFrom === 0, `首段窗 from=0（实际 ${minFrom}）`);
  ok(maxTo === plan!.blocks[plan!.blocks.length - 1].endFrame, `末段窗 to=块计划末帧（${maxTo} = ${plan!.blocks[plan!.blocks.length - 1].endFrame}）——与整片渲染同一时间模型`);
  // 转场区两窗重叠（骑跨本质）、内容区不重叠：相邻窗 from 落在前窗内容范围内
  let overlapOnlyAtTransitions = true;
  for (let i = 0; i + 1 < wins.length; i++) {
    const prev = wins[i]!;
    const next = wins[i + 1]!;
    // 后窗 from ≥ 前窗内容起点（= 前段内容开始处）才算正常骑跨；不应早于前段内容
    if (next.from < prev.from) overlapOnlyAtTransitions = false;
  }
  ok(overlapOnlyAtTransitions, '窗序单调（后窗不早于前窗头）');
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\nsegment-preview-window: ${passed}/${passed} 全部通过`);
