/**
 * 视频体裁（VideoType）——「AI 全自动视频制作器」的体裁维度。
 *
 * 片语不再只做产品宣传片：工程带上体裁后，AI 的工作流剧本、系统提示词身份、
 * 模板推荐口径都按体裁切换（agent-workflow.ts 的分册剧本 / llm-prompt.ts 的
 * 身份注入 / get_templates 的体裁过滤）。体裁只影响 AI 的「建议口径」，
 * 不限制任何模板/能力的实际使用——用户/agent 仍可自由混搭。
 *
 * 纯数据模块，无运行时依赖，主进程 / 渲染端 / 单测均可直接引用。
 */

/** 视频体裁（决定 AI 剧本与模板推荐口径；缺省 promo，兼容旧工程） */
export type VideoType = 'promo' | 'vlog' | 'talkingHead' | 'tutorial' | 'montage';

export const VIDEO_TYPES: VideoType[] = ['promo', 'vlog', 'talkingHead', 'tutorial', 'montage'];

/** 体裁中文显示名（set_video_type 确认卡 / get_project_info 回报用） */
export const VIDEO_TYPE_LABEL: Record<VideoType, string> = {
  promo: '产品宣传片',
  vlog: '生活 vlog / 素材混剪',
  talkingHead: '口播讲解',
  tutorial: '教程演示',
  montage: '卡点混剪',
};

/** 体裁一句话描述（步骤 1 体裁卡片 / 选择器提示用） */
export const VIDEO_TYPE_DESC: Record<VideoType, string> = {
  promo: '卖点说服，商业转化',
  vlog: '真实记录，素材混剪',
  talkingHead: '真人出镜，观点输出',
  tutorial: '操作演示，步骤教学',
  montage: '音乐卡点，情绪混剪',
};

/** 旧工程 / 新工程的缺省体裁 */
export const DEFAULT_VIDEO_TYPE: VideoType = 'promo';

/** 未知值守卫（加载手改工程文件时用） */
export const isVideoType = (v: unknown): v is VideoType =>
  typeof v === 'string' && (VIDEO_TYPES as string[]).includes(v);

/**
 * 各体裁的自动音效默认开关（新工程 / 未手动改过音效时随体裁生效）。
 * 产品宣传片 / 口播讲解 / 教程演示是「说话」型体裁，转场风声/节拍重音容易盖过旁白与
 * 商业质感（实战反馈：严肃宣传片里的巨大音效），默认关；生活 vlog 与卡点混剪靠
 * 音效烘托情绪，默认开。用户在 BGM 面板手动改过音效后（projectStore.sfxTouched），
 * 体裁切换不再覆盖用户选择。
 */
export const SFX_ENABLED_BY_VIDEO_TYPE: Record<VideoType, boolean> = {
  promo: false,
  vlog: true,
  talkingHead: false,
  tutorial: false,
  montage: true,
};
