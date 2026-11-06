/**
 * 演示故事板构建器（离线规则编排，无需 LLM / API Key / 网络）
 *
 * 定位：AI 助手「配置墙」的降级体验——未配置大模型时，用户点「先看演示编排」
 * 立即得到一份按当前体裁生成的完整故事板（模板挑选 + 文案 + 节奏），先跑通
 * 「改文案 → 快速预览 → 渲染」闭环，建立信心后再回头配置 AI。
 *
 * 全部选用 minVideos: 0 的模板（3D 场景族 + 文字模板），零素材即可渲染；
 * 每段时长/转场取接近真实 AI 流水线输出的档位，让演示片看起来「像那么回事」。
 */

import type {ValidatedSegmentSpec} from '../../shared/llm-tools';
import type {VideoType} from '../../shared/video-type';

/** 每个体裁的演示分镜：[模板 id, 时长秒, 标题, 副标题, 要点][]（顺序即播放顺序） */
const DEMO_STORYBOARDS: Record<VideoType, Array<{id: string; dur: number; title: string; subtitle: string; features: string[]}>> = {
  promo: [
    {id: 'Hero3DTitle', dur: 5.5, title: '遇见更好的体验', subtitle: '一句话，认识我们的产品', features: []},
    {id: 'CityScape3D', dur: 12, title: '城市之光', subtitle: '功能亮点逐一看', features: ['极速渲染引擎', '海量精美模板', 'AI 智能编排']},
    {id: 'FeatureList', dur: 6, title: '为什么选择我们', subtitle: '三个理由足够', features: ['10 分钟出片', '零学习成本', '一键多平台分发']},
    {id: 'StatCounter', dur: 5, title: '值得信赖', subtitle: '用数据说话', features: ['10 万+ 用户', '50 万+ 成片', '4.9 分好评']},
    {id: 'OutroCTA', dur: 5, title: '现在就开始', subtitle: '下载片语，三步出片', features: []},
  ],
  vlog: [
    {id: 'Hero3DTitle', dur: 5.5, title: '我的周末 Vlog', subtitle: '记录值得纪念的一天', features: []},
    {id: 'TextSlide', dur: 4, title: '清晨 · 出发', subtitle: '带上相机说走就走', features: []},
    {id: 'KineticType', dur: 5, title: '路上的风景', subtitle: '每一步都算数', features: ['城市漫步', '街角咖啡', '落日余晖']},
    {id: 'VlogStamp', dur: 5, title: '今日打卡', subtitle: '2026 · 秋', features: []},
    {id: 'OutroCTA', dur: 5, title: '下期再见', subtitle: '关注我，不迷路', features: []},
  ],
  talkingHead: [
    {id: 'Hero3DTitle', dur: 5.5, title: '三分钟讲清楚', subtitle: '今天聊一个被忽视的话题', features: []},
    {id: 'LowerThird', dur: 4, title: '主讲人登场', subtitle: '观点 | 观察 | 干货', features: []},
    {id: 'FeatureList', dur: 6, title: '三个关键点', subtitle: '听我慢慢说', features: ['背景是什么', '问题在哪', '怎么解决']},
    {id: 'Testimonial', dur: 5, title: '他们这么说', subtitle: '真实反馈', features: ['「讲得透彻」', '「收藏了」']},
    {id: 'OutroCTA', dur: 5, title: '点个关注', subtitle: '下期继续拆解', features: []},
  ],
  tutorial: [
    {id: 'Hero3DTitle', dur: 5.5, title: '手把手教程', subtitle: '跟着做，一次学会', features: []},
    {id: 'StepCard', dur: 6, title: '准备阶段', subtitle: '先备好这三样', features: ['打开软件', '导入素材', '选好模板']},
    {id: 'FeatureList', dur: 6, title: '核心步骤', subtitle: '照着点就行', features: ['搭建故事板', '替换你的素材', '渲染导出']},
    {id: 'TimelineRoadmap', dur: 6, title: '进阶路线', subtitle: '从入门到熟练', features: ['第 1 天 出样片', '第 3 天 调风格', '第 7 天 全流程']},
    {id: 'OutroCTA', dur: 5, title: '学会了就练一遍', subtitle: '有问题评论区见', features: []},
  ],
  montage: [
    {id: 'Hero3DTitle', dur: 5.5, title: '高能混剪', subtitle: '节奏拉满 30 秒', features: []},
    {id: 'KineticType', dur: 4, title: '这就是热爱', subtitle: '每一帧都心跳', features: []},
    {id: 'TextSlide', dur: 3.5, title: '名场面', subtitle: '来了', features: []},
    {id: 'Starfield3D', dur: 10, title: '星辰大海', subtitle: '把回忆放进星图', features: ['瞬间一', '瞬间二', '瞬间三']},
    {id: 'OutroCTA', dur: 5, title: '完整版见主页', subtitle: '点赞过百出续集', features: []},
  ],
};

/** 演示编排完成后的说明消息（推进 AI 面板对话流，让用户知道下一步做什么） */
export const demoStoryboardMessage = (genreLabel: string, segmentCount: number): string =>
  `演示编排完成：按「${genreLabel}」体裁生成 ${segmentCount} 段故事板（本地规则生成，未联网、未用大模型）。` +
  `全部模板零素材可渲染——你可以直接去渲染页点「快速预览」看效果，或先在故事板把文案改成你自己的。` +
  `这近似 AI 流水线「故事板阶段」的产出；配置 AI 助手（或 MCP 接入本机 agent）后，同样的事会用大模型写文案、配素材、挖高光、配音卡点、审片重渲一条龙完成。`;

/**
 * 生成演示分镜 specs（可直接交给 applyAiStoryboard 应用）。
 * availableIds：当前可用的模板 id 集（内置 + 自定义 + 市场 + AI 生成）；
 * id 不在集内的段落静默跳过，全部缺失返回空数组（调用方提示）。
 */
export const buildDemoStoryboardSpecs = (
  videoType: VideoType,
  availableIds: Set<string>,
): ValidatedSegmentSpec[] =>
  DEMO_STORYBOARDS[videoType]
    .filter((b) => availableIds.has(b.id))
    .map((b) => ({
      templateId: b.id,
      duration: b.dur,
      transition: 'crossfade',
      videoEffect: 'none',
      backgroundEffect: 'none',
      textAnim: undefined,
      exitStyle: undefined,
      narration: undefined,
      captions: undefined,
      text: {title: b.title, subtitle: b.subtitle, features: b.features, brandName: '片语'},
      customParams: undefined,
      transitionParams: undefined,
    }));
