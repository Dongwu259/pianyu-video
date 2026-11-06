/**
 * 渲染后处理计划（纯函数，无 Electron/Remotion 依赖，Node 可直跑单测）。
 *
 * 目前支持两类后处理，合并为一次 ffmpeg 调用（避免两遍转码）：
 * - 分辨率缩放：自定义分辨率/比例/免费版钳制（renderer.ts renderTo 已有逻辑的参数化）
 * - 响度归一化：loudnorm 到 -14 LUFS（社交/流媒体投放标准；动图/静音无音轨自动跳过）。
 *   **两遍线性口径**（2026-10-12 修复）：先测量（print_format=json）再带 measured_* + linear=true
 *   应用常量增益。单遍动态模式的 ~3s 自适应增益沉降是「BGM 开头响后面软」的根源——
 *   恒幅正弦对照实测 -13→-19dB（scripts/verify-bgm-decay.mjs 复现/验收）。
 *
 * 视频流策略：仅 loudnorm 时 `-c:v copy` 不触碰视频（保留 NVENC/QSV 产物、秒级完成）；
 * 需要缩放时视频必须重编码（维持原行为，不带 -c:v 走 ffmpeg 默认编码器）。
 * 音频流策略：loudnorm 必须重编码，按容器映射编码器（aac/libopus/pcm_s16le）；
 * loudnorm 内部会把音频上采样到 192kHz 做真峰值检测，不重钉采样率的话 AAC 会按
 * 上限落到 96kHz——部分播放器解码 96kHz AAC 无声，统一钉回 48kHz。
 */

import type {RenderFormat} from '../../shared/types';

/** loudnorm 滤镜参数：-14 LUFS 综合响度、-1.5 dBTP 真峰值上限、11 LU 响度范围 */
export const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

/** 两遍线性 loudnorm 的测量结果（ffmpeg loudnorm print_format=json 的 input_* 字段） */
export interface LoudnormMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
}

/** 测量遍的 -af 参数（配 -i 成片 + -f null -；跑完从 stderr 解析 JSON）。
 *  -vn 必须：Remotion 裁剪版 ffmpeg 的 null muxer 视频编码器被禁（wrapped_avframe），
 *  带视频流会「Error selecting an encoder」——audioReview 同款口径。 */
export const loudnormMeasureArgs = (): string[] => ['-vn', '-af', `${LOUDNORM_FILTER}:print_format=json`, '-f', 'null', '-'];

/** 从测量遍 stderr 解析 input_*（loudnorm 在结尾打一段 JSON；失败返回 null 走单遍降级） */
export const parseLoudnormMeasurement = (stderr: string): LoudnormMeasurement | null => {
  const text = stderr ?? '';
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const v = [j.input_i, j.input_tp, j.input_lra, j.input_thresh].map(Number);
    if (v.some((x) => !Number.isFinite(x))) return null;
    return {inputI: v[0], inputTp: v[1], inputLra: v[2], inputThresh: v[3]};
  } catch {
    return null;
  }
};

/**
 * 两遍线性 loudnorm 滤镜串：measured_* + linear=true = 全程常量增益（无动态沉降）。
 * LRA 目标放宽到 max(11, 实测 LRA)——线性模式在「实测响度范围 > 目标」时 ffmpeg 会
 * 静默回退动态模式（正是要消灭的行为），放宽目标保证线性恒成立（我们只要响度归一，
 * 不需要压动态范围）。
 */
export const linearLoudnormFilter = (m: LoudnormMeasurement): string =>
  `loudnorm=I=-14:TP=-1.5:LRA=${Math.max(11, m.inputLra)}:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:linear=true`;

export interface PostProcessOptions {
  /** 是否需要缩放到 targetWidth/Height */
  needsResize: boolean;
  targetWidth?: number;
  targetHeight?: number;
  /** 用户开启响度归一化（RenderOptions.loudnorm） */
  loudnorm: boolean;
  /** 测量遍结果：给出则用两遍线性滤镜（推荐路径）；缺省回退单遍动态（降级，带沉降） */
  loudnormMeasured?: LoudnormMeasurement | null;
  format: RenderFormat;
  /** 静音导出（无音轨，loudnorm 自动跳过） */
  muted: boolean;
}

export interface PostProcessPlan {
  /** false = 无需后处理，renderTo 直接输出最终文件 */
  needed: boolean;
  /** 本次计划包含 loudnorm（无音轨的产物跑 -af 会失败，调用方需准备降级路径） */
  hasLoudnorm: boolean;
  /** 本次 loudnorm 为两遍线性（测量已注入；false = 单遍动态降级） */
  isLinear: boolean;
  /** 组装好的 ffmpeg 参数（不含 -i/输入/输出/-y，便于拼进 execa 调用） */
  args: string[];
  /** 人类可读的后处理说明（日志用） */
  summary: string;
}

/** loudnorm 是否对该格式/选项组合生效（gif 无音频；muted 无音轨） */
export const loudnormApplicable = (format: RenderFormat, muted: boolean): boolean =>
  format !== 'gif' && !muted;

/** 各容器的 loudnorm 音频重编码参数 */
const audioCodecArgs = (format: RenderFormat): string[] => {
  switch (format) {
    case 'mp4':
    case 'mp4-hevc':
      return ['-c:a', 'aac', '-b:a', '192k'];
    case 'webm':
      return ['-c:a', 'libopus', '-b:a', '128k'];
    case 'mov':
      return ['-c:a', 'pcm_s16le'];
    default:
      return ['-c:a', 'copy'];
  }
};

/**
 * 生成后处理计划：
 * - 仅缩放：-vf scale + -c:a copy（与原 renderTo 行为一致）
 * - 仅 loudnorm：-af loudnorm + -c:v copy + 按容器重编码音频
 * - 两者都要：-vf + -af 合并（视频随缩放重编码，音频重编码）
 */
export const planPostProcess = (opts: PostProcessOptions): PostProcessPlan => {
  const doLoudnorm = opts.loudnorm && loudnormApplicable(opts.format, opts.muted);
  const doResize = opts.needsResize;
  if (!doLoudnorm && !doResize) return {needed: false, hasLoudnorm: false, isLinear: false, args: [], summary: ''};

  const args: string[] = [];
  const parts: string[] = [];

  if (doResize) {
    const w = Math.max(2, Math.floor((opts.targetWidth ?? 0) / 2) * 2);
    const h = Math.max(2, Math.floor((opts.targetHeight ?? 0) / 2) * 2);
    args.push(
      '-vf',
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    );
    parts.push(`缩放至 ${w}x${h}`);
  }

  let isLinear = false;
  if (doLoudnorm) {
    // loudnorm 内部上采样 192kHz 测真峰值，输出须钉回 48kHz（否则 AAC 落到 96kHz，部分播放器无声）
    const measured = opts.loudnormMeasured ?? null;
    const filter = measured ? linearLoudnormFilter(measured) : LOUDNORM_FILTER;
    isLinear = !!measured;
    args.push('-af', filter, ...audioCodecArgs(opts.format), '-ar', '48000');
    parts.push(isLinear ? `响度归一化 -14 LUFS（两遍线性：实测 I=${measured!.inputI}）` : '响度归一化 -14 LUFS（单遍动态降级——有 ~3s 起始沉降）');
  }

  // 视频流：仅 loudnorm 时 copy；缩放时不指定（重编码，维持原 resize 行为）
  if (doLoudnorm && !doResize) {
    args.push('-c:v', 'copy');
  } else if (doResize && !doLoudnorm) {
    args.push('-c:a', 'copy');
  }

  return {needed: true, hasLoudnorm: doLoudnorm, isLinear, args, summary: parts.join(' + ')};
};
