/**
 * 视频体裁（P0）单元测试：video-type 模块 / 模板注册表体裁标注与过滤 /
 * 工作流指南分册 / 系统提示词体裁注入 / 新工具参数校验 / store 体裁字段与持久化。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/video-type.test.ts
 */

import assert from 'node:assert/strict';

const {VIDEO_TYPES, VIDEO_TYPE_LABEL, DEFAULT_VIDEO_TYPE, isVideoType} = await import('../../src/shared/video-type.ts');
const {TEMPLATES, templateFitsVideoType, GENRE_RECOMMENDED_IDS} = await import('../../src/shared/template-registry.ts');
const {is3DTemplate} = await import('../../src/shared/template-catalog.ts');
const {buildWorkflowGuide, AGENT_WORKFLOW_GUIDE} = await import('../../src/shared/agent-workflow.ts');
const {buildSystemPrompt} = await import('../../src/shared/llm-prompt.ts');
const {
  validateSetVideoTypeArgs, validateMineHighlightsArgs, validateApplyCutListArgs,
} = await import('../../src/shared/llm-tools.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('体裁模块:');
{
  assert.deepEqual(VIDEO_TYPES, ['promo', 'vlog', 'talkingHead', 'tutorial', 'montage']);
  for (const t of VIDEO_TYPES) assert.ok(VIDEO_TYPE_LABEL[t], `${t} 缺中文标签`);
  assert.equal(DEFAULT_VIDEO_TYPE, 'promo');
  assert.ok(isVideoType('vlog') && isVideoType('promo'));
  assert.ok(!isVideoType('Vlog') && !isVideoType('') && !isVideoType(42) && !isVideoType(undefined));
  ok('枚举/标签/缺省值/守卫');
}

console.log('模板注册表体裁标注:');
/** 体裁标注总表（v1.4.0 起按体裁策展：3D 族=promo+tutorial，vlog/口播/教程/混剪各归位，营销件多为 promo 专属） */
const TAGGED_VIDEO_TYPES: Record<string, string[]> = {
  // 钩子族（1.7 AI 提示卡）
  AiPromptCard: ['promo'],
  // 营销/发布会系
  StatCounter: ['promo'], PricingTiers: ['promo'], ComingSoon: ['promo'], LogoCloud: ['promo'],
  TimelineRoadmap: ['promo'], BrandIntro: ['promo'], OutroCTA: ['promo'],
  Testimonial: ['promo', 'talkingHead'], GlobePoints: ['promo', 'montage'],
  // 批 2 真缺口三形态（2026-10-13）
  ChapterProgress: ['promo'], PriceAnchorPro: ['promo'], DiffReveal: ['promo', 'tutorial'],
  // 3D 族（3D 场景 + 三件套 + 数据 3D）：宣传片 + 教程演示
  Hero3DTitle: ['promo', 'tutorial'], DeviceShowcase3D: ['promo', 'tutorial'], ModelTurntable: ['promo', 'tutorial'],
  GrowthBars3D: ['promo', 'tutorial'], TrendLine3D: ['promo', 'tutorial'],
  CameraJourney3D: ['promo', 'tutorial'], GalleryHall3D: ['promo', 'tutorial'], OrbitCarousel3D: ['promo', 'tutorial'],
  TimeTunnel3D: ['promo', 'tutorial'], CityScape3D: ['promo', 'tutorial'], SpiralAtrium3D: ['promo', 'tutorial'], Starfield3D: ['promo', 'tutorial'],
  // vlog
  VlogStamp: ['vlog'], VlogPolaroid: ['vlog'],
  // 口播
  TalkingPoint: ['talkingHead'], LowerThird: ['talkingHead'],
  // 教程
  StepCard: ['tutorial'], RowEmbed: ['tutorial', 'promo'], CodeTerminal: ['tutorial'], BeforeAfter: ['tutorial'], CursorFollow: ['tutorial'],
  ScreenDemo: ['tutorial'], TutorialStep: ['tutorial'], ProductFloat: ['promo', 'tutorial'],
  PanelFlyout: ['tutorial'], ChatConversation: ['promo'], WhiteboardCanvas: ['promo', 'tutorial'], DocPanel: ['promo'],
  // 混剪
  KineticType: ['montage'], CardConverge: ['montage'], StackCards: ['montage'],
  Montage: ['montage', 'promo', 'vlog'],
};
{
  const tagged = TEMPLATES.filter((t) => t.videoTypes);
  assert.deepEqual(tagged.map((t) => t.id).sort(), Object.keys(TAGGED_VIDEO_TYPES).sort(), '体裁标注清单应与策展总表一致');
  for (const [id, vt] of Object.entries(TAGGED_VIDEO_TYPES)) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    assert.deepEqual([...(t.videoTypes ?? [])].sort(), [...vt].sort(), `${id} 体裁标注`);
    for (const g of vt) assert.ok(templateFitsVideoType(t, g as never), `${id} 应对 ${g} 可见`);
    for (const g of VIDEO_TYPES) {
      if (!(vt as string[]).includes(g)) assert.ok(!templateFitsVideoType(t, g), `${id} 应对 ${g} 隐藏`);
    }
  }
  // 缺省 = 通用：未标注模板对所有体裁可见
  for (const t of TEMPLATES.filter((x) => !x.videoTypes)) {
    for (const g of VIDEO_TYPES) assert.ok(templateFitsVideoType(t, g), `${t.id} 未标注应对 ${g} 可见`);
  }
  ok('体裁标注总表（3D 族 promo+tutorial 等 32 个）+ 缺省通用开放');
  // P1-5B：VideoCut 转全体裁通用（裸素材直剪是所有体裁的底层动词，移除 montage 专属标注）
}
{
  // vlog 视角：3D 场景族与营销件隐藏，通用/vlog 专属可见（用户点名：vlog 不推宣传片的 3D）
  const vlogIds = TEMPLATES.filter((t) => templateFitsVideoType(t, 'vlog')).map((t) => t.id);
  const hidden = Object.entries(TAGGED_VIDEO_TYPES).filter(([, vt]) => !(vt as string[]).includes('vlog')).map(([id]) => id);
  assert.equal(vlogIds.length, TEMPLATES.length - hidden.length, 'vlog 可见数 = 总数 - 非vlog标注数');
  for (const id of ['VlogStamp', 'KenBurns', 'ScreenRecord', 'UICallout', 'VerticalScroll']) assert.ok(vlogIds.includes(id), `vlog 应保留 ${id}`);
  for (const id of ['CityScape3D', 'Starfield3D', 'Hero3DTitle', 'DeviceShowcase3D', 'StatCounter', 'KineticType']) {
    assert.ok(!vlogIds.includes(id), `vlog 应隐藏 ${id}`);
  }
  ok('vlog 过滤口径（3D 场景/三件套/营销/混剪专属件隐藏，通用 + vlog 专属可见）');
}
{
  // 首页体裁策展推荐表（GENRE_RECOMMENDED_IDS）：id 全部存在、每体裁 ≥8、vlog 零 3D、
  // promo 3D 招牌位 + 实拍位（2026-10-05 拍板：Fullbleed 族进 promo/vlog/montage 策展前部，
  // 推荐位决定 AI/新段默认选型 + 蒸馏教师示范；talkingHead/tutorial 录屏体裁不进）
  for (const g of VIDEO_TYPES) {
    const ids = GENRE_RECOMMENDED_IDS[g];
    assert.ok(ids.length >= 8, `${g} 策展数 ≥8`);
    for (const id of ids) assert.ok(TEMPLATES.some((t) => t.id === id), `${g} 策展含不存在模板 ${id}`);
  }
  assert.ok(GENRE_RECOMMENDED_IDS.vlog.every((id) => !is3DTemplate(id)), 'vlog 策展不应含 3D 模板');
  const promoTop6 = GENRE_RECOMMENDED_IDS.promo.slice(0, 6);
  assert.ok(promoTop6.filter(is3DTemplate).length >= 4, 'promo 策展前六仍以 3D 招牌位为主（≥4）');
  assert.ok(promoTop6.includes('FullbleedTitle') && promoTop6.includes('FullbleedFeature'), 'promo 策展前六应含 Fullbleed 实拍位');
  for (const g of ['promo', 'vlog', 'montage'] as const) {
    assert.ok(GENRE_RECOMMENDED_IDS[g].slice(0, 3).some((id) => id.startsWith('Fullbleed')), `${g} 策展前部应有 Fullbleed 族`);
    assert.ok(GENRE_RECOMMENDED_IDS[g].includes('FullbleedCTA'), `${g} 策展应收 FullbleedCTA（电影感收尾）`);
  }
  for (const g of ['talkingHead', 'tutorial'] as const) {
    assert.ok(!GENRE_RECOMMENDED_IDS[g].some((id) => id.startsWith('Fullbleed')), `${g} 录屏体裁不应含 Fullbleed 族`);
  }
  ok('五体裁首页策展推荐表（vlog 零 3D / promo 3D 招牌 + Fullbleed 实拍位 / 录屏体裁不进）');
}

console.log('工作流指南分册:');
{
  assert.equal(AGENT_WORKFLOW_GUIDE, buildWorkflowGuide('promo'), '兼容导出应等于 promo 分册');
  const vlog = buildWorkflowGuide('vlog');
  assert.ok(vlog.includes('生活 vlog'), 'vlog 分册标题');
  assert.ok(vlog.includes('mine_highlights') && vlog.includes('apply_cut_list'), 'vlog 分册缺挖矿链路');
  assert.ok(vlog.includes('transcribe_segment_captions'), 'vlog 分册缺字幕链路');
  assert.ok(!vlog.includes('经典成片结构') && !vlog.includes('PricingTiers'), 'vlog 分册不应带宣传片专属内容');
  const talking = buildWorkflowGuide('talkingHead');
  assert.ok(talking.includes('camera') && talking.includes('跳切'), '口播分册缺出镜/跳切要点');
  const tutorial = buildWorkflowGuide('tutorial');
  assert.ok(tutorial.includes('CursorFollow') && tutorial.includes('步骤'), '教程分册缺跟随运镜/步骤要点');
  const montage = buildWorkflowGuide('montage');
  assert.ok(montage.includes('align_beats') && montage.includes('CardConverge'), '混剪分册缺卡点链路');
  // 共用主干：所有分册都含三阶段 + 前置条件 + 调参纪律
  for (const g of VIDEO_TYPES) {
    const guide = buildWorkflowGuide(g);
    for (const kw of ['阶段一 · 素材采集', '阶段二 · 成片', '阶段三 · 发布准备', '前置条件清单', '调参纪律', 'run_auto_pipeline']) {
      assert.ok(guide.includes(kw), `${g} 分册缺共用主干 ${kw}`);
    }
    assert.ok(guide.includes(VIDEO_TYPE_LABEL[g]), `${g} 分册缺当前体裁声明`);
  }
  ok('五分册内容 + 共用主干齐备');
}

console.log('系统提示词体裁注入:');
{
  const promoPrompt = buildSystemPrompt('promo');
  assert.ok(promoPrompt.includes('宣传片策划助手'));
  assert.ok(promoPrompt.includes('PricingTiers'), 'promo 应列出定价档位模板');
  assert.ok(promoPrompt.includes(AGENT_WORKFLOW_GUIDE), 'promo 提示词应嵌入 promo 分册');
  assert.equal(buildSystemPrompt(), buildSystemPrompt('promo'), '缺省 = promo');
  const vlogPrompt = buildSystemPrompt('vlog');
  assert.ok(vlogPrompt.includes('视频剪辑助手'), 'vlog 身份');
  assert.ok(vlogPrompt.includes('VideoCut'), 'vlog 模板清单缺 VideoCut');
  assert.ok(!vlogPrompt.includes('PricingTiers「定价档位」'), 'vlog 模板清单不应含 promo 专属模板');
  assert.ok(vlogPrompt.includes(buildWorkflowGuide('vlog')), 'vlog 提示词应嵌入 vlog 分册');
  ok('身份/模板清单/指南随体裁切换');
}

console.log('新工具参数校验:');
{
  const good = validateSetVideoTypeArgs({videoType: 'vlog'});
  assert.ok(good.ok && good.args.videoType === 'vlog');
  const bad = validateSetVideoTypeArgs({videoType: 'vlogs'});
  assert.ok(!bad.ok && bad.errors[0].includes('videoType'));
  assert.ok(!validateSetVideoTypeArgs({}).ok);
  ok('set_video_type 枚举校验');
}
{
  const d = validateMineHighlightsArgs({index: 0});
  assert.ok(d.ok);
  assert.equal(d.args.targetDurationSec, 60);
  assert.equal(d.args.maxSegments, 8);
  assert.equal(d.args.videoIndex, undefined);
  const full = validateMineHighlightsArgs({index: 2, videoIndex: 1, targetDurationSec: 90, maxSegments: 5, focus: '只要美食'});
  assert.ok(full.ok && full.args.targetDurationSec === 90 && full.args.maxSegments === 5 && full.args.focus === '只要美食');
  assert.ok(!validateMineHighlightsArgs({}).ok, 'index 必填');
  assert.ok(!validateMineHighlightsArgs({index: 0, targetDurationSec: 5}).ok, '时长下限 10');
  assert.ok(!validateMineHighlightsArgs({index: 0, targetDurationSec: 200}).ok, '时长上限 180');
  assert.ok(!validateMineHighlightsArgs({index: 0, maxSegments: 1}).ok, '段数下限 2');
  assert.ok(validateMineHighlightsArgs({index: 0, maxSegments: 13}).ok, '13 段在上限内');
  assert.ok(!validateMineHighlightsArgs({index: 0, maxSegments: 61}).ok, '段数上限 60');
  assert.ok(!validateMineHighlightsArgs({index: 0, videoIndex: -1}).ok, 'videoIndex 非负');
  const longFocus = validateMineHighlightsArgs({index: 0, focus: 'x'.repeat(101)});
  assert.ok(!longFocus.ok, 'focus ≤100 字');
  ok('mine_highlights 参数与范围');
}
{
  const good = validateApplyCutListArgs({index: 1, keepRanges: [{start: 0, end: 5}, {start: 10, end: 20}]});
  assert.ok(good.ok && good.args.keepRanges.length === 2);
  assert.ok(!validateApplyCutListArgs({index: 1}).ok, 'keepRanges 必填');
  assert.ok(!validateApplyCutListArgs({index: 1, keepRanges: []}).ok, '至少 1 段');
  assert.ok(!validateApplyCutListArgs({index: 1, keepRanges: [{start: 5, end: 5}]}).ok, 'start<end');
  assert.ok(!validateApplyCutListArgs({index: 1, keepRanges: [{start: -1, end: 5}]}).ok, 'start≥0');
  assert.ok(!validateApplyCutListArgs({index: -1, keepRanges: [{start: 0, end: 5}]}).ok, 'index 非负');
  const vid = validateApplyCutListArgs({index: 0, videoIndex: 2, keepRanges: [{start: 0, end: 5}]});
  assert.ok(vid.ok && vid.args.videoIndex === 2);
  ok('apply_cut_list 参数与范围');
}

// ====== store 体裁字段（window stub：applyLoadedProject/newProject 链路用） ======
(globalThis as any).window = {
  api: {
    saveProject: async () => ({success: true}),
    getStore: async () => [],
    setStore: async () => true,
    clearAutosave: async () => ({success: true}),
    captureReadCursorTrack: async () => null,
  },
  alert: () => {},
  confirm: () => true,
};
const {useProjectStore, createEmptySegment} = await import('../../src/renderer/store/projectStore.ts');

console.log('store 体裁字段与持久化:');
{
  const S = () => useProjectStore.getState();
  assert.equal(S().videoType, 'promo', '缺省 promo');
  S().setVideoType('vlog');
  assert.equal(S().videoType, 'vlog');
  const serialized = S().serializeProject();
  assert.equal(serialized.videoType, 'vlog', 'serializeProject 应带 videoType');
  // 加载：合法体裁恢复；非法值回退默认
  await S().applyLoadedProject('t', {
    aspectRatioId: '16-9', orientation: 'landscape', segments: [createEmptySegment()],
    videoType: 'montage',
  } as never, 'x.vtproj', []);
  assert.equal(S().videoType, 'montage', '加载恢复体裁');
  await S().applyLoadedProject('t2', {
    aspectRatioId: '16-9', orientation: 'landscape', segments: [createEmptySegment()],
    videoType: 'hacking',
  } as never, 'y.vtproj', []);
  assert.equal(S().videoType, DEFAULT_VIDEO_TYPE, '非法体裁回退默认');
  // 旧工程（无字段）→ 默认；newProject 重置
  await S().applyLoadedProject('t3', {
    aspectRatioId: '16-9', orientation: 'landscape', segments: [createEmptySegment()],
  } as never, 'z.vtproj', []);
  assert.equal(S().videoType, 'promo', '旧工程无字段回退默认');
  S().setVideoType('tutorial');
  S().newProject();
  assert.equal(S().videoType, 'promo', '新建工程重置为 promo');
  ok('setVideoType/序列化/加载回退/新建重置');
}

console.log(`\n共 ${passed} 项全部通过`);
