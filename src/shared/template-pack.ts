/**
 * 模板包（.vttemplate）- 云端市场分发的 JSON 模板文件格式
 *
 * 一个模板包 = 单个 JSON 文件：manifest（id/版本/作者/参数说明）+ 内联
 * CustomTemplateDef + 缩略图（data-URI）。纯数据、无代码执行，客户端安装时
 * 用 validateTemplatePack 全量校验。
 *
 * 市场模板 id 约定 'mkt-' 前缀；def.id 与包 id 一致，def.isCustom 保持 true，
 * 渲染链路与本地自定义模板完全共用（CustomTemplateRender / CustomTemplateCanvas）。
 */

import type {CustomTemplateDef} from './custom-template.ts';
import {validateCustomTemplateDef} from './custom-template.ts';

export const PACK_FORMAT_VERSION = 1;
/** 包文件体积上限（JSON 文本字节数） */
export const PACK_MAX_BYTES = 2 * 1024 * 1024;
/** 单个模板最多元素/参数（与 validateCustomTemplateDef 一致的防御上限） */
export const PACK_ID_PREFIX = 'mkt-';

export const isMarketTemplateId = (id: string): boolean => id.startsWith(PACK_ID_PREFIX);

export interface TemplatePack {
  formatVersion: number;
  /** 'mkt-<slug>'，全市场唯一 */
  id: string;
  name: string;
  description?: string;
  /** 语义化版本 'x.y.z'（允许 'x.y'） */
  version: string;
  author?: string;
  tags?: string[];
  /** 能使用该模板的最低客户端版本（如 '0.8.0'）；缺省不限制 */
  minAppVersion?: string;
  /** 缩略图 data-URI（image/svg+xml 或 image/png） */
  thumbnail?: string;
  /** 模板定义；def.id 必须等于包 id */
  def: CustomTemplateDef;
}

const SEMVER_RE = /^\d+\.\d+(\.\d+)?$/;

/**
 * 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 按点分数字逐段比较，缺段按 0 计（'1.2' < '1.2.1'）。
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
};

/**
 * 模板包结构校验。返回错误信息数组，空数组 = 合法。
 * def 部分复用 validateCustomTemplateDef（与自定义模板同一标准）。
 */
export const validateTemplatePack = (pack: unknown): string[] => {
  const errors: string[] = [];
  if (typeof pack !== 'object' || pack === null) return ['模板包必须是 JSON 对象'];
  const p = pack as Record<string, unknown>;

  if (p.formatVersion !== PACK_FORMAT_VERSION) {
    errors.push(`formatVersion 必须是 ${PACK_FORMAT_VERSION}（当前 ${String(p.formatVersion)}）`);
  }
  if (typeof p.id !== 'string' || !isMarketTemplateId(p.id)) {
    errors.push(`id 必须是 "${PACK_ID_PREFIX}" 前缀的字符串`);
  } else if (!/^mkt-[a-z0-9][a-z0-9-]{1,60}$/.test(p.id)) {
    errors.push('id 只能包含小写字母/数字/连字符（mkt-xxx 形式）');
  }
  if (typeof p.name !== 'string' || !p.name) errors.push('缺少模板名称 name');
  if (typeof p.version !== 'string' || !SEMVER_RE.test(p.version)) {
    errors.push('version 必须是语义化版本（如 1.0.0）');
  }
  if (p.description !== undefined && typeof p.description !== 'string') errors.push('description 必须是字符串');
  if (p.author !== undefined && typeof p.author !== 'string') errors.push('author 必须是字符串');
  if (p.minAppVersion !== undefined && (typeof p.minAppVersion !== 'string' || !SEMVER_RE.test(p.minAppVersion))) {
    errors.push('minAppVersion 必须是语义化版本');
  }
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string'))) {
    errors.push('tags 必须是字符串数组');
  }
  if (p.thumbnail !== undefined) {
    if (typeof p.thumbnail !== 'string' || !/^data:image\/(svg\+xml|png|jpeg);/.test(p.thumbnail)) {
      errors.push('thumbnail 必须是 image/svg+xml|png|jpeg 的 data-URI');
    } else if (p.thumbnail.length > 512 * 1024) {
      errors.push('thumbnail 超过 512KB');
    }
  }
  if (p.def === undefined) {
    errors.push('缺少模板定义 def');
  } else {
    const defErrors = validateCustomTemplateDef(p.def);
    errors.push(...defErrors.map((e) => `def: ${e}`));
    const defId = (p.def as {id?: unknown})?.id;
    if (typeof p.id === 'string' && typeof defId === 'string' && defId !== p.id) {
      errors.push('def.id 必须与包 id 一致');
    }
  }
  return errors;
};

/** 序列化为规范的 JSON 文本（服务端 sha256 的对象） */
export const serializePack = (pack: TemplatePack): string => JSON.stringify(pack, null, 2);

/**
 * 市场目录条目（服务端 GET /api/market/templates 的单项）。
 * 客户端安装时用 sha256 校验下载文本。
 */
export interface MarketCatalogEntry {
  id: string;
  name: string;
  description?: string;
  version: string;
  author?: string;
  tags?: string[];
  sha256: string;
  size: number;
  downloads: number;
  updatedAt: string;
  thumbnail?: string;
}

/** 目录条目 + 本地安装状态（市场 UI 用） */
export interface MarketCatalogEntryWithStatus extends MarketCatalogEntry {
  installedVersion?: string;
  hasUpdate: boolean;
}

/** 解析并校验模板包文本；合法返回 pack，否则返回错误列表 */
export const parsePack = (text: string): {pack?: TemplatePack; errors: string[]} => {
  if (new TextEncoder().encode(text).length > PACK_MAX_BYTES) {
    return {errors: [`模板包超过 ${PACK_MAX_BYTES / 1024 / 1024}MB 大小上限`]};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {errors: [`JSON 解析失败：${String(err)}`]};
  }
  const errors = validateTemplatePack(raw);
  return errors.length > 0 ? {errors} : {pack: raw as TemplatePack, errors: []};
};
