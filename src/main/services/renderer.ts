/**
 * @remotion/renderer - 视频渲染引擎封装
 *
 * 核心渲染流程：bundle → selectComposition → renderMedia → MP4
 *
 * 注意：bundle 来自 @remotion/bundler
 *       selectComposition 和 renderMedia 来自 @remotion/renderer
 */

import {bundle} from '@remotion/bundler';
import {selectComposition, renderMedia, renderStill, RenderInternals, makeCancelSignal} from '@remotion/renderer';
import type {FfmpegOverrideFn} from '@remotion/renderer';
import {app, nativeImage} from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {fileURLToPath} from 'url';
import execa from 'execa';
import type {RenderJob, RenderEncoderUsed, Segment, CoverConfig} from '../../shared/types';
import {DEFAULT_RENDER_OPTIONS} from '../../shared/types';
import {getOutroFadeFrames} from '../../shared/transition-style';
import {isImageFile, isModelFile} from '../../shared/media';
import {TEMPLATES, isDataDrivenTemplateId, isRawOutputTemplate, isGeneratedTemplateId} from '../../shared/template-registry';
import {computeRenderBlocks, blockCacheKey, concatListContent, type BlockKeyContext, type RenderBlockPlan} from '../../shared/render-blocks';
import {filePathToHttpUrl} from './videoServer';
import {resizeToDataUrl} from './frameExtract';
import {findFullFfmpeg, proxyCacheKey} from './proxyTranscode';
import {colorCurveMeta, COLOR_CURVE_IDS, type ColorCurveId} from '../../shared/proxy-media.ts';
import {trackRender, trackRenderFailure} from './usage';
import {detectEncoders, makeFfmpegOverride, resolveEncoder} from './encoderOverride';
import {planPostProcess, loudnormMeasureArgs, parseLoudnormMeasurement} from './renderPost';
import {readCachedBlock, writeBlockToCache, blockTmpPath, evictRenderCache} from './renderCache';
import {classifyRenderError, renderRetryDelayMs, summarizeRenderError, formatBrowserLogTail, buildProcessDeathError, BROWSER_LOG_RING_CAP} from './render-guard';

export type {RenderJob};

/** 取消函数（同一时刻只有一个渲染任务） */
let currentCancel: (() => void) | null = null;

/** 取消正在进行的渲染（无进行中任务时为空操作）；renderMedia 会以取消错误拒绝 */
export const cancelRender = (): void => {
  currentCancel?.();
};

/**
 * 渲染浏览器日志环形缓冲（onBrowserLog 推入；每任务开始时清空）。
 * 平时静默，进程死亡时随错误打印 = 死亡取证（"渲染静默死亡"变可诊断）。
 * 回调不受 logLevel 门控（consoleAPICalled 订阅恒挂），'error' 级也有取证。
 */
const renderBrowserLog: string[] = [];
const captureBrowserLog = (log: {type: string; text: string}): void => {
  renderBrowserLog.push(`${log.type}: ${log.text.replace(/\s+$/, '')}`);
  if (renderBrowserLog.length > BROWSER_LOG_RING_CAP) renderBrowserLog.splice(0, renderBrowserLog.length - BROWSER_LOG_RING_CAP);
};

/**
 * 渲染浏览器/组合器进程层死亡重试（8GB 低显存机器 OOM/GPU 重置带走进程 = bench
 * 噪声最后一根源）：只对 process-death 分类重试，同一渲染参数换新进程再来——
 * 产物逐帧等价、bench 可比；取消与其他错误（模板/素材问题，重试无意义）原样上抛。
 */
const withProcessDeathRetry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const delay = renderRetryDelayMs(attempt);
      if (classifyRenderError(err) !== 'process-death' || delay === null) {
        if (classifyRenderError(err) === 'process-death') {
          const tail = formatBrowserLogTail(renderBrowserLog);
          console.error(
            `[RenderGuard] ${label} 渲染浏览器/组合器死亡且重试已用尽（${attempt} 次）: ${summarizeRenderError(err)}` +
              (tail ? `\n[RenderGuard] 浏览器日志尾:\n${tail}` : ''),
          );
        }
        throw err;
      }
      attempt++;
      console.error(`[RenderGuard] ${label} 第 ${attempt} 次进程死亡，${delay}ms 后换新进程重试: ${summarizeRenderError(err)}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
};

/** 从渲染任务收集工程用到的模板 id 列表（去重；匿名用量统计用） */
const collectRenderTemplateIds = (job: RenderJob): string[] => {
  const segments = (job.inputProps as {segments?: Array<{templateId?: unknown}>} | undefined)?.segments;
  if (!Array.isArray(segments)) return [];
  const ids = segments.map((s) => s?.templateId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
};

/** 渲染错误是否为用户取消（包未导出 isUserCancelledRender，取消错误文案均含 "got cancelled"） */
export const isRenderCancelledError = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('got cancelled');

/** 帧率（与 Composition 定义一致） */
const FPS = 30;

/**
 * WebGL 3D 模板（three.js / @remotion/three）需要可用的 GL 后端。
 * 默认 angle：有 GPU 的机器走硬件加速；headless 无 GPU 时 Chromium 自动回退 SwiftShader。
 * 无 GPU 的 CI/服务器可设 PIANYU_GL=swangle 强制纯软件渲染（慢但最稳）。
 * 合法值：'angle' | 'swangle' | 'swiftshader' | 'egl' | 'vulkan' | 'angle-egl'。
 */
const chromiumGlOptions = (): {gl: 'angle' | 'swangle' | 'swiftshader' | 'egl' | 'vulkan' | 'angle-egl'} => ({
  gl: (process.env.PIANYU_GL || 'angle') as 'angle' | 'swangle' | 'swiftshader' | 'egl' | 'vulkan' | 'angle-egl',
});

/**
 * 根据片段数据计算需要渲染的帧范围
 * 避免渲染多余的黑帧。
 * 总帧 = Σ 各段内容帧 + 末段淡黑收尾（片段间转场重叠在下一段内容窗口内，不额外占时长，
 * 与 MultiSegmentPromo 的时间模型一致；常量在 shared/transition-style.ts 统一维护）。
 * 引用已删除/未知模板的片段按 0 时长处理（与 MultiSegmentPromo 一致），否则尾部多渲染黑帧。
 */
const calculateFrameRange = (inputProps: Record<string, unknown>): [number, number] | null => {
  const segments = inputProps.segments as Array<{duration?: number; templateId?: string}> | undefined;
  if (!segments || segments.length === 0) return null;

  const customTemplates = (inputProps.customTemplates as Array<{id?: string}> | undefined) ?? [];
  const generatedTemplates = (inputProps.generatedTemplates as Array<{id?: string}> | undefined) ?? [];
  const isRenderable = (templateId?: string): boolean => {
    if (!templateId) return false;
    if (isDataDrivenTemplateId(templateId)) return customTemplates.some((t) => t.id === templateId);
    if (isGeneratedTemplateId(templateId)) return generatedTemplates.some((t) => t.id === templateId);
    return TEMPLATES.some((t) => t.id === templateId);
  };

  let totalContentFrames = 0;
  for (const seg of segments) {
    totalContentFrames += isRenderable(seg.templateId) ? Math.round((seg.duration || 8) * FPS) : 0;
  }
  // 尾部淡黑帧只在末段可渲染时存在（与 MultiSegmentPromo 一致）；
  // 末段为「原样输出」模板（屏幕录制）时豁免——原始录像成片不加强制渐黑结尾
  const lastTemplateId = segments[segments.length - 1]?.templateId;
  const outroFrames = isRenderable(lastTemplateId) && !isRawOutputTemplate(lastTemplateId) ? getOutroFadeFrames(FPS) : 0;
  const endFrame = Math.max(0, totalContentFrames + outroFrames - 1);
  return [0, endFrame];
};

/**
 * 查找 Remotion 入口文件 root.tsx
 * 尝试多个可能的路径（开发/打包环境）
 */
const findEntryPoint = (): string => {
  // 可能的入口路径列表（.tsx 是 Remotion 入口的正确扩展名，因为它包含 JSX）
  const candidates: string[] = [];

  if (__dirname) {
    // 开发环境: electron-vite 将主进程打包为 out/main/index.js（单文件 bundle）
    //   __dirname = <project>/out/main → 往上 2 级 = 项目根
    // 打包后: __dirname = <app>/resources/app/out/main → 同样往上 2 级
    const from2 = path.resolve(__dirname, '../../');
    candidates.push(path.join(from2, 'src', 'remotion', 'root.tsx'));
    candidates.push(path.join(from2, 'src', 'remotion', 'root.ts'));

    // 备选：如果 services/ 子目录被保留在编译输出中
    const from3 = path.resolve(__dirname, '../../../');
    candidates.push(path.join(from3, 'src', 'remotion', 'root.tsx'));
    candidates.push(path.join(from3, 'src', 'remotion', 'root.ts'));
  }

  // 使用 process.cwd() 作为后备（通常就是项目根目录）
  candidates.push(path.resolve(process.cwd(), 'src', 'remotion', 'root.tsx'));
  candidates.push(path.resolve(process.cwd(), 'src', 'remotion', 'root.ts'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[Remotion] entryPoint: ${candidate}`);
      return candidate;
    }
  }

  // 都找不到则返回第一个（让 bundle() 给出明确错误）
  return candidates[0];
};

/**
 * bundle 进程内缓存（key = 入口文件路径，缓存 promise）。
 * bundle() 每次全量打包耗时数秒，整片渲染与 render:still 静帧共用同一份产物即可——
 * 入口不变则产物等价（inputProps 走 selectComposition/renderMedia 传入，不参与打包）。
 * 失败后清空缓存，下次调用重新打包（避免一次失败永久卡死）。
 */
let bundleCache: {entryPoint: string; promise: Promise<string>} | null = null;

// 源码监听：src/remotion（模板/合成）与 src/shared（模板引用的枚举与工具）在应用运行期间可能被
// 修改（AI 生成模板落盘、开发调试）——bundle 产物却按入口路径缓存，旧缓存会把旧模板代码一直用到
// 重启为止。监听这两个目录，变更后丢弃缓存，下一次渲染自动重新打包，免去「改完模板必须重启应用」。
let bundleWatchers: fs.FSWatcher[] = [];
let bundleInvalidateTimer: NodeJS.Timeout | null = null;
const invalidateBundleSoon = (): void => {
  if (bundleInvalidateTimer) clearTimeout(bundleInvalidateTimer);
  bundleInvalidateTimer = setTimeout(() => {
    bundleInvalidateTimer = null;
    if (bundleCache) {
      bundleCache = null;
      console.log('[Remotion] 源码变更，bundle 缓存已失效（下次渲染自动重新打包）');
    }
  }, 500);
};
const watchBundleSources = (entryPoint: string): void => {
  if (bundleWatchers.length > 0) return;
  const remotionDir = path.dirname(entryPoint);
  const sharedDir = path.resolve(remotionDir, '..', 'shared');
  for (const root of [remotionDir, sharedDir]) {
    if (!fs.existsSync(root)) continue;
    try {
      const w = fs.watch(root, {recursive: true}, () => invalidateBundleSoon());
      w.on('error', () => {}); // 目录被删/不可读：静默，保留已建缓存（退化为旧行为）
      bundleWatchers.push(w);
    } catch {
      // 平台不支持 recursive 等：退化为「改模板需重启」的旧行为
    }
  }
};

export const getBundled = (): Promise<string> => {
  const entryPoint = findEntryPoint();
  if (bundleCache && bundleCache.entryPoint === entryPoint) return bundleCache.promise;
  watchBundleSources(entryPoint);
  const promise = bundle({
    entryPoint,
    onProgress: (progress: number) => {
      console.log(`[Remotion] Bundle: ${progress}%`);
    },
  });
  bundleCache = {entryPoint, promise};
  promise.catch(() => {
    if (bundleCache?.promise === promise) bundleCache = null;
  });
  return promise;
};

/**
 * 获取兜底输出目录（软件所在目录下的 output 文件夹）
 */
const getFallbackOutputDir = (): string => {
  // 开发环境: process.cwd() = 项目根目录
  // 打包后: process.resourcesPath = resources 目录，需要上一级
  const baseDir = process.resourcesPath
    ? path.join(process.resourcesPath, '..')
    : process.cwd();
  const outputDir = path.join(baseDir, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, {recursive: true});
  }
  return outputDir;
};

/**
 * 完整版 ffmpeg 目录覆盖（硬件编码的前置条件，见 services/encoderOverride.ts 头注）
 * Remotion 内置的精简 ffmpeg 只编了 libx264（无 h264_nvenc/h264_qsv）。
 * 设置环境变量 PIANYU_FFMPEG_DIR 指向「remotion.exe（从 @remotion/compositor-win32-x64-msvc
 * 复制）+ 完整版 ffmpeg.exe/ffprobe.exe 同目录」后，渲染/转码/编码器探测全部改用该目录；
 * 未设置或目录不全时回退 Remotion 内置二进制（进程内只判定一次，避免重复刷警告）。
 */
let binariesDirCache: string | null | undefined;
const getBinariesDir = (): string | null => {
  if (binariesDirCache !== undefined) return binariesDirCache;
  binariesDirCache = null;
  const dir = process.env.PIANYU_FFMPEG_DIR?.trim();
  if (dir) {
    const required = process.platform === 'win32'
      ? ['remotion.exe', 'ffmpeg.exe', 'ffprobe.exe']
      : ['remotion', 'ffmpeg', 'ffprobe'];
    if (required.every((f) => fs.existsSync(path.join(dir, f)))) {
      console.log(`[Remotion] 使用完整版 ffmpeg 目录: ${dir}`);
      binariesDirCache = dir;
    } else {
      console.warn(`[Remotion] PIANYU_FFMPEG_DIR 缺少必要二进制（${required.join(' / ')}），忽略: ${dir}`);
    }
  }
  return binariesDirCache;
};

/**
 * 获取 FFmpeg 可执行文件路径（默认 Remotion 内置；PIANYU_FFMPEG_DIR 覆盖时取该目录）
 */
const getFfmpegPath = (): string => {
  return RenderInternals.getExecutablePath({
    type: 'ffmpeg',
    indent: false,
    logLevel: 'error',
    binariesDirectory: getBinariesDir(),
  });
};

/**
 * 通过 ffprobe 读取视频编码格式
 */
const getVideoCodec = async (filePath: string): Promise<string> => {
  try {
    const ffprobePath = RenderInternals.getExecutablePath({
      type: 'ffprobe',
      indent: false,
      logLevel: 'error',
      binariesDirectory: getBinariesDir(),
    });
    console.log(`[Transcode] ffprobe路径: ${ffprobePath}`);
    const {stdout} = await execa(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const codec = stdout.trim().toLowerCase();
    console.log(`[Transcode] ffprobe输出: "${codec}"`);
    return codec;
  } catch (err) {
    console.error(`[Transcode] ffprobe失败: ${err}`);
    return 'unknown';
  }
};

/**
 * Chromium 支持的视频编码
 */
const CHROMIUM_SUPPORTED_CODECS = ['h264', 'h265', 'hevc', 'vp8', 'vp9', 'av1'];

/**
 * 判断视频是否需要转码
 * 策略：只要不是标准 MP4(H.264/AAC)，一律转码（最可靠）
 */
const needsTranscoding = (filePath: string, codec: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  // MP4 容器 + h264/hevc + 无特殊编码 → 可以直接播放
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
    if (CHROMIUM_SUPPORTED_CODECS.includes(codec)) return false;
  }
  // 其他所有格式（mkv, avi, flv, wmv, webm）或未知编码 → 转码
  return true;
};

/**
 * 将视频转码为 Chromium 兼容格式（H.264/AAC/MP4）
 * 返回转码后的文件路径
 * @param lutFile 可选 lut3d 滤镜文件（Log→709 技术转换；需完整版 ffmpeg，见 findFullFfmpeg）
 */
const transcodeVideo = async (
  inputPath: string,
  outputPath: string,
  onLog?: (msg: string) => void,
  lutFile?: string,
): Promise<string> => {
  if (lutFile && !findFullFfmpeg()) {
    throw new Error('lut-ffmpeg-missing');
  }
  onLog?.(`[Transcode] 转码: ${path.basename(inputPath)} → H.264/AAC/MP4${lutFile ? ' + Log→709 LUT' : ''}`);

  // LUT 链路必须完整版（精简版无 lut3d 滤镜）；普通转码先精简版，失败自动换完整版重试
  await runTranscode(lutFile ? findFullFfmpeg()! : getFfmpegPath(), outputPath, onLog, inputPath, lutFile);
  onLog?.(`[Transcode] 完成: ${path.basename(outputPath)}`);
  return outputPath;
};

/** 单次转码执行（精简失败自动换完整版 ffmpeg 重试一次——精简版缺 mpeg2video/mxf 等解码器，电影机容器需要完整版） */
const runTranscode = async (
  ffmpegPath: string,
  outputPath: string,
  onLog: ((msg: string) => void) | undefined,
  inputPath: string,
  lutFile?: string,
): Promise<void> => {
  const args = [
    '-i', inputPath,
    ...(lutFile ? ['-vf', `lut3d='${lutFile.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}'`] : []),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
  try {
    await execa(ffmpegPath, args, {encoding: 'utf8'});
  } catch (err) {
    const full = ffmpegPath === getFfmpegPath() ? findFullFfmpeg() : null;
    if (!full) throw err;
    onLog?.(`[Transcode] 精简 ffmpeg 失败（${path.basename(inputPath)} 可能用了精简版没有的解码器），换完整版 ffmpeg 重试`);
    await execa(full, args, {encoding: 'utf8'});
  }
};

/**
 * Log 素材渲染前的恢复版源：全分辨率 + 烧入 Log→709 技术转换 LUT 的一次性转码
 * （离线渲染不在乎这一步耗时）。产物缓存 tmpdir/promo-lut/<内容指纹>.mp4——
 * 同内容同曲线的重复渲染（bench/重渲）不重转。完整版 ffmpeg 不可用时返回 null
 * （按原色渲染并回告，不阻断渲染）。
 */
const lutRestoredSource = async (
  inputPath: string,
  curve: ColorCurveId,
  onLog?: (msg: string) => void,
): Promise<string | null> => {
  const ffmpeg = findFullFfmpeg();
  if (!ffmpeg) {
    onLog?.(`[Transcode] 未找到支持 lut3d 的完整版 ffmpeg，素材 ${path.basename(inputPath)} 的 ${curve} 恢复跳过（按原色渲染；可设 PIANYU_FFMPEG_DIR 或安装系统 ffmpeg）`);
    return null;
  }
  const lutFile = path.join(findLutsDir(), colorCurveMeta(curve).lutFile);
  if (!fs.existsSync(lutFile)) {
    onLog?.(`[Transcode] LUT 文件缺失 ${lutFile}，${curve} 恢复跳过`);
    return null;
  }
  try {
    const st = fs.statSync(inputPath);
    const key = proxyCacheKey(inputPath, st, `render-${curve}`);
    const outDir = path.join(os.tmpdir(), 'promo-lut');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, {recursive: true});
    const outputPath = path.join(outDir, `${key}-${path.basename(inputPath, path.extname(inputPath)).slice(0, 40)}.mp4`);
    if (fs.existsSync(outputPath)) {
      onLog?.(`[Transcode] LUT 恢复缓存命中: ${path.basename(outputPath)}`);
      return outputPath;
    }
    await transcodeVideo(inputPath, outputPath, onLog, lutFile);
    return outputPath;
  } catch (err) {
    onLog?.(`[Transcode] LUT 恢复转码失败（使用原文件）: ${err}`);
    return null;
  }
};

/** 技术转换 LUT 目录（resources/luts；开发/打包两布局，与 sfxLibrary 同模式） */
const findLutsDir = (): string => {
  const candidates = [
    path.join(process.cwd(), 'resources', 'luts'),
    path.join(__dirname, '../../', 'resources', 'luts'),
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
};

/** 工程里存的 colorCurve 字符串安全解析（旧工程/非法值 → undefined，不触发 LUT 链路） */
const colorCurveMetaSafe = (v: unknown): ColorCurveId | undefined =>
  typeof v === 'string' && (COLOR_CURVE_IDS as readonly string[]).includes(v) ? (v as ColorCurveId) : undefined;

/**
 * 检查并转码所有不兼容的视频文件
 * 返回修改后的 inputProps（视频 src 指向转码后的文件）
 */
const ensureVideosPlayable = async (
  inputProps: Record<string, unknown>,
  onLog?: (msg: string) => void
): Promise<Record<string, unknown>> => {
  const segments = (inputProps.segments as Array<{
    videos?: Array<{src?: string; colorCurve?: string}>;
  }>) || [];

  // 收集所有需要转码的视频（含 Log 素材：渲染回源全分辨率 + 一次性 LUT 恢复转码）
  const transcodeTasks: Array<{segmentIdx: number; videoIdx: number; inputPath: string; outputPath: string; lutCurve?: ColorCurveId}> = [];

  for (let si = 0; si < segments.length; si++) {
    const videos = segments[si]?.videos || [];
    for (let vi = 0; vi < videos.length; vi++) {
      const src = videos[vi]?.src;
      if (!src || (!src.startsWith('http://') && !src.startsWith('https://'))) continue;

      // 从 HTTP URL 中提取原始文件路径
      try {
        const url = new URL(src);
        const filePath = decodeURIComponent(url.searchParams.get('path') || '');
        if (!filePath || !fs.existsSync(filePath)) continue;

        // 图片无需转码（静态帧，Chromium 原生支持），跳过避免误调 ffmpeg
        if (isImageFile(filePath)) continue;
        // 3D 模型（.glb）不是视频流，ffprobe/ffmpeg 解不了也无须解（three.js 直接加载），跳过
        if (isModelFile(filePath)) continue;

        const ext = path.extname(filePath).toLowerCase();
        const codec = await getVideoCodec(filePath);
        const needs = needsTranscoding(filePath, codec);
        const lutCurve = colorCurveMetaSafe(videos[vi]?.colorCurve);
        // Log 恢复：即使容器可直渲（mp4/h264），也需带 LUT 的恢复版源（渲染 src 恒指源，
        // 代理只服务预览/抽帧，不会出现在这里）
        const needsLut = !!lutCurve;

        console.log(`[Transcode] 检查: ${path.basename(filePath)} | 容器=${ext} | 编码=${codec} | 兼容转码=${needs} | Log恢复=${lutCurve ?? '无'}`);

        if (needs || needsLut) {
          // LUT 恢复优先走缓存目录（lutRestoredSource 内部复用）；纯兼容转码落临时目录
          if (needsLut && lutCurve) {
            const restored = await lutRestoredSource(filePath, lutCurve, onLog);
            if (restored) {
              const segs = inputProps.segments as Array<{videos?: Array<{src?: string}>}>;
              const target = segs[si]?.videos?.[vi];
              if (target) target.src = filePathToHttpUrl(restored);
              continue;
            }
            // LUT 恢复失败（无完整 ffmpeg 等）：若容器本身也不兼容，仍走纯兼容转码兜底
            if (!needs) continue;
          }
          const tmpDir = path.join(os.tmpdir(), 'promo-transcode');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, {recursive: true});
          const outputPath = path.join(tmpDir, `${Date.now()}_${si}_${vi}.mp4`);
          transcodeTasks.push({segmentIdx: si, videoIdx: vi, inputPath: filePath, outputPath});
        }
      } catch (err) {
        onLog?.(`[Transcode] 解析失败: ${err}`);
      }
    }
  }

  // 执行所有转码任务
  for (const task of transcodeTasks) {
    try {
      await transcodeVideo(task.inputPath, task.outputPath, onLog);
      // 更新 video src 为转码后的文件（file:// 协议，Remotion 可直接读取）
      const segs = inputProps.segments as Array<{videos?: Array<{src?: string}>}>;
      const targetSeg = segs[task.segmentIdx];
      if (targetSeg?.videos?.[task.videoIdx]) {
        // 转码后通过 HTTP 服务器提供（避免 Chromium file:// 限制；filePathToHttpUrl 会注册白名单）
        targetSeg.videos[task.videoIdx].src = filePathToHttpUrl(task.outputPath);
        onLog?.(`[Transcode] 已更新 video[${task.segmentIdx}][${task.videoIdx}] → ${task.outputPath}`);
      }
    } catch (err) {
      onLog?.(`[Transcode] 转码失败（使用原文件）: ${err}`);
    }
  }

  return inputProps;
};

/** 渲染执行结果（IPC 层据此组装 {success, outputPath, encoderUsed, ...} 响应） */
export interface RenderExecutionResult {
  outputPath: string;
  /** 实际使用的编码器（auto 已解析；prores/vp9/gif 输出恒为 software） */
  encoderUsed: RenderEncoderUsed;
  /** 硬件编码不可用/失败回退软件编码时的用户提示（无回退则为 undefined） */
  encoderNote?: string;
  /** 段级渲染缓存命中情况（未启用 / 回退整片单渲时为 undefined） */
  cacheInfo?: {hit: number; total: number};
}

/**
 * 执行 Remotion 渲染，返回输出路径与实际编码器
 *
 * @param job - 渲染任务（单段或多段）
 * @param onProgress - 进度回调 (0-100)
 */
export const executeRender = async (
  job: RenderJob,
  onProgress?: (progress: number) => void,
  onLog?: (msg: string) => void
): Promise<RenderExecutionResult> => {
  // 取消信号：IPC「render:cancel」→ cancelRender() → cancel() → renderMedia 抛出取消错误
  const {cancelSignal, cancel} = makeCancelSignal();
  currentCancel = cancel;
  const startedAt = Date.now();
  try {
    const result = await executeRenderInner(job, onProgress, cancelSignal);
    // 匿名用量统计：渲染成功（次数 + 模板 id 频次 + 耗时；track 内部静默容错，绝不影响渲染结果）
    trackRender(collectRenderTemplateIds(job), Date.now() - startedAt);
    return result;
  } catch (err) {
    // 失败与用户取消都计为未完成渲染（不含任何工程内容；取消语义不变，错误继续上抛）
    trackRenderFailure(collectRenderTemplateIds(job));
    // 进程层死亡且重试用尽：错误消息带上分类与浏览器日志尾再上抛——
    // IPC/UI/bench 日志里能看到死因，"渲染静默死亡"变可诊断（取消/其他错误原样上抛）
    if (classifyRenderError(err) === 'process-death') {
      throw buildProcessDeathError(err, formatBrowserLogTail(renderBrowserLog));
    }
    throw err;
  } finally {
    if (currentCancel === cancel) currentCancel = null;
  }
};

const executeRenderInner = async (
  job: RenderJob,
  onProgress: ((progress: number) => void) | undefined,
  cancelSignal: import('@remotion/renderer').CancelSignal
): Promise<RenderExecutionResult> => {
  const opts = job.renderOptions;
  // 每任务清空浏览器日志环形缓冲（上一任务的取证不串台）
  renderBrowserLog.length = 0;

  // 格式 → Remotion codec + 容器映射
  // supportsCrf=false 的格式（prores/gif）不能向 renderMedia 传 crf（gif 会直接抛错）
  const FORMAT_MAP: Record<string, {
    codec: 'h264' | 'h265' | 'prores' | 'vp9' | 'gif';
    ext: 'mp4' | 'mov' | 'webm' | 'gif';
    audioCodec?: 'aac' | 'pcm-16';
    supportsCrf: boolean;
  }> = {
    mp4: {codec: 'h264', ext: 'mp4', audioCodec: 'aac', supportsCrf: true},
    'mp4-hevc': {codec: 'h265', ext: 'mp4', audioCodec: 'aac', supportsCrf: true},
    mov: {codec: 'prores', ext: 'mov', audioCodec: 'pcm-16', supportsCrf: false},
    webm: {codec: 'vp9', ext: 'webm', supportsCrf: true},
    gif: {codec: 'gif', ext: 'gif', supportsCrf: false},
  };
  const formatConfig = FORMAT_MAP[opts.format] || FORMAT_MAP.mp4;

  // Step 0: 预处理视频 — 转码不兼容格式
  console.log('[Remotion] Step 0: 检查视频兼容性...');
  const processedInputProps = await ensureVideosPlayable(
    job.inputProps as unknown as Record<string, unknown>,
    (msg) => console.log(msg)
  );

  // Step 1: 打包 Remotion 项目 → 生成 bundle（进程内缓存，重复渲染/静帧不再重新打包）
  const bundleLocation = await getBundled();

  // Step 2: 选择要渲染的 Composition（浏览器进程死亡重试：selectComposition 同样起浏览器）
  const composition = await withProcessDeathRetry('selectComposition', () =>
    selectComposition({
      serveUrl: bundleLocation,
      id: job.compositionId,
      inputProps: processedInputProps,
      chromiumOptions: chromiumGlOptions(),
      onBrowserLog: captureBrowserLog,
    }),
  );

  // 帧率锁定 30fps：全链路帧换算（remotion/config/resolutions.ts FPS、MultiSegmentPromo
  // 时间模型、上方 calculateFrameRange）均按 30 硬编码，防止音画错位。
  composition.fps = FPS;
  // 应用分辨率缩放
  // GIF 特例：短边恒钳到 720px（与授权无关）。实测 1080p/4.5s 的 GIF 近 200MB 完全不可用，
  // 4K GIF 更是天文数字；GIF 的实际用途（文档/群聊嵌入）也不需要高分辨率。
  let effectiveScale = opts.scale || 1;
  if (formatConfig.ext === 'gif') {
    const short = Math.min(composition.width, composition.height);
    effectiveScale = Math.min(effectiveScale, 720 / short);
  }
  if (effectiveScale !== 1) {
    composition.width = Math.round(composition.width * effectiveScale);
    composition.height = Math.round(composition.height * effectiveScale);
  }

  // 根据 inputProps 计算实际帧范围（避免渲染多余黑帧）
  const frameRange = calculateFrameRange(processedInputProps);

  // ====== 编码器解析（仅 h264/mp4 生效；prores/vp9 始终软件编码）======
  // 硬件编码经 ffmpegOverride 改写 stitcher 参数实现（renderMedia 的
  // hardwareAcceleration 选项在 Windows 上是空操作，见 services/encoderOverride.ts 头注）
  let encoderUsed: RenderEncoderUsed = 'software';
  let encoderNote: string | undefined;
  let hwOverride: FfmpegOverrideFn | undefined;
  const requestedEncoder = opts.encoder ?? 'auto';
  if (formatConfig.codec === 'h264' && requestedEncoder !== 'software') {
    const detected = await detectEncoders(getFfmpegPath());
    const resolved = resolveEncoder(requestedEncoder, detected);
    if (resolved !== 'software') {
      encoderUsed = resolved;
      hwOverride = makeFfmpegOverride({encoder: resolved, codec: formatConfig.codec});
      console.log(`[Remotion] 编码器: ${resolved === 'nvenc' ? 'NVIDIA NVENC' : 'Intel QSV'} 硬件编码`);
    } else if (requestedEncoder !== 'auto') {
      console.warn(`[Remotion] 请求的硬件编码器 ${requestedEncoder} 不可用，回退软件编码`);
      encoderNote = '硬件编码不可用，已用软件编码';
    } else {
      console.log('[Remotion] 未检测到硬件编码器，使用软件编码 x264');
    }
  }

  // 构建 Remotion renderMedia 选项
  const mediaOptions = {
    composition,
    serveUrl: bundleLocation,
    codec: formatConfig.codec,
    chromiumOptions: chromiumGlOptions(),
    // WebGL（3D 模板）在多标签并发下 GPU 争用：个别帧纹理上传竞态 → 展板单帧黑板
    // （实测 Remotion 默认 7 标签时 ~40% 黑帧率）。并发压到 3；
    // PIANYU_RENDER_CONCURRENCY 可覆盖（0 = 交回 Remotion 默认）
    concurrency: process.env.PIANYU_RENDER_CONCURRENCY === undefined ? 3 : Number(process.env.PIANYU_RENDER_CONCURRENCY) || undefined,
    inputProps: processedInputProps,
    frameRange: frameRange || undefined,
    audioCodec: ('audioCodec' in formatConfig ? formatConfig.audioCodec : undefined) as 'aac' | 'pcm-16' | undefined,
    crf: formatConfig.supportsCrf ? (opts.crf ?? undefined) : undefined,
    // 注意：不向 renderMedia 传 scale。上面已把 composition.width/height 按 opts.scale 缩放
    // （line 305），renderMedia 默认按 composition 尺寸渲染。若再传 scale 会再乘一次，
    // 免费版（0.667）会缩成 853×480（而非 1280×720），licensed 选 2x 会变 8K。
    muted: opts.muted || undefined,
    // PIANYU_RENDER_LOGLEVEL=verbose 可导出浏览器侧控制台（诊断纹理/网络问题时用）
    logLevel: (process.env.PIANYU_RENDER_LOGLEVEL as 'verbose' | 'trace' | 'info' | 'warn' | 'error' | undefined) ?? 'error',
    // 浏览器日志环形缓冲（进程死亡取证：平时静默，死亡时随错误打出日志尾）
    onBrowserLog: captureBrowserLog,
    // 单帧渲染等待上限放宽到 180s（默认 30s+）：CardConverge 这类同屏并发解码
    // 8 路 1440p 素材的模板，在高负载机器上单帧 stall 会超过默认上限
    // （报 "frame N failed: timeout 33000ms exceeded"）
    timeoutInMilliseconds: 180000,
    x264Preset: formatConfig.codec === 'h264' && opts.x264Preset !== 'medium' ? opts.x264Preset : undefined,
    overwrite: opts.overwrite,
    cancelSignal,
    onProgress: ({progress}: {progress: number}) => {
      onProgress?.(Math.round(progress * 100));
    },
  };

  // 确保输出路径使用正确扩展名
  const ensureExt = (filePath: string) => {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath, path.extname(filePath)) || `promo-${Date.now()}`;
    return path.join(dir, `${name}.${formatConfig.ext}`);
  };
  const finalOutputLocation = ensureExt(job.outputLocation);

  // 检查是否需要自定义分辨率后处理
  const firstSegment = (job.inputProps as any)?.segments?.[0];
  const customRes = firstSegment?.layout?.customResolution;
  const customAspect = firstSegment?.layout?.customAspect;

  let targetWidth = composition.width;
  let targetHeight = composition.height;

  if (customRes?.width && customRes?.height) {
    targetWidth = customRes.width;
    targetHeight = customRes.height;
  } else if (customAspect?.x && customAspect?.y) {
    // 以短边 1080 为基准，按自定义比例 X:Y 计算长边。
    // ratio = x/y：>= 1 为横向（宽>高），< 1 为竖向（高>宽）。
    // 例：16:9 -> 1920x1080；9:16 -> 1080x1920；1:1 -> 1080x1080；4:3 -> 1440x1080
    const SHORT_SIDE = 1080;
    const ratio = customAspect.x / customAspect.y;
    if (ratio >= 1) {
      targetWidth = Math.round(SHORT_SIDE * ratio);
      targetHeight = SHORT_SIDE;
    } else {
      targetWidth = SHORT_SIDE;
      targetHeight = Math.round(SHORT_SIDE / ratio);
    }
  }

  // 免费版分辨率钳制同样约束后处理目标尺寸：否则免费用户可用自定义分辨率/比例
  // 把已钳到 720p 的成片再放大输出（直至 4K），「限 720p」形同虚设
  const licensed = (job.inputProps as {licensed?: boolean}).licensed === true;
  if (!licensed) {
    const shortSide = Math.min(targetWidth, targetHeight);
    if (shortSide > 720) {
      const k = 720 / shortSide;
      targetWidth = Math.round(targetWidth * k);
      targetHeight = Math.round(targetHeight * k);
    }
  }
  // 编码器（h264/yuv420p）要求偶数尺寸，自定义分辨率/钳制缩放可能给出奇数
  targetWidth = Math.max(2, Math.floor(targetWidth / 2) * 2);
  targetHeight = Math.max(2, Math.floor(targetHeight / 2) * 2);

  const needsResize = targetWidth !== composition.width || targetHeight !== composition.height;

  // 后处理计划：缩放（自定义分辨率/比例/免费版钳制）与响度归一化合并为一次 ffmpeg 调用。
  // loudnorm 缺省语义与工程加载一致（缺字段 = 默认开）；gif/静音在 planPostProcess 内自动跳过。
  const postOpts = {
    needsResize,
    targetWidth,
    targetHeight,
    loudnorm: opts.loudnorm ?? DEFAULT_RENDER_OPTIONS.loudnorm,
    format: opts.format,
    muted: opts.muted === true,
  };
  const postPlan = planPostProcess(postOpts);

  // ====== 段级渲染缓存（局部重渲）======
  // 原理与键设计见 shared/render-blocks.ts 头注：同一份全片 props 下按段分块窗口渲染，
  // 帧内容与整片渲染逐帧一致，concat 拼回整片；改一段只重渲本段与邻段。
  // 缓存键一律取「原始 inputProps」——ensureVideosPlayable 转码会生成带时间戳的新临时
  // 文件名，素材的内容身份应以源文件路径 + 指纹为准，否则每次渲染键都变、永不命中。
  const originalProps = job.inputProps as unknown as Record<string, unknown>;
  const keySegments = (originalProps.segments as Segment[] | undefined) ?? [];
  const customIds = ((originalProps.customTemplates as Array<{id?: string}> | undefined) ?? [])
    .map((t) => (typeof t?.id === 'string' ? t.id : ''))
    .filter((id) => id.length > 0);
  const generatedIds = ((originalProps.generatedTemplates as Array<{id?: string}> | undefined) ?? [])
    .map((t) => (typeof t?.id === 'string' ? t.id : ''))
    .filter((id) => id.length > 0);
  const blockPlan: RenderBlockPlan | null =
    (opts.segmentCache ?? DEFAULT_RENDER_OPTIONS.segmentCache) &&
    ['mp4', 'mp4-hevc', 'mov'].includes(opts.format) &&
    // 段预览（previewFrameRange）恒走下方整片单渲路径渲子窗（块缓存按内容边界切块，
    // 与「含转场垫帧的段窗」口径不同；预览也不需要缓存复用）
    !opts.previewFrameRange &&
    frameRange
      ? computeRenderBlocks(keySegments, customIds, FPS, generatedIds)
      : null;
  const cacheState = {used: false, hit: 0, total: blockPlan?.blocks.length ?? 0};
  const cacheInfoOf = (): {hit: number; total: number} | undefined =>
    cacheState.used ? {hit: cacheState.hit, total: cacheState.total} : undefined;

  // 素材文件指纹（size:mtime）：同名文件被替换时让缓存键失效；远程/内联源取不到则留空跳过
  const srcToFilePath = (src: unknown): string => {
    if (typeof src !== 'string' || !src) return '';
    if (/^https?:\/\//i.test(src)) {
      if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(src)) return '';
      try {
        return new URL(src).searchParams.get('path') || '';
      } catch {
        return '';
      }
    }
    if (src.startsWith('file://')) {
      try {
        return fileURLToPath(src);
      } catch {
        return '';
      }
    }
    return src;
  };
  const videoFingerprints = keySegments.map((seg) =>
    (seg.videos ?? []).map((v) => {
      try {
        const fp = srcToFilePath(v.src);
        if (!fp) return '';
        const st = fs.statSync(fp);
        return `${st.size}:${Math.round(st.mtimeMs)}`;
      } catch {
        return '';
      }
    }),
  );
  // logo 文件指纹：logo 内容被替换但路径不变（如宣传 logo 迭代）时让缓存键失效——
  // 只看路径会让所有块命中旧缓存、烤出旧 logo（v7 实际踩坑）
  const logoSrc = (originalProps.logo as {src?: unknown} | undefined)?.src;
  const logoFilePath = typeof logoSrc === 'string' ? srcToFilePath(logoSrc) : '';
  let logoFingerprint = '';
  if (logoFilePath) {
    try {
      const st = fs.statSync(logoFilePath);
      logoFingerprint = `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {}
  }

  /**
   * 分块渲染 + concat 到 dest。非取消类失败向上抛，由调用方回退整片单渲；
   * 已写入缓存的块保留（键即内容身份，下次渲染仍可命中）。
   */
  const renderBlocksAndConcat = async (
    dest: string,
    ffmpegOverride: FfmpegOverrideFn | undefined,
  ): Promise<void> => {
    const keyCtx: BlockKeyContext = {
      appVersion: app.getVersion(),
      compositionId: job.compositionId,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      codec: formatConfig.codec,
      audioCodec: mediaOptions.audioCodec,
      crf: mediaOptions.crf,
      x264Preset: mediaOptions.x264Preset,
      muted: opts.muted === true,
      encoder: encoderUsed,
      format: opts.format,
      globalProps: originalProps,
      segments: keySegments,
      videoFingerprints,
      logoFingerprint,
    };
    const blockPaths: string[] = [];
    let framesDone = 0;
    let hit = 0;
    // 强制重渲段（「重渲此段」入口）：段 i 内容进块键的邻域是 i-1..i+1（头注第 3 类依赖），
    // 这三个主属段的块一律跳过缓存读，其余块照常命中
    const forcedSegs = new Set<number>();
    for (const i of opts.forceSegments ?? []) {
      forcedSegs.add(i);
      forcedSegs.add(i - 1);
      forcedSegs.add(i + 1);
    }
    for (const block of blockPlan!.blocks) {
      const key = blockCacheKey(keyCtx, block);
      const cached = forcedSegs.has(block.segIndex) ? null : readCachedBlock(key, formatConfig.ext);
      if (cached) {
        blockPaths.push(cached);
        hit++;
        framesDone += block.frames;
        onProgress?.(Math.min(99, Math.round((framesDone / blockPlan!.totalFrames) * 100)));
        continue;
      }
      const tmpBlock = blockTmpPath(key, formatConfig.ext);
      // 单块渲染带重试：OffthreadVideo 逐帧抓取偶发 "Failed to fetch /proxy"
      // （Chrome/合成器瞬时抖动；Remotion 自带的 retries 只覆盖 delayRender 超时，
      // 不覆盖 fetch 失败直接 cancelRender 的路径）。块粒度重试成本极低（缓存块不重渲）。
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          await renderMedia({
            ...mediaOptions,
            frameRange: [block.startFrame, block.endFrame],
            ffmpegOverride,
            binariesDirectory: getBinariesDir(),
            outputLocation: tmpBlock,
            onProgress: ({progress}: {progress: number}) => {
              const global = (framesDone + progress * block.frames) / blockPlan!.totalFrames;
              onProgress?.(Math.min(99, Math.round(global * 100)));
            },
          });
          blockPaths.push(await writeBlockToCache(tmpBlock, key, formatConfig.ext));
          break;
        } catch (err) {
          try {
            fs.unlinkSync(tmpBlock);
          } catch {}
          if (isRenderCancelledError(err) || attempt >= 3) throw err;
          console.warn(`[Remotion] 块渲染失败（第 ${attempt} 次，共 3 次机会），重试: ${String(err).slice(0, 300)}`);
        }
      }
      framesDone += block.frames;
    }
    // concat：视频流 copy（各块同设置产出、码流参数一致）。
    // 音频不能整段 copy/重编码——Remotion mp4 的 AAC 不写 edit list，每块头部带
    // 2048 样本（42.7ms@48k）编码器 priming 静音，直接拼接会逐块累积漂移（实测
    // 4 块多 0.14s）。这里逐块 atrim 掉 priming 并截到「块帧数 × 1600 样本」的
    // 精确时长，用 concat 滤镜拼连续后单次编码——结果与整片渲染逐样本一致。
    const listFile = path.join(
      os.tmpdir(), 'promo-render', `concat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`,
    );
    fs.writeFileSync(
      listFile,
      concatListContent(
        blockPaths,
        // 显式视频时长：防止 concat demuxer 按含 priming 的音频时长偏移下一块 PTS（接缝 50ms 空洞）
        blockPlan!.blocks.map((b) => b.frames / FPS),
      ),
      'utf8',
    );
    let concatArgs: string[];
    if (opts.muted) {
      concatArgs = ['-c', 'copy'];
    } else {
      const AAC_PRIMING = 2048;
      const trim = blockPlan!.blocks
        .map((b, i) => `[${i + 1}:a]atrim=start_sample=${AAC_PRIMING}:end_sample=${AAC_PRIMING + b.frames * 1600},asetpts=PTS-STARTPTS[a${i}]`)
        .join(';');
      const join = `${blockPlan!.blocks.map((_, i) => `[a${i}]`).join('')}concat=n=${blockPlan!.blocks.length}:v=0:a=1[aout]`;
      concatArgs = [
        '-map', '0:v', '-c:v', 'copy',
        '-filter_complex', `${trim};${join}`,
        '-map', '[aout]',
        ...(opts.format === 'mov' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']),
      ];
    }
    try {
      await execa(
        getFfmpegPath(),
        ['-f', 'concat', '-safe', '0', '-i', listFile, ...blockPaths.flatMap((p) => ['-i', p]), ...concatArgs, '-y', dest],
        {encoding: 'utf8'},
      );
    } finally {
      try {
        fs.unlinkSync(listFile);
      } catch {}
    }
    cacheState.used = true;
    cacheState.hit = hit;
    if (hit > 0) {
      console.log(`[Remotion] 段级缓存命中 ${hit}/${blockPlan!.blocks.length} 块`);
    }
    onProgress?.(100);
    evictRenderCache();
  };

  // 单次渲染尝试：需要后处理时先渲临时文件再 ffmpeg 到最终路径
  const renderTo = async (finalPath: string, ffmpegOverride: FfmpegOverrideFn | undefined): Promise<string> => {
    let renderOutput = finalPath;

    if (postPlan.needed) {
      // 先渲染到临时文件，后处理到最终路径
      const tmpDir = path.join(os.tmpdir(), 'promo-render');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, {recursive: true});
      renderOutput = path.join(tmpDir, `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${formatConfig.ext}`);
    }

    // 分块渲染优先（段级缓存）；非取消类失败回退整片单渲，保证成片照常产出
    let renderedViaBlocks = false;
    if (blockPlan) {
      try {
        await renderBlocksAndConcat(renderOutput, ffmpegOverride);
        renderedViaBlocks = true;
      } catch (err) {
        if (isRenderCancelledError(err)) throw err;
        console.warn(`[Remotion] 分块渲染/拼接失败，回退整片单渲: ${err}`);
      }
    }

    if (!renderedViaBlocks) {
      await withProcessDeathRetry('整片单渲', () =>
        renderMedia({
          ...mediaOptions,
          // 段预览窗（RENDER_SEGMENT）：覆盖 calculateFrameRange 的全片范围——
          // 绝对帧窗渲子窗，段间转场上下文天然完整（segments 不裁剪）
          ...(opts.previewFrameRange ? {frameRange: opts.previewFrameRange} : {}),
          ffmpegOverride,
          // 完整版 ffmpeg 覆盖目录（默认 null = Remotion 内置；renderMedia 会用它解析
          // compositor/stitcher 所需的全部二进制，故该目录须同时含 remotion.exe）
          binariesDirectory: getBinariesDir(),
          outputLocation: renderOutput,
        }),
      );
    }

    // 后处理：缩放 / 响度归一化（计划见 planPostProcess）。
    // loudnorm 两遍线性：先测成片实测响度再常量增益应用（单遍动态模式有 ~3s 自适应沉降
    // =「BGM 开头响后面软」的根源，恒幅对照 -13→-19dB 实锤见 verify-bgm-decay.mjs）；
    // 测量失败降级单遍动态（仍归一，只是带沉降），应用失败沿用既有降级链。
    if (postPlan.needed) {
      const ffmpegPath = getFfmpegPath();
      const runPost = async (args: string[], dest: string) =>
        execa(ffmpegPath, ['-i', renderOutput, ...args, '-y', dest], {encoding: 'utf8'});
      const finishRaw = async (reason: string) => {
        await fs.promises.copyFile(renderOutput, finalPath);
        console.warn(`[Remotion] 已降级：${reason}，输出合成器原生产物`);
        try { fs.unlinkSync(renderOutput); } catch {}
      };
      let applyPlan = postPlan;
      if (postPlan.hasLoudnorm && !postPlan.isLinear) {
        try {
          const measure = await execa(ffmpegPath, ['-i', renderOutput, ...loudnormMeasureArgs()], {encoding: 'utf8'});
          const m = parseLoudnormMeasurement((measure.stderr ?? '') + (measure.stdout ?? ''));
          if (m) {
            applyPlan = planPostProcess({...postOpts, loudnormMeasured: m});
            console.log(`[Remotion] loudnorm 两遍线性：实测 I=${m.inputI} TP=${m.inputTp} LRA=${m.inputLra}`);
          } else {
            console.warn('[Remotion] loudnorm 测量解析失败，降级单遍动态（有 ~3s 起始沉降）');
          }
        } catch (measureErr) {
          console.warn(`[Remotion] loudnorm 测量遍失败，降级单遍动态（有 ~3s 起始沉降）: ${measureErr}`);
        }
      }
      let done = false;
      try {
        await runPost(applyPlan.args, finalPath);
        done = true;
        console.log(`[Remotion] 后处理: ${applyPlan.summary}`);
      } catch (postErr) {
        // 降级链（后处理是增强项，绝不让成片因它报废）：
        // 1) loudnorm 失败（常见：产物无音轨）→ 去掉音频滤镜重试，缩放保留；
        // 2) 缩放也失败（Remotion 内置 ffmpeg 未启用 pad 滤镜，自定义分辨率需
        //    PIANYU_FFMPEG_DIR 指向完整版 ffmpeg）→ 拷贝未处理产物，渲染照常完成
        console.warn(`[Remotion] 后处理失败（${applyPlan.summary}）: ${postErr}`);
        const fallback = planPostProcess({...postOpts, loudnorm: false});
        if (applyPlan.hasLoudnorm && fallback.needed) {
          try {
            await runPost(fallback.args, finalPath);
            done = true;
            console.warn('[Remotion] 已降级：跳过响度归一化，保留缩放');
          } catch (resizeErr) {
            console.warn(`[Remotion] 缩放后处理也失败（内置 ffmpeg 可能缺 pad 滤镜）: ${resizeErr}`);
          }
        }
        if (!done) await finishRaw(applyPlan.hasLoudnorm ? '跳过后处理' : '缩放不可用');
      }
      if (done) {
        // 清理临时文件
        try { fs.unlinkSync(renderOutput); } catch {}
      }
    }

    return finalPath;
  };

  // Step 3: 尝试渲染到用户指定位置（硬件编码失败先原地重试软件编码，再退兜底目录）
  let activeOverride = hwOverride;
  try {
    const outputPath = await renderTo(finalOutputLocation, activeOverride);
    return {outputPath, encoderUsed, encoderNote, cacheInfo: cacheInfoOf()};
  } catch (firstError) {
    // 用户取消：直接向上抛，不走重试/兜底路径（否则取消后会再渲染一遍）
    if (isRenderCancelledError(firstError)) throw firstError;
    console.warn(`[Remotion] 原路径渲染失败: ${firstError}`);

    // 硬件编码器激活时的失败先按编码失败处理：原地用软件编码重试一次
    if (activeOverride) {
      console.warn('[Remotion] 硬件编码失败，改用软件编码重试');
      encoderUsed = 'software';
      encoderNote = '硬件编码失败，已改用软件编码';
      activeOverride = undefined;
      try {
        const outputPath = await renderTo(finalOutputLocation, undefined);
        return {outputPath, encoderUsed, encoderNote, cacheInfo: cacheInfoOf()};
      } catch (secondError) {
        if (isRenderCancelledError(secondError)) throw secondError;
        console.warn(`[Remotion] 软件编码重试仍失败: ${secondError}`);
      }
    }

    // 最后手段：尝试兜底目录
    const fallbackDir = getFallbackOutputDir();
    const fallbackFinal = path.join(fallbackDir, ensureExt(job.outputLocation).split(path.sep).pop() || `promo-${Date.now()}.${formatConfig.ext}`);

    console.log(`[Remotion] 尝试兜底路径: ${fallbackFinal}`);

    const outputPath = await renderTo(fallbackFinal, activeOverride);
    return {outputPath, encoderUsed, encoderNote, cacheInfo: cacheInfoOf()};
  }
};

/** 静帧渲染结果（JPEG data URL + 缩放后尺寸，供 AI 多模态看图） */
export interface StoryboardStillResult {
  dataUrl: string;
  width: number;
  height: number;
}

/** 静帧缩放宽高上限（与抽帧同口径，控制 data URL 体积） */
const STILL_MAX_DIM = 768;

/**
 * 渲染故事板某时刻的一帧成片画面（AI preview_storyboard_frame 工具用）。
 * 与整片渲染同一套预处理与 bundle（走缓存）；帧号按 30fps 线性时间模型换算并钳到有效范围。
 * inputProps.licensed 已在 IPC 层强制覆写（与 render:start 同口径），本函数不再处理。
 */
export const renderStoryboardStill = async (
  inputProps: Record<string, unknown>,
  aspectRatioId: string,
  timeSec: number,
): Promise<StoryboardStillResult> => {
  // 视频兼容性预处理：http src 的素材若不兼容会先转码（本地路径/图片原样通过）
  const processedInputProps = await ensureVideosPlayable(inputProps, (msg) => console.log(msg));
  const bundleLocation = await getBundled();
  const composition = await withProcessDeathRetry('still.selectComposition', () =>
    selectComposition({
      serveUrl: bundleLocation,
      id: `MultiSegment-${aspectRatioId}`,
      inputProps: processedInputProps,
      chromiumOptions: chromiumGlOptions(),
      onBrowserLog: captureBrowserLog,
    }),
  );
  composition.fps = FPS;
  // 全局第 N 秒 = 第 N*30 帧（与 calculateFrameRange 的时间模型一致），钳到有效帧范围
  const frame = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(timeSec * FPS)));
  const outDir = path.join(os.tmpdir(), 'promo-stills');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, {recursive: true});
  const outPath = path.join(outDir, `still_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  await withProcessDeathRetry('renderStill', () =>
    renderStill({
      composition,
      serveUrl: bundleLocation,
      output: outPath,
      frame,
      inputProps: processedInputProps,
      chromiumOptions: chromiumGlOptions(),
    }),
  );
  try {
    // 读回缩放到长边 768 的 JPEG（复用抽帧的尺寸思路），随后清理临时 PNG
    const img = nativeImage.createFromPath(outPath);
    if (img.isEmpty()) throw new Error('静帧渲染失败：无法读取输出画面');
    return resizeToDataUrl(img, STILL_MAX_DIM);
  } finally {
    try { fs.unlinkSync(outPath); } catch {}
  }
};

/** 封面导出结果：落盘路径 + 供回看的缩略 data URL */
export interface CoverStillResult {
  outputPath: string;
  dataUrl: string;
  width: number;
  height: number;
}

/** 文件名里不允许出现的字符 → 全角替代（输出目录由 IPC 层白名单校验） */
const sanitizeFileToken = (name: string): string =>
  (name || '片语').replace(/[\\/:*?"<>|]/g, '－').trim().slice(0, 60) || '片语';

/**
 * 渲染封面：对 Cover-<比例> 合成做一次全分辨率 renderStill（全片画面 + 封面覆盖层），
 * 按配置转 JPG（q92，适合平台上传）/ PNG（无损）写入输出目录。
 * 输入的 cover 应已清洗（sanitizeCoverConfig），timeSec 由 IPC 层钳制；
 * subjectMask 为主体遮挡 mask（PNG data URL，behind 图层据此渲染到主体后面）。
 */
export const renderCoverStill = async (
  inputProps: Record<string, unknown>,
  cover: CoverConfig,
  aspectRatioId: string,
  timeSec: number,
  outputDir: string,
  baseName: string,
  subjectMask = '',
): Promise<CoverStillResult> => {
  const processedInputProps = await ensureVideosPlayable(inputProps, (msg) => console.log(msg));
  const bundleLocation = await getBundled();
  const coverProps = {project: processedInputProps, cover, ...(subjectMask ? {subjectMask} : {})};
  const composition = await withProcessDeathRetry('cover.selectComposition', () =>
    selectComposition({
      serveUrl: bundleLocation,
      id: `Cover-${aspectRatioId}`,
      inputProps: coverProps,
      chromiumOptions: chromiumGlOptions(),
      onBrowserLog: captureBrowserLog,
    }),
  );
  composition.fps = FPS;
  const frame = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(timeSec * FPS)));

  // 先渲到临时 PNG，再按格式落盘到输出目录（JPG 需重编码，PNG 直接拷贝）
  const tmpDir = path.join(os.tmpdir(), 'promo-covers');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, {recursive: true});
  const tmpPath = path.join(tmpDir, `cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  await withProcessDeathRetry('cover.renderStill', () =>
    renderStill({
      composition,
      serveUrl: bundleLocation,
      output: tmpPath,
      frame,
      inputProps: coverProps,
      chromiumOptions: chromiumGlOptions(),
    }),
  );

  try {
    const stem = `${sanitizeFileToken(baseName)}-封面-${timeSec.toFixed(1)}s`;
    let finalPath = path.join(outputDir, `${stem}.${cover.format}`);
    if (fs.existsSync(finalPath)) finalPath = path.join(outputDir, `${stem}-${Date.now() % 10000}.${cover.format}`);
    const img = nativeImage.createFromPath(tmpPath);
    if (img.isEmpty()) throw new Error('封面渲染失败：无法读取输出画面');
    if (cover.format === 'jpg') {
      fs.writeFileSync(finalPath, img.toJPEG(92));
    } else {
      fs.copyFileSync(tmpPath, finalPath);
    }
    const preview = resizeToDataUrl(img, STILL_MAX_DIM);
    return {outputPath: finalPath, dataUrl: preview.dataUrl, width: img.getSize().width, height: img.getSize().height};
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
};
