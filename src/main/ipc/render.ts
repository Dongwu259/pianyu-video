/**
 * 渲染（Remotion 导出）IPC：输出目录选择、开始/取消渲染
 */

import {app, dialog, ipcMain} from 'electron';
import path from 'path';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import {executeRender, cancelRender, isRenderCancelledError, renderStoryboardStill, renderCoverStill} from '../services/renderer';
import {getEntitlement} from '../services/license';
import {getGlobalSettings} from '../services/store';
import {registerMediaPath} from '../services/videoServer';
import {getAspectRatioPreset, ASPECT_RATIO_PRESETS} from '../../shared/aspect-ratios';
import {sanitizeCoverConfig} from '../../shared/cover-presets';
import {EDITOR_UNRESTRICTED, outputLicensed} from '../../shared/editor-policy';
import type {MultiSegmentProps} from '../../shared/types';
import type {IpcCtx} from './ctx';

// 选择输出目录
// 渲染进程可传任意 outputLocation 让主进程写盘，因此只信任「对话框选过 / 设置页配置过 /
// 系统视频目录」之内的目录（见 RENDER_START / RENDER_COVER 的校验）
const allowedOutputDirs = new Set<string>();

/** 输出目录是否在可信集合内（渲染进程不可信，防任意写盘） */
const isTrustedOutputDir = (dir: string): boolean => {
  const trusted = new Set(allowedOutputDirs);
  trusted.add(path.resolve(app.getPath('videos')));
  const configured = getGlobalSettings().defaultOutputDir?.trim();
  if (configured) trusted.add(path.resolve(configured));
  return trusted.has(path.resolve(dir));
};

export const registerRenderIpc = (ctx: IpcCtx) => {
  ipcMain.handle(IPC_CHANNELS.FILE_SELECT_OUTPUT_DIR, async () => {
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return '';
    allowedOutputDirs.add(path.resolve(result.filePaths[0]));
    return result.filePaths[0];
  });

  // 开始渲染
  ipcMain.handle(IPC_CHANNELS.RENDER_START, async (event, job) => {
    try {
      // ====== 输出策略（2026-11-06 开源转型）======
      // 旧策略：免费版强制叠加水印 + 输出短边钳制 720px。
      // 新策略：编辑器本体不限制画质/水印——开源构建里客户端限制不可强制（任何人都能去掉重编译），
      // 留着只会推走用户；付费点收缩到「专有模型权重 + 模板包」。EDITOR_UNRESTRICTED=false 一键回退。
      const licensed = outputLicensed(getEntitlement());
      (job.inputProps as MultiSegmentProps).licensed = licensed;
      if (!EDITOR_UNRESTRICTED && !licensed && job.renderOptions) {
        // compositionId 形如 MultiSegment-<aspectRatioId>，从比例预设取基准分辨率
        const preset = getAspectRatioPreset(String(job.compositionId || '').replace(/^MultiSegment-/, ''));
        const maxScale = 720 / Math.min(preset.width, preset.height);
        job.renderOptions.scale = Math.min(job.renderOptions.scale ?? 1, maxScale);
      }

      // ====== 输出路径约束（渲染进程不可信）======
      // 只允许写入：对话框选过的目录 / 设置页默认输出目录 / 系统视频目录
      let outputLocation = String(job.outputLocation || '');
      // 「裸文件名」判定必须同时认 / 和 \（渲染端用正斜杠拼绝对路径——path.sep 只含 \，
      // 误判会把绝对路径拼到 Videos 目录下导致可信校验失败；实测踩坑）
      const isBareFileName = !/[\\/]/.test(outputLocation);
      if (outputLocation && isBareFileName) {
        outputLocation = path.join(app.getPath('videos'), outputLocation);
      }
      const outDir = path.resolve(path.dirname(outputLocation));
      if (!isTrustedOutputDir(outDir)) {
        return {success: false, error: `输出目录不可信：${outDir}\n请通过「选择目录」重新选择输出位置。`};
      }

      let usedFallback = false;

      const renderResult = await executeRender(
        {
          compositionId: job.compositionId,
          inputProps: job.inputProps,
          outputLocation,
          renderOptions: job.renderOptions,
        },
        (progress) => {
          ctx.getMainWindow()?.webContents.send(IPC_CHANNELS.RENDER_PROGRESS, {progress});
        }
      );

      // 如果返回的路径与请求不同，说明使用了兜底路径。
      // 用 path.resolve 归一化（useStartRender 用正斜杠拼路径，ensureExt 用 path.join 转反斜杠，
      // 不归一化会因分隔符不一致误判 usedFallback，弹假「原保存路径不可用」警报）。
      if (path.resolve(renderResult.outputPath) !== path.resolve(outputLocation)) {
        usedFallback = true;
      }

      // 成片注册进媒体白名单：AI 助手可用 view_media_frames 抽帧回看渲染产物
      registerMediaPath(renderResult.outputPath);

      return {
        success: true,
        outputPath: renderResult.outputPath,
        usedFallback,
        encoderUsed: renderResult.encoderUsed,
        encoderNote: renderResult.encoderNote,
        cacheInfo: renderResult.cacheInfo,
        // 内容指纹随渲染结果回传（渲染进程发起时计算，记入 lastRenderInfo 供 get_app_status 比对）
        contentFingerprint: typeof job.contentFingerprint === 'string' ? job.contentFingerprint : undefined,
      };
    } catch (error) {
      // 用户主动取消：不当作失败，渲染端据此静默复位
      if (isRenderCancelledError(error)) {
        return {success: false, cancelled: true, error: '渲染已取消'};
      }
      return {success: false, error: String(error)};
    }
  });

  // 取消正在进行的渲染（RenderPanel 取消按钮）
  ipcMain.handle(IPC_CHANNELS.RENDER_CANCEL, async () => {
    cancelRender();
    return true;
  });

  // 渲染故事板某时刻的静帧画面（AI preview_storyboard_frame 工具用）
  // 参数校验在主进程强制执行：aspectRatioId 白名单、timeSec 有限非负；licensed 同 render:start 覆写
  ipcMain.handle(IPC_CHANNELS.RENDER_STILL, async (_event, req) => {
    const inputProps = req?.inputProps;
    if (!inputProps || typeof inputProps !== 'object') {
      throw new Error('静帧渲染参数缺失（inputProps）');
    }
    const aspectRatioId = String(req?.aspectRatioId ?? '');
    if (!ASPECT_RATIO_PRESETS.some((p) => p.id === aspectRatioId)) {
      throw new Error(`未知画幅比例：${aspectRatioId || '(空)'}`);
    }
    const timeSec = Number(req?.timeSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) {
      throw new Error('timeSec 必须是 ≥0 的有限数字');
    }
    // 输出策略与 render:start 同口径（2026-11-06 开源转型：不再叠水印）
    (inputProps as MultiSegmentProps).licensed = outputLicensed(getEntitlement());
    return renderStoryboardStill(inputProps as Record<string, unknown>, aspectRatioId, timeSec);
  });

  // 渲染封面图（封面设计面板 / AI export_cover 工具用）：全片帧 + 封面覆盖层，
  // 全分辨率落盘到可信输出目录；参数校验与授权门禁在主进程强制执行
  ipcMain.handle(IPC_CHANNELS.RENDER_COVER, async (_event, req) => {
    const project = req?.inputProps;
    if (!project || typeof project !== 'object') {
      throw new Error('封面渲染参数缺失（inputProps）');
    }
    const aspectRatioId = String(req?.aspectRatioId ?? '');
    if (!ASPECT_RATIO_PRESETS.some((p) => p.id === aspectRatioId)) {
      throw new Error(`未知画幅比例：${aspectRatioId || '(空)'}`);
    }
    const timeSec = Number(req?.timeSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) {
      throw new Error('timeSec 必须是 ≥0 的有限数字');
    }
    // 输出目录：未配置时回落系统「视频」文件夹（与 RENDER_START 的裸文件名兜底同口径）——
    // AI 流水线/MCP 未配置目录时封面生成不再终止
    const outputDir = String(req?.outputDir ?? '').trim() || app.getPath('videos');
    if (!isTrustedOutputDir(outputDir)) {
      throw new Error(`输出目录不可用：${outputDir}\n请先在「设置 → 默认输出目录」配置，或在渲染导出页选择输出目录。`);
    }
    // 输出策略与 render:still 同口径（2026-11-06 开源转型：不再叠水印）
    (project as MultiSegmentProps).licensed = outputLicensed(getEntitlement());
    const cover = sanitizeCoverConfig(req?.cover);
    // 主体遮挡 mask：仅接受 PNG data URL（渲染进程 canvas 生成），体积上限 2MB
    const rawMask = typeof req?.maskDataUrl === 'string' ? req.maskDataUrl : '';
    const subjectMask = rawMask.startsWith('data:image/png;base64,') && rawMask.length < 2 * 1024 * 1024 ? rawMask : '';
    const result = await renderCoverStill(
      project as Record<string, unknown>,
      cover,
      aspectRatioId,
      timeSec,
      path.resolve(outputDir),
      String(req?.baseName ?? '片语'),
      subjectMask,
    );
    // 封面注册进媒体白名单：后续抽帧/回看走既有安全链路
    registerMediaPath(result.outputPath);
    return result;
  });
};
