/**
 * Computer Use sidecar 管理器（纯 Node 实现，绝不 import electron，可 tsx 单测）。
 *
 * 职责：懒启动（首次工具调用才拉起，不在 app 启动时）→ 端口冲突递增重试 →
 * /health 轮询就绪 → Bearer token + 大脑配置（COMPUTE_USE_* env）注入 → stop/kill。
 * electron 胶水（spawn/fetch/设置读取/token 生成）全部经 ComputeUseDeps 注入，
 * 实现见 main/ipc/computerUse.ts。
 *
 * sidecar HTTP 契约见 shared/computer-use.ts。
 * 路径解析优先级：env PIANYU_COMPUTE_USE_CMD（完整命令覆盖）> resources 目录 exe > dev fallback
 * （compute_use 脚手架的 .venv Python，跑 `python -m compute_use.server.api`）。
 */

import path from 'node:path';
import {
  COMPUTE_USE_DEFAULT_PORT,
  COMPUTE_USE_HEALTH_POLL_MS,
  COMPUTE_USE_HEALTH_TIMEOUT_MS,
  COMPUTE_USE_MAX_PORT_RETRIES,
} from '../../shared/computer-use';
import type {
  ComputerPlayScriptRequest,
  ComputerRunTaskRequest,
  ComputerTaskStatus,
  ComputerTaskStopResult,
  ComputerTaskSubmitResult,
  ComputeUseResult,
  ComputeUseSidecarStatus,
} from '../../shared/computer-use';

/** dev 兜底：compute_use 脚手架的 venv 解释器（与脚手架仓库同机开发用） */
export const COMPUTE_USE_DEV_PYTHON = 'D:\\compute_use\\.venv\\Scripts\\python.exe';

/** 被打包子进程的抽象（child_process.ChildProcess 的最小面；测试里用 fake 实现） */
export interface ComputeUseChild {
  /** 进程 pid（spawn 失败/已退出可能为 undefined） */
  pid: number | undefined;
  /** 已退出时的退出码（未退出为 null）——健康轮询据此区分「端口冲突秒退」与「仍在启动」 */
  readonly exitCode: number | null;
  /** 注册退出回调（spawn 后、健康轮询前注册） */
  onExit: (cb: (code: number | null) => void) => void;
  /** 终止进程（幂等） */
  kill: () => void;
}

export interface ComputeUseSpawnOptions {
  /** 注入的 COMPUTE_USE_* 环境变量（调用方负责与 process.env 合并） */
  env: Record<string, string>;
  cwd?: string;
}

/** 最小 fetch 面（结构化类型，方便测试 mock；生产传全局 fetch 的薄封装） */
export type ComputeUseFetch = (
  url: string,
  init?: {method?: string; headers?: Record<string, string>; body?: string},
) => Promise<{status: number; json: () => Promise<unknown>}>;

export interface ComputeUseDeps {
  spawn: (cmd: string, args: string[], opts: ComputeUseSpawnOptions) => ComputeUseChild;
  fetch: ComputeUseFetch;
  fileExists: (p: string) => boolean;
  /** 完整命令覆盖（PIANYU_COMPUTE_USE_CMD），空串 = 走自动解析 */
  getCommandOverride: () => string;
  /** 打包后的 resources 目录（dev 下可传项目 resources/，无 exe 则落到 dev fallback） */
  getResourcesDir: () => string;
  /** dev 兜底 Python 解释器路径（缺省 COMPUTE_USE_DEV_PYTHON） */
  getDevPythonPath?: () => string;
  /** 大脑配置注入（映射为 COMPUTE_USE_BASE_URL / COMPUTE_USE_MODEL / COMPUTE_USE_API_KEY） */
  getBrainConfig: () => {baseUrl: string; model: string; apiKey: string};
  /** 会话级 Bearer token（首次调用生成，之后复用；明文只在本进程内存与子进程 env） */
  ensureToken: () => string;
  /** 时钟/睡眠注入（单测用假时钟快进 health 超时；缺省真实实现） */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 日志输出（缺省 console.log） */
  log?: (msg: string) => void;
}

/** sidecar 启动命令解析结果 */
export interface ComputeUseCommand {
  cmd: string;
  args: string[];
  cwd?: string;
  /** 来源标记（状态/日志展示用） */
  origin: 'override' | 'resources' | 'dev';
}

/** 命令行切分：支持双引号包裹含空格的路径（PIANYU_COMPUTE_USE_CMD 覆盖解析用） */
export const splitCommandLine = (line: string): string[] => {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2]);
  return out;
};

/**
 * 解析 sidecar 启动命令：env 覆盖 > resources/compute-use/compute-use-server.exe > dev fallback。
 * 全部不可用返回 null（= not_installed 优雅降级，UI 引导安装/配置）。
 */
export const resolveSidecarCommand = (deps: Pick<ComputeUseDeps, 'getCommandOverride' | 'getResourcesDir' | 'fileExists'> & Pick<ComputeUseDeps, 'getDevPythonPath'>): ComputeUseCommand | null => {
  const override = deps.getCommandOverride().trim();
  if (override) {
    const [cmd, ...args] = splitCommandLine(override);
    return cmd ? {cmd, args, origin: 'override'} : null;
  }
  const exe = path.join(deps.getResourcesDir(), 'compute-use', 'compute-use-server.exe');
  if (deps.fileExists(exe)) return {cmd: exe, args: [], origin: 'resources'};
  const py = deps.getDevPythonPath?.() ?? COMPUTE_USE_DEV_PYTHON;
  if (deps.fileExists(py)) {
    // <repo>/.venv/Scripts/python.exe → cwd 取 <repo>（python -m 需要包在 cwd 可导入）
    return {cmd: py, args: ['-m', 'compute_use.server.api'], cwd: path.resolve(path.dirname(py), '..', '..'), origin: 'dev'};
  }
  return null;
};

// ====== 模块级运行状态（单例 sidecar；同 mcpServer 的模块级风格）======

let child: ComputeUseChild | null = null;
/** 实际监听端口（被占用自动递增后的值；未运行为 0） */
let actualPort = 0;
/** 进行中的启动（并发调用共享同一 Promise，避免拉起多个 sidecar） */
let starting: Promise<ComputeUseResult<{port: number}>> | null = null;
/** stopSidecar 置位：中断进行中的启动（应用退出路径；下次 doStart 入口自动清除） */
let stoppingAll = false;

const logOf = (d: ComputeUseDeps) => (msg: string) => (d.log ?? console.log)(`[ComputerUse] ${msg}`);

const sleepOf = (d: ComputeUseDeps) => d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
const nowOf = (d: ComputeUseDeps) => d.now ?? Date.now;

/** 组装注入子进程的 COMPUTE_USE_* 环境变量（大脑配置 + 鉴权 + 端口） */
export const buildSidecarEnv = (deps: Pick<ComputeUseDeps, 'getBrainConfig' | 'ensureToken'>, port: number): Record<string, string> => {
  const brain = deps.getBrainConfig();
  const env: Record<string, string> = {
    COMPUTE_USE_TOKEN: deps.ensureToken(),
    COMPUTE_USE_PORT: String(port),
    COMPUTE_USE_MODEL: brain.model,
  };
  // baseUrl/apiKey 允许为空（本地端点场景 sidecar 自行兜底），为空时不注入而不是注空串
  if (brain.baseUrl) env.COMPUTE_USE_BASE_URL = brain.baseUrl;
  if (brain.apiKey) env.COMPUTE_USE_API_KEY = brain.apiKey;
  return env;
};

/** health 轮询：子进程退出 = 立即失败（端口冲突秒退场景）；超时可注入假时钟快进 */
const waitHealthy = async (d: ComputeUseDeps, port: number, c: ComputeUseChild): Promise<boolean> => {
  const now = nowOf(d);
  const sleep = sleepOf(d);
  const deadline = now() + COMPUTE_USE_HEALTH_TIMEOUT_MS;
  for (;;) {
    if (c.exitCode !== null) return false;
    try {
      const res = await d.fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) {
        const body = (await res.json()) as {status?: string} | null;
        if (body?.status === 'ok') return true;
      }
    } catch {
      // 连接拒绝 = 还没起来，继续等
    }
    if (now() >= deadline) return false;
    await sleep(COMPUTE_USE_HEALTH_POLL_MS);
  }
};

const resetState = (): void => {
  child = null;
  actualPort = 0;
};

/** 实际启动流程（ensureSidecar 的单飞实现） */
const doStart = async (d: ComputeUseDeps): Promise<ComputeUseResult<{port: number}>> => {
  const log = logOf(d);
  stoppingAll = false; // 新一轮启动：清除上一次 stopSidecar 的中止标记
  const command = resolveSidecarCommand(d);
  if (!command) {
    return {
      ok: false,
      code: 'not_installed',
      message: '电脑操作引擎未安装：打包版应内置 compute-use-server.exe（resources/compute-use/），开发机请配置环境变量 PIANYU_COMPUTE_USE_CMD 或准备好 D:\\compute_use 脚手架',
    };
  }
  for (let attempt = 0; attempt <= COMPUTE_USE_MAX_PORT_RETRIES; attempt++) {
    const port = COMPUTE_USE_DEFAULT_PORT + attempt;
    let c: ComputeUseChild;
    try {
      c = d.spawn(command.cmd, command.args, {env: buildSidecarEnv(d, port), ...(command.cwd ? {cwd: command.cwd} : {})});
    } catch (err) {
      return {ok: false, code: 'spawn_failed', message: `电脑操作引擎启动失败：${err instanceof Error ? err.message : String(err)}（命令：${command.cmd}）`};
    }
    child = c;
    // 进程意外退出（启动成功后崩了也算）：重置状态，下次调用重新拉起
    c.onExit((code) => {
      if (child === c) {
        log(`sidecar 进程已退出（code=${code}，端口 ${port}）`);
        resetState();
      }
    });
    log(`sidecar 启动中（${command.origin}）：${command.cmd} ${command.args.join(' ')}，端口 ${port}`);
    const healthy = await waitHealthy(d, port, c);
    // 启动期间被 stopSidecar 杀掉（应用退出）：立即中止，不再换端口重试
    if (stoppingAll) return {ok: false, code: 'spawn_failed', message: '电脑操作引擎启动已被取消'};
    if (healthy) {
      actualPort = port;
      log(`sidecar 已就绪: http://127.0.0.1:${port}（pid=${c.pid ?? '?'}）`);
      return {ok: true, data: {port}};
    }
    if (c.exitCode !== null) {
      // 秒退：大概率端口被占（或大脑配置缺失立刻报错退出）——换端口重试
      log(`端口 ${port} 上的 sidecar 立即退出（code=${c.exitCode}），换端口重试`);
      resetState();
      continue;
    }
    // 进程活着但 health 一直不 ok：僵死，杀掉报超时（换端口无意义，不是端口问题）
    c.kill();
    resetState();
    return {ok: false, code: 'start_timeout', message: `电脑操作引擎就绪超时（${COMPUTE_USE_HEALTH_TIMEOUT_MS / 1000} 秒内 /health 未通过），请查看日志或重启应用重试`};
  }
  return {ok: false, code: 'spawn_failed', message: `端口 ${COMPUTE_USE_DEFAULT_PORT}-${COMPUTE_USE_DEFAULT_PORT + COMPUTE_USE_MAX_PORT_RETRIES} 均不可用，电脑操作引擎启动失败`};
};

/** 懒启动：已运行直接返回；并发调用共享同一次启动 */
export const ensureSidecar = (d: ComputeUseDeps): Promise<ComputeUseResult<{port: number}>> => {
  if (child && child.exitCode === null && actualPort > 0) return Promise.resolve({ok: true, data: {port: actualPort}});
  if (!starting) {
    starting = doStart(d).finally(() => {
      starting = null;
    });
  }
  return starting;
};

/** 停止 sidecar（幂等；app before-quit 钩子调用）。会中断进行中的启动。 */
export const stopSidecar = (): void => {
  stoppingAll = true;
  if (child) {
    const c = child;
    resetState();
    try {
      c.kill();
    } catch {
      // 已退出/句柄失效，忽略
    }
  }
};

/** 当前引擎状态（not_installed 由调用方按 resolveSidecarCommand 结果换算，见 ipc 层 buildStatus） */
export const getSidecarState = (): {status: 'running' | 'starting' | 'stopped'; port: number; url: string; pid: number | null} => ({
  // starting 优先于 child 判活：启动窗口期（已 spawn 未就绪）应报 starting 而非 running（port 还是 0）
  status: starting ? 'starting' : child && child.exitCode === null ? 'running' : 'stopped',
  port: actualPort,
  url: actualPort > 0 ? `http://127.0.0.1:${actualPort}` : '',
  pid: child?.pid ?? null,
});

// ====== sidecar HTTP 客户端（先懒启动，再带 Bearer 调用）======

const request = async <T>(d: ComputeUseDeps, method: 'GET' | 'POST', pathName: string, body?: unknown): Promise<ComputeUseResult<T>> => {
  const started = await ensureSidecar(d);
  if (!started.ok) return started;
  let res: {status: number; json: () => Promise<unknown>};
  try {
    res = await d.fetch(`http://127.0.0.1:${actualPort}${pathName}`, {
      method,
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${d.ensureToken()}`},
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
  } catch (err) {
    // 连接失败 = sidecar 多半已崩，重置状态让下次调用重新拉起
    resetState();
    return {ok: false, code: 'http_error', message: `无法连接电脑操作引擎：${err instanceof Error ? err.message : String(err)}`};
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 401) {
    return {ok: false, code: 'http_error', message: '电脑操作引擎鉴权失败（401），请重启应用后重试'};
  }
  // sidecar 对未知 taskId 返回 200 + {error:"not found"}，换算成 not_found
  if (data && typeof data.error === 'string') {
    return {ok: false, code: 'not_found', message: `电脑任务不存在或已过期（sidecar：${data.error}）`};
  }
  if (res.status < 200 || res.status >= 300) {
    return {ok: false, code: 'http_error', message: `电脑操作引擎返回错误（HTTP ${res.status}）：${JSON.stringify(data)?.slice(0, 200) ?? ''}`};
  }
  return {ok: true, data: data as T};
};

/** 发起 GUI 任务（POST /tasks，202 后台执行） */
export const runTask = async (d: ComputeUseDeps, req: ComputerRunTaskRequest): Promise<ComputeUseResult<ComputerTaskSubmitResult>> => {
  const r = await request<{task_id?: string}>(d, 'POST', '/tasks', {
    task: req.task,
    max_steps: req.maxSteps ?? 30,
    film_mode: req.filmMode === true,
    dry_run: req.dryRun === true,
  });
  if (!r.ok) return r;
  const taskId = r.data?.task_id;
  if (!taskId) return {ok: false, code: 'http_error', message: '电脑操作引擎返回格式异常（缺 task_id）'};
  return {ok: true, data: {taskId, port: actualPort}};
};

/** 查询任务状态（GET /tasks/{tid}） */
export const getTaskStatus = async (d: ComputeUseDeps, taskId: string): Promise<ComputeUseResult<ComputerTaskStatus>> => {
  const r = await request<{status?: string; success?: boolean | null; result?: unknown; task?: string}>(d, 'GET', `/tasks/${encodeURIComponent(taskId)}`);
  if (!r.ok) return r;
  const status = r.data?.status;
  if (status !== 'running' && status !== 'done' && status !== 'error') {
    return {ok: false, code: 'http_error', message: `电脑操作引擎返回格式异常（status=${String(status)}）`};
  }
  return {ok: true, data: {taskId, status, success: r.data.success ?? null, result: r.data.result ?? null, ...(r.data.task ? {task: r.data.task} : {})}};
};

/** 协作式停止任务（POST /tasks/{tid}/stop） */
export const stopTask = async (d: ComputeUseDeps, taskId: string): Promise<ComputeUseResult<ComputerTaskStopResult>> => {
  const r = await request<{stopping?: boolean}>(d, 'POST', `/tasks/${encodeURIComponent(taskId)}/stop`);
  if (!r.ok) return r;
  return {ok: true, data: {stopping: r.data?.stopping === true}};
};

/** 确定性回放动作脚本（POST /replay，202 后台执行） */
export const playScript = async (d: ComputeUseDeps, req: ComputerPlayScriptRequest): Promise<ComputeUseResult<ComputerTaskSubmitResult>> => {
  const r = await request<{task_id?: string}>(d, 'POST', '/replay', {
    script_path: req.scriptPath,
    verify: req.verify !== false,
    film_mode: req.filmMode === true,
  });
  if (!r.ok) return r;
  const taskId = r.data?.task_id;
  if (!taskId) return {ok: false, code: 'http_error', message: '电脑操作引擎返回格式异常（缺 task_id）'};
  return {ok: true, data: {taskId, port: actualPort}};
};

/** 状态查询（含 not_installed 换算；设置页/排障用） */
export const getSidecarStatus = (d: ComputeUseDeps): ComputeUseSidecarStatus => {
  const s = getSidecarState();
  if (s.status !== 'stopped') return {...s};
  if (!resolveSidecarCommand(d)) {
    return {...s, status: 'not_installed', detail: '未找到电脑操作引擎（compute-use-server.exe 或 dev 脚手架）'};
  }
  return s;
};

/** 测试用：重置模块级状态（各用例间隔离） */
export const __resetComputerUseForTest = (): void => {
  stopSidecar();
  starting = null;
  stoppingAll = false;
};
