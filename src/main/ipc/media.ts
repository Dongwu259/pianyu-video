/**
 * 媒体相关 IPC（素材/音频/图片选择、元数据、抽帧、HTTP URL 注册、shell 操作）
 */

import {app, dialog, ipcMain, shell} from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import {getVideoMetadata} from '../services/ffprobe';
import {filePathToHttpUrl, isRegisteredMediaPath, registerMediaPath} from '../services/videoServer';
import {codecPreviewWarning} from '../../shared/codec-preview';
import {guessColorCurveFromTags, type ColorCurveId} from '../../shared/proxy-media.ts';
import {guessSourceKind} from '../../shared/source-kind';
import {uniqueCopyName, isLocalFilePath} from '../../shared/consolidate';
import {analyzeAudio, analyzeMusicMap} from '../services/audio';
import {analyzeFootageCached} from '../services/footage';
import {readCursorTrack} from '../services/capture';
import {analyzeColorStats} from '../services/colorStats';
import {getSfxLibraryUrls} from '../services/sfxLibrary';
import {listBuiltinBgm} from '../services/bgmLibrary';
import {extractFrame} from '../services/frameExtract';
import {makeContactSheet} from '../services/contactSheet';
import {detectLocalModelEnv, LocalModelDownloadService, type LocalModelDownloadState} from '../services/localModel';
import {getGlobalSettings} from '../services/store';
import {
  scanMusicDir,
  readMusicAnalysisCache,
  writeMusicAnalysisCache,
  lookupMusicAnalysis,
  upsertMusicAnalysis,
} from '../services/musicLibrary';
import type {IpcCtx} from './ctx';

export const registerMediaIpc = (ctx: IpcCtx) => {
  // 选择视频文件
  ipcMain.handle(IPC_CHANNELS.FILE_SELECT_Videos, async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {name: '媒体文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'glb']},
        {name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi']},
        {name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']},
        {name: '3D 模型', extensions: ['glb']},
        {name: '所有文件', extensions: ['*']},
      ],
    });

    if (result.canceled) return [];

    // 为每个媒体文件获取元数据（视频用 ffprobe，图片用 nativeImage），并生成小尺寸缩略图
    //（时间线卡片用；视频抽 10% 处一帧，图片直接缩放。失败不阻塞上传）
    const videos = await Promise.all(
      result.filePaths.map(async (filePath) => {
        const metadata = await getVideoMetadata(filePath);
        const duration = metadata.duration;
        // mxf/超大/4K 素材：入队后台代理（抽帧/预览/缩略图读代理；缓存命中立返 ready）。
        // 曲线猜测（Sony/DJI/BMD 无歧义厂牌自动填，Canon/ARRI 只回候选待确认）
        const guess = metadata.make || metadata.model ? guessColorCurveFromTags(metadata.make ?? '', metadata.model ?? '') : null;
        let proxy: {proxyPath?: string; proxyQueued?: boolean} = {};
        if (ctx.proxyService && metadata.type === 'video' && ctx.proxyService.probeTrigger(filePath, metadata.width, metadata.height)) {
          const job = await ctx.proxyService.prepare(filePath, guess?.curve);
          proxy = job.status === 'ready' && job.proxyPath
            ? {proxyPath: job.proxyPath}
            : {proxyQueued: true};
        }
        let thumbnail: string | undefined;
        try {
          const t = metadata.type === 'video' ? Math.min(1, duration * 0.1) : 0;
          thumbnail = (await extractFrame(filePath, t, 192)).dataUrl;
        } catch {
          thumbnail = undefined;
        }
        // 色彩统计（自动曝光匹配用；失败不阻塞上传，匹配时该素材跳过）
        let colorStats;
        try {
          colorStats = (await analyzeColorStats(filePath, metadata.type, duration)) ?? undefined;
        } catch {
          colorStats = undefined;
        }
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          src: filePathToHttpUrl(filePath),  // 转为 HTTP URL 供 Remotion 使用
          name: path.basename(filePath),
          type: metadata.type,  // 'video' | 'image' | 'model'
          width: metadata.width,
          height: metadata.height,
          duration,
          trimStart: 0,
          trimEnd: duration,
          trimmedDuration: duration,
          thumbnail,
          colorStats,
          // 素材来源类型（AI 选型信号：实拍优先 Fullbleed 满幅族；启发式不确定默认 live-action）
          sourceKind: guessSourceKind({type: metadata.type, width: metadata.width, height: metadata.height, make: metadata.make, model: metadata.model, ext: path.extname(filePath)}),
          ...(guess?.curve ? {colorCurve: guess.curve} : {}),
          ...proxy,
          ...(guess ? {colorCurveGuessNote: guess.note} : {}),
          // 编码预览白名单警告（hevc/prores 等 Chromium 解不动，预览可能黑屏/无声；导出不受影响）
          codecWarning: metadata.type === 'video' ? codecPreviewWarning(metadata.codec) ?? undefined : undefined,
        };
      })
    );

    return videos;
  });

  // ====== 代理转码（mxf/超大/4K：后台 960 宽代理；Log 素材烧入技术转换 LUT）======

  // 请求代理：先探测触发规则（mxf 等容器/超大/4K——主进程才能 stat 文件大小），
  // 不触发返回 not-needed（调用方零分支）；命中则缓存立返 ready / 入队。返回 job 快照。
  ipcMain.handle(IPC_CHANNELS.PROXY_PREPARE, async (_, req: {path?: unknown; colorCurve?: unknown}) => {
    const filePath = typeof req?.path === 'string' ? req.path : '';
    if (!filePath || !isRegisteredMediaPath(filePath)) {
      throw new Error('素材未注册（仅可为故事板素材生成代理）');
    }
    if (!ctx.proxyService) throw new Error('代理服务不可用');
    // 探测需要分辨率：ffprobe 元数据现拿（导入链路已有 meta 的调用方走 probeTrigger 直判免重复探测）
    const meta = await getVideoMetadata(filePath);
    if (!ctx.proxyService.probeTrigger(filePath, meta.width, meta.height)) {
      return {sourcePath: filePath, status: 'not-needed'};
    }
    const colorCurve = typeof req?.colorCurve === 'string' ? (req.colorCurve as ColorCurveId) : undefined;
    return ctx.proxyService.prepare(filePath, colorCurve);
  });

  // 全部代理 job 摘要（get_app_status / 面板轮询）
  ipcMain.handle(IPC_CHANNELS.PROXY_STATUS, async () => {
    return ctx.proxyService?.listJobs() ?? [];
  });

  // 素材来源类型手动修正记录（RLHF 留口：sourceKind 启发式误判的真实样本，本地 jsonl 追加；
  // 攒真实误判案例比任何离线实验都准——后续启发式调参/蒸馏分类语料的依据）
  ipcMain.handle(IPC_CHANNELS.SOURCEKIND_RECORD_CHANGE, async (_, req: {
    path?: unknown; name?: unknown; from?: unknown; to?: unknown;
  }) => {
    const sourcePath = typeof req?.path === 'string' ? req.path : '';
    if (!sourcePath) return {ok: false, error: '缺少素材路径'};
    const record = {
      ts: new Date().toISOString(),
      name: typeof req?.name === 'string' ? req.name : null,
      sourcePath,
      from: typeof req?.from === 'string' ? req.from : null,
      to: typeof req?.to === 'string' ? req.to : null,
    };
    try {
      const file = path.join(app.getPath('userData'), 'sourcekind-changes.jsonl');
      fs.appendFileSync(file, `${JSON.stringify(record)}
`, 'utf8');
      return {ok: true, file};
    } catch (err) {
      return {ok: false, error: err instanceof Error ? err.message : String(err)};
    }
  });

  // 获取单个视频元数据
  ipcMain.handle(IPC_CHANNELS.FILE_GET_VIDEO_METADATA, async (_, filePath: string) => {
    return getVideoMetadata(filePath);
  });

  // 读取录屏素材的鼠标轨迹 sidecar（录屏即成品编排用）
  // 口径同 FILE_GET_VIDEO_METADATA：不设媒体白名单——刚落盘的纯录屏文件尚未注册，
  // 编排器必须能读到；轨迹是演示统计数据非敏感内容，且只接受「同目录同名 .cursor.json」
  ipcMain.handle(IPC_CHANNELS.FILE_READ_CURSOR_TRACK, async (_, videoPath: string) => {
    if (typeof videoPath !== 'string' || !videoPath) {
      throw new Error('路径为空');
    }
    const sidePath = videoPath.replace(/\.(webm|mp4|mkv|mov|avi)$/i, '.cursor.json');
    if (sidePath === videoPath) return null;
    return readCursorTrack(sidePath);
  });

  // 分析素材色彩统计（录屏停录/agent 导入等渲染进程侧入库路径用）
  // 安全：与批量抽帧同口径——只分析已注册进媒体白名单的路径
  ipcMain.handle('media:analyzeColor', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath || !isRegisteredMediaPath(filePath)) {
      throw new Error('素材未注册（仅可分析故事板素材）');
    }
    const metadata = await getVideoMetadata(filePath);
    return analyzeColorStats(filePath, metadata.type, metadata.duration);
  });

  // ====== 收集工程素材（consolidate_project 工具）======

  /** 同内容判定的轻量指纹：文件大小 + 前 64KB 的 sha1（全量哈希大文件太慢，64KB 头 + 大小在实践中足够区分） */
  const contentFingerprintOf = (file: string, size: number): string => {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return `${size}:${crypto.createHash('sha1').update(buf).digest('hex')}`;
    } finally {
      fs.closeSync(fd);
    }
  };

  // 把入参的本地素材复制到 <dir>/media/（目录不存在会创建；同名冲突自动 -1/-2 改名，
  // 已存在同内容文件跳过复制直接映射），新路径注册进媒体白名单。
  // 返回 {map: 旧路径→新路径, missing: 源文件缺失清单, copied: 实际复制数}
  ipcMain.handle('media:consolidate', async (_, req: {dir?: unknown; paths?: unknown}) => {
    const dir = typeof req?.dir === 'string' ? req.dir.trim() : '';
    if (!dir || !path.isAbsolute(dir)) {
      throw new Error('需要目标目录的绝对路径（dir）');
    }
    const paths = Array.isArray(req?.paths)
      ? (req.paths as unknown[]).filter((p): p is string => typeof p === 'string' && isLocalFilePath(p))
      : [];
    if (paths.length === 0) return {map: {}, missing: [], copied: 0};
    if (paths.length > 500) throw new Error('一次最多收集 500 个素材文件');
    const mediaDir = path.join(dir, 'media');
    fs.mkdirSync(mediaDir, {recursive: true});
    // 已有文件登记：文件名 → 内容指纹（同名同内容判定用）
    const existing = new Map<string, string>();
    for (const name of fs.readdirSync(mediaDir)) {
      try {
        const full = path.join(mediaDir, name);
        const st = fs.statSync(full);
        if (st.isFile()) existing.set(name, contentFingerprintOf(full, st.size));
      } catch {
        // 单个文件读不了不影响整体
      }
    }
    const map: Record<string, string> = {};
    const missing: string[] = [];
    let copied = 0;
    const seen = new Set<string>();
    for (const src of paths) {
      const resolved = path.resolve(src);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      let size: number;
      try {
        const st = fs.statSync(resolved);
        if (!st.isFile()) throw new Error('not a file');
        size = st.size;
      } catch {
        missing.push(src);
        continue;
      }
      // 源文件已在 media 目录内（重复收集/幂等重跑）：直接映射自身，不复制
      if (path.dirname(resolved) === path.resolve(mediaDir)) {
        map[src] = resolved;
        existing.set(path.basename(resolved), contentFingerprintOf(resolved, size));
        continue;
      }
      const fp = contentFingerprintOf(resolved, size);
      const name = uniqueCopyName(path.basename(resolved), (candidate) => {
        const e = existing.get(candidate);
        return e !== undefined && e !== fp; // 占用 = 存在且内容不同；同内容不算占用（复用不复制）
      });
      const target = path.join(mediaDir, name);
      if (!existing.has(name)) {
        await fs.promises.copyFile(resolved, target);
        copied++;
      }
      existing.set(name, fp);
      map[src] = target;
      // 新路径注册进媒体白名单（与导入素材同口径，预览/渲染/抽帧才能访问）
      registerMediaPath(target);
    }
    return {map, missing, copied};
  });

  // 将本地文件路径转换为 HTTP URL（供 Remotion 渲染使用）
  ipcMain.handle('video:getHttpUrl', async (_, filePath: string) => {
    return filePathToHttpUrl(filePath);
  });

  // 在文件管理器中打开
  ipcMain.handle(IPC_CHANNELS.FILE_OPEN_IN_EXPLORER, async (_, targetPath: string) => {
    shell.showItemInFolder(targetPath);
  });

  // 用系统浏览器打开外部链接（仅允许 http/https，防止 file:// 等协议被滥用）
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  // ====== 背景音乐 ======

  // 选择音频文件，返回名称/路径/HTTP src
  ipcMain.handle('audio:select', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '选择背景音乐',
      properties: ['openFile'],
      filters: [
        {name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']},
        {name: '所有文件', extensions: ['*']},
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return {name: path.basename(filePath), path: filePath, src: filePathToHttpUrl(filePath)};
  });

  // 分析音频：返回时长、波形峰值与节拍
  ipcMain.handle('audio:analyze', async (_, filePath: string) => {
    try {
      return await analyzeAudio(filePath);
    } catch (err) {
      console.error('[audio:analyze] 失败:', err);
      return {duration: 0, peaks: [], beats: [], bpm: 0};
    }
  });

  // 音乐结构图（剪辑大脑：节拍 + 重拍 + 段落 + 每拍能量）
  ipcMain.handle('audio:musicMap', async (_, filePath: string) => {
    try {
      return await analyzeMusicMap(filePath);
    } catch (err) {
      console.error('[audio:musicMap] 失败:', err);
      return null;
    }
  });

  // 素材画面分析（剪辑大脑：镜头边界 + 运动强度曲线）
  ipcMain.handle('footage:analyze', async (_, filePath: string) => {
    try {
      return await analyzeFootageCached(filePath);
    } catch (err) {
      console.error('[footage:analyze] 失败:', err);
      return null;
    }
  });

  // ====== 内置音效库（SFX）======

  // 音效源表：类别 → 变体 HTTP URL 列表（resources/sfx；渲染预览与导出共用）
  ipcMain.handle('sfx:getLibrary', async () => getSfxLibraryUrls(__dirname));

  // ====== 内置配乐库（CC BY 4.0，用户拍板 2026-10-13 可用；带 credit 字段走强制署名链路）======

  // 内置曲库条目表（resources/bgm；点选与本地曲库同数据路径，UI 见 BgmPanel）
  ipcMain.handle('bgm:getLibrary', async () => listBuiltinBgm(__dirname));

  // ====== 本地曲库（用户指定目录，不内置任何音乐）======

  // 音频分析磁盘缓存文件（userData/music-analysis-cache.json）
  const getMusicAnalysisCacheFile = (): string =>
    path.join(app.getPath('userData'), 'music-analysis-cache.json');

  // 弹目录选择对话框选曲库目录（用户取消返回 ''）；写入设置由渲染端走 settings:set
  ipcMain.handle('music:selectDir', async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '选择曲库目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return '';
    return result.filePaths[0];
  });

  // 扫描设置里的曲库目录（仅一级文件；未设置/不存在返回 []）
  ipcMain.handle('music:scan', async () => {
    return scanMusicDir(getGlobalSettings().musicLibraryDir || '');
  });

  // 分析曲库音频：带磁盘缓存（key=路径，mtimeMs 校验命中，上限 200 条清最旧）
  ipcMain.handle('music:analyze', async (_, filePath: string) => {
    try {
      const cacheFile = getMusicAnalysisCacheFile();
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        // 文件不可读：放弃缓存直接分析（analyzeAudio 会抛中文错误走 catch）
      }
      const cache = readMusicAnalysisCache(cacheFile);
      if (mtimeMs > 0) {
        const hit = lookupMusicAnalysis(cache, filePath, mtimeMs);
        if (hit) return hit;
      }
      const analysis = await analyzeAudio(filePath);
      if (mtimeMs > 0) {
        writeMusicAnalysisCache(cacheFile, upsertMusicAnalysis(cache, filePath, mtimeMs, analysis));
      }
      return analysis;
    } catch (err) {
      console.error('[music:analyze] 失败:', err);
      return {duration: 0, peaks: []};
    }
  });

  // 选择图片（Logo）：返回 {name,path,src}，用户取消返回 null
  ipcMain.handle(IPC_CHANNELS.FILE_SELECT_IMAGE, async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: '选择 Logo 图片',
      properties: ['openFile'],
      filters: [
        {name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']},
        {name: '所有文件', extensions: ['*']},
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return {name: path.basename(filePath), path: filePath, src: filePathToHttpUrl(filePath)};
  });

  // ====== 视频抽帧（AI 助手多模态看图）======

  // 从视频/图片抽帧 -> JPEG data URL；错误以中文 Error 抛回渲染进程
  ipcMain.handle(IPC_CHANNELS.VIDEO_EXTRACT_FRAME, async (_, filePath: string, timeSec: number, maxDim?: number) => {
    // maxDim 可选（additive）：时间线缩略图等小图场景传 192；非法值交服务层缺省（768）
    const dim = typeof maxDim === 'number' && Number.isFinite(maxDim) && maxDim >= 32 ? maxDim : undefined;
    return extractFrame(filePath, timeSec, dim);
  });

  // 批量抽帧（AI 助手 view_media_frames；≤4 个时间点逐个校验）
  // 安全：与 asr:transcribe 同口径——只抽应用自己注册过的媒体路径（白名单见 videoServer），
  // 否则渲染进程任意 JS 可读本机任意文件画面发往第三方 AI 端点
  ipcMain.handle(IPC_CHANNELS.VIDEO_EXTRACT_FRAMES, async (_, req: {path?: unknown; timesSec?: unknown}) => {
    const filePath = typeof req?.path === 'string' ? req.path : '';
    if (!filePath || !isRegisteredMediaPath(filePath)) {
      throw new Error('素材未注册（仅可抽取故事板素材或本软件渲染产物）');
    }
    const times = Array.isArray(req?.timesSec) ? req.timesSec : [];
    if (times.length < 1 || times.length > 8) {
      throw new Error('timesSec 需为 1-8 个秒数');
    }
    for (const t of times) {
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
        throw new Error('timesSec 必须是 ≥0 的数字');
      }
    }
    const frames = [];
    for (const t of times) {
      frames.push(await extractFrame(filePath, t));
    }
    return frames;
  });

  // 缩略图墙（view_media_frames 的 contact-sheet 模式）：一张拼图 = 全片百帧信息
  ipcMain.handle(IPC_CHANNELS.VIDEO_CONTACT_SHEET, async (_, req: {path?: unknown; cells?: unknown}) => {
    const filePath = typeof req?.path === 'string' ? req.path : '';
    if (!filePath || !isRegisteredMediaPath(filePath)) {
      throw new Error('素材未注册（仅可拼接故事板素材或本软件渲染产物）');
    }
    const cells = typeof req?.cells === 'number' && Number.isFinite(req.cells) ? req.cells : 100;
    return makeContactSheet(filePath, Math.max(1, Math.min(144, Math.round(cells))));
  });

  // ====== 片语本地模型（付费版专属权重下载；门禁在渲染端 license 层，这里只供能力）======

  // 电脑状态检测：显卡/显存（注册表 qwMemorySize）+ ollama + 磁盘余量
  ipcMain.handle(IPC_CHANNELS.LOCAL_MODEL_DETECT, async () => {
    return detectLocalModelEnv(app.getPath('userData'));
  });

  // 下载队列单例（进度事件推渲染进程；重复 start 幂等返回当前态）
  let downloadService: LocalModelDownloadService | null = null;
  ipcMain.handle(IPC_CHANNELS.LOCAL_MODEL_DOWNLOAD_START, async () => {
    if (!downloadService) {
      downloadService = new LocalModelDownloadService(
        path.join(app.getPath('userData'), 'models', 'pianyu-2b'),
        app.getPath('userData'),
        (state: LocalModelDownloadState) => {
          try {
            ctx.getMainWindow()?.webContents.send(IPC_CHANNELS.LOCAL_MODEL_PROGRESS, state);
          } catch {
            // 窗口销毁瞬间发送失败可忽略
          }
        },
      );
    }
    // 不 await：启动即回当前快照（长任务走事件流；MCP/超时不背 4GB 下载）。
    // 换取 gating token 化下载地址（激活码在主进程持久凭证里；失败退直链）
    const {fetchModelDlUrls} = await import('../services/license');
    const urls = await fetchModelDlUrls();
    void downloadService.start(urls ?? undefined);
    return downloadService.getState();
  });

  ipcMain.handle(IPC_CHANNELS.LOCAL_MODEL_DOWNLOAD_CANCEL, async () => {
    downloadService?.cancel();
    return downloadService?.getState() ?? {status: 'idle'};
  });

  ipcMain.handle(IPC_CHANNELS.LOCAL_MODEL_DOWNLOAD_STATE, async () => {
    return downloadService?.getState() ?? {status: 'idle'};
  });
};
