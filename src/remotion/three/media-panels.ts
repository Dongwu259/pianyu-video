/**
 * 3D 场景模板的媒体展板装配（CameraJourney3D 抽出，四款 3D 场景模板共用）
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - features 第 i 行 = 第 i 块展板标题；无素材的行 = 纯文字展板；
 *   素材多于文字则多余素材无标题；总输入不足 2 时用 fallback 文案兜底凑 2 块。
 * - .glb 模型素材不支持（跳过并警告，与 CameraJourney3D 同口径）。
 */
import type {VideoClip} from '../../shared/types';

export const MAX_MEDIA_PANELS = 6;

export interface MediaPanel {
  /** 视频/图片素材（model 已剔除）；undefined = 纯文字展板 */
  video?: VideoClip;
  /** features 行（展板标题）；媒体多于文字时 undefined */
  caption?: string;
}

export const assembleMediaPanels = (videos: VideoClip[], features: string[] | undefined, fallbackFeatures: string[]): MediaPanel[] => {
  const usable = videos.filter((v) => v.type === 'video' || v.type === 'image');
  if (usable.length !== videos.length) console.warn('[3D 模板] 暂不支持 .glb 模型素材，已跳过');
  const media = usable.slice(0, MAX_MEDIA_PANELS);
  let lines = (features ?? []).map((s) => s.trim()).filter(Boolean);
  // 总输入不足 2 块时用示例文字兜底（模板不空转）
  if (Math.max(media.length, lines.length) < 2) {
    lines = [...lines, ...fallbackFeatures].slice(0, 2);
  }
  const count = Math.min(MAX_MEDIA_PANELS, Math.max(2, Math.max(media.length, lines.length)));
  return Array.from({length: count}, (_, i) => ({video: media[i], caption: lines[i]}));
};
