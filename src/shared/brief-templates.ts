/**
 * 官方提示词模板商店（三期后半，研究档 §5.3）。
 *
 * 「用户一句话 → 可执行的详细 brief」之间的提示词工程产品化：
 * 按场景预置模板，用户填 3-5 个空（产品名/卖点/受众/风格/时长），
 * buildBrief 把口语扩写成含镜头结构、节奏、文案风格的完整创作 brief，
 * 填入 AI 助手输入框即可驱动一键成片（run_auto_pipeline）。
 *
 * 与体裁人设（auto-pipeline.ts 的 PIPELINE_PERSONAS）/ 体裁结构（STORYBOARD_STRUCTURE）
 * 一脉相承——那里是流水线内置的提示词层，这里是把提示词层开放给用户。
 *
 * 纯数据/纯函数，Node 可直接单测。
 */

import type {VideoType} from './video-type.ts';

export interface BriefBlank {
  key: string;
  label: string;
  placeholder: string;
  /** 用户留空时的兜底文案（空串 = 该行从 brief 省略） */
  fallback?: string;
}

export interface BriefTemplate {
  id: string;
  name: string;
  /** 一句话说明（列表展示） */
  desc: string;
  /** 建议体裁（brief 里提示 AI 先 set_video_type） */
  videoType: VideoType;
  blanks: BriefBlank[];
  /** 由填空值组装完整 brief（镜头结构/节奏/文案风格齐全） */
  buildBrief: (values: Record<string, string>) => string;
}

/** 取填空值：trim 后为空则回退 fallback（仍空 = 调用方应省略对应行） */
const val = (v: Record<string, string>, b: BriefBlank): string =>
  (v[b.key] ?? '').trim() || (b.fallback ?? '');

/** 标签行：值为空则省略该行（返回空串，组装时过滤） */
const line = (label: string, text: string): string => (text ? `- ${label}：${text}` : '');

/** 统一收尾的执行要求（所有场景共用，驱动流水线与调参纪律） */
const EXECUTION_TAIL = [
  '- 执行：按以上 brief 一键成片（run_auto_pipeline）；素材不足时先规划采集（录屏/截屏工具），不要假设素材已存在',
  '- 调参：按 get_templates 的 paramSpecs 结合内容刻意调参（画框大小/运镜速度/字号），不要全留默认',
  '- 收尾：渲染后用 review_render 审片，按问题清单改稿重渲',
].join('\n');

const assemble = (sections: string[]): string =>
  sections.filter((s) => s.trim()).join('\n');

const blanksOf = (t: BriefTemplate): Record<string, BriefBlank> =>
  Object.fromEntries(t.blanks.map((b) => [b.key, b]));

const productLaunch: BriefTemplate = {
    id: 'product-launch',
    name: '产品发布',
    desc: '新品上线的完整叙事：钩子 → 亮相 → 卖点 → 背书 → CTA',
    videoType: 'promo',
    blanks: [
      {key: 'product', label: '产品名', placeholder: '如：片语'},
      {key: 'tagline', label: '一句话简介', placeholder: '如：AI 全自动宣传片制作器'},
      {key: 'points', label: '核心卖点', placeholder: '逗号分隔，如：一句话成片,35+ 商业模板,AI 卡点剪辑'},
      {key: 'audience', label: '目标受众', placeholder: '如：独立开发者/中小商家'},
      {key: 'style', label: '视觉风格', placeholder: '如：深色科技感/明亮简约', fallback: ''},
      {key: 'duration', label: '时长（秒）', placeholder: '45', fallback: '45'},
    ],
    buildBrief: (v) => {
      const b = blanksOf(productLaunch);
      const points = val(v, b.points).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      return assemble([
        `请为「${val(v, b.product)}」制作一条 ${val(v, b.duration)} 秒的产品发布宣传视频（体裁 promo）。`,
        line('产品', `${val(v, b.product)}——${val(v, b.tagline)}`),
        line('核心卖点', points.map((p, i) => `${i + 1}) ${p}`).join('；')),
        line('目标受众', val(v, b.audience)),
        line('视觉风格', val(v, b.style)),
        '- 叙事结构：开场 3 秒钩子（受众痛点或悬念提问）→ 产品亮相（品牌+一句话定位）→ ' +
          `卖点逐段展开（${Math.max(points.length, 1)} 个卖点各一段，每段只讲一个信息，配界面录屏/演示）→ 数据或背书（数字/用户评价）→ CTA 收尾（行动指令+品牌落版）`,
        '- 节奏：前 3 秒必须抓人；卖点段每段 5-7 秒；整体前快后稳；有 BGM 时切点压拍',
        '- 文案风格：短句有力，每屏一个信息点，避免形容词堆砌；标题 ≤12 字为宜',
        EXECUTION_TAIL,
      ]);
    },
};

const featureUpdate: BriefTemplate = {
    id: 'feature-update',
    name: '功能更新',
    desc: '新功能上线：痛点对比 → 功能演示 → 收益总结',
    videoType: 'promo',
    blanks: [
      {key: 'product', label: '产品名', placeholder: '如：片语'},
      {key: 'feature', label: '新功能名', placeholder: '如：AI 卡点剪辑'},
      {key: 'before', label: '更新前痛点', placeholder: '如：手动对鼓点切镜头，一小时起步'},
      {key: 'benefit', label: '用户收益', placeholder: '如：3 分钟自动剪出压拍成片'},
      {key: 'style', label: '视觉风格', placeholder: '如：深色科技感', fallback: ''},
      {key: 'duration', label: '时长（秒）', placeholder: '30', fallback: '30'},
    ],
    buildBrief: (v) => {
      const b = blanksOf(featureUpdate);
      return assemble([
        `请为「${val(v, b.product)}」的新功能「${val(v, b.feature)}」制作一条 ${val(v, b.duration)} 秒的功能更新视频（体裁 promo）。`,
        line('更新前痛点', val(v, b.before)),
        line('用户收益', val(v, b.benefit)),
        line('视觉风格', val(v, b.style)),
        '- 叙事结构：痛点钩子（还原更新前的麻烦场景，让受众共鸣）→ 新功能一句话亮相（名称+定位）→ ' +
          '功能演示 2-3 段（每段一个操作闭环：操作 → 结果，录屏为主）→ 收益总结（对比更新前，量化更佳）→ CTA（立即升级/体验）',
        '- 节奏：痛点段快切营造紧迫感，演示段稳（操作看得清），收益段上扬；总时长偏短，不铺陈',
        '- 文案风格：从用户视角写（「你」而非「我们」），功能名重复出现 2-3 次强化记忆',
        EXECUTION_TAIL,
      ]);
    },
};

const promoSale: BriefTemplate = {
    id: 'promo-sale',
    name: '促销带货',
    desc: '促销活动：优惠直给 → 卖点 → 机制 → 紧迫感 → CTA',
    videoType: 'promo',
    blanks: [
      {key: 'product', label: '产品名', placeholder: '如：片语年付会员'},
      {key: 'offer', label: '促销机制', placeholder: '如：限时 5 折/买一送一/前 100 名赠礼'},
      {key: 'points', label: '产品卖点', placeholder: '逗号分隔，如：AI 成片,4K 导出,无水印'},
      {key: 'deadline', label: '紧迫感要素', placeholder: '如：仅限本周/限量 50 份', fallback: ''},
      {key: 'duration', label: '时长（秒）', placeholder: '30', fallback: '30'},
    ],
    buildBrief: (v) => {
      const b = blanksOf(promoSale);
      const points = val(v, b.points).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      return assemble([
        `请为「${val(v, b.product)}」制作一条 ${val(v, b.duration)} 秒的促销带货视频（体裁 promo）。`,
        line('促销机制', val(v, b.offer)),
        line('产品卖点', points.map((p, i) => `${i + 1}) ${p}`).join('；')),
        line('紧迫感要素', val(v, b.deadline)),
        '- 叙事结构：开场即给优惠（钩子 = 折扣/福利本身，第一屏就出现）→ 产品卖点 2-3 段（为什么值得买）→ ' +
          '促销机制讲清楚（怎么买/省多少）→ 紧迫感收束（限时/限量）→ CTA（购买指令+行动路径）',
        '- 节奏：全程偏快，促销信息与价格类数字用大字号/对比色强调；每 3-5 秒一个信息变化',
        '- 文案风格：直接、有行动感，多用数字和动词；避免夸大虚假宣传用语（最/第一/100%）',
        EXECUTION_TAIL,
      ]);
    },
};

const tutorialTpl: BriefTemplate = {
    id: 'tutorial',
    name: '教程演示',
    desc: '操作教程：成果预览 → 分步演示 → 坑点提示 → 总结',
    videoType: 'tutorial',
    blanks: [
      {key: 'product', label: '产品名', placeholder: '如：片语'},
      {key: 'topic', label: '教程主题', placeholder: '如：3 分钟做出第一条 AI 宣传片'},
      {key: 'steps', label: '关键步骤', placeholder: '逗号分隔，如：新建工程,上传录屏,选模板,渲染导出'},
      {key: 'audience', label: '受众水平', placeholder: '如：零基础新手', fallback: '零基础新手'},
      {key: 'duration', label: '时长（秒）', placeholder: '60', fallback: '60'},
    ],
    buildBrief: (v) => {
      const b = blanksOf(tutorialTpl);
      const steps = val(v, b.steps).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      return assemble([
        `请为「${val(v, b.product)}」制作一条 ${val(v, b.duration)} 秒的教程视频（体裁 tutorial），主题：${val(v, b.topic)}。`,
        line('受众水平', val(v, b.audience)),
        line('关键步骤', steps.map((s, i) => `${i + 1}) ${s}`).join('；')),
        '- 叙事结构：成果预览钩子（先展示做完的效果，让观众知道值不值得学）→ ' +
          `分步演示（${Math.max(steps.length, 1)} 步每步一段：步骤序号+步骤名大字卡+操作录屏，StepCard 类模板优先）→ ` +
          '常见坑/技巧提示 1 段 → 总结+CTA（关注/下载/试做）',
        '- 节奏：步骤段 6-10 秒（操作要看得清、鼠标动作跟得上），其余段偏快；步骤序号跨段连贯',
        '- 文案风格：步骤名用动宾短语（≤8 字），副标题写「这一步达成什么」；旁白口语化',
        EXECUTION_TAIL,
      ]);
    },
};

const brandStory: BriefTemplate = {
    id: 'brand-story',
    name: '品牌故事',
    desc: '品牌叙事：情怀钩子 → 理念 → 里程碑 → 愿景',
    videoType: 'promo',
    blanks: [
      {key: 'brand', label: '品牌名', placeholder: '如：东吴摄影'},
      {key: 'mission', label: '品牌理念', placeholder: '如：让每个人都能做出专业视频'},
      {key: 'milestones', label: '关键里程碑', placeholder: '逗号分隔，如：2024 立项,2025 用户破万,2026 上架微软商店'},
      {key: 'tone', label: '情感基调', placeholder: '如：真诚/热血/匠人感', fallback: '真诚'},
      {key: 'duration', label: '时长（秒）', placeholder: '45', fallback: '45'},
    ],
    buildBrief: (v) => {
      const b = blanksOf(brandStory);
      const stones = val(v, b.milestones).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      return assemble([
        `请为品牌「${val(v, b.brand)}」制作一条 ${val(v, b.duration)} 秒的品牌故事视频（体裁 promo）。`,
        line('品牌理念', val(v, b.mission)),
        line('关键里程碑', stones.map((s, i) => `${i + 1}) ${s}`).join('；')),
        line('情感基调', val(v, b.tone)),
        '- 叙事结构：情怀钩子（一个具体场景或提问，不讲道理先讲画面）→ 初心与理念（为什么做这件事）→ ' +
          `里程碑时间线（${Math.max(stones.length, 1)} 个节点，TimelineRoadmap 类模板优先）→ 团队或用户的真实面孔 → 愿景与 CTA`,
        '- 节奏：整体舒缓但有起伏，里程碑段渐强；避免一路平铺',
        '- 文案风格：克制真诚，少用感叹号；金句收尾（一句话说清品牌相信什么）',
        EXECUTION_TAIL,
      ]);
    },
};

const eventTeaser: BriefTemplate = {
    id: 'event-teaser',
    name: '活动预热',
    desc: '活动预告：悬念钩子 → 亮点 → 时间地点 → 报名 CTA',
    videoType: 'promo',
    blanks: [
      {key: 'event', label: '活动名', placeholder: '如：片语 2.0 线上发布会'},
      {key: 'time', label: '时间地点', placeholder: '如：9 月 15 日 20:00 B 站直播'},
      {key: 'highlights', label: '活动亮点', placeholder: '逗号分隔，如：新功能首发,嘉宾分享,抽奖福利'},
      {key: 'audience', label: '目标受众', placeholder: '如：内容创作者/电商运营', fallback: ''},
      {key: 'duration', label: '时长（秒）', placeholder: '30', fallback: '30'},
    ],
    buildBrief: (v) => {
      const b = blanksOf(eventTeaser);
      const hl = val(v, b.highlights).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
      return assemble([
        `请为活动「${val(v, b.event)}」制作一条 ${val(v, b.duration)} 秒的预热宣传视频（体裁 promo）。`,
        line('时间地点', val(v, b.time)),
        line('活动亮点', hl.map((s, i) => `${i + 1}) ${s}`).join('；')),
        line('目标受众', val(v, b.audience)),
        '- 叙事结构：悬念钩子（不直接说活动名，先抛亮点或倒计时）→ 活动正式亮相（名称+一句话定位）→ ' +
          `亮点逐段（${Math.max(hl.length, 1)} 个亮点各一段）→ 时间地点明确告知（大字号）→ 报名/预约 CTA`,
        '- 节奏：偏快、有期待感；时间地点信息停留 ≥2 秒确保看清',
        '- 文案风格：短促有力，日期/时间/地点等关键信息用数字和大字突出',
        EXECUTION_TAIL,
      ]);
    },
};

export const BRIEF_TEMPLATES: BriefTemplate[] = [
  productLaunch,
  featureUpdate,
  promoSale,
  tutorialTpl,
  brandStory,
  eventTeaser,
];

export const getBriefTemplate = (id: string): BriefTemplate | undefined =>
  BRIEF_TEMPLATES.find((t) => t.id === id);
