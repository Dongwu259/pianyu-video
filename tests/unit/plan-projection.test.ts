/**
 * plan-projection / frame-grid / mediaToTimelineSec 单测（timeline-master-plan M1）
 *
 * 锚定重点：
 * - 同源纪律（总纲 §二.7）：WhiteboardCanvas 驻留节拍必须与 template-keyframes
 *   whiteboardPlanner（v10-v12 目检帧实战）逐值一致——投影漂移单测即抓；
 * - 白名单纪律：投影输出键 ⊆ registry materializable；未声明模板 → null；
 * - agent 面 v1.3：get_timeline plan 摘要 additive 键 + get_segment_plan 执行器闭环。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs --test tests/unit/plan-projection.test.ts
 */
import assert from 'node:assert/strict';
// 必须在 toolExecutors 链（最终引用 ThreeText 的 .ttf 字体 import）之前求值
import './asset-stub.cjs';
import {TOOL_EXECUTORS} from '../../src/renderer/ai/toolExecutors.ts';
import {secToFrame, frameToSec, clampSec} from '../../src/shared/frame-grid.ts';
import {mediaToTimelineSec, timelineToMediaSec} from '../../src/shared/clipCuts.ts';
import {projectSegmentPlan, segmentPlanSummary} from '../../src/shared/plan-projection.ts';
import {TEMPLATE_KEYFRAME_PLANNERS, fallbackKeyframe} from '../../src/shared/template-keyframes.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {readParam} from '../../src/shared/template-checkpoints.ts';
import type {Segment} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const mkSeg = (over: Partial<Segment> & {templateId: string}): Segment =>
  ({
    id: 'seg-x',
    videos: [],
    text: {},
    style: {},
    duration: 8,
    transition: 'none',
    ...over,
  }) as Segment;

// ====== frame-grid：契约冻结口径 ======
{
  assert.equal(secToFrame(1.5), 45, 'round(sec×30)');
  assert.equal(secToFrame(0.0166), 0, '半帧以下取 0');
  assert.equal(secToFrame(0.0167), 1, '过半帧进 1');
  assert.equal(frameToSec(45), 1.5, '帧→秒精确除法');
  assert.equal(secToFrame(frameToSec(2999)), 2999, '往返恒等');
  assert.equal(clampSec(9, 8), 8, '秒钳到段尾');
  assert.equal(clampSec(-1, 8), 0, '秒钳到段首');
  ok('frame-grid 取整口径 round(sec×30) + 往返恒等');
}

// ====== mediaToTimelineSec：timelineToMediaSec 的逆 ======
{
  // 无 cuts：恒等平移
  assert.equal(mediaToTimelineSec(5.0, 2, 10, undefined), 3, '无 cuts 平移');
  // 往返恒等（无 cuts）
  assert.equal(mediaToTimelineSec(timelineToMediaSec(4.25, 2, undefined), 2, 10, undefined), 4.25, '往返恒等');
  // 窗外：null
  assert.equal(mediaToTimelineSec(1.0, 2, 10, undefined), null, 'trimStart 前为 null');
  assert.equal(mediaToTimelineSec(10.5, 2, 10, undefined), null, 'trimEnd 后为 null');
  // 洞内：null（宁少勿猜，不猜出口）
  const cuts = [{start: 4, end: 6}];
  assert.equal(mediaToTimelineSec(5.0, 2, 10, cuts), null, '洞内为 null');
  // 洞后平移累计洞长
  assert.ok(Math.abs((mediaToTimelineSec(7.0, 2, 10, cuts) ?? -1) - 3) < 1e-9, '洞后累计（4→7 跨 2s 洞 = 3s 段内）');
  ok('mediaToTimelineSec 四态（平移/往返/窗外/洞内）');
}

// ====== 白名单与批次 ======
{
  const kinetic = mkSeg({templateId: 'KineticType'});
  assert.equal(projectSegmentPlan(kinetic), null, '未声明模板 → null');
  const withPlan = TEMPLATES.filter((t) => t.plan).map((t) => t.id).sort();
  assert.deepEqual(withPlan, ['CursorFollow', 'DocPanel', 'WhiteboardCanvas'], 'M1 首批三模板');
  ok('批次外模板 null + 首批清单锚定');
}

// ====== CursorFollow：点击节拍映射 ======
{
  const seg = mkSeg({
    templateId: 'CursorFollow',
    duration: 6,
    videos: [
      {
        id: 'c1',
        name: 'rec.mp4',
        type: 'video',
        src: 'x/rec.mp4',
        duration: 30,
        width: 2538,
        height: 1434,
        trimStart: 10,
        trimEnd: 16,
        cursorClicks: [
          {t: 9000, x: 100, y: 50, button: 1}, // media 9s < trimStart → 窗外
          {t: 11500, x: 200, y: 60, button: 1}, // media 11.5s → 段内 1.5s
          {t: 13000, x: 300, y: 70, button: 1}, // media 13s → 段内 3s
          {t: 20000, x: 400, y: 80, button: 1}, // media 20s > trimEnd → 窗外
        ],
      } as Segment['videos'][number],
    ],
    text: {title: '海量模板', subtitle: '一搜即达'},
  });
  const p = projectSegmentPlan(seg)!;
  assert.equal(p.templateId, 'CursorFollow');
  assert.deepEqual(p.beats!.map((b) => b.sec), [1.5, 3], '窗内点击 → 段内秒（精确逆映射）');
  assert.ok(p.beats!.every((b) => b.kind === 'click'), 'kind=click');
  assert.ok(p.beats![0].target!.startsWith('('), 'target=归一化坐标');
  assert.equal(p.captions!.length, 2, '标题+副标题两行');
  assert.equal(p.captions![0].startSec, 0, '全程在场');
  assert.equal(p.mediaWindows!.length, 1, '素材窗');
  assert.equal(p.mediaWindows![0].mediaInSec, 10, 'mediaIn=trimStart');
  assert.ok(Math.abs(p.mediaWindows![0].mediaOutSec - 16) < 1e-9, 'mediaOut=trimEnd');
  ok('CursorFollow 点击节拍（窗外剔除+逆映射）+ 字幕窗 + 素材窗');
  // 挖段洞内点击 → 剔除
  const segCut = mkSeg({
    templateId: 'CursorFollow',
    duration: 6,
    videos: [
      {
        id: 'c2', name: 'r.mp4', type: 'video', src: 'x/r.mp4', duration: 30, width: 100, height: 100,
        trimStart: 10, trimEnd: 16, cuts: [{start: 11, end: 15}],
        cursorClicks: [
          {t: 12000, x: 1, y: 1, button: 1}, // 洞内 → 剔除
          {t: 15300, x: 2, y: 2, button: 1}, // 洞后 media 15.3 → 段内 (15.3-10) - 4(洞长) = 1.3
        ],
      } as Segment['videos'][number],
    ],
  });
  const p2 = projectSegmentPlan(segCut)!;
  assert.deepEqual(p2.beats!.map((b) => b.sec), [1.3], '洞内点击剔除、洞后累计洞长');
  ok('CursorFollow 挖段洞内点击剔除');
}

// ====== WhiteboardCanvas：驻留节拍与 keyframes 规划器同源锚定 ======
{
  const features = ['[t]本地 AI 模型部署', '[v]模型下载|授权解锁', '[t]高光挖掘', '[v]候选打分|一键挖段'];
  const seg = mkSeg({templateId: 'WhiteboardCanvas', duration: 7.2, text: {features}});
  const p = projectSegmentPlan(seg)!;
  assert.equal(p.beats!.length, 4, '四卡四节拍');
  // 同源锚定：与 whiteboardPlanner（目检帧实战）逐值一致
  const meta = TEMPLATES.find((t) => t.id === 'WhiteboardCanvas')!;
  const read = readParam(meta.paramSpecs!, undefined);
  const marks = TEMPLATE_KEYFRAME_PLANNERS.WhiteboardCanvas!(seg, read, 30);
  assert.equal(marks.length, 4);
  assert.deepEqual(
    p.beats!.map((b) => b.sec),
    marks.map((m) => Math.round(m.atSec * 1000) / 1000),
    '驻留节拍 ≡ whiteboardPlanner（同源纪律，漂移即红）',
  );
  assert.equal(p.captions!.length, 4, '四卡字幕行');
  assert.ok(p.captions![1].text.includes('｜'), '副题用全角竖线拼接');
  assert.ok(p.captions![0].startSec < p.captions![1].startSec, '卡窗顺序');
  ok('WhiteboardCanvas 驻留节拍 ≡ keyframes 规划器（同源锚定）+ 卡字幕窗');
}

// ====== DocPanel：段落/占位格节拍与 docPanelTimeline 同源 ======
{
  const seg = mkSeg({
    templateId: 'DocPanel',
    duration: 6,
    text: {title: '分镜脚本', features: ['开场：一句话钩子', '总览：三板驻留展板', '[[自证：本片由片语自己剪]]', 'img:首帧', 'img:中段']},
  });
  const p = projectSegmentPlan(seg)!;
  const pops = p.beats!.filter((b) => b.kind === 'pop');
  const cells = p.beats!.filter((b) => b.kind === 'cell');
  assert.equal(pops.length, 3, '三段落');
  assert.equal(cells.length, 2, '两占位格');
  // 同源锚定：paraEnter 直接来自渲染端消费的 docPanelTimeline
  const {docPanelTimeline} = await import('../../src/shared/doc-panel.ts');
  const tl = docPanelTimeline(3, 2, Math.round(6 * 30), 30, 1);
  assert.ok(Math.abs(pops[1].sec - tl.paraEnter(1) / 30) < 5e-4, '段落节拍 ≡ docPanelTimeline（毫秒舍入内）');
  assert.ok(cells[0].sec > pops[2].sec, '占位格在末段 60% 后');
  assert.equal(p.captions!.length, 4, '窗口条标题 + 三段落');
  assert.ok(p.captions![1].text.includes('一句话钩子'), '段落文本 [[ ]] 剥壳');
  assert.equal(p.mediaWindows, undefined, 'DocPanel 未开放 mediaWindows——白名单纪律');
  ok('DocPanel 段落/占位格节拍 ≡ docPanelTimeline（同源锚定）+ 白名单缺键');
}

// ====== 摘要 + agent 面执行器闭环 ======
{
  const seg = mkSeg({
    templateId: 'DocPanel',
    duration: 6,
    text: {features: ['段落一', '段落二']},
  });
  const s = segmentPlanSummary(seg)!;
  assert.equal(s.beatsCount, 2, '摘要计数');
  assert.deepEqual(s.materializable, ['captions', 'beats'], '白名单回读');
  assert.equal(segmentPlanSummary(mkSeg({templateId: 'KineticType'})), null, '批次外无摘要键');

  // get_timeline：plan 键 additive（批次外段不出现）
  const store: any = {
    segments: [seg, mkSeg({templateId: 'KineticType', duration: 4})],
    bgm: null,
    sfx: {enabled: true, volume: 0.8, transitionWhoosh: true, beatImpact: false, introRiser: true},
    customTemplates: [], marketTemplates: [], generatedTemplates: [],
  };
  const ctx: any = {getStore: () => store};
  const tl: any = await TOOL_EXECUTORS.get_timeline({}, ctx);
  assert.equal(tl.result.ok, true);
  assert.ok(tl.result.clips[0].plan, 'DocPanel 段有 plan 摘要');
  assert.equal(tl.result.clips[0].plan.beatsCount, 2);
  assert.equal(tl.result.clips[1].plan, undefined, '批次外段无 plan 键（旧消费方无感）');

  // get_segment_plan：命中 + 未开放两态
  const r1: any = await TOOL_EXECUTORS.get_segment_plan({segmentIndex: 0}, ctx);
  assert.equal(r1.result.ok, true);
  assert.equal(r1.result.beats.length, 2);
  assert.ok(r1.result.message.includes('段内坐标'));
  const r2: any = await TOOL_EXECUTORS.get_segment_plan({segmentIndex: 1}, ctx);
  assert.equal(r2.result.ok, false, '未开放模板 ok:false');
  assert.ok(r2.result.errors[0].includes('未开放'), '带开放清单指引');
  const r3: any = await TOOL_EXECUTORS.get_segment_plan({segmentIndex: 9}, ctx);
  assert.equal(r3.result.ok, false, '越界 ok:false');
  ok('agent 面 v1.3：plan 摘要 additive 键 + get_segment_plan 三态闭环');
}

// ====== 规划器回退仍可用（keyframes 模块不受影响） ======
{
  assert.equal(fallbackKeyframe(mkSeg({templateId: 'Nope', duration: 5}))[0].atSec, 2.5, '回退段中点');
  ok('keyframes 回退不受影响');
}

console.log(`plan-projection: ${passed} 组全 PASS`);
