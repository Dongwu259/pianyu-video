/**
 * 文生 3D（Meshy 兼容 Text-to-3D REST）——共享类型与纯逻辑。
 * 服务实现在 main/services/modelGen.ts（electron 依赖：缓存落盘 / Key 解密 / 媒体注册）。
 *
 * 流程：POST {baseUrl}/v2/text-to-3d 建任务（mode=preview）→ 轮询 GET /v2/text-to-3d/{id}
 * 直到 SUCCEEDED → 下载 model_urls.glb → userData/modelgen/ 哈希缓存 → 本地 HTTP URL 进故事板。
 *
 * 本文件不 import 任何 Node 运行时依赖（fetch 用全局，Node 18+ / Chromium 均有），
 * 因此主进程 / 渲染端 / 单测都可直接引用；网络细节由调用方注入（fetch/sleep/时钟），单测可 mock。
 */

export interface ModelGenRequest {
  prompt: string;
  /** 艺术风格（可选，如 realistic / cartoon，视服务商支持而定） */
  artStyle?: string;
  /** 负面提示词（可选） */
  negativePrompt?: string;
}

export interface ModelGenResult {
  /** 本地文件绝对路径（userData/modelgen/ 哈希缓存） */
  path: string;
  /** 本地媒体服务器 HTTP URL（VideoClip type:'model' 直接可用） */
  src: string;
}

/** 生成任务快照（主进程 pending 单例；渲染端按 MODEL_GEN_FRONTEND_POLL_MS 轮询） */
export interface ModelGenTaskSnapshot {
  state: 'idle' | 'pending' | 'running' | 'succeeded' | 'failed';
  /** 进度 0-100（服务商回报值钳制后透出） */
  progress: number;
  /** 本任务的提示词（去重判断与展示用） */
  prompt: string;
  /** 可读状态/错误文本（failed 时必有） */
  message?: string;
  /** 成功产物（succeeded 时必有） */
  path?: string;
  src?: string;
}

export interface ModelGenStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  task: ModelGenTaskSnapshot;
}

export const MODEL_GEN_DEFAULT_BASE_URL = 'https://api.meshy.ai';
export const MODEL_GEN_DEFAULT_MODEL = 'meshy-4';
/** 主进程轮询服务商任务间隔（Meshy preview 任务普遍 1-3 分钟） */
export const MODEL_GEN_POLL_INTERVAL_MS = 2500;
/** 生成总超时（超时放弃并提示去服务商后台确认） */
export const MODEL_GEN_TOTAL_TIMEOUT_MS = 8 * 60_000;
/** 渲染端轮询主进程任务快照的间隔 */
export const MODEL_GEN_FRONTEND_POLL_MS = 3000;

export const MODEL_GEN_IDLE_TASK: ModelGenTaskSnapshot = {state: 'idle', progress: 0, prompt: ''};

// ====== 状态归一化 / 错误文本（纯函数） ======

export type MeshyTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';

/** 服务商 status 字段归一化；不认识的状态按 FAILED 处理（避免死等服务商新增状态） */
export const normalizeMeshyStatus = (raw: unknown): MeshyTaskStatus => {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'PENDING' || s === 'IN_PROGRESS' || s === 'SUCCEEDED') return s;
  return 'FAILED';
};

/** 进度钳制到 0-100 整数（非法值归 0） */
export const clampProgress = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
};

/** Meshy task_error 字段（{message} 或字符串）→ 可读中文错误 */
export const describeMeshyTaskError = (taskError: unknown): string => {
  if (!taskError) return '3D 生成失败（服务商未给出原因）';
  if (typeof taskError === 'string') return `3D 生成失败：${taskError.slice(0, 200)}`;
  const msg = (taskError as {message?: unknown}).message;
  if (typeof msg === 'string' && msg.trim()) return `3D 生成失败：${msg.trim().slice(0, 200)}`;
  return '3D 生成失败（服务商未给出原因）';
};

/** 建任务/轮询 HTTP 非 2xx → 可读中文错误（401/403 特判 Key，429 特判限流） */
export const meshyHttpErrorText = (status: number, body: string): string => {
  const brief = (body || '').replace(/\s+/g, ' ').slice(0, 200);
  if (status === 401 || status === 403) {
    return `文生 3D 服务拒绝了 API Key（HTTP ${status}），请到「设置 → 文生 3D」检查 Key 是否正确`;
  }
  if (status === 429) return '文生 3D 服务限流（HTTP 429），稍后再试或检查服务商额度';
  return `文生 3D 服务返回错误（HTTP ${status || '非 2xx'}）：${brief || '无响应正文'}`;
};

/**
 * 缓存键材料（主进程对其做 sha1 得文件名）：baseUrl|model|artStyle|prompt。
 * 与 imageGen 同口径——同输入不重复请求、不重复计费。
 */
export const modelGenCacheKeyMaterial = (parts: {baseUrl: string; model: string; prompt: string; artStyle?: string}): string =>
  `${parts.baseUrl}|${parts.model}|${parts.artStyle || ''}|${parts.prompt}`;

// ====== Meshy 兼容端点交互（fetch/sleep/时钟全部可注入，单测可 mock） ======

export interface MeshyClientOpts {
  baseUrl: string;
  apiKey: string;
  /** 缺省用全局 fetch（Node 18+ / Chromium） */
  fetchImpl?: typeof fetch;
  /** 缺省为真实 setTimeout 睡眠；测试传立即 resolved 的假实现 */
  sleepImpl?: (ms: number) => Promise<void>;
  /** 缺省 Date.now；测试传假时钟配合超时分支 */
  nowImpl?: () => number;
  pollIntervalMs?: number;
  totalTimeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type CreateTaskResponse = {result?: unknown};

type TaskQueryResponse = {
  status?: unknown;
  progress?: unknown;
  model_urls?: {glb?: unknown} | null;
  task_error?: unknown;
};

/**
 * 创建 Text-to-3D preview 任务，返回 taskId。
 * 网络/HTTP/协议错误统一转中文 Error。
 */
export const createTextTo3dTask = async (opts: MeshyClientOpts, req: ModelGenRequest): Promise<string> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {mode: 'preview', prompt: req.prompt};
  if (req.artStyle) body.art_style = req.artStyle;
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
  let res: Response;
  try {
    res = await fetchImpl(`${base}/v2/text-to-3d`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}`},
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`无法连接文生 3D 服务：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(meshyHttpErrorText(res.status, text));
  }
  const json = await res.json().catch(() => null) as CreateTaskResponse | null;
  const taskId = typeof json?.result === 'string' ? json.result : '';
  if (!taskId) throw new Error('文生 3D 服务未返回任务 id（确认端点为 Meshy 兼容 Text-to-3D）');
  return taskId;
};

/**
 * 轮询任务直到 SUCCEEDED，返回 glb 下载地址。
 * onProgress 每跳回报一次（归一化状态 + 钳制进度）；FAILED 抛中文错误；超时抛超时错误。
 */
export const pollTextTo3dTask = async (
  opts: MeshyClientOpts,
  taskId: string,
  onProgress?: (status: MeshyTaskStatus, progress: number) => void,
): Promise<string> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const nowImpl = opts.nowImpl ?? Date.now;
  const interval = opts.pollIntervalMs ?? MODEL_GEN_POLL_INTERVAL_MS;
  const timeout = opts.totalTimeoutMs ?? MODEL_GEN_TOTAL_TIMEOUT_MS;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const deadline = nowImpl() + timeout;
  for (;;) {
    if (nowImpl() > deadline) {
      throw new Error(`3D 生成超时（${Math.round(timeout / 60000)} 分钟），请到服务商后台确认任务状态后重试`);
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}/v2/text-to-3d/${encodeURIComponent(taskId)}`, {
        headers: {Authorization: `Bearer ${opts.apiKey}`},
      });
    } catch (err) {
      throw new Error(`查询 3D 生成进度失败（网络错误）：${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(meshyHttpErrorText(res.status, text));
    }
    const json = await res.json().catch(() => null) as TaskQueryResponse | null;
    if (!json) throw new Error('查询 3D 生成进度失败：服务返回非 JSON');
    const status = normalizeMeshyStatus(json.status);
    const progress = clampProgress(json.progress);
    onProgress?.(status, progress);
    if (status === 'SUCCEEDED') {
      const glb = typeof json.model_urls?.glb === 'string' ? json.model_urls.glb : '';
      if (!glb) throw new Error('3D 生成成功但服务未返回 glb 下载地址（仅支持未压缩 glb 链路）');
      return glb;
    }
    if (status === 'FAILED') {
      throw new Error(describeMeshyTaskError(json.task_error));
    }
    await sleepImpl(interval);
  }
};
