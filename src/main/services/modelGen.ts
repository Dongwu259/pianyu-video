/**
 * 文生 3D 服务（主进程）——Meshy 兼容 Text-to-3D REST。
 *
 * 与文生图（imageGen.ts）同模式，但服务商 Key 独立（设置 → 文生 3D）：
 * - API key 用 safeStorage 加密存 electron-store（与 tts.ts 同模式），永不回传渲染进程
 * - 生成任务为 pending 单例：重复调用 generateModel 返回进行中的任务快照，不重复建任务；
 *   渲染端拿快照后按 MODEL_GEN_FRONTEND_POLL_MS 轮询 getModelGenStatus 直到 succeeded/failed
 * - 产物 glb 落盘 userData/modelgen/ 哈希缓存（prompt+model+baseUrl 相同不重复请求），
 *   落盘后注册媒体白名单并转本地 HTTP URL（与素材导入同口径，可直接进故事板）
 * - 轮询/错误文本等纯逻辑在 shared/model-gen.ts（可单测）；glb 魔数嗅探不信任响应头
 *
 * 网络/HTTP/格式错误统一转中文 Error。
 */

import {app, safeStorage} from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {getGlobalSettings, getModelGenApiKeyEncrypted, setModelGenApiKeyEncrypted} from './store';
import {registerMediaPath, filePathToHttpUrl} from './videoServer';
import {
  MODEL_GEN_DEFAULT_BASE_URL, MODEL_GEN_DEFAULT_MODEL, MODEL_GEN_IDLE_TASK,
  MODEL_GEN_POLL_INTERVAL_MS, MODEL_GEN_TOTAL_TIMEOUT_MS,
  createTextTo3dTask, pollTextTo3dTask, modelGenCacheKeyMaterial,
} from '../../shared/model-gen';
import type {ModelGenRequest, ModelGenStatus, ModelGenTaskSnapshot} from '../../shared/model-gen';

/** safeStorage 加密 API key；不可用时退化为 base64（与 tts.ts 一致） */
const encryptKey = (key: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64');
  }
  return Buffer.from(key, 'utf8').toString('base64');
};

const decryptKey = (keyEncrypted: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(keyEncrypted, 'base64'));
  }
  return Buffer.from(keyEncrypted, 'base64').toString('utf8');
};

/** 保存 API key（空字符串 = 清除） */
export const setModelGenApiKey = (key: string): void => {
  const trimmed = (key || '').trim();
  setModelGenApiKeyEncrypted(trimmed ? encryptKey(trimmed) : '');
};

/** 进行/最近一次任务的快照（pending 单例；终态保留供迟到的轮询读取） */
let currentTask: ModelGenTaskSnapshot = MODEL_GEN_IDLE_TASK;
/** 进行中任务的缓存键材料（去重判断：同材料复用，不同材料拒绝） */
let currentKeyMaterial = '';

/** 查询配置状态 + 任务快照（只回 已配置/baseUrl/model，key 永不回渲染进程） */
export const getModelGenStatus = (): ModelGenStatus => {
  const settings = getGlobalSettings();
  return {
    configured: Boolean(getModelGenApiKeyEncrypted()),
    baseUrl: (settings.modelGenBaseUrl || '').trim() || MODEL_GEN_DEFAULT_BASE_URL,
    model: (settings.modelGenModel || '').trim() || MODEL_GEN_DEFAULT_MODEL,
    task: currentTask,
  };
};

/** 缓存目录：userData/modelgen/（不存在则创建） */
const modelGenCacheDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'modelgen');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
  return dir;
};

/** glb 魔数嗅探（"glTF" 小端头），不信任响应头/扩展名 */
const isGlbBuffer = (buf: Buffer): boolean => buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'glTF';

/**
 * 发起文生 3D 任务（立即返回任务快照，不阻塞到完成）。
 * - 命中缓存（prompt+baseUrl+model+artStyle 哈希）直接返回 succeeded 快照
 * - 已有进行中任务：同材料返回其快照（去重），不同材料抛中文错误
 * - 新任务：建任务后在后台轮询→下载→落盘，快照经 getModelGenStatus 透出
 */
export const generateModel = async (req: ModelGenRequest): Promise<ModelGenTaskSnapshot> => {
  const prompt = (req.prompt || '').trim();
  if (!prompt) throw new Error('3D 生成提示词为空');
  const artStyle = (req.artStyle || '').trim();
  const negativePrompt = (req.negativePrompt || '').trim();
  const settings = getGlobalSettings();
  const baseUrl = ((settings.modelGenBaseUrl || '').trim() || MODEL_GEN_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = (settings.modelGenModel || '').trim() || MODEL_GEN_DEFAULT_MODEL;
  const keyEncrypted = getModelGenApiKeyEncrypted();
  if (!keyEncrypted) throw new Error('未配置文生 3D 的 API Key，请到「设置 → 文生 3D」中保存（去 meshy.ai 申请）');
  let apiKey: string;
  try {
    apiKey = decryptKey(keyEncrypted);
  } catch {
    throw new Error('文生 3D API Key 解密失败，请到「设置 → 文生 3D」重新保存');
  }

  const keyMaterial = modelGenCacheKeyMaterial({baseUrl, model, prompt, artStyle});
  const hash = crypto.createHash('sha1').update(keyMaterial).digest('hex');
  const cached = path.join(modelGenCacheDir(), `${hash}.glb`);
  if (fs.existsSync(cached)) {
    registerMediaPath(cached);
    currentTask = {state: 'succeeded', progress: 100, prompt, path: cached, src: filePathToHttpUrl(cached)};
    currentKeyMaterial = '';
    return currentTask;
  }

  if (currentTask.state === 'pending' || currentTask.state === 'running') {
    if (currentKeyMaterial === keyMaterial) return currentTask;
    throw new Error(`已有 3D 生成任务进行中（「${currentTask.prompt.slice(0, 30)}」），等完成后再发起新任务`);
  }

  const clientOpts = {baseUrl, apiKey, pollIntervalMs: MODEL_GEN_POLL_INTERVAL_MS, totalTimeoutMs: MODEL_GEN_TOTAL_TIMEOUT_MS};
  const taskId = await createTextTo3dTask(clientOpts, {prompt, artStyle, negativePrompt});
  console.log(`[ModelGen] 任务已创建：${taskId}（model=${model}）`);
  currentKeyMaterial = keyMaterial;
  currentTask = {state: 'pending', progress: 0, prompt};

  // 后台轮询 → 下载 → 落盘缓存 → 注册白名单；终态快照供渲染端轮询读取
  void (async () => {
    try {
      const glbUrl = await pollTextTo3dTask(clientOpts, taskId, (status, progress) => {
        currentTask = {...currentTask, state: status === 'PENDING' ? 'pending' : 'running', progress};
      });
      const res = await fetch(glbUrl).catch(() => null);
      if (!res || !res.ok) throw new Error('3D 模型下载失败（服务商返回的 glb 地址无法拉取），请重试');
      const buf = Buffer.from(await res.arrayBuffer());
      if (!isGlbBuffer(buf)) throw new Error('服务商返回内容不是有效 glb（仅支持未压缩 glb 链路）');
      const file = path.join(modelGenCacheDir(), `${hash}.glb`);
      fs.writeFileSync(file, buf);
      registerMediaPath(file);
      currentTask = {state: 'succeeded', progress: 100, prompt, path: file, src: filePathToHttpUrl(file)};
      currentKeyMaterial = '';
      console.log(`[ModelGen] 任务完成：${taskId} → ${file}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[ModelGen] 任务失败：${taskId}：${message}`);
      currentTask = {state: 'failed', progress: currentTask.progress, prompt, message};
      currentKeyMaterial = '';
    }
  })();

  return currentTask;
};
