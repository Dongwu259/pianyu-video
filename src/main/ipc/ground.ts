/**
 * 3D 地面追踪 IPC（分析 + sidecar 读取）
 * 安全口径与 stabilization.ts 一致：只处理 isRegisteredMediaPath() 白名单内的路径
 */

import {ipcMain} from 'electron';
import os from 'node:os';
import {isRegisteredMediaPath} from '../services/videoServer';
import {
  analyzeGroundTrackingCached,
  readGroundTrack,
  type GroundAnalyzeOpts,
} from '../services/groundTracking';
import type {IpcCtx} from './ctx';

/** 校验可选分析参数（存在的项必须是有限数字；candidateAnchors 4~16 整数） */
const parseOpts = (raw: unknown): GroundAnalyzeOpts => {
  if (raw == null || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: GroundAnalyzeOpts = {};
  for (const k of ['maxAnalyzeFps', 'trimStart', 'trimEnd'] as const) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} 必须是数字`);
    out[k] = v;
  }
  if (o.candidateAnchors !== undefined) {
    const v = o.candidateAnchors;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 4 || v > 16) {
      throw new Error('candidateAnchors 需为 4~16 的整数');
    }
    out.candidateAnchors = v;
  }
  return out;
};

export const registerGroundIpc = (_ctx: IpcCtx) => {
  // 地面追踪分析：解码 → 自动选锚 → 块匹配跟踪 → RANSAC 共面筛选 → 写 <同名>.ground.json
  ipcMain.handle('ground:analyze', async (_, req: {videoPath?: unknown; opts?: unknown}) => {
    const videoPath = typeof req?.videoPath === 'string' ? req.videoPath : '';
    if (!videoPath || !isRegisteredMediaPath(videoPath)) {
      throw new Error('素材未注册（仅可分析故事板素材）');
    }
    const opts = parseOpts(req?.opts);
    return analyzeGroundTrackingCached(videoPath, opts);
  });

  // 读地面 sidecar（不存在/损坏返回 null）
  // 路径口径：<已注册媒体同名>.ground.json，或写权限降级时落 os.tmpdir() 的产物
  ipcMain.handle('ground:read', async (_, req: {trackPath?: unknown}) => {
    const trackPath = typeof req?.trackPath === 'string' ? req.trackPath : '';
    if (!trackPath.endsWith('.ground.json')) return null;
    const mediaPath = trackPath.slice(0, -'.ground.json'.length);
    if (!isRegisteredMediaPath(mediaPath) && !trackPath.startsWith(os.tmpdir())) {
      throw new Error('轨迹文件未注册（仅可读取故事板素材的地面 sidecar）');
    }
    return readGroundTrack(trackPath);
  });
};
