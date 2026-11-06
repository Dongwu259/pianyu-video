/**
 * 蒙太奇卡点切分计划（shared/montage-plan.ts）单元测试：
 * 等长切分与收尾 / 多素材轮转与区间消耗 / 素材循环 / 甩切标记 / 确定性与兜底。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/montage-plan.test.ts
 */

import assert from 'node:assert/strict';

const {planMontageCuts} = await import('../../src/shared/montage-plan.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ok ${name}`);
};

// 1. 等长切分与收尾：8s / 1.8s → 5 切（最后一切 0.8s）
{
  const cuts = planMontageCuts({durations: [30], totalSec: 8, cutSec: 1.8, whipEvery: 0});
  assert.equal(cuts.length, 5, `应 5 切，实际 ${cuts.length}`);
  assert.deepEqual(cuts.map((c) => c.durationSec).map(Math.round), [2, 2, 2, 2, 1]);
  const total = cuts.reduce((n, c) => n + c.durationSec, 0);
  assert.ok(Math.abs(total - 8) < 0.01, `总时长 ${total} 应 = 8`);
  ok('等长切分与收尾');
}

// 2. 多素材轮转：3 素材轮转，mediaStart 依次推进
{
  const cuts = planMontageCuts({durations: [10, 10, 10], totalSec: 9, cutSec: 1.5, whipEvery: 0});
  assert.deepEqual(cuts.map((c) => c.videoIndex), [0, 1, 2, 0, 1, 2], '轮转顺序 012012');
  assert.deepEqual(cuts.map((c) => c.mediaStart), [0, 0, 0, 1.5, 1.5, 1.5], '各素材独立推进');
  ok('多素材轮转与独立推进');
}

// 3. 素材耗尽循环：短素材重绕
{
  const cuts = planMontageCuts({durations: [2, 10], totalSec: 6, cutSec: 1.5, whipEvery: 0});
  const v0 = cuts.filter((c) => c.videoIndex === 0);
  // 素材 0 只有 2s：第一切用 [0,1.5]，第二切剩 0.5 <0.3? 0.5≥0.3 → 用 [1.5, 2]（0.5s），第三切重绕 [0,1.5]
  assert.ok(v0.length >= 2, '短素材应被再次轮到（循环）');
  const restarts = v0.filter((c) => c.mediaStart === 0);
  assert.ok(restarts.length >= 1, '应有重绕（mediaStart 归零）');
  for (const c of cuts) {
    const d = [2, 10][c.videoIndex];
    assert.ok(c.mediaStart >= 0 && c.mediaStart + c.durationSec <= d + 0.001, '切窗口不越素材界');
  }
  ok('素材耗尽循环且不越界');
}

// 4. 甩切标记：每 4 切一甩；末切落在段尾无下一切可甩 → 不甩
{
  const cuts = planMontageCuts({durations: [30], totalSec: 12, cutSec: 1.5, whipEvery: 4});
  const whips = cuts.map((c) => (c.whip ? 1 : 0));
  assert.deepEqual(whips, [0, 0, 0, 1, 0, 0, 0, 0], '第 4 切甩切；末切贴段尾不甩');
  const cuts2 = planMontageCuts({durations: [30], totalSec: 12.5, cutSec: 1.5, whipEvery: 4});
  assert.equal(cuts2[7].whip, true, '12.5s 时第 8 切后面还有内容 → 甩切');
  ok('甩切按间隔标记（末切守卫）');
}

// 5. 确定性与兜底
{
  const a = planMontageCuts({durations: [5, 5], totalSec: 6, cutSec: 1.5, whipEvery: 2});
  const b = planMontageCuts({durations: [5, 5], totalSec: 6, cutSec: 1.5, whipEvery: 2});
  assert.deepEqual(a, b, '同输入同输出');
  assert.deepEqual(planMontageCuts({durations: [0, 0], totalSec: 6, cutSec: 1.5, whipEvery: 0}), [], '无可用素材 → 空');
  assert.deepEqual(planMontageCuts({durations: [5], totalSec: 0, cutSec: 1.5, whipEvery: 0}), [], '总时长 0 → 空');
  assert.deepEqual(planMontageCuts({durations: [NaN], totalSec: 6, cutSec: 1.5, whipEvery: 0}), [], 'NaN 时长 → 空');
  ok('确定性与兜底');
}

console.log(`\n通过 ${passed} 组断言`);
