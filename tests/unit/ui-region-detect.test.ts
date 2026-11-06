/**
 * UI 面板视觉检测（B6 视觉检测线）与 .regions.json sidecar 解析单元测试
 *
 * 覆盖：
 * - findCuts：合成剖面的缝检测（两侧平坦+台阶）、过渡带合并
 * - pickCuts：对比度贪心 + 最小带约束
 * - aggregateCuts：多数派聚类（闪现弹层被滤掉）
 * - detectUiRegions：典型桌面 UI 合成帧（侧栏/主区/属性板/时间轴条）→ 四角色区域；
 *   无缝整帧 → 单 main 回退
 * - parseUiRegionsJson：合法/坏版本/坏区域钳制/非法输入
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/ui-region-detect.test.ts
 */

import assert from 'node:assert/strict';
import {findCuts, pickCuts, aggregateCuts, detectUiRegions} from '../../src/shared/ui-region-detect.ts';
import {parseUiRegionsJson} from '../../src/shared/ui-regions.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== findCuts ======

console.log('findCuts:');
{
  // 剖面：平坦 40（0-0.2）→ 台阶 → 平坦 120（0.2-0.8）→ 台阶 → 平坦 70（0.8-1）
  const n = 320;
  const mean = new Float64Array(n);
  for (let i = 0; i < n; i++) mean[i] = i < 64 ? 40 : i < 256 ? 120 : 70;
  const cuts = findCuts(mean, 12, 0.09);
  assert.equal(cuts.length, 2, `应检出 2 条缝，实际 ${cuts.length}（${cuts.map((c) => c.pos.toFixed(3)).join(',')}）`);
  assert.ok(Math.abs(cuts[0].pos - 0.2) < 0.02, `缝1≈0.2，实际 ${cuts[0].pos.toFixed(3)}`);
  assert.ok(Math.abs(cuts[1].pos - 0.8) < 0.02, `缝2≈0.8，实际 ${cuts[1].pos.toFixed(3)}`);
  // 无缝平坦剖面 → 空
  const flat = new Float64Array(n).fill(100);
  assert.equal(findCuts(flat, 12, 0.09).length, 0);
  // 平坦但差值不足 → 空
  const subtle = new Float64Array(n);
  for (let i = 0; i < n; i++) subtle[i] = i < n / 2 ? 100 : 108;
  assert.equal(findCuts(subtle, 12, 0.09).length, 0, '台阶 <12 不出缝');
  ok('双缝定位 / 无缝空 / 弱台阶不误检');
}

// ====== pickCuts ======

console.log('pickCuts:');
{
  const cuts = [
    {pos: 0.1, contrast: 30},
    {pos: 0.12, contrast: 50},
    {pos: 0.5, contrast: 20},
    {pos: 0.85, contrast: 40},
  ];
  const picked = pickCuts(cuts, 2, 0.09);
  assert.deepEqual(picked.map((c) => c.pos), [0.12, 0.85], '贪心留最强且间距合规');
  ok('贪心 + 最小带约束');
}

// ====== aggregateCuts ======

console.log('aggregateCuts:');
{
  // 5 帧里 4 帧在 0.2 有缝、1 帧闪现在 0.6 → 多数派只留 0.2
  const cutSets = [
    [{pos: 0.2, contrast: 30}],
    [{pos: 0.205, contrast: 28}],
    [{pos: 0.6, contrast: 25}],
    [{pos: 0.195, contrast: 31}],
    [{pos: 0.2, contrast: 29}],
  ];
  const agg = aggregateCuts(cutSets, 0.09);
  assert.equal(agg.length, 1, `多数派聚类应只剩 1 条，实际 ${agg.length}`);
  assert.ok(Math.abs(agg[0].pos - 0.2) < 0.01, `中位≈0.2，实际 ${agg[0].pos.toFixed(3)}`);
  // 兜底中位：缝位抖动无多数派（0.415×2/0.471×2/0.505×1）但过半帧有候选 → 全体中位 0.471
  const jitter = [
    [{pos: 0.415, contrast: 20}],
    [{pos: 0.471, contrast: 18}],
    [{pos: 0.471, contrast: 19}],
    [{pos: 0.415, contrast: 21}],
    [{pos: 0.505, contrast: 17}],
  ];
  const fallback = aggregateCuts(jitter, 0.09);
  assert.equal(fallback.length, 1, `兜底应出 1 条，实际 ${fallback.length}`);
  assert.ok(Math.abs(fallback[0].pos - 0.471) < 0.01, `兜底中位≈0.471，实际 ${fallback[0].pos.toFixed(3)}`);
  ok('多数派聚类滤闪现 / 兜底中位抗抖动');
}

// ====== detectUiRegions ======

console.log('detectUiRegions:');
{
  // 典型桌面 UI 合成帧 320×180：侧栏 0-60(40) / 主区 60-240(120) / 属性板 240-320(70)；
  // 底部 y=140-180 时间轴条（中/右 60，侧栏底 30）
  const W = 320;
  const H = 180;
  const frame = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = x < 60 ? 40 : x < 240 ? 120 : 70;
      if (y >= 140) v = x < 60 ? 30 : 60;
      frame[y * W + x] = v;
    }
  }
  const regions = detectUiRegions(frame, W, H);
  const byRole = Object.fromEntries(regions.map((r) => [r.role, r]));
  assert.ok(byRole.sidebar, '应检出侧栏');
  assert.ok(Math.abs(byRole.sidebar.w - 0.1875) < 0.03, `侧栏宽≈0.1875，实际 ${byRole.sidebar.w.toFixed(3)}`);
  assert.equal(byRole.sidebar.h, 1, '侧栏通高');
  assert.ok(byRole.main, '应检出主区');
  assert.ok(Math.abs(byRole.main.x - 0.1875) < 0.03 && byRole.main.h < 0.9, '主区在中列上部');
  assert.ok(byRole.panel, '应检出属性板');
  assert.ok(Math.abs(byRole.panel.x - 0.75) < 0.03, `属性板 x≈0.75，实际 ${byRole.panel.x.toFixed(3)}`);
  assert.ok(byRole.timeline, '应检出时间轴条');
  assert.ok(byRole.timeline.y > 0.6 && byRole.timeline.h < 0.4, '时间轴条在中下');
  // 无缝整帧 → 单 main 回退
  const plain = new Uint8Array(W * H).fill(100);
  const only = detectUiRegions(plain, W, H);
  assert.equal(only.length, 1);
  assert.equal(only[0].role, 'main');
  assert.equal(only[0].x, 0);
  assert.equal(only[0].w, 1);
  // 非法输入
  assert.deepEqual(detectUiRegions(new Uint8Array(10), 320, 180), []);
  ok('四角色定位 / 无缝回退 main / 非法输入');
}

// ====== parseUiRegionsJson ======

console.log('parseUiRegionsJson:');
{
  const valid = JSON.stringify({
    version: 1, videoWidth: 2560, videoHeight: 1440, source: 'visual', sampleSec: [0.5, 3],
    regions: [
      {id: 'sidebar', role: 'sidebar', x: 0, y: 0, w: 0.19, h: 1, score: 0.8},
      {id: 'main', role: 'main', x: 0.19, y: 0, w: 0.81, h: 1},
    ],
  });
  const parsed = parseUiRegionsJson(valid);
  assert.ok(parsed);
  assert.equal(parsed!.regions.length, 2);
  assert.equal(parsed!.regions[0].role, 'sidebar');
  assert.equal(parsed!.source, 'visual');
  // 坏版本 / 坏来源 / 空 regions / 坏 JSON
  assert.equal(parseUiRegionsJson('{"version":2,source:"visual",regions:[]}'), null);
  assert.equal(parseUiRegionsJson(JSON.stringify({version: 1, source: 'magic', regions: [{x: 0, y: 0, w: 1, h: 1}]})), null);
  assert.equal(parseUiRegionsJson(JSON.stringify({version: 1, source: 'visual', regions: []})), null);
  assert.equal(parseUiRegionsJson('not-json'), null);
  // 区域钳制：越界 x/w 收回画内，role 非法回 main
  const clamped = parseUiRegionsJson(JSON.stringify({
    version: 1, source: 'cdp',
    regions: [{id: 'a', role: 'weird', x: 0.9, y: -0.1, w: 0.5, h: 0.5}],
  }));
  assert.ok(clamped);
  assert.equal(clamped!.regions[0].role, 'main');
  assert.ok(clamped!.regions[0].x + clamped!.regions[0].w <= 1.0001);
  assert.ok(clamped!.regions[0].y >= 0);
  ok('合法解析 / 坏结构拒收 / 越界钳制');
}

console.log(`\n共 ${passed} 项全部通过`);
