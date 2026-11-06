/**
 * MCP 服务器（services/mcpServer.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/mcp-server.test.ts
 * （被测模块为纯 Node 实现，不依赖 electron；token/端口/桥全部经 deps 注入 mock）
 *
 * 覆盖：401 鉴权 → initialize 握手 → tools/list 工具清单与注册表同源 →
 * tools/call 桥接路由与 text/image 映射 → 未知工具 isError。
 */

import assert from 'node:assert/strict';
import {startMcpServer, stopMcpServer, getMcpServerStatus} from '../../src/main/services/mcpServer.ts';
import type {McpBridgeResult} from '../../src/main/services/mcpServer.ts';
import {LLM_TOOL_REGISTRY} from '../../src/shared/llm-tools.ts';
import {EXTRA_MCP_TOOLS, MCP_PATH} from '../../src/shared/mcp.ts';

const TEST_TOKEN = 'test-token-0123456789abcdef';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== mock 桥：记录调用并按工具名返回固定结果 ======

const bridgeCalls: {name: string; args: Record<string, unknown>}[] = [];
const mockBridge = {
  execute: async (name: string, args: Record<string, unknown>): Promise<McpBridgeResult> => {
    bridgeCalls.push({name, args});
    if (name === 'get_storyboard') {
      return {
        ok: true,
        result: {segments: [{index: 0, templateId: 'feature-trio'}]},
        image: {dataUrl: 'data:image/jpeg;base64,QUJDMTIz', note: '第1段画面'},
      };
    }
    if (name === 'get_templates') {
      return {ok: true, result: [{id: 'feature-trio'}]};
    }
    if (name === 'preview_storyboard_frame') {
      return {
        ok: true,
        result: {ok: true, timeSec: 0},
        images: [
          {dataUrl: 'data:image/jpeg;base64,AA==', note: 'f0'},
          {dataUrl: 'data:image/jpeg;base64,BB==', note: 'f1'},
        ],
      };
    }
    if (name === 'take_screenshot') {
      return {ok: false, error: '窗口已最小化，无法截图'};
    }
    return {ok: true};
  },
};

// ====== HTTP 辅助 ======

let baseUrl = '';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });

const authedPost = (body: unknown) => post(body, {Authorization: `Bearer ${TEST_TOKEN}`});

const rpc = async (method: string, params: unknown, id = 1) => {
  const res = await authedPost({jsonrpc: '2.0', id, method, params});
  assert.equal(res.status, 200, `${method} HTTP 状态异常：${res.status}`);
  return (await res.json()) as {result?: any; error?: any};
};

// ====== 测试主体 ======

const main = async () => {
  const port = await startMcpServer({
    getToken: () => TEST_TOKEN,
    getPort: () => 0, // 系统分配可用端口
    bridge: mockBridge,
    getVersion: () => '0.0.0-test',
    log: () => {},
  });
  assert.ok(port > 0, '未拿到实际监听端口');
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`测试服务已启动：${baseUrl}${MCP_PATH}\n`);

  try {
    // (a) 鉴权
    console.log('鉴权:');
    {
      const res = await post({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}});
      assert.equal(res.status, 401, `无 token 应 401，实际 ${res.status}`);
      ok('无 Authorization 头返回 401');
    }
    {
      const res = await post({jsonrpc: '2.0', id: 1, method: 'initialize', params: {}}, {Authorization: 'Bearer wrong-token'});
      assert.equal(res.status, 401, `错误 token 应 401，实际 ${res.status}`);
      ok('错误 token 返回 401');
    }
    {
      const res = await fetch(`${baseUrl}/other`, {method: 'GET'});
      assert.equal(res.status, 404, `非 MCP 路径应 404，实际 ${res.status}`);
      ok('非 /mcp 路径返回 404');
    }

    // (b) initialize 握手
    console.log('initialize:');
    {
      const r = await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {name: 'unit-test', version: '1.0'},
      });
      assert.ok(r.result, `initialize 无 result：${JSON.stringify(r)}`);
      assert.equal(r.result.serverInfo?.name, 'pianyu');
      assert.equal(r.result.serverInfo?.version, '0.0.0-test');
      assert.ok(r.result.capabilities?.tools, 'capabilities 缺 tools');
      ok('initialize 握手成功（serverInfo=pianyu/0.0.0-test）');
    }

    // (c) tools/list 与注册表同源
    console.log('tools/list:');
    {
      const r = await rpc('tools/list', {}, 2);
      const names = (r.result?.tools ?? []).map((t: {name: string}) => t.name).sort();
      const expected = [...LLM_TOOL_REGISTRY.map((e) => e.name), ...EXTRA_MCP_TOOLS.map((t) => t.name)].sort();
      assert.deepEqual(names, expected, '工具清单应等于 LLM_TOOL_REGISTRY ∪ EXTRA_MCP_TOOLS');
      const getTemplates = r.result.tools.find((t: {name: string}) => t.name === 'get_templates');
      assert.ok(getTemplates?.inputSchema?.type === 'object', 'inputSchema 应为 JSON Schema object');
      assert.ok(typeof getTemplates?.description === 'string' && getTemplates.description.length > 0, '缺描述');
      ok(`tools/list 返回 ${names.length} 个工具（注册表 + MCP 扩展），与唯一事实源一致`);
    }

    // (d) tools/call 桥接路由与 content 映射
    console.log('tools/call:');
    bridgeCalls.length = 0;
    {
      const r = await rpc('tools/call', {name: 'get_storyboard', arguments: {}}, 3);
      assert.equal(bridgeCalls.length, 1, 'mock 桥应被调用一次');
      assert.equal(bridgeCalls[0].name, 'get_storyboard');
      const content = r.result?.content ?? [];
      assert.equal(content[0]?.type, 'text', '第一个 block 应为 text');
      const parsed = JSON.parse(content[0].text);
      assert.equal(parsed.segments[0].templateId, 'feature-trio', 'text block 应携带桥返回的 JSON');
      assert.equal(content[1]?.type, 'image', '第二个 block 应为 image');
      assert.equal(content[1]?.data, 'QUJDMTIz', 'image data 应剥离 dataURL 前缀');
      assert.equal(content[1]?.mimeType, 'image/jpeg');
      assert.ok(!r.result.isError, '成功调用不应 isError');
      ok('result→text、image→image block（dataURL 前缀已剥离）映射正确');
    }
    {
      const r = await rpc('tools/call', {name: 'get_templates', arguments: {}}, 4);
      const content = r.result?.content ?? [];
      assert.equal(content.length, 1, '无图结果应只有 text block');
      assert.equal(content[0]?.type, 'text');
      ok('无图结果只返回 text block');
    }
    {
      const r = await rpc('tools/call', {name: 'preview_storyboard_frame', arguments: {timeSec: 1}}, 5);
      const content = r.result?.content ?? [];
      assert.equal(content.filter((c: {type: string}) => c.type === 'image').length, 2, 'images 应映射为多个 image block');
      assert.deepEqual(content.slice(1).map((c: {data: string}) => c.data), ['AA==', 'BB==']);
      ok('images 多图映射为多个 image block');
    }
    {
      const r = await rpc('tools/call', {name: 'take_screenshot', arguments: {}}, 6);
      assert.ok(r.result?.isError, '桥返回失败应 isError');
      assert.match(r.result.content[0].text, /窗口已最小化/, 'isError 应携带桥返回的中文错误');
      ok('桥返回错误映射为 isError + 中文错误信息');
    }

    // (e) 未知工具
    console.log('未知工具:');
    {
      const before = bridgeCalls.length;
      const r = await rpc('tools/call', {name: 'no_such_tool', arguments: {}}, 7);
      assert.ok(r.result?.isError, '未知工具应 isError');
      assert.match(r.result.content[0].text, /未知工具/, '应含中文提示');
      assert.equal(bridgeCalls.length, before, '未知工具不应转发到桥');
      ok('未知工具返回 isError 中文提示且不触发桥调用');
    }

    // 状态查询
    {
      const s = getMcpServerStatus();
      assert.equal(s.running, true);
      assert.equal(s.port, port);
      assert.equal(s.url, `${baseUrl}${MCP_PATH}`);
      ok('getMcpServerStatus 返回运行中/实际端口/完整 URL');
    }
  } finally {
    await stopMcpServer();
    assert.equal(getMcpServerStatus().running, false, '停止后不应还在运行');
    console.log('  ✓ stopMcpServer 停止服务');
    passed++;
  }

  console.log(`\n===== ${passed} 项全部通过 =====`);
};

main().catch((err) => {
  console.error('\n✗ 测试失败：', err);
  process.exit(1);
});
