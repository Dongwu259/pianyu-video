/**
 * MCP 服务接口的 electron 胶水（services/mcpServer.ts 是纯 Node 实现，可单测）。
 *
 * 职责：
 * - token 生命周期：首次启用时 crypto 随机生成，safeStorage 加密落盘（mcpTokenEncrypted）；
 * - IPC handler：mcp:getStatus / mcp:setEnabled / mcp:setPort / mcp:regenerateToken；
 * - 渲染端桥：mcp:execute 下发 + mcp:result 配对（pending Map + callId + 超时清理）。
 */

import crypto from 'node:crypto';
import {app, ipcMain, safeStorage} from 'electron';
import {
  getGlobalSettings,
  getMcpTokenEncrypted,
  setGlobalSettings,
  setMcpTokenEncrypted,
  getCustomTemplates,
  getGeneratedTemplates,
} from '../services/store';
import {listInstalled} from '../services/templateMarket';
import {getMcpServerStatus, startMcpServer, stopMcpServer} from '../services/mcpServer';
import type {McpBridgeResult} from '../services/mcpServer';
import {installAgent, listAgents, MCP_AGENT_IDS, healAgentConfigs} from '../services/mcpAgentInstall';
import {MCP_CALL_TIMEOUT_MS, MCP_CHANNELS, MCP_DEFAULT_PORT} from '../../shared/mcp';
import type {McpAgentId, McpAgentListResult, McpAgentInstallResult, McpBridgeRequest, McpBridgeResponse, McpServerStatus} from '../../shared/mcp';
import type {IpcCtx} from './ctx';

// ====== token（safeStorage 加密落盘；明文只在主进程内存与设置页展示）======

/** 解密已存 token；无记录/解密失败（换机/数据损坏）返回空串 */
const readToken = (): string => {
  const enc = getMcpTokenEncrypted();
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
};

/** 生成新 token 并加密落盘，返回明文 */
const generateToken = (): string => {
  const token = crypto.randomBytes(24).toString('hex');
  setMcpTokenEncrypted(safeStorage.encryptString(token).toString('base64'));
  return token;
};

// 本次启动内已确保的 token（明文仅存内存）。getToken 每个请求都会调——若无此缓存，
// readToken 一旦瞬时失败就会当场重新生成并覆盖落盘，造成「重启后旧接入方 401」的隐性轮换。
// 这里保证每次启动至多生成一次，且生成必打日志（可追查），显式重生成（设置页按钮）才更新。
let ensuredToken = '';
const ensureToken = (): string => {
  if (ensuredToken) return ensuredToken;
  const t = readToken();
  if (t) {
    ensuredToken = t;
    return t;
  }
  ensuredToken = generateToken();
  console.warn('[MCP] 已存 token 缺失或解密失败，已生成新 token（此前接入方需在设置页重新复制）');
  return ensuredToken;
};

// ====== 渲染端桥（pending Map + callId 配对 + 超时清理）======

interface PendingCall {
  resolve: (r: McpBridgeResult) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingCall>();
let callSeq = 0;

const makeBridge = (ctx: IpcCtx) => ({
  execute: (name: string, args: Record<string, unknown>): Promise<McpBridgeResult> => {
    const win = ctx.getMainWindow();
    if (!win || win.isDestroyed()) {
      return Promise.resolve({ok: false, error: '应用界面未就绪（主窗口不存在或已关闭），请在片语窗口打开后重试'});
    }
    const callId = `${Date.now()}-${++callSeq}`;
    return new Promise<McpBridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        resolve({ok: false, error: '应用界面响应超时，请重试'});
      }, MCP_CALL_TIMEOUT_MS);
      pending.set(callId, {resolve, timer});
      const req: McpBridgeRequest = {callId, name, args};
      win.webContents.send(MCP_CHANNELS.EXECUTE, req);
    });
  },
});

/** 渲染端结果回传配对（mcpBridge.ts 经 preload 的 mcpExecuteResult 发来） */
const registerResultListener = (): void => {
  ipcMain.on(MCP_CHANNELS.RESULT, (_e, resp: McpBridgeResponse) => {
    const p = pending.get(resp?.callId);
    if (!p) return; // 超时已清理/未知 callId：丢弃
    pending.delete(resp.callId);
    clearTimeout(p.timer);
    if (resp.ok) {
      p.resolve({ok: true, result: resp.result, image: resp.image, images: resp.images});
    } else {
      p.resolve({ok: false, error: resp.error || '工具执行失败'});
    }
  });
};

// ====== 服务启停 ======

const startWithCurrentSettings = async (ctx: IpcCtx): Promise<void> => {
  await startMcpServer({
    getToken: ensureToken,
    getPort: () => getGlobalSettings().mcpPort ?? MCP_DEFAULT_PORT,
    bridge: makeBridge(ctx),
    getVersion: () => app.getVersion(),
    // 模板清单与 AI 助手同源：内置 + 自定义 + 已装市场模板 + AI 生成模板
    getTemplates: () => ({customTemplates: getCustomTemplates(), marketTemplates: listInstalled(), generatedTemplates: getGeneratedTemplates()}),
  });
  // 端口自愈：端口被占用顺延/用户改端口后，已接入 agent 配置里的旧地址会失联——
  // 每次成功启动后把 token 未变的已接入配置改写为当前实际地址（token 重新生成过的=已吊销，不动）
  const s = getMcpServerStatus();
  if (s.running && s.url) {
    for (const f of healAgentConfigs(app.getPath('home'), s.url, ensureToken())) {
      console.warn(`[MCP] 端口自愈：${f.name} 接入地址 ${f.fromUrl} → ${s.url}（重启该 agent 后生效）`);
    }
  }
};

/** 应用启动时调用：设置里启用了 MCP 则拉起服务（index.ts whenReady） */
export const startMcpServerIfEnabled = async (ctx: IpcCtx): Promise<void> => {
  if (!getGlobalSettings().mcpEnabled) return;
  try {
    await startWithCurrentSettings(ctx);
  } catch (err) {
    console.warn('[MCP] 启动失败:', err);
  }
};

/** 应用退出前调用（index.ts before-quit） */
export const shutdownMcpServer = async (): Promise<void> => {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.resolve({ok: false, error: '应用正在退出'});
  }
  pending.clear();
  await stopMcpServer();
};

const buildStatus = (): McpServerStatus => {
  const settings = getGlobalSettings();
  const s = getMcpServerStatus();
  return {
    enabled: settings.mcpEnabled ?? false,
    running: s.running,
    // 未运行时回退配置端口（设置页端口输入框/状态行展示用）
    port: s.running ? s.port : (settings.mcpPort ?? MCP_DEFAULT_PORT),
    url: s.url,
    token: ensureToken(),
  };
};

// ====== IPC 注册 ======

export const registerMcpIpc = (ctx: IpcCtx): void => {
  registerResultListener();

  ipcMain.handle(MCP_CHANNELS.GET_STATUS, () => buildStatus());

  ipcMain.handle(MCP_CHANNELS.SET_ENABLED, async (_e, enabled: unknown) => {
    const on = enabled === true;
    setGlobalSettings({mcpEnabled: on});
    try {
      if (on) await startWithCurrentSettings(ctx);
      else await shutdownMcpServer();
    } catch (err) {
      console.warn('[MCP] 服务启停失败:', err);
    }
    return buildStatus();
  });

  ipcMain.handle(MCP_CHANNELS.SET_PORT, async (_e, port: unknown) => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('端口必须是 1024-65535 的整数');
    }
    setGlobalSettings({mcpPort: port});
    // 运行中则重启生效（端口占用时 startMcpServer 内部自动递增）
    if (getMcpServerStatus().running) {
      try {
        await stopMcpServer();
        await startWithCurrentSettings(ctx);
      } catch (err) {
        console.warn('[MCP] 修改端口后重启失败:', err);
      }
    }
    return buildStatus();
  });

  ipcMain.handle(MCP_CHANNELS.REGENERATE_TOKEN, () => {
    ensuredToken = generateToken();
    return buildStatus();
  });

  // ====== 一键接入（把 url+token 直接写进本机 agent 的配置文件，见 services/mcpAgentInstall.ts）======

  ipcMain.handle(MCP_CHANNELS.LIST_AGENTS, (): McpAgentListResult => ({
    agents: listAgents(app.getPath('home')),
    url: getMcpServerStatus().url,
  }));

  ipcMain.handle(MCP_CHANNELS.INSTALL_AGENT, (_e, id: unknown): McpAgentInstallResult => {
    // 六家 agent（kimi/claude/codex/openclaw/zcode/dsh）都支持一键接入——
    // 守卫只挡未知 id，别再硬编码两家（曾导致 Codex/OpenClaw/ZCode/DSH 点一键接入报「未知的 agent」）
    if (typeof id !== 'string' || !MCP_AGENT_IDS.includes(id as McpAgentId)) throw new Error('未知的 agent');
    // 未启用服务时没有可写入的接入地址：直接报错比「先按当前设置启动」更简单安全
    //（启用是用户的显式授权动作，一键接入不应顺带改设置）
    const s = getMcpServerStatus();
    if (!s.running || !s.url) throw new Error('请先在上方启用 MCP 服务，再执行一键接入');
    return installAgent(app.getPath('home'), id as McpAgentId, {url: s.url, token: ensureToken()});
  });
};
