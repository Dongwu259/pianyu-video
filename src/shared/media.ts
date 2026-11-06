/**
 * 媒体文件工具 - 视频/图片类型判断与常量
 *
 * 主进程与渲染进程共享。
 */

/** 支持的图片扩展名 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'] as const;

/** 支持的视频扩展名 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.avi'] as const;

/** 支持的 3D 模型扩展名（仅 .glb 单文件；.gltf 外部 bin/纹理无法经单文件 URL 服务，需先转 glb） */
export const MODEL_EXTENSIONS = ['.glb'] as const;

/** 图片默认展示时长（秒）- 图片无原生时长，需指定展示多久 */
export const IMAGE_DISPLAY_DURATION = 4;

/**
 * 判断文件是否为图片（按扩展名）
 */
export const isImageFile = (filePath: string): boolean => {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
};

/**
 * 判断文件是否为视频（按扩展名）
 */
export const isVideoFile = (filePath: string): boolean => {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext);
};

/**
 * 判断文件是否为 3D 模型（按扩展名，仅 .glb）
 */
export const isModelFile = (filePath: string): boolean => {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return (MODEL_EXTENSIONS as readonly string[]).includes(ext);
};
