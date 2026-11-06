/**
 * Agent 成片工作流指南（shared/agent-workflow.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/agent-workflow.test.ts
 * （被测模块在 src/shared 下，不依赖 electron，可被 tsx 直接加载）
 *
 * 覆盖：指南含关键章节（经典结构/两阶段流程/素材采集步骤/成片调用序列/set_storyboard 警告/输出目录前置）→
 * buildSystemPrompt() 原样嵌入同一份指南（单一事实源）→ MCP 扩展工具清单含 get_workflow_guide。
 */

import assert from 'node:assert/strict';
import {AGENT_WORKFLOW_GUIDE} from '../../src/shared/agent-workflow.ts';
import {buildSystemPrompt} from '../../src/shared/llm-prompt.ts';
import {EXTRA_MCP_TOOLS} from '../../src/shared/mcp.ts';
import {LLM_TOOL_REGISTRY} from '../../src/shared/llm-tools.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 指南关键章节 ======

console.log('指南关键章节:');
{
  // 经典成片结构：片头 → 2-4 段功能展示 → CTA 收尾
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('经典成片结构'), '缺「经典成片结构」章节');
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('BrandIntro') && AGENT_WORKFLOW_GUIDE.includes('OutroCTA'), '经典结构缺首尾模板');
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('2-4 段'), '经典结构缺功能段数量');
  ok('经典成片结构（BrandIntro → 2-4 段 → OutroCTA）');
}
{
  // 两阶段结构：素材采集 → 成片
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('阶段一 · 素材采集'), '缺「阶段一 · 素材采集」章节');
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('阶段二 · 成片'), '缺「阶段二 · 成片」章节');
  for (const kw of ['list_capture_sources', 'take_screenshot', 'start_screen_recording', 'stop_screen_recording', 'view_media_frames', 'countdownSec', 'trimStartSec', 'import_segment_media']) {
    assert.ok(AGENT_WORKFLOW_GUIDE.includes(kw), `素材采集阶段缺 ${kw}`);
  }
  ok('阶段一 · 素材采集（6 步，含录屏工具链与新参数）');
}
{
  // 阶段二成片调用序列（9 步）的关键工具节点
  for (const kw of ['get_app_status', 'search_templates', 'get_templates', 'get_storyboard', 'update_segment', 'set_segment_captions', 'set_logo', 'preview_storyboard_frame', 'request_render', 'renderOutputPath']) {
    assert.ok(AGENT_WORKFLOW_GUIDE.includes(kw), `成片序列缺 ${kw}`);
  }
  ok('阶段二 · 成片覆盖 9 步关键工具');
}
{
  // set_storyboard 清空素材警告
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('set_storyboard'), '缺 set_storyboard 警告');
  const idx = AGENT_WORKFLOW_GUIDE.indexOf('set_storyboard');
  assert.ok(AGENT_WORKFLOW_GUIDE.slice(Math.max(0, idx - 80), idx + 120).includes('清空'), 'set_storyboard 附近缺「清空」警告');
  ok('set_storyboard 清空素材警告');
}
{
  // 前置条件清单：默认输出目录 / TTS·ASR key / CursorFollow 轨迹
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('前置条件'), '缺「前置条件清单」章节');
  for (const kw of ['默认输出目录', 'TTS', 'ASR', 'CursorFollow']) {
    assert.ok(AGENT_WORKFLOW_GUIDE.includes(kw), `前置条件缺 ${kw}`);
  }
  ok('前置条件清单（输出目录/TTS·ASR/CursorFollow）');
}
{
  // 调参纪律：paramSpecs + 不要全默认
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('调参纪律'), '缺「调参纪律」章节');
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('paramSpecs'), '调参纪律缺 paramSpecs');
  assert.ok(AGENT_WORKFLOW_GUIDE.includes('不要一律留默认值'), '调参纪律缺「不要全默认」');
  ok('调参纪律（paramSpecs，不全默认）');
}

// ====== 单一事实源：内置助手提示词嵌入同一份指南 ======

console.log('buildSystemPrompt 单源嵌入:');
{
  const prompt = buildSystemPrompt();
  assert.ok(prompt.includes(AGENT_WORKFLOW_GUIDE), '系统提示词未原样嵌入 AGENT_WORKFLOW_GUIDE');
  ok('buildSystemPrompt() 输出包含完整指南文本');
}

// ====== MCP 扩展工具清单 ======

console.log('MCP 扩展工具注册:');
{
  const names = EXTRA_MCP_TOOLS.map((t) => t.name);
  // 2026-11-03 收编：get_app_status 从 EXTRA_MCP_TOOLS 移入 LLM_TOOL_REGISTRY（EDGE 26→29 面）。
  // MCP 面仍可用（mcpServer 列表 = 注册表 + 扩展工具），但不再算「扩展工具」。
  assert.ok(!names.includes('get_app_status'), 'get_app_status 已收编进注册表，不应再列在 EXTRA_MCP_TOOLS');
  assert.ok(LLM_TOOL_REGISTRY.some((t) => t.name === 'get_app_status'), 'get_app_status 未注册进 LLM_TOOL_REGISTRY');
  assert.ok(names.includes('get_workflow_guide'), '缺 get_workflow_guide');
  const guide = EXTRA_MCP_TOOLS.find((t) => t.name === 'get_workflow_guide')!;
  assert.ok(guide.description.includes('首次接入必读'), 'description 缺「首次接入必读」');
  assert.deepEqual(guide.inputSchema, {type: 'object', properties: {}});
  ok('get_workflow_guide 已注册（无参数），get_app_status 走注册表');
}

console.log(`\n共 ${passed} 项全部通过`);
