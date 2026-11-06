/**
 * ASR 语音识别服务（主进程）
 *
 * 职责：把素材音频抽成 16kHz 单声道 wav，POST 到 OpenAI 兼容 /audio/transcriptions，
 * 解析 verbose_json 为 CaptionLine[]（解析与钳制见 shared/asr.ts）。
 * - API key 用 safeStorage 加密存 electron-store（与 llm.ts/tts.ts 同模式），永不回传渲染进程
 * - baseUrl/model 自主进程全局设置读取（不信任渲染端入参，key 只发向用户配置的端点）
 * - 抽出的临时 wav 在 os.tmpdir()（promo-asr- 前缀），用完即删
 *
 * 网络/HTTP/格式错误统一转中文 Error，供渲染端直接展示。
 */

import {safeStorage} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import execa from 'execa';
import {getGlobalSettings, getAsrApiKeyEncrypted, setAsrApiKeyEncrypted} from './store';
import {getFfmpegPath} from './audio';
import {segmentsToCaptions} from '../../shared/asr';
import type {AsrStatus, AsrTranscribeRequest, AsrVerboseSegment} from '../../shared/asr';
import type {CaptionLine} from '../../shared/types';

/** 请求超时（长素材转录可能较慢，给 120 秒） */
const REQUEST_TIMEOUT_MS = 120_000;

/** safeStorage 加密 API key；不可用时退化为 base64（与 llm.ts/tts.ts 一致） */
const encryptKey = (key: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64');
  }
  return Buffer.from(key, 'utf8').toString('base64');
};

const decryptKey = (keyEncrypted: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(keyEncrypted, 'base64'));
  }
  return Buffer.from(keyEncrypted, 'base64').toString('utf8');
};

/** 保存 API key（空字符串 = 清除） */
export const setAsrApiKey = (key: string): void => {
  const trimmed = (key || '').trim();
  setAsrApiKeyEncrypted(trimmed ? encryptKey(trimmed) : '');
};

/** 查询配置状态：只回 是否已配置/服务地址/模型，key 永不回渲染进程 */
export const getAsrStatus = (): AsrStatus => {
  const settings = getGlobalSettings();
  return {
    configured: Boolean(getAsrApiKeyEncrypted()),
    baseUrl: settings.asrBaseUrl || '',
    model: settings.asrModel || '',
  };
};

/** 用 Remotion 自带 ffmpeg 抽 16kHz 单声道 wav 到临时目录（调用方负责删除） */
const extractAudioForAsr = async (filePath: string): Promise<string> => {
  const wavPath = path.join(
    os.tmpdir(),
    `promo-asr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`,
  );
  try {
    await execa(getFfmpegPath(), ['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath]);
  } catch (err) {
    throw new Error(`提取素材音频失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return wavPath;
};

/** 读取 ASR 端点配置并解密 key；未配置抛中文 Error（两条转录路径共用） */
const resolveAsrConfig = async (): Promise<{baseUrl: string; model: string; apiKey: string}> => {
  const settings = getGlobalSettings();
  const baseUrl = (settings.asrBaseUrl || '').trim().replace(/\/+$/, '');
  const model = (settings.asrModel || '').trim() || 'whisper-1';
  if (!baseUrl) throw new Error('未配置 ASR 服务地址，请到「设置 -> 语音识别（ASR）」中填写');
  const keyEncrypted = getAsrApiKeyEncrypted();
  if (!keyEncrypted) throw new Error('未配置 ASR API Key，请到「设置 -> 语音识别（ASR）」中填写');
  try {
    return {baseUrl, model, apiKey: decryptKey(keyEncrypted)};
  } catch {
    throw new Error('ASR API Key 解密失败，请到「设置 -> 语音识别（ASR）」中重新保存');
  }
};

/** 单个 wav → verbose_json 分段（网络/格式错误统一转中文 Error） */
const postTranscribeVerbose = async (
  wavPath: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<AsrVerboseSegment[]> => {
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('file', new Blob([fs.readFileSync(wavPath)], {type: 'audio/wav'}), 'audio.wav');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    // body 读取也必须在 AbortController 保护内，否则收到响应头后超时就失效
    text = await res.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('ASR 请求超时（120 秒），请检查网络或服务地址后重试');
    }
    throw new Error(`无法连接 ASR 服务：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 保留 data 为 null，走下方统一报错
  }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 200) || res.statusText;
    throw new Error(`ASR 服务返回错误（HTTP ${res.status}）：${msg}`);
  }
  if (!Array.isArray(data?.segments)) {
    throw new Error('ASR 服务返回格式异常（缺少 segments），请确认端点支持 verbose_json');
  }
  return data.segments as AsrVerboseSegment[];
};

/**
 * 原始转录（mine_highlights 用）：返回整条媒体的全量时间戳分段，不做段时长钳制。
 * 长音频自动分块（480s/块 ≈ 15MB 16kHz wav，留足 OpenAI 兼容端点 25MB 上限），
 * 分块时间戳按块起点累加回媒体绝对秒。未配置/失败抛中文 Error（调用方降级继续）。
 */
export const transcribeMediaRaw = async (filePath: string): Promise<AsrVerboseSegment[]> => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('缺少素材路径');
  const {baseUrl, model, apiKey} = await resolveAsrConfig();

  // 先整段抽 16k wav；过长再按 480s 等分切块（16-bit PCM = 32000 字节/秒，44B wav 头）
  const whole = await extractAudioForAsr(filePath);
  const chunkPrefix = path.join(os.tmpdir(), `promo-asr-chunk-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const CHUNK_SEC = 480;
  const wavBytes = fs.statSync(whole).size - 44;
  const durationSec = wavBytes / 32000;
  const chunkPaths: string[] = [];
  try {
    if (durationSec <= CHUNK_SEC * 1.05) {
      chunkPaths.push(whole);
    } else {
      // -f segment 按时间等分 PCM：块边界由采样数决定（误差 < 0.001s），块起点 = 序号 × CHUNK_SEC
      await execa(getFfmpegPath(), [
        '-y', '-i', whole, '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(CHUNK_SEC), `${chunkPrefix}-%03d.wav`,
      ]);
      fs.unlinkSync(whole);
      const files = fs.readdirSync(path.dirname(chunkPrefix))
        .filter((f) => f.startsWith(path.basename(chunkPrefix) + '-') && f.endsWith('.wav'))
        .sort();
      for (const f of files) chunkPaths.push(path.join(path.dirname(chunkPrefix), f));
      if (chunkPaths.length === 0) throw new Error('ASR 音频分块失败');
    }

    const out: AsrVerboseSegment[] = [];
    for (let i = 0; i < chunkPaths.length; i++) {
      const offset = i * CHUNK_SEC;
      const segments = await postTranscribeVerbose(chunkPaths[i]!, baseUrl, apiKey, model);
      for (const s of segments) {
        if (typeof s?.start !== 'number' || typeof s?.end !== 'number') continue;
        out.push({start: s.start + offset, end: s.end + offset, text: typeof s.text === 'string' ? s.text : ''});
      }
    }
    return out;
  } finally {
    for (const p of chunkPaths) fs.unlink(p, () => {});
    // 整段未切块时 whole 已在 chunkPaths 里删过；切块路径下 whole 已显式删除，兜底再删一次
    if (fs.existsSync(whole)) fs.unlink(whole, () => {});
  }
};

/**
 * 转录素材语音为字幕行。
 * model/response_format=verbose_json；key 自主进程设置读取。
 * 所有失败路径抛中文 Error。
 */
export const transcribeMedia = async (req: AsrTranscribeRequest): Promise<CaptionLine[]> => {
  if (!req || typeof req.path !== 'string' || !req.path) {
    throw new Error('缺少素材路径');
  }
  const segmentDuration = req.segmentDuration;
  if (typeof segmentDuration !== 'number' || !Number.isFinite(segmentDuration) || segmentDuration <= 0) {
    throw new Error('片段时长不合法');
  }

  const {baseUrl, model, apiKey} = await resolveAsrConfig();

  const wavPath = await extractAudioForAsr(req.path);
  try {
    const segments = await postTranscribeVerbose(wavPath, baseUrl, apiKey, model);
    return segmentsToCaptions(segments, segmentDuration);
  } finally {
    // 临时 wav 用完即删
    fs.unlink(wavPath, () => {});
  }
};
