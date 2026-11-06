/**
 * 音频分析 - 提取背景音乐的时长、波形峰值与节拍
 *
 * 用 Remotion 自带的 ffmpeg 将音频降采样为 8kHz 单声道 s16le PCM（走 wav muxer），
 * 再分桶取每桶最大幅度作为波形峰值（供 UI 画波形条）；同一份 PCM 送节拍检测
 * （shared/beat-detect：起振包络 → 自相关定速 → 梳状定相 → 网格精修），
 * 输出帧级精度的节拍时间与 BPM——卡点对齐/节拍脉冲/节拍音效都吃这份 beats。
 *
 * 注意：compositor 的精简 ffmpeg 构建未启用 f32le muxer（早期版本可用，升级后失效），
 * 必须用已启用的 wav muxer 输出 s16le，再按 16-bit PCM 解析（ffmpeg wav 头为 44 字节）。
 */

import execa from 'execa';
import {RenderInternals} from '@remotion/renderer';
import {detectBeatsFromSamples} from '../../shared/beat-detect';
import {classifyBeatBands} from '../../shared/beat-bands';
import {buildMusicMapFromSamples, type MusicMap} from '../../shared/music-map';

const getFfmpegPath = (): string =>
  RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
  });

// ASR 服务（services/asr.ts）复用同一取路径逻辑
export {getFfmpegPath};

export interface AudioAnalysis {
  duration: number;   // 秒
  peaks: number[];    // 0..1，每个桶的最大幅度（UI 波形条）
  beats: number[];    // 节拍时间（秒，升序）；检出失败为空数组
  bpm: number;        // 每分钟节拍数；未检出为 0
}

const SAMPLE_RATE = 8000;
const BUCKETS = 240;
const WAV_HEADER = 44;

/** 解码音频文件为 8kHz 单声道 PCM（wav muxer，44 字节头；与 analyzeAudio 同口径） */
const decodeTo8kPcm = async (filePath: string): Promise<Float32Array> => {
  const ffmpeg = getFfmpegPath();
  const {stdout} = await execa(
    ffmpeg,
    ['-i', filePath, '-f', 'wav', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'],
    {encoding: 'buffer', maxBuffer: 100 * 1024 * 1024}
  );
  const buf = stdout as unknown as Buffer;
  const ab = buf.buffer.slice(buf.byteOffset + WAV_HEADER, buf.byteOffset + buf.byteLength);
  const raw = new Int16Array(ab);
  const samples = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) samples[i] = raw[i] / 32768;
  return samples;
};

export const analyzeAudio = async (filePath: string): Promise<AudioAnalysis> => {
  const samples = await decodeTo8kPcm(filePath);
  const duration = samples.length / SAMPLE_RATE;

  const bucketSize = Math.max(1, Math.floor(samples.length / BUCKETS));
  const peaks: number[] = [];
  for (let i = 0; i < BUCKETS; i++) {
    let max = 0;
    const start = i * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    for (let j = start; j < end; j++) {
      const a = Math.abs(samples[j]);
      if (a > max) max = a;
    }
    peaks.push(Math.min(1, max));
  }
  // 节拍检测吃同一份 PCM（不重复解码）
  const {beats, bpm} = detectBeatsFromSamples(samples, SAMPLE_RATE);
  return {duration, peaks, beats, bpm};
};

/**
 * 音乐结构图（剪辑大脑的音乐理解层）：节拍 + 重拍 + 段落 + 每拍能量。
 * 与 analyzeAudio 分开入口——调用方只需要节拍网格时用 analyzeAudio（更轻）。
 */
export const analyzeMusicMap = async (filePath: string): Promise<MusicMap> => {
  const samples = await decodeTo8kPcm(filePath);
  const map = buildMusicMapFromSamples(samples, SAMPLE_RATE);
  // kick/snare 分频段逐拍强度：同一份 PCM，零额外解码成本
  if (map.beats.length > 0) {
    const {kick, snare} = classifyBeatBands(samples, map.beats);
    map.beatKicks = kick;
    map.beatSnares = snare;
  }
  return map;
};
