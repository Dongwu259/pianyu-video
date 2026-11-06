/**
 * 段内多镜切分计划（shared/segment-shot-plan.ts）单测（P1-5B）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/segment-shot-plan.test.ts
 */
import {planSegmentShots, shotAt} from '../../src/shared/segment-shot-plan';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};
const close = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

// ====== 固定节奏：两素材轮转 ======
const twoClips = planSegmentShots({
  clips: [{durationSec: 6}, {durationSec: 6}],
  totalSec: 10,
  shotSec: 2.5,
});
ok(twoClips.length === 4, `两素材 10s/2.5s → 4 镜（实得 ${twoClips.length}）`);
ok(twoClips.map((s) => s.videoIndex).join(',') === '0,1,0,1', '两素材严格轮转（不连用同源）');
ok(twoClips.every((s) => close(s.durationSec, 2.5)), '每镜 2.5s');
ok(close(sum(twoClips.map((s) => s.durationSec)), 10), '总时长恰好铺满段');

// ====== 镜头清单优先：切点落素材自身场景边界 ======
const shotListClips = planSegmentShots({
  clips: [
    {
      durationSec: 4,
      windowStartSec: 10,
      windowEndSec: 14,
      shots: [
        {startSec: 0, endSec: 8, motionScore: 0.1},       // 窗口外（整段早于窗口）
        {startSec: 8, endSec: 11, motionScore: 0.5},      // 与窗口交叠 10-11 → 1s 镜
        {startSec: 11, endSec: 14, motionScore: 0.9},     // 窗口内 11-14 → 3s 镜
        {startSec: 14, endSec: 20, motionScore: 0.2},     // 窗口外
      ],
    },
    {durationSec: 2},
  ],
  totalSec: 9,
  shotSec: 2.5,
});
// 素材 0 提供两个镜头窗口（1s、3s，mediaStart 相对窗口起点），素材 1 固定节奏 2s（耗尽回绕）
// 轮转序列：c0(1s) → c1(2s) → c0(3s) → c1(2s 回绕) → c0(1s 回绕) = 9s
ok(shotListClips.length === 5, `镜头清单取窗 → 5 镜（实得 ${shotListClips.length}）`);
ok(close(shotListClips[0].durationSec, 1) && close(shotListClips[0].mediaStart, 0), '镜 1 = 素材 0 的 10-11s 场景（相对窗口 0s，1s）');
ok(shotListClips[1].videoIndex === 1, '镜 2 轮到素材 1');
ok(shotListClips[2].videoIndex === 0 && close(shotListClips[2].durationSec, 3) && close(shotListClips[2].mediaStart, 1), '镜 3 = 素材 0 的 11-14s 场景（相对窗口 1s，3s）');
ok(shotListClips[3].videoIndex === 1 && close(shotListClips[3].mediaStart, 0), '镜 4 = 素材 1 窗口回绕（从头）');
ok(close(sum(shotListClips.map((s) => s.durationSec)), 9), '镜头清单模式总时长铺满');

// ====== 窗口耗尽循环：单素材轮播自身 ======
const loopOne = planSegmentShots({clips: [{durationSec: 3}], totalSec: 10, shotSec: 2.5});
ok(close(sum(loopOne.map((s) => s.durationSec)), 10, 0.06), '单素材循环铺满 10s');
ok(loopOne.every((s) => s.videoIndex === 0), '单素材全为 videoIndex 0');
ok(loopOne.some((s) => close(s.mediaStart, 0)), '循环回到窗口起点');
ok(loopOne.every((s) => s.durationSec >= 0.15), '无闪帧镜（每镜 ≥0.15s）');

// ====== 段预算先尽：部分消耗 + 余量保留 ======
const partial = planSegmentShots({clips: [{durationSec: 30}], totalSec: 4, shotSec: 10});
ok(partial.length === 1 && close(partial[0].durationSec, 4), '窗口长于段预算 → 单镜截到段尾');

// ====== 图片素材（durationSec 传大数）参与轮转 ======
const withImage = planSegmentShots({
  clips: [{durationSec: 3600}, {durationSec: 5}],
  totalSec: 6,
  shotSec: 2.5,
});
ok(withImage.some((s) => s.videoIndex === 0) && withImage.some((s) => s.videoIndex === 1), '图片素材参与轮转');

// ====== 边界：空输入/非法参数 → 空计划（调用方退回旧单素材路径）======
ok(planSegmentShots({clips: [], totalSec: 5, shotSec: 2.5}).length === 0, '无素材 → 空');
ok(planSegmentShots({clips: [{durationSec: 0}], totalSec: 5, shotSec: 2.5}).length === 0, '素材零时长 → 空');
ok(planSegmentShots({clips: [{durationSec: 5}], totalSec: 0, shotSec: 2.5}).length === 0, '段时长 0 → 空');
ok(planSegmentShots({clips: [{durationSec: 5}], totalSec: 5, shotSec: 0}).length === 0, 'shotSec 非法 → 空');
// 镜头清单与窗口无交集 → 退固定节奏（不返回空）
const noOverlap = planSegmentShots({
  clips: [{durationSec: 4, windowStartSec: 0, shots: [{startSec: 10, endSec: 12}]}],
  totalSec: 4,
  shotSec: 2,
});
ok(noOverlap.length === 2 && close(noOverlap[0].mediaStart, 0), '镜头清单无交集 → 退固定节奏');

// ====== shotAt 定位 ======
const plan = planSegmentShots({clips: [{durationSec: 9}], totalSec: 9, shotSec: 3});
ok(shotAt(plan, 0.5) === plan[0] && shotAt(plan, 3.5) === plan[1], 'shotAt 按时间定位所在镜');
ok(shotAt(plan, 999) === plan[plan.length - 1], 'shotAt 越界取末镜');
ok(shotAt([], 1) === null, 'shotAt 空序列 → null');

// ====== 确定性 ======
const a = JSON.stringify(planSegmentShots({clips: [{durationSec: 5}, {durationSec: 7}], totalSec: 12, shotSec: 2}));
const b = JSON.stringify(planSegmentShots({clips: [{durationSec: 5}, {durationSec: 7}], totalSec: 12, shotSec: 2}));
ok(a === b, '同输入同计划（确定性）');

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
