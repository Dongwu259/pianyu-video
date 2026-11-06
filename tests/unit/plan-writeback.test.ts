/**
 * plan-writeback 单测（timeline-master-plan M2 L1 回写环切片一）
 *
 * 锚定重点：
 * - **回写往返恒等**：时间线改文案 → text/features 回写 → 重新投影 = 所见即所得
 *  （「时间线改文案→成片变」的数据侧闭环；渲染侧由 CDP+渲染 still 验收）；
 * - **宁少勿猜**：选区结构破坏/半角竖线/未开放模板/越界 → 显式失败带人话原因；
 * - **冻结形态**：窗反解 → frozen 记录（frozenAt/paramSnapshot/detachedFields）+
 *  materialized 覆盖层；已冻结沿用原 frozenAt（快照锚定首次冻结）；
 * - **投影消费覆盖层**：冻结段投影窗 = 物化层真值，文案仍按当前 text 推导。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs --test tests/unit/plan-writeback.test.ts
 */
import assert from 'node:assert/strict';
// 必须在 toolExecutors 链（最终引用 ThreeText 的 .ttf 字体 import）之前求值
import './asset-stub.cjs';
import {solveCaptionText, solveCaptionWindow, solveMediaWindow, effectiveCaptionWindows, editWhiteboardCardLine, editDocParagraphLine} from '../../src/shared/plan-writeback.ts';
import {projectSegmentPlan} from '../../src/shared/plan-projection.ts';
import {parseWhiteboardCards, layoutWhiteboard, whiteboardCameraAt, WHITEBOARD_WORLD_W, WHITEBOARD_WORLD_H} from '../../src/shared/whiteboard-canvas.ts';
import {docPanelTimeline} from '../../src/shared/doc-panel.ts';
import type {Segment, VideoClip} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const mkSeg = (over: Partial<Segment> & {templateId: string}): Segment =>
  ({
    id: 'seg-w',
    videos: [],
    text: {},
    style: {},
    duration: 8,
    transition: 'none',
    ...over,
  }) as Segment;

const mkVideo = (over: Partial<VideoClip> & {type: 'video'}): VideoClip =>
  ({
    id: 'v1',
    src: 'file:///x.mp4',
    name: 'x.mp4',
    type: 'video',
    duration: 20,
    width: 1920,
    height: 1080,
    ...over,
  }) as VideoClip;

// ====== 字幕文字反解：CursorFollow（title/subtitle 直槽） ======
{
  const seg = mkSeg({templateId: 'CursorFollow', text: {title: '原标题', subtitle: '原副题', features: [], brandName: ''}});
  const r0 = solveCaptionText(seg, 0, '新标题');
  assert.ok(r0.ok);
  assert.deepEqual(r0.value, {title: '新标题'}, 'caption 0 → title');
  const r1 = solveCaptionText(seg, 1, '新副题');
  assert.ok(r1.ok);
  assert.deepEqual(r1.value, {subtitle: '新副题'}, 'caption 1 → subtitle');
  const bad = solveCaptionText(seg, 2, 'x');
  assert.ok(!bad.ok && bad.reason.includes('不存在'), '越界 caption 显式失败');
  const empty = solveCaptionText(seg, 0, '  ');
  assert.ok(!empty.ok && empty.reason.includes('不能为空'), '空文案拒绝');
  const pipe = solveCaptionText(seg, 0, '带|竖线');
  assert.ok(!pipe.ok && pipe.reason.includes('半角竖线'), '半角竖线拒绝（features 格式保留字符）');
  ok('CursorFollow 文字反解（直槽映射 + 三类拒绝）');
}

// ====== 字幕文字反解：WhiteboardCanvas（features 行往返恒等） ======
{
  const seg = mkSeg({
    templateId: 'WhiteboardCanvas',
    text: {title: '', subtitle: '', features: ['[v] 卡一|副一', '[t] 卡二', '卡三'], brandName: ''},
  });
  // 投影所见（卡 i 显示 = title｜sub 全角连接）
  const caps = projectSegmentPlan(seg)?.captions ?? [];
  assert.equal(caps.length, 3, '三卡三字幕');
  assert.equal(caps[1].text, '卡二', '无副题卡显示=纯标题');

  // 改卡 2（无前缀行）：显示「卡三改｜新副」→ 行 = '卡三改|新副'
  const r = solveCaptionText(seg, 2, '卡三改｜新副');
  assert.ok(r.ok);
  assert.deepEqual(r.value.features, ['[v] 卡一|副一', '[t] 卡二', '卡三改|新副'], '无前缀行重写为 标题|副题');
  // 改卡 1（[t] 前缀保留）：显示「新卡二」（无 ｜ = 无副题）
  const r2 = solveCaptionText(seg, 1, '新卡二');
  assert.ok(r2.ok);
  assert.deepEqual(r2.value.features, ['[v] 卡一|副一', '[t] 新卡二', '卡三'], '[t] 前缀形状原样保留');

  // 往返恒等：回写后重新投影 = 编辑后的显示文本（所见即所得闭环）
  const segAfter = {...seg, text: {...seg.text, features: r.value.features!}};
  const capsAfter = projectSegmentPlan(segAfter)?.captions ?? [];
  assert.equal(capsAfter[2].text, '卡三改｜新副', '回写→投影往返恒等（含副题）');
  const segAfter2 = {...seg, text: {...seg.text, features: r2.value.features!}};
  assert.equal((projectSegmentPlan(segAfter2)?.captions ?? [])[1].text, '新卡二', '回写→投影往返恒等（纯标题）');

  // 序列化器边界：空行/废行跳过计数（与 parse 同口径）
  const dirty = editWhiteboardCardLine(['', '  ', '[v] A|B', '垃圾'], 0, 'X', 'Y');
  assert.deepEqual(dirty, ['', '  ', '[v] X|Y', '垃圾'], '空行不计卡序，其余行原样保留');
  assert.equal(editWhiteboardCardLine(['[v] A'], 5, 'X'), null, '卡序越界 null');
  ok('WhiteboardCanvas 文字反解（行编辑保格式 + 往返恒等）');
}

// ====== 字幕文字反解：DocPanel（title 直槽 + 段落行 + 选区保护） ======
{
  const seg = mkSeg({
    templateId: 'DocPanel',
    text: {title: '窗口标题', subtitle: '', features: ['第一段', '前[[中]]后', 'img:图表'], brandName: ''},
  });
  const r0 = solveCaptionText(seg, 0, '新标题');
  assert.ok(r0.ok);
  assert.deepEqual(r0.value, {title: '新标题'}, 'caption 0 → 窗口标题');

  const r1 = solveCaptionText(seg, 1, '第一段改');
  assert.ok(r1.ok);
  assert.deepEqual(r1.value.features, ['第一段改', '前[[中]]后', 'img:图表'], '纯文本段整行替换，img 行不动');

  const r2 = solveCaptionText(seg, 2, '整体改');
  assert.ok(!r2.ok && r2.reason.includes('选区'), '含 [[选区]] 段落拒绝（宁少勿猜——不毁选区结构）');

  const r3 = solveCaptionText(seg, 1, '带 [[选区]] 输入');
  assert.ok(!r3.ok && r3.reason.includes('保留字符'), '输入含选区语法拒绝');

  const edited = editDocParagraphLine(['第一段', 'img:图', '第二段'], 1, 'X');
  assert.deepEqual(edited, ['第一段', 'img:图', 'X'], 'img 行不计段序（段 1 = 第三行）');
  assert.equal(editDocParagraphLine(['第一段'], 5, 'X'), null, '段序越界 null');
  ok('DocPanel 文字反解（title/段落/选区三态）');
}

// ====== 字幕文字反解：未开放模板拒绝 ======
{
  const seg = mkSeg({templateId: 'KenBurns', text: {title: 'T', subtitle: '', features: [], brandName: ''}});
  const r = solveCaptionText(seg, 0, 'X');
  assert.ok(!r.ok && r.reason.includes('未开放'), 'plan 白名单外模板拒绝');
  ok('未开放模板拒绝');
}

// ====== 字幕窗反解：冻结兜底（CursorFollow 开放；记录形态 + 沿用语义） ======
{
  const seg = mkSeg({
    templateId: 'CursorFollow',
    duration: 8,
    customParams: {zoom: 1.6},
    text: {title: '标题', subtitle: '副题', features: [], brandName: ''},
  });
  const r = solveCaptionWindow(seg, 0, 1.2, 8);
  assert.ok(r.ok, 'CursorFollow 窗反解走冻结路径');
  const {frozen, captions, frozeNow} = r.value;
  assert.ok(frozeNow, '首次冻结标记');
  assert.ok(!Number.isNaN(Date.parse(frozen.frozenAt)), 'frozenAt 是 ISO 时间');
  assert.deepEqual(frozen.paramSnapshot, {zoom: 1.6}, 'paramSnapshot = 冻结时参数快照');
  assert.deepEqual(frozen.detachedFields, ['captions'], 'captions 外置');
  assert.equal(captions.length, 2, '两条字幕窗（title+subtitle）');
  assert.ok(Math.abs(captions[0].startSec - 1.2) < 1e-9, 'title 窗起点生效');
  assert.equal(captions[1].startSec, 0, '未编辑的 subtitle 窗保持推导值');

  // 已冻结：沿用原 frozenAt（快照锚定首次冻结），窗更新
  const seg2 = {...seg, frozen, materialized: {captions}};
  const r2 = solveCaptionWindow(seg2, 1, 0.8, 6);
  assert.ok(r2.ok && !r2.value.frozeNow, '二次编辑不再新冻结');
  assert.equal(r2.value.frozen.frozenAt, frozen.frozenAt, 'frozenAt 沿用');
  assert.ok(Math.abs(r2.value.captions[1].startSec - 0.8) < 1e-9, 'subtitle 窗更新');

  // 钳制与最小窗长
  const r3 = solveCaptionWindow(seg, 0, -1, 99);
  assert.ok(r3.ok);
  assert.equal(r3.value.captions[0].startSec, 0, '窗起点钳到段首');
  assert.equal(r3.value.captions[0].endSec, 8, '窗终点钳到段尾');
  const r4 = solveCaptionWindow(seg, 0, 7.99, 8.5);
  assert.ok(r4.ok);
  assert.ok(r4.value.captions[0].endSec - r4.value.captions[0].startSec >= 2 / 30 - 1e-9, '最小窗长 2 帧保窗尾');

  // 越界 + 渲染消费未开放（用 plan 批次外模板测白名单拒绝；批次内三模板切片二起全开放）
  const oob = solveCaptionWindow(seg, 5, 0, 1);
  assert.ok(!oob.ok && oob.reason.includes('不存在'), '越界 caption 拒绝');
  const wb = mkSeg({templateId: 'WhiteboardCanvas', text: {title: '', subtitle: '', features: ['卡一'], brandName: ''}});
  const rwb = solveCaptionWindow(wb, 0, 0, 2);
  assert.ok(rwb.ok && rwb.value.frozeNow && rwb.value.frozen.detachedFields.includes('captions'), 'WhiteboardCanvas 切片二起窗编辑开放（相机卡槽窗消费已实装）');
  const nb = mkSeg({templateId: 'KenBurns', text: {title: 'T', subtitle: '', features: [], brandName: ''}});
  const rnb = solveCaptionWindow(nb, 0, 0, 2);
  assert.ok(!rnb.ok && rnb.reason.includes('未开放'), 'plan 白名单外模板窗编辑拒绝');
  ok('冻结兜底（记录形态/沿用/钳制/最小窗长/开放名单门）');
}

// ====== 切片二：相机/段落时间线窗口驱动（零漂移恒等 + 窗口接管 + beats 跟随） ======
{
  // whiteboardCameraAt：均匀窗（按缺省数学构造）与不传窗逐帧恒等（零漂移结构证明）
  const cards = parseWhiteboardCards(['卡一', '卡二', '卡三'], 9);
  const rects = layoutWhiteboard(cards);
  const total = 180;
  const intro = 10, tail = Math.round(total * 0.16), usable = total - intro - tail;
  const seg = usable / 3;
  const uniWins = [0, 1, 2].map((i) => ({startFrame: intro + i * seg, endFrame: intro + (i + 1) * seg}));
  let drift = 0;
  for (let f = 0; f <= total; f++) {
    const a = whiteboardCameraAt(f, total, rects, {});
    const b = whiteboardCameraAt(f, total, rects, {cardWindows: uniWins});
    drift = Math.max(drift, Math.abs(a.scale - b.scale), Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));
  }
  assert.ok(drift < 1e-9, `均匀窗 = 不传窗逐帧恒等（最大漂移 ${drift}）`);

  // 窗口接管：卡 0 槽位延到 85 帧（w1 起点 57→85）→ 72 帧时相机驻留卡 0（注视点=卡 0 槽心）
  const shiftWins = [
    {startFrame: 10, endFrame: 85},
    {startFrame: 85, endFrame: 104},
    {startFrame: 104, endFrame: 151},
  ];
  const camDefault = whiteboardCameraAt(72, total, rects, {});
  const camShift = whiteboardCameraAt(72, total, rects, {cardWindows: shiftWins});
  const fit = 1 / WHITEBOARD_WORLD_W;
  // 卡 0 槽 [10,85)：72 帧 q=62/75=0.827>0.45 → move=1 → 注视点=rects[0]（tx/ty 与 scale 自洽）
  const expectTx = -(rects[0].cx - 0.5) * camShift.scale * WHITEBOARD_WORLD_W;
  const expectTy = -(rects[0].cy - 0.5) * camShift.scale * WHITEBOARD_WORLD_H;
  assert.ok(
    Math.abs(camShift.tx - expectTx) < 1e-9 && Math.abs(camShift.ty - expectTy) < 1e-9,
    '窗口接管：72 帧注视点=卡 0（tx/ty 与卡 0 槽心×scale 自洽）',
  );
  assert.ok(camShift.scale > fit * 1.2, '已在推近驻留段（push 过半）');
  assert.ok(
    Math.abs(camDefault.tx - camShift.tx) > 1e-6 || Math.abs(camDefault.scale - camShift.scale) > 1e-6,
    '默认数学 72 帧在卡 1（与接管版不同）',
  );
  // 覆盖层与卡数不齐：宁少勿猜回退均匀数学
  const shortWins = shiftWins.slice(0, 2);
  const camShort = whiteboardCameraAt(72, total, rects, {cardWindows: shortWins});
  assert.ok(
    Math.abs(camShort.tx - camDefault.tx) < 1e-12 && Math.abs(camShort.scale - camDefault.scale) < 1e-12,
    '窗数<卡数回退均匀数学',
  );
  ok('whiteboardCameraAt 窗口驱动（零漂移恒等/槽位接管/不齐回退）');
}

{
  // docPanelTimeline：窗口驱动 paraEnter + 缺省恒等 + 不齐回退
  const uni = docPanelTimeline(2, 0, 150, 30, 1);
  assert.equal(uni.paraEnter(0), 12, '缺省 intro=0.4s');
  const wins = [{startFrame: 12, endFrame: 60}, {startFrame: 60, endFrame: 120}];
  const w = docPanelTimeline(2, 0, 150, 30, 1, wins);
  assert.equal(w.paraEnter(0), 12, '窗驱动 para0');
  assert.equal(w.paraEnter(1), 60, '窗驱动 para1');
  assert.ok(w.cellEnter(0) >= 60, '占位格锚在末段后');
  // 缺省口径：窗=均匀窗时 paraEnter 与缺省一致
  const segStep = Math.max(24, Math.round((150 - 12 - 12) / 2));
  const uniWins = [
    {startFrame: 12, endFrame: 12 + segStep},
    {startFrame: 12 + segStep, endFrame: 12 + 2 * segStep},
  ];
  const w2 = docPanelTimeline(2, 0, 150, 30, 1, uniWins);
  assert.equal(w2.paraEnter(1), uni.paraEnter(1), '均匀窗=缺省（零漂移）');
  const short = docPanelTimeline(3, 0, 150, 30, 1, wins);
  assert.equal(short.paraEnter(0), uni.paraEnter(0), '窗数<段数回退均匀数学');

  // deriveDocTimeline 跟随覆盖层：段 2 浮现节拍 = 覆盖窗起点（渲染同源）
  // （时长取 5s：均匀数学下 paraEnter(1)=75 帧=2.5s，与覆盖窗 4s 明确区分）
  const base = mkSeg({templateId: 'DocPanel', duration: 5, text: {title: 'T', subtitle: '', features: ['第一段', '第二段'], brandName: ''}});
  const beats0 = projectSegmentPlan(base)?.beats ?? [];
  const frozen = {
    ...base,
    frozen: {frozenAt: '2026-10-12T00:00:00.000Z', paramSnapshot: {}, detachedFields: ['captions' as const]},
    materialized: {captions: [{startSec: 0, endSec: 5}, {startSec: 0.4, endSec: 5}, {startSec: 4, endSec: 5}]},
  };
  const beatsF = projectSegmentPlan(frozen)?.beats ?? [];
  const pop2 = beatsF.find((b) => b.kind === 'pop' && b.target?.includes('第二段'));
  assert.ok(pop2 && Math.abs(pop2.sec - 4) < 0.05, `冻结段段落节拍跟随覆盖窗（got ${pop2?.sec}，want 4）`);
  const pop2base = beats0.find((b) => b.kind === 'pop' && b.target?.includes('第二段'));
  assert.ok(pop2base && Math.abs(pop2base.sec - 4) > 0.05, '默认版段落节拍在别处（确实接管了）');
  ok('docPanelTimeline 窗口驱动 + DocPanel beats 跟随覆盖层');
}

{
  // deriveCardDwell 跟随覆盖层：卡驻留节拍 = 槽窗推导（0.725 同源）
  const base = mkSeg({templateId: 'WhiteboardCanvas', text: {title: '', subtitle: '', features: ['卡一', '卡二', '卡三'], brandName: ''}});
  const beats0 = projectSegmentPlan(base)?.beats ?? [];
  assert.equal(beats0.length, 3, '三卡三驻留节拍');
  const frozen = {
    ...base,
    frozen: {frozenAt: '2026-10-12T00:00:00.000Z', paramSnapshot: {}, detachedFields: ['captions' as const]},
    materialized: {captions: [
      {startSec: 10 / 30, endSec: 85 / 30},
      {startSec: 85 / 30, endSec: 104 / 30},
      {startSec: 104 / 30, endSec: 151 / 30},
    ]},
  };
  const beatsF = projectSegmentPlan(frozen)?.beats ?? [];
  const b0F = beatsF[0];
  const expect0 = (10 + 0.725 * (85 - 10)) / 30;
  assert.ok(b0F && Math.abs(b0F.sec - expect0) < 0.034, `卡 0 驻留节拍=槽窗 0.725 位（got ${b0F?.sec}，want ~${expect0.toFixed(3)}）`);
  assert.ok(Math.abs(beats0[0].sec - b0F.sec) > 0.03, '与默认均匀版确实不同（接管生效）');
  // 窗数不足回退：beats = 默认版
  const mismatch = {...frozen, materialized: {captions: frozen.materialized.captions.slice(0, 2)}};
  const beatsM = projectSegmentPlan(mismatch)?.beats ?? [];
  assert.ok(Math.abs(beatsM[0].sec - beats0[0].sec) < 1e-9, '窗数<卡数 beats 回退均匀数学');
  ok('deriveCardDwell 跟随覆盖层（0.725 同源 + 不齐回退）');
}

// ====== 素材窗反解：mediaIn/mediaOut ↔ trim ======
{
  const seg = mkSeg({
    templateId: 'CursorFollow',
    videos: [mkVideo({type: 'video', trimStart: 2, trimEnd: 10, cuts: [{start: 4, end: 5}]})],
  });
  const r = solveMediaWindow(seg, 0, 3, 12);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {trimStart: 3, trimEnd: 12, cuts: [{start: 4, end: 5}]}, '窗→trim 映射且 cuts 原样保留');
  const inv = solveMediaWindow(seg, 0, 8, 8.01);
  assert.ok(!inv.ok && inv.reason.includes('过短'), '倒置/过短窗拒绝');
  const img = mkSeg({templateId: 'KenBurns', videos: [mkVideo({type: 'image' as VideoClip['type'], duration: 0})]});
  const rimg = solveMediaWindow(img, 0, 0, 1);
  assert.ok(!rimg.ok && rimg.reason.includes('图片'), '图片无时窗拒绝');
  const miss = solveMediaWindow(seg, 3, 0, 1);
  assert.ok(!miss.ok, '素材下标越界拒绝');
  ok('素材窗反解（trim 同口径 + cuts 保留 + 三类拒绝）');
}

// ====== 投影消费覆盖层：冻结段投影窗 = 物化层真值，文案仍按当前 text 推导 ======
{
  const base = mkSeg({templateId: 'CursorFollow', text: {title: '标题', subtitle: '副题', features: [], brandName: ''}});
  const caps0 = projectSegmentPlan(base)?.captions ?? [];
  const frozen = {frozenAt: '2026-10-12T00:00:00.000Z', paramSnapshot: {}, detachedFields: ['captions' as const]};
  const seg = {
    ...base,
    frozen,
    materialized: {captions: [{startSec: 1.5, endSec: 6}, {startSec: 0, endSec: 8}]},
    text: {...base.text, title: '改后标题'},
  };
  const caps = projectSegmentPlan(seg)?.captions ?? [];
  assert.equal(caps.length, caps0.length, '条数不变');
  assert.equal(caps[0].text, '改后标题', '文案按当前 text 推导（文案永不冻结）');
  assert.ok(Math.abs(caps[0].startSec - 1.5) < 1e-9 && Math.abs(caps[0].endSec - 6) < 1e-9, '窗=物化层真值');
  assert.equal(caps[0].startFrame, 45, '帧口径随窗重算');

  // effectiveCaptionWindows：冻结段直接回覆盖层；未冻结段=推导窗
  assert.deepEqual(effectiveCaptionWindows(seg).length, 2, '冻结段生效窗=覆盖层');
  assert.deepEqual(effectiveCaptionWindows(base), caps0.map((c) => ({startSec: c.startSec, endSec: c.endSec})), '未冻结段=推导窗');

  // 覆盖层比推导长：多余窗弃（无文字槽可配，宁少勿猜）
  const longer = {...seg, materialized: {captions: [{startSec: 1, endSec: 2}, {startSec: 0, endSec: 8}, {startSec: 3, endSec: 4}]}};
  assert.equal((projectSegmentPlan(longer)?.captions ?? []).length, 2, '多余覆盖窗弃');
  ok('投影消费覆盖层（窗真值/文案推导/帧重算/多余弃）');
}

console.log(`\nplan-writeback: ${passed} 组全过`);
