/**
 * 模板市场服务（主进程）
 *
 * 从许可证服务器（getServerBaseUrl 同一端点，生产强制内置地址）拉取模板目录、
 * 下载模板包（.vttemplate 单个 JSON 文件），校验 sha256 + 结构后写入
 * userData/market-templates/<id>.vttemplate。
 *
 * 安全模型：包是纯数据（无代码执行）；服务器经 HTTPS 下发目录，目录里的 sha256
 * 与下载文本摘要比对，损坏/篡改即拒装。结构校验与本地自定义模板同一套
 * （shared/template-pack 的 parsePack → validateTemplatePack）。
 */

import {app} from 'electron';
import fs from 'fs';
import path from 'path';
import {createHash} from 'crypto';
import {getServerBaseUrl} from './license';
import {parsePack, compareVersions, type TemplatePack, type MarketCatalogEntry, type MarketCatalogEntryWithStatus} from '../../shared/template-pack';

/** 目录缓存有效期（毫秒） */
const CATALOG_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export type {MarketCatalogEntry};

interface CatalogCache {
  fetchedAt: number;
  entries: MarketCatalogEntry[];
}

let catalogCache: CatalogCache | null = null;

const marketDir = (): string => path.join(app.getPath('userData'), 'market-templates');

const ensureMarketDir = (): void => {
  fs.mkdirSync(marketDir(), {recursive: true});
};

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 拉取模板目录。5 分钟内重复调用用内存缓存；网络失败时有过期缓存则回退缓存，
 * 否则抛错（调用方按「离线」处理）。
 */
export const fetchCatalog = async (forceRefresh = false): Promise<MarketCatalogEntry[]> => {
  if (!forceRefresh && catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.entries;
  }
  try {
    const res = await fetchWithTimeout(`${getServerBaseUrl()}/api/market/templates`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {templates?: MarketCatalogEntry[]};
    const entries = Array.isArray(data.templates) ? data.templates : [];
    catalogCache = {fetchedAt: Date.now(), entries};
    return entries;
  } catch (err) {
    if (catalogCache) return catalogCache.entries;
    throw err;
  }
};

/** 列出已安装模板（扫描目录 + 校验；坏文件跳过并告警） */
export const listInstalled = (): TemplatePack[] => {
  ensureMarketDir();
  const packs: TemplatePack[] = [];
  for (const file of fs.readdirSync(marketDir())) {
    if (!file.endsWith('.vttemplate')) continue;
    try {
      const text = fs.readFileSync(path.join(marketDir(), file), 'utf8');
      const {pack, errors} = parsePack(text);
      if (pack) {
        packs.push(pack);
      } else {
        console.warn(`[template-market] 跳过非法模板包 ${file}：${errors.slice(0, 2).join('；')}`);
      }
    } catch (err) {
      console.warn(`[template-market] 读取 ${file} 失败：${String(err)}`);
    }
  }
  return packs;
};

/** 已安装版本映射（id → version），供目录页标注「已安装/有更新」 */
export const installedVersions = (): Record<string, string> =>
  Object.fromEntries(listInstalled().map((p) => [p.id, p.version]));

export interface InstallResult {
  ok: boolean;
  error?: string;
  pack?: TemplatePack;
}

/** 安装（或更新）模板：下载 → sha256 比对 → 结构校验 → 原子写入 */
export const installTemplate = async (id: string): Promise<InstallResult> => {
  let catalog: MarketCatalogEntry[];
  try {
    catalog = await fetchCatalog();
  } catch {
    return {ok: false, error: '无法连接模板服务器，请检查网络后重试'};
  }
  const entry = catalog.find((t) => t.id === id);
  if (!entry) return {ok: false, error: '市场中没有该模板（可能已下架）'};

  let text: string;
  try {
    const res = await fetchWithTimeout(`${getServerBaseUrl()}/api/market/templates/${encodeURIComponent(id)}/download`);
    if (!res.ok) return {ok: false, error: `下载失败（HTTP ${res.status}）`};
    text = await res.text();
  } catch {
    return {ok: false, error: '下载失败，请检查网络后重试'};
  }

  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  if (entry.sha256 && digest !== entry.sha256) {
    return {ok: false, error: '模板包校验和不匹配（传输损坏或被篡改），已拒绝安装'};
  }

  const {pack, errors} = parsePack(text);
  if (!pack) return {ok: false, error: `模板包校验失败：${errors.slice(0, 3).join('；')}`};
  if (pack.id !== id) return {ok: false, error: '模板包 id 与请求不一致，已拒绝安装'};

  if (pack.minAppVersion && compareVersions(pack.minAppVersion, app.getVersion()) > 0) {
    return {ok: false, error: `该模板需要片语 v${pack.minAppVersion} 及以上，请先到「关于」检查更新`};
  }

  try {
    ensureMarketDir();
    const target = path.join(marketDir(), `${id}.vttemplate`);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
    return {ok: true, pack};
  } catch (err) {
    return {ok: false, error: `写入模板文件失败：${String(err)}`};
  }
};

/** 卸载模板；返回是否实际删除了文件 */
export const uninstallTemplate = (id: string): boolean => {
  const target = path.join(marketDir(), `${id}.vttemplate`);
  try {
    fs.rmSync(target, {force: true});
    return true;
  } catch {
    return false;
  }
};

/** 从本地文件安装（网页下载的 .vttemplate 手动安装场景） */
export const importPackFile = (filePath: string): InstallResult => {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const {pack, errors} = parsePack(text);
    if (!pack) return {ok: false, error: `模板包校验失败：${errors.slice(0, 3).join('；')}`};
    if (pack.minAppVersion && compareVersions(pack.minAppVersion, app.getVersion()) > 0) {
      return {ok: false, error: `该模板需要片语 v${pack.minAppVersion} 及以上`};
    }
    ensureMarketDir();
    const target = path.join(marketDir(), `${pack.id}.vttemplate`);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
    return {ok: true, pack};
  } catch (err) {
    return {ok: false, error: `读取模板包失败：${String(err)}`};
  }
};

/** 目录条目 + 本地安装状态合并（市场 UI 用） */
export const catalogWithStatus = async (forceRefresh = false): Promise<{
  entries: MarketCatalogEntryWithStatus[];
  offline: boolean;
}> => {
  const installed = installedVersions();
  try {
    const entries = await fetchCatalog(forceRefresh);
    return {
      entries: entries.map((e) => ({
        ...e,
        installedVersion: installed[e.id],
        hasUpdate: installed[e.id] ? compareVersions(e.version, installed[e.id]) > 0 : false,
      })),
      offline: false,
    };
  } catch {
    return {entries: [], offline: true};
  }
};
