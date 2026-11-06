/**
 * edit-brain 单测：卡点切镜计划的槽位密度、选镜匹配、切点压拍、素材轮换
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/edit-brain.test.ts
 */
import assert from 'node:assert/strict';
import {planBeatMontage, findMoneyShot} from '../../src/shared/edit-brain.ts';
import type {MusicMap} from '../../src/shared/music-map.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

/** 合成音乐图：120BPM（0.5s/拍），0-8s intro、8-24s drop、24-32s break、32-48s drop */
const music = (): MusicMap => {
  const beats: number[] = [];
  for (let i = 0; i < 96; i++) beats.push(i * 0.5);
  return {
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    barSec: 2,
    beatEnergies: beats.map((b) => (b < 8 ? 0.2 : b < 24 ? 0.9 : b < 32 ? 0.3 : 0.85)),
    sections: [
      {startSec: 0, endSec: 8, energy: 0.2, label: 'intro'},
      {startSec: 8, endSec: 24, energy: 0.9, label: 'drop'},
      {startSec: 24, endSec: 32, energy: 0.3, label: 'break'},
      {startSec: 32, endSec: 48, energy: 0.85, label: 'drop'},
    ],
    durationSec: 48,
  };
};

/** 三个素材：A 高运动（0.85）、B 中（0.5）、C 低（0.15），各 3 个 4s 镜头 */
const sources = () => [
  {source: 'A', shots: [0, 1, 2].map((i) => ({startSec: i * 4, endSec: i * 4 + 4, motionScore: 0.85}))},
  {source: 'B', shots: [0, 1, 2].map((i) => ({startSec: i * 4, endSec: i * 4 + 4, motionScore: 0.5}))},
  {source: 'C', shots: [0, 1, 2].map((i) => ({startSec: i * 4, endSec: i * 4 + 4, motionScore: 0.15}))},
];

console.log('edit-brain:');

t('切点全部压拍且 clip 时长为拍整数倍', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 24});
  assert.ok(d.clips.length > 0);
  let t = 0;
  for (const c of d.clips) {
    assert.ok(Math.abs(c.durationSec / 0.5 - Math.round(c.durationSec / 0.5)) < 1e-6, `clip ${c.durationSec}s 非拍整数倍`);
    t += c.durationSec;
    // 成片切点在节拍网格上
    const onBeat = Math.abs(t / 0.5 - Math.round(t / 0.5)) < 1e-6;
    assert.ok(onBeat, `切点 ${t}s 不压拍`);
  }
  assert.ok(Math.abs(t - d.totalSec) < 1e-6);
});

t('槽位密度：drop 段切镜明显密于 intro/outro', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 40});
  const dropClips = d.clips.filter((c) => c.section === 'drop');
  const introClips = d.clips.filter((c) => c.section === 'intro' || c.section === 'outro');
  const avg = (arr: typeof dropClips) => arr.reduce((a, c) => a + c.durationSec, 0) / Math.max(1, arr.length);
  assert.ok(avg(dropClips) < avg(introClips), `drop 均长 ${avg(dropClips)} 应小于 intro/outro 均长 ${avg(introClips)}`);
  assert.ok(avg(dropClips) <= 1.01, `drop 应一拍一刀（0.5s），实际 ${avg(dropClips)}`);
});

t('选镜匹配：高能量段落选高运动素材，低能量段落选低运动素材', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 40});
  const dropClips = d.clips.filter((c) => c.section === 'drop');
  const calmClips = d.clips.filter((c) => c.section === 'intro' || c.section === 'break');
  const dropA = dropClips.filter((c) => c.source === 'A').length;
  const calmC = calmClips.filter((c) => c.source === 'C').length;
  assert.ok(dropA >= dropClips.length * 0.5, `drop 段应主要用 A（高运动）：${dropA}/${dropClips.length}`);
  assert.ok(calmC >= 1, '安静段应至少用一次 C（低运动）');
});

t('素材轮换：不连续三次用同一素材（池未枯竭时）', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 40});
  let run = 1;
  for (let i = 1; i < d.clips.length; i++) {
    if (d.clips[i].source === d.clips[i - 1].source) {
      run++;
      assert.ok(run < 3, `素材 ${d.clips[i].source} 连出 ${run} 次`);
    } else {
      run = 1;
    }
  }
});

t('目标时长：计划总时长不超过 targetSec + 1 拍', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 20});
  assert.ok(d.totalSec <= 20 + 0.5, `totalSec=${d.totalSec}`);
});

t('短镜头被淘汰：不足 1 拍的镜头不进计划', () => {
  const short = [{source: 'S', shots: [{startSec: 0, endSec: 0.3, motionScore: 0.9}]}];
  const d = planBeatMontage(music(), short, {targetSec: 10});
  assert.equal(d.clips.length, 0);
});

t('同镜复用重罚：优先轮换到不同镜头，同镜被迫复用时窗口后错', () => {
  // 单素材单镜头（8s）：21 个槽位注定复用——窗口必须错开且不超镜头尾
  const single = [{source: 'S', shots: [{startSec: 0, endSec: 8, motionScore: 0.6}]}];
  const d = planBeatMontage(music(), single, {targetSec: 10});
  assert.ok(d.clips.length >= 3);
  const starts = d.clips.map((c) => c.startSec);
  assert.ok(new Set(starts).size > 1, `复用窗口应错开: ${starts}`);
  for (const c of d.clips) assert.ok(c.endSec <= 8 + 1e-9, `窗口出界 ${c.endSec}`);
  // 三素材九镜头：每个镜头最多用一次（池未枯竭）
  const d2 = planBeatMontage(music(), sources(), {targetSec: 20});
  const key = d2.clips.map((c) => `${c.source}@${c.startSec}`);
  assert.equal(new Set(key).size, key.length, `有重复镜头窗口: ${key}`);
});

t('退化：无节拍/无素材返回空计划不崩', () => {
  const m = music();
  m.beats = [];
  assert.equal(planBeatMontage(m, sources(), {}).clips.length, 0);
  assert.equal(planBeatMontage(music(), [], {}).clips.length, 0);
});

t('A 槽位不跨段：段落边界处强制收刀，drop 第一拍必落剪点', () => {
  // intro 0-3s（6 拍）、drop 3-12s：intro 槽 4 拍，t=2s 时下一槽 2-4s 会跨段 → 收成 2-3s
  const m = music();
  m.sections = [
    {startSec: 0, endSec: 3, energy: 0.2, label: 'intro'},
    {startSec: 3, endSec: 12, energy: 0.9, label: 'drop'},
  ];
  m.durationSec = 12;
  const d = planBeatMontage(m, sources(), {targetSec: 12});
  assert.ok(d.clips.length > 0);
  // 3s 处必有剪点，且跨段两侧 clip 分别以 3s 为尾/头
  const before = d.clips.filter((c) => c.section === 'intro');
  const after = d.clips.filter((c) => c.section === 'drop');
  assert.ok(before.length > 0 && after.length > 0);
  let t0 = 0;
  const boundaries = d.clips.map((c) => { t0 += c.durationSec; return t0; });
  assert.ok(boundaries.some((b) => Math.abs(b - 3) < 1e-6), `3s 处无剪点: ${boundaries}`);
});

t('B 取窗对齐能量峰：首用窗口覆盖镜头能量峰（峰值落窗内 40% 处）', () => {
  // 单素材单镜头 0-8s，能量峰在 5s；fps=6
  const energies = new Array(48).fill(0.1);
  energies[29] = 1; // (29+1)/6 = 5s
  const src = [{source: 'S', shots: [{startSec: 0, endSec: 8, motionScore: 0.6}], energies, sampleFps: 6}];
  const m = music();
  m.sections = [{startSec: 0, endSec: 4, energy: 0.9, label: 'drop'}];
  m.durationSec = 4;
  const d = planBeatMontage(m, src, {targetSec: 4});
  assert.ok(d.clips.length > 0);
  const first = d.clips[0];
  // drop 槽 1 拍=0.5s，峰 5s → 窗口起点应 ≈ 5-0.4*0.5 = 4.8s
  assert.ok(Math.abs(first.startSec - 4.8) < 0.26, `首窗起点 ${first.startSec} 未对齐峰 5s`);
  assert.ok(first.startSec <= 5 && first.endSec >= 5, '峰不在窗内');
});

// ===== 创意层（LLM 创意指令）=====

t('C1 钉开篇镜：第一个槽位强制用指定镜头（无视运动匹配）', () => {
  // intro 能量 0.2 本来也会选 C，但把开篇钉成 A#1（高运动）验证「无视 cost」
  const d = planBeatMontage(music(), sources(), {targetSec: 24, directives: {openingShot: {source: 'A', shot: 1}}});
  assert.ok(d.clips.length > 0);
  assert.equal(d.clips[0].source, 'A');
  // A#1 镜头区间 4-8s，无能量曲线 → 窗口从镜头起点取
  assert.ok(Math.abs(d.clips[0].startSec - 4) < 1e-6, `开篇镜起点 ${d.clips[0].startSec}`);
  assert.ok(d.notes.some((n) => n.includes('开篇') && n.includes('A#1')), `notes 缺钉镜记录: ${d.notes}`);
});

t('C2 钉首 drop 高光镜：第一个 drop 槽位用指定镜头，且只生效一次', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 40, directives: {firstDropShot: {source: 'B', shot: 2}}});
  const firstDrop = d.clips.find((c) => c.section === 'drop');
  assert.ok(firstDrop, '无 drop 镜');
  assert.equal(firstDrop.source, 'B');
  // B#2 镜头区间 8-12s
  assert.ok(firstDrop.startSec >= 8 - 1e-6 && firstDrop.startSec < 12, `首 drop 镜起点 ${firstDrop.startSec} 不在 B#2 区间`);
  // 只钉一次：后续 drop 镜恢复自动选镜（高能量段应回到 A）
  const laterDrops = d.clips.filter((c) => c.section === 'drop').slice(1);
  assert.ok(laterDrops.some((c) => c.source === 'A'), '后续 drop 应恢复自动选高运动素材');
});

t('C3 钉收尾镜：最后一个槽位用指定镜头', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 24, directives: {closingShot: {source: 'C', shot: 0}}});
  const last = d.clips[d.clips.length - 1];
  assert.equal(last.source, 'C');
  assert.ok(last.startSec >= 0 && last.startSec < 4, `收尾镜起点 ${last.startSec} 不在 C#0 区间`);
});

t('C4 禁镜：被禁镜头不进计划', () => {
  const d = planBeatMontage(music(), sources(), {
    targetSec: 40,
    directives: {excludeShots: [{source: 'A', shot: 0}, {source: 'A', shot: 1}, {source: 'A', shot: 2}]},
  });
  assert.ok(d.clips.length > 0);
  assert.ok(d.clips.every((c) => c.source !== 'A'), `禁镜后仍用到 A: ${d.clips.map((c) => c.source)}`);
});

t('C5 钉镜无效回退：找不到的镜头按自动选镜且记 notes，不崩', () => {
  const d = planBeatMontage(music(), sources(), {targetSec: 20, directives: {openingShot: {source: 'Z', shot: 9}}});
  assert.ok(d.clips.length > 0);
  assert.ok(d.notes.some((n) => n.includes('无效')), `notes 缺回退记录: ${d.notes}`);
  // 被禁的钉镜同样回退
  const d2 = planBeatMontage(music(), sources(), {
    targetSec: 20,
    directives: {openingShot: {source: 'A', shot: 0}, excludeShots: [{source: 'A', shot: 0}]},
  });
  assert.ok(d2.clips.length > 0);
  assert.ok(d2.notes.some((n) => n.includes('无效')), `禁镜钉镜应回退: ${d2.notes}`);
});

t('C6 findMoneyShot：选出全场能量峰最高的镜头', () => {
  const e1 = new Array(60).fill(0.1);
  e1[10] = 0.5;
  const e2 = new Array(60).fill(0.1);
  e2[40] = 1.0;
  const src = [
    {source: 'S1', shots: [{startSec: 0, endSec: 10, motionScore: 0.3}], energies: e1, sampleFps: 6},
    {source: 'S2', shots: [{startSec: 0, endSec: 5, motionScore: 0.5}, {startSec: 5, endSec: 10, motionScore: 0.8}], energies: e2, sampleFps: 6},
  ];
  const m = findMoneyShot(src);
  assert.ok(m);
  assert.equal(m.source, 'S2');
  assert.equal(m.shot, 1); // 峰 40/6≈6.8s 落在 S2 的第二个镜头（5-10s）
});

t('C7 无指令时行为不变：notes 为空且结果与纯确定性版一致', () => {
  const a = planBeatMontage(music(), sources(), {targetSec: 30});
  const b = planBeatMontage(music(), sources(), {targetSec: 30, directives: {}});
  assert.deepEqual(a.clips, b.clips);
  assert.equal(a.notes.length, 0);
});

console.log(`\n===== ${passed} 项全部通过 =====`);
