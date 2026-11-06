/**
 * 故事板完整性体检（shared/storyboard-completeness.ts）单测：
 * 缺主标题 / 缺素材 / 全片无转场三规则，request_render 前的宿主护栏。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/storyboard-completeness.test.ts
 */
import {lintStoryboardCompleteness} from '../../src/shared/storyboard-completeness';
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

const rules = (segs: Segment[]) => lintStoryboardCompleteness({segments: segs}).map((i) => i.rule);

// ====== 缺主标题（warn） ======
{
  const issues = lintStoryboardCompleteness({segments: [mkSeg({id: 'a', templateId: 'T'})]});
  const t = issues.find((i) => i.rule === 'empty-title');
  ok(Boolean(t) && t!.severity === 'warn' && t!.segmentIndex === 0, '无 title → warn 带段下标');
}
{
  const segs = [mkSeg({id: 'a', templateId: 'T', text: {title: '有标题', subtitle: '', features: [], brandName: ''}})];
  ok(!rules(segs).includes('empty-title'), '有 title 不报');
}

// ====== 缺素材（warn） ======
{
  const segs = [
    mkSeg({id: 'a', templateId: 'T'}),
    mkSeg({id: 'b', templateId: 'T', videos: [{src: 'x.mp4'}] as Segment['videos']}),
  ];
  const issues = lintStoryboardCompleteness({segments: segs}).filter((i) => i.rule === 'no-media');
  ok(issues.length === 1 && issues[0].segmentIndex === 0, '只有第 1 段报缺素材');
}

// ====== 全片无转场（info，不阻断） ======
{
  const segs = [mkSeg({id: 'a', templateId: 'T'}), mkSeg({id: 'b', templateId: 'T'})];
  const issues = lintStoryboardCompleteness({segments: segs}).filter((i) => i.rule === 'no-transition');
  ok(issues.length === 1 && issues[0].severity === 'info', '全硬切 → info 全片级');
}
{
  const segs = [
    mkSeg({id: 'a', templateId: 'T', transition: 'none'}),
    mkSeg({id: 'b', templateId: 'T', transition: 'crossfade'}),
  ];
  ok(!rules(segs).includes('no-transition'), '任一段设了非硬切转场即不报');
}

// ====== 干净故事板零输出 / 单段不查转场 ======
{
  const clean = [mkSeg({id: 'a', templateId: 'T3D', text: {title: 'T', subtitle: '', features: [], brandName: ''}, videos: [{src: 'x.mp4'}] as Segment['videos']})];
  ok(lintStoryboardCompleteness({segments: clean}).length === 0, '标题+素材齐全的单段 → 零问题（单段不查转场）');
}

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
