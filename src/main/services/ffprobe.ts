/**
 * 媒体元数据获取 - 视频用 Remotion 自带 ffprobe，图片用 Electron nativeImage
 *
 * 重要：不依赖系统 PATH 中的 ffprobe（用户机器通常未安装），
 * 而是通过 RenderInternals.getExecutablePath 获取 @remotion/renderer 内置的 ffprobe。
 */

import {execFile} from 'child_process';
import {promisify} from 'util';
import {existsSync} from 'node:fs';
import {nativeImage} from 'electron';
import {RenderInternals} from '@remotion/renderer';
import {isImageFile, isModelFile, IMAGE_DISPLAY_DURATION} from '../../shared/media';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;    // 秒（图片为展示时长）
  fps: number;
  codec: string;       // 视频编码（ffprobe codec_name；图片为 'image'）
  audioCodec?: string; // 音频编码（无音轨/探测失败时缺省）
  type: 'video' | 'image' | 'model';
  /** 录制设备厂商（ffprobe format/streams tags 的 make/model 等，电影机素材常见） */
  make?: string;
  model?: string;
}

/** 录像实际帧率统计（ffprobe 探测；读不到的维度为 null，由调用方降级） */
export interface VideoFrameStats {
  /** 实际帧数（nb_frames；读不到为 null） */
  frameCount: number | null;
  /** 容器声明的平均帧率（avg_frame_rate；读不到为 null） */
  avgFps: number | null;
  /** 时长（秒；MediaRecorder 的 webm 无 Duration 元素时为 null） */
  durationSec: number | null;
}

/**
 * 获取 Remotion 自带的 ffprobe 可执行文件路径
 * 失败时回退到系统 ffprobe（最后手段）
 */
const getFfprobePath = (): string => {
  try {
    return RenderInternals.getExecutablePath({
      type: 'ffprobe',
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
    });
  } catch (err) {
    console.warn('[ffprobe] 无法定位 Remotion 自带 ffprobe，回退到系统 ffprobe:', err);
    return 'ffprobe';
  }
};

/**
 * 获取媒体元数据（视频或图片）
 */
export const getVideoMetadata = async (filePath: string): Promise<VideoMetadata> => {
  // 存在性前置校验：不存在的文件永远不可能有合法元数据，必须 fail-fast
  //（否则落到下方兜底会返回 1920×1080 默认值，import 工具表现为「静默成功 + duration 0」）
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  // 3D 模型（.glb）：无像素维度/原生时长，three.js 加载时才知包围盒；直接返回占位元数据
  if (isModelFile(filePath)) {
    return {width: 1920, height: 1080, duration: 0, fps: 30, codec: 'gltf-binary', type: 'model'};
  }

  // 图片：用 nativeImage 读取尺寸，无原生时长，用默认展示时长
  if (isImageFile(filePath)) {
    try {
      const img = nativeImage.createFromPath(filePath);
      const size = img.getSize();
      return {
        width: size.width || 1920,
        height: size.height || 1080,
        duration: IMAGE_DISPLAY_DURATION,
        fps: 30,
        codec: 'image',
        type: 'image',
      };
    } catch (err) {
      console.warn(`[ffprobe] 无法读取图片 ${filePath}:`, err);
      return {
        width: 1920,
        height: 1080,
        duration: IMAGE_DISPLAY_DURATION,
        fps: 30,
        codec: 'image',
        type: 'image',
      };
    }
  }

  // 视频：用 ffprobe（一次取全部流，分别挑第一个视频流/音频流——音频编码也要回报，
  // 供预览白名单判定；旧行为只 select v:0 拿不到音频流）
  try {
    const ffprobePath = getFfprobePath();
    const {stdout} = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,width,height,duration,r_frame_rate',
      '-show_entries', 'format=duration',
      '-show_entries', 'format_tags=make,model',
      '-of', 'json',
      filePath,
    ]);

    const data = JSON.parse(stdout);
    const streams: {codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; r_frame_rate?: string;
      tags?: Record<string, string>}[] = data.streams ?? [];
    const stream = streams.find((s) => s.codec_type === 'video') ?? streams[0] ?? {};
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const format = data.format || {};
    // 录制设备厂商：format tags（mov/mp4 的 make/model）或视频流 tags（mxf 的
    // com/apple quicktime 键族兜底），供 Log 曲线猜测（guessColorCurveFromTags）
    const tagSource: Record<string, string> = {...(format.tags || {}), ...(stream.tags || {})};
    const make = tagSource.make || tagSource['com.apple.quicktime.make'] || tagSource.manufacturer || undefined;
    const model = tagSource.model || tagSource['com.apple.quicktime.model'] || undefined;

    // 解析帧率（可能是 "30/1" 或 "29.97"）
    const fpsStr = stream.r_frame_rate || '30/1';
    const [num, den] = fpsStr.split('/').map(Number);
    const fps = num && den ? num / den : 30;

    // 时长可能缺失（MediaRecorder 的 webm 无 Duration 元素，ffprobe 给 "N/A" 或干脆没有该字段）：
    // parseFloat('N/A') = NaN，归一为 0，由调用方决定兜底策略（录屏走实测时长）
    const parsedDuration = parseFloat(format.duration || stream.duration || '0');
    return {
      width: stream.width || 1920,
      height: stream.height || 1080,
      duration: Number.isFinite(parsedDuration) ? parsedDuration : 0,
      fps: Math.round(fps),
      codec: stream.codec_name || 'unknown',
      ...(audioStream?.codec_name ? {audioCodec: audioStream.codec_name} : {}),
      ...(make ? {make} : {}),
      ...(model ? {model} : {}),
      type: 'video',
    };
  } catch (err) {
    // ffprobe 不可用时的兜底：使用默认值
    // 注意 duration=0 会导致裁剪失效，调用方应提示用户
    console.warn(`[ffprobe] 无法解析 ${filePath}:`, err);
    return {
      width: 1920,
      height: 1080,
      duration: 0,
      fps: 30,
      codec: 'unknown',
      type: 'video',
    };
  }
};

/**
 * 录像实际帧率统计：nb_frames（实际帧数）+ avg_frame_rate（容器声明）+ duration。
 * MediaRecorder 的 webm 时长元数据不可靠（无 cues/Duration），调用方应优先用
 * frameCount÷实测时长，读不到帧数时再降级 avgFps 并标注 estimated。
 * 探测失败返回全 null（调用方静默降级，不影响保存链路）。
 */
export const getVideoFrameStats = async (filePath: string): Promise<VideoFrameStats> => {
  try {
    const ffprobePath = getFfprobePath();
    const {stdout} = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames,avg_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ]);
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] || {};
    const frameCount = parseInt(stream.nb_frames, 10);
    const [num, den] = String(stream.avg_frame_rate || '0/1').split('/').map(Number);
    const avg = num && den ? num / den : NaN;
    const duration = parseFloat(stream.duration || data.format?.duration || '');
    return {
      frameCount: Number.isFinite(frameCount) && frameCount > 0 ? frameCount : null,
      avgFps: Number.isFinite(avg) && avg > 0 ? Math.round(avg * 100) / 100 : null,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch (err) {
    console.warn(`[ffprobe] 帧率统计失败 ${filePath}:`, err);
    return {frameCount: null, avgFps: null, durationSec: null};
  }
};
