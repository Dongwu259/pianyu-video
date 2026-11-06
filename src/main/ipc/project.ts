/**
 * 工程文件（.vtproj）与自动保存 IPC
 */

import {app, dialog, ipcMain} from 'electron';
import path from 'path';
import fs from 'fs';
import {
  buildProjectFile, saveProjectFile, readProjectFile,
  collectMediaPaths, checkMediaMissing,
} from '../services/projectFile';
import type {ProjectFileData, OpenProjectResult} from '../services/projectFile';
import {createRollingBackup} from '../services/projectBackup';
import {
  getSampleSourceCandidates, findSampleSourceDir, ensureSampleCopy, loadSampleProjectCopy,
} from '../services/sampleProject';
import {registerMediaPath} from '../services/videoServer';
import type {IpcCtx} from './ctx';

// 渲染进程可传任意路径让主进程写 JSON，必须约束：
// 只允许写入「经保存/打开对话框选择过的 .vtproj 路径」（集合随会话维护）
const allowedProjectPaths = new Set<string>();

/** 自动保存文件路径（userData 目录下，异常退出后下次启动可提示恢复） */
const getAutosavePath = () => path.join(app.getPath('userData'), 'autosave.vtproj');

/**
 * 写自动保存的统一落盘逻辑（invoke 与 send 两通道共用，保证校验一致）。
 * saveProjectFile 本身是 writeFileSync + renameSync 的原子同步写，
 * 因此 send 通道（退出前 beforeunload 兜底）也能可靠落盘。
 */
const writeAutosave = (name: string, data: ProjectFileData): {success: boolean; error?: string} => {
  try {
    // 最小结构校验（与读取端 validatePayload 同口径）：send 通道无返回值，坏数据在此挡掉
    if (typeof name !== 'string' || !data || typeof data !== 'object' || !Array.isArray(data.segments)) {
      return {success: false, error: '自动保存数据不完整'};
    }
    saveProjectFile(getAutosavePath(), buildProjectFile(name, data));
    return {success: true};
  } catch (err) {
    return {success: false, error: err instanceof Error ? err.message : String(err)};
  }
};

/**
 * 显式保存覆盖已存在文件前的滚动备份（真实踩坑：手滑保存坏状态覆盖好工程）。
 * 旧文件复制到 userData/project-backups/，按目标文件名前缀保留最近 5 份；
 * 备份失败只告警不阻断保存（console.warn + 返回值带 backupWarning）。
 */
const backupBeforeOverwrite = (filePath: string): string | undefined => {
  const r = createRollingBackup(filePath, path.join(app.getPath('userData'), 'project-backups'));
  if (r.warning) {
    console.warn(`[Project] 保存前备份失败（不阻断保存）: ${r.warning}`);
    return `旧版本备份失败：${r.warning}`;
  }
  return undefined;
};

export const registerProjectIpc = (ctx: IpcCtx) => {
  /** 读取工程文件并做媒体存在性检查（打开 / 最近工程共用） */
  const openProjectFile = (filePath: string): OpenProjectResult => {
    if (!fs.existsSync(filePath)) {
      return {success: false, path: filePath, error: '工程文件不存在，可能已被移动或删除'};
    }
    try {
      const payload = readProjectFile(filePath);
      const missingMedia = checkMediaMissing(collectMediaPaths(payload.data));
      allowedProjectPaths.add(path.resolve(filePath));
      return {success: true, path: filePath, name: payload.name, data: payload.data, missingMedia};
    } catch (err) {
      return {success: false, path: filePath, error: err instanceof Error ? err.message : String(err)};
    }
  };

  // 另存为：弹保存对话框后写入
  ipcMain.handle('project:saveAs', async (_, name: string, data: ProjectFileData) => {
    const result = await dialog.showSaveDialog(ctx.getMainWindow()!, {
      title: '保存工程',
      defaultPath: `${name || '未命名工程'}.vtproj`,
      filters: [{name: '工程文件', extensions: ['vtproj']}],
    });
    if (result.canceled || !result.filePath) return {success: false, canceled: true};
    try {
      const backupWarning = backupBeforeOverwrite(result.filePath);
      saveProjectFile(result.filePath, buildProjectFile(name, data));
      allowedProjectPaths.add(path.resolve(result.filePath));
      return {success: true, path: result.filePath, ...(backupWarning ? {backupWarning} : {})};
    } catch (err) {
      return {success: false, error: err instanceof Error ? err.message : String(err)};
    }
  });

  // 保存到已有路径（无对话框）
  ipcMain.handle('project:save', async (_, filePath: string, name: string, data: ProjectFileData) => {
    // 路径约束：必须是此前经对话框保存/打开过的 .vtproj 文件
    if (typeof filePath !== 'string' || !/\.vtproj$/i.test(filePath) || !allowedProjectPaths.has(path.resolve(filePath))) {
      return {success: false, error: '保存路径未授权：请先通过「另存为」选择保存位置'};
    }
    try {
      const backupWarning = backupBeforeOverwrite(filePath);
      saveProjectFile(filePath, buildProjectFile(name, data));
      return {success: true, path: filePath, ...(backupWarning ? {backupWarning} : {})};
    } catch (err) {
      return {success: false, error: err instanceof Error ? err.message : String(err)};
    }
  });

  // 保存到任意指定路径（MCP save_project 用，无对话框）。
  // 与 project:save 的白名单不同：MCP 调用方持 bearer token，与本地用户同信任级；
  // 仍收敛风险面：只允许 .vtproj 后缀、父目录必须已存在（不代建目录），内容恒为工程 JSON。
  // 成功后加入白名单，后续 Ctrl+S 可直接原地保存。
  ipcMain.handle('project:saveToPath', async (_, filePath: string, name: string, data: ProjectFileData) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.vtproj$/i.test(filePath)) {
      return {success: false, error: '保存路径必须是 .vtproj 结尾的绝对路径'};
    }
    const parent = path.dirname(filePath);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      return {success: false, error: `父目录不存在：${parent}（不会自动创建目录）`};
    }
    try {
      const backupWarning = backupBeforeOverwrite(filePath);
      saveProjectFile(filePath, buildProjectFile(name, data));
      allowedProjectPaths.add(path.resolve(filePath));
      return {success: true, path: filePath, ...(backupWarning ? {backupWarning} : {})};
    } catch (err) {
      return {success: false, error: err instanceof Error ? err.message : String(err)};
    }
  });

  // 打开：弹对话框选择工程文件
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '打开工程',
      properties: ['openFile'],
      filters: [{name: '工程文件', extensions: ['vtproj']}],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return openProjectFile(result.filePaths[0]);
  });

  // 按路径打开（最近工程列表用，无对话框）
  ipcMain.handle('project:openPath', async (_, filePath: string) => openProjectFile(filePath));

  // 打开内置示例工程：把 resources/sample-project 复制到 userData/sample-project
  // （已存在则跳过复制），相对媒体路径重写为副本目录下的绝对路径后按常规流程加载。
  // 返回结构与 project:open 一致，渲染进程走同一条加载管线。
  ipcMain.handle('sample:open', async (): Promise<OpenProjectResult> => {
    try {
      const srcDir = findSampleSourceDir(getSampleSourceCandidates(__dirname));
      if (!srcDir) {
        return {success: false, error: '未找到内置示例工程资源，请重新安装应用'};
      }
      const destDir = path.join(app.getPath('userData'), 'sample-project');
      ensureSampleCopy(srcDir, destDir);
      const {payload, projectPath, mediaPaths} = loadSampleProjectCopy(destDir);
      // 预览/渲染白名单：副本内的媒体路径逐一注册
      for (const p of mediaPaths) registerMediaPath(p);
      // 工程保存白名单：示例副本允许 Ctrl+S 直接保存
      allowedProjectPaths.add(path.resolve(projectPath));
      const missingMedia = checkMediaMissing(mediaPaths);
      return {success: true, path: projectPath, name: payload.name, data: payload.data, missingMedia};
    } catch (err) {
      return {success: false, error: err instanceof Error ? err.message : String(err)};
    }
  });

  // ====== 工程自动保存 ======

  // 写自动保存（静默，复用工程文件原子写）
  ipcMain.handle('project:autosave', async (_, name: string, data: ProjectFileData) => writeAutosave(name, data));

  // 退出前兜底自动保存（send 通道，无返回值）：渲染端 beforeunload 阶段 invoke 的
  // 异步写不可靠（渲染进程随时被销毁），改用 send + 主进程同步落盘（writeAutosave
  // 内部是 writeFileSync 原子写）。与 invoke 通道同一份校验与落盘逻辑。
  ipcMain.on('project:autosaveSync', (_, name: string, data: ProjectFileData) => {
    const r = writeAutosave(name, data);
    if (!r.success) console.warn(`[Project] 退出前自动保存失败: ${r.error}`);
  });

  // 读取自动保存（不存在或已损坏返回 null，存在则附媒体存在性检查）
  ipcMain.handle('project:loadAutosave', async () => {
    const filePath = getAutosavePath();
    if (!fs.existsSync(filePath)) return null;
    try {
      const payload = readProjectFile(filePath);
      const missingMedia = checkMediaMissing(collectMediaPaths(payload.data));
      return {success: true, name: payload.name, data: payload.data, missingMedia};
    } catch {
      // 损坏的自动保存不阻拦启动，按不存在处理
      return null;
    }
  });

  // 删除自动保存（手动保存 / 新建 / 打开工程成功后调用）
  ipcMain.handle('project:clearAutosave', async () => {
    try {
      const filePath = getAutosavePath();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return {success: true};
    } catch (err) {
      return {success: false, error: err instanceof Error ? err.message : String(err)};
    }
  });
};
