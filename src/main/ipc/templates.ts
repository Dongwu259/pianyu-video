/**
 * 自定义模板 IPC（列表 / 保存 / 删除 / 导入 / 导出 / 导出模板包）
 * 结构校验统一用 shared/custom-template 的 validateCustomTemplateDef。
 */

import {dialog, ipcMain} from 'electron';
import fs from 'fs';
import {getCustomTemplates, setCustomTemplates} from '../services/store';
import {validateCustomTemplateDef} from '../../shared/custom-template';
import {serializePack, validateTemplatePack, type TemplatePack} from '../../shared/template-pack';
import type {IpcCtx} from './ctx';

/** 模板名称 → 市场包 slug（mkt-xxx）；非 ASCII 字符丢弃，空则回退时间戳 */
const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || `tpl-${Date.now().toString(36)}`;
};

export const registerCustomTemplatesIpc = (ctx: IpcCtx) => {
  // 列出所有自定义模板（存量数据做结构校验：坏数据不进渲染进程，避免画布/渲染炸掉）
  ipcMain.handle('custom-templates:list', async () => {
    const list = getCustomTemplates();
    const valid = list.filter((def) => validateCustomTemplateDef(def).length === 0);
    if (valid.length !== list.length) {
      console.warn(`[custom-templates] 丢弃 ${list.length - valid.length} 个结构非法的存量模板并回写清理`);
      setCustomTemplates(valid);
    }
    return valid;
  });

  // 保存（新增或更新）一个自定义模板
  ipcMain.handle('custom-templates:save', async (_, def) => {
    // 与 import/list 同一道结构校验：渲染进程可任意调用本通道，
    // 不校验则坏数据进 store，画布/渲染时才炸（list 会静默丢弃造成行为不一致）
    const errors = validateCustomTemplateDef(def);
    if (errors.length > 0) {
      throw new Error(`模板数据校验失败：${errors.slice(0, 3).join('；')}${errors.length > 3 ? ` 等 ${errors.length} 项` : ''}`);
    }
    const list = getCustomTemplates();
    const idx = list.findIndex((t) => t.id === def.id);
    if (idx >= 0) {
      list[idx] = def;
    } else {
      list.push(def);
    }
    setCustomTemplates(list);
    return list;
  });

  // 删除一个自定义模板
  ipcMain.handle('custom-templates:delete', async (_, id) => {
    const list = getCustomTemplates().filter((t) => t.id !== id);
    setCustomTemplates(list);
    return list;
  });

  // 导出为 JSON 文件
  ipcMain.handle('custom-templates:export', async (_, def) => {
    const result = await dialog.showSaveDialog(ctx.getMainWindow()!, {
      title: '导出自定义模板',
      defaultPath: `${def.name || 'custom-template'}.json`,
      filters: [{name: '模板文件', extensions: ['json']}],
    });
    if (result.canceled || !result.filePath) return {success: false};
    try {
      fs.writeFileSync(result.filePath, JSON.stringify(def, null, 2), 'utf8');
      return {success: true, path: result.filePath};
    } catch (err) {
      return {success: false, error: String(err)};
    }
  });

  // 导入 JSON 文件
  ipcMain.handle('custom-templates:import', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '导入自定义模板',
      properties: ['openFile'],
      filters: [{name: '模板文件', extensions: ['json']}],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf8');
      const def = JSON.parse(raw);
      // 结构校验：坏数据直接报错，不进 store（否则列表页/画布渲染时才炸）
      const errors = validateCustomTemplateDef(def);
      if (errors.length > 0) {
        const preview = errors.slice(0, 5).join('；');
        return {success: false, error: `模板文件校验失败：${preview}${errors.length > 5 ? ` 等 ${errors.length} 项` : ''}`};
      }
      // 导入时重生成 id 避免冲突
      def.id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return {success: true, def};
    } catch (err) {
      return {success: false, error: String(err)};
    }
  });

  // 导出为市场模板包（.vttemplate）：def 换 mkt- id，附 manifest，全量校验后落盘
  ipcMain.handle(
    'custom-templates:export-pack',
    async (_, payload: {def: unknown; meta?: {description?: string; author?: string; tags?: string[]; version?: string; thumbnail?: string}}) => {
      const {def, meta = {}} = payload || ({} as {def: unknown});
      const d = def as {id?: string; name?: string};
      if (!d || typeof d.name !== 'string' || !d.name) return {success: false, error: '缺少模板名称'};
      const packId = `mkt-${slugify(d.name)}`;
      const pack: TemplatePack = {
        formatVersion: 1,
        id: packId,
        name: d.name,
        version: meta.version || '1.0.0',
        ...(meta.description ? {description: meta.description} : {}),
        ...(meta.author ? {author: meta.author} : {}),
        ...(meta.tags && meta.tags.length > 0 ? {tags: meta.tags} : {}),
        ...(meta.thumbnail ? {thumbnail: meta.thumbnail} : {}),
        def: {...(def as object), id: packId} as TemplatePack['def'],
      };
      const errors = validateTemplatePack(pack);
      if (errors.length > 0) {
        const preview = errors.slice(0, 5).join('；');
        return {success: false, error: `模板包校验失败：${preview}${errors.length > 5 ? ` 等 ${errors.length} 项` : ''}`};
      }
      const result = await dialog.showSaveDialog(ctx.getMainWindow()!, {
        title: '导出模板包',
        defaultPath: `${packId}.vttemplate`,
        filters: [{name: '模板包', extensions: ['vttemplate']}],
      });
      if (result.canceled || !result.filePath) return {success: false};
      try {
        fs.writeFileSync(result.filePath, serializePack(pack), 'utf8');
        return {success: true, path: result.filePath, packId};
      } catch (err) {
        return {success: false, error: String(err)};
      }
    },
  );
};
