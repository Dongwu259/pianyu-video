/**
 * 跟踪稳定 IPC（分析 + sidecar 读取）
 * 安全口径与 media.ts 的批量抽帧一致：只处理 isRegisteredMediaPath() 白名单内的路径
 */

import {ipcMain} from 'electron';
import os from 'node:os';
import {isRegisteredMediaPath} from '../services/videoServer';
import {
  analyzeStabilizationCached,
  readStabTrack,
  type StabAnalyzeOpts,
} from '../services/stabilization';
import type {StabPoint} from '../../shared/stabilization';
import type {IpcCtx} from './ctx';

/** 校验跟踪点数组：0~2 个 {x,y} 有限非负数字；空数组 = 自动选点（服务侧首帧 autoPickPoint） */
const parsePoints = (raw: unknown): StabPoint[] => {
  if (!Array.isArray(raw) || raw.length > 2) {
    throw new Error('points 需为 0~2 个跟踪点（空数组 = 自动选点）');
  }
  return raw.map((p) => {
    const x = (p as StabPoint)?.x;
    const y = (p as StabPoint)?.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      throw new Error('跟踪点坐标必须是 ≥0 的数字');
    }
    return {x, y};
  });
};

/** 校验可选分析参数（存在的项必须是有限数字） */
const parseOpts = (raw: unknown): StabAnalyzeOpts => {
  if (raw == null || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: StabAnalyzeOpts = {};
  const keys = ['smoothSec', 'maxZoom', 'maxAnalyzeFps', 'trimStart', 'trimEnd'] as const;
  for (const k of keys) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} 必须是数字`);
    out[k] = v;
  }
  return out;
};

export const registerStabilizationIpc = (_ctx: IpcCtx) => {
  // 跟踪稳定分析：解码 → 块匹配跟踪 → 平滑求解 → 写 <同名>.stab.json sidecar
  ipcMain.handle('stabilization:analyze', async (_, req: {videoPath?: unknown; points?: unknown; opts?: unknown}) => {
    const videoPath = typeof req?.videoPath === 'string' ? req.videoPath : '';
    if (!videoPath || !isRegisteredMediaPath(videoPath)) {
      throw new Error('素材未注册（仅可稳定故事板素材）');
    }
    const points = parsePoints(req?.points);
    const opts = parseOpts(req?.opts);
    return analyzeStabilizationCached(videoPath, points, opts);
  });

  // 读稳定 sidecar（不存在/损坏返回 null）
  // 路径口径：<已注册媒体同名>.stab.json，或分析服务写权限降级时落 os.tmpdir() 的产物
  ipcMain.handle('stabilization:read', async (_, req: {trackPath?: unknown}) => {
    const trackPath = typeof req?.trackPath === 'string' ? req.trackPath : '';
    if (!trackPath.endsWith('.stab.json')) return null;
    const mediaPath = trackPath.slice(0, -'.stab.json'.length);
    if (!isRegisteredMediaPath(mediaPath) && !trackPath.startsWith(os.tmpdir())) {
      throw new Error('轨迹文件未注册（仅可读取故事板素材的稳定 sidecar）');
    }
    return readStabTrack(trackPath);
  });
};
