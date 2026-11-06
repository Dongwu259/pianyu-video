/**
 * 设置与持久化存储 IPC（store 白名单 / 全局设置）
 */

import {dialog, ipcMain} from 'electron';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import {AI_PROVIDER_PRESETS} from '../../shared/ai-presets';
import {store, getGlobalSettings, setGlobalSettings} from '../services/store';
import type {IpcCtx} from './ctx';

// 持久化存储
// 安全：渲染进程任意 JS 都能调这三个通道，必须白名单——否则 license.code 明文、
// llmApiKeyEncrypted/ttsApiKeyEncrypted 密文、machineId 都可被读出，license 甚至可被覆写。
// 白名单只放渲染端实际使用且不敏感的键（recentProjects 见 projectStore.ts；config 为输出目录/画质预设）。
const ALLOWED_STORE_KEYS: ReadonlySet<string> = new Set(['recentProjects', 'config']);

// 安全：渲染进程任意 JS 都能调这个通道，必须白名单 + 逐键校验。
// 否则 llmBaseUrl/ttsBaseUrl/licenseServerUrl 可被改写为攻击者服务器，
// 主进程下次请求就会把用户的 API key / 激活码明文发过去（「key 不出主进程」的保护形同虚设）。
const SETTINGS_SCHEMA: Record<string, 'string' | 'boolean' | 'number' | 'format' | 'theme' | 'port'> = {
  defaultOutputDir: 'string',
  defaultFormat: 'format',
  defaultCrf: 'number',
  autoSave: 'boolean',
  theme: 'theme',
  editorProMode: 'boolean',
  persistUndoHistory: 'boolean',
  crashReporting: 'boolean',
  usageReporting: 'boolean',
  llmBaseUrl: 'string',
  llmModel: 'string',
  ttsBaseUrl: 'string',
  ttsModel: 'string',
  ttsVoice: 'string',
  licenseServerUrl: 'string',
  musicLibraryDir: 'string',
  asrBaseUrl: 'string',
  asrModel: 'string',
  imageGenModel: 'string',
  imageGenBaseUrl: 'string',
  modelGenBaseUrl: 'string',
  modelGenModel: 'string',
  mcpEnabled: 'boolean',
  mcpPort: 'port',
};

/** baseUrl 类键：改动会把 API key / 激活码发往新端点，需要主进程弹窗由用户本人确认 */
const SENSITIVE_URL_KEYS = [
  {key: 'llmBaseUrl', label: 'AI 助手服务地址'},
  {key: 'ttsBaseUrl', label: 'TTS 语音服务地址'},
  {key: 'licenseServerUrl', label: '授权服务器地址'},
  {key: 'asrBaseUrl', label: '语音识别服务地址'},
  {key: 'modelGenBaseUrl', label: '文生 3D 服务地址'},
] as const;

/** 已知厂商预设端点白名单：预设 chip / 三步快速配置写入的都是第一方厂商官方端点，
    不弹确认框——弹窗会把「点厂商，粘 Key，即用」变成两次吓人的安全警告（AI 零门槛形同虚设）。
    安全账仍然成立：渲染进程被攻破时，白名单只能把 Key 发往该厂商的官方端点，密钥不出该厂商，无外泄面；
    自定义端点（真正的任意重定向）照旧弹窗确认。 */
const PRESET_BASE_URLS: ReadonlySet<string> = new Set(
  AI_PROVIDER_PRESETS.flatMap((p) => [p.llm.baseUrl, p.tts?.baseUrl, p.asr?.baseUrl, p.image?.baseUrl])
    .filter((u): u is string => !!u)
    .map((u) => u.replace(/\/+$/, '')),
);
const isPresetBaseUrl = (v: string): boolean => PRESET_BASE_URLS.has(v.trim().replace(/\/+$/, ''));

export const registerSettingsIpc = (ctx: IpcCtx) => {
  const {isDev} = ctx;

  /** baseUrl 合法性：空串合法；否则必须 http(s)，且生产环境下 http 仅允许本机回环（公网 http 明文传 key） */
  const isValidBaseUrl = (v: string): boolean => {
    if (!v) return true;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false;
    }
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      return isDev || ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
    }
    return false;
  };

  ipcMain.handle(IPC_CHANNELS.STORE_GET, async (_, key: string) => {
    if (!ALLOWED_STORE_KEYS.has(key)) return undefined;
    return store.get(key);
  });

  ipcMain.handle(IPC_CHANNELS.STORE_SET, async (_, key: string, value: unknown) => {
    if (!ALLOWED_STORE_KEYS.has(key)) {
      throw new Error(`store:set 不允许写入键「${String(key)}」`);
    }
    store.set(key, value);
  });

  ipcMain.handle(IPC_CHANNELS.STORE_GET_ALL, () => {
    // 只回白名单键（llmApiKeyEncrypted/ttsApiKeyEncrypted/license/machineId 等一律不出主进程）
    const filtered: Record<string, unknown> = {};
    for (const key of ALLOWED_STORE_KEYS) {
      filtered[key] = store.get(key);
    }
    return filtered;
  });

  // 全局设置（设置页面）
  ipcMain.handle('settings:get', async () => {
    return getGlobalSettings();
  });

  ipcMain.handle('settings:set', async (_, settings) => {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new Error('settings:set 入参必须是对象');
    }
    // 白名单 + 类型校验，未知键直接丢弃
    const cleaned: Record<string, unknown> = {};
    for (const [key, kind] of Object.entries(SETTINGS_SCHEMA)) {
      const v = (settings as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (kind === 'string' && typeof v === 'string' && v.length <= 500) cleaned[key] = v;
      else if (kind === 'boolean' && typeof v === 'boolean') cleaned[key] = v;
      else if (kind === 'number' && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000) cleaned[key] = v;
      else if (kind === 'port' && typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535) cleaned[key] = v;
      else if (kind === 'format' && (v === 'mp4' || v === 'mov' || v === 'webm')) cleaned[key] = v;
      else if (kind === 'theme' && (v === 'light' || v === 'dark' || v === 'system')) cleaned[key] = v;
    }
    // 生产环境禁用自定义授权服务器地址（防伪造服务端白嫖授权；开发联调保留）
    if (!isDev) delete cleaned.licenseServerUrl;
    // baseUrl 类键逐个校验格式
    for (const {key} of SENSITIVE_URL_KEYS) {
      const v = cleaned[key];
      if (typeof v === 'string' && !isValidBaseUrl(v.trim())) {
        throw new Error(`服务地址不合法：${v.slice(0, 80)}（生产环境仅允许 https 或本机回环 http）`);
      }
    }
    // 敏感端点变更：生产环境下弹主进程确认框（渲染进程 JS 无法伪造用户点击），
    // 防止恶意脚本静默把 API key 重定向到攻击者服务器。用户取消则丢弃这些键，其余照常保存。
    const mainWindow = ctx.getMainWindow();
    if (!isDev && mainWindow) {
      const current = getGlobalSettings();
      const changed = SENSITIVE_URL_KEYS.filter(({key}) => {
        const next = cleaned[key];
        if (typeof next !== 'string') return false;
        // 预设白名单端点免确认（见 PRESET_BASE_URLS 注）；清空/自定义端点照旧确认
        if (isPresetBaseUrl(next)) return false;
        return next.trim() !== (current[key] ?? '').trim();
      });
      if (changed.length > 0) {
        const detail = changed
          .map(({key, label}) => `${label}：\n  ${(current[key] ?? '') || '（默认）'}  →  ${(cleaned[key] as string) || '（默认）'}`)
          .join('\n');
        const {response} = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['允许修改', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '确认修改服务地址',
          message: '以下服务地址将被修改（API key / 授权信息将发往新地址）：',
          detail: `${detail}\n\n请确认这是你本人的操作。`,
        });
        if (response !== 0) {
          for (const {key} of changed) delete cleaned[key];
        }
      }
    }
    setGlobalSettings(cleaned);
    return true;
  });
};
