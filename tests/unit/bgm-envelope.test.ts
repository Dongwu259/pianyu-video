/**
 * BGM 音量包络 + 素材原声 AI 写路径单测（P2.5 音频升级 v1.2）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/bgm-envelope.test.ts
 */
import assert from 'node:assert/strict';
import {bgmVolumeAt, normalizeBgmVolumeKeys, BGM_VOLUME_KEYS_MAX, suggestBgmTrimStartSec} from '../../src/shared/bgm-track.ts';
import {createLlmTools, validateSetBgmArgs} from '../../src/shared/llm-tools.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {
  TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS,
} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== bgmVolumeAt 取值 ======
{
  assert.equal(bgmVolumeAt(undefined, 5), 1, '空包络恒 1（零回归）');
  assert.equal(bgmVolumeAt([], 5), 1);
  assert.equal(bgmVolumeAt([{sec: 0, volume: 0.8}], 10), 0.8, '单点 = 恒值');
  const keys = [
    {sec: 0, volume: 1},
    {sec: 4, volume: 0.3},
    {sec: 12, volume: 1},
  ];
  assert.equal(bgmVolumeAt(keys, -1), 1, '首点前取端值');
  assert.equal(bgmVolumeAt(keys, 0), 1);
  assert.ok(Math.abs(bgmVolumeAt(keys, 2) - 0.65) < 1e-9, '两点中点线性插值');
  assert.ok(Math.abs(bgmVolumeAt(keys, 3) - 0.475) < 1e-9, '1/4 处插值');
  assert.equal(bgmVolumeAt(keys, 20), 1, '末点后取端值');
  assert.equal(bgmVolumeAt(keys, Number.NaN), 1, 'NaN 容错 1');
  assert.equal(bgmVolumeAt([{sec: 2, volume: Number.NaN}], 5), 1, '非法 volume 容错 1');
  ok('bgmVolumeAt：空恒 1 / 端值外推 / 线性插值 / 非法容错');
}
{
  // 单点包络：首点前也取该点值（0 处的单点即全程恒值）
  assert.equal(bgmVolumeAt([{sec: 3, volume: 0.5}], 1), 0.5);
  assert.equal(bgmVolumeAt([{sec: 3, volume: 0.5}], 9), 0.5);
  ok('bgmVolumeAt：首点前取首点值（单点恒值语义）');
}

// ====== normalizeBgmVolumeKeys 清洗 ======
{
  const n = normalizeBgmVolumeKeys(
    [{sec: -3, volume: 2}, {sec: 5.005, volume: 0.4}, {sec: 5, volume: 0.6}, {sec: 'x' as unknown as number, volume: 1}, 42 as unknown as {sec: number}],
    10,
  );
  assert.deepEqual(n, [{sec: 0, volume: 1}, {sec: 5.005, volume: 0.4}], JSON.stringify(n));
  assert.equal(normalizeBgmVolumeKeys([], 10), undefined, '空数组 → undefined（剥离字段语义）');
  assert.equal(normalizeBgmVolumeKeys(undefined, 10), undefined);
  const long = Array.from({length: BGM_VOLUME_KEYS_MAX + 10}, (_, i) => ({sec: i, volume: 0.5}));
  assert.equal(normalizeBgmVolumeKeys(long, 100)!.length, BGM_VOLUME_KEYS_MAX, '超上限截断');
  ok('normalizeBgmVolumeKeys：钳制/排序/同位去重/垃圾点丢弃/上限截断');
}

// ====== set_bgm volumeKeys 校验 ======
{
  const r = validateSetBgmArgs({volumeKeys: [{sec: 0, volume: 1}, {sec: 4, volume: 0.3}, {sec: 12, volume: 1}]});
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.args.volumeKeys!.length, 3);
    assert.equal(r.args.volumeKeys![1].volume, 0.3);
  }
  const clear = validateSetBgmArgs({volumeKeys: []});
  assert.ok(clear.ok && clear.args.volumeKeys !== undefined && clear.args.volumeKeys.length === 0, '空数组 = 清除语义透传');
  const bad = validateSetBgmArgs({volumeKeys: 'loud'});
  assert.ok(!bad.ok, '非数组拒绝');
  const garbage = validateSetBgmArgs({volumeKeys: [{sec: 'a', volume: 1}, {nope: true}]});
  assert.ok(!garbage.ok, '全非法点拒绝');
  const partial = validateSetBgmArgs({volumeKeys: [{sec: 1, volume: 9}, {sec: 'z', volume: 1}]});
  assert.ok(partial.ok, '部分合法点通过（非法点丢弃+附注）');
  if (partial.ok) {
    assert.equal(partial.args.volumeKeys!.length, 1);
    assert.equal(partial.args.volumeKeys![0].volume, 1, 'volume 9 钳到 1');
    assert.ok((partial.args.volumeKeysNotes ?? []).length > 0, '丢弃附注回告');
  }
  ok('set_bgm volumeKeys：合法/清除/拒绝/部分丢弃附注');
}

// ====== update_segment patch muted/volume 校验 ======
const {validateSegmentPatch} = createLlmTools({
  templates: TEMPLATES,
  transitions: TRANSITION_OPTIONS.map((t) => t.value),
  videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
  backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
  textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
});
{
  const r = validateSegmentPatch({templateId: 'KenBurns', muted: true, volume: 0.3}, 0);
  assert.ok(r.ok, JSON.stringify((r as {errors?: string[]}).errors));
  if (r.ok) {
    assert.equal(r.patch.muted, true);
    assert.equal(r.patch.volume, 0.3);
  }
  ok('patch：muted/volume 合法透传');
}
{
  const r = validateSegmentPatch({templateId: 'KenBurns', volume: 1.7}, 0);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.patch.volume, 1, '越界钳到 1');
    assert.ok(r.notes.some((n) => n.includes('钳制')), '钳制告警回告');
  }
  const bad = validateSegmentPatch({templateId: 'KenBurns', muted: 'yes' as unknown as boolean}, 0);
  assert.ok(bad.ok);
  if (bad.ok) assert.equal(bad.patch.muted, undefined, '非布尔忽略');
  ok('patch：volume 越界钳制+告警 / muted 非布尔忽略');
}
{
  // 只传 muted 不传 volume：volume 保持 undefined（applyAiSegmentPatch 只动给出的键）
  const r = validateSegmentPatch({templateId: 'KenBurns', muted: false}, 0);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.patch.muted, false);
    assert.equal(r.patch.volume, undefined);
  }
  ok('patch：muted/volume 相互独立');
}

// ====== suggestBgmTrimStartSec（J-cut 掐前奏默认） ======
{
  // 构造：60s 曲，前 5s 低能量（0.05）、之后主体（0.6~1.0），每秒 10 个峰值点
  const peaks: number[] = [];
  for (let s = 0; s < 60; s++) {
    const level = s < 5 ? 0.05 : 0.6 + 0.4 * ((s * 7) % 10) / 10;
    for (let k = 0; k < 10; k++) peaks.push(level);
  }
  const trim = suggestBgmTrimStartSec(peaks, 60);
  assert.ok(trim >= 3.5 && trim <= 5.5, `进点应在能量跳升处 5s 附近，got ${trim}`);
  assert.ok(suggestBgmTrimStartSec(undefined, 60) === 0, '无 peaks 不掐');
  assert.ok(suggestBgmTrimStartSec(peaks.slice(0, 20), 2) === 0, '太短不掐');
  // 全程同能量（无前奏）→ 首窗即达标 → sec≈0 → <1.5s 不掐 → 0
  const flat = new Array(600).fill(0.7);
  assert.equal(suggestBgmTrimStartSec(flat, 60), 0, '无前奏不掐');
  // 留足循环窗：前奏极长（40s/60s）→ 钳到 duration-8=52？不——钳 min(sec, 52)，sec=40 → 40，窗 20s ✓
  const long: number[] = [];
  for (let s = 0; s < 60; s++) {
    const level = s < 40 ? 0.05 : 0.8;
    for (let k = 0; k < 10; k++) long.push(level);
  }
  assert.ok(suggestBgmTrimStartSec(long, 60) >= 38, '长前奏按进点掐（留 >8s 循环窗）');
  ok('suggestBgmTrimStartSec：能量进点/无前奏不掐/短曲不掐/长前奏留窗');
}

console.log(`\n${passed} 项通过`);
