/**
 * planFrameTimes 纯函数单测：view_media_frames 缺省采样点规划
 * （有效区间 = 裁剪窗口挖掉 cuts；返回媒体秒 + 段内相对秒）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/frame-times.test.ts
 */
import assert from 'node:assert/strict';
import {planFrameTimes, effectiveRanges} from '../../src/shared/clipCuts.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('frame-times:');

t('无裁剪无挖段：全片均匀采样，segmentSec = mediaSec', () => {
  const pts = planFrameTimes({duration: 60}, 4);
  assert.equal(pts.length, 4);
  // 60s 的 12.5%/37.5%/62.5%/87.5%
  assert.ok(Math.abs(pts[0].mediaSec - 7.5) < 0.01, `p0=${pts[0].mediaSec}`);
  assert.ok(Math.abs(pts[3].mediaSec - 52.5) < 0.01, `p3=${pts[3].mediaSec}`);
  for (const p of pts) assert.equal(p.segmentSec, p.mediaSec);
});

t('trim 窗口：只在 [trimStart, trimEnd] 内采样，segmentSec 从 0 起', () => {
  const pts = planFrameTimes({duration: 60, trimStart: 38, trimEnd: 47}, 4);
  for (const p of pts) {
    assert.ok(p.mediaSec >= 38 && p.mediaSec <= 47, `media ${p.mediaSec} 出窗`);
    assert.ok(p.segmentSec >= 0 && p.segmentSec <= 9, `seg ${p.segmentSec} 出窗`);
    assert.ok(Math.abs((p.mediaSec - 38) - p.segmentSec) < 0.01);
  }
  assert.ok(Math.abs(pts[0].segmentSec - 1.125) < 0.01, `first seg=${pts[0].segmentSec}`);
});

t('挖段：采样点永不落在洞内（trim+cuts 组合）', () => {
  const clip = {duration: 60, trimStart: 10, trimEnd: 40, cuts: [{start: 20, end: 30}]};
  const pts = planFrameTimes(clip, 6);
  // 有效总长 30 - 10 = 20s，两段 [10,20] [30,40]
  for (const p of pts) {
    const inHole = p.mediaSec > 20 && p.mediaSec < 30;
    assert.ok(!inHole, `点 ${p.mediaSec} 落在挖段内`);
    assert.ok(p.mediaSec >= 10 && p.mediaSec <= 40, `media ${p.mediaSec} 出窗`);
  }
  // 均匀分布应两段都有点
  const inFirst = pts.filter((p) => p.mediaSec < 20).length;
  const inSecond = pts.filter((p) => p.mediaSec >= 30).length;
  assert.ok(inFirst >= 2 && inSecond >= 2, `分布不均: first=${inFirst} second=${inSecond}`);
});

t('count 钳制 2-8，小数四舍五入', () => {
  assert.equal(planFrameTimes({duration: 60}, 1).length, 2);
  assert.equal(planFrameTimes({duration: 60}, 99).length, 8);
  assert.equal(planFrameTimes({duration: 60}, 4.7).length, 5);
});

t('极端窗口（防御）：有效区间为空返回起点单点', () => {
  const pts = planFrameTimes({duration: 10, trimStart: 9.99, trimEnd: 10}, 4);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].segmentSec, 0);
});

t('effectiveRanges：挖段在窗外/跨窗边都被正确裁剪', () => {
  const rs = effectiveRanges({duration: 60, trimStart: 38, trimEnd: 47, cuts: [{start: 10, end: 40}, {start: 50, end: 55}]});
  // 窗口 [38,47]：cut 10-40 裁出 [40,47]，cut 50-55 在窗外无贡献
  assert.deepEqual(rs, [{start: 40, end: 47}]);
});

console.log(`\n===== ${passed} 项全部通过 =====`);
