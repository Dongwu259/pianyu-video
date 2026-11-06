/**
 * 自动更新服务（主进程，electron-updater）
 *
 * 两个更新渠道（app.isPackaged 为前提，dev 完全不碰）：
 * - NSIS 直链版（!process.windowsStore）：electron-updater 全自动——启动静默检查，
 *   autoDownload=true 后台下载，关于页可手动检查/重启安装。
 * - 商店 appx 包（process.windowsStore=true）：MSIX 安装目录只读，无法自更新，
 *   由 Partner Center 托管更新。这里只做「版本检查 + 提示」：启动静默拉取
 *   latest.yml 比对版本号，发现新版本经 update:status 提示；update:install 跳转
 *   商店「下载和更新」页（ms-windows-store://downloadsandupdates）。
 *
 * 更新源：generic provider，latest.yml + exe 由 nginx 在 /videotool/downloads/ 下静态提供，
 * 地址与授权服务共用 getServerBaseUrl() 解析（生产强制内置地址）。
 *
 * 流程：启动后静默检查一次；关于页「检查更新」走 update:check 手动检查，结果直接返回，
 * 后续下载进度/完成经 update:status 推送给渲染进程展示。
 */

import {app, ipcMain, net, shell} from 'electron';
import type {BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';
import {getServerBaseUrl} from './license';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import type {UpdateCheckResult, UpdateStatusEvent} from '../../shared/types';

/** 已下载完成的新版本号（「重启安装」的依据；下载完成后 autoUpdater 不再重复发事件，必须缓存） */
let downloadedVersion: string | null = null;
/** update:status 推送目标窗口 */
let mainWindowRef: BrowserWindow | null = null;

/** 推送更新状态到渲染进程（关于页结果区用；窗口已销毁时静默丢弃） */
const pushStatus = (event: UpdateStatusEvent): void => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(IPC_CHANNELS.UPDATE_STATUS, event);
  }
};

/** 比较两个 x.y.z 版本号：a>b 返回 1，a<b 返回 -1，相等返回 0 */
const compareSemver = (a: string, b: string): number => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
};

/**
 * 商店渠道版本检查：拉取 latest.yml 解析版本号与当前版本比对。
 * 只检查不下载——MSIX 无法自更新，发现新版本由渲染端提示用户去商店更新。
 */
const checkStoreUpdate = async (): Promise<UpdateCheckResult> => {
  try {
    const res = await net.fetch(`${getServerBaseUrl()}/downloads/latest.yml`, {cache: 'no-store'});
    if (!res.ok) return {status: 'error', message: `更新服务器返回 ${res.status}`};
    const text = await res.text();
    const m = text.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m);
    if (!m) return {status: 'error', message: '更新信息格式异常'};
    const latest = m[1];
    if (compareSemver(latest, app.getVersion()) > 0) {
      pushStatus({status: 'available', version: latest});
      return {status: 'available', version: latest};
    }
    return {status: 'none'};
  } catch (err) {
    console.error('[Updater] 商店渠道检查更新失败:', err);
    return {status: 'error', message: err instanceof Error ? err.message : String(err)};
  }
};

/** 手动检查更新：已有下载完成的更新直接回报，否则发起一次新检查 */
const checkForUpdatesManual = async (): Promise<UpdateCheckResult> => {
  if (downloadedVersion) return {status: 'downloaded', version: downloadedVersion};
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return {status: 'error', message: '当前环境不支持自动更新'};
    // autoDownload=true：发现新版本即自动开始后台下载，进度/完成经 update:status 推送
    if (result.updateInfo.version === app.getVersion()) return {status: 'none'};
    return {status: 'available', version: result.updateInfo.version};
  } catch (err) {
    console.error('[Updater] 检查更新失败:', err);
    return {status: 'error', message: err instanceof Error ? err.message : String(err)};
  }
};

/** 初始化自动更新：注册 IPC；NSIS 直链版配置 electron-updater，商店版走版本检查提示 */
export const initUpdater = (win: BrowserWindow): void => {
  mainWindowRef = win;

  // IPC 始终注册：渲染端在打包版显示入口，dev 留个兜底返回避免意外 invoke 抛错
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (): Promise<UpdateCheckResult> => {
    if (!app.isPackaged) {
      return {status: 'error', message: '开发环境不经过自动更新渠道'};
    }
    // 商店 appx 包：只做版本检查（MSIX 无法自更新）
    if (process.windowsStore) return checkStoreUpdate();
    return checkForUpdatesManual();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    if (!app.isPackaged) return;
    // 商店版：跳转商店「下载和更新」页；NSIS 直链版：退出并安装
    if (process.windowsStore) {
      void shell.openExternal('ms-windows-store://downloadsandupdates');
      return;
    }
    autoUpdater.quitAndInstall();
  });

  // 门禁：dev 不碰；商店版启动后静默做一次版本检查（有新版仅提示，不下载）
  if (!app.isPackaged) return;
  if (process.windowsStore) {
    checkStoreUpdate().catch((err) => {
      console.warn('[Updater] 商店渠道启动检查更新失败:', err);
    });
    return;
  }

  autoUpdater.autoDownload = true;
  // 项目无 electron-log 依赖，日志直接用 console（主进程控制台/日志文件）
  autoUpdater.logger = console;
  autoUpdater.setFeedURL({provider: 'generic', url: `${getServerBaseUrl()}/downloads`});

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] 正在检查更新…');
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] 发现新版本: ${info.version}，开始后台下载`);
    pushStatus({status: 'available', version: info.version});
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log(`[Updater] 已是最新版本: ${info.version}`);
  });
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Updater] 下载进度: ${progress.percent.toFixed(1)}%`);
    pushStatus({status: 'downloading', percent: progress.percent});
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] 新版本 ${info.version} 下载完成，等待重启安装`);
    downloadedVersion = info.version;
    pushStatus({status: 'downloaded', version: info.version});
  });
  autoUpdater.on('error', (err) => {
    // 错误只记日志不打扰用户（离线、更新目录未就绪等都很常见）
    console.error('[Updater] 自动更新出错:', err);
    pushStatus({status: 'error', message: err.message});
  });

  // 启动后静默检查一次（事件驱动：有新版本自动下载，用户无感）
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[Updater] 启动检查更新失败:', err);
  });
};
