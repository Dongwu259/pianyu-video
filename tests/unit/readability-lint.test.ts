/**
 * 成片可读性体检（shared/readability-lint.ts）单测：
 * 13 字/秒停留、行 ≤30 字、标题 ≤20 字、要点 ≤5 条、字幕行宽/停留、hook 密度。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/readability-lint.test.ts
 */
import {
  lintReadability,
  estimateVisibleChars,
  minDwellSec,
  READABILITY_CHARS_PER_SEC,
} from '../../src/shared/readability-lint';
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

const findIssues = (segments: Segment[], rule: string) => lintReadability({segments}).filter((i) => i.rule === rule);

// ====== 基础估算 ======
ok(minDwellSec(13) === 1, '13 字 → 1s');
ok(minDwellSec(20) === 2, '20 字 → 2s（0.5s 档向上取整）');
ok(minDwellSec(0) === 0, '0 字 → 0s');
{
  const seg = mkSeg({id: 'a', templateId: 'TextSlide', text: {title: '标题', subtitle: '副标题', features: ['一二三四五', '六七八九十'], brandName: ''}});
  ok(estimateVisibleChars(seg) === 2 + 3 + 10, '可见字量 = 标题+副标题+前 3 要点');
}

// ====== 停留时长（13 字/秒） ======
{
  // 40 字 / 2s = 20 字每秒，超速 → warn
  const seg = mkSeg({id: 'a', templateId: 'TextSlide', duration: 2, text: {title: '', subtitle: '', features: ['一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'], brandName: ''}});
  const issues = findIssues([seg], 'dwell');
  ok(issues.length === 1 && issues[0].severity === 'warn', '超速阅读 → dwell warn');
  ok(issues[0].segmentIndex === 0, '带 segmentIndex');
}
{
  // 20 字 / 2s = 10 字每秒，达标
  const seg = mkSeg({id: 'a', templateId: 'TextSlide', duration: 2, text: {title: '一二三四五六七八九十', subtitle: '', features: ['一二三四五六七八九十'], brandName: ''}});
  ok(findIssues([seg], 'dwell').length === 0, '10 字/秒 → 无 dwell');
}

// ====== 行宽 ≤30 ======
{
  const long = '一'.repeat(31);
  const seg = mkSeg({id: 'a', templateId: 'TextSlide', text: {title: '', subtitle: '', features: [long], brandName: ''}});
  ok(findIssues([seg], 'line-length').length === 1, '31 字行 → line-length warn');
  const ok30 = mkSeg({id: 'a', templateId: 'TextSlide', text: {title: '', subtitle: '一'.repeat(30), features: [], brandName: ''}});
  ok(findIssues([ok30], 'line-length').length === 0, '30 字行不报');
}

// ====== 标题 ≤20（info） ======
{
  const seg = mkSeg({id: 'a', templateId: 'KineticType', text: {title: '一'.repeat(21), subtitle: '', features: [], brandName: ''}});
  const issues = findIssues([seg], 'title-length');
  ok(issues.length === 1 && issues[0].severity === 'info', '21 字标题 → info');
}

// ====== 要点 ≤5（info） ======
{
  const seg = mkSeg({id: 'a', templateId: 'FeatureList', duration: 30, text: {title: '', subtitle: '', features: ['a', 'b', 'c', 'd', 'e', 'f'], brandName: ''}});
  ok(findIssues([seg], 'line-count').length === 1, '6 条要点 → line-count info');
}

// ====== 字幕行 ======
{
  const seg = mkSeg({
    id: 'a', templateId: 'VideoCut', duration: 10,
    text: {title: '', subtitle: '', features: [], brandName: ''},
    captions: [
      {text: '一'.repeat(31), startSec: 0, endSec: 4}, // 行宽超
      {text: '一二三四五六七八九十', startSec: 4, endSec: 4.4}, // 停留不足（10 字需 ≥0.77s）
      {text: '短句', startSec: 5, endSec: 7}, // 正常
    ],
  } as Partial<Segment>);
  ok(findIssues([seg], 'caption-length').length === 1, '31 字字幕行 → caption-length');
  ok(findIssues([seg], 'caption-dwell').length === 1, '0.4s 停 10 字 → caption-dwell');
}

// ====== hook 密度 ======
{
  // 前 3 秒只有 2 次变化（首帧 + 1 切点）：5s+5s → info
  const segs = [
    mkSeg({id: 'a', templateId: 'VideoCut', duration: 5}),
    mkSeg({id: 'b', templateId: 'VideoCut', duration: 5}),
  ];
  const issues = findIssues(segs, 'hook-density');
  ok(issues.length === 1 && issues[0].severity === 'info', '2 次变化 → hook-density info');
  ok(issues[0].segmentIndex === undefined, '全片级不带段下标');
}
{
  // 1s+1s+1s+6s：前 3 秒 4 次变化 → 不报
  const segs = [1, 1, 1, 6].map((d, i) => mkSeg({id: `s${i}`, templateId: 'VideoCut', duration: d}));
  ok(findIssues(segs, 'hook-density').length === 0, '快切 hook 不报');
}

// ====== 干净工程零问题 + 排序 ======
{
  const segs = [
    mkSeg({id: 'a', templateId: 'VideoCut', duration: 1}),
    mkSeg({id: 'b', templateId: 'VideoCut', duration: 1}),
    mkSeg({id: 'c', templateId: 'VideoCut', duration: 1}),
    mkSeg({id: 'd', templateId: 'KineticType', duration: 4, text: {title: '效率翻倍', subtitle: '', features: ['「效率」翻倍的工作流', '让创意自动成片'], brandName: ''}}),
    mkSeg({id: 'e', templateId: 'TextSlide', duration: 6, text: {title: '总结', subtitle: '', features: ['要点一', '要点二'], brandName: ''}}),
  ];
  const issues = lintReadability({segments: segs});
  ok(issues.length === 0, `干净工程零问题（实际 ${issues.length}${issues.length ? '：' + issues.map((i) => i.message).join('/') : ''}）`);
}
{
  // warn 排在 info 前
  const segs = [
    mkSeg({id: 'a', templateId: 'TextSlide', duration: 1, text: {title: '一'.repeat(21) + '二'.repeat(20), subtitle: '', features: ['一'.repeat(31)], brandName: ''}}),
  ];
  const issues = lintReadability({segments: segs});
  ok(issues.length >= 3 && issues[0].severity === 'warn', 'warn 在 info 前');
}

console.log(`可读性体检: ${passed} 通过, ${failed} 失败（阅读速度基准 ${READABILITY_CHARS_PER_SEC} 字/秒）`);
if (failed > 0) process.exit(1);
