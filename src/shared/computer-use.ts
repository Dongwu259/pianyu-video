/**
 * Computer Use（内置电脑操作）共享契约。
 *
 * 架构：主进程托管一个本地 Python sidecar 服务（compute-use 脚手架，FastAPI，仅绑 127.0.0.1，
 * Bearer token 鉴权），AI 助手的 computer_* 工具组经 IPC 调用它操控鼠标键盘。
 * 本文件不 import 任何运行时依赖，主进程 / preload / 渲染端 / 单测都可直接引用。
 *
 * sidecar HTTP 契约（见 d:/compute_use/src/compute_use/server/api.py）：
 * - GET  /health            → {status:"ok"}（无需鉴权，就绪探针）
 * - POST /tasks             {task, max_steps?, film_mode?, dry_run?} → 202 {task_id}（后台执行）
 * - GET  /tasks/{tid}       → {status:"running"|"done"|"error", success, result, task}
 * - POST /tasks/{tid}/stop  → {stopping: bool}（协作式停止）
 * - POST /replay            {script_path, verify?, film_mode?} → 202 {task_id}
 * 鉴权：COMPUTE_USE_TOKEN 非空时除 /health 外一律要求 Authorization: Bearer <token>，否则 401。
 */

/** sidecar 缺省监听端口（被占用时自动递增重试，最多 +COMPUTE_USE_MAX_PORT_RETRIES） */
export const COMPUTE_USE_DEFAULT_PORT = 8765;
/** 端口占用时的递增重试次数上限（与 MCP 服务同一口径） */
export const COMPUTE_USE_MAX_PORT_RETRIES = 20;
/** sidecar 启动后就绪轮询总超时（毫秒）：GET /health 直到 {status:"ok"} */
export const COMPUTE_USE_HEALTH_TIMEOUT_MS = 30_000;
/** 就绪轮询间隔（毫秒） */
export const COMPUTE_USE_HEALTH_POLL_MS = 300;

/** IPC 频道名（preload / main / renderer 三端共用，避免散写字符串） */
export const COMPUTER_USE_CHANNELS = {
  /** 渲染 → 主（invoke）：发起 GUI 任务（入参 ComputerRunTaskRequest，返回 ComputerTaskSubmitResult） */
  RUN_TASK: 'computerUse:runTask',
  /** 渲染 → 主（invoke）：查询任务状态（入参 taskId string，返回 ComputerTaskStatus） */
  TASK_STATUS: 'computerUse:taskStatus',
  /** 渲染 → 主（invoke）：协作式停止任务（入参 taskId string，返回 {stopping}） */
  STOP_TASK: 'computerUse:stopTask',
  /** 渲染 → 主（invoke）：确定性回放动作脚本（入参 ComputerPlayScriptRequest，返回 ComputerTaskSubmitResult） */
  PLAY_SCRIPT: 'computerUse:playScript',
  /** 渲染 → 主（invoke）：查询 sidecar 引擎状态（返回 ComputeUseSidecarStatus） */
  GET_SIDECAR_STATUS: 'computerUse:getSidecarStatus',
} as const;

/** 失败分类（services/computerUse.ts 的结果码；IPC 层折进中文错误文案） */
export type ComputeUseErrorCode =
  | 'not_installed'   // sidecar 不可用（未打包 exe 且无 dev 环境）
  | 'not_configured'  // AI 助手大脑未配置（baseUrl/model）或当前模型不支持看图
  | 'spawn_failed'    // 进程拉起失败
  | 'start_timeout'   // health 轮询超时
  | 'http_error'      // sidecar HTTP 层错误（含 401/404/非 2xx）
  | 'not_found';      // taskId 不存在

/** 服务层统一返回：成功带数据，失败带错误码 + 中文消息（IPC 层转为抛中文 Error） */
export type ComputeUseResult<T> = {ok: true; data: T} | {ok: false; code: ComputeUseErrorCode; message: string};

/** computer_run_task 入参（对应 sidecar POST /tasks 的 snake_case 体） */
export interface ComputerRunTaskRequest {
  /** 任务自然语言描述（必填） */
  task: string;
  /** 最大步数（防失控，缺省 30） */
  maxSteps?: number;
  /** 拍片模式：拟人贝塞尔鼠标轨迹（宣传片素材拍摄用） */
  filmMode?: boolean;
  /** 干跑：只决策不执行（调试用） */
  dryRun?: boolean;
}

/** computer_play_script 入参（对应 sidecar POST /replay 的 snake_case 体） */
export interface ComputerPlayScriptRequest {
  /** 动作脚本文件绝对路径（script.jsonl） */
  scriptPath: string;
  /** 逐动作画面校验（缺省 true） */
  verify?: boolean;
  /** 拍片模式：拟人贝塞尔鼠标轨迹 */
  filmMode?: boolean;
}

/** 发起类调用的返回（POST /tasks、POST /replay 共用） */
export interface ComputerTaskSubmitResult {
  taskId: string;
  /** sidecar 实际监听端口（排查用） */
  port: number;
}

/** 任务状态查询返回（GET /tasks/{tid} 的 camelCase 映射） */
export interface ComputerTaskStatus {
  taskId: string;
  status: 'running' | 'done' | 'error';
  /** running 中为 null；done/error 后为布尔 */
  success: boolean | null;
  /** 任务结果（done 时为 agent 结果对象，error 时为错误描述） */
  result: unknown;
  /** 任务描述回显 */
  task?: string;
}

/** 协作式停止返回（POST /tasks/{tid}/stop） */
export interface ComputerTaskStopResult {
  stopping: boolean;
}

/** sidecar 引擎状态（getSidecarStatus；token 不出主进程，不在这里回传） */
export interface ComputeUseSidecarStatus {
  /** stopped=未启动（懒启动，首次工具调用才拉起）；not_installed=找不到 sidecar */
  status: 'running' | 'starting' | 'stopped' | 'not_installed';
  /** 实际监听端口（未运行为 0；可能被自动递增，不一定等于缺省端口） */
  port: number;
  /** 完整接入地址（未运行为空串） */
  url: string;
  /** sidecar 进程 pid（未运行为 null） */
  pid: number | null;
  /** 补充说明（not_installed 时为安装指引） */
  detail?: string;
}

// ====== 工具参数校验（纯函数，渲染端 executor 用，可单测）======

export interface ComputerRunTaskArgs {
  task: string;
  maxSteps: number;
  filmMode: boolean;
}

/** computer_run_task 参数：task 必填非空（≤500 字截断）；maxSteps 钳 1-200 缺省 30；filmMode 缺省 false */
export const validateComputerRunTaskArgs = (
  raw: unknown,
): {ok: true; args: ComputerRunTaskArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.task !== 'string' || !a.task.trim()) {
    return {ok: false, errors: ['task 必须是非空字符串（要让电脑做什么的自然语言描述）']};
  }
  let maxSteps = 30;
  if (a.maxSteps !== undefined && a.maxSteps !== null) {
    if (typeof a.maxSteps !== 'number' || !Number.isFinite(a.maxSteps)) {
      return {ok: false, errors: ['maxSteps 必须是数字（1-200）']};
    }
    maxSteps = Math.max(1, Math.min(200, Math.round(a.maxSteps)));
  }
  return {ok: true, args: {task: a.task.trim().slice(0, 500), maxSteps, filmMode: a.filmMode === true}};
};

/** computer_status / computer_stop 共用的 taskId 校验 */
export const validateComputerTaskIdArg = (
  raw: unknown,
): {ok: true; taskId: string} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.taskId !== 'string' || !a.taskId.trim()) {
    return {ok: false, errors: ['taskId 必须是非空字符串（computer_run_task / computer_play_script 返回的 taskId）']};
  }
  return {ok: true, taskId: a.taskId.trim()};
};

export interface ComputerPlayScriptArgs {
  scriptPath: string;
  verify: boolean;
  filmMode: boolean;
}

/** computer_play_script 参数：scriptPath 必填；verify 缺省 true；filmMode 缺省 false */
export const validateComputerPlayScriptArgs = (
  raw: unknown,
): {ok: true; args: ComputerPlayScriptArgs} | {ok: false; errors: string[]} => {
  const a = (raw || {}) as Record<string, unknown>;
  if (typeof a.scriptPath !== 'string' || !a.scriptPath.trim()) {
    return {ok: false, errors: ['scriptPath 必须是动作脚本文件的绝对路径（script.jsonl）']};
  }
  return {ok: true, args: {
    scriptPath: a.scriptPath.trim(),
    verify: a.verify !== false,
    filmMode: a.filmMode === true,
  }};
};
