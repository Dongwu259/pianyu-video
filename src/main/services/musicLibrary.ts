/**
 * 本地曲库服务 - 扫描用户指定目录中的音频文件 + 音频分析磁盘缓存
 *
 * 与 projectFile.ts 同模式：本模块只做纯逻辑（fs 扫描 / 缓存读写），不 import electron，
 * 因此可在纯 Node 环境直接做单元测试；目录对话框、userData 路径等在 ipc/media.ts 完成。
 *
 * 不内置任何音乐（版权决策）：曲库内容完全来自用户指定的本地文件夹。
 */

import fs from 'fs';
import path from 'path';
import type {AudioAnalysis} from './audio';

/** 曲库收录的音频扩展名（小写；匹配时大小写不敏感） */
const MUSIC_EXTENSIONS: ReadonlySet<string> = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);

export interface MusicTrack {
  name: string;   // 文件名（含扩展名）
  path: string;   // 完整路径
}

/** 判断文件名是否是曲库收录的音频（按扩展名，大小写不敏感） */
export const isMusicFileName = (name: string): boolean =>
  MUSIC_EXTENSIONS.has(path.extname(name).toLowerCase());

/** 过滤 + 排序（纯函数）：从文件名清单挑出音频文件并按文件名排序 */
export const filterMusicNames = (names: string[]): string[] =>
  names.filter(isMusicFileName).sort((a, b) => a.localeCompare(b));

/**
 * 扫描曲库目录（仅一级文件，不递归）。
 * 目录未设置（空串）/ 不存在 / 不可读一律返回空数组，不报错。
 */
export const scanMusicDir = (dir: string): MusicTrack[] => {
  if (!dir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }
  return filterMusicNames(entries.filter((e) => e.isFile()).map((e) => e.name))
    .map((name) => ({name, path: path.join(dir, name)}));
};

// ====== 音频分析磁盘缓存 ======

/** 单条缓存：分析结果 + 命中校验用的文件 mtime + 淘汰用的写入时间 */
export interface MusicAnalysisCacheEntry extends AudioAnalysis {
  mtimeMs: number;   // 分析时源文件的 mtimeMs（与当前文件不一致 = 缓存失效）
  cachedAt: number;  // 写入缓存的时间（超上限时清最旧）
}

/** 缓存表：key = 文件完整路径 */
export type MusicAnalysisCache = Record<string, MusicAnalysisCacheEntry>;

/** 缓存条数上限（超出时清最旧） */
export const MUSIC_ANALYSIS_CACHE_LIMIT = 200;

/** 读缓存文件；不存在 / 损坏一律返回空表 */
export const readMusicAnalysisCache = (cacheFile: string): MusicAnalysisCache => {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    return raw as MusicAnalysisCache;
  } catch {
    return {};
  }
};

/** 写缓存文件（父目录不存在则创建；写失败静默——缓存丢了只是下次重算，不影响主流程） */
export const writeMusicAnalysisCache = (cacheFile: string, cache: MusicAnalysisCache): void => {
  try {
    fs.mkdirSync(path.dirname(cacheFile), {recursive: true});
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {
    // 缓存写失败静默
  }
};

/** 查缓存：path 有记录且 mtimeMs 与当前文件一致才命中。
 *  旧缓存条目（无 beats 字段，节拍检测升级前写入）按 miss 处理，触发重算补齐节拍。 */
export const lookupMusicAnalysis = (
  cache: MusicAnalysisCache,
  filePath: string,
  mtimeMs: number,
): AudioAnalysis | null => {
  const hit = cache[filePath];
  if (!hit || hit.mtimeMs !== mtimeMs) return null;
  if (!Array.isArray(hit.beats)) return null;
  return {duration: hit.duration, peaks: hit.peaks, beats: hit.beats, bpm: hit.bpm ?? 0};
};

/** 写入一条分析结果（返回新表）；超过上限时按 cachedAt 清最旧 */
export const upsertMusicAnalysis = (
  cache: MusicAnalysisCache,
  filePath: string,
  mtimeMs: number,
  analysis: AudioAnalysis,
  cachedAt: number = Date.now(),
): MusicAnalysisCache => {
  const next: MusicAnalysisCache = {...cache, [filePath]: {...analysis, mtimeMs, cachedAt}};
  const keys = Object.keys(next);
  if (keys.length > MUSIC_ANALYSIS_CACHE_LIMIT) {
    const byAge = keys.sort((a, b) => next[a].cachedAt - next[b].cachedAt);
    for (const k of byAge.slice(0, keys.length - MUSIC_ANALYSIS_CACHE_LIMIT)) {
      delete next[k];
    }
  }
  return next;
};
