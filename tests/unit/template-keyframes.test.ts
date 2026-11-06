/**
 * 模板特性帧时刻规划（shared/template-keyframes.ts，质量路线图第四层）单测：
 * 三规划器公式（白板驻留中点/拆层前后/每泡入场+0.1 同源 bubbleEnterFrame）、
 * 通用回退段中点、keyframeTimetable 绝对帧累计与段窗钳制。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/template-keyframes.test.ts
 */
import {keyframeTimetable, TEMPLATE_KEYFRAME_PLANNERS} from '../../src/shared/template-keyframes';
import {readParam} from '../../src/shared/template-checkpoints';
import {TEMPLATES} from '../../src/shared/template-registry';
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
  duration: 8,
  transition: 'none',
  ...partial,
} as Segment);

const plan = (seg: Segment) => {
  const meta = TEMPLATES.find((t) => t.id === seg.templateId);
  const read = readParam(meta?.paramSpecs ?? [], seg.customParams as Record<string, number> | undefined);
  const planner = TEMPLATE_KEYFRAME_PLANNERS[seg.templateId];
  return planner(seg, read, 30);
};

// WhiteboardCanvas：每卡驻留中点（intro 10 帧 + (i+0.725)×seg；pullBack 扣 16% 尾窗）
{
  const seg = mkSeg({
    id: 'w', templateId: 'WhiteboardCanvas', duration: 12.5,
    text: {title: '', subtitle: '', features: ['[t]甲|x', '[t]乙|y', '[t]丙|z'], brandName: ''},
  });
  const marks = plan(seg);
  ok(marks.length === 3, `3 卡 3 标记（实际 ${marks.length}）`);
  // 手算：intro=10, tail=round(375×0.16)=60, usable=305, seg=101.667
  // 卡1=(10+0.725×101.667)/30≈2.79s；卡2≈6.18s；卡3≈9.57s
  ok(Math.abs(marks[0].atSec - 2.79) < 0.05, `卡1 驻留中点 ≈2.79s（实际 ${marks[0].atSec.toFixed(2)}）`);
  ok(Math.abs(marks[1].atSec - 6.18) < 0.05, `卡2 ≈6.18s（实际 ${marks[1].atSec.toFixed(2)}）`);
  ok(Math.abs(marks[2].atSec - 9.57) < 0.05, `卡3 ≈9.57s（实际 ${marks[2].atSec.toFixed(2)}）`);
  // pullBack 关：尾窗不扣 → usable 更大 → 卡1 时刻更晚
  const seg2 = {...seg, customParams: {pullBack: 0}};
  const m2 = plan(seg2);
  ok(m2[0].atSec > marks[0].atSec, 'pullBack 关 → 驻留时刻整体后移');
}

// PanelFlyout：拆层前后两帧（flyAt×段长 ±0.2/+0.3）
{
  const seg = mkSeg({id: 'p', templateId: 'PanelFlyout', duration: 4, customParams: {flyAmp: 1.2}});
  const marks = plan(seg);
  ok(marks.length === 2, '拆层前后两帧');
  ok(Math.abs(marks[0].atSec - 0.4) < 0.01, `拆层前 = flyAt(0.15)×4 - 0.2 = 0.4s（实际 ${marks[0].atSec}）`);
  ok(Math.abs(marks[1].atSec - 0.9) < 0.01, `拆层后 = 0.6 + 0.3 = 0.9s（实际 ${marks[1].atSec}）`);
  // flyAt 调晚 → 两帧同步后移且前帧不出负
  const seg2 = {...seg, customParams: {flyAt: 0.05}};
  const m2 = plan(seg2);
  ok(m2[0].atSec === 0, 'flyAt 早于 0.2s → 前帧钳 0');
}

// ChatConversation：每泡入场+0.1（与 bubbleEnterFrame 同源，pace 生效）
{
  const seg = mkSeg({
    id: 'c', templateId: 'ChatConversation', duration: 8,
    text: {title: '', subtitle: '', features: ['u:你好', 'a:在的', 'u:再来'], brandName: ''},
  });
  const marks = plan(seg);
  ok(marks.length === 3, '3 泡 3 标记');
  ok(Math.abs(marks[0].atSec - 0.6) < 0.01, `泡1 = 首泡 0.5s + 0.1（实际 ${marks[0].atSec}）`);
  ok(marks[1].label.includes('AI'), `标签带角色（${marks[1].label}）`);
}

// 通用回退：段中点（无声明模板）
{
  const rows = keyframeTimetable([mkSeg({id: 't', templateId: 'TextSlide', duration: 4})], 30);
  ok(rows.length === 1 && rows[0].marks.length === 1, '回退 1 帧');
  ok(Math.abs(rows[0].marks[0].atSec - 2.0) < 0.01 && rows[0].absFrames[0] === 60, '段中点=2.0s=绝对 60 帧');
}

// keyframeTimetable：绝对帧累计 + 不可渲染段跳过且不占内容帧
{
  const segs = [
    mkSeg({id: 'a', templateId: 'TextSlide', duration: 3}),
    mkSeg({id: 'bad', templateId: 'NoSuchTemplate', duration: 5}),
    mkSeg({
      id: 'c', templateId: 'ChatConversation', duration: 4,
      text: {title: '', subtitle: '', features: ['u:一句话', 'a:两句'], brandName: ''},
    }),
  ];
  const rows = keyframeTimetable(segs, 30);
  ok(rows.length === 2, `不可渲染段跳过（实际 ${rows.length} 行）`);
  // 段 3 内容起点 = 3s（坏段不占帧）：泡1 绝对 = 90 + (15+3) = 108 帧 = 3.6s
  const r2 = rows[1];
  ok(r2.segmentIndex === 2 && r2.absFrames[0] === 108, `泡1 绝对帧 108（实际 ${r2.absFrames[0]}）`);
}

// 时刻钳进段内容窗：超长脚本末泡 enter 超段长 → 钳到 duration-1/fps
{
  const segs = [mkSeg({
    id: 'c', templateId: 'ChatConversation', duration: 2.2,
    text: {title: '', subtitle: '', features: Array.from({length: 8}, (_, i) => `u:第${i}句`), brandName: ''},
  })];
  const rows = keyframeTimetable(segs, 30);
  const maxAt = Math.max(...rows[0].marks.map((k) => k.atSec));
  ok(maxAt <= 2.2 - 1 / 30 + 1e-9, `末泡时刻钳进段窗（max ${maxAt.toFixed(2)} ≤ ${(2.2 - 1 / 30).toFixed(2)}）`);
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\ntemplate-keyframes: ${passed}/${passed} 全部通过`);
