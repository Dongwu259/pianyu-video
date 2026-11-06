/**
 * AI 对话存档 IPC（导出 / 导入）
 * 导出：Markdown 人读版或 JSON 往返版（JSON 可再导入恢复完整对话）；
 * 导入：读 JSON 文本返回渲染端（结构校验在渲染端 shared/chat-history 做）。
 */

import {dialog, ipcMain} from 'electron';
import fs from 'fs';
import type {IpcCtx} from './ctx';

export const registerAiChatIpc = (ctx: IpcCtx) => {
  ipcMain.handle(
    'ai-chat:export',
    async (_, args: {content: string; defaultName: string; format: 'md' | 'json'}) => {
      const result = await dialog.showSaveDialog(ctx.getMainWindow()!, {
        title: '导出 AI 对话记录',
        defaultPath: args.defaultName,
        filters: [
          args.format === 'md'
            ? {name: 'Markdown 文档', extensions: ['md']}
            : {name: 'JSON 存档', extensions: ['json']},
        ],
      });
      if (result.canceled || !result.filePath) return {success: false};
      try {
        fs.writeFileSync(result.filePath, args.content, 'utf8');
        return {success: true, path: result.filePath};
      } catch (err) {
        return {success: false, error: String(err)};
      }
    },
  );

  ipcMain.handle('ai-chat:import', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '导入 AI 对话存档',
      properties: ['openFile'],
      filters: [{name: 'JSON 存档', extensions: ['json']}],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      const content = fs.readFileSync(result.filePaths[0], 'utf8');
      return {success: true, content};
    } catch (err) {
      return {success: false, error: String(err)};
    }
  });
};
