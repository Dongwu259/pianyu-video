/**
 * 视频抽帧服务（主进程）
 *
 * 给 AI 助手的「看图」能力：从视频指定时间点抽取一帧，缩放后返回 JPEG data URL，
 * 供多模态 LLM 的 image_url 消息使用。图片素材直接返回自身（缩放后）。
 *
 * 用 Remotion 自带 ffmpeg（与 audio.ts 同源），不依赖系统 PATH。
 */

import execa from 'execa';
import {nativeImage, type NativeImage} from 'electron';
import {RenderInternals} from '@remotion/renderer';
import {isImageFile} from '../../shared/media';

/** 抽帧结果 */
export interface ExtractFrameResult {
  /** JPEG data URL（data:image/jpeg;base64,...），可直接放进 image_url 消息 */
  dataUrl: string;
  /** 抽取帧的宽度（px） */
  width: number;
  /** 抽取帧的高度（px） */
  height: number;
}

/**
 * 代理解析钩子：素材有 ready 代理（mxf/超大/4K）时抽帧读代理（时间轴等价）。
 * 由 index.ts 启动时注入 ProxyTranscodeService.resolveForRead；未注入 = 原路径
 * （脚本/单测环境零依赖）。集中在这里 = 缩略图/AI 看图/胶片条/色彩统计全部自动受益。
 */
let proxyResolver: ((filePath: string) => string) | null = null;
export const setProxyResolver = (fn: ((filePath: string) => string) | null): void => {
  proxyResolver = fn;
};

/** 缩放后长边上限（控制 data URL 体积，兼顾视觉模型识别清晰度） */
const MAX_DIM = 768;

const getFfmpegPath = (): string =>
  RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
  });

/**
 * 从视频/图片抽取一帧。
 * @param filePath 原始文件路径
 * @param timeSec 抽帧时间点（秒，视频有效；图片忽略）
 * @param maxDim 缩放后长边上限（缺省 MAX_DIM；时间线缩略图等小图场景传小值）
 */
export const extractFrame = async (filePath: string, timeSec: number, maxDim: number = MAX_DIM): Promise<ExtractFrameResult> => {
  if (!filePath) throw new Error('文件路径为空');
  // 有 ready 代理走代理（mxf 精简 ffmpeg 解不了 / 超大文件抽帧慢 / Log 代理已是恢复色）
  const sourcePath = proxyResolver ? proxyResolver(filePath) : filePath;

  // 图片：直接读取并缩放
  if (isImageFile(sourcePath)) {
    const img = nativeImage.createFromPath(sourcePath);
    if (img.isEmpty()) throw new Error('无法读取图片（可能已损坏）');
    return resizeToDataUrl(img, maxDim);
  }

  // 视频：ffmpeg -ss 抽帧（-ss 在 -i 前为快速关键帧 seek）
  const ffmpeg = getFfmpegPath();
  const t = Math.max(0, timeSec || 0);
  let stdout: Buffer;
  try {
    const res = await execa(
      ffmpeg,
      [
        '-ss', String(t),
        '-i', sourcePath,
        '-frames:v', '1',
        '-vf', `scale=${maxDim}:${maxDim}:force_original_aspect_ratio=decrease`,
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        '-q:v', '3',
        'pipe:1',
      ],
      {encoding: 'buffer', maxBuffer: 20 * 1024 * 1024},
    );
    stdout = res.stdout as unknown as Buffer;
  } catch (err) {
    throw new Error(`抽帧失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stdout || stdout.length === 0) {
    throw new Error('抽帧失败：ffmpeg 未返回画面（时间点可能超出视频时长）');
  }
  // 用 nativeImage 解析尺寸
  const img = nativeImage.createFromBuffer(stdout);
  if (img.isEmpty()) throw new Error('抽帧失败：无法解析画面');
  const size = img.getSize();
  return {
    dataUrl: `data:image/jpeg;base64,${stdout.toString('base64')}`,
    width: size.width || maxDim,
    height: size.height || maxDim,
  };
};

/** 把 NativeImage 缩放到长边 <= maxDim，返回 JPEG data URL + 尺寸（render:still 静帧缩放同用） */
export const resizeToDataUrl = (img: NativeImage, maxDim: number): ExtractFrameResult => {
  const size = img.getSize();
  let out = img;
  const longSide = Math.max(size.width, size.height);
  if (longSide > maxDim) {
    const scale = maxDim / longSide;
    out = img.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    });
  }
  const newSize = out.getSize();
  const jpegBuf = out.toJPEG(80);
  return {
    dataUrl: `data:image/jpeg;base64,${jpegBuf.toString('base64')}`,
    width: newSize.width,
    height: newSize.height,
  };
};
