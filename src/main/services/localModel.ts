/**
 * 片语本地模型（pianyu-v1-2b 端侧）主进程服务
 *
 * 1. 电脑状态检测（首次激活弹窗的「检查用户电脑状态」）：
 *    - 显卡/显存：nvidia-smi 优先（精确不溢出）→ 注册表 qwMemorySize → CIM 兜底；多卡取最大
 *    - 推理引擎：llama-server.exe 是否已下载（userData/runtime/llama-server/）+ 服务健康
 *    - 权重：两个 gguf 是否就位（按字节数快判，sha256 留给下载校验）
 *    - 磁盘：userData 所在盘剩余空间（fs.statfsSync）
 * 2. 下载队列：权重两件套 + llama.cpp 运行时（裁剪版官方发布件）https 流式下载 +
 *    sha256 校验 + 进度事件；完成后自动解压运行时、拉起 llama-server 并把
 *    「设置 → AI 助手」接线到本地端点——用户全程零终端操作。
 *
 * 付费门禁不在本层（license 是渲染端 store 状态）；本层只提供能力。
 */

import execa from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import type {ClientRequest} from 'node:http';
import {createHash} from 'node:crypto';
import {
  LOCAL_MODEL_ALL_FILES,
  LOCAL_MODEL_BASE_URL,
  LOCAL_MODEL_FILES,
  RUNTIME_FILE,
} from '../../shared/local-model.ts';
import {autoConfigureAiSettings, ensureRuntimeStarted, resolveRuntimeExe, getRuntimeStatus} from './localRuntime';
import {getGlobalSettings, getLlmApiKeyEncrypted, setGlobalSettings} from './store';
import {setLlmApiKey} from './llm';

// ====== 电脑状态检测 ======

export interface GpuInfo {
  name: string;
  vramMb: number;
}

export interface LocalModelEnv {
  gpus: GpuInfo[];
  /** 多卡取最大（门槛判定用） */
  maxVramMb: number;
  /** llama.cpp 运行时已下载（llama-server.exe 存在） */
  runtimeInstalled: boolean;
  /** 引擎版本（如 b11429） */
  runtimeVersion: string | null;
  /** 本地推理服务健康 */
  runtimeRunning: boolean;
  runtimePort: number | null;
  /** 权重两件套就位（字节数匹配） */
  weightsReady: boolean;
  freeDiskBytes: number;
}

/** 显卡显存：nvidia-smi 优先（独显主流且精确不溢出）→ 注册表 qwMemorySize → CIM 兜底 */
const readGpuInfos = async (): Promise<GpuInfo[]> => {
  // ① nvidia-smi：name + memory.total 直出真实显存（实测 RTX 4060 Laptop 8188MiB；
  //    本机注册表读不到该键、CIM uint32 溢出读 4095——所以它排第一）
  try {
    const {stdout} = await execa('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {encoding: 'utf8', timeout: 10_000});
    const gpus = stdout.split(/\r?\n/).map((line) => {
      const m = /^(.+),\s*(\d+)\s*$/.exec(line.trim());
      return m ? {name: m[1].trim(), vramMb: Number(m[2])} : null;
    }).filter((g): g is GpuInfo => g !== null && g.vramMb > 0);
    if (gpus.length > 0) return gpus.sort((a, b) => b.vramMb - a.vramMb);
  } catch {
    // 无 NVIDIA 卡/未装驱动 → 下一条路
  }
  // ② 注册表 qwMemorySize（REG_QWORD 不溢出；部分驱动不写该键则空手而归）
  try {
    const gpuClassRoot = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
    const reg = await execa('powershell', ['-NoProfile', '-Command',
      `Get-ItemProperty -Path '${gpuClassRoot}\\*' -ErrorAction SilentlyContinue` +
      ` | Where-Object { $_.PSObject.Properties['HardwareInformation.qwMemorySize'] }` +
      ` | ForEach-Object { '{0},${1}' -f $_.DriverDesc, [long]($_.'HardwareInformation.qwMemorySize'/1MB) }`], {encoding: 'utf8', timeout: 15_000});
    const gpus = reg.stdout.split(/\r?\n/).map((line) => {
      const [name, mb] = line.split(',');
      const vramMb = Number(mb);
      return name && Number.isFinite(vramMb) && vramMb > 0 ? {name: name.trim(), vramMb: Math.round(vramMb)} : null;
    }).filter((g): g is GpuInfo => g !== null);
    if (gpus.length > 0) return gpus.sort((a, b) => b.vramMb - a.vramMb);
  } catch {
    // 权限/精简系统 → CIM 兜底
  }
  // ③ CIM AdapterRAM（uint32：>4GB 卡溢出为 ~4095——宁可低估提醒用户，也不误报满足）
  try {
    const {stdout} = await execa('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,@{n=\'MB\';e={[math]::Round($_.AdapterRAM/1MB)}} | ConvertTo-Json -Compress'], {encoding: 'utf8', timeout: 15_000});
    const parsed = JSON.parse(stdout || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r: {MB?: number}) => typeof r.MB === 'number' && r.MB > 0)
      .map((r: {Name?: string; MB: number}) => ({name: String(r.Name ?? '未知显卡'), vramMb: Math.round(r.MB)}))
      .sort((a: GpuInfo, b: GpuInfo) => b.vramMb - a.vramMb);
  } catch {
    return [];
  }
};

/** 权重两件套是否就位（字节数匹配 = 快判；完整性由下载期 sha256 把关） */
export const isWeightsReady = (userDataDir: string): boolean => {
  const dir = path.join(userDataDir, 'models', 'pianyu-2b');
  return LOCAL_MODEL_FILES.every((f) => {
    try {
      return fs.statSync(path.join(dir, f.name)).size === f.sizeBytes;
    } catch {
      return false;
    }
  });
};

/** 一次性全量检测（弹窗打开时调） */
export const detectLocalModelEnv = async (userDataDir: string): Promise<LocalModelEnv> => {
  const [gpus, runtime, weightsReady] = await Promise.all([
    readGpuInfos(),
    getRuntimeStatus(userDataDir),
    Promise.resolve(isWeightsReady(userDataDir)),
  ]);
  let freeDiskBytes = 0;
  try {
    fs.mkdirSync(userDataDir, {recursive: true});
    const st = fs.statfsSync(userDataDir);
    freeDiskBytes = st.bavail * st.bsize;
  } catch {
    // 读不到磁盘余量按 0（弹窗红灯提示，不阻塞下载按钮——statfs 极少失败）
  }
  return {
    gpus,
    maxVramMb: gpus[0]?.vramMb ?? 0,
    runtimeInstalled: runtime.installed,
    runtimeVersion: runtime.version,
    runtimeRunning: runtime.running,
    runtimePort: runtime.port,
    weightsReady,
    freeDiskBytes,
  };
};

// ====== 下载队列（权重 + llama.cpp 运行时）======

export type LocalModelDownloadStatus = 'idle' | 'downloading' | 'verifying' | 'importing' | 'done' | 'failed' | 'cancelled';

export interface LocalModelDownloadState {
  status: LocalModelDownloadStatus;
  /** 当前文件名 / 阶段名（如「准备推理引擎」「启动本地服务」） */
  currentFile: string | null;
  /** 当前文件已下载字节 */
  currentBytes: number;
  /** 当前文件总字节（Content-Length） */
  currentTotal: number;
  /** 已完成项数 / 总项数（权重×2 + 运行时 + 启动，按需跳过） */
  filesDone: number;
  filesTotal: number;
  /** 错误信息（failed 时） */
  error?: string;
  /** 完成产物：权重目录（done 时） */
  weightsDir?: string;
  /** 本地服务是否已拉起并接线 AI 设置 */
  served?: boolean;
}

export class LocalModelDownloadService {
  private state: LocalModelDownloadState = {status: 'idle', currentFile: null, currentBytes: 0, currentTotal: 0, filesDone: 0, filesTotal: LOCAL_MODEL_ALL_FILES.length + 1};
  private cancelRequested = false;
  private activeRequest: ClientRequest | null = null;
  /** gating token 化的下载地址（主进程 license 服务换取；未取得时退直链） */
  private urls: Record<string, string> | undefined = undefined;

  constructor(
    private readonly weightsDir: string,
    private readonly userDataDir: string,
    private readonly onStateChange: (s: LocalModelDownloadState) => void,
  ) {}

  getState(): LocalModelDownloadState {
    return this.state;
  }

  cancel(): void {
    this.cancelRequested = true;
    this.activeRequest?.destroy();
    if (this.state.status === 'downloading' || this.state.status === 'verifying') {
      this.update({status: 'cancelled'});
    }
  }

  private update(patch: Partial<LocalModelDownloadState>): void {
    this.state = {...this.state, ...patch};
    this.onStateChange(this.state);
  }

  async start(urls?: Record<string, string>): Promise<LocalModelDownloadState> {
    this.urls = urls;
    if (this.state.status === 'downloading' || this.state.status === 'verifying' || this.state.status === 'importing') {
      return this.state;
    }
    this.cancelRequested = false;
    const runtimeExeExists = fs.existsSync(resolveRuntimeExe(this.userDataDir));
    const needRuntime = !runtimeExeExists;
    this.state = {status: 'downloading', currentFile: null, currentBytes: 0, currentTotal: 0, filesDone: 0, filesTotal: LOCAL_MODEL_FILES.length + (needRuntime ? 1 : 0) + 1};
    try {
      fs.mkdirSync(this.weightsDir, {recursive: true});
      // 1) 权重大件（流式下载 + sha256；已完好的文件按校验和秒跳）
      for (const f of LOCAL_MODEL_FILES) {
        if (this.cancelRequested) return this.state;
        await this.downloadOne(f.name, f.sha256, f.sizeBytes, this.urls?.[f.name]);
        this.update({filesDone: this.state.filesDone + 1, currentBytes: 0, currentTotal: 0});
      }
      // 2) llama.cpp 运行时（缺失才下；zip 校验后解压即用，无安装器）
      if (needRuntime) {
        if (this.cancelRequested) return this.state;
        if (!RUNTIME_FILE.sha256) throw new Error('分发清单缺少运行时校验值（打包疏漏），请更新应用');
        await this.downloadOne(RUNTIME_FILE.name, RUNTIME_FILE.sha256, RUNTIME_FILE.sizeBytes, this.urls?.[RUNTIME_FILE.name]);
        this.update({filesDone: this.state.filesDone + 1, currentFile: '准备推理引擎', status: 'importing'});
        const zipPath = path.join(this.weightsDir, RUNTIME_FILE.name);
        const runtimeDir = path.dirname(resolveRuntimeExe(this.userDataDir));
        fs.mkdirSync(runtimeDir, {recursive: true});
        // Expand-Archive 是 Windows 内置能力，不引第三方解压依赖；官方发布件为扁平结构
        await execa('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${runtimeDir}' -Force`], {timeout: 10 * 60_000});
        try {fs.unlinkSync(zipPath);} catch {}
        if (!fs.existsSync(resolveRuntimeExe(this.userDataDir))) {
          throw new Error('运行时解压后未找到 llama-server.exe，请重试下载');
        }
      }
      if (this.cancelRequested) return this.state;
      // 3) 拉起本地服务 + AI 设置接线（失败不判下载失败——文件已完好落盘，可重启应用再试）
      let served = false;
      try {
        this.update({status: 'importing', currentFile: '启动本地服务'});
        const port = await ensureRuntimeStarted(this.userDataDir);
        await this.configureAiSettings(port);
        served = true;
      } catch (err) {
        console.warn('[LocalModel] 本地服务启动/接线失败（权重已落盘）:', err instanceof Error ? err.message : err);
      }
      this.update({status: 'done', weightsDir: this.weightsDir, served, currentFile: null, currentBytes: 0, currentTotal: 0});
      return this.state;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.update({status: this.cancelRequested ? 'cancelled' : 'failed', error: message.slice(0, 300)});
      return this.state;
    }
  }

  /** 「设置 → AI 助手」接线到本地端点（只动本地/空配置，云端配置绝不碰）；补本地占位 Key */
  private async configureAiSettings(port: number): Promise<void> {
    const settings = getGlobalSettings();
    const patch = autoConfigureAiSettings(port, {llmBaseUrl: settings.llmBaseUrl, llmModel: settings.llmModel});
    if (patch) {
      setGlobalSettings({...settings, ...patch});
      console.log(`[LocalModel] AI 设置已接线本地端点 ${patch.llmBaseUrl} / ${patch.llmModel}`);
    }
    if (!getLlmApiKeyEncrypted()) setLlmApiKey('pianyu-local');
  }

  /** https GET 跟随 3xx 重定向（≤5 跳，仅允许 https 目标）。
   *  ModelScope 的 /resolve/ 直链会 302 到 CDN，Node https.get 不自动跟随。
   *  activeRequest 指向最新一跳的请求（取消时 destroy 的是当前在传的那条连接）。 */
  private getWithRedirects(url: string, hops: number, onRes: (res: import('node:http').IncomingMessage) => void, onErr: (e: Error) => void): ClientRequest {
    const req = https.get(url, {headers: {'User-Agent': 'pianyu-client', Accept: '*/*'}}, (res) => {
      // ModelScope LFS CDN 对无 User-Agent 的请求直接 403（node 默认不发 UA，必须显式带）
      const s = res.statusCode ?? 0;
      if (s >= 300 && s < 400 && s !== 304) {
        const loc = res.headers.location;
        res.resume(); // 3xx 无 body，挂起连接尽快释放
        if (!loc || hops >= 5) {
          onErr(new Error(`下载失败：重定向异常（HTTP ${s}${loc ? '' : '，缺 Location'}）`));
          return;
        }
        try {
          const next = new URL(loc, url).toString();
          if (!next.startsWith('https://')) throw new Error('拒绝跟随非 https 重定向');
          this.getWithRedirects(next, hops + 1, onRes, onErr);
        } catch (err) {
          onErr(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      onRes(res);
    });
    req.on('error', onErr);
    this.activeRequest = req;
    return req;
  }

  /** 单文件流式下载（.part 临时名 + sha256 增量；完成后改名）。
   *  幂等跳过先在此做（async），进下载 Promise 前就完成校验读。 */
  private async downloadOne(name: string, sha256: string, expectBytes: number, url?: string): Promise<void> {    const target = path.join(this.weightsDir, name);
    const partPath = target + '.part';
    // 已有同名完好文件（重复下载幂等）：流式算 sha256 快速跳过（f16 权重 3.4GB，
    // 不可 readFileSync 整读进内存）
    if (fs.existsSync(target)) {
      try {
        if (fs.statSync(target).size === expectBytes) {
          const h = createHash('sha256');
          await new Promise<void>((done, failHash) => {
            const rs = fs.createReadStream(target);
            rs.on('data', (c) => h.update(c));
            rs.on('end', () => done());
            rs.on('error', failHash);
          });
          if (h.digest('hex') === sha256) {
            // filesDone 由调用方 start() 统一累加，这里不再自增（否则跳过路径双计出现 5/4 项）
            return;
          }
        }
      } catch {
        // 校验读失败走重下
      }
      try {fs.unlinkSync(target);} catch {}
    }
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const out = fs.createWriteStream(partPath);
      let received = 0;
      let total = expectBytes;
      this.update({currentFile: name, currentBytes: 0, currentTotal: expectBytes, status: 'downloading'});
      const fail = (err: Error) => {
        out.destroy();
        this.activeRequest = null;
        reject(err);
      };
      this.getWithRedirects(url ?? `${LOCAL_MODEL_BASE_URL}${name}`, 0, (res) => {
        if (res.statusCode !== 200) {
          fail(new Error(`下载 ${name} 失败：HTTP ${res.statusCode}`));
          return;
        }
        const len = Number(res.headers['content-length'] ?? 0);
        if (len > 0) total = len;
        this.update({currentTotal: total});
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
          out.write(chunk);
          this.update({currentBytes: received});
        });
        res.on('end', () => {
          out.end(() => {
            if (this.cancelRequested) {
              reject(new Error('已取消'));
              return;
            }
            this.update({status: 'verifying'});
            const digest = hash.digest('hex');
            if (digest !== sha256) {
              try {fs.unlinkSync(partPath);} catch {/* 清理失败不掩盖根因 */}
              reject(new Error(`${name} 校验失败（sha256 不符，文件可能传输损坏），请重试`));
              return;
            }
            fs.renameSync(partPath, target);
            this.update({status: 'downloading'});
            resolve();
          });
        });
        res.on('error', (err) => fail(err));
      }, (err) => fail(err));
    });
  }
}
