/**
 * Stock 素材搜索/下载服务（主进程）——Pexels + Pixabay 聚合。
 *
 * 职责：
 * - searchStockMedia：两家都查（只查已配 key 的家），归一化合并返回 StockMediaItem[]
 * - downloadStockMedia：域名白名单校验后下载到 userData/stock-media/，注册媒体
 *   白名单并转本地 HTTP URL（与手动导入素材同口径，Remotion 可直接用）
 * - fetchStockThumbnail：缩略图代下载转 dataUrl（渲染进程不直连外网，MCP 回图用）
 *
 * API key 用 safeStorage 加密存 electron-store（与 llm.ts/tts.ts 同模式），永不回传渲染进程。
 * 网络/HTTP/格式错误统一转中文 Error。两家素材均免费商用免署名（页面链接随结果返回）。
 */

import {app, safeStorage} from 'electron';
import fs from 'fs';
import path from 'path';
import {
  getStockPexelsKeyEncrypted, setStockPexelsKeyEncrypted,
  getStockPixabayKeyEncrypted, setStockPixabayKeyEncrypted,
} from './store';
import {registerMediaPath, filePathToHttpUrl} from './videoServer';
import {
  orientationParam, isAllowedStockUrl,
  pexelsVideosToItems, pexelsPhotosToItems,
  pixabayVideosToItems, pixabayPhotosToItems,
} from '../../shared/stock-media';
import type {StockMediaItem, StockSearchRequest, StockDownloadRequest, StockProvider} from '../../shared/stock-media';

const REQUEST_TIMEOUT_MS = 30_000;
/** 单文件下载上限（视频大文件保护） */
const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;

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

/** 保存某家的 API key（空字符串 = 清除） */
export const setStockApiKey = (provider: StockProvider, key: string): void => {
  const trimmed = (key || '').trim();
  const enc = trimmed ? encryptKey(trimmed) : '';
  if (provider === 'pexels') setStockPexelsKeyEncrypted(enc);
  else setStockPixabayKeyEncrypted(enc);
};

const providerKey = (provider: StockProvider): string => {
  const enc = provider === 'pexels' ? getStockPexelsKeyEncrypted() : getStockPixabayKeyEncrypted();
  if (!enc) return '';
  try {
    return decryptKey(enc);
  } catch {
    return '';
  }
};

/** 配置状态：哪家可用（key 永不回渲染进程） */
export const getStockStatus = (): {pexels: boolean; pixabay: boolean} => ({
  pexels: Boolean(getStockPexelsKeyEncrypted()),
  pixabay: Boolean(getStockPixabayKeyEncrypted()),
});

/** 统一 fetch（超时 + 非 2xx 转中文错误；JSON 与二进制共用） */
const fetchWithGuard = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {...init, signal: controller.signal});
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = body.slice(0, 200) || res.statusText;
      throw new Error(`素材服务返回错误（HTTP ${res.status}）：${msg}`);
    }
    return res;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('素材服务返回错误')) throw err;
    if (controller.signal.aborted) throw new Error('素材服务请求超时（30 秒），请检查网络后重试');
    throw new Error(`无法连接素材服务：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
};

const searchPexels = async (req: StockSearchRequest, key: string): Promise<StockMediaItem[]> => {
  const perPage = Math.min(20, Math.max(1, req.perPage ?? 8));
  const orient = orientationParam('pexels', req.orientation);
  const base = req.type === 'video' ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search';
  const qs = new URLSearchParams({query: req.query, per_page: String(perPage)});
  if (orient) qs.set('orientation', orient);
  const res = await fetchWithGuard(`${base}?${qs}`, {headers: {Authorization: key}});
  const data = await res.json();
  return req.type === 'video' ? pexelsVideosToItems(data) : pexelsPhotosToItems(data);
};

const searchPixabay = async (req: StockSearchRequest, key: string): Promise<StockMediaItem[]> => {
  const perPage = Math.min(20, Math.max(3, req.perPage ?? 8));
  const orient = orientationParam('pixabay', req.orientation);
  const base = req.type === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
  const qs = new URLSearchParams({key, q: req.query, per_page: String(perPage), safesearch: 'true'});
  if (orient) qs.set('orientation', orient);
  const res = await fetchWithGuard(`${base}?${qs}`);
  const data = await res.json();
  return req.type === 'video' ? pixabayVideosToItems(data) : pixabayPhotosToItems(data);
};

/** 聚合搜索：已配置的源都查，单源失败不拖垮整体（错误聚到 warnings） */
export const searchStockMedia = async (
  req: StockSearchRequest,
): Promise<{items: StockMediaItem[]; warnings: string[]}> => {
  const query = (req.query || '').trim();
  if (!query) throw new Error('搜索词为空');
  const warnings: string[] = [];
  const jobs: Array<Promise<StockMediaItem[]>> = [];
  const pexelsKey = providerKey('pexels');
  if (pexelsKey) {
    jobs.push(searchPexels(req, pexelsKey).catch((err) => {
      warnings.push(`Pexels：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }));
  }
  const pixabayKey = providerKey('pixabay');
  if (pixabayKey) {
    jobs.push(searchPixabay(req, pixabayKey).catch((err) => {
      warnings.push(`Pixabay：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }));
  }
  if (jobs.length === 0) {
    throw new Error('未配置任何素材源 API Key，请到「设置 → Stock 素材搜索」填写 Pexels 或 Pixabay 的免费 Key');
  }
  const all = (await Promise.all(jobs)).flat();
  // 去重（同 provider+id 理论不会重，防御多页）+ 方向过滤兜底（两家 orientation 偶有漏网）
  const seen = new Set<string>();
  const items = all.filter((it) => {
    const k = `${it.provider}:${it.type}:${it.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (items.length === 0 && warnings.length > 0) throw new Error(warnings.join('；'));
  return {items, warnings};
};

const stockCacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'stock-media');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
  return dir;
};

export interface StockDownloadResult {
  path: string;
  src: string;
  fileName: string;
  bytes: number;
}

/** 下载素材到本地缓存目录并注册白名单（provider+id 命名，重复下载直接复用） */
export const downloadStockMedia = async (req: StockDownloadRequest): Promise<StockDownloadResult> => {
  if (!isAllowedStockUrl(req.url)) {
    throw new Error('下载链接不在素材站域名白名单内（Pexels/Pixabay CDN），已拒绝');
  }
  const ext = req.type === 'photo'
    ? (req.url.match(/\.(jpe?g|png|webp)(?:\?|$)/i)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg')
    : (req.url.match(/\.(mp4|mov|webm)(?:\?|$)/i)?.[1] || 'mp4').toLowerCase();
  const file = path.join(stockCacheDir(), `${req.provider}-${req.type}-${req.id}.${ext}`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    registerMediaPath(file);
    return {path: file, src: filePathToHttpUrl(file), fileName: path.basename(file), bytes: fs.statSync(file).size};
  }
  const res = await fetchWithGuard(req.url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('素材下载结果为空，请重试');
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`素材过大（${(buf.length / 1024 / 1024).toFixed(0)}MB，上限 120MB），换一条`);
  fs.writeFileSync(file, buf);
  registerMediaPath(file);
  return {path: file, src: filePathToHttpUrl(file), fileName: path.basename(file), bytes: buf.length};
};

/** 缩略图代下载 → dataUrl（失败返回空串，调用方按无图处理） */
export const fetchStockThumbnail = async (url: string): Promise<string> => {
  if (!isAllowedStockUrl(url)) return '';
  try {
    const res = await fetchWithGuard(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 3 * 1024 * 1024) return '';
    const type = url.includes('.png') ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
};
