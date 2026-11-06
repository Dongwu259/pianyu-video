/**
 * 导入素材的预览编码白名单判定（纯函数，可单测）。
 *
 * 片语预览走 Chromium <video> 解码：h264/vp8/vp9/av1 是安全白名单；
 * hevc/prores/mjpeg/mpeg1video/mpeg2video/wmv3 等 Chromium 解不动，预览会黑屏/无声。
 * 导出渲染走 ffmpeg（Remotion 管线），与预览解码无关——所以只警告不拦截。
 */

/** Chromium 可解码的视频编码白名单（ffprobe codec_name，小写） */
export const PREVIEW_SAFE_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'vp8', 'vp9', 'av1']);

/** 非视频编码的占位值：图片走 nativeImage 读尺寸、探测失败不吓唬用户，都不警告 */
const NON_VIDEO_CODECS: ReadonlySet<string> = new Set(['image', 'unknown']);

/**
 * 预览编码警告：白名单内/图片/未知编码返回 null，其余返回中文警告文案。
 * container 目前只参与文案（某些编码名本身看不出封装格式），不参与判定。
 */
export const codecPreviewWarning = (codec: string | null | undefined, container?: string | null): string | null => {
  const c = (codec || '').trim().toLowerCase();
  if (!c || NON_VIDEO_CODECS.has(c)) return null;
  if (PREVIEW_SAFE_VIDEO_CODECS.has(c)) return null;
  const containerNote = container ? `（${container} 封装）` : '';
  return `视频编码「${c}」${containerNote}不在预览白名单（h264/vp8/vp9/av1）：预览可能黑屏/无声，导出渲染不受影响（走 ffmpeg），建议转成 H.264`;
};
