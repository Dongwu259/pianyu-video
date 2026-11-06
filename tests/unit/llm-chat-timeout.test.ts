/**
 * 本地端点判定与超时自适应（shared/llm-chat.ts isLlmLoopback / llmTimeoutMs）单测：
 * loopback 识别（Ollama/llama.cpp/vLLM 自托管形态）与按端点的超时矩阵。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/llm-chat-timeout.test.ts
 */
import {isLlmLoopback, llmTimeoutMs} from '../../src/shared/llm-chat';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

// ====== isLlmLoopback ======
ok(isLlmLoopback('http://127.0.0.1:11434/v1'), 'Ollama loopback');
ok(isLlmLoopback('http://localhost:8080'), 'localhost');
ok(isLlmLoopback('http://localhost'), '无端口 localhost');
ok(isLlmLoopback('http://[::1]:11434/v1'), 'IPv6 loopback');
ok(isLlmLoopback('http://0.0.0.0:8080'), '0.0.0.0 监听');
ok(isLlmLoopback('  http://127.0.0.1:11434/v1  '), '首尾空白容忍');
ok(!isLlmLoopback('https://open.bigmodel.cn/api/paas/v4'), '云端：智谱');
ok(!isLlmLoopback('https://api.siliconflow.cn/v1'), '云端：硅基流动');
ok(!isLlmLoopback('http://192.168.1.5:8080'), '局域网地址不算 loopback（可能是另一台机器）');
ok(!isLlmLoopback(''), '空串');
ok(!isLlmLoopback('https://evil.com/host=127.0.0.1'), '域名里带 loopback 字样不算');

// ====== llmTimeoutMs ======
ok(llmTimeoutMs(false, 'https://open.bigmodel.cn/api/paas/v4') === 30_000, '云端纯文本 30s（基线不变）');
ok(llmTimeoutMs(true, 'https://open.bigmodel.cn/api/paas/v4') === 180_000, '云端含图 180s（基线不变）');
ok(llmTimeoutMs(false, 'http://127.0.0.1:11434/v1') === 120_000, '本地纯文本 120s');
ok(llmTimeoutMs(true, 'http://127.0.0.1:11434/v1') === 300_000, '本地含图 300s');

console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
