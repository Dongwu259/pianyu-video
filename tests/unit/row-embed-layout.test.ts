/**
 * row-embed-layout 单测：RowEmbed 节拍与四画幅版式（设计稿 §六/§七/§八.1）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/row-embed-layout.test.ts
 */
import assert from 'node:assert/strict';
import {
  ROW_EMBED_MAX_ROWS,
  planRowEmbed,
  planRowEmbedTiming,
  rowEmbedAspectOf,
  rowEmbedRowCount,
  type RowEmbedAspect,
} from '../../src/shared/row-embed-layout.ts';
import {ROW_EMBED_PARAMS} from '../../src/shared/template-registry.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

/** 四画幅的常用画布尺寸与 body token（getScaledTokens 取值，1920 基准 × 竖版 1.35 / 宽幅封顶） */
const CANVAS: Record<RowEmbedAspect | '21-9', {w: number; h: number; body: number}> = {
  standard: {w: 1920, h: 1080, body: 28},
  '21-9': {w: 2560, h: 1080, body: 28}, // wideAspectCap 压回 16:9 等效密度
  square: {w: 1080, h: 1080, body: 15.75},
  portrait: {w: 1080, h: 1920, body: 21.3},
};

const planFor = (
  canvas: {w: number; h: number; body: number},
  over: Partial<Parameters<typeof planRowEmbed>[0]> = {},
) =>
  planRowEmbed({
    canvasW: canvas.w,
    canvasH: canvas.h,
    totalFrames: 150, // 5s
    featureCount: 4,
    hasMedia: true,
    bodyFontPx: canvas.body,
    ...over,
  });

console.log('row-embed-layout:');

t('画幅识别四档：16:9 基线 / 21:9 wide / 1:1 square / 9:16 portrait', () => {
  assert.equal(rowEmbedAspectOf(1920, 1080), 'standard');
  assert.equal(rowEmbedAspectOf(2560, 1080), 'wide');
  assert.equal(rowEmbedAspectOf(1080, 1080), 'square');
  assert.equal(rowEmbedAspectOf(1080, 1920), 'portrait');
  assert.equal(rowEmbedAspectOf(1080, 1350), 'portrait'); // 4:5 也算竖版
});

t('行数上限：16:9/9:16 收 4，21:9/1:1 收 3；超 4 条只取前 4；短段再降到 3', () => {
  assert.equal(rowEmbedRowCount({featureCount: 6, totalFrames: 150, aspect: 'standard'}), 4);
  assert.equal(rowEmbedRowCount({featureCount: 6, totalFrames: 150, aspect: 'portrait'}), 4);
  assert.equal(rowEmbedRowCount({featureCount: 6, totalFrames: 150, aspect: 'wide'}), 3);
  assert.equal(rowEmbedRowCount({featureCount: 6, totalFrames: 150, aspect: 'square'}), 3);
  assert.equal(rowEmbedRowCount({featureCount: 2, totalFrames: 150, aspect: 'standard'}), 2);
  assert.equal(rowEmbedRowCount({featureCount: 0, totalFrames: 150, aspect: 'standard'}), 0);
  // 2.4s = 72f < 2.5s：即使 4 条也降到 3
  assert.equal(rowEmbedRowCount({featureCount: 4, totalFrames: 72, aspect: 'standard'}), 3);
  assert.equal(ROW_EMBED_MAX_ROWS, 4);
});

t('节拍公式：首行 = round(0.18N)，cues 严格递增，FLY 固定 12f（速度 1）', () => {
  const timing = planRowEmbedTiming({totalFrames: 150, rows: 4, flySpeed: 1, staggerDecel: 0.3});
  assert.equal(timing.cues[0], Math.round(150 * 0.18));
  assert.equal(timing.flyFrames, 12);
  for (let i = 1; i < timing.cues.length; i++) assert.ok(timing.cues[i] > timing.cues[i - 1], `cue ${i}`);
  assert.deepEqual(timing.landFrames, timing.cues.map((c) => c + 12));
});

t('节拍递减：decel 0.3 时间隔逐行变短（越落越快）；decel 0 时等间隔', () => {
  const decel = planRowEmbedTiming({totalFrames: 150, rows: 4, flySpeed: 1, staggerDecel: 0.3});
  for (let i = 1; i < decel.steps.length - 1; i++) {
    assert.ok(decel.steps[i] <= decel.steps[i - 1], `step ${i} 未递减: ${decel.steps}`);
  }
  assert.ok(decel.steps[decel.steps.length - 2] < decel.steps[0], `末段间隔应明显更短: ${decel.steps}`);

  const even = planRowEmbedTiming({totalFrames: 150, rows: 4, flySpeed: 1, staggerDecel: 0});
  const head = even.steps.slice(0, -1);
  assert.ok(head.every((s) => Math.abs(s - head[0]) <= 1), `匀速档步长应一致: ${even.steps}`);
});

t('flySpeed → 飞行帧数：0.6→20 / 1→12 / 1.6→8；不随段长拉伸', () => {
  assert.equal(planRowEmbedTiming({totalFrames: 150, rows: 4, flySpeed: 0.6}).flyFrames, 20);
  assert.equal(planRowEmbedTiming({totalFrames: 150, rows: 4, flySpeed: 1}).flyFrames, 12);
  assert.equal(planRowEmbedTiming({totalFrames: 150, rows: 4, flySpeed: 1.6}).flyFrames, 8);
  const short = planRowEmbedTiming({totalFrames: 90, rows: 2, flySpeed: 1});
  const long = planRowEmbedTiming({totalFrames: 300, rows: 2, flySpeed: 1});
  assert.equal(short.flyFrames, long.flyFrames);
});

t('末行落地 ≤ 0.7N（行数 4/2/1 × 5s/6s），保持帧 = N − 末落地', () => {
  for (const totalFrames of [150, 180]) {
    for (const rows of [4, 2, 1]) {
      const plan = planRowEmbed({
        canvasW: 1920, canvasH: 1080, totalFrames, featureCount: rows, hasMedia: true, bodyFontPx: 28,
      });
      const landLast = plan.landFrames[plan.rows - 1];
      assert.ok(landLast <= totalFrames * 0.7 + 1, `rows=${rows} N=${totalFrames} land=${landLast}`);
      assert.equal(plan.holdFrames, totalFrames - landLast);
      assert.ok(plan.holdFrames > 0);
    }
  }
});

t('短段（1.2s）不越界：落地 ≤ N、保持帧非负、行数 ≤3', () => {
  const plan = planRowEmbed({
    canvasW: 1920, canvasH: 1080, totalFrames: 36, featureCount: 4, hasMedia: true, bodyFontPx: 28,
  });
  assert.ok(plan.rows <= 3, `rows=${plan.rows}`);
  const landLast = plan.landFrames[plan.rows - 1];
  assert.ok(landLast <= 36, `land=${landLast}`);
  assert.ok(plan.holdFrames >= 0);
});

t('四画幅面板宽：16:9 66% / 21:9 56% / 1:1 80% / 9:16 88%，且左右留白满足安全区', () => {
  const std = planFor(CANVAS.standard);
  assert.equal(std.panelW, Math.round(1920 * 0.66));
  const wide = planFor(CANVAS['21-9']);
  assert.equal(wide.panelW, Math.round(2560 * 0.56));
  assert.ok(wide.panelLeft >= 2560 * 0.1, `21:9 左右留白应 ≥10%：left=${wide.panelLeft}`);
  const square = planFor(CANVAS.square);
  assert.equal(square.panelW, Math.round(1080 * 0.8));
  const portrait = planFor(CANVAS.portrait);
  assert.equal(portrait.panelW, Math.round(1080 * 0.88));
  for (const canvas of Object.values(CANVAS)) {
    const plan = planFor(canvas);
    assert.ok(plan.panelLeft >= canvas.w * 0.06, `左右安全区 ≥6%: ${plan.panelLeft}/${canvas.w}`);
    assert.ok(plan.panelLeft + plan.panelW <= canvas.w, '面板不越画布右边');
  }
});

t('四画幅面板高 ≤ 画框 86%（checkpoint ③ 的规划侧兜底）', () => {
  for (const [name, canvas] of Object.entries(CANVAS)) {
    for (const featureCount of [4, 6]) {
      const plan = planFor(canvas, {featureCount});
      assert.ok(
        plan.panelH <= Math.round(canvas.h * 0.86),
        `${name} rows=${plan.rows} panelH=${plan.panelH} / ${canvas.h}`,
      );
      assert.ok(plan.rowH >= plan.rowTextPx * 1.15, `${name} 行高压到文字以下`);
    }
  }
});

t('面板内容装配恒等式：padY×2 + 头部 + 行区 + 页脚 = panelH（未触顶时）', () => {
  for (const canvas of Object.values(CANVAS)) {
    const plan = planFor(canvas);
    const sum = plan.padY * 2 + plan.headerH + plan.rows * plan.rowH + plan.footerH;
    assert.ok(Math.abs(sum - plan.panelH) <= 1, `装配 ${sum} vs panelH ${plan.panelH}`);
  }
});

t('行纹理条带：16:9 18% / 21:9 16% / 1:1 20% 内容宽；9:16 恒 0；无素材或 rowMedia=0 退化 0', () => {
  const std = planFor(CANVAS.standard);
  assert.equal(std.mediaBandW, Math.round(std.contentW * 0.18));
  assert.equal(planFor(CANVAS['21-9']).mediaBandW, Math.round(planFor(CANVAS['21-9']).contentW * 0.16));
  assert.equal(planFor(CANVAS.square).mediaBandW, Math.round(planFor(CANVAS.square).contentW * 0.2));
  assert.equal(planFor(CANVAS.portrait).mediaBandW, 0);
  assert.equal(planFor(CANVAS.standard, {params: {rowMedia: 0}}).mediaBandW, 0);
  assert.equal(planFor(CANVAS.standard, {hasMedia: false}).mediaBandW, 0);
  assert.equal(planFor(CANVAS.standard, {featureCount: 0}).mediaBandW, 0);
});

t('竖版安全区：panelTop 被 safeTop/safeBottom 钳制且面板不越界', () => {
  const safeTop = Math.round(1920 * 0.1);
  const safeBottom = Math.round(1920 * 0.18);
  const plan = planFor(CANVAS.portrait, {safeTop, safeBottom});
  assert.ok(plan.panelTop >= safeTop, `panelTop=${plan.panelTop}`);
  assert.ok(plan.panelTop + plan.panelH <= 1920 - safeBottom, '面板不进入底部署名区');
  // 极端安全区（面板比可用高还高）不产生负/越界坐标
  const tight = planFor(CANVAS.portrait, {safeTop: 900, safeBottom: 900});
  assert.ok(tight.panelTop >= 900);
  assert.ok(Number.isFinite(tight.panelTop));
});

t('相机推近：0.06 × camPush，竖版 0.5 档封顶', () => {
  assert.ok(Math.abs(planFor(CANVAS.standard, {params: {camPush: 0.7}}).camScale - 0.042) < 1e-9);
  assert.ok(Math.abs(planFor(CANVAS.portrait, {params: {camPush: 1}}).camScale - 0.03) < 1e-9);
  assert.equal(planFor(CANVAS.standard, {params: {camPush: 0}}).camScale, 0);
});

t('空文案槽收缩面板：无标题/副标题/品牌 → 面板更矮', () => {
  const full = planFor(CANVAS.standard);
  const bare = planFor(CANVAS.standard, {hasTitle: false, hasSubtitle: false, hasBrand: false});
  assert.ok(bare.panelH < full.panelH, `${bare.panelH} vs ${full.panelH}`);
  // 头部只剩「头部→行区」的间距，页脚整块消失
  assert.ok(bare.headerH < full.headerH, `${bare.headerH} vs ${full.headerH}`);
  assert.equal(bare.footerH, 0);
});

t('无 features：rows=0、cues 空、hold=全段、只剩面板头尾', () => {
  const plan = planFor(CANVAS.standard, {featureCount: 0});
  assert.equal(plan.rows, 0);
  assert.deepEqual(plan.cues, []);
  assert.deepEqual(plan.landFrames, []);
  assert.equal(plan.holdFrames, 150);
  assert.equal(plan.mediaBandW, 0);
  assert.ok(plan.panelH > 0 && plan.panelH < 1080 * 0.86);
});

t('参数防御：NaN/缺失回默认，不产出 NaN 坐标', () => {
  const plan = planRowEmbed({
    canvasW: 1920, canvasH: 1080, totalFrames: 150, featureCount: 3, hasMedia: true, bodyFontPx: 28,
    params: {flySpeed: Number.NaN, staggerDecel: Number.NaN, camPush: Number.NaN, rowsTextScale: Number.NaN},
  });
  assert.equal(plan.flyFrames, 12);
  assert.ok(Number.isFinite(plan.panelH) && Number.isFinite(plan.panelTop));
  assert.ok(plan.cues.every((c) => Number.isFinite(c)));
});

t('参数规格表：9 项、键唯一、默认值落在区间、开关为 0/1 整数档', () => {
  assert.equal(ROW_EMBED_PARAMS.length, 9);
  const keys = ROW_EMBED_PARAMS.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const spec of ROW_EMBED_PARAMS) {
    assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${spec.key} 默认越界`);
    assert.ok(spec.max > spec.min, `${spec.key} 区间非法`);
    assert.ok(spec.step > 0, `${spec.key} 步长非法`);
  }
  for (const key of ['rowMedia', 'panelTone']) {
    const spec = ROW_EMBED_PARAMS.find((p) => p.key === key)!;
    assert.equal(spec.step, 1, `${key} 应是开关档`);
    assert.ok(spec.default === 0 || spec.default === 1);
  }
  const fly = ROW_EMBED_PARAMS.find((p) => p.key === 'flySpeed')!;
  assert.equal(fly.default, 1);
  const decel = ROW_EMBED_PARAMS.find((p) => p.key === 'staggerDecel')!;
  assert.equal(decel.default, 0.3);
});

console.log(`\n${passed} 项通过`);
