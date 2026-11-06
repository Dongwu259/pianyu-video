/**
 * 授权 / 订阅 IPC（激活 / 解绑 / 状态查询）
 */

import {ipcMain} from 'electron';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import {activateLicense, deactivateLicense, getLicenseStatus} from '../services/license';

export const registerLicenseIpc = () => {
  // 激活授权码
  ipcMain.handle(IPC_CHANNELS.LICENSE_ACTIVATE, async (_, code: string) => {
    return activateLicense(code);
  });

  // 解绑当前设备
  ipcMain.handle(IPC_CHANNELS.LICENSE_DEACTIVATE, async () => {
    return deactivateLicense();
  });

  // 查询授权状态（供 UI 展示）
  ipcMain.handle(IPC_CHANNELS.LICENSE_GET_STATUS, async () => {
    return getLicenseStatus();
  });
};
