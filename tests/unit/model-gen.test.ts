/**
 * 文生 3D（shared/model-gen.ts + generate_model 工具注册）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/model-gen.test.ts
 * （被测模块在 src/shared 下，不依赖 electron；fetch/sleep/时钟全部注入 mock）
 *
 * 覆盖：工具注册 → validateGenerateModelArgs → 状态归一化/进度钳制/错误文本/缓存键材料 →
 * createTextTo3dTask 建任务 → pollTextTo3dTask 轮询（成功流 / FAILED 流 / 超时流 / 协议异常）。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {LLM_TOOL_REGISTRY, validateGenerateModelArgs} from '../../src/shared/llm-tools.ts';
import {
  MODEL_GEN_DEFAULT_BASE_URL, MODEL_GEN_DEFAULT_MODEL,
  normalizeMeshyStatus, clampProgress, describeMeshyTaskError, meshyHttpErrorText,
  modelGenCacheKeyMaterial, createTextTo3dTask, pollTextTo3dTask,
} from '../../src/shared/model-gen.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** mock fetch：按队列/函数返回伪 Response，并记录调用 */
const mockFetch = (
  impl: (url: string, init?: {method?: string; headers?: Record<string, string>; body?: string}) => Promise<{ok: boolean; status: number; body: unknown}>,
  calls?: Array<{url: string; init?: unknown}>,
): typeof fetch => {
  return (async (url: unknown, init?: unknown) => {
    calls?.push({url: String(url), init});
    const r = await impl(String(url), init as {method?: string; headers?: Record<string, string>; body?: string});
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    } as Response;
  }) as unknown as typeof fetch;
};

const BASE_OPTS = {baseUrl: 'https://api.meshy.ai', apiKey: 'msy-test'};

// ====== 工具注册 ======

console.log('工具注册:');
{
  const entry = LLM_TOOL_REGISTRY.find((t) => t.name === 'generate_model');
  assert.ok(entry, 'generate_model 未注册');
  const params = entry.parameters as {required?: string[]; properties?: Record<string, unknown>};
  assert.deepEqual(params.required, ['prompt']);
  assert.equal(entry.sideEffect, true, '3D 生成烧额度应标记 sideEffect 弹确认卡');
  assert.ok(entry.description.includes('.glb'), 'description 应写明产物为 .glb');
  assert.ok(entry.description.includes('文生 3D'), 'description 应指向「设置 → 文生 3D」');
  assert.ok(params.properties && 'prompt' in params.properties && 'index' in params.properties && 'artStyle' in params.properties);
  ok('generate_model 已注册（required=[prompt]，sideEffect，prompt/index/artStyle）');
}

// ====== validateGenerateModelArgs ======

console.log('validateGenerateModelArgs:');
{
  const r = validateGenerateModelArgs({prompt: 'a low-poly rocket', index: 0, artStyle: 'cartoon'});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.prompt, 'a low-poly rocket');
    assert.equal(r.args.index, 0);
    assert.equal(r.args.artStyle, 'cartoon');
  }
  ok('全参数合法通过');
}
{
  const r = validateGenerateModelArgs({prompt: '  a cube  '});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.prompt, 'a cube', 'prompt 应 trim');
    assert.equal(r.args.index, undefined, 'index 缺省保留 undefined（执行器回退当前段）');
  }
  ok('仅 prompt 通过（trim，index/artStyle 缺省）');
}
{
  const long = 'x'.repeat(700);
  const r = validateGenerateModelArgs({prompt: long});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.args.prompt.length, 600, 'prompt 截断到 600');
  ok('超长 prompt 截断 600 字');
}
{
  for (const bad of [{}, {prompt: ''}, {prompt: '   '}, {prompt: 123}, null, undefined]) {
    const r = validateGenerateModelArgs(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0], /prompt/);
  }
  ok('缺/空/非字符串 prompt 报错');
}
{
  for (const bad of [{prompt: 'a', index: -1}, {prompt: 'a', index: 1.5}, {prompt: 'a', index: '0'}]) {
    const r = validateGenerateModelArgs(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0], /index/);
  }
  ok('负/非整数/非数字 index 报错');
}
{
  const r = validateGenerateModelArgs({prompt: 'a', artStyle: 42});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /artStyle/);
  ok('非字符串 artStyle 报错');
}

// ====== 纯函数：状态归一化 / 进度钳制 / 错误文本 / 缓存键 ======

console.log('纯函数:');
{
  assert.equal(normalizeMeshyStatus('PENDING'), 'PENDING');
  assert.equal(normalizeMeshyStatus('IN_PROGRESS'), 'IN_PROGRESS');
  assert.equal(normalizeMeshyStatus('SUCCEEDED'), 'SUCCEEDED');
  assert.equal(normalizeMeshyStatus('FAILED'), 'FAILED');
  assert.equal(normalizeMeshyStatus('in_progress'), 'IN_PROGRESS', '小写归一');
  assert.equal(normalizeMeshyStatus('QUEUED'), 'FAILED', '不认识的状态按 FAILED（不死等）');
  assert.equal(normalizeMeshyStatus(undefined), 'FAILED');
  assert.equal(normalizeMeshyStatus(null), 'FAILED');
  ok('normalizeMeshyStatus 映射（未知 → FAILED）');
}
{
  assert.equal(clampProgress(50), 50);
  assert.equal(clampProgress(-5), 0);
  assert.equal(clampProgress(150), 100);
  assert.equal(clampProgress('30'), 30);
  assert.equal(clampProgress(NaN), 0);
  assert.equal(clampProgress(undefined), 0);
  assert.equal(clampProgress(33.6), 34, '取整');
  ok('clampProgress 钳制 0-100 取整');
}
{
  assert.equal(describeMeshyTaskError({message: 'prompt rejected'}), '3D 生成失败：prompt rejected');
  assert.equal(describeMeshyTaskError('quota exceeded'), '3D 生成失败：quota exceeded');
  assert.equal(describeMeshyTaskError(null), '3D 生成失败（服务商未给出原因）');
  assert.equal(describeMeshyTaskError({}), '3D 生成失败（服务商未给出原因）');
  assert.equal(describeMeshyTaskError({message: '  '}), '3D 生成失败（服务商未给出原因）');
  ok('describeMeshyTaskError 结构/字符串/空值分支');
}
{
  assert.match(meshyHttpErrorText(401, ''), /API Key/);
  assert.match(meshyHttpErrorText(403, ''), /API Key/);
  assert.match(meshyHttpErrorText(429, ''), /限流/);
  assert.match(meshyHttpErrorText(500, 'Internal Error'), /HTTP 500.*Internal Error/);
  assert.match(meshyHttpErrorText(0, ''), /非 2xx/);
  ok('meshyHttpErrorText 401/429/500/无状态分支');
}
{
  const a = {baseUrl: 'https://api.meshy.ai', model: 'meshy-4', prompt: 'a rocket'};
  const b = {baseUrl: 'https://api.meshy.ai', model: 'meshy-4', prompt: 'a rocket', artStyle: 'cartoon'};
  const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
  assert.equal(modelGenCacheKeyMaterial(a), modelGenCacheKeyMaterial({...a}));
  assert.notEqual(modelGenCacheKeyMaterial(a), modelGenCacheKeyMaterial(b), 'artStyle 参与缓存键');
  assert.notEqual(modelGenCacheKeyMaterial(a), modelGenCacheKeyMaterial({...a, prompt: 'a car'}), 'prompt 参与缓存键');
  assert.notEqual(modelGenCacheKeyMaterial(a), modelGenCacheKeyMaterial({...a, model: 'meshy-5'}), 'model 参与缓存键');
  assert.equal(sha1(modelGenCacheKeyMaterial(a)), sha1(modelGenCacheKeyMaterial({...a})), '同材料 sha1 一致（缓存命中前提）');
  ok('modelGenCacheKeyMaterial 稳定性与区分度');
}
{
  assert.equal(MODEL_GEN_DEFAULT_BASE_URL, 'https://api.meshy.ai');
  assert.equal(MODEL_GEN_DEFAULT_MODEL, 'meshy-4');
  ok('默认端点/模型常量');
}

// ====== createTextTo3dTask ======

console.log('createTextTo3dTask:');
{
  const calls: Array<{url: string; init?: unknown}> = [];
  const fetchImpl = mockFetch(async () => ({ok: true, status: 200, body: {result: 'task-abc'}}), calls);
  const taskId = await createTextTo3dTask({...BASE_OPTS, fetchImpl}, {prompt: 'a rocket', artStyle: 'cartoon', negativePrompt: 'blurry'});
  assert.equal(taskId, 'task-abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.meshy.ai/v2/text-to-3d');
  const init = calls[0].init as {method: string; headers: Record<string, string>; body: string};
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer msy-test');
  const sent = JSON.parse(init.body);
  assert.equal(sent.mode, 'preview');
  assert.equal(sent.prompt, 'a rocket');
  assert.equal(sent.art_style, 'cartoon');
  assert.equal(sent.negative_prompt, 'blurry');
  ok('成功流：POST /v2/text-to-3d，Bearer 鉴权，mode=preview，风格/负提示透传');
}
{
  const calls: Array<{url: string; init?: unknown}> = [];
  const fetchImpl = mockFetch(async () => ({ok: true, status: 200, body: {result: 't1'}}), calls);
  await createTextTo3dTask({...BASE_OPTS, fetchImpl}, {prompt: 'a cube'});
  const sent = JSON.parse((calls[0].init as {body: string}).body);
  assert.equal('art_style' in sent, false, '缺省不带 art_style');
  assert.equal('negative_prompt' in sent, false, '缺省不带 negative_prompt');
  ok('可选字段缺省时不发');
}
{
  const fetchImpl = mockFetch(async () => ({ok: false, status: 401, body: 'Unauthorized'}));
  await assert.rejects(() => createTextTo3dTask({...BASE_OPTS, fetchImpl}, {prompt: 'x'}), /API Key/);
  ok('HTTP 401 → API Key 错误');
}
{
  const fetchImpl = mockFetch(async () => ({ok: true, status: 200, body: {}}));
  await assert.rejects(() => createTextTo3dTask({...BASE_OPTS, fetchImpl}, {prompt: 'x'}), /任务 id/);
  ok('响应缺 result → 协议错误');
}
{
  const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(() => createTextTo3dTask({...BASE_OPTS, fetchImpl}, {prompt: 'x'}), /无法连接文生 3D 服务/);
  ok('网络异常 → 无法连接');
}

// ====== pollTextTo3dTask ======

console.log('pollTextTo3dTask:');
{
  // 成功流：PENDING → IN_PROGRESS(50) → SUCCEEDED 返回 glb 地址
  const queue = [
    {ok: true, status: 200, body: {status: 'PENDING', progress: 0}},
    {ok: true, status: 200, body: {status: 'IN_PROGRESS', progress: 50}},
    {ok: true, status: 200, body: {status: 'SUCCEEDED', progress: 100, model_urls: {glb: 'https://cdn.meshy.ai/x.glb'}}},
  ];
  const calls: Array<{url: string; init?: unknown}> = [];
  const fetchImpl = mockFetch(async () => queue.shift()!, calls);
  const sleeps: number[] = [];
  const progress: Array<[string, number]> = [];
  const url = await pollTextTo3dTask(
    {...BASE_OPTS, fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); }, pollIntervalMs: 2500},
    'task-abc',
    (s, p) => progress.push([s, p]),
  );
  assert.equal(url, 'https://cdn.meshy.ai/x.glb');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.meshy.ai/v2/text-to-3d/task-abc');
  assert.deepEqual(progress, [['PENDING', 0], ['IN_PROGRESS', 50], ['SUCCEEDED', 100]]);
  assert.deepEqual(sleeps, [2500, 2500], '未完成状态各睡一跳');
  ok('成功流：PENDING→IN_PROGRESS→SUCCEEDED 返回 glb 地址（进度回调逐跳回报）');
}
{
  const queue = [
    {ok: true, status: 200, body: {status: 'IN_PROGRESS', progress: 20}},
    {ok: true, status: 200, body: {status: 'FAILED', progress: 20, task_error: {message: 'content policy violation'}}},
  ];
  const fetchImpl = mockFetch(async () => queue.shift()!);
  await assert.rejects(
    () => pollTextTo3dTask({...BASE_OPTS, fetchImpl, sleepImpl: async () => {}}, 't'),
    /3D 生成失败：content policy violation/,
  );
  ok('FAILED 流：task_error.message 进错误文本');
}
{
  // 超时流：假时钟随 sleep 前进，永远 PENDING，超过总超时抛错
  let now = 0;
  const fetchImpl = mockFetch(async () => ({ok: true, status: 200, body: {status: 'PENDING', progress: 5}}));
  await assert.rejects(
    () => pollTextTo3dTask(
      {...BASE_OPTS, fetchImpl, nowImpl: () => now, sleepImpl: async (ms) => { now += ms; }, pollIntervalMs: 2500, totalTimeoutMs: 5000},
      't',
    ),
    /超时/,
  );
  assert.ok(now > 5000, '假时钟应推进过超时线');
  ok('超时流：超过总超时抛「超时」错误');
}
{
  const fetchImpl = mockFetch(async () => ({ok: true, status: 200, body: {status: 'SUCCEEDED', progress: 100, model_urls: {}}}));
  await assert.rejects(
    () => pollTextTo3dTask({...BASE_OPTS, fetchImpl, sleepImpl: async () => {}}, 't'),
    /glb/,
  );
  ok('SUCCEEDED 但无 glb 地址 → 协议错误');
}
{
  const fetchImpl = mockFetch(async () => ({ok: false, status: 429, body: 'slow down'}));
  await assert.rejects(
    () => pollTextTo3dTask({...BASE_OPTS, fetchImpl, sleepImpl: async () => {}}, 't'),
    /限流/,
  );
  ok('轮询 HTTP 429 → 限流错误');
}
{
  const fetchImpl = mockFetch(async () => ({ok: true, status: 200, body: {status: 'QUEUED', progress: 0, task_error: 'weird'}}));
  await assert.rejects(
    () => pollTextTo3dTask({...BASE_OPTS, fetchImpl, sleepImpl: async () => {}}, 't'),
    /3D 生成失败：weird/,
  );
  ok('未知状态按 FAILED（不死等）');
}

console.log(`\n共 ${passed} 项全部通过`);
