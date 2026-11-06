/**
 * TTS 语音合成服务（主进程）
 *
 * 职责：调用 OpenAI 兼容 /audio/speech 端点，把旁白文案合成 mp3 落盘到 userData/tts 缓存。
 * - API key 用 safeStorage 加密存 electron-store（与 llm.ts 同模式），永不回传渲染进程
 * - 按 baseUrl+model+voice+text 哈希缓存，相同输入不重复请求（TTS 文件跨机不迁移，靠 text 可重生成）
 * - duration 用 analyzeAudio（Remotion 自带 ffmpeg）取
 *
 * 网络/HTTP/格式错误统一转中文 Error，供渲染端直接展示。
 */

import {app, safeStorage} from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {getGlobalSettings, getTtsApiKeyEncrypted, setTtsApiKeyEncrypted} from './store';
import {filePathToHttpUrl} from './videoServer';
import {analyzeAudio} from './audio';
import type {TtsStatus, TtsSynthesizeRequest, TtsSynthesizeResult} from '../../shared/llm-chat';

/** 请求超时（语音合成可能较慢，给 60 秒） */
const REQUEST_TIMEOUT_MS = 60_000;

/** safeStorage 加密 API key；不可用时退化为 base64（与 llm.ts 一致） */
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
export const setTtsApiKey = (key: string): void => {
  const trimmed = (key || '').trim();
  setTtsApiKeyEncrypted(trimmed ? encryptKey(trimmed) : '');
};

/** 查询配置状态：只回 是否已配置/服务地址/模型/音色，key 永不回渲染进程 */
export const getTtsStatus = (): TtsStatus => {
  const settings = getGlobalSettings();
  return {
    configured: Boolean(getTtsApiKeyEncrypted()),
    baseUrl: settings.ttsBaseUrl || '',
    model: settings.ttsModel || '',
    voice: settings.ttsVoice || '',
  };
};

/** TTS 缓存目录：userData/tts/（不存在则创建） */
const getTtsCacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'tts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {recursive: true});
  }
  return dir;
};

/**
 * 合成语音。命中缓存时直接返回（不重复请求）。
 * @returns {path, src, duration} - src 为本地服务器 HTTP URL，供 Remotion <Audio> 播放
 */
export const synthesizeSpeech = async (req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> => {
  const text = (req.text || '').trim();
  if (!text) throw new Error('旁白文案为空');

  const settings = getGlobalSettings();
  const baseUrl = (settings.ttsBaseUrl || '').trim().replace(/\/+$/, '');
  const model = (settings.ttsModel || '').trim();
  const voice = (req.voice || settings.ttsVoice || 'alloy').trim();
  // 语速钳 0.5-2（OpenAI /audio/speech 规范范围；兼容端点不支持时自动忽略该字段）
  const speed = Math.min(2, Math.max(0.5, req.speed ?? 1));
  if (!baseUrl) throw new Error('未配置 TTS 服务地址，请到「设置 -> TTS 语音合成」中填写');
  if (!model) throw new Error('未配置 TTS 模型，请到「设置 -> TTS 语音合成」中填写');
  const keyEncrypted = getTtsApiKeyEncrypted();
  if (!keyEncrypted) throw new Error('未配置 TTS API Key，请到「设置 -> TTS 语音合成」中填写');
  let apiKey: string;
  try {
    apiKey = decryptKey(keyEncrypted);
  } catch {
    throw new Error('TTS API Key 解密失败，请到「设置 -> TTS 语音合成」中重新保存');
  }

  // 缓存命中：相同 baseUrl+model+voice+speed+text 直接复用（baseUrl 纳入哈希，换服务商不命中旧音频）
  const hash = crypto.createHash('sha1').update(`${baseUrl}|${model}|${voice}|${speed}|${text}`).digest('hex');
  const cachePath = path.join(getTtsCacheDir(), `${hash}.mp3`);
  if (fs.existsSync(cachePath)) {
    const analysis = await analyzeAudio(cachePath).catch(() => ({duration: 0, peaks: []}));
    return {path: cachePath, src: filePathToHttpUrl(cachePath), duration: analysis.duration};
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  /** 非 2xx 时的错误正文；2xx 时的音频内容（body 读取同样在超时保护内） */
  let errText = '';
  let buf: Buffer | null = null;
  try {
    res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({model, input: text, voice, speed, response_format: 'mp3'}),
      signal: controller.signal,
    });
    // body 读取也必须在 AbortController 保护内，否则收到响应头后超时就失效
    if (!res.ok) {
      errText = await res.text().catch(() => '');
    } else {
      buf = Buffer.from(await res.arrayBuffer());
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error('TTS 请求超时（60 秒），请检查网络或服务地址后重试');
    }
    throw new Error(`无法连接 TTS 服务：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const msg = errText.slice(0, 200) || res.statusText;
    throw new Error(`TTS 服务返回错误（HTTP ${res.status}）：${msg}`);
  }

  if (!buf || buf.length === 0) {
    throw new Error('TTS 服务返回空音频，请检查模型/音色配置');
  }
  fs.writeFileSync(cachePath, buf);
  const analysis = await analyzeAudio(cachePath).catch(() => ({duration: 0, peaks: []}));
  return {path: cachePath, src: filePathToHttpUrl(cachePath), duration: analysis.duration};
};
