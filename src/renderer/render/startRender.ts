/**
 * 渲染发起的纯函数实现（从 useStartRender 抽出）。
 *
 * 与 UI 解耦后两处共用：useStartRender（渲染导出页 / AI 助手确认卡，行为不变）
 * 与 MCP 桥（renderer/ai/mcpBridge.ts，无弹窗、输出目录取自设置）。
 * 主进程 RENDER_START 的授权闸门（水印 / 720p 钳制）不变，本函数不绕过任何限制。
 */

import {useProjectStore} from '../store/projectStore';
import {isDataDrivenTemplateId, findDataDrivenDef, isGeneratedTemplateId, findGeneratedDef} from '../../shared/template-registry';
import type {MultiSegmentProps, RenderEncoderUsed, RenderFormat, X264Preset} from '../../shared/types';
import {getSfxSources} from '../sfx/sfxSources';
import {currentContentFingerprint} from './contentFingerprint';

export interface StartRenderResult {
  success: boolean;
  /** 实际输出路径（成功时） */
  outputPath?: string;
  /** 原路径不可用、落到了兜底路径 */
  usedFallback?: boolean;
  /** 实际使用的编码器（成功时） */
  encoderUsed?: RenderEncoderUsed;
  /** 硬件编码不可用/失败回退软件编码的提示（成功时可能有） */
  encoderNote?: string;
  /** 段级渲染缓存命中情况（≥3 段且未回退整片单渲时提供） */
  cacheInfo?: {hit: number; total: number};
  /** 用户主动取消（非失败，调用方不应报错） */
  cancelled?: boolean;
  /** 失败原因（中文） */
  error?: string;
}

export interface StartRenderOptions {
  /**
   * 输出目录为空时的处理：
   * 'prompt'（默认）= 弹目录选择框（与 RenderPanel 一致）；
   * 'error' = 不弹框，返回中文错误（引导用户先在设置里配默认输出目录）；
   * 'videos' = 不弹框不报错，发裸文件名由主进程落到系统「视频」文件夹
   *   （AI 流水线 / MCP 桥用：未配置输出目录不再终止流程，成片路径随结果回传）
   */
  whenNoOutputDir?: 'prompt' | 'error' | 'videos';
  /**
   * 有片段引用未安装的数据驱动模板时是否弹确认框（默认 true，与 RenderPanel 一致）；
   * MCP 桥传 false：不打扰用户，直接渲染（缺失模板的片段按既有逻辑被跳过）
   */
  confirmMissingTemplates?: boolean;
}

/**
 * 按当前 store 状态发起一次渲染：
 * - 先把工作副本刷入故事板，再按 store 最新状态组装 compositionId / inputProps
 * - 渲染状态（isRendering/renderProgress/输出路径）写入全局 store，进度监听由调用方各自负责
 * - overrides：批量导出等场景按 job 覆盖画幅与文件名（缺省用 store 当前值）；
 *   renderSettings 部分覆盖用于「快速预览」等场景——不动 store 里用户保存的设置，仅本次渲染生效
 */
export interface StartRenderOverrides {
  aspectRatioId?: string;
  filename?: string;
  /** 渲染设置临时覆盖（快速预览：低分辨率 + 高 CRF + 极速编码，仅本次渲染生效） */
  renderSettings?: {crf?: number; scale?: number; x264Preset?: X264Preset; muted?: boolean};
  /** 强制重渲段（一次性，不持久化）：这些段±邻段的缓存块跳过命中直接重渲（时间轴右键「重渲此段」） */
  forceSegments?: number[];
}

export const startRenderFromStore = async (
  outputDir: string,
  overrides?: StartRenderOverrides,
  options?: StartRenderOptions,
): Promise<StartRenderResult> => {
  const store = useProjectStore.getState();
  store.syncCurrentToSegment();
  const {segments, editPlan, orientation, aspectRatioId, bgm, sfx, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood, renderSettings, customTemplates, marketTemplates, generatedTemplates} = useProjectStore.getState();
  if (segments.length === 0) {
    return {success: false, error: '故事板为空，无法渲染'};
  }

  // 渲染前检查：引用未安装数据驱动模板（自定义已删/市场未装）或已删除 AI 生成模板的片段会被静默跳过，
  // 先显式确认，避免渲完才发现缺段
  const missingIds = segments
    .filter((s) =>
      (isDataDrivenTemplateId(s.templateId) && !findDataDrivenDef(s.templateId, customTemplates, marketTemplates)) ||
      (isGeneratedTemplateId(s.templateId) && !findGeneratedDef(s.templateId, generatedTemplates)),
    )
    .map((s) => s.templateId);
  if (missingIds.length > 0 && (options?.confirmMissingTemplates ?? true)) {
    const names = missingIds.map((id) => id.replace(/^mkt-/, '').replace(/^custom-/, '').replace(/^gen-/, '')).join('、');
    const go = window.confirm(
      `有 ${missingIds.length} 个片段引用的模板未安装（${names}），渲染时这些片段会被跳过。\n云端模板可到「模板市场」安装。\n\n仍要继续渲染吗？`,
    );
    if (!go) return {success: false, error: '已取消渲染（模板未安装）'};
  }

  store.startRendering();
  // 内容指纹在发起这一刻算（AI 确认卡流程 = 用户点「开始渲染」那一刻），
  // 随渲染请求送到主进程并记入渲染结果；get_app_status 用它比对「成片是不是当前版本」
  const contentFingerprint = currentContentFingerprint(useProjectStore.getState());
  const renderStartedAt = Date.now();
  try {
    // 优先使用已选/默认输出目录；未设置时按选项弹框、报错或落到系统视频文件夹
    let dir = outputDir;
    if (!dir) {
      if (options?.whenNoOutputDir === 'error') {
        store.resetRendering();
        return {success: false, error: '未设置输出目录：请先在「设置 → 默认输出目录」里配置，agent 触发的渲染不再弹框选择'};
      }
      if (options?.whenNoOutputDir !== 'videos') {
        dir = await window.api.selectOutputDir();
      }
      // 'videos'：dir 保持空 → outputPath 为裸文件名，主进程 RENDER_START 会落到系统「视频」文件夹（可信目录）
    }
  const baseName = overrides?.filename ?? (renderSettings.filename || `promo-${Date.now()}`);
  const effectiveSettings = {...renderSettings, ...(overrides?.renderSettings ?? {}), ...(overrides?.forceSegments ? {forceSegments: overrides.forceSegments} : {})};
  const formatExt: Record<RenderFormat, string> = {mp4: '.mp4', 'mp4-hevc': '.mp4', mov: '.mov', webm: '.webm', gif: '.gif'};
  const ext = formatExt[effectiveSettings.format] || '.mp4';
  const outputPath = dir ? `${dir}/${baseName}${ext}` : `${baseName}${ext}`;

  const compositionId = `MultiSegment-${overrides?.aspectRatioId ?? aspectRatioId}`;

  // 音效源表：内置库 URL（SFX 关闭时也要传配置，合成器据此跳过放置）
  const sfxSources = await getSfxSources();

  const result = await window.api.startRender({
    compositionId,
    inputProps: {segments, editPlan: editPlan ?? undefined, orientation, customTemplates: [...customTemplates, ...marketTemplates.map((t) => t.def)], generatedTemplates, bgm, sfx, sfxSources, texture, beatPulse, cursor, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood} as MultiSegmentProps,
    outputLocation: outputPath,
    renderOptions: effectiveSettings,
    contentFingerprint,
  });

    if (result.success) {
      const finalPath = result.outputPath || outputPath;
      const st = useProjectStore.getState();
      st.finishRendering(finalPath);
      // 渲染结果回读：确认「成片对应哪版内容」（get_app_status 的 lastRender 比对当前指纹）
      st.setLastRenderInfo({
        outputPath: finalPath,
        finishedAt: new Date().toISOString(),
        durationSec: Math.round((Date.now() - renderStartedAt) / 100) / 10,
        segmentCount: segments.length,
        fingerprint: result.contentFingerprint ?? contentFingerprint,
        ...(result.cacheInfo ? {cacheStats: result.cacheInfo} : {}),
      });
      return {
        success: true,
        outputPath: finalPath,
        usedFallback: result.usedFallback,
        encoderUsed: result.encoderUsed,
        encoderNote: result.encoderNote,
        cacheInfo: result.cacheInfo,
      };
    }
    useProjectStore.getState().resetRendering();
    // 用户取消不视为失败
    if (result.cancelled) return {success: false, cancelled: true};
    return {success: false, error: result.error || '渲染失败，请重试'};
  } catch (err) {
    useProjectStore.getState().resetRendering();
    return {success: false, error: String(err)};
  }
};
