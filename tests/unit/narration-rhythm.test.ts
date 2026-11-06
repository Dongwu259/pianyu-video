/**
 * narration-rhythm.ts 单测：旁白驱动的节奏规划（卡点自动化）
 * 向上吸附格口径 / 字数估测标定 / 规划只拉长不压缩 / 规划输出对 snapDurationsToBeats 零移动。
 */
import assert from 'node:assert/strict';
import {
  upSnapSec, estimateNarrationSec, planNarrationRhythm,
  type RhythmLineTiming,
} from '../../src/shared/narration-rhythm.ts';
import {snapDurationsToBeats} from '../../src/shared/beat-align.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  // upSnapSec：向上吸附到最小节拍；已在格上=原值；超格回退 d+0.1
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  assert.equal(upSnapSec(0.9, beats), 1);
  assert.equal(upSnapSec(1.0, beats), 1);
  assert.equal(upSnapSec(1.01, beats), 1.5);
  assert.equal(upSnapSec(0, beats), 0);
  assert.equal(upSnapSec(5, beats), 5.1, '超格回退 d+0.1');
  ok('upSnapSec 向上吸附/在格保持/超格回退');
}
{
  // 估测：v11 标定句实测对照（lsq dur=0.660+0.1808×字）
  // 「你说需求，它自己跑完全程」12字 实测 2.95s；「本地模型、离线出片、一键成片」类长句
  assert.ok(Math.abs(estimateNarrationSec('你说需求，它自己跑完全程') - 2.83) < 0.01);
  assert.ok(estimateNarrationSec('短') >= 1.2, '下限 1.2s');
  const est = estimateNarrationSec('一句话，开工'); // 6字（含标点）→ 0.66+1.0848≈1.74（v11 同量级实测 1.78）
  assert.ok(Math.abs(est - 1.74) < 0.01);
  ok('estimateNarrationSec 标定常数与下限');
}
{
  // 规划：句短于板长=不动；句长超板长=向上拉长到 ≥句长+0.4 的整拍
  const beats = Array.from({length: 40}, (_, k) => k * 0.5);
  const t = (seg: number, durSec: number, measured = true): RhythmLineTiming => ({file: `nar-${seg}.mp3`, seg, durSec, measured});
  const plan = planNarrationRhythm({
    boardDurations: [4.0, 6.0, 5.5],
    timing: [t(0, 2.4), t(1, 6.1), t(2, 3.0)],
    beats,
  });
  assert.equal(plan.durations[0], 4.0, '2.4+0.4=2.8 < 4.0 → 板长不动');
  assert.equal(plan.durations[1], 6.5, '6.1+0.4=6.5，max(6.0,6.5)=6.5 已在格上 → 6.5');
  assert.equal(plan.durations[2], 5.5, '3.0+0.4=3.4 < 5.5 → 不动');
  assert.equal(plan.raised.length, 1);
  assert.equal(plan.raised[0].seg, 1);
  assert.equal(plan.estimated.length, 0);
  ok('规划只拉长不压缩，下限=句长+0.4 向上整拍');
}
{
  // 混合实测/估测 + 多句同段告警
  const beats = Array.from({length: 40}, (_, k) => k * 0.5);
  const plan = planNarrationRhythm({
    boardDurations: [3.0, 4.0],
    timing: [
      {file: 'a.mp3', seg: 0, durSec: 2.0, measured: false},
      {file: 'b.mp3', seg: 1, durSec: 1.0, measured: true},
      {file: 'c.mp3', seg: 1, durSec: 1.5, measured: true},
    ],
    beats,
  });
  assert.equal(plan.estimated.length, 1);
  assert.equal(plan.estimated[0].file, 'a.mp3');
  assert.equal(plan.durations[1], 4.0, 'Σ1.0+1.5+0.8=3.3 < 4.0 → 不动');
  assert.equal(plan.warnings.length, 1, '同段多句告警');
  ok('估测归集与多句同段告警');
}
{
  // 关键闭环：规划输出全在格上 ⇒ snapDurationsToBeats 零移动（压拍语义不被规划破坏）
  const beats = Array.from({length: 200}, (_, k) => k * 0.5);
  const board = [4.0, 6.0, 12.5, 5.5, 4.5];
  const timing = [t0(0, 3.8), t0(1, 6.2), t0(2, 9.9), t0(3, 2.0), t0(4, 4.4)];
  function t0(seg: number, durSec: number): RhythmLineTiming {
    return {file: `nar-${seg}.mp3`, seg, durSec, measured: true};
  }
  const plan = planNarrationRhythm({boardDurations: board, timing, beats});
  const snap = snapDurationsToBeats(plan.durations, beats, {min: 0.5, max: 60, tolerance: 0.6});
  assert.ok(snap, '吸附成功');
  assert.equal(snap.movedCount, 0, `规划后段长应全在格上（实际 ${plan.durations.join('/')}）`);
  assert.deepEqual(snap.durations, plan.durations);
  // 断言口径：每句旁白 ≤ 规划段长 - 0.4（mixNarration 同款）
  timing.forEach((t) => assert.ok(t.durSec <= plan.durations[t.seg] - 0.4 - 1e-9));
  ok('规划输出对卡点吸附零移动 + 断言口径自洽');
}
console.log(`\n narration-rhythm: ${passed} 组全过`);
