/**
 * MCP 渲染端桥 - 主进程转发的第三方 agent 工具调用在这里执行。
 *
 * 主进程 mcpServer.ts 只负责 HTTP/鉴权/协议，工具一律桥接到渲染进程执行（故事板状态在
 * zustand）。收到 mcp:execute 后：
 * - get_app_status：本地直接读取 store + app:get-info 组装状态；
 * - get_workflow_guide：本地直接返回 agent-workflow.ts 按工程当前体裁组装的分册指南；
 * - 其余工具：复用 executeLlmTool（与 AI 助手同一套执行器），差异仅在上下文：
 *   - requestConfirm 自动批准（启用 MCP 即视为信任持有 token 的本机 agent；
 *     设置页文案已明示「副作用操作将自动执行」）；
 *   - onRequestRender 不弹确认卡，直接后台启动渲染并立即回执（进度用 get_app_status 轮询）。
 * 结果经 mcp:result 回传主进程配对（callId）。
 */

import {useProjectStore} from '../store/projectStore';
import {createLlmTools} from '../../shared/llm-tools';
import {mergeTemplateMetas} from '../../shared/template-registry';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS} from '../../shared/types';
import type {McpBridgeRequest, McpBridgeResponse} from '../../shared/mcp';
import {buildWorkflowGuide} from '../../shared/agent-workflow';
import {executeLlmTool} from './toolExecutors';
import type {ToolExecContext} from './toolExecutors';
import {startRenderFromStore} from '../render/startRender';
import {getAppStatus} from './appStatus';

/** MCP 专用执行上下文：与 AIAssistantPanel 同 deps，差异在确认/渲染两个钩子（见文件头注释） */
const buildMcpContext = (): ToolExecContext => {
  const st = useProjectStore.getState();
  return {
    llm: createLlmTools({
      templates: mergeTemplateMetas(st.customTemplates, st.marketTemplates, st.generatedTemplates),
      transitions: TRANSITION_OPTIONS.map((t) => t.value),
      videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
      backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
      textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
    }),
    getStore: () => useProjectStore.getState(),
    // 副作用操作（TTS/ASR/录屏/截屏）自动执行：启用 MCP 即视为信任持有 token 的 agent
    requestConfirm: () => Promise.resolve(true),
    onRequestRender: () => {
      const store = useProjectStore.getState();
      if (store.isRendering) {
        return {message: '渲染已在进行中，可调用 get_app_status 查询进度'};
      }
      if (store.segments.length === 0) {
        return {message: '渲染未启动：故事板为空，请先用 set_storyboard 搭建故事板'};
      }
      // 未配置输出目录不再终止：成片自动落到系统「视频」文件夹（路径随 get_app_status 回传）
      // 后台渲染：启动失败只影响 store 渲染态，agent 用 get_app_status 轮询进度/结果
      void startRenderFromStore(store.appSettings.defaultOutputDir, undefined, {whenNoOutputDir: 'videos', confirmMissingTemplates: false});
      return {message: '渲染已在后台进行，可调用 get_app_status 查询进度'};
    },
  };
};

const handleRequest = async (req: McpBridgeRequest): Promise<void> => {
  let resp: McpBridgeResponse;
  try {
    const out =
      req.name === 'get_app_status'
        ? await getAppStatus()
        : req.name === 'get_workflow_guide'
          ? {result: buildWorkflowGuide(useProjectStore.getState().videoType)}
          : await executeLlmTool(req.name, JSON.stringify(req.args ?? {}), buildMcpContext());
    resp = {callId: req.callId, ok: true, result: out.result, image: out.image, images: out.images};
  } catch (err) {
    resp = {callId: req.callId, ok: false, error: err instanceof Error ? err.message : String(err)};
  }
  window.api.mcpExecuteResult(resp);
};

let unsubscribe: (() => void) | null = null;

/**
 * 挂载 MCP 桥（幂等；App.tsx useEffect 调用，返回清理函数）。
 * 窗口重载后 effect 重新执行即可恢复订阅，主进程 pending 调用有超时兜底。
 */
export const initMcpBridge = (): (() => void) => {
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = null;
  };
  if (!window.api?.onMcpExecute) return () => {};
  if (unsubscribe) return cleanup;
  unsubscribe = window.api.onMcpExecute((req) => {
    void handleRequest(req);
  });
  return cleanup;
};
