/**
 * 源素材时间线分析（mine_highlights 的主进程半边）——纯本地 ffmpeg + 可选 ASR。
 *
 * 产出「素材时间线」：总时长、语音窗口（silencedetect 静音区间的补集）、
 * ASR 全量分段（带文字线索；未配置/失败自动降级，只回语音窗口 + 报错原因）。
 * 解析/聚类/提示词等纯逻辑在 shared/highlight-mining.ts（可单测）。
 *
 * 仅接受已注册白名单的媒体路径（IPC 层校验）——素材内容会经 ASR 发往
 * 第三方端点，与 asr:transcribe 同口径。
 */

import execa from 'execa';
import {getFfmpegPath, analyzeAudio} from './audio';
import {transcribeMediaRaw} from './asr';
import {parseSilenceDetect} from '../../shared/audio-review';
import {speechWindowsFromSilences} from '../../shared/highlight-mining';
import type {RawAsrSegment} from '../../shared/highlight-mining';
import {analyzeFootageCached} from './footage';
import {rankHighlightCandidates, type HighlightCandidate} from '../../shared/highlight-heuristics';

/** mining:analyzeTimeline IPC 返回的素材时间线 */
export interface SourceTimeline {
  /** 素材总时长（秒） */
  durationSec: number;
  /** 语音/有声窗口（媒体绝对秒；无音轨时退化为整条一个窗口） */
  speechWindows: {startSec: number; endSec: number}[];
  /** ASR 全量分段；未配置/失败时 undefined（asrError 说明原因） */
  asrSegments?: RawAsrSegment[];
  asrUsed: boolean;
  asrError?: string;
}

/** 挖矿可接受的最大素材时长（更长请先裁剪；防 MCP 120s 超时内跑不完） */
export const MINING_MAX_DURATION_SEC = 3600;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 分析一条素材的时间线：silencedetect 找静音 → 补集即有声窗口；
 * ASR 尽力而为（失败不阻断，调用方靠窗口 + 抽帧继续）。
 * opts.asrSegments 给出有效分段时直接复用（P0-4：转写已回写工程后挖矿不再重跑 ASR）。
 */
export const analyzeSourceTimeline = async (
  filePath: string,
  opts?: {asrSegments?: RawAsrSegment[]},
): Promise<SourceTimeline> => {
  if (!filePath || typeof filePath !== 'string') throw new Error('缺少素材路径');

  const {duration} = await analyzeAudio(filePath).catch(() => ({duration: 0, peaks: [] as number[]}));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法读取素材时长（文件可能损坏或不是视频/音频文件）');
  }
  if (duration > MINING_MAX_DURATION_SEC) {
    throw new Error(`素材时长 ${(duration / 60).toFixed(0)} 分钟超出挖矿上限（60 分钟），请先用 set_segment_trim 裁出候选区间`);
  }

  // silencedetect：-af 必须在 -f null - 之前（audioReview 同款踩坑注释）
  const sil = await execa(
    getFfmpegPath(),
    ['-i', filePath, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-'],
    {reject: false},
  );
  const spans = parseSilenceDetect(`${sil.stderr}\n${sil.stdout}`);
  const speechWindows = speechWindowsFromSilences(spans, duration).map((w) => ({
    startSec: round2(w.startSec),
    endSec: round2(w.endSec),
  }));

  const cached = (opts?.asrSegments ?? []).filter(
    (s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.text === 'string' && s.text.trim().length > 0,
  );
  let asrSegments: RawAsrSegment[] | undefined;
  let asrError: string | undefined;
  if (cached.length > 0) {
    asrSegments = cached; // 复用调用方缓存的转写（与素材现时长的同源校验由调用方负责）
  } else {
    try {
      asrSegments = await transcribeMediaRaw(filePath);
    } catch (err) {
      asrError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    durationSec: round2(duration),
    // 静音探测颗粒度有限：完全探测不到静音时视为「整条有声」（含无音轨素材，交给抽帧判断）
    speechWindows: speechWindows.length > 0 ? speechWindows : [{startSec: 0, endSec: round2(duration)}],
    ...(asrSegments !== undefined ? {asrSegments} : {}),
    asrUsed: asrSegments !== undefined,
    ...(asrError !== undefined ? {asrError} : {}),
  };
};

// ====== 启发式高光候选（mine_highlights 预筛层：零模型 token）======

export interface HighlightCandidateBundle {
  durationSec: number;
  shotCount: number;
  candidates: HighlightCandidate[];
  /** 每个候选的缩略图 dataUrl（面板墙/模型看图用，与 candidates 同序） */
  thumbnails: string[];
}

/**
 * 场景检测 + 音轨能量 + 代表帧曝光 → 启发式 top-N 候选（带缩略图）。
 * 模型未配置时这就是 mine_highlights 的完整产出；配置了则作为看图精选的先验。
 */
export const analyzeHighlightCandidates = async (
  filePath: string,
  opts?: {topN?: number; targetSec?: number},
): Promise<HighlightCandidateBundle> => {
  const topN = Math.max(1, Math.min(12, opts?.topN ?? 8));
  const map = await analyzeFootageCached(filePath);
  const audio = await analyzeAudio(filePath).catch(() => ({duration: 0, peaks: [] as number[]}));

  // 每镜头代表帧（中点）统计：48×27 rgb24 rawvideo 裸字节一次解出灰度分位 +
  // 肤色占比/中心肤色占比（人物概率弱信号；零解码成本）
  const luma: Array<{p5: number; p50: number; p95: number; skinRatio?: number; centerSkinRatio?: number}> = [];
  for (const s of map.shots) {
    try {
      const mid = Math.min(Math.max((s.startSec + s.endSec) / 2, 0.05), Math.max(0.05, map.durationSec - 0.05));
      luma.push(await ffmpegFrameStats(filePath, mid));
    } catch {
      luma.push({p5: 0, p50: 128, p95: 255}); // 抽帧失败按全动态范围（不惩罚）
    }
  }

  const candidates = rankHighlightCandidates(
    {shots: map.shots, audioPeaks: audio.peaks, shotLuma: luma, targetSec: opts?.targetSec},
    topN,
  );

  // 候选缩略图（中点帧 192px mjpeg 管道直出——不依赖 electron，本模块 electron-free 可脚本直跑）
  const thumbnails: string[] = [];
  for (const c of candidates) {
    try {
      const mid = (c.startSec + c.endSec) / 2;
      thumbnails.push(await thumbDataUrl(filePath, mid));
    } catch {
      thumbnails.push('');
    }
  }
  return {durationSec: round2(map.durationSec), shotCount: map.shots.length, candidates, thumbnails};
};

/**
 * 代表帧统计：48×27 rgb24 rawvideo 裸字节一次解出
 * - 灰度直方图分位（曝光质量信号）
 * - 肤色占比 + 中央 50% 区域肤色占比（人物概率弱信号：YCbCr 经典肤色区间，
 *   纯数学零依赖——不是人脸检测，是「画面里疑似有人物」的倾向分）
 */
const ffmpegFrameStats = async (filePath: string, t: number): Promise<{p5: number; p50: number; p95: number; skinRatio: number; centerSkinRatio: number}> => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const execFileAsync = promisify(execFile);
  const W = 48, H = 27;
  const ffmpeg = getFfmpegPath();
  const {stdout} = await execFileAsync(ffmpeg, [
    '-ss', String(Math.max(0, t)), '-i', filePath, '-frames:v', '1',
    '-vf', 'scale=48:27,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], {encoding: 'buffer', maxBuffer: 1024 * 1024}) as {stdout: Buffer};
  const px = stdout.subarray(0, W * H * 3);
  if (px.length < W * H * 3) return {p5: 0, p50: 128, p95: 255, skinRatio: 0, centerSkinRatio: 0};
  // YCbCr 肤色判定（经典区间）：Cb 77-127 / Cr 133-173 / Y>40 排暗部噪声
  let skin = 0, centerSkin = 0, centerN = 0;
  const cx0 = W >> 2, cx1 = W - cx0, cy0 = H >> 2, cy1 = H - cy0; // 中央 50%
  const grays: number[] = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      grays[y * W + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      const yy = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const isSkin = yy > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
      if (isSkin) skin++;
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
        centerN++;
        if (isSkin) centerSkin++;
      }
    }
  }
  const sorted = grays.sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    p5: at(5), p50: at(50), p95: at(95),
    skinRatio: skin / (W * H),
    centerSkinRatio: centerN > 0 ? centerSkin / centerN : 0,
  };
};

/** 中点帧缩略图（192px mjpeg 管道 → dataUrl；与抽帧视觉等价但零 electron 依赖） */
const thumbDataUrl = async (filePath: string, t: number): Promise<string> => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const execFileAsync = promisify(execFile);
  const {stdout} = await execFileAsync(getFfmpegPath(), [
    '-ss', String(Math.max(0, t)), '-i', filePath, '-frames:v', '1',
    '-vf', 'scale=192:192:force_original_aspect_ratio=decrease',
    '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1',
  ], {encoding: 'buffer', maxBuffer: 8 * 1024 * 1024}) as {stdout: Buffer};
  if (!stdout || stdout.length === 0) throw new Error('缩略图抽帧为空');
  return `data:image/jpeg;base64,${stdout.toString('base64')}`;
};
