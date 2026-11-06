/**
 * 素材 src ↔ 原始本地路径 转换工具
 *
 * VideoClip.src 在内存中是本地视频服务器 URL
 * （http://127.0.0.1:端口/video?path=<encodeURIComponent(原始路径)>），
 * 端口每会话随机，不能直接持久化。
 * 保存工程时用 clipSrcToPath 还原原始路径；加载时用 pathToClipSrc 重建 URL。
 */

/**
 * 从本地视频服务器 URL 还原原始文件路径。
 * 非 http(s) 形式的输入（已是路径）原样返回。
 * URL.searchParams.get 会自动做 URL 解码，无需再 decodeURIComponent。
 */
export const clipSrcToPath = (src: string): string => {
  if (!src) return src;
  if (!/^https?:\/\//i.test(src)) return src;
  try {
    const url = new URL(src);
    const p = url.searchParams.get('path');
    if (p) return p;
  } catch {
    // 非法 URL，原样返回
  }
  return src;
};

/**
 * 由原始路径重建本地视频服务器 URL（走主进程拿到当前会话端口）。
 * 已是 http(s) URL 的输入原样返回。
 */
export const pathToClipSrc = async (filePath: string): Promise<string> => {
  if (!filePath || /^https?:\/\//i.test(filePath)) return filePath;
  return window.api.getVideoHttpUrl(filePath);
};
