/**
 * MCP 服务接口 - 内嵌 Streamable HTTP MCP 服务器（第三方 Agent 接入）。
 *
 * 架构见 shared/mcp.ts。本模块是**纯 Node 实现，绝不 import electron**（要能被 tsx 单测
 * 直接加载）；token 加解密、版本号、渲染端桥接等 electron 胶水全部经 McpServerDeps 注入，
 * 实现见 main/ipc/mcp.ts。
 *
 * 安全模型：
 * - 仅绑 127.0.0.1，且逐请求校验 Host 头必须是本机回环（挡 DNS rebinding）；
 * - 所有请求校验 `Authorization: Bearer <token>`，不符一律 401；
 * - 仅接受 POST {MCP_PATH}，其余方法与路径一律拒绝。
 */

import http from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createLlmTools} from '../../shared/llm-tools';
import {LLM_TOOL_REGISTRY} from '../../shared/llm-tools';
import {mergeTemplateMetas} from '../../shared/template-registry';
import type {TemplatePack} from '../../shared/template-pack';
import type {CustomTemplateDef} from '../../shared/custom-template';
import type {GeneratedTemplateDef} from '../../shared/generated-template';
import {BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS, TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS} from '../../shared/types';
import {
  EXTRA_MCP_TOOLS,
  MCP_CALL_TIMEOUT_MS,
  MCP_DEFAULT_PORT,
  MCP_MAX_PORT_RETRIES,
  MCP_PATH,
} from '../../shared/mcp';
import type {McpImagePayload} from '../../shared/mcp';

/** 渲染端执行结果（对应 renderer/ai/mcpBridge.ts 回传的 McpBridgeResponse 去 callId） */
export type McpBridgeResult =
  | {ok: true; result?: unknown; image?: McpImagePayload; images?: McpImagePayload[]}
  | {ok: false; error: string};

/** 渲染端工具执行桥：主进程把工具调用转发给渲染进程（实现见 main/ipc/mcp.ts） */
export interface McpToolBridge {
  execute: (name: string, args: Record<string, unknown>) => Promise<McpBridgeResult>;
}

export interface McpServerDeps {
  /** 取当前接入 token（每次请求都调，重新生成后无需重启服务即生效） */
  getToken: () => string;
  /** 取配置的监听端口（缺省/非法值由本模块回退 MCP_DEFAULT_PORT） */
  getPort: () => number;
  /** 渲染端工具执行桥 */
  bridge: McpToolBridge;
  /** 应用版本号（MCP initialize 握手返回的 serverInfo.version） */
  getVersion: () => string;
  /**
   * 工具 schema 的模板清单注入（自定义 + 已装市场模板与 AI 助手同源）；
   * 缺省仅用内置模板（单测场景）。
   */
  getTemplates?: () => {customTemplates: CustomTemplateDef[]; marketTemplates: TemplatePack[]; generatedTemplates?: GeneratedTemplateDef[]};
  /** 日志输出（缺省 console.log） */
  log?: (msg: string) => void;
}

let server: http.Server | null = null;
let deps: McpServerDeps | null = null;
/** 实际监听端口（被占用自动递增后的值；未运行为 0） */
let actualPort = 0;

const log = (msg: string) => (deps?.log ?? console.log)(`[McpServer] ${msg}`);

/** 已知工具名集合（注册表 + MCP 扩展工具），CallTool 先查它再转发 */
const KNOWN_TOOL_NAMES = new Set([...LLM_TOOL_REGISTRY.map((e) => e.name), ...EXTRA_MCP_TOOLS.map((t) => t.name)]);

/** initialize 握手下发的接入指引（MCP 协议标准 instructions 字段，agent 首次接入可见） */
const MCP_SERVER_INSTRUCTIONS =
  '片语是 Windows AI 全自动视频制作器（宣传片 / vlog / 口播 / 教程 / 卡点混剪），本接口可读写故事板、查看画面、触发渲染与录屏截图、长素材挖高光。' +
  '首次接入请先调用 get_workflow_guide，获取按工程体裁组装的成片工作流指南（体裁分册剧本 + 三阶段：素材采集 → 成片渲染 → 发布准备，含推荐调用序列、前置条件与调参纪律）；set_video_type 可切换体裁。' +
  '全自动两段式：用户想先过目再执行时 run_auto_pipeline(plan_only=true) 只出成片计划，确认或修改后 run_auto_pipeline(segments=计划) 执行。' +
  '素材采集：用 list_capture_sources / take_screenshot / start_screen_recording（可倒计时起录）/ stop_screen_recording（停录自动入段，可掐头去尾）主动收集录屏素材，用户已有素材用 import_segment_media 直接导入，不要假设素材已存在。' +
  '关键警告：set_storyboard 是整体重建，会清空全部片段素材——已有素材的片段一律用 update_segment 逐段修改。' +
  '渲染前确认用户已配置「设置 → 默认输出目录」；触发渲染后用 get_app_status 轮询进度与输出路径。';

/** ListTools：与 AI 助手同源（createLlmTools 派生），OpenAI 格式转 MCP 格式，再并上扩展工具 */
const listTools = () => {
  const d = deps!;
  const extra = d.getTemplates?.() ?? {customTemplates: [], marketTemplates: [], generatedTemplates: []};
  const llm = createLlmTools({
    templates: mergeTemplateMetas(extra.customTemplates, extra.marketTemplates, extra.generatedTemplates),
    transitions: TRANSITION_OPTIONS.map((t) => t.value),
    videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
    backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
    textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
  });
  return [
    ...llm.toolDefs.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
    })),
    ...EXTRA_MCP_TOOLS,
  ];
};

/** data:image/jpeg;base64,xxx → 纯 base64（MCP image block 的 data 字段） */
const stripDataUrlPrefix = (dataUrl: string): string => dataUrl.replace(/^data:image\/[a-z]+;base64,/i, '');

const imageToBlock = (img: McpImagePayload) => ({
  type: 'image' as const,
  data: stripDataUrlPrefix(img.dataUrl),
  mimeType: 'image/jpeg' as const,
});

/** 带超时的桥调用：超时按失败处理（渲染端可能卡死/窗口已关） */
const executeWithTimeout = async (name: string, args: Record<string, unknown>): Promise<McpBridgeResult> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      deps!.bridge.execute(name, args),
      new Promise<McpBridgeResult>((resolve) => {
        timer = setTimeout(() => resolve({ok: false, error: `工具执行超时（${MCP_CALL_TIMEOUT_MS / 1000} 秒），应用界面可能未就绪或正忙`}), MCP_CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** CallTool：未知工具直接 isError；桥结果映射为 MCP content blocks（result→text，image/images→image） */
const callTool = async (name: string, args: Record<string, unknown>) => {
  if (!KNOWN_TOOL_NAMES.has(name)) {
    return {
      content: [{type: 'text' as const, text: `未知工具：${name}，请先调用 tools/list 获取可用工具清单`}],
      isError: true,
    };
  }
  try {
    const r = await executeWithTimeout(name, args);
    if (!r.ok) {
      return {content: [{type: 'text' as const, text: r.error}], isError: true};
    }
    const content: ({type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string})[] = [
      {
        type: 'text',
        // 字符串结果（get_workflow_guide 的指南文本）原样下发，对象才 JSON 序列化
        text: r.result !== undefined ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)) : '执行成功（无返回内容）',
      },
    ];
    if (r.image) content.push(imageToBlock(r.image));
    for (const img of r.images ?? []) content.push(imageToBlock(img));
    return {content};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {content: [{type: 'text' as const, text: `工具执行失败：${msg}`}], isError: true};
  }
};

/** 每个请求一个无会话 Server + transport（stateless 模式，见 SDK 文档） */
const handleMcpRequest = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> => {
  const mcpServer = new Server(
    {name: 'pianyu', version: deps!.getVersion()},
    {capabilities: {tools: {}}, instructions: MCP_SERVER_INSTRUCTIONS},
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({tools: listTools()}));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
  );
  // Host 白名单含端口（SDK 是精确匹配 Host 头整串），按实际端口动态构造
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts: ['127.0.0.1', 'localhost', `127.0.0.1:${actualPort}`, `localhost:${actualPort}`, '[::1]', `[::1]:${actualPort}`],
    enableDnsRebindingProtection: true,
  });
  transport.onerror = (err) => log(`transport 错误: ${err.message}`);
  res.on('close', () => {
    void transport.close();
    void mcpServer.close();
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
};

const writeJson = (res: http.ServerResponse, status: number, obj: unknown): void => {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
};

/** 读请求体（≤10MB）并解析 JSON；失败抛错由调用方统一 400 */
const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });

const createHttpServer = (): http.Server =>
  http.createServer((req, res) => {
    // 整个回调必须无异常逸出（同 videoServer：回调异常会击穿主进程）
    void (async () => {
      const url = new URL(req.url || '', 'http://127.0.0.1');
      if (req.method !== 'POST' || url.pathname !== MCP_PATH) {
        writeJson(res, 404, {error: `Not Found（MCP 端点为 POST ${MCP_PATH}）`});
        return;
      }
      // Bearer token 鉴权（token 为空 = 未初始化，拒绝一切请求）
      const token = deps!.getToken();
      const auth = req.headers.authorization || '';
      if (!token || auth !== `Bearer ${token}`) {
        writeJson(res, 401, {error: '未授权：请在请求头携带 Authorization: Bearer <token>（token 见 设置 → Agent 接入（MCP））'});
        return;
      }
      const body = await readJsonBody(req);
      await handleMcpRequest(req, res, body);
    })().catch((err) => {
      console.error('[McpServer] 请求处理失败:', err);
      if (!res.headersSent) writeJson(res, 400, {error: `请求处理失败：${err instanceof Error ? err.message : String(err)}`});
      else res.end();
    });
  });

/**
 * 启动 MCP 服务器（幂等：已在运行直接返回当前端口）。
 * 端口被占用时从配置端口起递增重试（最多 +MCP_MAX_PORT_RETRIES）；
 * 配置端口为 0 时由系统分配（单测用）。
 * @returns 实际监听端口
 */
export const startMcpServer = (d: McpServerDeps): Promise<number> => {
  if (server) return Promise.resolve(actualPort);
  deps = d;
  const configured = d.getPort();
  const base = configured === 0 ? 0 : (Number.isInteger(configured) && configured >= 1024 && configured <= 65535 ? configured : MCP_DEFAULT_PORT);

  return new Promise((resolve, reject) => {
    const tryListen = (port: number, attemptsLeft: number) => {
      const srv = createHttpServer();
      srv.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0 && attemptsLeft > 0) {
          log(`端口 ${port} 被占用，尝试 ${port + 1}`);
          tryListen(port + 1, attemptsLeft - 1);
        } else {
          reject(err);
        }
      });
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('无法获取 MCP 服务器端口'));
          return;
        }
        server = srv;
        actualPort = addr.port;
        log(`MCP 服务已启动: http://127.0.0.1:${actualPort}${MCP_PATH}`);
        resolve(actualPort);
      });
    };
    tryListen(base, MCP_MAX_PORT_RETRIES);
  });
};

/** 停止 MCP 服务器（幂等；before-quit / 设置里停用时调用） */
export const stopMcpServer = (): Promise<void> =>
  new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const srv = server;
    server = null;
    actualPort = 0;
    srv.close(() => {
      log('MCP 服务已停止');
      resolve();
    });
  });

/** 当前运行状态（设置页状态行用） */
export const getMcpServerStatus = (): {running: boolean; port: number; url: string} => ({
  running: server !== null,
  port: actualPort,
  url: server ? `http://127.0.0.1:${actualPort}${MCP_PATH}` : '',
});
