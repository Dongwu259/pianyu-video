/**
 * 实拍铁律的工具层软执行（P0-2；诊断 docs/real-footage-genre-diagnosis.md §2.5-1，
 * 模型线评估 Q1 拍板「只软排序不硬过滤」）。
 *
 * 只做「排序 + 警告」，绝不隐藏/删除模板——sourceKind 是启发式标注，硬过滤会误杀
 * 实拍片里合法的片头/片尾文字卡，还会与旧训练痕迹的状态-动作对冲突（模型选过的
 * 模板从返回里消失）。纯函数；单测 tests/unit/live-action-guard.test.ts。
 */
import type {VideoClip} from './types.ts';

/** 实拍占比统计：dominant = 视频素材 ≥1 且 live-action 占 ≥60%（混合工程不触发） */
export interface LiveActionStats {
  live: number;
  videos: number;
  dominant: boolean;
}

export const liveActionStats = (segments: Array<{videos: VideoClip[]}>): LiveActionStats => {
  let live = 0;
  let videos = 0;
  for (const seg of segments) {
    for (const v of seg.videos) {
      if (v && v.type === 'video') {
        videos++;
        if ((v.sourceKind ?? 'live-action') === 'live-action') live++;
      }
    }
  }
  return {live, videos, dominant: videos > 0 && live / videos >= 0.6};
};

/**
 * 软排序档位：0=满幅素材类（minVideos≥1 且 defaultLayout 标记满幅——VideoCut/Fullbleed 族）
 * 1=素材承载类（画中画/展台，素材进画框）2=零素材文字卡。defaultLayout 缺省视为非满幅
 * （注册表约定：只有满幅模板才标 defaultLayout.videoWidthRatio=1）。
 */
export const liveActionTemplateRank = (t: {minVideos: number; defaultLayout?: {videoWidthRatio?: number}}): number => {
  const fullBleed = (t.defaultLayout?.videoWidthRatio ?? 0) >= 1;
  if (t.minVideos >= 1 && fullBleed) return 0;
  return t.minVideos >= 1 ? 1 : 2;
};

/** 稳定软排序：同档内保持原相对次序（推荐位/评分排序不被打散），不删任何选项 */
export const softSortTemplatesForLiveAction = <T extends {minVideos: number; defaultLayout?: {videoWidthRatio?: number}}>(
  list: T[],
): T[] =>
  list
    .map((t, i) => ({t, i, r: liveActionTemplateRank(t)}))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);

/**
 * 实拍素材挂非满幅模板（会被放进画框/缩成小窗）→ 警告句（不阻断）；其余情形返回 null。
 * 段内无实拍视频或模板本身满幅/未找到 → null。
 */
export const liveActionShrinkWarning = (
  videos: VideoClip[] | undefined,
  template: {name: string; defaultLayout?: {videoWidthRatio?: number}} | undefined,
  index: number,
): string | null => {
  if (!videos || !template) return null;
  if ((template.defaultLayout?.videoWidthRatio ?? 0) >= 1) return null;
  if (!videos.some((v) => v && v.type === 'video' && (v.sourceKind ?? 'live-action') === 'live-action')) return null;
  return `⚠ 实拍铁律：第 ${index + 1} 段的实拍素材在「${template.name}」里会被放进画框/缩成小窗——实拍画面是主角，建议满幅族（VideoCut / FullbleedTitle / FullbleedFeature）；如确属设计意图可忽略本警告`;
};

/**
 * 首次导入素材的体裁自动路由（P0-1；模型线评估拍板「只在首次导入时路由 + 可见确认，
 * 不做会话中静默改」）：视频素材里实拍占 ≥60% → vlog；录屏/图形/混合 → null（保持现状，
 * 不瞎猜——录屏正解是 promo/tutorial 双合法、混合工程让用户自己定）。
 */
export const inferAutoVideoType = (clips: VideoClip[]): 'vlog' | null => {
  const stats = liveActionStats([{videos: clips}]);
  return stats.dominant ? 'vlog' : null;
};
