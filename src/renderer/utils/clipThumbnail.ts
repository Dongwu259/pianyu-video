/**
 * 素材缩略图生成（录制/AI 链路补齐）。
 *
 * 时间线/故事板卡片消费 seg.videos[].thumbnail（TimelinePanel 胶片条平铺、
 * StoryboardEditor 卡面），此前只有「文件导入」链路生成（media.ts 文件选择器：
 * 视频 10% 处抽一帧 192px）；实录录制、import_segment_media、import_stock_media、
 * generate_image 都不带——卡片退到文字预览/Film 图标。本 helper 统一补齐，
 * 与导入链路同口径（10% 处、长边 192），失败静默 undefined 不阻塞入段。
 * 图片素材 extractFrame 原样缩放返回自身（顺带修故事板卡对图片的 Film 兜底误伤）。
 */

export const CLIP_THUMBNAIL_MAX_DIM = 192;

/** 缩略图抽帧时间点：视频 10% 处且 ≤1s（太短的取 0）；duration 异常（0/NaN）取 0 */
export const clipThumbnailTimeSec = (durationSec: number): number =>
  Number.isFinite(durationSec) && durationSec > 0.2 ? Math.min(1, durationSec * 0.1) : 0;

/** 生成素材缩略图 dataUrl；任何失败返回 undefined（调用方不阻塞） */
export const makeClipThumbnail = async (filePath: string, durationSec: number): Promise<string | undefined> => {
  try {
    const r = await window.api.extractFrame(filePath, clipThumbnailTimeSec(durationSec), CLIP_THUMBNAIL_MAX_DIM);
    return r.dataUrl;
  } catch {
    return undefined;
  }
};
