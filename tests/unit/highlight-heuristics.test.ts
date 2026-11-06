/**
 * 高光启发式排序单测：加权打分 / 信号区分 / 相邻合并 / top-N 截断 / 挖段落地数学。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/highlight-heuristics.test.ts
 */

import assert from 'node:assert/strict';
import {
  audioEnergyIn,
  durationFitOf,
  exposureScoreOf,
  personLikelihoodOf,
  rankHighlightCandidates,
  type ShotLike,
} from '../../src/shared/highlight-heuristics';
import {keepRangesToTrim} from '../../src/shared/highlight-mining';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('highlight-heuristics（高光候选启发式排序）');

const shot = (startSec: number, endSec: number, motionScore: number): ShotLike => ({startSec, endSec, motionScore});

t('高运动镜头排在低运动前（同曝光/音轨条件下）', () => {
  const shots = [
    shot(0, 5, 0.1), shot(5, 10, 0.9), shot(10, 15, 0.2), shot(15, 20, 0.7),
  ];
  const out = rankHighlightCandidates({shots, audioPeaks: [], shotLuma: shots.map(() => ({p5: 30, p50: 128, p95: 220}))}, 4);
  assert.equal(out[0].startSec, 5, '首候选应是运动最强的 5-10s 段');
  assert.ok(out[0].score > out[out.length - 1].score, '分数应降序');
});

t('音轨能量参与排序（安静段让位给活跃段）', () => {
  const shots = [shot(0, 5, 0.5), shot(6.5, 11.5, 0.5)]; // 间隙 1.5s > 0.8s 防相邻合并
  // 峰值桶集中在第二段（时长 ~11.5s，240 桶：前半静音后半满格）
  const peaks = Array.from({length: 240}, (_, i) => (i >= 120 && i < 240 ? 0.9 : 0.02));
  const out = rankHighlightCandidates({shots, audioPeaks: peaks, shotLuma: [{p5: 30, p50: 128, p95: 220}, {p5: 30, p50: 128, p95: 220}]}, 2);
  assert.equal(out[0].startSec, 6.5, '音轨活跃段应排前');
  assert.ok(out[0].audio > out[1].audio, `audio 分项应区分（${out[0].audio} vs ${out[1].audio}）`);
  assert.ok(out[0].reasons.some((r) => r.includes('音轨')), '理由应含音轨信号');
});

t('曝光质量：死黑/过曝/灰片减分，中间调满分档', () => {
  assert.ok(exposureScoreOf({p5: 30, p50: 120, p95: 210}) >= 0.9, '中间调应近满分');
  assert.ok(exposureScoreOf({p5: 0, p50: 10, p95: 40}) < 0.4, '死黑应显著减分');
  assert.ok(exposureScoreOf({p5: 230, p50: 245, p95: 255}) < 0.4, '过曝应显著减分');
  assert.ok(exposureScoreOf({p5: 100, p50: 128, p95: 130}) < 0.8, '灰片（低反差）应减分');
  assert.equal(exposureScoreOf(undefined), 0.6, '无直方图给中性分不惩罚');
});

t('时长适配：3-15s 满分，两端衰减', () => {
  assert.equal(durationFitOf(8), 1);
  assert.equal(durationFitOf(2), 0.5);
  assert.equal(durationFitOf(0.5), 0);
  assert.equal(durationFitOf(35), 0);
});

t('人物概率：肤色占比映射 + 中心聚集加权 + 无数据不惩罚', () => {
  // 无肤色统计 → 0（旧调用方兼容，不惩罚不加分）
  assert.equal(personLikelihoodOf(undefined), 0);
  assert.equal(personLikelihoodOf({p5: 30, p50: 128, p95: 220}), 0);
  // 人物特写量级（15% 肤色）→ 满概率；空镜（0.5%）→ 近零
  assert.ok(personLikelihoodOf({p5: 30, p50: 128, p95: 220, skinRatio: 0.15}) > 0.85, '15% 肤色应近满概率');
  assert.ok(personLikelihoodOf({p5: 30, p50: 128, p95: 220, skinRatio: 0.005}) < 0.1, '0.5% 肤色应近零');
  // 中心聚集加成：同肤色占比，肤色集中在中心 > 均匀分布
  const centered = personLikelihoodOf({p5: 30, p50: 128, p95: 220, skinRatio: 0.06, centerSkinRatio: 0.2});
  const spread = personLikelihoodOf({p5: 30, p50: 128, p95: 220, skinRatio: 0.06, centerSkinRatio: 0.02});
  assert.ok(centered > spread, `中心聚集应加成（${centered} vs ${spread}）`);
  assert.ok(centered <= 1 && spread >= 0);
});

t('人物概率参与排序：同运动/音轨下人物镜头排前（权重 0.15 生效）', () => {
  const shots = [shot(0, 6, 0.5), shot(7.5, 13.5, 0.5)];
  const luma = [
    {p5: 30, p50: 128, p95: 220, skinRatio: 0.003},        // 空镜
    {p5: 30, p50: 128, p95: 220, skinRatio: 0.14, centerSkinRatio: 0.24}, // 人物特写
  ];
  const out = rankHighlightCandidates({shots, audioPeaks: [], shotLuma: luma}, 2);
  assert.equal(out[0].startSec, 7.5, '人物镜头应排前');
  assert.ok(out[0].person > 0.5 && out[1].person < 0.1, `person 分项应区分（${out[0].person} vs ${out[1].person}）`);
  assert.ok(out[0].reasons.some((r) => r.includes('疑似人物')), '理由应含人物概率标注');
});

t('相邻高能镜头合并为完整候选（间隙 <0.8s 且双过基线）', () => {
  // 3 个 3s 高运动镜头紧挨 → 合并成一个 9s 候选
  const shots = [shot(0, 3, 0.8), shot(3.1, 6, 0.75), shot(6.2, 9.2, 0.7)];
  const out = rankHighlightCandidates({shots, audioPeaks: [], shotLuma: shots.map(() => ({p5: 30, p50: 128, p95: 220}))}, 5);
  assert.ok(out.length < 3, `相邻高能镜头应合并（得 ${out.length} 候选）`);
  assert.ok(Math.abs(out[0].endSec - 9.2) < 0.01, `合并候选应覆盖到 9.2s（得 ${out[0].endSec}）`);
});

t('top-N 截断 + 空输入安全', () => {
  const shots = Array.from({length: 10}, (_, i) => shot(i * 4, i * 4 + 4, 0.5));
  const out = rankHighlightCandidates({shots}, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(rankHighlightCandidates({shots: []}, 5), []);
});

t('audioEnergyIn 桶映射（区间均值）', () => {
  const peaks = [0, 0, 1, 1]; // 4 桶 4s 素材
  assert.ok(Math.abs(audioEnergyIn(peaks, 2, 4, 4) - 1) < 1e-9, '后半段均值应 1');
  assert.ok(Math.abs(audioEnergyIn(peaks, 0, 2, 4) - 0) < 1e-9, '前半段均值应 0');
  assert.equal(audioEnergyIn(undefined, 0, 1, 1), 0, '无音轨安全返回 0');
  assert.equal(audioEnergyIn([], 0, 1, 1), 0);
});

t('面板挖段落地数学：多选区间 → keepRangesToTrim（与 apply_cut_list 同口径）', () => {
  // store.applyHighlightPick 多选时用区间外挖洞（cuts），等价 keepRangesToTrim：
  // 选中 5-8 与 12-15 → trim [5,15] + cut [8,12]
  const r = keepRangesToTrim([
    {start: 5, end: 8},
    {start: 12, end: 15},
  ]);
  assert.equal(r.trimStart, 5);
  assert.equal(r.trimEnd, 15);
  assert.equal(r.cuts.length, 1);
  assert.deepEqual(r.cuts[0], {start: 8, end: 12});
});
