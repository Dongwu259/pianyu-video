/**
 * 模板市场 IPC（目录 / 已装列表 / 安装 / 卸载 / 从文件导入）
 */

import {dialog, ipcMain} from 'electron';
import {
  catalogWithStatus,
  installTemplate,
  listInstalled,
  uninstallTemplate,
  importPackFile,
} from '../services/templateMarket';
import type {IpcCtx} from './ctx';

export const registerMarketIpc = (ctx: IpcCtx) => {
  // 模板目录（含本地安装状态）；forceRefresh 绕过 5 分钟缓存
  ipcMain.handle('market:catalog', async (_, forceRefresh?: boolean) => catalogWithStatus(Boolean(forceRefresh)));

  // 已安装模板包列表
  ipcMain.handle('market:installed', async () => listInstalled());

  // 安装/更新
  ipcMain.handle('market:install', async (_, id: string) => installTemplate(id));

  // 卸载（返回最新的已装列表，方便渲染进程一次刷新）
  ipcMain.handle('market:uninstall', async (_, id: string) => {
    uninstallTemplate(id);
    return listInstalled();
  });

  // 从本地 .vttemplate 文件安装（网页手动下载场景）
  ipcMain.handle('market:import-file', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '安装模板包',
      properties: ['openFile'],
      filters: [{name: '模板包', extensions: ['vttemplate']}],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const r = importPackFile(result.filePaths[0]);
    if (!r.ok) return {success: false, error: r.error};
    return {success: true, pack: r.pack};
  });
};
