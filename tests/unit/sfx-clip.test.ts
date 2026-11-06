/**
 * 手放音效（SfxClip）纯函数单测：钳制 / 确定性变体 / 车道分配（时间轴 v4）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/sfx-clip.test.ts
 */
import assert from 'node:assert/strict';
import {
  clampSfxClipAtSec, clampSfxClipVolume, sfxClipVariant, assignSfxClipLanes, SFX_CLIP_VISUAL_SEC,
  SFX_KIND_GAIN, SFX_KIND_META,
} from '../../src/shared/sfx-plan.ts';
import type {SfxClip} from '../../src/shared/types.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

console.log('sfx-clip：钳制');

t('atSec 钳制到 [0, 片长-0.1] 且 0.1 步进', () => {
  assert.equal(clampSfxClipAtSec(-3, 30), 0);
  assert.equal(clampSfxClipAtSec(99, 30), 29.9);
  assert.equal(clampSfxClipAtSec(12.345, 30), 12.3);
  assert.equal(clampSfxClipAtSec(0.05, 30), 0.1);
});

t('atSec 片长极短（<0.1）时上界钳到 0', () => {
  assert.equal(clampSfxClipAtSec(0.5, 0.05), 0);
  assert.equal(clampSfxClipAtSec(1, 0), 0);
});

t('音量钳制 0..1', () => {
  assert.equal(clampSfxClipVolume(1.5), 1);
  assert.equal(clampSfxClipVolume(-0.2), 0);
  assert.equal(clampSfxClipVolume(0.65), 0.65);
});

console.log('sfx-clip：确定性变体');

t('同一 id 每次同一变体（导出可复现）', () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(sfxClipVariant('sfxclip-abc', 6), sfxClipVariant('sfxclip-abc', 6));
  }
});

t('不同 id 尽量分散；variantCount ≤1 恒 0；非法计数兜底 0', () => {
  assert.equal(sfxClipVariant('x', 0), 0);
  assert.equal(sfxClipVariant('x', 1), 0);
  assert.equal(sfxClipVariant('x', Number.NaN), 0);
  const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => sfxClipVariant(id, 3)));
  assert.ok(picks.size >= 2, `8 个 id 在 3 个变体上应至少覆盖 2 个（实际 ${picks.size}）`);
  for (const p of picks) assert.ok(p >= 0 && p < 3);
});

t('变体落在 [0, variantCount)', () => {
  for (let n = 2; n <= 12; n++) {
    for (const id of ['a', 'sfxclip-k2j3h4', 'zzz-9']) {
      const v = sfxClipVariant(id, n);
      assert.ok(v >= 0 && v < n, `${id}@${n} → ${v} 越界`);
    }
  }
});

console.log('sfx-clip：车道分配');

const clip = (id: string, atSec: number): SfxClip => ({id, kind: 'whoosh', atSec, volume: 1});

t('空列表 → 0 车道', () => {
  assert.deepEqual(assignSfxClipLanes([]), {lanes: [], laneCount: 0});
});

t('时间不重叠的 clip 全部 0 车道', () => {
  const r = assignSfxClipLanes([clip('a', 0), clip('b', 2), clip('c', 10)]);
  assert.deepEqual(r.lanes, [0, 0, 0]);
  assert.equal(r.laneCount, 1);
});

t('重叠的 clip 上下错开（多轨叠加视图）', () => {
  // 块宽 0.8s：a@0 占 [0,0.8)，b@0.3 重叠 → 车道 1；c@0.85 不与 a 重叠但与 b 重叠 → 车道 2? 
  // b 占 [0.3,1.1)，c@0.85 与 b 重叠、与 a 不重叠 → 首适配回到车道 0
  const r = assignSfxClipLanes([clip('a', 0), clip('b', 0.3), clip('c', 0.85)]);
  assert.equal(r.laneCount, 2);
  assert.equal(r.lanes[0], 0);
  assert.equal(r.lanes[1], 1);
  assert.equal(r.lanes[2], 0);
});

t('同一时刻 N 个 clip → N 车道（lanes 与输入下标同序）', () => {
  const r = assignSfxClipLanes([clip('a', 5), clip('b', 5), clip('c', 5)]);
  assert.equal(r.laneCount, 3);
  assert.deepEqual([...r.lanes].sort(), [0, 1, 2]);
});

t('重叠链按排序贪心（乱序输入逐 clip 稳定；不叠的回收车道）', () => {
  const in1 = [clip('a', 1), clip('b', 0), clip('c', 0.5)];
  const in2 = [clip('c', 0.5), clip('a', 1), clip('b', 0)];
  const r1 = assignSfxClipLanes(in1);
  const r2 = assignSfxClipLanes(in2);
  // b[0,0.8) 与 c[0.5,1.3) 叠、c 与 a[1,1.8) 叠，但 b 与 a 不叠 → a 回收车道 0
  assert.equal(r1.laneCount, 2);
  assert.equal(r2.laneCount, 2);
  // lanes 按输入下标序：换序后逐 clip 的车道号应一致
  const laneOf = (input: typeof in1, lanes: number[]) =>
    Object.fromEntries(input.map((c, i) => [c.id, lanes[i]]));
  assert.deepEqual(laneOf(in1, r1.lanes), laneOf(in2, r2.lanes));
  assert.deepEqual([...r1.lanes].sort(), [0, 0, 1]);
});

t('块宽 = SFX_CLIP_VISUAL_SEC（UI 与分配同口径）', () => {
  // 间距恰好 = 视觉宽 → 不重叠（start >= end 判定）
  const r = assignSfxClipLanes([clip('a', 0), clip('b', SFX_CLIP_VISUAL_SEC)]);
  assert.equal(r.laneCount, 1);
  const r2 = assignSfxClipLanes([clip('a', 0), clip('b', SFX_CLIP_VISUAL_SEC - 0.01)]);
  assert.equal(r2.laneCount, 2);
});

t('SFX_KIND_GAIN：七类齐全、(0,1] 区间、与渲染混音同源（v5 试听口径）', () => {
  const kinds = Object.keys(SFX_KIND_META);
  assert.equal(Object.keys(SFX_KIND_GAIN).length, kinds.length);
  for (const k of kinds) {
    const g = SFX_KIND_GAIN[k as keyof typeof SFX_KIND_GAIN];
    assert.ok(g > 0 && g <= 1, `${k} 增益 ${g} 应在 (0,1]`);
  }
  // 弱拍轻点最轻（律动用）；铺底类压低、重类给足
  assert.ok(SFX_KIND_GAIN.click < SFX_KIND_GAIN.impact);
  assert.ok(SFX_KIND_GAIN.riser < SFX_KIND_GAIN.drop);
});

console.log(`\nsfx-clip: ${passed} 组断言通过`);
if (process.exitCode) process.exit(1);
