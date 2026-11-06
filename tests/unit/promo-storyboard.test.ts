/**
 * promo-storyboard.ts 单测：故事板单一源与平台派生（P0-1）
 * 竖屏派生的三层叠加顺序、portraitDuration/portraitTrim 机械层、deriveCut 前缀切条、
 * registry portraitParams 的参数面同步纪律（沿用预设层测试套路）。
 */
import assert from 'node:assert/strict';
import {
  deriveBoard, deriveLandscape, derivePortrait, deriveCut, materializeBoard,
  type Storyboard, type StorySegment,
} from '../../src/shared/promo-storyboard.ts';
import {TEMPLATES, portraitParamsFor} from '../../src/shared/template-registry.ts';
import type {VideoClip} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const seg = (over: Partial<StorySegment>): StorySegment => ({
  id: 'seg-x', templateId: 'KineticType', duration: 5, transition: 'velocityPush',
  text: {title: '', subtitle: '', features: [], brandName: ''},
  ...over,
});

const board = (segments: StorySegment[]): Storyboard => ({
  id: 'test', mediaDir: 'promo/x', narrationDir: 'promo/x',
  canvas: {
    landscape: {aspectRatioId: '16-9', orientation: 'landscape', logoSize: 0.09, projectName: '横', outName: 'h'},
    portrait: {aspectRatioId: '9-16', orientation: 'portrait', logoSize: 0.12, projectName: '竖', outName: 'v'},
  },
  segments,
  narration: [],
});

const resolveClip = (c: {src: string}): VideoClip => ({
  id: `clip-${c.src}`, src: c.src, name: c.src, width: 1920, height: 1080, duration: 30,
  type: 'video', trimStart: 0, trimEnd: 30,
});

{
  // 竖屏派生机械层：portraitDuration 压缩 + portraitTrim 换窗 + 画幅/logo/工程名
  const b = board([
    seg({id: 's0', templateId: 'KineticType', duration: 6.5, portraitDuration: 6.0}),
    seg({id: 's1', templateId: 'CursorFollow', duration: 5.5, portraitDuration: 5.0, presetId: 'glow-stage',
      clips: [{src: 'a.mp4', trimStart: 15.4, trimEnd: 21.4, portraitTrim: [15.9, 21.4]}]}),
  ]);
  const h = deriveLandscape(b);
  const v = derivePortrait(b);
  assert.equal(h.segments[0].duration, 6.5);
  assert.equal(v.segments[0].duration, 6.0);
  assert.equal(h.segments[1].clips?.[0].trimStart, 15.4);
  assert.equal(v.segments[1].clips?.[0].trimStart, 15.9);
  assert.equal(v.segments[1].clips?.[0].trimEnd, 21.4);
  assert.equal(v.segments[1].clips?.[0].src, 'a.mp4', '换窗不得丢 src（迁移首跑实锤坑）');
  assert.equal(h.canvas.aspectRatioId, '16-9');
  assert.equal(v.canvas.aspectRatioId, '9-16');
  assert.equal(h.canvas.logoSize, 0.09);
  assert.equal(v.canvas.logoSize, 0.12);
  assert.equal(v.canvas.projectName, '竖');
  ok('竖屏派生机械层（时长压缩/换窗/画幅/logo）');
}

{
  // 参数三层叠加：preset 铺底 < params 覆写 < registry 竖屏配方 < 段级 portraitParams；
  // 横屏不吃竖屏配方
  const b = board([
    seg({id: 's0', templateId: 'CursorFollow', presetId: 'glow-stage',
      params: {cardFill: 0.85, clickHold: 0.8},
      portraitParams: {viewSpan: 0.7}}),
  ]);
  const h = deriveLandscape(b).segments[0].params as Record<string, number>;
  assert.equal(h.cardFill, 0.85, '横屏 params 覆写预设');
  assert.equal(h.clickHold, 0.8);
  assert.equal(h.viewSpan, undefined, '横屏不吃竖屏配方');
  assert.equal(h.stageCard, 2, '预设铺底');
  const v = derivePortrait(b).segments[0].params as Record<string, number>;
  assert.equal(v.cardFill, 0.96, 'registry 竖屏配方覆写横屏参数');
  assert.equal(v.stagePalette, 8);
  assert.equal(v.viewSpan, 0.7, '段级 portraitParams 优先于模板层配方');
  assert.equal(v.clickHold, 0.8, '非配方键保持段参数');
  assert.equal(v.stageCard, 2, '预设键保留');
  ok('参数叠加顺序（预设<段参<竖屏配方<段级竖屏覆写）');
}

{
  // 派生摊平：presetId/portraitParams 清痕（防二次派生重复叠加）
  const b = board([seg({id: 's0', templateId: 'KineticType', presetId: 'chapter-shine', portraitDuration: 4, portraitParams: {typeScale: 0.9}})]);
  const v = derivePortrait(b);
  assert.equal(v.segments[0].presetId, undefined);
  assert.equal(v.segments[0].portraitParams, undefined);
  assert.ok(v.segments[0].params && v.segments[0].params.exitFx === 1, '预设已摊平进 params');
  ok('派生摊平清痕');
}

{
  // materializeBoard：clips 解析/direction→transitionParams/customParams/layout 缺省全幅
  const b = board([
    seg({id: 's0', templateId: 'CursorFollow', params: {clickZoom: 2}, direction: 2,
      clips: [{src: 'a.mp4', trimStart: 1, trimEnd: 2}]}),
    seg({id: 's1', templateId: 'KineticType'}),
  ]);
  const out = materializeBoard(deriveLandscape(b), resolveClip);
  assert.equal(out[0].videos[0].src, 'a.mp4');
  assert.equal(out[0].videos[0].width, 1920);
  assert.deepEqual(out[0].customParams, {clickZoom: 2});
  assert.equal(out[0].transitionParams?.direction, 2);
  assert.equal(out[1].transitionParams, undefined, 'direction 缺省不设');
  assert.deepEqual(out[1].layout, {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0});
  ok('materializeBoard 结构装配');
}

{
  // deriveCut 前缀切条：预算内取头段；keepCta 预留 CTA 时长并把旁白重排
  const b = board([
    seg({id: 's0', templateId: 'AiPromptCard', duration: 4}),
    seg({id: 's1', templateId: 'TimeTunnel3D', duration: 6.5}),
    seg({id: 's2', templateId: 'KineticType', duration: 4.5}),
    seg({id: 's3', templateId: 'OutroCTA', duration: 5}),
  ]);
  b.narration = [
    {file: 'a.mp3', seg: 0, text: '一'},
    {file: 'b.mp3', seg: 1, text: '二'},
    {file: 'c.mp3', seg: 3, text: 'CTA'},
  ];
  const plain = deriveCut(b, 15);
  assert.deepEqual(plain.segments.map((s) => s.id), ['s0', 's1', 's2'], '15s 装下前三段（14.5≤15）');
  assert.deepEqual(plain.narration.map((l) => l.seg), [0, 1], '掉段的旁白过滤');

  const cta = deriveCut(b, 15, {keepCta: true});
  // CTA 预留 min(5, 15*0.4=6)=5 → 钩子预算 10：s0(4) 入、s1(6.5) 超预算不入；
  // CTA 用设计时长 5s 不拉长（全片 9s ≤ 预算上限，宁短勿变形）
  assert.equal(cta.segments[cta.segments.length - 1].templateId, 'OutroCTA', 'keepCta 末段落 CTA');
  assert.equal(cta.segments[cta.segments.length - 1].duration, 5, 'CTA 不被预算剩余拉长');
  assert.deepEqual(cta.narration.map((l) => l.text), ['一', 'CTA'], 'CTA 旁白 remap 到新末位');
  assert.equal(cta.narration[1].seg, cta.segments.length - 1);

  const tiny = deriveCut(b, 2);
  assert.deepEqual(tiny.segments.map((s) => s.id), ['s0'], '预算装不下也保第一段');
  const ctaOnly = deriveCut(board([seg({id: 'c', templateId: 'OutroCTA', duration: 5})]), 4, {keepCta: true});
  assert.equal(ctaOnly.segments.length, 1, 'CTA-only 板不重复追加');
  ok('deriveCut 前缀切条/keepCta/旁白重排');
}

{
  // deriveCut keepCta 的 CTA 时长钳制：CTA 不超过预留（5s/预算 40% 取小）
  const b = board([
    seg({id: 's0', templateId: 'AiPromptCard', duration: 4}),
    seg({id: 's9', templateId: 'OutroCTA', duration: 5}),
  ]);
  const cta = deriveCut(b, 15, {keepCta: true});
  const last = cta.segments[cta.segments.length - 1];
  assert.equal(last.duration, 5, '整板装得下时 CTA 保持自身时长');
  ok('deriveCut CTA 时长钳制');
}

{
  // 纪律：registry portraitParams 的键必须存在于该模板 PARAMS 且值在域内（竖屏配方与参数面同步）
  const checked: string[] = [];
  for (const meta of TEMPLATES) {
    if (!meta.portraitParams) continue;
    for (const [k, v] of Object.entries(meta.portraitParams)) {
      const spec = meta.paramSpecs?.find((sp) => sp.key === k);
      assert.ok(spec, `${meta.id}.portraitParams.${k} 不存在于 PARAMS（参数面改了竖屏配方没跟）`);
      if (typeof spec.min === 'number') assert.ok(v >= spec.min, `${meta.id}.portraitParams.${k}=${v} < min ${spec.min}`);
      if (typeof spec.max === 'number') assert.ok(v <= spec.max, `${meta.id}.portraitParams.${k}=${v} > max ${spec.max}`);
    }
    checked.push(meta.id);
  }
  assert.ok(checked.includes('CursorFollow'), 'CursorFollow 竖屏配方在册');
  // 空模板查 portraitParamsFor 不炸、返回空包
  assert.deepEqual(portraitParamsFor('NoSuchTemplate'), {});
  ok(`portraitParams 参数面同步（在册：${checked.join('/')}）`);
}

console.log(`\n共 ${passed} 项全部通过`);
