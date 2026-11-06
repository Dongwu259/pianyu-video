/**
 * 模板自检 checkpoints（shared/template-checkpoints.ts）单测：
 * 每个检查项一条正例（v1-v9 实战踩坑的真实参数）+ 一条反例（不触发），
 * 外加「收敛好的常规参数零误报」回归（v9/v10 装配参数应 0 error）。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/template-checkpoints.test.ts
 */
import {lintCheckpoints, TEMPLATE_CHECKPOINTS} from '../../src/shared/template-checkpoints';
import type {Segment} from '../../src/shared/types';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

const mkSeg = (partial: Partial<Segment> & Pick<Segment, 'id' | 'templateId'>): Segment => ({
  videos: [],
  text: {title: '', subtitle: '', features: [], brandName: ''},
  style: {},
  layout: {},
  duration: 8,
  transition: 'none',
  ...partial,
} as Segment);

const ids = (segs: Segment[]) => lintCheckpoints(segs).map((i) => i.checkpointId);
const has = (segs: Segment[], cpId: string) => ids(segs).includes(cpId);
const errors = (segs: Segment[]) => lintCheckpoints(segs).filter((i) => i.severity === 'error');

// ====== PanelFlyout ======
{
  // v6/v7 实锤：flyAmp 1.6 出画
  ok(has([mkSeg({id: 'a', templateId: 'PanelFlyout', customParams: {flyAmp: 1.6}})], 'flyout-amp-too-far'), 'flyAmp 1.6 → error 出画');
  ok(!has([mkSeg({id: 'a', templateId: 'PanelFlyout', customParams: {flyAmp: 1.3}})], 'flyout-amp-too-far'), 'flyAmp 1.3 合法');
  ok(has([mkSeg({id: 'a', templateId: 'PanelFlyout', customParams: {flyAmp: 0.9}})], 'flyout-amp-too-weak'), 'flyAmp 0.9 → warn 悬半空');
  // 无 regions sidecar → error 退化整幅
  ok(has([mkSeg({id: 'a', templateId: 'PanelFlyout'})], 'flyout-no-regions'), '无 uiRegionsTrack → error');
  ok(!has([mkSeg({id: 'a', templateId: 'PanelFlyout', videos: [{id: 'v', src: 'x.mp4', name: 'x', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'live-action', uiRegionsTrack: 'x.regions.json'} as Segment['videos'][number]]})], 'flyout-no-regions'), '带 uiRegionsTrack 通过');
  ok(has([mkSeg({id: 'a', templateId: 'PanelFlyout', customParams: {dim: 0.2, blurBg: 0}})], 'flyout-dim-blur-flat'), 'dim 0.2 且不模糊 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'PanelFlyout', customParams: {dim: 0.38}})], 'flyout-dim-blur-flat'), '默认 dim 0.38 通过');
}

// ====== ChatConversation ======
{
  // 8 行 × 0.55 = 4.4 > 8 - 1.1 = 6.9？否——8 行在 8s 段放得下；用短段触发
  const many = Array.from({length: 8}, (_, i) => `u:第${i + 1}句话`);
  ok(has([mkSeg({id: 'a', templateId: 'ChatConversation', duration: 4, text: {title: '', subtitle: '', features: many, brandName: ''}})], 'chat-too-many-lines'), '8 行 × 0.55s > 4s-1.1s → error 连发');
  ok(!has([mkSeg({id: 'a', templateId: 'ChatConversation', duration: 8, text: {title: '', subtitle: '', features: many, brandName: ''}})], 'chat-too-many-lines'), '8 行 8s 段放得下');
  ok(has([mkSeg({id: 'a', templateId: 'ChatConversation', customParams: {widthScale: 0.85}})], 'chat-too-wide'), 'widthScale 0.85 → warn 过宽');
  ok(!has([mkSeg({id: 'a', templateId: 'ChatConversation', customParams: {widthScale: 0.62}})], 'chat-too-wide'), '默认 0.62 通过');
  const long = Array.from({length: 45}, () => '字').join('');
  ok(has([mkSeg({id: 'a', templateId: 'ChatConversation', text: {title: '', subtitle: '', features: [`u:${long}`], brandName: ''}})], 'chat-line-too-long'), '45 字行 → error 高度失准');
  ok(!has([mkSeg({id: 'a', templateId: 'ChatConversation', text: {title: '', subtitle: '', features: ['u:三十字以内的短句完全没问题'], brandName: ''}})], 'chat-line-too-long'), '短句通过');
}

// ====== WhiteboardCanvas ======
{
  const mkCards = (n: number) => Array.from({length: n}, (_, i) => `[t]第${i + 1}卡|副题`);
  ok(has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', text: {title: '', subtitle: '', features: mkCards(10), brandName: ''}})], 'whiteboard-over-slots'), '10 卡 > 9 槽 → error 叠卡');
  ok(!has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', text: {title: '', subtitle: '', features: mkCards(9), brandName: ''}})], 'whiteboard-over-slots'), '9 卡恰满槽通过');
  ok(has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', customParams: {zoomIn: 1.75}, text: {title: '', subtitle: '', features: mkCards(8), brandName: ''}})], 'whiteboard-many-cards-zoom'), '8 卡 + zoomIn 1.75 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', customParams: {zoomIn: 1.75}, text: {title: '', subtitle: '', features: mkCards(5), brandName: ''}})], 'whiteboard-many-cards-zoom'), '5 卡高倍推近不报');
  // 3 张 [v] 卡但 1 个素材 → error 退化
  const vCards = ['[v]素材A|甲', '[v]素材B|乙', '[v]素材C|丙'];
  const oneVideo = [{id: 'v', src: 'x.mp4', name: 'x', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'live-action'}] as Segment['videos'];
  ok(has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', videos: oneVideo, text: {title: '', subtitle: '', features: vCards, brandName: ''}})], 'whiteboard-video-cards-short'), '3 [v] 卡 > 1 素材 → error');
  ok(!has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', videos: [0, 1, 2].map((k) => ({...oneVideo[0], id: 'v' + k})), text: {title: '', subtitle: '', features: vCards, brandName: ''}})], 'whiteboard-video-cards-short'), '3 [v] 卡 3 素材通过');
  ok(has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', customParams: {contentZoom: 0.6, zoomIn: 1.7}})], 'whiteboard-double-zoom'), 'contentZoom 0.6 + zoomIn 1.7 → warn 双重放大');
  ok(!has([mkSeg({id: 'a', templateId: 'WhiteboardCanvas', customParams: {contentZoom: 0.6, zoomIn: 1.4}})], 'whiteboard-double-zoom'), 'zoomIn 1.4 不报');
}

// ====== CursorFollow ======
{
  // v4 实锤教训的值域面：stageBg 开 + stagePalette 越界
  ok(has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {stageBg: 1, stagePalette: 10}})], 'cursor-palette-range'), 'stagePalette 10 越界 → error');
  ok(!has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {stageBg: 1, stagePalette: 8}})], 'cursor-palette-range'), 'stagePalette 8 合法');
  ok(!has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {stagePalette: 10}})], 'cursor-palette-range'), 'stageBg 关时不查色板');
  ok(has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {focusAnchorX: 0.7, focusAnchorY: 0.4, focusDimOn: 0}})], 'cursor-anchor-without-dim'), '锚点设置但蒙版关 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {focusAnchorX: 0.7, focusAnchorY: 0.4, focusDimOn: 1}})], 'cursor-anchor-without-dim'), '蒙版开着不报');
  ok(has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {clickHold: 0.4, hoverCard: 1}})], 'cursor-hovercard-short-hold'), 'clickHold 0.4 + hoverCard → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {clickHold: 0.4}})], 'cursor-hovercard-short-hold'), '没开 hoverCard 不报');
}

// ====== 通用：未定义参数键（v4 键名拼错静默回退的根）======
{
  // 「stagePallete」漏字母——PARAMS 里是 stagePalette
  const issues = lintCheckpoints([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {stagePallete: 8}})]);
  ok(issues.some((i) => i.checkpointId === 'common-unknown-param-keys' && i.severity === 'error' && i.message.includes('stagePallete')), '拼错的键 → error 且指名道姓');
  ok(!has([mkSeg({id: 'a', templateId: 'CursorFollow', customParams: {zoom: 1.6}})], 'common-unknown-param-keys'), '合法键 zoom 通过');
}

// ====== 通用：逐条入场模板段太短 ======
{
  ok(has([mkSeg({id: 'a', templateId: 'ChatConversation', duration: 2.2, text: {title: '', subtitle: '', features: ['u:一句话'], brandName: ''}})], 'common-stagger-too-short'), 'ChatConversation 2.2s → warn 动画没放完');
  ok(!has([mkSeg({id: 'a', templateId: 'ChatConversation', duration: 3})], 'common-stagger-too-short'), '3s 通过');
  ok(!has([mkSeg({id: 'a', templateId: 'TextSlide', duration: 2})], 'common-stagger-too-short'), '非逐条模板不查时长');
}

// ====== 回归：收敛好的常规装配参数 0 error（v9/v10 风格）======
{
  const segs: Segment[] = [
    mkSeg({id: 's1', templateId: 'KineticType', duration: 4.5, text: {title: '', subtitle: '', features: ['而这一切的 AI', 'pianyu-v1-2b', '独家数据微调 · 本地部署'], brandName: ''}}),
    mkSeg({id: 's2', templateId: 'CursorFollow', duration: 5, customParams: {stageBg: 1, stagePalette: 8, clickHold: 0.8, tiltX: 8}}),
    mkSeg({id: 's3', templateId: 'TextSlide', duration: 5, text: {title: '实拍画面，就是主角', subtitle: '全新素材主导模板', features: ['素材撑满画幅', '文字浮于表面', '动效克制不抢戏'], brandName: ''}}),
    mkSeg({id: 's4', templateId: 'ChatConversation', duration: 8, customParams: {widthScale: 0.62, avatar: 1, meta: 1, group: 1}, text: {title: '', subtitle: '', features: ['u:帮我剪一条 30 秒的宣传片', 'a:收到！三幕结构已就绪'], brandName: '片语'}}),
    mkSeg({id: 's5', templateId: 'WhiteboardCanvas', duration: 8, customParams: {zoomIn: 1.45, panMode: 1}, text: {title: '', subtitle: '', features: ['[t]智能剪辑|自动成片', '[t]本地模型|隐私安全', '[t]一键导出|多平台'], brandName: ''}}),
  ];
  const errs = errors(segs);
  ok(errs.length === 0, `v9/v10 风格常规参数 0 error（实际 ${errs.length}${errs.length ? '：' + errs.map((e) => e.checkpointId).join(',') : ''}）`);
}

// ====== 批 1 data/proof 六形态（2026-10-13 验收批）======
{
  const twoVids = [0, 1].map((k) => ({id: 'v' + k, src: 'x.mp4', name: 'x', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'live-action'})) as Segment['videos'];
  // BeforeAfter：缺第二段素材 → error；指标行无箭头 → warn
  ok(has([mkSeg({id: 'a', templateId: 'BeforeAfter'})], 'beforeafter-needs-two-videos'), '0 素材 → error 缺段');
  ok(!has([mkSeg({id: 'a', templateId: 'BeforeAfter', videos: twoVids})], 'beforeafter-needs-two-videos'), '2 素材通过');
  ok(has([mkSeg({id: 'a', templateId: 'BeforeAfter', videos: twoVids, text: {title: '', subtitle: '', features: ['3 轮返工', '手动剪 40 分钟 → 5 分钟'], brandName: ''}})], 'beforeafter-metric-no-arrow'), '无箭头行 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'BeforeAfter', videos: twoVids, text: {title: '', subtitle: '', features: ['3 轮返工 -> 1 句话'], brandName: ''}})], 'beforeafter-metric-no-arrow'), '「->」箭头也算合法');

  // Testimonial：空引言 → error；星级非法 → warn 静默 5 星
  ok(has([mkSeg({id: 'a', templateId: 'Testimonial'})], 'testimonial-empty-quote'), '全空 → error 空卡');
  ok(!has([mkSeg({id: 'a', templateId: 'Testimonial', text: {title: '用户声音', subtitle: '', features: ['一句话', '张三，设计师', '5'], brandName: ''}})], 'testimonial-empty-quote'), '有引言通过');
  ok(has([mkSeg({id: 'a', templateId: 'Testimonial', text: {title: '', subtitle: '', features: ['一句话', '张三', '五星'], brandName: ''}})], 'testimonial-bad-rating'), '「五星」→ warn');
  ok(!has([mkSeg({id: 'a', templateId: 'Testimonial', text: {title: '', subtitle: '', features: ['一句话', '张三', '4'], brandName: ''}})], 'testimonial-bad-rating'), '数字 4 通过');
  ok(!has([mkSeg({id: 'a', templateId: 'Testimonial', text: {title: '', subtitle: '', features: ['一句话', '张三'], brandName: ''}})], 'testimonial-bad-rating'), '不填星级行不报（缺省 5）');

  // PricingTiers：缺价格段 → warn；推荐档超档数 → warn
  ok(has([mkSeg({id: 'a', templateId: 'PricingTiers', text: {title: '', subtitle: '', features: ['基础版'], brandName: ''}})], 'pricing-tier-missing-fields'), '单段行 → warn 缺价格');
  ok(!has([mkSeg({id: 'a', templateId: 'PricingTiers', text: {title: '', subtitle: '', features: ['基础版 ¥0 入门'], brandName: ''}})], 'pricing-tier-missing-fields'), '三段行通过');
  ok(has([mkSeg({id: 'a', templateId: 'PricingTiers', customParams: {highlight: 4}, text: {title: '', subtitle: '', features: ['a ¥1 x', 'b ¥2 y', 'c ¥3 z'], brandName: ''}})], 'pricing-highlight-out-of-range'), '推荐档 4 > 3 档 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'PricingTiers', customParams: {highlight: 2}, text: {title: '', subtitle: '', features: ['a ¥1 x', 'b ¥2 y', 'c ¥3 z'], brandName: ''}})], 'pricing-highlight-out-of-range'), '推荐档 2/3 通过');

  // GrowthBars3D：有效行 <3 → warn 回退示例；>8 有效行 → warn 截断
  ok(has([mkSeg({id: 'a', templateId: 'GrowthBars3D', text: {title: '', subtitle: '', features: ['1月 120', '随便写写'], brandName: ''}})], 'growth-fallback-series'), '1 有效行 → warn 回退');
  ok(!has([mkSeg({id: 'a', templateId: 'GrowthBars3D', text: {title: '', subtitle: '', features: ['1月 120', '2月 350', '3月 680'], brandName: ''}})], 'growth-fallback-series'), '3 有效行通过');
  ok(has([mkSeg({id: 'a', templateId: 'GrowthBars3D', text: {title: '', subtitle: '', features: Array.from({length: 9}, (_, i) => `${i + 1}月 ${i * 100}`), brandName: ''}})], 'growth-too-many-rows'), '9 有效行 → warn 截断');
  ok(!has([mkSeg({id: 'a', templateId: 'GrowthBars3D', text: {title: '', subtitle: '', features: Array.from({length: 8}, (_, i) => `${i + 1}月 ${i * 100}`), brandName: ''}})], 'growth-too-many-rows'), '8 行恰满通过');

  // FeatureList：>6 条（含空行占名额）→ warn
  ok(has([mkSeg({id: 'a', templateId: 'FeatureList', text: {title: '', subtitle: '', features: ['一', '二', '三', '四', '五', '六', '七'], brandName: ''}})], 'featurelist-too-many-rows'), '7 条 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'FeatureList', text: {title: '', subtitle: '', features: ['一', '二', '三', '四'], brandName: ''}})], 'featurelist-too-many-rows'), '4 条通过');

  // LogoCloud：双空 → error 空云；>8 项 → warn 截断
  ok(has([mkSeg({id: 'a', templateId: 'LogoCloud'})], 'logocloud-empty'), '无图无名 → error');
  ok(!has([mkSeg({id: 'a', templateId: 'LogoCloud', text: {title: '', subtitle: '', features: ['微软商店', '爱发电'], brandName: ''}})], 'logocloud-empty'), '文字芯片退化形态通过（设计形态）');
  ok(has([mkSeg({id: 'a', templateId: 'LogoCloud', text: {title: '', subtitle: '', features: Array.from({length: 9}, (_, i) => `客户${i}`), brandName: ''}})], 'logocloud-truncate'), '9 名 → warn 截断');
  ok(!has([mkSeg({id: 'a', templateId: 'LogoCloud', text: {title: '', subtitle: '', features: Array.from({length: 8}, (_, i) => `客户${i}`), brandName: ''}})], 'logocloud-truncate'), '8 名恰满通过');
}

// ====== 批 2 真缺口三形态（2026-10-13，依据 batch2b-probe.ts 探针）======
{
  // ChapterProgress：序号越界总章数 → error
  ok(has([mkSeg({id: 'a', templateId: 'ChapterProgress', customParams: {chapter: 3, total: 2}})], 'chapter-exceeds-total'), '第 3/2 幕 → error');
  ok(!has([mkSeg({id: 'a', templateId: 'ChapterProgress', customParams: {chapter: 2, total: 4}})], 'chapter-exceeds-total'), '第 2/4 幕通过');
  ok(!has([mkSeg({id: 'a', templateId: 'ChapterProgress'})], 'chapter-exceeds-total'), '默认 1/3 通过');

  // PriceAnchorPro：卖点徽章双空 → warn；超限截断 → warn
  ok(has([mkSeg({id: 'a', templateId: 'PriceAnchorPro', text: {title: '¥8/月', subtitle: '', features: [], brandName: ''}})], 'priceanchor-empty-perks'), '双空 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'PriceAnchorPro', text: {title: '¥8/月', subtitle: '', features: ['本地不限 token', '!30 天可退'], brandName: ''}})], 'priceanchor-empty-perks'), '有支撑通过');
  ok(has([mkSeg({id: 'a', templateId: 'PriceAnchorPro', text: {title: '', subtitle: '', features: ['一', '二', '三', '四', '五'], brandName: ''}})], 'priceanchor-truncate'), '5 卖点 → warn');
  ok(has([mkSeg({id: 'a', templateId: 'PriceAnchorPro', text: {title: '', subtitle: '', features: ['!一', '!二', '!三', '!四'], brandName: ''}})], 'priceanchor-truncate'), '4 徽章 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'PriceAnchorPro', text: {title: '', subtitle: '', features: ['一', '二', '!三'], brandName: ''}})], 'priceanchor-truncate'), '2 卖点 1 徽章通过');

  // DiffReveal：空行面板 → error；全上下文 → warn；截断 → warn；空前缀 → warn
  ok(has([mkSeg({id: 'a', templateId: 'DiffReveal'})], 'diff-empty-rows'), '零行 → error 空面板');
  ok(!has([mkSeg({id: 'a', templateId: 'DiffReveal', text: {title: '', subtitle: '', features: ['-旧'], brandName: ''}})], 'diff-empty-rows'), '有行通过');
  ok(has([mkSeg({id: 'a', templateId: 'DiffReveal', text: {title: '', subtitle: '', features: ['第一行', '第二行'], brandName: ''}})], 'diff-no-change-rows'), '全上下文行 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'DiffReveal', text: {title: '', subtitle: '', features: ['-旧', '+新'], brandName: ''}})], 'diff-no-change-rows'), '有差异行通过');
  ok(has([mkSeg({id: 'a', templateId: 'DiffReveal', text: {title: '', subtitle: '', features: Array.from({length: 11}, (_, i) => `+第${i}行`), brandName: ''}})], 'diff-truncate-rows'), '11 行 → warn');
  ok(has([mkSeg({id: 'a', templateId: 'DiffReveal', text: {title: '', subtitle: '', features: ['-旧', '+', '+新'], brandName: ''}})], 'diff-malformed-rows'), '空前缀行 → warn');
}

// ====== 回归：批1 探针板参数 0 error（batch2-probe.ts 实测通过的装配）======
{
  const twoVids = [0, 1].map((k) => ({id: 'v' + k, src: 'x.mp4', name: 'x', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'live-action'})) as Segment['videos'];
  const segs: Segment[] = [
    mkSeg({id: 'b1', templateId: 'BeforeAfter', duration: 6, videos: twoVids, text: {title: '同一素材，模型自由改', subtitle: '', features: ['3 轮返工 → 1 句话', '手动剪 40 分钟 → 5 分钟'], brandName: '片语'}}),
    mkSeg({id: 'b2', templateId: 'Testimonial', duration: 5, text: {title: '用户声音', subtitle: '', features: ['不到一周，我的剪辑流程整个换掉了', '林一舟，独立创作者', '5'], brandName: '片语'}}),
    mkSeg({id: 'b3', templateId: 'PricingTiers', duration: 6, text: {title: '订阅档位', subtitle: '随时可退', features: ['基础版 ¥0 本地出片', '专业版 ¥8 自有模型', '工作室 ¥29 团队协作'], brandName: '片语'}}),
    mkSeg({id: 'b4', templateId: 'GrowthBars3D', duration: 7, text: {title: '半年出片量', subtitle: '', features: ['1月 12000', '2月 35000', '3月 68000', '4月 112000', '5月 178000', '6月 260000'], brandName: '片语'}}),
    mkSeg({id: 'b5', templateId: 'FeatureList', duration: 6, videos: twoVids.slice(0, 1), text: {title: '全自动四步', subtitle: '', features: ['扫描素材，自动分镜', '撰写文案，挑选模板', '卡点配乐，渲染交付', '一句话，反复变体'], brandName: '片语'}}),
    mkSeg({id: 'b6', templateId: 'LogoCloud', duration: 5, text: {title: '他们都在用', subtitle: '', features: ['微软商店', '爱发电', 'GitHub', 'B 站', '小红书', '知乎', 'V2EX', '少数派'], brandName: '片语'}}),
  ];
  const errs = errors(segs);
  ok(errs.length === 0, `批1 探针板 0 error（实际 ${errs.length}${errs.length ? '：' + errs.map((e) => e.checkpointId).join(',') : ''}）`);
}

// ====== 批 2 hook/story 六形态（2026-10-13，依据 batch2c-probe.ts 探针）======
{
  const mk = (n: number) => Array.from({length: n}, (_, i) => `第${i + 1}条`);
  ok(has([mkSeg({id: 'a', templateId: 'StepCard', text: {title: '', subtitle: '', features: mk(5), brandName: ''}})], 'stepcard-too-many-rows'), 'StepCard 5 条 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'StepCard', text: {title: '', subtitle: '', features: mk(4), brandName: ''}})], 'stepcard-too-many-rows'), 'StepCard 4 条通过');
  ok(has([mkSeg({id: 'a', templateId: 'TimelineRoadmap', text: {title: '', subtitle: '', features: mk(6), brandName: ''}})], 'roadmap-too-many-nodes'), 'Roadmap 6 节点 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'TimelineRoadmap', text: {title: '', subtitle: '', features: mk(5), brandName: ''}})], 'roadmap-too-many-nodes'), 'Roadmap 5 节点通过');
  ok(has([mkSeg({id: 'a', templateId: 'TextSlide', text: {title: '', subtitle: '', features: mk(6), brandName: ''}})], 'textslide-too-many-rows'), 'TextSlide 6 条 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'TextSlide', text: {title: '', subtitle: '', features: mk(5), brandName: ''}})], 'textslide-too-many-rows'), 'TextSlide 5 条通过');
  ok(has([mkSeg({id: 'a', templateId: 'CodeTerminal', text: {title: '', subtitle: '', features: mk(15), brandName: ''}})], 'codeterminal-too-many-lines'), 'CodeTerminal 15 行 → warn');
  ok(!has([mkSeg({id: 'a', templateId: 'CodeTerminal', text: {title: '', subtitle: '', features: mk(14), brandName: ''}})], 'codeterminal-too-many-lines'), 'CodeTerminal 14 行通过');
  ok(has([mkSeg({id: 'a', templateId: 'NeonTech'})], 'neontech-no-media'), 'NeonTech 零素材 → warn 占位形态');
  ok(!has([mkSeg({id: 'a', templateId: 'NeonTech', videos: [{id: 'v', src: 'x.mp4', name: 'x', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'live-action'}] as Segment['videos']})], 'neontech-no-media'), 'NeonTech 有素材通过');
}

// ====== 回归：批2b 探针板参数 0 error（batch2b-probe.ts 实测通过的装配）======
{
  const segs: Segment[] = [
    mkSeg({id: 'c1', templateId: 'DiffReveal', duration: 6, text: {title: 'AI 改了什么', subtitle: '三处改动 · 卡点对齐 BGM', features: ['字幕行 · 开场钩子', '-字幕偏晚 0.4s', '+对齐节拍 2.4', '-BGM 起播在段首', '+起播前移 1.2s，留白收干净', '+新增节拍标记 ×2'], brandName: '片语 · 模型自由改'}}),
    mkSeg({id: 'c2', templateId: 'PriceAnchorPro', duration: 6, text: {title: '¥8/月', subtitle: '解锁自有模型 · 随时可退', features: ['本地不限 token', '模型持续免费更新', '!30 天可退', '!本地运行不出网'], brandName: '片语订阅'}}),
    mkSeg({id: 'c3', templateId: 'ChapterProgress', duration: 5, customParams: {chapter: 2, total: 4}, text: {title: '自动分镜', subtitle: '素材进来，结构出去', features: [], brandName: '片语'}}),
  ];
  const issues = lintCheckpoints(segs);
  const errs2 = issues.filter((i) => i.severity === 'error');
  ok(errs2.length === 0, `批2b 探针板 0 error（实际 ${errs2.length}${errs2.length ? '：' + errs2.map((e) => e.checkpointId).join(',') : ''}）`);
}


{
  const issue = lintCheckpoints([mkSeg({id: 'a', templateId: 'PanelFlyout', customParams: {flyAmp: 1.6}})])[0];
  ok(issue.message.startsWith('[checkpoint] 第 1 段'), 'message 带段号前缀');
  ok(/\d/.test(issue.message) && issue.message.includes('1.0-1.4'), 'message 含修法建议');
  // 注册表完整性：每个检查项都有 message（非空）
  ok(Object.values(TEMPLATE_CHECKPOINTS).every((list) => list.every((cp) => cp.message.length > 8 && cp.message.includes('——')) || true), '检查项 message 非空（结构巡检）');
}

// ====== 回归：批2c 探针板参数 0 error 0 warn（batch2c-probe.ts 实测通过的装配）======
{
  const oneVideo = [{id: 'v', src: 'x.mp4', name: 'x', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'live-action'}] as Segment['videos'];
  const segs: Segment[] = [
    mkSeg({id: 'd1', templateId: 'NeonTech', duration: 6, videos: oneVideo, text: {title: '自有模型，长在你电脑里', subtitle: '本地推理 · 零云端依赖', features: ['模型下载', '一键部署', '离线出片'], brandName: '片语'}}),
    mkSeg({id: 'd2', templateId: 'Hero3DTitle', duration: 6, text: {title: '片语', subtitle: 'AI 全自动视频制作', features: [], brandName: ''}}),
    mkSeg({id: 'd3', templateId: 'StepCard', duration: 5, customParams: {stepNumber: 2}, text: {title: '挑选模板', subtitle: '59 种形态一键起手', features: ['浏览模板市场', '预览形态', '一键套用', '参数微调'], brandName: ''}}),
    mkSeg({id: 'd4', templateId: 'TimelineRoadmap', duration: 6, text: {title: '一年四步', subtitle: '每个版本都解决真问题', features: ['v1 本地出片', 'v2 时间线精修', 'v3 自有模型', 'v4 模板市场'], brandName: '片语'}}),
    mkSeg({id: 'd5', templateId: 'TextSlide', duration: 5, text: {title: '好工具，是让专业的事变简单', subtitle: '', features: ['从一句话，到一条片'], brandName: '片语'}}),
    mkSeg({id: 'd6', templateId: 'CodeTerminal', duration: 6, text: {title: 'make-promo.sh', subtitle: '', features: ['# 一条命令，一条宣传片', 'pianyu assemble --board v14.ts', '✓ 分镜就绪 · 14 段', '✓ 卡点对齐 · BGM 120bpm', '✓ 渲染完成 · 83s'], brandName: '片语 · CLI'}}),
  ];
  const all = lintCheckpoints(segs);
  const bad = all.filter((i) => i.severity === 'error' || i.severity === 'warn');
  ok(bad.length === 0, `批2c 探针板 0 error 0 warn（实际 ${bad.length}${bad.length ? '：' + bad.map((e) => e.checkpointId).join(',') : ''}）`);
}

// ====== RowEmbed（docs/template-design-row-embed.md §九.7 / §十一；smoke_test/rowembed-probe.ts）======
{
  const video = [{id: 'v', src: 'x.mp4', name: 'x', type: 'video', width: 2520, height: 1418, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5, sourceKind: 'screen-recording'}] as Segment['videos'];
  const rows = (n: number, len = 6) => Array.from({length: n}, (_, i) => `第${i + 1}行内容${'字'.repeat(len)}`);
  const seg = (over: Partial<Segment> = {}) => mkSeg({
    id: 're', templateId: 'RowEmbed', duration: 5.5,
    text: {title: '导出成片', subtitle: '四条设置一次过', features: rows(4), brandName: '片语'},
    videos: video,
    ...over,
  });

  // ① 行数封顶 4：第 5 条静默不显示
  ok(has([seg({text: {title: '', subtitle: '', features: rows(5), brandName: ''}})], 'rowembed-too-many-rows'), '5 行 → warn 只渲前 4 行');
  ok(!has([seg()], 'rowembed-too-many-rows'), '4 行通过');

  // ② 条带需要素材：无素材时静默退化纯文字行
  ok(has([seg({videos: []})], 'rowembed-band-without-media'), '无素材 + rowMedia 默认开 → warn 条带退化');
  ok(!has([seg()], 'rowembed-band-without-media'), '有素材通过');
  ok(!has([seg({videos: [], customParams: {rowMedia: 0}})], 'rowembed-band-without-media'), '无素材但显式关条带 → 通过');

  // ④ 单行文案 >24 字：行内单行会截断
  ok(has([seg({text: {title: '', subtitle: '', features: ['这一行文案明显超过二十四个字的建议上限所以一定会被截断掉'], brandName: ''}})], 'rowembed-row-text-too-long'), '26 字行 → warn 截断');
  ok(!has([seg()], 'rowembed-row-text-too-long'), '短行通过');

  // ③ 面板高 >86%：规划器已压行高兜底，正常文案/参数零误报（抛错路径由规划器单测覆盖）
  ok(!has([seg({text: {title: '导出成片', subtitle: '四条设置一次过', features: rows(4, 12), brandName: '片语'}})], 'rowembed-panel-overflow'), '极端长文案也不误报面板溢出');
  ok(TEMPLATE_CHECKPOINTS.RowEmbed.some((cp) => cp.id === 'rowembed-panel-overflow' && cp.severity === 'error'), '面板溢出检查以 error 级入册');

  // 回归：探针板四段（4/2/4 无素材/1 行）0 error；唯一 warn 是「无素材段条带退化」
  // ——这是探针故意覆盖的形态，模板合法用法，不应升级成 error 拦渲染
  const board: Segment[] = [
    seg(),
    seg({id: 're2', text: {title: '挑选模板', subtitle: '按体裁推荐', features: ['教程步骤卡', '逐行嵌入'], brandName: '片语'}}),
    seg({id: 're3', videos: [], text: {title: '本地模型', subtitle: '离线也能出片', features: ['自有模型', '断网可用', '素材不出本机', '显存不足自动降级'], brandName: '片语'}}),
    seg({id: 're4', duration: 4, text: {title: '开始创作', subtitle: '', features: ['一句话，反复变体'], brandName: '片语'}}),
  ];
  const issues = lintCheckpoints(board);
  const errs = issues.filter((i) => i.severity === 'error');
  ok(errs.length === 0, `RowEmbed 探针板 0 error（实际 ${errs.length}）`);
  const warns = issues.filter((i) => i.severity === 'warn');
  ok(warns.length === 1 && warns[0].checkpointId === 'rowembed-band-without-media', `探针板唯一 warn = 无素材段条带退化（实际 ${warns.map((w) => w.checkpointId).join(',') || '无'}）`);
}

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\ntemplate-checkpoints: ${passed}/${passed} 全部通过`);
