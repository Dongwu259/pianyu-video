/**
 * 高光挖矿纯逻辑（shared/highlight-mining.ts）单元测试：
 * 语音聚类 / 静音补集窗口 / 抽帧采样 / 挖矿提示词 / 模型回复解析 /
 * 保留区间归一与 trim+cuts 落地数学。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/highlight-mining.test.ts
 */

import assert from 'node:assert/strict';

const {
  buildSpeechClusters, speechWindowsFromSilences, sampleFrameTimes,
  buildMiningPrompt, parseHighlightResponse, normalizeKeepRanges, keepRangesToTrim,
} = await import('../../src/shared/highlight-mining.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('语音聚类（ASR 分段 → 话题块）:');
{
  // 间隙 ≤1.2s 合并；>1.2s 分块；短于 0.8s 的碎句丢弃
  const segs = [
    {start: 0, end: 2, text: '大家好'},
    {start: 2.5, end: 4, text: '今天去爬山'},
    {start: 10, end: 11, text: '呃'},           // 0.8s 整——保留边界（≥ minLen）
    {start: 12, end: 18, text: '山顶风景特别好'},
    {start: 25, end: 26, text: '嗯'},           // 1s 但独立成块后 ≥0.8 保留
  ];
  const clusters = buildSpeechClusters(segs);
  // 0-4 合一块（间隙 0.5）；10-11 与 12-18 间隙 1.0 合并；25-26 独立
  assert.equal(clusters.length, 3);
  assert.ok(Math.abs(clusters[0]!.startSec - 0) < 1e-9 && Math.abs(clusters[0]!.endSec - 4) < 1e-9);
  assert.ok(clusters[0]!.text.includes('大家好') && clusters[0]!.text.includes('爬山'));
  assert.ok(Math.abs(clusters[1]!.startSec - 10) < 1e-9 && Math.abs(clusters[1]!.endSec - 18) < 1e-9);
  ok('间隙合并与话题块边界');
}
{
  const clusters = buildSpeechClusters([
    {start: 0, end: 0.5, text: '嗯'},
    {start: 5, end: 5.4, text: '啊'},
  ]);
  assert.equal(clusters.length, 0, '短于 0.8s 的碎句应丢弃');
  const custom = buildSpeechClusters([{start: 0, end: 1, text: 'a'}, {start: 2.5, end: 4, text: 'b'}], {maxGapSec: 3});
  assert.equal(custom.length, 1, '自定义间隙');
  const empty = buildSpeechClusters([]);
  assert.equal(empty.length, 0);
  ok('碎句过滤 / 自定义参数 / 空输入');
}
{
  // 乱序输入按 start 排序；文本截断到 160
  const shuffled = [
    {start: 10, end: 12, text: 'B'},
    {start: 0, end: 2, text: 'A'},
  ];
  const c = buildSpeechClusters(shuffled);
  assert.equal(c[0]!.text, 'A');
  const long = buildSpeechClusters([{start: 0, end: 30, text: '字'.repeat(300)}]);
  assert.equal(long[0]!.text.length, 160);
  ok('排序与转写截断');
}

console.log('静音补集 → 语音窗口:');
{
  // 中段静音 10-20s、尾部静音 55-60s：窗口 = [0,10) + [20,55)
  const w = speechWindowsFromSilences([{start: 10, end: 20}, {start: 55, end: 60}], 60);
  assert.equal(w.length, 2);
  assert.ok(Math.abs(w[0]!.startSec - 0) < 1e-9 && Math.abs(w[0]!.endSec - 10) < 1e-9);
  assert.ok(Math.abs(w[1]!.startSec - 20) < 1e-9 && Math.abs(w[1]!.endSec - 55) < 1e-9);
  ok('中段/尾部静音切窗口');
}
{
  // 开头静音：0-5 静音 → 窗口从 5 起
  const w = speechWindowsFromSilences([{start: 0, end: 5}], 60);
  assert.equal(w.length, 1);
  assert.ok(Math.abs(w[0]!.startSec - 5) < 1e-9);
  // 全程静音 → 无窗口（服务层会兜底整条）
  assert.equal(speechWindowsFromSilences([{start: 0, end: 60}], 60).length, 0);
  // 重叠/乱序静音合并
  const w2 = speechWindowsFromSilences([{start: 20, end: 30}, {start: 10, end: 25}], 60);
  assert.equal(w2.length, 2);
  assert.ok(Math.abs(w2[0]!.endSec - 10) < 1e-9 && Math.abs(w2[1]!.startSec - 30) < 1e-9);
  // 超出时长的静音被钳制
  const w3 = speechWindowsFromSilences([{start: 50, end: 80}], 60);
  assert.equal(w3.length, 1);
  assert.ok(Math.abs(w3[0]!.endSec - 50) < 1e-9);
  ok('开头/全程/重叠/越界静音');
}

console.log('抽帧采样:');
{
  const t = sampleFrameTimes(120, 6);
  assert.equal(t.length, 6);
  assert.ok(t[0]! >= 120 * 0.03 - 0.01 && t[t.length - 1]! <= 120 * 0.97 + 0.01, '避开首尾 3%');
  for (let i = 1; i < t.length; i++) assert.ok(t[i]! > t[i - 1]!, '单调递增');
  assert.equal(sampleFrameTimes(50, 99).length, 50, '钳到时长秒数');
  assert.equal(sampleFrameTimes(10, 4).length, 4);
  assert.equal(sampleFrameTimes(3, 4).length, 3, '短素材按秒数封顶');
  ok('均匀采样与数量钳制');
}

console.log('挖矿提示词:');
{
  const p = buildMiningPrompt({
    durationSec: 600, targetDurationSec: 60, maxSegments: 8,
    clusters: [{startSec: 10, endSec: 30, text: '今天教大家做菜'}],
    asrUsed: true, frameTimes: [18, 180, 360, 540],
  });
  assert.ok(p.includes('600.0 秒'));
  assert.ok(p.includes('目标成片总时长约 60 秒'));
  assert.ok(p.includes('[10.0-30.0s] 今天教大家做菜'));
  assert.ok(p.includes('18.0s、180.0s、360.0s、540.0s'));
  assert.ok(p.includes('"highlights"'));
  const noAsr = buildMiningPrompt({durationSec: 100, targetDurationSec: 30, maxSegments: 4, clusters: [], asrUsed: false, frameTimes: [50]});
  assert.ok(noAsr.includes('无转写线索'));
  const focused = buildMiningPrompt({durationSec: 100, targetDurationSec: 30, maxSegments: 4, clusters: [], asrUsed: false, frameTimes: [50], focus: '只要美食部分'});
  assert.ok(focused.includes('用户侧重：只要美食部分'));
  ok('提示词要素（时长/话题块/帧时间点/侧重）');
}

console.log('模型回复解析:');
{
  const good = '{"highlights":[{"startSec":12.4,"endSec":25,"summary":"山顶看日出","reason":"情绪高点"},{"startSec":120,"endSec":138,"summary":"下山吃饭","reason":"信息完整"}]}';
  const picks = parseHighlightResponse(good, 600);
  assert.ok(picks);
  assert.equal(picks!.length, 2);
  assert.ok(Math.abs(picks![0]!.startSec - 12.4) < 1e-9);
  assert.equal(picks![0]!.summary, '山顶看日出');
  ok('干净 JSON');
}
{
  const fenced = '好的，以下是高光：\n```json\n{"highlights":[{"startSec":0,"endSec":10,"summary":"a","reason":"r"}]}\n```\n希望有帮助';
  const picks = parseHighlightResponse(fenced, 600);
  assert.ok(picks && picks.length === 1 && picks[0]!.startSec === 0);
  const arr = '[{"startSec":5,"endSec":15,"summary":"x","reason":"y"}]';
  const picks2 = parseHighlightResponse(arr, 600);
  assert.ok(picks2 && picks2.length === 1);
  ok('围栏/前后缀文本/裸数组');
}
{
  // 钳制与过滤：start<0 钳 0；end>duration 钳 duration；<0.5s 丢弃；完全越界的窗口钳后不足 0.5s 也丢弃；乱序输出按 start 排序
  const picks = parseHighlightResponse(
    '{"highlights":[{"startSec":100,"endSec":110,"summary":"后","reason":""},{"startSec":-5,"endSec":5.5,"summary":"前","reason":""},{"startSec":50,"endSec":50.3,"summary":"太短","reason":""},{"startSec":590,"endSec":900,"summary":"半越界","reason":""},{"startSec":700,"endSec":900,"summary":"全越界","reason":""}]}',
    600,
  );
  assert.ok(picks);
  assert.equal(picks!.length, 3, '太短/全越界的丢弃');
  assert.equal(picks![0]!.startSec, 0, '负起点钳 0');
  assert.ok(Math.abs(picks![2]!.endSec - 600) < 1e-9, '越界终点钳时长');
  assert.ok(picks![0]!.startSec < picks![1]!.startSec && picks![1]!.startSec < picks![2]!.startSec, '按时间排序');
  ok('钳制/过滤/排序');
}
{
  assert.equal(parseHighlightResponse('', 600), null);
  assert.equal(parseHighlightResponse('完全没有 JSON', 600), null);
  assert.equal(parseHighlightResponse('{"foo": 1}', 600), null);
  assert.equal(parseHighlightResponse('{"highlights": []}', 600), null, '空清单不接受');
  assert.equal(parseHighlightResponse('{"highlights": "not-array"}', 600), null);
  ok('坏输入防御');
}

console.log('保留区间归一:');
{
  const r = normalizeKeepRanges([{start: 10, end: 20}, {start: 5, end: 8}, {start: 19.5, end: 25}], 100);
  assert.deepEqual(r.map((x) => [x.start, x.end]), [[5, 8], [10, 25]], '排序 + 近接合并');
  const clamped = normalizeKeepRanges([{start: -5, end: 3}, {start: 90, end: 200}], 100);
  assert.deepEqual(clamped.map((x) => [x.start, x.end]), [[0, 3], [90, 100]], '钳到时长');
  const dropped = normalizeKeepRanges([{start: 0, end: 0.2}], 100);
  assert.equal(dropped.length, 0, '过短丢弃');
  assert.equal(normalizeKeepRanges([], 100).length, 0);
  ok('排序/合并/钳制/过滤');
}

console.log('keepRanges → trim + cuts（apply_cut_list 数学）:');
{
  const single = keepRangesToTrim([{start: 12, end: 30}]);
  assert.equal(single.trimStart, 12);
  assert.equal(single.trimEnd, 30);
  assert.equal(single.cuts.length, 0, '单段无挖段');
  const multi = keepRangesToTrim([
    {start: 10, end: 20}, {start: 30, end: 40}, {start: 55, end: 60},
  ]);
  assert.equal(multi.trimStart, 10);
  assert.equal(multi.trimEnd, 60);
  assert.deepEqual(multi.cuts, [{start: 20, end: 30}, {start: 40, end: 55}]);
  // 有效时长 = trim 窗口 − 挖段总长（与 clipCuts 语义闭环）
  const {effectiveTrimmedDuration} = await import('../../src/shared/clipCuts.ts');
  const eff = effectiveTrimmedDuration(multi.trimStart, multi.trimEnd, multi.cuts);
  assert.ok(Math.abs(eff - (10 + 10 + 5)) < 1e-9, '有效时长 = 保留区间之和');
  assert.throws(() => keepRangesToTrim([]));
  ok('trim 边界 / 挖段缝隙 / 有效时长闭环');
}

console.log(`\n共 ${passed} 项全部通过`);
