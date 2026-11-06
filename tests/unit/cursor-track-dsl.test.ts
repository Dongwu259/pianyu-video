/**
 * 声明式鼠标动作脚本单测（cursorScript：DSL 解析 + 轨迹合成 + update_segment 校验路径）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/cursor-track-dsl.test.ts
 */
import assert from 'node:assert/strict';
import {parseCursorTrackScript, buildCursorTrack, generateDemoCursorTrack} from '../../src/shared/demo-cursor-track.ts';
import {createLlmTools} from '../../src/shared/llm-tools.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {
  TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS,
} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== DSL 解析 ======
{
  const p = parseCursorTrackScript('0.2,0.8 > 0.45,0.5 @1.2 | click | @0.6 | >0.8,0.35@1.5s | hold');
  assert.deepEqual(p.start, {x: 0.2, y: 0.8});
  assert.equal(p.steps.length, 5, JSON.stringify(p.steps));
  assert.deepEqual(p.steps[0], {kind: 'move', x: 0.45, y: 0.5, sec: 1.2});
  assert.deepEqual(p.steps[1], {kind: 'click'});
  assert.deepEqual(p.steps[2], {kind: 'pause', sec: 0.6});
  assert.deepEqual(p.steps[3], {kind: 'move', x: 0.8, y: 0.35, sec: 1.5});
  assert.equal(p.steps[4].kind, 'pause');
  assert.ok((p.steps[4] as {sec: number}).sec >= 60, 'hold = 长停顿（停到结尾）');
  assert.equal(p.warnings.length, 0);
  ok('标准 DSL：起点/滑动/点击/停顿/hold 全解析');
}
{
  // 变体容忍：无 > 前缀（非首令牌=移动）、hold@2、wait 1.5、中文点击、换行/分号/中文逗号分隔
  const p = parseCursorTrackScript('0.1,0.1\n0.5,0.5；click；hold@2；wait 1.5；点击');
  assert.equal(p.steps.filter((s) => s.kind === 'click').length, 2, '中文点击等价');
  assert.equal(p.steps.filter((s) => s.kind === 'move').length, 1, '无前缀非首坐标=移动');
  assert.deepEqual(p.steps.find((s) => s.kind === 'pause' && s.sec === 2), {kind: 'pause', sec: 2});
  assert.deepEqual(p.steps.find((s) => s.kind === 'pause' && s.sec === 1.5), {kind: 'pause', sec: 1.5});
  ok('变体容忍：无前缀移动/hold@/wait/中文令牌/多种分隔符');
}
{
  // 结构化数组 + 非法项
  const p = parseCursorTrackScript([
    {kind: 'move', x: 0.4, y: 0.5, sec: 1},
    {kind: 'click'},
    {kind: 'pause', sec: 0.5},
    {kind: 'teleport'},
    {kind: 'pause', sec: -1},
    '垃圾',
  ]);
  assert.equal(p.steps.length, 3, JSON.stringify(p.steps));
  assert.ok(p.warnings.length >= 3, `非法项告警 ${p.warnings.length} 条`);
  ok('结构化数组：合法步骤通过、非法项跳过并告警');
}
{
  // 越界钳制与垃圾字符串
  const p = parseCursorTrackScript('0.2,0.8 > 1.4,-0.3 @1 | ??? | click');
  const mv = p.steps[0] as {kind: string; x: number; y: number};
  assert.equal(mv.x, 1, 'x 钳到 1');
  assert.equal(mv.y, 0, 'y 钳到 0');
  assert.ok(p.warnings.some((w) => w.includes('越界')));
  assert.equal(p.steps.filter((s) => s.kind !== 'move' && s.kind !== 'click').length, 0, '垃圾令牌跳过');
  const empty = parseCursorTrackScript('');
  assert.equal(empty.steps.length, 0);
  const junk = parseCursorTrackScript(42);
  assert.equal(junk.steps.length, 0);
  assert.ok(junk.warnings.length > 0);
  ok('越界钳制 / 非法令牌跳过 / 空串与非字符串兜底');
}

// ====== 轨迹合成 ======
const OPTS = {durationSec: 6, width: 1920, height: 1080};
{
  const p = parseCursorTrackScript('0.2,0.8 > 0.45,0.5 @1.2 | click | @0.6 | >0.8,0.35 @1.5 | click | hold');
  const a = buildCursorTrack(p, {...OPTS, seed: 7});
  const b = buildCursorTrack(p, {...OPTS, seed: 7});
  assert.deepEqual(a.points, b.points, '同 seed 逐点一致');
  assert.deepEqual(a.clicks, b.clicks);
  ok('确定性：同 seed 输出逐点相等');
}
{
  const p = parseCursorTrackScript('0.2,0.8 > 0.45,0.5 @1.2 | click | >0.8,0.35 @1.5 | click | hold');
  const {points, clicks} = buildCursorTrack(p, {...OPTS, seed: 3});
  assert.equal(clicks.length, 2, '声明的 click 全落');
  // 点击位置 = 到达时刻的采样点（≈目标像素，钳 8% 边距内）
  const mx = 1920 * 0.08;
  for (const c of clicks) {
    const near = points.find((pt) => Math.abs(pt.t - c.t) <= 34);
    assert.ok(near, `点击 t=${c.t} 附近有采样点`);
    assert.ok(Math.hypot(near.x - c.x, near.y - c.y) < 8, `点击位置贴合轨迹（Δ=${Math.hypot(near.x - c.x, near.y - c.y).toFixed(1)}px）`);
    assert.ok(c.x >= mx && c.x <= 1920 - mx, '点击 x 在 8% 边距内');
  }
  // 时间轴覆盖与末点钉
  assert.equal(points[0].t, 0);
  assert.equal(points[points.length - 1].t, 6000, '末点钉在精确时长');
  for (let i = 1; i < points.length; i++) assert.ok(points[i].t >= points[i - 1].t, '时间单调');
  ok('点击落在声明的目标处（±8px）、时间轴覆盖、末点钉精确时长');
}
{
  // 脚本短于时长 → 末尾停住补齐；超长 → 截断 warning
  const short = buildCursorTrack(parseCursorTrackScript('0.5,0.5 > 0.6,0.6 @0.5 | click'), {...OPTS, seed: 1});
  assert.equal(short.points[short.points.length - 1].t, 6000, '短脚本补齐到段尾');
  const lastMoving = [...short.points].reverse().find((pt, i, arr) => i > 0 && Math.hypot(pt.x - arr[i - 1].x, pt.y - arr[i - 1].y) > 1);
  assert.ok(lastMoving, '脚本动作确实发生（非全程静止）');
  const long = buildCursorTrack(
    parseCursorTrackScript('0.1,0.1 > 0.9,0.9 @8 | click'),
    {...OPTS, seed: 1},
  );
  assert.ok(long.warnings.some((w) => w.includes('截断')), '超长脚本截断告警');
  ok('时长语义：短脚本停住补齐、超长截断并告警');
}
{
  // 空脚本 → 全程 hold 起始点（起点也在边距内）
  const hold = buildCursorTrack(parseCursorTrackScript('0.5,0.5'), {...OPTS, seed: 1});
  assert.ok(hold.points.length > 100, '全程采样');
  assert.ok(hold.points.every((pt) => Math.hypot(pt.x - hold.points[0].x, pt.y - hold.points[0].y) <= 2 * 3), '静止（仅手抖幅度内）');
  assert.equal(hold.clicks.length, 0);
  ok('空动作脚本 = 全程静止持位（手抖幅度内）');
}

// ====== update_segment 校验路径（模型入口） ======
const {validateSegmentPatch} = createLlmTools({
  templates: TEMPLATES,
  transitions: TRANSITION_OPTIONS.map((t) => t.value),
  videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
  backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
  textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
});
{
  const r = validateSegmentPatch({templateId: 'CursorFollow', cursorScript: '0.2,0.8 > 0.45,0.5 @1.2 | click | hold'}, 0);
  assert.ok(r.ok, JSON.stringify((r as {errors?: string[]}).errors));
  if (r.ok) assert.equal(r.patch.cursorScript, '0.2,0.8 > 0.45,0.5 @1.2 | click | hold');
  ok('patch：字符串 DSL 原文透传');
}
{
  const r = validateSegmentPatch(
    {templateId: 'CursorFollow', cursorScript: [{kind: 'move', x: 0.45, y: 0.5, sec: 1.2}, {kind: 'click'}, {kind: 'pause', sec: 0.6}]},
    0,
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.patch.cursorScript, '>0.45,0.5@1.2 | click | @0.6', r.patch.cursorScript);
  ok('patch：结构化数组规范化为 DSL 字符串（持久化单一形态）');
}
{
  const r = validateSegmentPatch({templateId: 'CursorFollow', cursorScript: 'garbage !!'}, 0);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.patch.cursorScript, undefined, '无有效步骤 → 忽略（保留原轨迹）');
    assert.ok(r.notes.some((n) => n.includes('cursorScript')), '告警回告模型');
  }
  const clear = validateSegmentPatch({templateId: 'CursorFollow', cursorScript: ''}, 0);
  assert.ok(clear.ok);
  if (clear.ok) assert.equal(clear.patch.cursorScript, '', '空串 = 清除语义透传');
  ok('patch：垃圾脚本忽略+告警 / 空串清除');
}

// ====== 随机演示轨迹零回归（重构 easeInOut 提升后行为不变） ======
{
  const a = generateDemoCursorTrack({durationSec: 5, width: 1280, height: 720, seed: 42});
  const b = generateDemoCursorTrack({durationSec: 5, width: 1280, height: 720, seed: 42});
  assert.deepEqual(a, b);
  assert.equal(a[a.length - 1].t, 5000);
  assert.ok(a.some((pt, i) => i > 0 && pt.x !== a[i - 1].x), '有移动段');
  ok('generateDemoCursorTrack 重构后行为不变（同 seed 确定性）');
}

// ====== computer-use 新令牌解析（dblclick/right/down/up/drag/scroll/type） ======
{
  const p = parseCursorTrackScript(
    '0.2,0.8 > 0.4,0.5 @0.5 | dblclick | right | down | @0.5 | up | drag > 0.75,0.5 @1 | scroll +3 @0.5 | scroll -2 | type "你好 world" @1.5 | hold',
  );
  assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
  assert.deepEqual(p.start, {x: 0.2, y: 0.8});
  const kinds = p.steps.map((s) => s.kind).join(',');
  assert.equal(kinds, 'move,dblclick,right,down,pause,up,drag,scroll,scroll,type,pause', kinds);
  assert.deepEqual(p.steps[6], {kind: 'drag', x: 0.75, y: 0.5, sec: 1});
  assert.deepEqual(p.steps[7], {kind: 'scroll', ticks: 3, sec: 0.5});
  assert.deepEqual(p.steps[8], {kind: 'scroll', ticks: -2, sec: 0.3}, 'scroll 缺省时长 150ms/格');
  assert.deepEqual(p.steps[9], {kind: 'type', text: '你好 world', sec: 1.5});
  ok('新令牌全解析：双击/右键/按住配对/拖拽/滚轮/打字（缺省时长口径）');
}
{
  // 中文别名 / 无 > 的 drag / 三种引号 / 裸文本 / 结构化数组新 kinds
  const p = parseCursorTrackScript('0.3,0.3 | 双击 | 右键 | 拖到 0.8,0.6 | 滚动 +2 | 输入 「部署完成」');
  assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
  const kinds = p.steps.map((s) => s.kind).join(',');
  assert.equal(kinds, 'dblclick,right,drag,scroll,type', kinds);
  assert.deepEqual(p.steps[4], {kind: 'type', text: '部署完成', sec: 0.4}, '4 字缺省 0.36s → 钳到 0.4 下限');
  const arr = parseCursorTrackScript([
    {kind: 'dblclick'}, {kind: 'right'}, {kind: 'down'}, {kind: 'up'},
    {kind: 'drag', x: 0.7, y: 0.4, sec: 0.8},
    {kind: 'scroll', ticks: -4, sec: 0.6},
    {kind: 'type', text: 'AI 剪辑', sec: 1},
  ]);
  assert.equal(arr.warnings.length, 0, JSON.stringify(arr.warnings));
  assert.equal(arr.steps.length, 7);
  ok('中文别名与结构化数组新 kinds 全过');
}
{
  // 非法/越界兜底：scroll 0、scroll 超限钳制、type 空/超长、drag 坐标非法
  const long50 = '片'.repeat(50);
  const p = parseCursorTrackScript(`0.5,0.5 | scroll 0 | scroll +99 | type "" | type "${long50}" | drag x,y`);
  assert.equal(p.steps.filter((s) => s.kind === 'scroll').length, 1, 'scroll 0 跳过、+99 保留（钳制）');
  assert.equal((p.steps.find((s) => s.kind === 'scroll') as {ticks: number}).ticks, 10, '钳到 +10');
  assert.equal(p.steps.filter((s) => s.kind === 'type').length, 1, '空 type 跳过、超长保留');
  assert.equal((p.steps.find((s) => s.kind === 'type') as {text: string}).text.length, 40, '截到 40 字');
  assert.equal(p.steps.filter((s) => s.kind === 'drag').length, 0, 'drag 坐标非法跳过');
  assert.ok(p.warnings.length >= 3, '告警齐（格数钳制/文本截断/坐标非法）');
  ok('非法/越界兜底：格数钳 ±10、文本截 40 字、非法坐标跳过');
}

// ====== 构建语义：按压态 / 点击落点 / 事件 ======
{
  // drag：按住期间采样点带 down:true；点击落在目标处；drag 前后无按压
  const b = buildCursorTrack(parseCursorTrackScript('0.15,0.2 > 0.3,0.3 @0.6 | drag > 0.8,0.7 @1.2 | hold'), {...OPTS, seed: 7});
  const downs = b.points.filter((pt) => pt.down === true);
  assert.ok(downs.length > 10, '按住段采样充足');
  assert.ok(downs.every((pt) => pt.t >= 600), '按压不早于 drag 开始');
  assert.ok(downs[downs.length - 1].t - downs[0].t >= 1000, '按压跨度 ≈ 拖拽时长');
  assert.ok(b.points[b.points.length - 1].down !== true, '收尾不按住');
  const dragClick = b.clicks.find((c) => c.t >= downs[0].t);
  assert.ok(dragClick, 'drag 落子有点击');
  assert.ok(Math.hypot(dragClick.x - 0.8 * 1920, dragClick.y - 0.7 * 1080) <= 10, '点击落在目标处');
  assert.equal(dragClick.button, 1);
  ok('drag 语义：按压态标记 + 点击落目标处（左键）');
}
{
  // down/up 配对 = 一次点击落抬起位置；期间按压
  const b = buildCursorTrack(parseCursorTrackScript('0.5,0.5 | down | @0.8 | up | hold'), {...OPTS, seed: 3});
  assert.equal(b.clicks.length, 1, 'down+up = 一次点击');
  assert.ok(b.clicks[0].t >= 800, '点击在抬起时刻');
  const downs = b.points.filter((pt) => pt.down === true);
  assert.ok(downs.length > 10 && downs[downs.length - 1].t < b.clicks[0].t + 100, '按压贯穿按住段');
  ok('down/up 配对：一次点击落抬起位置');
}
{
  // dblclick = 两记 90ms 左键；right = 单记右键
  const b = buildCursorTrack(parseCursorTrackScript('0.5,0.5 | dblclick | @1 | right | hold'), {...OPTS, seed: 5});
  const dbl = b.clicks.slice(0, 2);
  assert.equal(dbl.length, 2);
  assert.ok(Math.abs(dbl[1].t - dbl[0].t - 90) <= 34, '双击间隔 90ms（±一个采样）');
  assert.ok(Math.hypot(dbl[0].x - dbl[1].x, dbl[0].y - dbl[1].y) <= 6, '双击同位');
  assert.equal(b.clicks[2].button, 2, 'right = 右键');
  assert.equal(b.clicks[0].button, 1);
  ok('dblclick 两记同位 90ms / right 右键 button=2');
}
{
  // scroll/type 事件：字段齐、type 期间光标定住、同 seed 确定
  const script = '0.4,0.6 | scroll +3 @0.6 | @0.3 | type "登录成功" @1.2 | hold';
  const a = buildCursorTrack(parseCursorTrackScript(script), {...OPTS, seed: 11});
  const c = buildCursorTrack(parseCursorTrackScript(script), {...OPTS, seed: 11});
  assert.deepEqual(a.events, c.events, '事件同 seed 确定');
  const scr = a.events.find((e) => e.kind === 'scroll');
  assert.ok(scr && scr.ticks === 3 && scr.durMs === 600, JSON.stringify(scr));
  const typ = a.events.find((e) => e.kind === 'type');
  assert.ok(typ && typ.text === '登录成功' && typ.durMs === 1200, JSON.stringify(typ));
  // type 期间（scr 之后 typ 期间）光标只在手抖幅度内
  const during = a.points.filter((pt) => pt.t >= typ!.t && pt.t <= typ!.t + typ!.durMs);
  assert.ok(during.length > 20, 'type 期间有采样');
  const anchor = during[0];
  assert.ok(during.every((pt) => Math.hypot(pt.x - anchor.x, pt.y - anchor.y) <= 2 * 3), '光标定住（仅手抖）');
  ok('scroll/type 事件字段 + type 期间光标定住 + 确定性');
}
{
  // patch 数组规范化：新 kinds 序列化 DSL 后可无损再解析
  const r = validateSegmentPatch(
    {templateId: 'CursorFollow', cursorScript: [
      {kind: 'drag', x: 0.75, y: 0.5, sec: 1},
      {kind: 'scroll', ticks: 3},
      {kind: 'type', text: '登录', sec: 0.8},
      {kind: 'dblclick'},
      {kind: 'right'},
      {kind: 'down'}, {kind: 'up'},
    ]},
    0,
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.patch.cursorScript, 'drag > 0.75,0.5@1 | scroll +3@0.45 | type "登录"@0.8 | dblclick | right | down | up', r.patch.cursorScript);
    const re = parseCursorTrackScript(r.patch.cursorScript);
    assert.equal(re.warnings.length, 0, JSON.stringify(re.warnings));
    assert.equal(re.steps.length, 7, '无损往返');
  }
  ok('patch：新 kinds 数组规范化 DSL 往返无损');
}

console.log(`\n${passed} 项通过`);
