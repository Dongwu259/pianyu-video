/**
 * 实拍铁律软执行（shared/live-action-guard.ts）单测（P0-2）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/live-action-guard.test.ts
 */
import {liveActionStats, liveActionTemplateRank, softSortTemplatesForLiveAction, liveActionShrinkWarning} from '../../src/shared/live-action-guard';
import type {VideoClip} from '../../src/shared/types';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

const clip = (type: VideoClip['type'], sourceKind?: VideoClip['sourceKind']): VideoClip =>
  ({type, ...(sourceKind ? {sourceKind} : {}), videos: undefined, src: '', name: '', width: 0, height: 0, duration: 0}) as unknown as VideoClip;

// ====== 占比统计 ======
const la = liveActionStats([
  {videos: [clip('video', 'live-action'), clip('video', 'live-action'), clip('video', 'screen-recording')]},
  {videos: [clip('image')]},
]);
ok(la.videos === 3 && la.live === 2, '只统计视频素材（图片不计入分母）');
ok(la.dominant, '实拍 2/3 ≥60% → dominant');
ok(!liveActionStats([{videos: [clip('video', 'live-action'), clip('video', 'screen-recording')]}]).dominant, '50% 不触发');
ok(!liveActionStats([{videos: [clip('image')]}]).dominant, '无视频素材不触发');
ok(liveActionStats([{videos: [clip('video')]}]).dominant, 'sourceKind 缺省按 live-action（旧工程兼容）');

// ====== 档位 ======
ok(liveActionTemplateRank({minVideos: 1, defaultLayout: {videoWidthRatio: 1}}) === 0, '满幅素材类 = 0 档');
ok(liveActionTemplateRank({minVideos: 6, defaultLayout: {videoWidthRatio: 1}}) === 0, '多素材满幅 = 0 档');
ok(liveActionTemplateRank({minVideos: 1}) === 1, '无 defaultLayout 的素材承载类 = 1 档（缺省非满幅）');
ok(liveActionTemplateRank({minVideos: 0}) === 2, '零素材文字卡 = 2 档');

// ====== 稳定软排序：同档保序、不删选项 ======
const a = {id: 'A', minVideos: 0};                       // 文字卡（原有首位）
const b = {id: 'B', minVideos: 1, defaultLayout: {videoWidthRatio: 1}}; // 满幅
const c = {id: 'C', minVideos: 1};                       // 画中画
const d = {id: 'D', minVideos: 0};                       // 文字卡
const sorted = softSortTemplatesForLiveAction([a, b, c, d]);
ok(sorted.map((t) => t.id).join(',') === 'B,C,A,D', `满幅前移、文字卡靠后、同档保序（实得 ${sorted.map((t) => t.id).join(',')}）`);
ok(sorted.length === 4, '不删除任何选项');

// ====== 缩小警告 ======
const warn = liveActionShrinkWarning(
  [clip('video', 'live-action')],
  {name: '3D 展台', defaultLayout: {videoWidthRatio: 0.6}},
  2,
);
ok(warn !== null && warn.includes('第 3 段') && warn.includes('3D 展台'), '实拍 + 非满幅模板 → 警告（段号 1 起）');
ok(liveActionShrinkWarning([clip('video', 'live-action')], {name: '满幅', defaultLayout: {videoWidthRatio: 1}}, 0) === null, '满幅模板不警');
ok(liveActionShrinkWarning([clip('video', 'screen-recording')], {name: '画中画'}, 0) === null, '纯录屏不警（画中画是录屏正解）');
ok(liveActionShrinkWarning([clip('video', 'live-action')], undefined, 0) === null, '模板未找到不警');
ok(liveActionShrinkWarning(undefined, {name: 'X'}, 0) === null, '无素材不警');

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);

// ====== P0-1 首次导入体裁自动路由 ======
import {inferAutoVideoType} from '../../src/shared/live-action-guard';

ok(inferAutoVideoType([clip('video', 'live-action'), clip('video', 'live-action'), clip('image')]) === 'vlog', '实拍占多数 → vlog');
ok(inferAutoVideoType([clip('video', 'screen-recording'), clip('video', 'screen-recording')]) === null, '纯录屏不路由（promo/tutorial 双合法，不瞎猜）');
ok(inferAutoVideoType([clip('video', 'live-action'), clip('video', 'screen-recording')]) === null, '混合工程不路由');
ok(inferAutoVideoType([clip('image'), clip('image')]) === null, '纯图片不路由');
ok(inferAutoVideoType([]) === null, '空素材不路由');
console.log('P0-1 inferAutoVideoType: passed');
