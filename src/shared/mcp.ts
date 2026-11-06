/**
 * MCP 服务接口（第三方 Agent 接入）的共享契约。
 *
 * 架构：主进程内嵌 Streamable HTTP MCP 服务器（services/mcpServer.ts，仅绑 127.0.0.1 +
 * Bearer token 鉴权）；ListTools 由 LLM_TOOL_REGISTRY 派生（与 AI 助手同源，不另抄 schema），
 * CallTool 经 IPC 桥（mcp:execute / mcp:result）转发到渲染端执行（故事板状态在 zustand）。
 *
 * 本文件不 import 任何运行时依赖，主进程 / preload / 渲染端 / 单测都可直接引用。
 */

/** 默认端口（被占用时自动递增重试，最多 +20，见 services/mcpServer.ts） */
export const MCP_DEFAULT_PORT = 17890;
/** HTTP 端点路径（仅接受 POST） */
export const MCP_PATH = '/mcp';
/** 端口占用时的递增重试次数上限 */
export const MCP_MAX_PORT_RETRIES = 20;
/** 单次工具调用的超时（毫秒） */
export const MCP_CALL_TIMEOUT_MS = 120_000;

/** 桥接与设置的 IPC 频道名（preload / main / renderer 三端共用，避免散写字符串） */
export const MCP_CHANNELS = {
  /** 主 → 渲染：请求执行工具（payload: McpBridgeRequest） */
  EXECUTE: 'mcp:execute',
  /** 渲染 → 主：工具执行结果（payload: McpBridgeResponse） */
  RESULT: 'mcp:result',
  /** 渲染 → 主（invoke）：查询服务状态（返回 McpServerStatus） */
  GET_STATUS: 'mcp:getStatus',
  /** 渲染 → 主（invoke）：启用/停用服务（入参 boolean，返回 McpServerStatus） */
  SET_ENABLED: 'mcp:setEnabled',
  /** 渲染 → 主（invoke）：修改端口（入参 number，返回 McpServerStatus） */
  SET_PORT: 'mcp:setPort',
  /** 渲染 → 主（invoke）：重新生成接入 token（返回 McpServerStatus） */
  REGENERATE_TOKEN: 'mcp:regenerateToken',
  /** 渲染 → 主（invoke）：探测本机已装 agent 及其配置状态（返回 McpAgentListResult） */
  LIST_AGENTS: 'mcp:listAgents',
  /** 渲染 → 主（invoke）：一键写入指定 agent 的配置文件（入参 McpAgentId，返回 McpAgentInstallResult） */
  INSTALL_AGENT: 'mcp:installAgent',
} as const;

/** 主 → 渲染的工具执行请求 */
export interface McpBridgeRequest {
  /** 配对用调用 id（主进程生成，结果按它路由回等待中的 HTTP 请求） */
  callId: string;
  /** 工具名（LLM_TOOL_REGISTRY 的 name 或 EXTRA_MCP_TOOLS 里的扩展工具） */
  name: string;
  /** 已解析的参数对象 */
  args: Record<string, unknown>;
}

/** 工具执行的图片载荷（dataUrl 为 data:image/jpeg;base64,... 形式） */
export interface McpImagePayload {
  dataUrl: string;
  note: string;
}

/** 渲染 → 主的工具执行结果（与 ToolExecResult 对应，加 ok/error 表达异常） */
export interface McpBridgeResponse {
  callId: string;
  ok: boolean;
  /** 回给 agent 的 JSON 结果（映射为 MCP text block） */
  result?: unknown;
  image?: McpImagePayload;
  images?: McpImagePayload[];
  /** ok=false 时的中文错误信息（映射为 MCP isError 响应） */
  error?: string;
}

/** 设置页展示用的服务状态（token 明文仅出到本机渲染进程，用于展示/复制配置） */
export interface McpServerStatus {
  /** 设置里是否启用 */
  enabled: boolean;
  /** HTTP 服务是否正在监听 */
  running: boolean;
  /** 实际监听端口（未运行为 0；可能被自动递增，不一定等于配置端口） */
  port: number;
  /** 完整接入地址（未运行为空串） */
  url: string;
  /** 接入 token（Bearer） */
  token: string;
}

/** 支持一键接入的本机 agent（实现见 main/services/mcpAgentInstall.ts） */
export type McpAgentId = 'kimi' | 'claude' | 'codex' | 'openclaw' | 'zcode' | 'dsh';

/** 本机 agent 的探测结果（设置页「一键接入」分区展示用） */
export interface McpAgentInfo {
  id: McpAgentId;
  /** 展示名（如 Kimi Code CLI） */
  name: string;
  /** 是否检测到已安装（按配置目录/文件存在性判定） */
  installed: boolean;
  /** 配置里是否已有我们的 pianyu 条目 */
  configured: boolean;
  /** 配置文件绝对路径（不管是否存在，供「已接入」状态展示/排障） */
  configPath: string;
}

/** mcp:listAgents 的返回：agent 清单 + 当前服务地址（未启用/未运行为空串） */
export interface McpAgentListResult {
  agents: McpAgentInfo[];
  url: string;
}

/** mcp:installAgent 的返回（写入成功；失败直接抛中文错误） */
export interface McpAgentInstallResult {
  configPath: string;
  /** 原配置已存在时生成的备份路径（已有备份则不覆盖，沿用首次备份） */
  backupPath?: string;
  /** 给用户看的中文结果说明（含「重启后生效」） */
  message: string;
}

/** MCP 扩展工具（渲染端本地执行，不过 LLM 执行器；实现见 renderer/ai/mcpBridge.ts）
 *  注：get_app_status 已于 2026-11-03 收编进 LLM_TOOL_REGISTRY（EDGE 26→29 面），不再列在这里。 */
export const EXTRA_MCP_TOOLS = [
  {
    name: 'get_workflow_guide',
    description:
      '首次接入必读：返回片语按工程当前视频体裁组装的成片工作流指南（体裁分册剧本 + 三阶段调用序列 + 前置条件清单与调参纪律；set_video_type 切换体裁后返回对应分册）。无参数。',
    inputSchema: {type: 'object', properties: {}} as Record<string, unknown>,
  },
];
