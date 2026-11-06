/**
 * 点击放大丝滑化规划器单测（移植自 DogSC 的四策略验证）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/click-zoom-smooth.test.ts
 */
import assert from 'node:assert/strict';
import {planClickZoomEnvelopes, sampleClickZoom, springProgress, focusMaskState, hoverClusters, hoverCardState} from '../../src/shared/click-zoom-smooth.ts';
import type {CursorClick, CursorPoint} from '../../src/shared/capture.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const W = 1920;
const H = 1080;
const mkClick = (t: number, x: number, y: number): CursorClick => ({t, x, y, button: 1});
const mkPoint = (t: number, x: number, y: number): CursorPoint => ({t, x, y});
// 默认参数（与实现 DEFAULTS 同值；显式传避免测试随默认漂移）
const OPTS = (over: Partial<Parameters<typeof planClickZoomEnvelopes>[4]> = {}) => ({
  zoomScale: 1.8,
  enterSec: 0.7,
  holdSec: 0.9,
  exitSec: 0.7,
  clickGroupGapSec: 1.4,
  activityIdleGapSec: 1.4,
  settleSec: 0.55,
  ...over,
});

// ====== springProgress ======
console.log('springProgress:');
{
  assert.equal(springProgress(0), 0);
  assert.equal(springProgress(1), 1);
  ok('端点精确（0→0，1→1，归一化保证关键帧不漂）');
  const mid = springProgress(0.5);
  assert.ok(mid > 0 && mid < 1.01, `中段进度应接近 1（可微超调后钳），实际 ${mid}`);
  ok(`中段连续（t=0.5 → ${mid.toFixed(3)}）`);
  // 单调性抽查（欠阻尼归一化后可能局部非单调=回弹质感，但 0..0.3 段应上升）
  let asc = true;
  for (let i = 1; i <= 30; i++) {
    if (springProgress(i / 100) < springProgress((i - 1) / 100)) asc = false;
  }
  assert.ok(asc, '前 30% 应单调上升（未过冲区间）');
  ok('上升沿单调（无早回弹）');
}

// ====== 策略 1：空间分组（区域稳定优先） ======
console.log('空间分组:');
{
  // 同区域 1.2s 内三连点 → 一个包络、一个焦点（包围盒中心）
  const clicks = [
    mkClick(1000, 900, 500),
    mkClick(1400, 1000, 560),
    mkClick(1800, 950, 620),
  ];
  const env = planClickZoomEnvelopes(clicks, [], W, H, OPTS());
  assert.equal(env.length, 1, `同区域连点应合一包络，实际 ${env.length}`);
  const f = env[0].focus;
  assert.ok(Math.abs(f.x - 950) < 1 && Math.abs(f.y - 560) < 1, `组焦点=包围盒中心 (${f.x},${f.y})`);
  ok('同区域三连点 → 一包络，焦点=包围盒中心（区域稳定，注视点不跳）');

  // 时间连续但跨屏 → 两个包络（span 超上限裂组），首尾相接（前组无出场）
  const far = [
    mkClick(1000, 200, 200),
    mkClick(1600, 1700, 900),
  ];
  const env2 = planClickZoomEnvelopes(far, [], W, H, OPTS());
  assert.equal(env2.length, 2, `跨屏两点击应裂两包络，实际 ${env2.length}`);
  assert.equal(env2[0].exitMs, 0, '非末组无出场（串联不回落）');
  assert.ok(Math.abs(env2[0].endMs - env2[1].startMs) <= 1, '空间裂组首尾相接（交接连续）');
  ok('时间连续但跨屏 → 裂两包络相接，前组无出场（串联）');

  // 时间上分开（>1.4s）→ 独立两包络
  const apart = [mkClick(1000, 900, 500), mkClick(5000, 920, 520)];
  const env3 = planClickZoomEnvelopes(apart, [], W, H, OPTS());
  assert.equal(env3.length, 2);
  assert.ok(env3[1].startMs > env3[0].endMs + env3[0].exitMs, '独立包络间应完全分离');
  ok('间隔 >1.4s → 独立两包络');
}

// ====== 策略 2：指针活动延长 ======
console.log('指针活动延长:');
{
  const click = mkClick(1000, 900, 500);
  // 点击后指针静默（只有点击前一个点）
  const still: CursorPoint[] = [mkPoint(0, 100, 100), mkPoint(900, 800, 400)];
  const envStill = planClickZoomEnvelopes([click], still, W, H, OPTS());
  assert.ok(Math.abs(envStill[0].endMs - (1000 + 900)) < 5, `静默时保持=点击+hold（${envStill[0].endMs}）`);
  ok('指针静默 → 保持期 = 点击 + 基础 hold');

  // 点击后指针持续动 3s（间隔 0.5s）→ 保持延长到活动末 + settle
  const active: CursorPoint[] = [
    mkPoint(0, 100, 100),
    mkPoint(900, 800, 400),
    mkPoint(1200, 850, 430),
    mkPoint(1700, 870, 450),
    mkPoint(2200, 880, 470),
    mkPoint(2700, 890, 480),
    mkPoint(3200, 895, 490),
    mkPoint(3700, 897, 495),
    mkPoint(4200, 899, 498),
  ];
  const envActive = planClickZoomEnvelopes([click], active, W, H, OPTS());
  // 活动末 4200ms + settle 550 = 4750；基础 1900
  assert.ok(envActive[0].endMs >= 4750 - 5, `活动期保持延长（end=${envActive[0].endMs} ≥ 4750）`);
  ok('指针持续活动 → 保持期延长到活动末 + settle（操作中相机不抽走）');

  // 活动中断 1.5s 后再动 → 只延长到中断前（idleGap 1.4s）
  const gapped: CursorPoint[] = [
    mkPoint(1200, 850, 430),
    mkPoint(1700, 870, 450),
    mkPoint(4000, 900, 500), // 与 1700 间隔 2.3s > 1.4 → 活动断在 1700
  ];
  const envGap = planClickZoomEnvelopes([click], gapped, W, H, OPTS());
  assert.ok(Math.abs(envGap[0].endMs - (1700 + 550)) < 5, `中断后活动不算（end=${envGap[0].endMs} ≈ 2250）`);
  ok('活动间隔 > idleGap → 延长止于中断点');
}

// ====== 策略 3：相接交接（不回零重启） ======
console.log('相接交接:');
{
  // 活动延长把第一包络的保持推到与第二包络起播相接：exit 压 0，交接期缩放连续、focus 平滑移交
  const clicks = [
    mkClick(1000, 900, 500),
    mkClick(3200, 920, 520),
  ];
  const active: CursorPoint[] = [
    mkPoint(1100, 850, 430),
    mkPoint(1500, 870, 450),
    mkPoint(1900, 880, 470),
    mkPoint(2300, 885, 480),
    mkPoint(2700, 890, 485),
    mkPoint(3100, 895, 490),
    mkPoint(3500, 897, 492),
  ];
  const env = planClickZoomEnvelopes(clicks, active, W, H, OPTS());
  assert.equal(env.length, 2, `两爆发两包络（实际 ${env.length}）`);
  assert.ok(env[0].exitMs <= 1, '延长相接后前包络出场清零（直接交接）');
  assert.ok(Math.abs(env[0].endMs - env[1].startMs) <= 1, '首尾相接');
  // 交接中点：缩放保持满格（boost 不回 1），focus 在两焦点之间
  const handoffMid = env[1].startMs + env[1].enterMs / 2;
  const s = sampleClickZoom(env, handoffMid, clicks);
  assert.equal(s.boost, 1.8, `交接期缩放连续（boost=${s.boost}）`);
  const f1 = env[0].focus;
  const f2 = env[1].focus;
  const between = s.focus!.x > Math.min(f1.x, f2.x) && s.focus!.x < Math.max(f1.x, f2.x);
  assert.ok(between, `注视点平滑移交（x=${s.focus!.x.toFixed(0)} 介于 ${f1.x.toFixed(0)} 与 ${f2.x.toFixed(0)}）`);
  ok('相接交接：缩放满格连续 + 注视点平滑移交（不回零重启）');
}

// ====== 策略 4：采样连续性与端点 ======
console.log('采样:');
{
  const clicks = [
    mkClick(1000, 900, 500),
    mkClick(1250, 1000, 560),
    mkClick(1500, 950, 620),
  ];
  const env = planClickZoomEnvelopes(clicks, [], W, H, OPTS());
  // 起播前恒等
  assert.deepEqual(sampleClickZoom(env, 0, clicks).amount, 0);
  // 保持期满格：boost=zoomScale、focus=组焦点、click=最近真实点击
  const full = sampleClickZoom(env, 2000, clicks);
  assert.equal(full.amount, 1);
  assert.equal(full.boost, 1.8);
  assert.equal(full.click, clicks[2], '波纹点击 = 组内 ≤t 的最近真实点击');
  ok('保持期满格（boost=zoomScale，波纹点击=最近真实点击）');

  // 起播提前量：首点击前 18%×enter 已开始
  const early = sampleClickZoom(env, 1000 - 126 + 10, clicks);
  assert.ok(early.amount > 0, '点击前 18% 进场已开始（落点时已就位）');
  ok('提前进场（点击时刻前 0.126s 已在缓入）');

  // 出场终点精确归零
  const end = env[0].endMs + env[0].exitMs;
  assert.equal(sampleClickZoom(env, end + 1, clicks).amount, 0);
  ok('出场终点精确归恒等');

  // 跨帧连续性：全时间轴逐 16.7ms 采样，amount 相邻差 < 0.09（60fps 无跳变）
  let maxJump = 0;
  let prev = 0;
  for (let t = 0; t <= end + 200; t += 16.7) {
    const a = sampleClickZoom(env, t, clicks).amount;
    maxJump = Math.max(maxJump, Math.abs(a - prev));
    prev = a;
  }
  assert.ok(maxJump < 0.09, `相邻帧最大跳变 ${maxJump.toFixed(4)} < 0.09`);
  ok('60fps 逐帧连续（无相邻帧跳变）');

  // 两个独立包络间回落再进入，衔接处也连续
  const two = [mkClick(1000, 200, 200), mkClick(8000, 1700, 900)];
  const env2 = planClickZoomEnvelopes(two, [], W, H, OPTS());
  let maxJump2 = 0;
  let prev2 = 0;
  for (let t = 0; t <= 12000; t += 16.7) {
    const a = sampleClickZoom(env2, t, two).amount;
    maxJump2 = Math.max(maxJump2, Math.abs(a - prev2));
    prev2 = a;
  }
  assert.ok(maxJump2 < 0.09, `双包络相邻帧最大跳变 ${maxJump2.toFixed(4)}`);
  ok('双包络全程连续');

  // 跨屏相接包络：boost 全程不回落（丝滑的本质——缩放不回零重启）
  const span = [mkClick(1000, 200, 200), mkClick(1600, 1700, 900)];
  const env3 = planClickZoomEnvelopes(span, [], W, H, OPTS());
  let minBoostDuring = Infinity;
  for (let t = env3[0].startMs + 300; t <= env3[1].endMs; t += 16.7) {
    minBoostDuring = Math.min(minBoostDuring, sampleClickZoom(env3, t, span).boost);
  }
  assert.ok(Math.abs(minBoostDuring - 1.8) < 1e-9, `相接期间 boost 恒满格（最低 ${minBoostDuring}）`);
  ok('跨屏相接全程 boost 满格（缩放零回落）');
}

// ====== safeInset 焦点钳制 ======
console.log('safeInset:');
{
  const edge = [mkClick(1000, 30, 20), mkClick(1300, 60, 40)];
  const env = planClickZoomEnvelopes(edge, [], W, H, OPTS());
  assert.ok(env[0].focus.x >= 0.12 * W - 1 && env[0].focus.y >= 0.12 * H - 1, `焦点离边钳制 (${env[0].focus.x},${env[0].focus.y})`);
  ok('角落点击焦点钳离边缘 12%（放大后不贴边）');
}

// ====== 退化与防御 ======
console.log('防御:');
{
  assert.deepEqual(planClickZoomEnvelopes([], [], W, H, OPTS()), []);
  assert.deepEqual(planClickZoomEnvelopes([mkClick(0, 1, 1)], [], 0, 0, OPTS()), []);
  assert.deepEqual(planClickZoomEnvelopes([mkClick(0, 1, 1)], [], W, H, OPTS({zoomScale: 1})), []);
  assert.equal(sampleClickZoom([], 1000).amount, 0);
  // NaN/负时间点击被过滤
  const dirty = [mkClick(-500, 100, 100), mkClick(NaN as unknown as number, 200, 200), mkClick(1000, 900, 500)];
  const env = planClickZoomEnvelopes(dirty, [], W, H, OPTS());
  assert.equal(env.length, 1, '脏点击被过滤');
  ok('空输入/非法尺寸/zoomScale=1/脏点击 全部安全退化');
}

// ====== 聚焦蒙版（D 项 + 一.3 锚定内容修复） ======
console.log('聚焦蒙版:');
{
  const cam = {scale: 1.9, translateX: -300, translateY: -100};
  const focus = {x: 1200, y: 600};
  const dimOn = {focusDimOn: 1, focusDimBlur: 6, focusDimSize: 0.3, focusDimDark: 0.25, focusDimTarget: 0};
  // 关 / 无包络 / 零强度 → 不挂层（零成本）
  assert.equal(focusMaskState({...dimOn, focusDimOn: 0}, {amount: 1, focus}, cam, W, H, W, H), null);
  assert.equal(focusMaskState(dimOn, {amount: 0, focus}, cam, W, H, W, H), null);
  assert.equal(focusMaskState(dimOn, {amount: 1, focus: null}, cam, W, H, W, H), null);
  ok('开关关/无包络/无焦点 → null（不挂层）');
  // 几何：中心 = 焦点经相机映射（planeW/2 + scale×(fx−videoW/2) + tx）
  const g = focusMaskState(dimOn, {amount: 1, focus}, cam, W, H, W, H)!;
  const expectCx = W / 2 + cam.scale * (focus.x - W / 2) + cam.translateX;
  const expectCy = H / 2 + cam.scale * (focus.y - H / 2) + cam.translateY;
  assert.ok(Math.abs(g.cx - expectCx) < 1e-9 && Math.abs(g.cy - expectCy) < 1e-9);
  assert.ok(Math.abs(g.r - 0.3 * H) < 1e-9, '清晰区半径 = size × 平面短边');
  ok(`蒙版中心=锚点相机映射 (${g.cx.toFixed(0)},${g.cy.toFixed(0)})`);
  // 横向椭圆（一.3）：清晰区 X 方向拉长适配文字行
  assert.ok(g.aspect > 1.5, `清晰区横向拉长比 ${g.aspect}（文字行/输入框横向内容）`);
  ok('横向椭圆清晰区（打字场景文字行整行可读）');
  // 指针跟随模式（一.3）：中心跟随当前注视点而非组焦点
  const pointer = {x: 400, y: 300};
  const gp = focusMaskState({...dimOn, focusDimTarget: 1}, {amount: 1, focus}, cam, W, H, W, H, pointer)!;
  const expectPx = W / 2 + cam.scale * (pointer.x - W / 2) + cam.translateX;
  assert.ok(Math.abs(gp.cx - expectPx) < 1e-9, `指针模式中心=注视点映射（${gp.cx.toFixed(0)}）`);
  // 指针模式无 anchor（无轨迹降级）→ 回退组焦点
  const gf = focusMaskState({...dimOn, focusDimTarget: 1}, {amount: 1, focus}, cam, W, H, W, H, null)!;
  assert.ok(Math.abs(gf.cx - expectCx) < 1e-9);
  ok('指针跟随模式（内容不在点击点处时视线跟手；无注视点回退组焦点）');
  // 透明度随包络强度（与相机弹簧同参）
  const half = focusMaskState(dimOn, {amount: 0.5, focus}, cam, W, H, W, H)!;
  assert.ok(Math.abs(half.opacity - 0.5) < 1e-9);
  ok('透明度 = 包络强度（与相机缩放同参淡入淡出）');
  // 参数越界钳制
  const dirty = focusMaskState(
    {focusDimOn: 1, focusDimBlur: 99, focusDimSize: 2, focusDimDark: -3, focusDimTarget: 0},
    {amount: 1, focus}, cam, W, H, W, H,
  )!;
  assert.equal(dirty.blur, 16);
  assert.equal(dirty.dark, 0);
  assert.ok(Math.abs(dirty.r - 0.5 * H) < 1e-9, 'size 钳上限 0.5');
  ok('参数越界钳制（blur≤16 / dark≥0 / size≤0.5）');
}

// ====== 悬停浮卡（一.2） ======
console.log('悬停浮卡:');
{
  const OPTS = {videoW: W, videoH: H};
  // 悬停检测：1.2s 驻留 → 事件；短暂停顿（300ms）不算
  const track: CursorPoint[] = [
    mkPoint(0, 100, 100),
    mkPoint(200, 300, 300),
    mkPoint(400, 900, 500), mkPoint(700, 905, 502), mkPoint(1000, 908, 498), mkPoint(1200, 902, 503), mkPoint(1400, 910, 500), mkPoint(1600, 906, 497),
    mkPoint(2200, 1500, 800), // 移出半径（>stillR≈11.5px…距离 (600,300) 远超）
  ];
  const ev = hoverClusters(track, undefined, OPTS);
  assert.equal(ev.length, 1, `应检出 1 个悬停事件，实际 ${ev.length}`);
  const dwell = track.filter((p) => p.t >= 400 && p.t <= 1600);
  const meanX = dwell.reduce((a, p) => a + p.x, 0) / dwell.length;
  const meanY = dwell.reduce((a, p) => a + p.y, 0) / dwell.length;
  assert.ok(Math.abs(ev[0].x - meanX) < 1e-9 && Math.abs(ev[0].y - meanY) < 1e-9 && ev[0].t1 <= 1600,
    `驻留中心=均值 (${ev[0].x.toFixed(1)},${ev[0].y.toFixed(1)})`);
  ok('驻留 ≥550ms 检出事件，中心=驻留段均值');

  const short: CursorPoint[] = [
    mkPoint(0, 100, 100), mkPoint(200, 900, 500), mkPoint(400, 902, 501), mkPoint(600, 904, 499), mkPoint(1000, 1500, 800),
  ];
  assert.equal(hoverClusters(short, undefined, OPTS).length, 0, '400ms 驻留不够阈值');
  ok('短于 hoverMs 的停顿不产生事件');

  // 点击让位：事件结束后 400ms 内有点击 → 剔除
  const clickSoon: CursorClick[] = [mkClick(1750, 1600, 850)];
  assert.equal(hoverClusters(track, clickSoon, OPTS).length, 0, '点前犹豫让位点击');
  const clickLate: CursorClick[] = [mkClick(3000, 1600, 850)];
  assert.equal(hoverClusters(track, clickLate, OPTS).length, 1, '点击在让位窗外 → 事件保留');
  ok('结束后 400ms 内的点击让位（点前犹豫不弹卡）');

  // 浮卡包络：驻留满 550ms（appearAt=950）后生长；指针移走后收场
  const card = hoverCardState(ev, track, 900, OPTS); // 900 < 400+550 未到
  assert.equal(card, null, '驻留未满阈值前无卡');
  const growing = hoverCardState(ev, track, 1060, OPTS)!; // appear 中点（950+110）
  assert.ok(growing.scale > 0 && growing.scale < 1 && growing.opacity === 1, `生长中 scale=${growing.scale.toFixed(2)}`);
  const full = hoverCardState(ev, track, 1600, OPTS)!;
  assert.equal(full.scale, 1);
  const exiting = hoverCardState(ev, track, 1700, OPTS)!; // 移走后 100ms
  assert.ok(exiting.opacity < 1 && exiting.opacity > 0, `退场中 opacity=${exiting.opacity.toFixed(2)}`);
  assert.equal(hoverCardState(ev, track, 2200, OPTS), null, '退场完无卡');
  ok('浮卡包络：驻留满→生长→保持→移走收场');
}

console.log(`\n${passed} 项通过`);
