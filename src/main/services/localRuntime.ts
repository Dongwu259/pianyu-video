/**
 * 片语本地推理运行时（llama.cpp llama-server）生命周期管理
 *
 * 2026-10-06 换代：Ollama → llama.cpp。原因与分发形态见 shared/local-model.ts 头注。
 *
 * - 运行时：官方发布件裁剪版（只留 llama-server + 依赖 DLL），下载后解压到
 *   userData/runtime/llama-server/，llama-server.exe 单进程即服务，无需安装器。
 * - 权重：userData/models/pianyu-2b/（与官网分发同源；llama-server -m/--mmproj 直读）。
 * - 服务只绑 127.0.0.1（loopback 与 Ollama 同安全边界）；应用退出即回收子进程。
 * - 参数沿用 2B 量化实验的实测最优组合：f16 权重 + KV cache q8_0 + FlashAttention
 *   （8GB 卡实测占用 ~7.3GB、较 f16+fp16 KV 提速 ~49%），上下文 40960，
 *   --jinja 打开 OpenAI tools 支持（编辑工作流的工具调用依赖它）。
 */

import {spawn, type ChildProcess} from 'child_process';
import execa from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import {LEGACY_MODEL_ID, LOCAL_MODEL_CTX, LOCAL_MODEL_NAME, LOCAL_MODEL_PORT_BASE} from '../../shared/local-model.ts';

export const weightsDirOf = (userDataDir: string): string => path.join(userDataDir, 'models', 'pianyu-2b');
export const runtimeDirOf = (userDataDir: string): string => path.join(userDataDir, 'runtime', 'llama-server');
export const resolveRuntimeExe = (userDataDir: string): string => path.join(runtimeDirOf(userDataDir), 'llama-server.exe');

export interface RuntimeStatus {
  /** llama-server.exe 已落盘 */
  installed: boolean;
  /** 引擎版本（llama-server --version 首段，如 b11429；读不到为 null） */
  version: string | null;
  /** 服务健康 */
  running: boolean;
  /** 服务端口（running 时有效） */
  port: number | null;
}

let proc: ChildProcess | null = null;
let activePort = 0;

/** GET http://127.0.0.1:port/health 的状态码（连接拒绝/超时 = null） */
const probeHealth = (port: number, timeoutMs = 1200): Promise<number | null> =>
  new Promise((resolve) => {
    const req = fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(timeoutMs)});
    req.then((r) => resolve(r.status)).catch(() => resolve(null));
  });

/** 复用判定：已有健康服务且 /v1/models 报出我们的别名（可能是上一个实例或用户手动起的） */
const isOurServer = async (port: number): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {signal: AbortSignal.timeout(1500)});
    const data = (await r.json()) as {data?: {id?: string}[]};
    return (data?.data ?? []).some((m) => m.id === LOCAL_MODEL_NAME);
  } catch {
    return false;
  }
};

/** 启动 llama-server 并等健康；成功返回端口。已有健康实例（含遗留进程）直接复用。 */
export const ensureRuntimeStarted = async (userDataDir: string): Promise<number> => {
  // ① 已由本进程拉起且健康
  if (proc && activePort && (await probeHealth(activePort)) === 200) return activePort;
  // ② 端口段扫描：复用健康实例 / 跳过被占端口
  for (let port = LOCAL_MODEL_PORT_BASE; port < LOCAL_MODEL_PORT_BASE + 10; port++) {
    const st = await probeHealth(port);
    if (st === 200) {
      if (await isOurServer(port)) {
        activePort = port;
        return port;
      }
      continue; // 别的服务占着，看下一个
    }
    // 连接拒绝 = 空闲，用它
    activePort = port;
    break;
  }
  const exe = resolveRuntimeExe(userDataDir);
  if (!fs.existsSync(exe)) throw new Error('推理引擎未下载（llama-server.exe 不存在）');
  const dir = weightsDirOf(userDataDir);
  const modelGguf = path.join(dir, 'pianyu-2b-v6b-f16.gguf');
  const mmprojGguf = path.join(dir, 'pianyu-2b-mmproj-f16.gguf');
  if (!fs.existsSync(modelGguf) || !fs.existsSync(mmprojGguf)) throw new Error('模型权重未下载完整');

  // stderr 环形缓冲：异常退出时给弹窗/日志留证据
  const errTail: string[] = [];
  const child = spawn(exe, [
    '-m', modelGguf,
    '--mmproj', mmprojGguf,
    '--alias', LOCAL_MODEL_NAME,
    '--host', '127.0.0.1',
    '--port', String(activePort || LOCAL_MODEL_PORT_BASE),
    '-c', String(LOCAL_MODEL_CTX),
    '-ngl', '999',
    '-fa', 'on',
    '--cache-type-k', 'q8_0',
    '--cache-type-v', 'q8_0',
    '--jinja',
  ], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  proc = child;
  child.stderr?.on('data', (d: Buffer) => {
    errTail.push(d.toString('utf8'));
    if (errTail.length > 40) errTail.shift();
  });
  child.on('exit', (code) => {
    if (proc === child) {
      proc = null;
      console.warn(`[LocalRuntime] llama-server 退出（code=${code}）`, errTail.slice(-8).join('').slice(-800));
    }
  });

  // 等健康（f16 4.3GB 权重首载冷盘可到数十秒；2 分钟兜底）
  const port = activePort || LOCAL_MODEL_PORT_BASE;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc !== child) throw new Error(`推理引擎启动失败：${errTail.slice(-6).join('').slice(-400) || '进程提前退出'}`);
    if ((await probeHealth(port, 800)) === 200) return port;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('推理引擎启动超时（120 秒未就绪）');
};

/** 应用退出回收子进程（before-quit 调；遗留进程由下次启动的端口扫描复用接管） */
export const shutdownRuntime = (): void => {
  if (proc) {
    try {proc.kill();} catch {}
    proc = null;
  }
};

/** 状态查询（弹窗检测用）：exe 存在性 + 版本 + 服务健康 */
export const getRuntimeStatus = async (userDataDir: string): Promise<RuntimeStatus> => {
  const exe = resolveRuntimeExe(userDataDir);
  const installed = fs.existsSync(exe);
  let version: string | null = null;
  if (installed) {
    try {
      const {stdout} = await execa(exe, ['--version'], {encoding: 'utf8', timeout: 8000});
      version = /version:\s*(\S+)/.exec(stdout)?.[1] ?? /(\bb\d+\b)/.exec(stdout)?.[1] ?? stdout.split(/\s+/)[0] ?? null;
    } catch {
      // 版本读失败不影响判定
    }
  }
  let running = false;
  let port: number | null = null;
  for (let p = LOCAL_MODEL_PORT_BASE; p < LOCAL_MODEL_PORT_BASE + 10; p++) {
    if ((await probeHealth(p)) === 200 && (await isOurServer(p))) {
      running = true;
      port = p;
      break;
    }
  }
  return {installed, version, running, port};
};

/**
 * AI 设置自动接线：本地服务就绪后把「设置 → AI 助手」指向它（用户零手动配置）。
 * 只在「当前就是本地模型配置（新名/旧名/旧 Ollama 端点）或从未配置」时改写——
 * 用户配了云端/自定义端点绝不碰。首次同时补一个本地占位 Key（llama-server 不校验，
 * 但 llm.ts 的「未配置 Key」防线要求非空）。
 * 返回是否发生了改写（供日志）。
 */
export const autoConfigureAiSettings = (port: number, settings: {llmBaseUrl?: string; llmModel?: string}): {llmBaseUrl: string; llmModel: string} | null => {
  const base = (settings.llmBaseUrl || '').trim();
  const model = (settings.llmModel || '').trim();
  const wasLocal =
    model === LOCAL_MODEL_NAME ||
    model === LEGACY_MODEL_ID ||
    /\/\/(127\.0\.0\.1|localhost):(11434|1143[5-9])/.test(base);
  if (base && !wasLocal) return null;
  if (base === `http://127.0.0.1:${port}/v1` && model === LOCAL_MODEL_NAME) return null;
  return {llmBaseUrl: `http://127.0.0.1:${port}/v1`, llmModel: LOCAL_MODEL_NAME};
};
