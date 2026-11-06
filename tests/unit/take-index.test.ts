/**
 * take-index.ts 单测：实录素材窗口索引（P1-4）
 * 点击表/运动曲线分桶/游离点击告警（22.19s 事故形态）/窗检查全景。
 * 悬停聚类本体是 click-zoom-smooth.hoverClusters 的直通（那边有自己的测试），这里只测秒制包装。
 */
import assert from 'node:assert/strict';
import {
  indexClicks, indexHovers, motionCurve, buildTakeIndex, offWindowClickAlerts, checkWindow,
  type CursorSidecar,
} from '../../src/shared/take-index.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const side = (over: Partial<CursorSidecar>): CursorSidecar => ({
  videoWidth: 1000, videoHeight: 500,
  points: [], clicks: [],
  ...over,
});

{
  // 点击表：ms→秒、归一化、排序、button 透传
  const clicks = indexClicks(side({clicks: [{t: 20000, x: 500, y: 250, button: 1}, {t: 5000, x: 100, y: 50}]}));
  assert.equal(clicks.length, 2);
  assert.equal(clicks[0].tSec, 5, '升序');
  assert.equal(clicks[0].normX, 0.1);
  assert.equal(clicks[0].normY, 0.1);
  assert.equal(clicks[1].tSec, 20);
  assert.equal(clicks[1].normX, 0.5);
  assert.equal(clicks[1].button, 1);
  assert.equal(clicks[0].button, undefined, '无 button 不造键');
  ok('indexClicks 秒制/归一化/排序');
}

{
  // 悬停包装：真轨迹产事件（不动 1s = 悬停），秒制字段补齐
  const pts = [
    {t: 0, x: 100, y: 100},
    {t: 300, x: 102, y: 101},
    {t: 600, x: 101, y: 100},
    {t: 900, x: 100, y: 102},
    {t: 1200, x: 400, y: 300}, // 移出半径
  ];
  const h = indexHovers(side({points: pts}));
  assert.equal(h.length, 1);
  assert.equal(h[0].t0Sec, 0);
  assert.ok(h[0].t1Sec >= 0.9 && h[0].t1Sec <= 1.2, `t1 落在移出前驻留点（实测 ${h[0].t1Sec}s）`);
  assert.ok(Math.abs(h[0].durSec - h[0].t1Sec) < 1e-9);
  ok('indexHovers hoverClusters 直通+秒制');
}

{
  // 运动曲线：0.5s 桶、跨桶段按时间均摊、空桶记 0
  const m = motionCurve(side({
    points: [
      {t: 0, x: 0, y: 0},
      {t: 400, x: 100, y: 0},    // 桶 0：0.4s 走 100px → 速度 250px/s 均摊入桶 0
      {t: 1400, x: 100, y: 0},   // 空闲 1s（无位移）
      {t: 1600, x: 200, y: 0},   // 跨桶段：1.4-1.6s 走 100px，0.1s 入桶 2、0.1s 入桶 3
    ],
  }));
  assert.equal(m[0].tSec, 0);
  assert.equal(m[0].samples, 1);
  assert.ok(Math.abs(m[0].speedPxPerSec - 200) < 1e-6, `桶0 均速=100px/0.5s（实测 ${m[0].speedPxPerSec}）`);
  assert.equal(m[1].speedPxPerSec, 0, '空闲桶速度 0');
  assert.ok(m[2].speedPxPerSec > 0 && m[3].speedPxPerSec > 0, '跨桶段两桶都有分摊');
  assert.ok(Math.abs(m[2].speedPxPerSec - m[3].speedPxPerSec) < 1e-6, '对称分摊');
  ok('motionCurve 0.5s 桶/均摊/空桶');
}

{
  // 游离点击告警：v11 事故同形态数据（窗 15.4-21.4，点击 22.19s 窗尾后 0.79s）
  const clicks = indexClicks(side({
    clicks: [
      {t: 15600, x: 1, y: 1},   // 窗内
      {t: 18200, x: 2, y: 2},   // 窗内
      {t: 22190, x: 3, y: 3},   // 窗尾后 0.79s ← 事故点击
      {t: 31650, x: 4, y: 4},   // 窗尾后 10.25s（远，不告）
      {t: 14000, x: 5, y: 5},   // 窗头前 1.4s（告）
      {t: 10000, x: 6, y: 6},   // 窗头前 5.4s（不告）
    ],
  }));
  const alerts = offWindowClickAlerts(clicks, {startSec: 15.4, endSec: 21.4}, 2);
  assert.equal(alerts.length, 2, '近距窗外点击恰好 2 条');
  assert.equal(alerts[0].tSec, 22.19, '按距离升序：最近（0.79s）先出');
  assert.equal(alerts[1].tSec, 14.0);
  assert.equal(alerts[1].side, 'before');
  assert.ok(Math.abs(alerts[1].distSec - 1.4) < 1e-9);
  const hit = alerts.find((a) => a.tSec === 22.19);
  assert.ok(hit, '22.19s 事故点击被标记');
  assert.equal(hit.side, 'after');
  assert.ok(Math.abs(hit.distSec - 0.79) < 1e-9, `事故距离 0.79s（实测 ${hit.distSec}）`);
  // 恰在告警半径边界：算告警（≤）
  const edge = offWindowClickAlerts([{tSec: 23.4, x: 0, y: 0, normX: 0, normY: 0}], {startSec: 15.4, endSec: 21.4}, 2);
  assert.equal(edge.length, 1, '边界距离 2.0s 告警（≤口径）');
  ok('offWindowClickAlerts 22.19s 事故复现/前摇/边界');
}

{
  // 窗检查全景：窗内点击/悬停重叠/运动摘要
  const idx = buildTakeIndex('t.mp4', side({
    points: [
      {t: 16000, x: 100, y: 100}, {t: 16300, x: 102, y: 101}, {t: 16600, x: 101, y: 100},
      {t: 16900, x: 100, y: 102}, {t: 17200, x: 500, y: 300},
    ],
    clicks: [{t: 15600, x: 1, y: 1}, {t: 22190, x: 3, y: 3}],
  }), {durationSec: 32, width: 1000, height: 500});
  const c = checkWindow(idx, {file: 't.mp4', startSec: 15.4, endSec: 21.4}, 2);
  assert.equal(c.clicksInside.length, 1);
  assert.equal(c.clicksInside[0].tSec, 15.6);
  assert.equal(c.offWindowAlerts.length, 1);
  assert.equal(c.offWindowAlerts[0].tSec, 22.19);
  assert.equal(c.hoversInWindow.length, 1, '窗内悬停事件（驻留 1.6-1.7s）');
  assert.ok(c.motionAvgPxPerSec >= 0);
  assert.ok(c.motionPeakSec !== null, '窗内有运动桶');
  // 无运动的空窗
  const empty = checkWindow(idx, {file: 't.mp4', startSec: 25, endSec: 28}, 0.5);
  assert.equal(empty.clicksInside.length, 0);
  assert.equal(empty.motionPeakSec, null);
  ok('checkWindow 全景（窗内/告警/悬停/运动摘要）');
}

console.log(`\n共 ${passed} 项全部通过`);
