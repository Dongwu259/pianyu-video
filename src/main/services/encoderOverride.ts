/**
 * 硬件编码器（NVENC / QSV）探测与 Remotion ffmpegOverride 参数改写
 *
 * 背景：renderMedia 的 hardwareAcceleration 选项在 Windows 上是空操作
 * （Remotion 只对 darwin 映射 VideoToolbox，见 renderer/dist/get-codec-name.js）。
 * 这里改用官方 ffmpegOverride 钩子，把 stitcher 的 libx264 软件编码参数改写为
 * h264_nvenc / h264_qsv 硬件编码参数（改写点见 stitch-frames-to-video.js：
 * ffmpegOverride({type:'stitcher', args})，argv 内含 -c:v libx264 -preset <p> -crf <n>）。
 *
 * 前置条件：Remotion 内置的精简 ffmpeg 只编了 libx264（无 h264_nvenc/h264_qsv），
 * 硬件编码需要完整版 ffmpeg 构建——经 PIANYU_FFMPEG_DIR 环境变量指定
 * （目录约定见 services/renderer.ts getBinariesDir），否则探测恒为不可用、自动回退软件编码。
 *
 * 本模块只做纯逻辑 + 一次子进程探测，不 import electron，可直接单元测试。
 */

import {execFile} from 'child_process';
import type {FfmpegOverrideFn} from '@remotion/renderer';
import type {RenderEncoder, RenderEncoderUsed} from '../../shared/types';

/** 探测到的可用硬件编码器 */
export interface DetectedEncoders {
  nvenc: boolean;  // h264_nvenc（NVIDIA）
  qsv: boolean;    // h264_qsv（Intel Quick Sync）
}

/**
 * x264 预设 → NVENC p1..p7（ffmpeg ≥ 6 的 NVENC 预设体系；越慢质量越高）
 * x264 共 9 档而 NVENC 只有 7 档，slow/slower/veryslow 合并到 p7
 */
const NVENC_PRESET_BY_X264: Record<string, string> = {
  ultrafast: 'p1',
  superfast: 'p2',
  veryfast: 'p3',
  faster: 'p4',
  fast: 'p5',
  medium: 'p6',
  slow: 'p7',
  slower: 'p7',
  veryslow: 'p7',
};

/** x264 预设 → QSV 预设（QSV 与 x264 同名子集 veryfast..veryslow，缺的两档并入 veryfast） */
const QSV_PRESET_BY_X264: Record<string, string> = {
  ultrafast: 'veryfast',
  superfast: 'veryfast',
  veryfast: 'veryfast',
  faster: 'faster',
  fast: 'fast',
  medium: 'medium',
  slow: 'slow',
  slower: 'slower',
  veryslow: 'veryslow',
};

/**
 * 解析 `ffmpeg -hide_banner -encoders` 输出，识别 h264_nvenc / h264_qsv
 * （编码器列表行形如 " V..... h264_nvenc  NVIDIA NVENC H.264 encoder (codec h264)"，
 *   只匹配第二列的编码器名，避免命中描述文本；纯函数，便于单测）
 */
export const parseEncoderList = (output: string): DetectedEncoders => {
  const found: DetectedEncoders = {nvenc: false, qsv: false};
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*V\S*\s+(\S+)\s/);
    if (!m) continue;
    if (m[1] === 'h264_nvenc') found.nvenc = true;
    if (m[1] === 'h264_qsv') found.qsv = true;
  }
  return found;
};

/** 探测结果缓存（编码器支持取决于机器与 ffmpeg 构建，进程内不变；失败不缓存以便下次重试） */
let detectedCache: DetectedEncoders | null = null;

/**
 * 运行 `<ffmpeg> -hide_banner -encoders` 探测硬件编码器（结果缓存）。
 * 任何执行错误都按「无硬件编码器」处理，绝不影响渲染主流程。
 */
export const detectEncoders = async (ffmpegPath: string): Promise<DetectedEncoders> => {
  if (detectedCache) return detectedCache;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        ffmpegPath,
        ['-hide_banner', '-encoders'],
        {timeout: 15000, maxBuffer: 4 * 1024 * 1024},
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });
    detectedCache = parseEncoderList(stdout);
    return detectedCache;
  } catch (err) {
    console.warn(`[Encoder] 编码器探测失败，按无硬件编码器处理: ${err}`);
    return {nvenc: false, qsv: false};
  }
};

/** 仅供测试重置探测缓存 */
export const resetEncoderDetectionCache = (): void => {
  detectedCache = null;
};

/**
 * 把用户选择解析为实际使用的编码器：
 * auto = NVENC → QSV → 软件；显式指定的硬件编码器不可用时回退软件
 */
export const resolveEncoder = (requested: RenderEncoder, detected: DetectedEncoders): RenderEncoderUsed => {
  if (requested === 'nvenc') return detected.nvenc ? 'nvenc' : 'software';
  if (requested === 'qsv') return detected.qsv ? 'qsv' : 'software';
  if (requested === 'auto') return detected.nvenc ? 'nvenc' : detected.qsv ? 'qsv' : 'software';
  return 'software';
};

/**
 * 改写 stitcher argv 为硬件编码（纯函数）：
 * - `-c:v libx264` → `-c:v h264_nvenc|h264_qsv`（不含该对则整体原样返回，保守不改）
 * - `-preset <x264预设>` → NVENC p1..p7 / QSV veryfast..veryslow（不认识的值原样保留）
 * - `-crf <n>` → NVENC `-rc vbr -cq <n>` / QSV `-global_quality <n>`
 * - 其余 token（-pix_fmt / -movflags / -b:v / -maxrate / -bufsize / 音频与路径等）原样透传
 */
const rewriteStitcherArgs = (args: string[], encoder: 'nvenc' | 'qsv'): string[] => {
  const encoderName = encoder === 'nvenc' ? 'h264_nvenc' : 'h264_qsv';
  const presetMap = encoder === 'nvenc' ? NVENC_PRESET_BY_X264 : QSV_PRESET_BY_X264;

  // 确认是预期的 libx264 软件编码参数再动手，否则整体透传
  const cvIdx = args.indexOf('-c:v');
  if (cvIdx === -1 || args[cvIdx + 1] !== 'libx264') return args;

  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const next = args[i + 1];
    if (tok === '-c:v' && next === 'libx264') {
      out.push('-c:v', encoderName);
      i++;
      continue;
    }
    if (tok === '-preset' && next !== undefined && presetMap[next]) {
      out.push('-preset', presetMap[next]);
      i++;
      continue;
    }
    if (tok === '-crf' && next !== undefined && /^\d+$/.test(next)) {
      // NVENC 无 crf 概念：vbr 码控 + 恒定质量目标；QSV 用全局质量
      if (encoder === 'nvenc') out.push('-rc', 'vbr', '-cq', next);
      else out.push('-global_quality', next);
      i++;
      continue;
    }
    out.push(tok);
  }
  return out;
};

/**
 * 生成 Remotion renderMedia 的 ffmpegOverride。
 * 只在「h264 输出 + 硬件编码器」时返回改写函数；其余情况（prores/vp9/软件编码）
 * 返回 undefined，调用方按未设置处理。'pre-stitcher' 调用一律原样透传。
 */
export const makeFfmpegOverride = (
  {encoder, codec}: {encoder: RenderEncoderUsed; codec: 'h264' | 'prores' | 'vp9'}
): FfmpegOverrideFn | undefined => {
  if (codec !== 'h264') return undefined;
  if (encoder !== 'nvenc' && encoder !== 'qsv') return undefined;
  return ({type, args}) => (type === 'stitcher' ? rewriteStitcherArgs(args, encoder) : args);
};
