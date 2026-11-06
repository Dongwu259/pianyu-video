/**
 * Computer Use（内置电脑操作）的 electron 胶水（services/computerUse.ts 是纯 Node 实现，可单测）。
 *
 * 职责：
 * - 生产 spawn/fetch/settings/token 等 deps：token 每次启动随机生成（仅存内存 + 注入子进程 env，
 *   不落盘——sidecar 生命周期与本次 app 运行绑定，重启即换 token）；
 * - 大脑配置门：模型未配置 / 命中预设里 vision=false 的纯文本模型时，直接抛中文引导
 *   （computer-use 靠截图驱动，纯文本模型跑不了）；
 * - IPC handler：computerUse:runTask / taskStatus / stopTask / playScript / getSidecarStatus。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {app, ipcMain} from 'electron';
import {getGlobalSettings} from '../services/store';
import {getLlmApiKey} from '../services/llm';
import {
  getSidecarStatus,
  getTaskStatus,
  playScript,
  runTask,
  stopSidecar,
  stopTask,
} from '../services/computerUse';
import type {ComputeUseChild, ComputeUseDeps, ComputeUseSpawnOptions} from '../services/computerUse';
import {AI_PROVIDER_PRESETS} from '../../shared/ai-presets';
import {COMPUTER_USE_CHANNELS} from '../../shared/computer-use';
import type {ComputeUseResult} from '../../shared/computer-use';

// ====== 会话 token（明文只在本进程内存与 sidecar 子进程 env；重启即换）======

let sessionToken = '';
const ensureToken = (): string => {
  if (!sessionToken) sessionToken = crypto.randomBytes(24).toString('hex');
  return sessionToken;
};

// ====== deps 装配 ======

/** child_process.spawn → ComputeUseChild（stderr 逐行转日志，便于排查 sidecar 启动失败） */
const spawnChild = (cmd: string, args: string[], opts: ComputeUseSpawnOptions): ComputeUseChild => {
  const proc = spawn(cmd, args, {
    env: {...process.env, ...opts.env},
    ...(opts.cwd ? {cwd: opts.cwd} : {}),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let exitCode: number | null = null;
  const exitCbs: ((code: number | null) => void)[] = [];
  proc.on('exit', (code) => {
    // 被信号杀掉时 code 为 null——统一记 -1，保证「已退出」判定（exitCode !== null）覆盖 kill 路径
    exitCode = code ?? -1;
    for (const cb of exitCbs.splice(0)) cb(exitCode);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) console.warn(`[ComputerUse:stderr] ${line.slice(0, 300)}`);
    }
  });
  proc.on('error', (err) => console.warn('[ComputerUse] spawn 失败:', err.message));
  return {
    pid: proc.pid,
    get exitCode() {
      return exitCode;
    },
    onExit: (cb) => {
      if (exitCode !== null) cb(exitCode);
      else exitCbs.push(cb);
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // 已退出，忽略
      }
    },
  };
};

const makeDeps = (): ComputeUseDeps => ({
  spawn: spawnChild,
  fetch: (url, init) => fetch(url, init),
  fileExists: (p) => fs.existsSync(p),
  getCommandOverride: () => process.env.PIANYU_COMPUTE_USE_CMD ?? '',
  // 打包后 exe 在 resources/compute-use/；dev 下 resources 目录没有 exe，自动落到 dev fallback
  getResourcesDir: () => (app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')),
  getBrainConfig: () => {
    const s = getGlobalSettings();
    return {baseUrl: (s.llmBaseUrl || '').trim(), model: (s.llmModel || '').trim(), apiKey: getLlmApiKey()};
  },
  ensureToken,
});

// ====== 大脑配置门（computer-use 靠截图驱动，必须多模态模型）======

const assertBrainConfigured = (): void => {
  const s = getGlobalSettings();
  const baseUrl = (s.llmBaseUrl || '').trim().replace(/\/+$/, '');
  const model = (s.llmModel || '').trim();
  if (!baseUrl || !model) {
    throw new Error('电脑操作需要先在「设置 → AI 助手」配置多模态视觉模型（服务地址 + 模型名，如 glm-4.6v-flash / qwen-vl）');
  }
  // 命中预设且预设标注不支持看图 → 直接引导换模型（sidecar 的截图决策链路必失败）
  const preset = AI_PROVIDER_PRESETS.find((p) => p.llm.baseUrl.replace(/\/+$/, '') === baseUrl && p.llm.model === model);
  if (preset && !preset.vision) {
    throw new Error(`当前模型 ${model} 不支持看图，无法驱动电脑操作（每步都要看屏幕截图决策）。请到「设置 → AI 助手」切换为多模态视觉模型（如 glm-4.6v-flash / qwen-vl / gpt-4o）`);
  }
};

// ====== IPC 注册 ======

/** 服务层结果 → IPC 返回：失败抛中文 Error（渲染端 stripIpcPrefix 后展示） */
const unwrap = <T>(r: ComputeUseResult<T>): T => {
  if (!r.ok) throw new Error(r.message);
  return r.data;
};

export const registerComputerUseIpc = (): void => {
  ipcMain.handle(COMPUTER_USE_CHANNELS.RUN_TASK, async (_e, req: {task?: unknown; maxSteps?: unknown; filmMode?: unknown; dryRun?: unknown}) => {
    const task = typeof req?.task === 'string' ? req.task.trim() : '';
    if (!task) throw new Error('task 必须是非空字符串');
    assertBrainConfigured();
    return unwrap(await runTask(makeDeps(), {
      task,
      ...(typeof req.maxSteps === 'number' && Number.isFinite(req.maxSteps) ? {maxSteps: Math.max(1, Math.min(200, Math.round(req.maxSteps)))} : {}),
      ...(req.filmMode === true ? {filmMode: true} : {}),
      ...(req.dryRun === true ? {dryRun: true} : {}),
    }));
  });

  ipcMain.handle(COMPUTER_USE_CHANNELS.TASK_STATUS, async (_e, taskId: unknown) => {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId 必须是非空字符串');
    return unwrap(await getTaskStatus(makeDeps(), taskId.trim()));
  });

  ipcMain.handle(COMPUTER_USE_CHANNELS.STOP_TASK, async (_e, taskId: unknown) => {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('taskId 必须是非空字符串');
    return unwrap(await stopTask(makeDeps(), taskId.trim()));
  });

  ipcMain.handle(COMPUTER_USE_CHANNELS.PLAY_SCRIPT, async (_e, req: {scriptPath?: unknown; verify?: unknown; filmMode?: unknown}) => {
    const scriptPath = typeof req?.scriptPath === 'string' ? req.scriptPath.trim() : '';
    if (!scriptPath) throw new Error('scriptPath 必须是非空字符串');
    // 回放不需要大脑（确定性动作重放），不做 vision 门
    return unwrap(await playScript(makeDeps(), {
      scriptPath,
      ...(req.verify !== undefined ? {verify: req.verify === true} : {}),
      ...(req.filmMode === true ? {filmMode: true} : {}),
    }));
  });

  ipcMain.handle(COMPUTER_USE_CHANNELS.GET_SIDECAR_STATUS, () => getSidecarStatus(makeDeps()));
};

/** 应用退出前调用（index.ts before-quit）：杀掉 sidecar 子进程 */
export const shutdownComputerUse = (): void => {
  stopSidecar();
};
