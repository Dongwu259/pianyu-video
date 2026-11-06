/**
 * 文生图服务（主进程）——OpenAI 兼容 /images/generations 端点。
 *
 * 与 AI 助手共用服务地址与 API Key（聚合网关普遍同端点同 Key 提供对话与生图模型），
 * 仅模型名单独配置（设置 → 文生图，如 dall-e-3 / flux / cogview-3 等视服务商而定）。
 * - 生成结果（b64_json 或 url 二次拉取）落盘 userData/imagegen/ 哈希缓存，相同
 *   prompt+model+size 不重复请求
 * - 落盘后注册媒体白名单并转本地 HTTP URL（与素材导入同口径，可直接进故事板）
 * - 图片格式按魔数嗅探（PNG/JPEG/WebP），不信任响应头
 *
 * 网络/HTTP/格式错误统一转中文 Error。
 */

import {app, safeStorage} from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {getGlobalSettings, getLlmApiKeyEncrypted} from './store';
import {registerMediaPath, filePathToHttpUrl} from './videoServer';
import type {ImageGenRequest, ImageGenResult, ImageGenStatus} from '../../shared/image-gen';

const REQUEST_TIMEOUT_MS = 180_000; // 生图普遍 10-60s，给足 3 分钟

/** 允许的尺寸：256-4096 的 WxH（各生图模型的合法尺寸集不同，做范围校验而非枚举） */
export const DEFAULT_IMAGE_SIZE = '1792x1024';

export const isValidImageSize = (size: string): boolean => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!m) return false;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w >= 256 && w <= 4096 && h >= 256 && h <= 4096;
};

/** WxH → DashScope 原生 W*H；就近映射到 qwen-image 官方档位（错档会被 API 拒） */
export const toDashScopeSize = (size: string): string => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  const w = m ? Number(m[1]) : 1792;
  const h = m ? Number(m[2]) : 1024;
  if (w === h) return '1328*1328';
  return w > h ? '1664*928' : '928*1664';
};

/** 阿里云百炼/DashScope 端点走原生同步 API（/compatible-mode/v1/images/generations 404，实测） */
const isDashScopeHost = (baseUrl: string): boolean => /aliyuncs\.com/.test(baseUrl);

/** 原生端点 origin：剥掉 /compatible-mode/v1 或 /api/v1 尾巴 */
const dashScopeOrigin = (baseUrl: string): string => baseUrl.replace(/\/(compatible-mode|api)\/v1\/?$/, '');

export const getImageGenStatus = (): ImageGenStatus => {
  const settings = getGlobalSettings();
  const model = (settings.imageGenModel || '').trim();
  return {
    configured: Boolean(model) && Boolean(getLlmApiKeyEncrypted()),
    baseUrl: (settings.imageGenBaseUrl || settings.llmBaseUrl || '').trim(),
    model,
  };
};

const imageGenCacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'imagegen');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
  return dir;
};

/** 图片魔数嗅探：返回扩展名（不认识返回空串） */
const sniffImageExt = (buf: Buffer): string => {
  if (buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
};

/**
 * 生成图片。命中缓存（prompt+baseUrl+model+size 哈希）时直接复用。
 * @returns {path, src} - src 为本地 HTTP URL，Remotion <Img> 可直接渲染
 */
export const generateImage = async (req: ImageGenRequest): Promise<ImageGenResult> => {
  const prompt = (req.prompt || '').trim();
  if (!prompt) throw new Error('生图提示词为空');
  const settings = getGlobalSettings();
  const baseUrl = (settings.imageGenBaseUrl || settings.llmBaseUrl || '').trim().replace(/\/+$/, '');
  const model = (settings.imageGenModel || '').trim();
  const size = req.size && isValidImageSize(req.size) ? req.size : DEFAULT_IMAGE_SIZE;
  if (!baseUrl) throw new Error('未配置生图服务地址，请到「设置 → AI 助手 / 文生图」中填写');
  if (!model) throw new Error('未配置生图模型名，请到「设置 → 文生图」中填写（如 dall-e-3，与 AI 助手共用地址和 Key）');
  const keyEncrypted = getLlmApiKeyEncrypted();
  if (!keyEncrypted) throw new Error('未配置 API Key，请到「设置 → AI 助手」中保存 Key（文生图与 AI 助手共用）');
  let apiKey: string;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      apiKey = safeStorage.decryptString(Buffer.from(keyEncrypted, 'base64'));
    } else {
      apiKey = Buffer.from(keyEncrypted, 'base64').toString('utf8');
    }
  } catch {
    throw new Error('API Key 解密失败，请到「设置 → AI 助手」重新保存');
  }

  const hash = crypto.createHash('sha1').update(`${baseUrl}|${model}|${size}|${prompt}`).digest('hex');
  for (const ext of ['png', 'jpg', 'webp']) {
    const cached = path.join(imageGenCacheDir(), `${hash}.${ext}`);
    if (fs.existsSync(cached)) {
      registerMediaPath(cached);
      return {path: cached, src: filePathToHttpUrl(cached)};
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  type ImageGenResponse = {data?: Array<{b64_json?: string; url?: string}>};
  let json: ImageGenResponse | null = null;
  let imageUrl: string | null = null;
  let errText = '';
  let errStatus = 0;
  try {
    if (isDashScopeHost(baseUrl)) {
      // DashScope 原生同步生成（qwen-image 系列；size 用 * 分隔，返回 OSS 预签名 URL）
      const res = await fetch(`${dashScopeOrigin(baseUrl)}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({
          model,
          input: {messages: [{role: 'user', content: [{text: prompt}]}]},
          parameters: {size: toDashScopeSize(size), n: 1},
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        errStatus = res.status;
        errText = await res.text().catch(() => '');
        json = null;
      } else {
        const native = await res.json() as {
          output?: {choices?: Array<{message?: {content?: Array<{image?: string}>}}>} | null;
          code?: string; message?: string;
        };
        if (native.code) {
          // DashScope 业务错误（InvalidParameter 等）HTTP 也可能 200，统一转中文错误
          throw new Error(`生图服务返回错误：${native.code} ${native.message || ''}（确认模型名与尺寸）`);
        }
        imageUrl = native.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image || null;
        if (!imageUrl) throw new Error('生图服务未返回图片（确认模型支持文生图）');
      }
    } else {
      const res = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({model, prompt, size, n: 1, response_format: 'b64_json'}),
        signal: controller.signal,
      });
      if (!res.ok) {
        errStatus = res.status;
        errText = await res.text().catch(() => '');
        json = null;
      } else {
        json = await res.json() as ImageGenResponse;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('生图服务')) throw err;
    if (controller.signal.aborted) {
      throw new Error('生图请求超时（3 分钟），请检查网络或换更快的模型后重试');
    }
    throw new Error(`无法连接生图服务：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!json && !imageUrl) {
    const msg = errText.slice(0, 200);
    throw new Error(`生图服务返回错误（HTTP ${errStatus || '非 2xx'}）：${msg || '无响应正文'}（确认模型名正确、端点支持生图）`);
  }
  const first = json?.data?.[0];
  let buf: Buffer | null = null;
  if (!imageUrl && first) {
    if (first.b64_json) {
      buf = Buffer.from(first.b64_json, 'base64');
    } else if (first.url) {
      // 部分端点只回 URL（含预签名 OSS/S3 链接），二次拉取；这是生图端点自己返回的地址
      const imgRes = await fetch(first.url, {signal: controller.signal}).catch(() => null);
      if (!imgRes || !imgRes.ok) throw new Error('生图服务返回的图片 URL 拉取失败');
      buf = Buffer.from(await imgRes.arrayBuffer());
    }
  } else if (imageUrl) {
    const imgRes = await fetch(imageUrl, {signal: controller.signal}).catch(() => null);
    if (!imgRes || !imgRes.ok) throw new Error('生图结果（OSS 预签名链接）拉取失败，请重试');
    buf = Buffer.from(await imgRes.arrayBuffer());
  }
  const ext = buf ? sniffImageExt(buf) : '';
  if (!buf || !ext) throw new Error('生图服务返回内容不是有效图片（PNG/JPEG/WebP），请检查模型是否支持生图');

  const file = path.join(imageGenCacheDir(), `${hash}.${ext}`);
  fs.writeFileSync(file, buf);
  registerMediaPath(file);
  return {path: file, src: filePathToHttpUrl(file)};
};
