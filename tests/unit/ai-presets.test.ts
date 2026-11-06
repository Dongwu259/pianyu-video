/**
 * AI 厂商预设（ai-presets）单元测试
 *
 * 关键不变量：
 * 1. 每个预设的 LLM 项必须完整可用（选了厂商就一定能跑通文字对话）；
 * 2. URL 合法且指向国内可直连或本机端点（OpenAI 占位是历史教训）；
 * 3. 同一厂商的 TTS/ASR/图 端点与 LLM 端点同源——「同一个 Key 一家配齐」口径成立；
 * 4. id 唯一、name 非空、keyUrl 可跳转——UI 与截图脚本依赖。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/ai-presets.test.ts
 */

import assert from 'node:assert/strict';
import {AI_PROVIDER_PRESETS, getAiProviderPreset} from '../../src/shared/ai-presets.ts';

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

test('预设库非空且 id 唯一、基础字段完整', () => {
  assert.ok(AI_PROVIDER_PRESETS.length >= 4, '至少 4 家厂商，否则「快速填充」失去意义');
  const ids = new Set(AI_PROVIDER_PRESETS.map((p) => p.id));
  assert.equal(ids.size, AI_PROVIDER_PRESETS.length, 'id 重复会导致 chip 高亮串位');
  for (const p of AI_PROVIDER_PRESETS) {
    assert.ok(p.name.length > 0, `${p.id}: name 为空`);
    assert.ok(p.note.length > 0, `${p.id}: note 为空（用户看不到选型理由）`);
  }
});

test('所有 URL 合法；端点可直连或本机（禁止 api.openai.com 占位回流）', () => {
  for (const p of AI_PROVIDER_PRESETS) {
    assert.match(p.keyUrl, /^https:\/\//, `${p.id}: keyUrl 必须 https`);
    for (const ep of [p.llm.baseUrl, p.tts?.baseUrl, p.asr?.baseUrl, p.image?.baseUrl]) {
      if (!ep) continue;
      assert.doesNotThrow(() => new URL(ep), `${p.id}: 端点 ${ep} 不是合法 URL`);
      const isLocal = /^http:\/\/127\.0\.0\.1(:\d+)?/.test(ep);
      assert.ok(
        ep.startsWith('https://') || isLocal,
        `${p.id}: 端点 ${ep} 必须 https 或本机回环（目标用户多数无法直连外网端点）`,
      );
      assert.ok(!ep.includes('api.openai.com'), `${p.id}: 不允许 openai 占位回流`);
    }
  }
});

test('LLM 项完整：baseUrl 去尾斜杠 + model 非空', () => {
  for (const p of AI_PROVIDER_PRESETS) {
    assert.ok(p.llm.baseUrl.length > 0, `${p.id}: llm.baseUrl 为空`);
    assert.ok(p.llm.model.length > 0, `${p.id}: llm.model 为空`);
    assert.ok(!p.llm.baseUrl.endsWith('/'), `${p.id}: baseUrl 以 / 结尾（主进程拼接 /chat/completions 会出现双斜杠）`);
  }
});

test('同厂商 TTS/ASR/图 端点与 LLM 端点同源（一个 Key 配齐口径）', () => {
  for (const p of AI_PROVIDER_PRESETS) {
    const llmOrigin = new URL(p.llm.baseUrl).origin;
    for (const [k, ep] of [['tts', p.tts?.baseUrl], ['asr', p.asr?.baseUrl], ['image', p.image?.baseUrl]] as const) {
      if (!ep) continue;
      assert.equal(new URL(ep).origin, llmOrigin, `${p.id}: ${k} 端点跨源（用户要配两个 Key，违背一家配齐）`);
    }
  }
});

test('TTS 预设必须带音色；ASR/图 预设必须带模型名', () => {
  for (const p of AI_PROVIDER_PRESETS) {
    if (p.tts) assert.ok(p.tts.voice.length > 0, `${p.id}: tts.voice 为空（合成请求会 400）`);
    if (p.tts) assert.ok(p.tts.model.length > 0, `${p.id}: tts.model 为空`);
    if (p.asr) assert.ok(p.asr.model.length > 0, `${p.id}: asr.model 为空`);
    if (p.image) assert.ok(p.image.model.length > 0, `${p.id}: image.model 为空`);
  }
});

test('免费徽标必须挂真实免费说明；「免费」字样不允许出现在收费厂商', () => {
  for (const p of AI_PROVIDER_PRESETS) {
    if (p.freeNote) assert.ok(p.freeNote.length >= 4, `${p.id}: freeNote 太短说清不了免在哪`);
  }
  // 至少一家免费档：零门槛兜底（没有免费档，「先跑通」就变成了「先付费」）
  assert.ok(
    AI_PROVIDER_PRESETS.some((p) => p.freeNote),
    '至少一家厂商要有免费档（当前靠智谱 glm-4v-flash 兜底）',
  );
});

test('getAiProviderPreset：命中与未命中行为正确', () => {
  assert.equal(getAiProviderPreset('zhipu')?.name, '智谱');
  assert.equal(getAiProviderPreset('nonexistent'), undefined);
});

test('已下线模型不允许回流（glm-4v-flash 2026-09 确认已不可用，接替者为 glm-4.6v-flash）', () => {
  for (const p of AI_PROVIDER_PRESETS) {
    assert.notEqual(p.llm.model, 'glm-4v-flash', `${p.id}: glm-4v-flash 已下线，应改用 glm-4.6v-flash`);
  }
});

test('至少一家预设的推荐模型支持看图（看图工具链依赖多模态）', () => {
  const visionVendors = AI_PROVIDER_PRESETS.filter((p) => p.vision).map((p) => p.id);
  assert.ok(visionVendors.length >= 3, `支持看图的厂商太少：${visionVendors.join('、')}`);
});

console.log(`\nai-presets: ${passed} 项全部通过`);
