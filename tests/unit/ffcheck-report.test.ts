/**
 * ffcheck-report.ts 单测：检测事件解析与设计内排除（P1-5）
 * 解析锚定 ffmpeg 实际 stderr 行格式（black_* 与 freeze_* 两族键序不同）；
 * 三判分类含 v11 竖版实测形态（69.83-69.97s 尾淡出）；拼条规划数学。
 */
import assert from 'node:assert/strict';
import {
  parseBlackEvents, parseFreezeEvents, classifyBlackEvents, classifyFreezeEvents, segSheetPlan,
  DARK_TEMPLATES,
} from '../../src/shared/ffcheck-report.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const BLACK_LOG = [
  '[Parsed_blackdetect_0 @ 000001f4e12fca00] black_start:3.200 black_end:4.100 black_duration:0.900',
  '[Parsed_blackdetect_0 @ 000001f4e12fca00] black_start:69.833333 black_end:69.966667 black_duration:0.133333',
].join('\n');
const FREEZE_LOG = '[Parsed_freezedetect_0 @ 000001f4e12fca00] freeze_start:12.000 freeze_duration:2.500 freeze_end:14.500';

{
  // 解析：两族键序各自锚定（black=start,end,duration；freeze=start,duration,end）
  const b = parseBlackEvents(BLACK_LOG);
  assert.equal(b.length, 2);
  assert.ok(Math.abs(b[0].startSec - 3.2) < 1e-9 && Math.abs(b[0].endSec - 4.1) < 1e-9);
  assert.ok(Math.abs(b[1].durationSec - 0.133333) < 1e-6, 'v11 竖版实测事件解析');
  assert.equal(parseBlackEvents('no matches here').length, 0, '无事件文本返回空表');
  const f = parseFreezeEvents(FREEZE_LOG);
  assert.equal(f.length, 1);
  assert.ok(Math.abs(f[0].endSec - 14.5) < 1e-9, 'freeze 键序 start,duration,end');
  ok('parse 两族键序（实测行格式锚点）');
}

const segs = [
  {id: 'seg-0', templateId: 'AiPromptCard', startSec: 0, endSec: 4},
  {id: 'seg-1', templateId: 'TimeTunnel3D', startSec: 4, endSec: 10.5},
  {id: 'seg-12', templateId: 'OutroCTA', startSec: 69, endSec: 74},
];

{
  // 三判：片尾余量=设计内淡出；暗底模板段内=设计内暗场；其余 suspect + 归属段
  // 竖版实测形态：总长 70.1s、事件 69.83-69.97（片尾余量 1.5s 内）
  const total = 70.1;
  const c = classifyBlackEvents([
    {startSec: 69.833, endSec: 69.966, durationSec: 0.133},   // v11 竖版实测形态（尾淡出）
    {startSec: 1.0, endSec: 2.0, durationSec: 1.0},           // seg-0 AiPromptCard 段内（暗底模板）
    {startSec: 5.0, endSec: 6.0, durationSec: 1.0},           // seg-1 中段（无设计理由）
    {startSec: 3.9, endSec: 4.4, durationSec: 0.5},           // 骑跨暗底段边界（不是全程在内）
  ], segs, total);
  assert.equal(c[0].verdict, 'design-fade', '片尾余量内 → 设计内淡出');
  assert.equal(c[1].verdict, 'design-dark', 'AiPromptCard 段内全程 → 设计内暗场');
  assert.equal(c[1].segId, 'seg-0');
  assert.equal(c[2].verdict, 'suspect', 'TimeTunnel3D 中段黑屏 = 事故');
  assert.equal(c[2].segId, 'seg-1', 'suspect 归属段');
  assert.equal(c[3].verdict, 'suspect', '骑跨暗底段边界不豁免');
  ok('classify 三判 + 归属段');
}

{
  // 冻结：无设计内形态全 suspect；段外（转场缝隙）归属 null
  const f = classifyFreezeEvents([
    {startSec: 12, endSec: 14.5, durationSec: 2.5},
    {startSec: 74.1, endSec: 76, durationSec: 1.9},
  ], segs);
  assert.equal(f[0].segId, null, '12s 在段表外（三段示例表）');
  assert.ok(DARK_TEMPLATES.has('OutroCTA') && DARK_TEMPLATES.has('AiPromptCard'));
  ok('freeze 全 suspect + 段外归属 null');
}

{
  // 拼条规划：帧数含头不含尾、行列数、图例时刻表
  const plan = segSheetPlan({id: 's', templateId: 'X', startSec: 10, endSec: 16}, 0.5, 4);
  assert.equal(plan.frames, 12, '6s / 0.5s = 12 格');
  assert.equal(plan.rows, 3);
  assert.equal(plan.times[0], 10);
  assert.equal(plan.times[11], 15.5, '最后一格 = start + 11×step（含头不含尾）');
  const tiny = segSheetPlan({id: 's', templateId: 'X', startSec: 0, endSec: 0.3}, 0.5, 4);
  assert.equal(tiny.frames, 1, '短于一步至少 1 格');
  assert.equal(tiny.rows, 1);
  ok('segSheetPlan 帧数/行列/图例');
}

console.log(`\n共 ${passed} 项全部通过`);
