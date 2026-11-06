/**
 * 导播分析器（shared/director-plan.ts）单元测试：
 * 停顿检测 / 点击锚定与聚簇 / 能量景别 / 相邻景别互异 / 时长界与无缝覆盖 /
 * 倾斜循环 / 过渡分级 / 采样空洞鲁棒 / 确定性 / 兜底与钳制。
 *
 * 合成轨迹按真实采集口径生成（30Hz 帧级、静止位移精确为 0，见 M1 实测）。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/director-plan.test.ts
 */

import assert from 'node:assert/strict';

const {planDirectorShots, buildActivityCurve, DIRECTOR_DEFAULTS, SHOT_ZOOM} = await import('../../src/shared/director-plan.ts');

type Shot = ReturnType<typeof planDirectorShots>[number];

const VW = 1000;
const VH = 1000;
let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 合成轨迹段：still = 原地不动；move = from→to 线性移动（坐标为视频像素） */
interface Seg {
  from: number;
  to: number;
  kind: 'still' | 'move';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
}
/** 按 30Hz 帧级采样生成 sidecar 口径的输入（与真实采集同构） */
const synth = (segs: Seg[], clicks: {t: number; x: number; y: number}[] = [], dur?: number) => {
  const points: {t: number; x: number; y: number}[] = [];
  for (const s of segs) {
    const steps = Math.max(1, Math.round((s.to - s.from) * 30));
    for (let k = 0; k <= steps; k++) {
      const r = k / steps;
      points.push({
        t: Math.round((s.from + (s.to - s.from) * r) * 1000),
        x: s.kind === 'still' ? (s.x ?? 500) : (s.x ?? 0) + ((s.x2 ?? 1000) - (s.x ?? 0)) * r,
        y: s.kind === 'still' ? (s.y ?? 500) : (s.y ?? 0) + ((s.y2 ?? 1000) - (s.y ?? 0)) * r,
      });
    }
  }
  return {
    points,
    clicks: clicks.map((c) => ({...c, button: 1})),
    videoWidth: VW,
    videoHeight: VH,
    durationSec: dur ?? Math.max(...segs.map((s) => s.to)),
  };
};

/** 全片硬性不变量：无缝覆盖 / 相邻景别与倾斜互异 / 时长界 / focus 域 / trans 域 */
const assertPlanValid = (shots: Shot[], dur: number, label: string) => {
  assert.ok(shots.length >= 1, `${label}: 至少一个镜头`);
  assert.equal(shots[0].t0, 0, `${label}: 从 0 开始`);
  assert.ok(Math.abs(shots[shots.length - 1].t1 - dur) < 0.011, `${label}: 末镜到片尾 (${shots[shots.length - 1].t1} vs ${dur})`);
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    assert.ok(s.t1 > s.t0, `${label} #${i}: 时长为正`);
    assert.ok(['wide', 'medium', 'close'].includes(s.scale), `${label} #${i}: 景别合法`);
    assert.ok([-2, 0, 2].includes(s.tilt), `${label} #${i}: 倾斜档位合法`);
    assert.ok(['click', 'pause', 'energy', 'coverage'].includes(s.reason), `${label} #${i}: 依据合法`);
    if (s.scale === 'wide') assert.equal(s.focus, null, `${label} #${i}: 大景无焦点`);
    if (s.focus) {
      assert.ok(s.focus.x >= 0.04 && s.focus.x <= 0.96 && s.focus.y >= 0.04 && s.focus.y <= 0.96, `${label} #${i}: focus 在画面内`);
    }
    if (i === 0) {
      assert.equal(s.trans, 'cut', `${label} #0: 首镜硬切入`);
    } else {
      const p = shots[i - 1];
      assert.ok(Math.abs(s.t0 - p.t1) < 0.0011, `${label} #${i}: 与前一镜无缝 (${s.t0} vs ${p.t1})`);
      assert.notEqual(s.scale, p.scale, `${label} #${i}: 相邻景别必不同`);
      assert.notEqual(s.tilt, p.tilt, `${label} #${i}: 相邻倾斜必不同`);
      const jump = Math.abs(['wide', 'medium', 'close'].indexOf(s.scale) - ['wide', 'medium', 'close'].indexOf(p.scale));
      assert.equal(s.trans, jump >= 2 ? 'whoosh' : 'cut', `${label} #${i}: 过渡分级（跨两级 whoosh）`);
    }
    if (dur >= 1.2) assert.ok(s.t1 - s.t0 >= 1.19, `${label} #${i}: 时长 ${s.t1 - s.t0} ≥ 1.2s`);
    assert.ok(s.t1 - s.t0 <= 4.62, `${label} #${i}: 时长 ${s.t1 - s.t0} ≤ 4.6s（含吸收外溢）`);
  }
};

console.log('兜底与退化输入:');
{
  const shots = planDirectorShots({points: [], clicks: [], videoWidth: VW, videoHeight: VH, durationSec: 8});
  assert.equal(shots.length, 1);
  assert.equal(shots[0].scale, 'wide');
  assert.equal(shots[0].reason, 'coverage');
  assert.equal(shots[0].t1, 8);
  ok('空轨迹 → 单个全覆盖大景');

  const tiny = planDirectorShots(synth([{from: 0, to: 0.8, kind: 'move', x: 0, y: 0, x2: 800, y2: 600}]));
  assert.equal(tiny.length, 1);
  assertPlanValid(tiny, 0.8, '超短素材');
  ok('0.8s 素材 → 单镜头全覆盖（不套时长下限）');
}

console.log('停顿检测与大景:');
{
  const shots = planDirectorShots(synth([{from: 0, to: 10, kind: 'still', x: 400, y: 300}]));
  assertPlanValid(shots, 10, '全程静止');
  assert.ok(shots.every((s) => s.reason === 'pause'), '全部按停顿划分');
  assert.ok(shots.some((s) => s.scale === 'wide'), '有上下文大景');
  ok('全程静止 10s → 停顿切分，镜头互异且全覆盖');
}

console.log('点击锚定:');
{
  const shots = planDirectorShots(
    synth([{from: 0, to: 10, kind: 'still', x: 400, y: 300}], [{t: 3000, x: 700, y: 500}]),
  );
  const clickShot = shots.find((s) => s.reason === 'click');
  assert.ok(clickShot, '存在点击小景');
  assert.equal(clickShot.scale, 'close');
  assert.ok(clickShot.t0 <= 3 && clickShot.t1 >= 3, `点击时刻被小景覆盖 [${clickShot.t0},${clickShot.t1}]`);
  const center = (clickShot.t0 + clickShot.t1) / 2;
  assert.ok(Math.abs(center - 3) <= 0.2, `点击近小景中心（偏差 ${Math.abs(center - 3)}s）`);
  assert.ok(clickShot.focus && Math.abs(clickShot.focus.x - 0.7) < 0.01 && Math.abs(clickShot.focus.y - 0.5) < 0.01, 'focus = 点击点归一化坐标');
  assertPlanValid(shots, 10, '单点击');
  ok('单点击 → 小景含点击、focus 落点击点、近似居中');

  const cluster = planDirectorShots(
    synth([{from: 0, to: 10, kind: 'still'}], [{t: 3000, x: 600, y: 400}, {t: 4300, x: 640, y: 420}]),
  );
  const clickShots = cluster.filter((s) => s.reason === 'click');
  assert.equal(clickShots.length, 1, '相隔 1.3s 的两击并进同一小景');
  assert.ok(clickShots[0].t0 <= 3 && clickShots[0].t1 >= 4.3, '小景覆盖两次点击');
  assertPlanValid(cluster, 10, '点击聚簇');
  ok('点击聚簇（间隔 ≤2.2s → 同一小景）');

  const tail = planDirectorShots(
    synth([{from: 0, to: 10, kind: 'still'}], [{t: 9500, x: 500, y: 500}]),
  );
  const tailShot = tail.find((s) => s.reason === 'click');
  assert.ok(tailShot, '末尾点击仍出小景');
  assert.ok(tailShot.t0 <= 9.5 && tailShot.t1 >= 9.5, '末尾点击被覆盖');
  assertPlanValid(tail, 10, '末尾点击');
  ok('9.5s 处点击 → 小景钳到片尾且 ≥1.2s');

  const corner = planDirectorShots(
    synth([{from: 0, to: 10, kind: 'still'}], [{t: 3000, x: 2, y: 3}]),
  );
  const cornerShot = corner.find((s) => s.reason === 'click');
  assert.ok(cornerShot.focus && cornerShot.focus.x >= 0.04 && cornerShot.focus.y >= 0.04, '角落点击 focus 被钳进画面');
  ok('角落点击 focus 钳制（不越出画面）');
}

console.log('能量景别与运动/静止交替:');
{
  const shots = planDirectorShots(synth([
    {from: 0, to: 4, kind: 'move', x: 100, y: 100, x2: 900, y2: 800},
    {from: 4, to: 9, kind: 'still', x: 900, y: 800},
  ]));
  assertPlanValid(shots, 9, '活动+停顿');
  const before = shots.filter((s) => s.t1 <= 4.01);
  const after = shots.filter((s) => s.t0 >= 3.99);
  assert.ok(before.length >= 1, '活动段有镜头');
  assert.ok(before.every((s) => s.scale !== 'wide'), '高活动段不出大景');
  assert.ok(after.some((s) => s.reason === 'pause' && s.scale === 'wide'), '停顿段出大景');
  ok('快移 4s + 静止 5s → 活动段中/小景、停顿段大景');

  const mediumShots = planDirectorShots(synth([
    {from: 0, to: 10, kind: 'move', x: 100, y: 100, x2: 160, y2: 130},
  ]));
  assertPlanValid(mediumShots, 10, '低活动');
  ok('低活动匀速移动 → 能量镜头切分且互异');
}

console.log('倾斜循环与过渡分级:');
{
  const shots = planDirectorShots(synth([
    {from: 0, to: 3, kind: 'still'},
    {from: 3, to: 3.2, kind: 'move', x: 500, y: 500, x2: 700, y2: 600},
    {from: 3.2, to: 8, kind: 'still', x: 700, y: 600},
  ], [{t: 3200, x: 700, y: 600}]));
  const cycle = [0, -2, 0, 2];
  shots.forEach((s, i) => assert.equal(s.tilt, cycle[i % 4], `# ${i} 倾斜按 0/-2/0/+2 循环`));
  const jumpPair = shots.findIndex((s, i) => i > 0 && Math.abs(['wide', 'medium', 'close'].indexOf(s.scale) - ['wide', 'medium', 'close'].indexOf(shots[i - 1].scale)) >= 2);
  if (jumpPair > 0) assert.equal(shots[jumpPair].trans, 'whoosh', '跨两级景别 → whoosh');
  ok('倾斜 0/-2/0/+2 循环；跨两级 whoosh');
}

console.log('鲁棒性与确定性:');
{
  // 采样空洞：0.35s 无点（超过 200ms 空洞阈），两侧正常移动
  const holed = synth([
    {from: 0, to: 2, kind: 'move', x: 100, y: 100, x2: 500, y2: 300},
    {from: 2.35, to: 5, kind: 'move', x: 500, y: 300, x2: 800, y2: 600},
  ]);
  const shots = planDirectorShots(holed);
  assertPlanValid(shots, 5, '采样空洞');
  ok('0.35s 采样空洞 → 不出 NaN、覆盖完整');

  const track = synth([
    {from: 0, to: 3, kind: 'move', x: 0, y: 0, x2: 600, y2: 400},
    {from: 3, to: 6, kind: 'still', x: 600, y: 400},
  ], [{t: 4500, x: 620, y: 420}]);
  const a = planDirectorShots(track);
  const b = planDirectorShots(track);
  assert.equal(JSON.stringify(a), JSON.stringify(b), '同输入两次调用输出一致');
  assertPlanValid(a, 6, '确定性样例');
  ok('确定性：同输入 → 同计划');

  const withClick = planDirectorShots(synth(
    [{from: 0, to: 6, kind: 'still', x: 600, y: 400}],
    [{t: 4500, x: 620, y: 420}],
  ));
  assertPlanValid(withClick, 6, '静止带点击');
  const c = withClick.find((s) => s.reason === 'click');
  assert.ok(c, '静止素材中的点击仍锚出小景');
  ok('静止素材 + 点击 → 停顿绕开点击小景');
}

console.log('导出常量与曲线:');
{
  assert.equal(SHOT_ZOOM.wide, 1);
  assert.ok(SHOT_ZOOM.medium > 1 && SHOT_ZOOM.close > SHOT_ZOOM.medium);
  assert.equal(DIRECTOR_DEFAULTS.maxShotSec, 4.0);
  const bins = buildActivityCurve(
    [{t: 0, x: 0, y: 0}, {t: 100, x: 100, y: 0}, {t: 200, x: 200, y: 0}],
    [],
    0.5,
    0.1,
  );
  assert.equal(bins.length, 5);
  assert.ok(bins[1].energy > 0, '移动记在到达点的 bin');
  assert.ok(bins[3].energy === 0, '无点 bin 能量为零');
  ok('活动曲线 bin 划分与常量导出');
}

console.log('内容确认窗约束（cue 表 → 导播小景只落窗内）:');
{
  const base = synth([{from: 0, to: 6, kind: 'still', x: 600, y: 400}], [{t: 4500, x: 620, y: 420}]);
  const clickOf = (shots: Shot[]) => shots.find((s) => s.reason === 'click');
  assert.equal(clickOf(planDirectorShots(base))?.scale, 'close', '基线：未声明窗时点击锚小景');
  ok('未声明内容窗 → 行为与历史一致');

  const inWin = planDirectorShots({...base, contentWindows: [{t0: 3.5, t1: 5.5}]});
  assert.equal(clickOf(inWin)?.scale, 'close', '窗内点击保留小景');
  assertPlanValid(inWin, 6, '窗内点击');
  const outWin = planDirectorShots({...base, contentWindows: [{t0: 0, t1: 1}]});
  assert.equal(clickOf(outWin)?.scale, 'medium', '窗外点击降中景');
  assertPlanValid(outWin, 6, '窗外点击');
  ok('点击锚：窗内小景 / 窗外中景');

  // 快-慢-快-慢活动分布：窗盖住开头 2.4s（覆盖首镜 ≥60%），后半段高速活动不得出小景
  const fast = synth([
    {from: 0, to: 1.5, kind: 'move', x: 0, y: 100, x2: 1000, y2: 600},
    {from: 1.5, to: 3, kind: 'move', x: 1000, y: 600, x2: 700, y2: 600},
    {from: 3, to: 4.5, kind: 'move', x: 700, y: 600, x2: 0, y2: 300},
    {from: 4.5, to: 6, kind: 'move', x: 0, y: 300, x2: 0, y2: 100},
  ]);
  const constrained = planDirectorShots({...fast, contentWindows: [{t0: 0, t1: 2.4}]});
  assertPlanValid(constrained, 6, '能量约束');
  const closes = constrained.filter((s) => s.scale === 'close');
  assert.ok(closes.length >= 1, '窗内活动仍出小景');
  for (const s of closes) {
    const mid = (s.t0 + s.t1) / 2;
    assert.ok(mid <= 2.4, `小景必须落在内容窗一侧 (mid=${mid})`);
  }
  ok('能量小景：窗外活动降中景');

  // 跨窗边缘回归（v10 a3 [8.7,11.5] 中点测试漏网）：窗只盖 1.5s，两镜均不过半重叠 → 全片无小景
  const straddle = planDirectorShots({...fast, contentWindows: [{t0: 0, t1: 1.5}]});
  assertPlanValid(straddle, 6, '跨窗边缘');
  assert.equal(straddle.filter((s) => s.scale === 'close').length, 0, '跨窗不过半的镜头不得为小景');
  ok('跨窗边缘：大部分重叠才允许小景（中点测试漏网回归）');
}

console.log('内容拟合缩放（zoomFit 随演示目标尺寸走）:');
{
  // 小区域点击（悬停+点击都聚在 60px 内）→ close 镜头 zoomFit 应显著大（重特写）
  const small = synth([
    {from: 0, to: 3, kind: 'still', x: 500, y: 400},
    {from: 3, to: 3.4, kind: 'move', x: 500, y: 400, x2: 530, y2: 430},
    {from: 3.4, to: 6, kind: 'still', x: 530, y: 430},
  ], [{t: 3200, x: 530, y: 430}]);
  const planSmall = planDirectorShots(small);
  const zfSmall = planSmall.filter((s) => s.scale === 'close' && s.zoomFit !== undefined);
  assert.ok(zfSmall.length >= 1, '小目标特写有拟合缩放');
  assert.ok(zfSmall.every((s) => s.zoomFit >= 2), `小目标拟合缩放应 ≥2 (got ${zfSmall.map((s) => s.zoomFit).join(',')})`);
  assertPlanValid(planSmall, 6, '小目标拟合');
  ok('小目标点击 → 拟合缩放显著大（重特写）');

  // 全屏快速扫过 → 能量镜头 zoomFit 应小（轻推近，不为无目标区域乱放大）
  const sweep = synth([{from: 0, to: 6, kind: 'move', x: 0, y: 0, x2: 1000, y2: 1000}]);
  const planSweep = planDirectorShots(sweep);
  const zfSweep = planSweep.filter((s) => s.scale !== 'wide' && s.zoomFit !== undefined);
  assert.ok(zfSweep.length >= 1, '全屏扫过镜头有拟合缩放');
  assert.ok(zfSweep.every((s) => s.zoomFit <= 1.6), `全屏扫过拟合缩放应 ≤1.6 (got ${zfSweep.map((s) => s.zoomFit).join(',')})`);
  assertPlanValid(planSweep, 6, '全屏拟合');
  ok('全屏扫过 → 拟合缩放小（轻推近不乱放大）');
}

console.log(`\n共 ${passed} 项断言全部通过`);
