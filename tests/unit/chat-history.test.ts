/**
 * AI 对话历史工具（shared/chat-history）单元测试
 *
 * 覆盖：持久化图片剥离、字符量估算、压缩安全切割（tool_calls 配对不被切断的
 * 不变量）、压缩结果组装、崩溃恢复修复、Markdown 导出、JSON 存档往返与校验。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/chat-history.test.ts
 */

import assert from 'node:assert/strict';
import {
  AUTO_COMPACT_THRESHOLD_CHARS,
  HISTORY_IMAGE_PLACEHOLDER,
  type UiMsg,
  type ChatArchive,
  stripImagesForStorage,
  estimateHistoryChars,
  findCompactionCut,
  buildCompactionMessages,
  applyCompaction,
  sanitizeRestoredHistory,
  serializeChatMarkdown,
  buildChatArchive,
  parseChatArchive,
  makeToolCallMsg,
} from '../../src/shared/chat-history.ts';
import type {LlmChatMessage, ContentPart} from '../../src/shared/llm-chat.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 造一轮对话：user → assistant(tool_calls) → tool 应答 → assistant 总结。
 *  pad 撑字符量让阈值测试可控。 */
const turn = (i: number, chars = 400): LlmChatMessage[] => [
  {role: 'user', content: `需求 ${i}：`.padEnd(chars / 2, `u${i % 10}`)},
  makeToolCallMsg(`call-${i}`, 'get_storyboard', `{"i":${i}}`.padEnd(chars / 4, 'a')),
  {role: 'tool', tool_call_id: `call-${i}`, content: `{"ok":true,"i":${i}}`.padEnd(chars / 4, 'r')},
  {role: 'assistant', content: `回复 ${i}：`.padEnd(chars / 2, `s${i % 10}`)},
];

const history = (turns: number, chars = 400): LlmChatMessage[] => [
  {role: 'system', content: '你是视频制作助手'},
  ...Array.from({length: turns}, (_, i) => turn(i, chars)).flat(),
];

/** 不变量：历史里每个带 tool_calls 的 assistant，其每个 id 都在「下一条非 tool 消息之前」
 *  得到了 role:'tool' 应答（OpenAI 兼容 API 的硬性要求）。 */
const assertToolCallsAnswered = (msgs: LlmChatMessage[], scope: string) => {
  for (let i = 0; i < msgs.length; i++) {
    const calls = msgs[i].tool_calls ?? [];
    if (msgs[i].role !== 'assistant' || calls.length === 0) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) answered.add(String(msgs[j].tool_call_id));
    for (const c of calls) {
      assert.ok(answered.has(c.id), `${scope}: assistant 的 tool_call ${c.id} 缺少应答（会被 API 400 拒绝）`);
    }
  }
};

console.log('chat-history: stripImagesForStorage');
ok('image_url 片段替换为文字占位、文本片段保留、原数组不被修改', () => {
  const parts: ContentPart[] = [
    {type: 'text', text: '看这张图'},
    {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAA'}},
  ];
  const msgs: LlmChatMessage[] = [{role: 'user', content: parts}];
  const out = stripImagesForStorage(msgs);
  assert.equal(out.length, 1);
  const outParts = out[0].content as ContentPart[];
  assert.equal(outParts[0].type, 'text');
  assert.equal(outParts[0].text, '看这张图');
  assert.equal(outParts[1].type, 'text');
  assert.equal(outParts[1].text, HISTORY_IMAGE_PLACEHOLDER);
  // 原数组未动（无副作用）
  const origParts = msgs[0].content as ContentPart[];
  assert.equal(origParts[1].type, 'image_url');
});

ok('纯文本消息原样返回', () => {
  const msgs: LlmChatMessage[] = [{role: 'user', content: '你好'}];
  assert.deepEqual(stripImagesForStorage(msgs), msgs);
});

console.log('chat-history: estimateHistoryChars');
ok('字符串 content 按 length 计、图片片段按 64 计、tool_calls 参数计入', () => {
  const n = estimateHistoryChars([
    {role: 'user', content: 'abcde'},
    {role: 'user', content: [{type: 'text', text: 'xy'}, {type: 'image_url', image_url: {url: 'zzz'}}]},
    makeToolCallMsg('c1', 'upd', '12345'),
  ]);
  assert.equal(n, 5 + (2 + 64) + ('upd'.length + 5));
});

console.log('chat-history: findCompactionCut');
ok('超阈值历史：切割点落在 user 轮次起点，保留部分足量且配对完整', () => {
  const msgs = history(30, 400); // ~1 system + 30 轮 × 400 字符 ≈ 12k 字符
  const cut = findCompactionCut(msgs, {threshold: 6000, keepRecent: 12});
  assert.ok(cut > 1, `应发生切割（cut=${cut}）`);
  assert.equal(msgs[cut].role, 'user', '切割点必须是 user 轮次起点');
  assert.ok(msgs.length - cut >= 12, '保留部分不得少于 keepRecent');
  const keptChars = estimateHistoryChars([msgs[0], ...msgs.slice(cut)]);
  assert.ok(keptChars <= 6000, `保留部分应压到阈值内（实际 ${keptChars}）`);
  // 被移除区间与保留区间都满足 tool_calls 配对不变量
  assertToolCallsAnswered([msgs[0], ...msgs.slice(1, cut)], '移除区间');
  assertToolCallsAnswered(msgs.slice(cut), '保留区间');
});

ok('历史太短：无可压缩空间返回 -1', () => {
  assert.equal(findCompactionCut(history(3), {threshold: 100000, keepRecent: 24}), -1);
});

ok('阈值内但可移除量大：回退到最晚合法边界（移除最多、保留 keepRecent 附近）', () => {
  const msgs = history(20, 500); // 1 + 20×4 = 81 条，user 边界每 4 条一个
  const cut = findCompactionCut(msgs, {threshold: 10, keepRecent: 10});
  // 最晚合法 user 边界在 turn 17 起点（下标 69）：81-69=12 条，再多切一格就低于 keepRecent
  assert.ok(cut > 0, `应回退切割（cut=${cut}）`);
  assert.equal(msgs[cut].role, 'user');
  assert.ok(msgs.length - cut >= 10 && msgs.length - cut < 14, `保留应在 keepRecent 附近（实际 ${msgs.length - cut}）`);
});

ok('首条 user 消息（index 1）不会被单独切掉导致保留区为空', () => {
  const msgs = history(30, 400);
  const cut = findCompactionCut(msgs, {threshold: 6000, keepRecent: 12});
  if (cut > 0) assert.ok(msgs.length - cut >= 12);
});

console.log('chat-history: buildCompactionMessages / applyCompaction');
ok('压缩请求是两段消息（system 归档器 + user 历史原文），已剥图', () => {
  const removed = history(3).slice(1);
  const req = buildCompactionMessages(removed);
  assert.equal(req.length, 2);
  assert.equal(req[0].role, 'system');
  const body = req[1].content as string;
  assert.ok(body.includes('"role"'), '历史以 JSON 序列化传入');
  assert.ok(!body.includes('image_url'), 'base64 图片不进压缩请求');
});

ok('applyCompaction：system 首条保留 + 摘要 system + 原样保留区间', () => {
  const msgs = history(10, 200);
  const cut = 9; // 任意合法边界
  const out = applyCompaction(msgs, cut, '摘要内容');
  assert.equal(out.length, msgs.length - cut + 2);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'system');
  assert.ok((out[1].content as string).includes('摘要内容'));
  assert.deepEqual(out.slice(2), msgs.slice(cut));
  assertToolCallsAnswered(out, '压缩后历史');
});

console.log('chat-history: sanitizeRestoredHistory');
ok('完整历史原样通过', () => {
  const msgs = history(4);
  assert.deepEqual(sanitizeRestoredHistory(msgs), msgs);
});

ok('崩溃残留的悬空 tool_calls 补中止应答（含多 call 部分应答）', () => {
  const msgs: LlmChatMessage[] = [
    {role: 'user', content: '需求'},
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {id: 'a', type: 'function', function: {name: 't1', arguments: '{}'}},
        {id: 'b', type: 'function', function: {name: 't2', arguments: '{}'}},
      ],
    },
    {role: 'tool', tool_call_id: 'a', content: '{"ok":true}'},
    // 应用在此崩溃：b 没有应答
    {role: 'user', content: '继续'},
  ];
  const out = sanitizeRestoredHistory(msgs);
  assert.equal(out.length, 5);
  assert.equal(out[3].role, 'tool');
  assert.equal(out[3].tool_call_id, 'b');
  assert.ok(String(out[3].content).includes('未执行'));
  assert.equal(out[4].content, '继续');
  assertToolCallsAnswered(out, '修复后');
});

ok('assistant 带 tool_calls 后直接跟 user（完全没应答）：两条都补', () => {
  const out = sanitizeRestoredHistory([
    {role: 'user', content: 'x'},
    makeToolCallMsg('only', 't', '{}'),
    {role: 'user', content: 'y'},
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[2].tool_call_id, 'only');
});

console.log('chat-history: serializeChatMarkdown');
ok('按角色成段，工具调用列名', () => {
  const ui: UiMsg[] = [
    {id: '1', role: 'user', content: '帮我做个宣传片'},
    {id: '2', role: 'assistant', content: '好的', toolNames: ['get_storyboard', 'update_segment']},
    {id: '3', role: 'system', content: '[渲染结果] 成功'},
  ];
  const md = serializeChatMarkdown(ui, {videoTypeLabel: '产品宣传片'});
  assert.ok(md.includes('# 片语 AI 助手对话记录'));
  assert.ok(md.includes('视频体裁：产品宣传片'));
  assert.ok(md.includes('帮我做个宣传片'));
  assert.ok(md.includes('get_storyboard、update_segment'));
  assert.ok(md.includes('[渲染结果] 成功'));
});

console.log('chat-history: buildChatArchive / parseChatArchive');
const sampleUi: UiMsg[] = [
  {id: 'u1', role: 'user', content: '你好'},
  {id: 'a1', role: 'assistant', content: '你好，需要什么帮助？'},
];
const sampleApi: LlmChatMessage[] = [
  {role: 'user', content: '你好'},
  {role: 'assistant', content: '回复'},
];

ok('JSON 往返：结构完整、图片剥离、悬空修复', () => {
  const apiWithImage: LlmChatMessage[] = [
    ...sampleApi,
    {role: 'user', content: [{type: 'text', text: '图'}, {type: 'image_url', image_url: {url: 'data:...'}}]},
    makeToolCallMsg('dangling', 't', '{}'), // 故意悬空，parse 内应修复
  ];
  const archive = buildChatArchive({videoType: 'vlog', uiMessages: sampleUi, apiMessages: apiWithImage});
  const parsed = parseChatArchive(JSON.stringify(archive));
  assert.ok(parsed.ok);
  const a = (parsed as {ok: true; archive: ChatArchive}).archive;
  assert.equal(a.version, 1);
  assert.deepEqual(a.uiMessages, sampleUi);
  const imgMsg = a.apiMessages[2];
  const parts = imgMsg.content as ContentPart[];
  assert.equal(parts[1].type, 'text');
  assert.equal(a.apiMessages[a.apiMessages.length - 1].role, 'tool');
  assert.equal(a.apiMessages[a.apiMessages.length - 1].tool_call_id, 'dangling');
  assertToolCallsAnswered(a.apiMessages, '导入存档');
});

ok('坏存档拒绝：非 JSON / 版本不认识 / 角色非法 / tool 缺 id', () => {
  const r1 = parseChatArchive('not json {');
  assert.ok(!r1.ok && r1.error.includes('JSON'));
  const r2 = parseChatArchive(JSON.stringify({version: 2, uiMessages: [], apiMessages: []}));
  assert.ok(!r2.ok && r2.error.includes('版本'));
  const r3 = parseChatArchive(
    JSON.stringify({version: 1, uiMessages: [{id: 'x', role: 'alien'}], apiMessages: []}),
  );
  assert.ok(!r3.ok);
  const r4 = parseChatArchive(
    JSON.stringify({version: 1, uiMessages: [], apiMessages: [{role: 'tool', content: 'x'}]}),
  );
  assert.ok(!r4.ok && r4.error.includes('apiMessages'));
});

ok('存档消息数超限拒绝', () => {
  const huge = Array.from({length: 5001}, () => ({role: 'user', content: 'x'}));
  const r = parseChatArchive(JSON.stringify({version: 1, uiMessages: huge, apiMessages: []}));
  assert.ok(!r.ok && r.error.includes('超限'));
});

console.log('chat-history: 常量口径');
ok('自动压缩阈值与占位文案非空', () => {
  assert.ok(AUTO_COMPACT_THRESHOLD_CHARS >= 50000);
  assert.ok(HISTORY_IMAGE_PLACEHOLDER.length > 0);
});

console.log(`\nchat-history: ${passed} 项全部通过`);
