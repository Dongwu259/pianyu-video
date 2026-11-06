/**
 * 渲染触发 Hook - 组装渲染任务并发起渲染
 *
 * 从 RenderPanel 的 handleRender 抽出，供「渲染导出」页与 AI 助手的渲染确认卡共用。
 * 核心逻辑在 render/startRender.ts 的 startRenderFromStore（纯函数，MCP 桥也走它），
 * 本 hook 只是薄封装（行为与抽离前完全一致：空目录弹选择框、缺失模板弹确认框）。
 * 主进程 RENDER_START 的授权闸门（水印 / 720p 钳制）不变，本 hook 不绕过任何限制。
 */

import {useCallback} from 'react';
import {startRenderFromStore} from '../render/startRender';
import type {StartRenderResult, StartRenderOverrides} from '../render/startRender';

export type {StartRenderResult};

/**
 * 返回一个发起渲染的函数（参数语义见 startRenderFromStore）：
 * - outputDir 为空时弹目录选择框（与 RenderPanel 行为一致）
 * - 渲染状态（isRendering/renderProgress/输出路径）写入全局 store，进度监听由调用方各自负责
 */
export const useStartRender = () => {
  return useCallback(
    async (outputDir: string, overrides?: StartRenderOverrides): Promise<StartRenderResult> =>
      startRenderFromStore(outputDir, overrides),
    [],
  );
};
