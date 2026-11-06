/**
 * P6 UI 音效放置规划器（planUiSfxPlacements）与 P4 文档时间线/滚动纯函数单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/ui-sfx-cues.test.ts
 */

import assert from 'node:assert/strict';
import {planUiSfxPlacements} from '../../src/shared/sfx-plan.ts';
import {docPanelTimeline, docScrollOffset} from '../../src/shared/doc-panel.ts';
import type {Segment} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const mkSeg = (templateId: string, features: string[], customParams: Record<string, number>, duration = 9, title = ''): Segment =>
  ({
    id: 's', templateId, videos: [],
    text: {title, subtitle: '', features, brandName: ''},
    style: {}, layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
    duration, transition: 'none', customParams,
  } as unknown as Segment);

const COUNTS = {whoosh: 2, swish: 2, sweep: 2, drop: 2, impact: 2, riser: 1, click: 4, pop: 2, ding: 2};

console.log('planUiSfxPlacements:');
{
  const fps = 30;
  // 对话段：5 气泡 pop + 1 徽章 ding
  const chat = mkSeg('ChatConversation', ['u:改节奏', 'a:✅ 解析完成', 'a:收紧转场', 'u:换轻快配乐', 'a:✅ 已重卡点'], {badge: 1});
  const cues = planUiSfxPlacements([chat], [0], fps, {enabled: true, volume: 0.8, transitionWhoosh: false, beatImpact: false, introRiser: false}, COUNTS);
  const pops = cues.filter((c) => c.kind === 'pop');
  const dings = cues.filter((c) => c.kind === 'ding');
  assert.equal(pops.length, 5, `每气泡一个 pop，实际 ${pops.length}`);
  assert.equal(dings.length, 1, '徽章一个 ding');
  assert.ok(pops.every((p) => p.variant < 2), 'pop 变体对 2 取模');
  // uiCues=false 关
  const off = planUiSfxPlacements([chat], [0], fps, {enabled: true, volume: 0.8, transitionWhoosh: false, beatImpact: false, introRiser: false, uiCues: false}, COUNTS);
  assert.equal(off.length, 0, 'uiCues=false 全关');
  // 打字轻点：AiPromptCard 打字窗内每 3 帧一个 click + 回车 ding
  const prompt = mkSeg('AiPromptCard', [], {typeSpeed: 10, enterAt: 0.6}, 8, '帮我剪一条产品宣传片');
  const cues2 = planUiSfxPlacements([prompt], [90], fps, {enabled: true, volume: 0.8, transitionWhoosh: false, beatImpact: false, introRiser: false}, COUNTS);
  const clicks = cues2.filter((c) => c.kind === 'click');
  assert.ok(clicks.length >= 5, `打字窗有 click 序列，实际 ${clicks.length}`);
  assert.ok(clicks.every((c, i, arr) => i === 0 || c.frame - arr[i - 1].frame === 3), 'click 每 3 帧一格');
  assert.ok(cues2.some((c) => c.kind === 'ding' && c.frame >= 90 + Math.round(8 * 30 * 0.6) - 2), '回车 ding 在 enter 帧');
  // 文档段：段落 pop + 占位格 ding
  const doc = mkSeg('DocPanel', ['开场用[[空镜]]立基调。', '中段三镜快切。', 'img:分镜一', 'img:分镜二'], {});
  const cues3 = planUiSfxPlacements([doc], [0], fps, {enabled: true, volume: 0.8, transitionWhoosh: false, beatImpact: false, introRiser: false}, COUNTS);
  assert.equal(cues3.filter((c) => c.kind === 'pop').length, 2, '每段落一个 pop');
  assert.equal(cues3.filter((c) => c.kind === 'ding').length, 2, '每占位格一个 ding');
  // 绝对帧偏移：start=90 时所有 cue ≥ 90
  assert.ok(cues2.every((c) => c.frame >= 90));
  // 非目标模板零放置
  const other = planUiSfxPlacements([mkSeg('TextSlide', ['x'], {})], [0], fps, {enabled: true, volume: 0.8, transitionWhoosh: false, beatImpact: false, introRiser: false}, COUNTS);
  assert.equal(other.length, 0);
  ok('对话 pop/ding / uiCues 开关 / 打字 click 序列与 ding / 文档 pop+ding / 绝对偏移 / 非目标零放置');
}

console.log('docPanelTimeline & docScrollOffset:');
{
  const fps = 30;
  const tl = docPanelTimeline(3, 2, 9 * fps, fps, 1);
  assert.equal(tl.paraEnter(0), Math.round(0.4 * fps), '首段 0.4s');
  assert.ok(tl.cellEnter(0) > tl.paraEnter(2), '占位格在末段后');
  // 滚动：不溢出 → 0；溢出 → 正值且 progress 单调
  assert.equal(docScrollOffset([20, 20], {charsPerLine: 40, lineHeightPx: 20, gapPx: 10, availPx: 500, progress: 1}), 0);
  const half = docScrollOffset([40, 40, 40], {charsPerLine: 10, lineHeightPx: 20, gapPx: 10, availPx: 100, progress: 0.5});
  const full = docScrollOffset([40, 40, 40], {charsPerLine: 10, lineHeightPx: 20, gapPx: 10, availPx: 100, progress: 1});
  assert.ok(half > 0 && full > half, `滚动单调递增（${half.toFixed(1)} → ${full.toFixed(1)}）`);
  ok('时间线基准/滚动溢出与单调');
}

console.log(`\n共 ${passed} 项全部通过`);
