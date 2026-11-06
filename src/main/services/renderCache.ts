/**
 * 段级渲染缓存存储（磁盘）
 *
 * 目录 <userData>/render-cache-v1/，文件名 = 块内容哈希（键的计算见 shared/render-blocks.ts）。
 * 写入先落系统临时目录，成功后搬入缓存（rename，跨盘退化为 copy）。
 * 总量超上限按 mtime 清最旧（LRU 近似）；条目无引用计数——键即内容身份，改稿后旧块自然滞留至被清理。
 */

import {app} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CACHE_DIR_NAME = 'render-cache-v1';

/** 缓存总量上限（4GB；渲一个 10 段 1080p 成片的块约占 0.5-2GB，足够容纳数个工程的热块） */
export const RENDER_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export const renderCacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), CACHE_DIR_NAME);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
};

export const blockCacheFile = (key: string, ext: string): string =>
  path.join(renderCacheDir(), `${key}.${ext}`);

/** 命中则返回块文件路径，否则 null（存在但 0 字节视为未命中） */
export const readCachedBlock = (key: string, ext: string): string | null => {
  try {
    const file = blockCacheFile(key, ext);
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0 ? file : null;
  } catch {
    return null;
  }
};

/** 块临时输出路径（渲染直接写入；扩展名真实，供 renderMedia 推断容器） */
export const blockTmpPath = (key: string, ext: string): string => {
  const dir = path.join(os.tmpdir(), 'promo-render');
  fs.mkdirSync(dir, {recursive: true});
  return path.join(dir, `block_${key}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
};

/** 渲染成功的块搬入缓存，返回缓存内路径；失败时删除临时文件并抛错 */
export const writeBlockToCache = async (tmpPath: string, key: string, ext: string): Promise<string> => {
  const dest = blockCacheFile(key, ext);
  try {
    try {
      await fs.promises.rename(tmpPath, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EXDEV') throw err;
      // 临时目录与 userData 跨盘：退化为复制
      await fs.promises.copyFile(tmpPath, dest);
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
    return dest;
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    try {
      fs.unlinkSync(dest);
    } catch {}
    throw err;
  }
};

/** 清理缓存至上限内（按 mtime 从旧到新删）。渲染完成后调用，失败静默（不影响渲染） */
export const evictRenderCache = (maxBytes: number = RENDER_CACHE_MAX_BYTES): void => {
  try {
    const dir = renderCacheDir();
    const entries = fs
      .readdirSync(dir)
      .map((name) => {
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          return st.isFile() ? {file, size: st.size, mtimeMs: st.mtimeMs} : null;
        } catch {
          return null;
        }
      })
      .filter((e): e is {file: string; size: number; mtimeMs: number} => e !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((s, e) => s + e.size, 0);
    for (const e of entries) {
      if (total <= maxBytes) break;
      try {
        fs.unlinkSync(e.file);
        total -= e.size;
      } catch {
        // 单文件删除失败（占用等）跳过继续
      }
    }
  } catch {
    // 缓存清理失败不影响渲染
  }
};
