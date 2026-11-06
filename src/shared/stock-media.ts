/**
 * Stock 素材搜索（Pexels / Pixabay）——类型与响应归一化（纯函数，Node 可直跑单测）。
 *
 * 两家均为免费商用免署名素材库，API key 免费申请：
 * - Pexels:  https://www.pexels.com/api/ （Authorization 头）
 * - Pixabay: https://pixabay.com/api/docs/ （key 查询参数）
 *
 * 本模块只做数据形状转换：原始 JSON → StockMediaItem[]，网络与落盘在
 * main/services/stockMedia.ts。下载直链带域名白名单校验（见 isAllowedStockUrl），
 * 防止把渲染进程传来的任意 URL 当下载器用。
 */

export type StockProvider = 'pexels' | 'pixabay';
export type StockMediaType = 'video' | 'photo';
export type StockOrientation = 'landscape' | 'portrait' | 'square';

export interface StockMediaItem {
  provider: StockProvider;
  type: StockMediaType;
  /** 原站数字 id（provider+id+type 定位同一条素材） */
  id: string;
  title: string;
  author: string;
  /** 仅视频：时长秒 */
  durationSec?: number;
  width: number;
  height: number;
  /** 缩略图远程 URL（主进程代下载转 dataUrl 回传，渲染进程不直连外网） */
  previewUrl: string;
  /** 下载直链（主进程域名白名单校验后使用） */
  downloadUrl: string;
  /** 原站页面（来源/授权核对） */
  pageUrl: string;
  tags: string[];
}

export interface StockSearchRequest {
  query: string;
  type: StockMediaType;
  orientation?: StockOrientation;
  /** 每家最多取几条（总结果 ≤ 2×，缺省 8） */
  perPage?: number;
}

/** 下载请求：provider+type 定位服务端逻辑；url 必须过域名白名单 */
export interface StockDownloadRequest {
  provider: StockProvider;
  id: string;
  type: StockMediaType;
  /** 搜索结果里带回的下载直链（Pixabay 无按 id 查询端点，靠白名单直链下载） */
  url: string;
}

/** 方向参数映射：两家 API 的取值（square 仅 Pexels 支持） */
export const orientationParam = (provider: StockProvider, o?: StockOrientation): string | null => {
  if (!o) return null;
  if (provider === 'pexels') return o; // landscape | portrait | square
  return o === 'landscape' ? 'horizontal' : o === 'portrait' ? 'vertical' : null; // Pixabay 无 square
};

/** 下载直链域名白名单（HTTPS + 原站 CDN）；渲染进程传入的其他一律拒绝 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'videos.pexels.com',
  'images.pexels.com',
  'player.vimeo.com', // Pexels 部分 4K 变体走 vimeo 外链
  'cdn.pixabay.com',
  'i.pixabay.com',
]);

export const isAllowedStockUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

// ====== Pexels 归一化 ======

interface PexelsVideoFile {link: string; quality: string; width: number | null; height: number | null; file_type: string}

interface PexelsVideo {
  id: number; duration: number; width: number; height: number;
  url: string; image: string; user: {name: string};
  video_files: PexelsVideoFile[];
}

interface PexelsPhoto {
  id: number; width: number; height: number; url: string; photographer: string;
  src: {large2x: string; large: string}; alt: string | null;
}

/** Pexels 视频变体挑选：mp4、≤1080p 优先取最大，全超则取最小（避免 4K 大文件） */
export const pickPexelsVideoFile = (files: PexelsVideoFile[]): PexelsVideoFile | null => {
  const mp4 = files.filter((f) => f.file_type === 'video/mp4' && f.link && f.width);
  if (mp4.length === 0) return null;
  const within = mp4.filter((f) => (f.width ?? 0) <= 1920);
  if (within.length > 0) return within.reduce((a, b) => ((a.width ?? 0) >= (b.width ?? 0) ? a : b));
  return mp4.reduce((a, b) => ((a.width ?? 0) <= (b.width ?? 0) ? a : b));
};

export const pexelsVideosToItems = (data: unknown): StockMediaItem[] => {
  const videos = (data as {videos?: PexelsVideo[]})?.videos;
  if (!Array.isArray(videos)) return [];
  return videos.flatMap((v) => {
    const file = pickPexelsVideoFile(v.video_files ?? []);
    if (!file) return [];
    return [{
      provider: 'pexels' as const, type: 'video' as const, id: String(v.id),
      title: `${v.duration}s · ${v.width}x${v.height}`, author: v.user?.name ?? 'Pexels',
      durationSec: v.duration, width: file.width ?? v.width, height: file.height ?? v.height,
      previewUrl: v.image, downloadUrl: file.link, pageUrl: v.url, tags: [],
    }];
  });
};

export const pexelsPhotosToItems = (data: unknown): StockMediaItem[] => {
  const photos = (data as {photos?: PexelsPhoto[]})?.photos;
  if (!Array.isArray(photos)) return [];
  return photos.map((p) => ({
    provider: 'pexels' as const, type: 'photo' as const, id: String(p.id),
    title: p.alt || 'Pexels 图片', author: p.photographer,
    width: p.width, height: p.height,
    previewUrl: p.src?.large || p.src?.large2x,
    downloadUrl: p.src?.large2x || p.src?.large,
    pageUrl: p.url, tags: [],
  }));
};

// ====== Pixabay 归一化 ======

interface PixabayVideoVariant {url: string; width: number; height: number; thumbnail: string}

interface PixabayVideoHit {
  id: number; duration: number; tags: string; pageURL: string; user: string;
  videos: Record<string, PixabayVideoVariant>;
}

interface PixabayPhotoHit {
  id: number; webformatURL: string; previewURL: string; imageWidth: number; imageHeight: number;
  user: string; pageURL: string; tags: string;
}

/** Pixabay 视频变体：large > medium > small（都不超 1080p，取最大） */
const PIXABAY_ORDER = ['large', 'medium', 'small'] as const;

export const pixabayVideosToItems = (data: unknown): StockMediaItem[] => {
  const hits = (data as {hits?: PixabayVideoHit[]})?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.flatMap((h) => {
    const variant = PIXABAY_ORDER.map((k) => h.videos?.[k]).find((v) => v && v.url);
    if (!variant) return [];
    const tags = (h.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    return [{
      provider: 'pixabay' as const, type: 'video' as const, id: String(h.id),
      title: `${h.duration}s · ${variant.width}x${variant.height}`, author: h.user,
      durationSec: h.duration, width: variant.width, height: variant.height,
      previewUrl: variant.thumbnail || '', downloadUrl: variant.url, pageUrl: h.pageURL,
      tags: tags.slice(0, 6),
    }];
  });
};

export const pixabayPhotosToItems = (data: unknown): StockMediaItem[] => {
  const hits = (data as {hits?: PixabayPhotoHit[]})?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => {
    const tags = (h.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    return {
      provider: 'pixabay' as const, type: 'photo' as const, id: String(h.id),
      title: tags.slice(0, 3).join(' / ') || 'Pixabay 图片', author: h.user,
      width: h.imageWidth, height: h.imageHeight,
      previewUrl: h.previewURL, downloadUrl: h.webformatURL, pageUrl: h.pageURL,
      tags: tags.slice(0, 6),
    };
  });
};
