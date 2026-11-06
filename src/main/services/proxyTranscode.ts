/**
 * 代理转码服务（主进程，真实电影机工作流）
 *
 * mxf/超大/4K 素材导入即后台生成 960 宽 H.264 代理：CPU 队列串行（veryfast，
 * 不占 GPU——8GB 机器显存留给渲染线），Log 素材同时烧入技术转换 LUT 恢复正常色。
 * 抽帧/预览/缩略图统一经 resolveProxyForRead 读代理（时间轴等价）；
 * 渲染回源（全分辨率），Log 源由 renderer.ts 渲染前做带 LUT 的一次性转码。
 *
 * 本模块 electron-free（路径/事件由构造参数注入，单测/脚本可直接实例化）：
 * - 代理缓存目录 userData/proxies/（可再生，工程不打包代理）；
 * - 缓存命中 = proxyCacheKey（内容指纹+曲线+参数版本）同名文件存在；
 * - LUT 烧入需要 lut3d 滤镜（Remotion 精简 ffmpeg 没有）——自动探测完整版
 *   ffmpeg（PIANYU_FFMPEG_DIR / 系统 PATH），不可用时降级为无 LUT 代理并回告。
 */

import execa from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {RenderInternals} from '@remotion/renderer';
import {
  type ColorCurveId,
  PROXY_WIDTH,
  PROXY_VERSION,
  colorCurveMeta,
  shouldMakeProxy,
} from '../../shared/proxy-media.ts';

/**
 * 代理缓存 key：源内容指纹（大小+mtime）+ 曲线 + 参数版本。
 * 故意不含路径——consolidate_project 把素材拷进工程目录后内容不变仍命中。
 * （放主进程侧：shared/proxy-media 要进渲染端 bundle，不能依赖 node:crypto）
 */
export const proxyCacheKey = (sourcePath: string, stats: Stats, colorCurve?: string): string => {
  void sourcePath;
  const raw = `v${PROXY_VERSION}|${Math.round(stats.size)}|${Math.round(stats.mtimeMs)}|${colorCurve || 'none'}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 12);
};

export type ProxyJobStatus = 'queued' | 'transcoding' | 'ready' | 'failed';

export interface ProxyJobInfo {
  sourcePath: string;
  status: ProxyJobStatus;
  /** ready 时的代理文件绝对路径 */
  proxyPath?: string;
  /** 0-100（transcoding 时的最新进度） */
  percent?: number;
  /** 曲线（LUT 版代理） */
  colorCurve?: ColorCurveId;
  error?: string;
  note?: string;
}

export interface ProxyEvent {
  sourcePath: string;
  status: ProxyJobStatus;
  proxyPath?: string;
  percent?: number;
  error?: string;
}

export interface ProxyTranscodeOptions {
  /** 代理缓存目录（生产 = userData/proxies；测试/脚本注入临时目录） */
  cacheDir: string;
  /** 技术转换 LUT 目录（生产 = resources/luts） */
  lutDir: string;
  /** 事件推送（ipc 层转发渲染进程；不传则静默） */
  onEvent?: (e: ProxyEvent) => void;
}

/** 完整版 ffmpeg 探测结果（进程内缓存一次） */
let fullFfmpegCache: string | null | undefined;
/**
 * 找支持 lut3d 滤镜的完整版 ffmpeg：
 * ①PIANYU_FFMPEG_DIR（渲染硬件编码同款覆盖机制）②系统 PATH ffmpeg。
 * Remotion 精简 ffmpeg 不含 lut3d（实测），故 LUT 链路必须完整版。
 */
export const findFullFfmpeg = (): string | null => {
  if (fullFfmpegCache !== undefined) return fullFfmpegCache;
  fullFfmpegCache = null;
  const candidates: string[] = [];
  const dir = process.env.PIANYU_FFMPEG_DIR?.trim();
  if (dir) candidates.push(path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  candidates.push('ffmpeg'); // 系统 PATH（winget/choco 安装的完整版）
  for (const candidate of candidates) {
    try {
      const res = execa.sync(candidate, ['-hide_banner', '-filters'], {encoding: 'utf8', timeout: 10_000});
      if (/\blut3d\b/.test(res.stdout)) {
        fullFfmpegCache = candidate;
        break;
      }
    } catch {
      // 该候选不可用/无 lut3d，试下一个
    }
  }
  return fullFfmpegCache;
};

/** 供测试重置探测缓存 */
export const resetFullFfmpegCache = (): void => { fullFfmpegCache = undefined; };

/** 精简版 ffmpeg（无 LUT 代理转码用；与 frameExtract/audio.ts 同源） */
const slimFfmpegPath = (): string =>
  RenderInternals.getExecutablePath({type: 'ffmpeg', indent: false, logLevel: 'error', binariesDirectory: null});

export class ProxyTranscodeService {
  private readonly cacheDir: string;
  private readonly lutDir: string;
  private readonly onEvent?: (e: ProxyEvent) => void;
  /** job 表（sourcePath → job）；ready 的 job 也保留（供状态查询），进程内生命周期 */
  private readonly jobs = new Map<string, ProxyJobInfo>();
  private queueRunning = false;

  constructor(opts: ProxyTranscodeOptions) {
    this.cacheDir = opts.cacheDir;
    this.lutDir = opts.lutDir;
    this.onEvent = opts.onEvent;
    try { fs.mkdirSync(this.cacheDir, {recursive: true}); } catch { /* 磁盘不可用时转码会失败并回告 */ }
  }

  /** 所有 job 摘要（get_app_status / 面板轮询用） */
  listJobs(): ProxyJobInfo[] {
    return Array.from(this.jobs.values());
  }

  /** 探测素材是否触发代理（shared 规则 + 实际文件 stat） */
  probeTrigger(filePath: string, width: number, height: number): boolean {
    try {
      const st = fs.statSync(filePath);
      return shouldMakeProxy({filePath, sizeBytes: st.size, width, height});
    } catch {
      return false;
    }
  }

  private proxyPathFor(sourcePath: string, colorCurve?: ColorCurveId): string {
    const st = fs.statSync(sourcePath);
    const key = proxyCacheKey(sourcePath, st, colorCurve);
    const base = path.basename(sourcePath, path.extname(sourcePath)) || 'proxy';
    // key 在前：目录清理按 key 前缀扫（换曲线/升级参数自动失配重转）
    return path.join(this.cacheDir, `${key}-${base.slice(0, 40)}.mp4`);
  }

  /**
   * 请求代理：缓存/在途 job 命中立返，否则入队后台转码。
   * 立即返回当前状态（不等转码完成——导入链路保持同步语义）。
   */
  async prepare(sourcePath: string, colorCurve?: ColorCurveId): Promise<ProxyJobInfo> {
    const existing = this.jobs.get(sourcePath);
    // 曲线变化（用户改 colorspace）→ 旧 job 失效重排队
    if (existing && (existing.status === 'queued' || existing.status === 'transcoding') && existing.colorCurve === colorCurve) {
      return existing;
    }
    let proxyPath: string;
    try {
      proxyPath = this.proxyPathFor(sourcePath, colorCurve);
    } catch (err) {
      const job: ProxyJobInfo = {sourcePath, status: 'failed', colorCurve, error: `源文件不可读：${(err as Error).message}`};
      this.jobs.set(sourcePath, job);
      return job;
    }
    const job: ProxyJobInfo = fs.existsSync(proxyPath)
      ? {sourcePath, status: 'ready', proxyPath, colorCurve}
      : {sourcePath, status: 'queued', colorCurve};
    this.jobs.set(sourcePath, job);
    if (job.status === 'queued') this.drain();
    else this.emit({...job});
    return job;
  }

  /**
   * 读帧前的代理解析：素材有 ready 代理 → 返回代理路径（时间轴等价：代理只缩
   * 分辨率不改时间/帧率）；缓存丢失自动重入队自愈；无代理返回原路径。
   */
  resolveForRead(filePath: string): string {
    const job = this.jobs.get(filePath);
    if (job?.status === 'ready' && job.proxyPath && fs.existsSync(job.proxyPath)) {
      return job.proxyPath;
    }
    if (job && (job.status === 'ready' || job.status === 'failed') && !fs.existsSync(job.proxyPath ?? '')) {
      // 代理文件被清理：重排队（resolveForRead 是同步的，只触发不等待）
      this.jobs.delete(filePath);
      void this.prepare(filePath, job.colorCurve).catch(() => {});
    }
    return filePath;
  }

  private emit(e: ProxyEvent): void {
    this.onEvent?.(e);
  }

  private update(sourcePath: string, patch: Partial<ProxyJobInfo>): ProxyJobInfo {
    const job = {...this.jobs.get(sourcePath)!, ...patch};
    this.jobs.set(sourcePath, job);
    this.emit({sourcePath, status: job.status, proxyPath: job.proxyPath, percent: job.percent, error: job.error});
    return job;
  }

  /** 串行队列（CPU veryfast 一条已吃满核；并行只抢渲染线资源） */
  private async drain(): Promise<void> {
    if (this.queueRunning) return;
    this.queueRunning = true;
    try {
      for (;;) {
        const next = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
        if (!next) break;
        await this.transcode(next);
      }
    } finally {
      this.queueRunning = false;
    }
  }

  private async transcode(job: ProxyJobInfo): Promise<void> {
    const {sourcePath, colorCurve} = job;
    this.update(sourcePath, {status: 'transcoding', percent: 0});
    try {
      const proxyPath = this.proxyPathFor(sourcePath, colorCurve);
      // LUT 链路需要完整 ffmpeg 的 lut3d；不可用降级为无 LUT 代理（灰片仍可编辑，回告提示）
      let vf = `scale=${PROXY_WIDTH}:-2`;
      let note: string | undefined;
      if (colorCurve) {
        const full = findFullFfmpeg();
        const lutFile = path.join(this.lutDir, colorCurveMeta(colorCurve).lutFile);
        if (full && fs.existsSync(lutFile)) {
          vf = `lut3d='${lutFile.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}',scale=${PROXY_WIDTH}:-2`;
        } else {
          note = full ? `LUT 文件缺失（${lutFile}），代理未做 Log 恢复` : '未找到支持 lut3d 的完整版 ffmpeg（可设 PIANYU_FFMPEG_DIR 或安装系统 ffmpeg），代理未做 Log 恢复';
        }
      }
      const ffmpeg = colorCurve && vf.includes('lut3d') ? findFullFfmpeg()! : slimFfmpegPath();
      // -progress pipe:1 拿 out_time_ms 解析百分比（总时长用 ffprobe 一次）
      const totalSec = await this.probeDurationSec(sourcePath);
      const args = [
        '-y', '-i', sourcePath,
        '-vf', vf,
        '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '128k',
        '-progress', 'pipe:1', '-nostats',
        proxyPath + '.part.mp4',
      ];
      const runWithProgress = async (bin: string): Promise<void> => {
        const child = execa(bin, args, {encoding: 'utf8'});
        let lastPercent = 0;
        child.stdout?.on('data', (chunk: Buffer) => {
          const m = /out_time_ms=(\d+)/g;
          const text = chunk.toString();
          let match: RegExpExecArray | null;
          while ((match = m.exec(text)) !== null) {
            const sec = Number(match[1]) / 1_000_000;
            if (totalSec > 0) {
              lastPercent = Math.max(lastPercent, Math.min(99, Math.round((sec / totalSec) * 100)));
            }
          }
          if (lastPercent > 0) this.update(sourcePath, {percent: lastPercent});
        });
        await child;
      };
      try {
        await runWithProgress(ffmpeg);
      } catch (err) {
        // 精简 ffmpeg 缺 mpeg2video/mxf 等解码器（电影机容器常见）：换完整版重试一次
        if (ffmpeg === slimFfmpegPath() && findFullFfmpeg()) {
          this.emit({sourcePath, status: 'transcoding', percent: 0});
          await runWithProgress(findFullFfmpeg()!);
          void err;
        } else {
          throw err;
        }
      }
      fs.renameSync(proxyPath + '.part.mp4', proxyPath);
      this.update(sourcePath, {status: 'ready', proxyPath, percent: 100, note});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.update(sourcePath, {status: 'failed', error: `代理转码失败：${message.slice(0, 300)}`});
    }
  }

  private async probeDurationSec(filePath: string): Promise<number> {
    try {
      const ffprobe = RenderInternals.getExecutablePath({type: 'ffprobe', indent: false, logLevel: 'error', binariesDirectory: null});
      const {stdout} = await execa(ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
      ]);
      const d = parseFloat(stdout.trim());
      return Number.isFinite(d) && d > 0 ? d : 0;
    } catch {
      return 0;
    }
  }
}
