/**
 * 成片音频审片服务（主进程）——纯 ffmpeg 本地探测，不上传任何数据。
 *
 * 三路探测（stderr 解析在 shared/audio-review.ts 纯函数，可单测）：
 * 1. volumedetect：均值/峰值音量（爆音疑似）
 * 2. silencedetect：静音区间（问题段过滤在共享层）
 * 3. loudnorm JSON 探测：综合响度（对照 -14 LUFS 目标）
 *
 * 时长用 analyzeAudio 取（与 BGM 波形同一套）。仅分析已注册白名单的媒体路径
 * （渲染产物渲染完成时自动注册；不开放任意路径给渲染进程当探测探针）。
 */

import execa from 'execa';
import {getFfmpegPath, analyzeAudio} from './audio';
import {isRegisteredMediaPath} from './videoServer';
import {
  parseVolumeDetect, parseSilenceDetect, parseLoudnormProbe, parseLoudnormTp, meaningfulSilences,
  PEAK_CLIP_DB,
} from '../../shared/audio-review';
import type {AudioReviewReport} from '../../shared/audio-review';

export const analyzeRenderAudio = async (path: string): Promise<AudioReviewReport> => {
  if (!path || !isRegisteredMediaPath(path)) {
    throw new Error('成片未注册（仅可分析本应用渲染/导入过的媒体）');
  }
  const ffmpegPath = getFfmpegPath();
  // 注意参数顺序：-af 必须在输出（-f null -）之前，放在其后会被 ffmpeg 当作
  // 「下一个输出的选项」而静默丢弃（实测踩坑：探测结果全空）
  const nullOut = ['-f', 'null', '-'];

  const {duration} = await analyzeAudio(path).catch(() => ({duration: 0, peaks: [] as number[]}));

  const vol = await execa(ffmpegPath, ['-i', path, '-vn', '-af', 'volumedetect', ...nullOut], {reject: false});
  const sil = await execa(ffmpegPath, ['-i', path, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.5', ...nullOut], {reject: false});
  const loud = await execa(ffmpegPath, ['-i', path, '-vn', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', ...nullOut], {reject: false});

  const peak = parseVolumeDetect(`${vol.stderr}\n${vol.stdout}`);
  const spans = parseSilenceDetect(`${sil.stderr}\n${sil.stdout}`);
  const loudStderr = `${loud.stderr}\n${loud.stdout}`;
  const loudness = parseLoudnormProbe(loudStderr);
  // volumedetect 在 Remotion 精简 ffmpeg 中不存在（No such filter，静默失败）：
  // 峰值/爆音用 loudnorm 探测的真峰值（input_tp，dBTP）兜底，阈值与 volumedetect 路径一致
  let peakFinal = peak;
  if (peakFinal.meanDb === null && peakFinal.maxDb === null) {
    const tp = parseLoudnormTp(loudStderr);
    if (tp !== null) peakFinal = {meanDb: null, maxDb: tp, clippingSuspected: tp > PEAK_CLIP_DB};
  }

  return {
    loudness,
    peak: peakFinal,
    problemSilences: meaningfulSilences(spans, duration || 0),
    durationSec: Math.round(duration * 100) / 100,
  };
};
