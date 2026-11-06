/**
 * AI 生成模板 IPC（列表 / 保存[扫描+编译+落库] / 删除）
 * 扫描与编译全部在主进程权威执行（services/templateGen），渲染进程不接触 esbuild。
 */

import {ipcMain} from 'electron';
import {
  compileGeneratedSource,
  deleteGeneratedTemplate,
  listValidGeneratedTemplates,
  saveGeneratedTemplate,
  type SaveGeneratedPayload,
} from '../services/templateGen';
import type {IpcCtx} from './ctx';

export const registerTemplateGenIpc = (_ctx: IpcCtx) => {
  // 列出全部 AI 生成模板（存量坏数据在此清理）
  ipcMain.handle('template-gen:list', async () => listValidGeneratedTemplates());

  // 保存（新增或覆盖迭代）：源码扫描 → esbuild 编译 → 结构校验 → 落盘；
  // 失败不落盘，errors 面向 LLM 可直接回喂改稿
  ipcMain.handle('template-gen:save', async (_, payload: SaveGeneratedPayload) => {
    if (typeof payload !== 'object' || payload === null || typeof payload.source !== 'string') {
      return {ok: false, errors: ['参数必须是含 source 的对象']};
    }
    return saveGeneratedTemplate(payload);
  });

  // 仅编译（渲染端冒烟实例化用；不落盘）
  ipcMain.handle('template-gen:compile', async (_, source: string) => {
    if (typeof source !== 'string' || !source.trim()) return {ok: false, errors: ['源码为空']};
    return compileGeneratedSource(source);
  });

  // 删除
  ipcMain.handle('template-gen:delete', async (_, id: string) => {
    if (typeof id !== 'string' || !id) return listValidGeneratedTemplates();
    return deleteGeneratedTemplate(id);
  });
};
