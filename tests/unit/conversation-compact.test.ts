/**
 * 会话历史压缩（shared/conversation-compact.ts）单测：
 * 保留区规则 / tool 截断 / 帧图占位 / 边界便签 / shouldCompact 阈值。
 * 跑法：node server/node_modules/tsx/dist/cli.mjs tests/unit/conversation-compact.test.ts
 */
import {compactConversation, countImages, shouldCompact, DEFAULT_IMAGE_PLACEHOLDER} from '../../src/shared/conversation-compact';

let passed = 0;
let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};

const img = (n: string) => ({type: 'image_url', image_url: {url: n}});
const txt = (t: string) => ({type: 'text', text: t});
const sys = {role: 'system', content: 'S'};
const firstUser = {role: 'user', content: '原始需求'};

// ====== 保留区规则 ======
{
  const msgs = [sys, firstUser, {role: 'assistant', content: 'a'}, {role: 'user', content: 'b'}];
  ok(compactConversation(msgs) === msgs, '短历史（≤keepLast+2）原样返回同一引用');
}
{
  const msgs = [
    sys, firstUser,
    {role: 'assistant', content: 'note1', tool_calls: [{id: 'c1'}]},
    {role: 'tool', tool_call_id: 'c1', name: 'get_storyboard', content: 'x'.repeat(2000)},
    {role: 'user', content: [txt('看了下'), img('f1.jpg')]},
    {role: 'assistant', content: 'note2', tool_calls: [{id: 'c2'}]},
    {role: 'tool', tool_call_id: 'c2', name: 'update_segment', content: 'y'.repeat(2000)},
    {role: 'assistant', content: 'note3', tool_calls: [{id: 'c3'}]},
    {role: 'tool', tool_call_id: 'c3', name: 'get_storyboard', content: 'z'.repeat(100)},
  ];
  const out = compactConversation(msgs, {keepLast: 3, maxToolChars: 400});
  ok(out.length === msgs.length, '压缩不删消息（保序等长）');
  ok(out[0] === msgs[0] && out[1] === msgs[1], 'system 与首条 user 引用不变（永不裁）');
  ok((out[3].content as string).length === 406, '中段 tool 截断到 maxToolChars+省略号');
  ok(out[3].content === 'x'.repeat(400) + '…（已截断）', '截断文案正确');
  ok((out[8].content as string) === 'z'.repeat(100), '保留区内 tool 不截断');
  const u = out[4] as {content: {type: string; text?: string}[]};
  ok(u.content[0].type === 'text' && u.content[0].text === '看了下', '中段 user 文本项保留');
  ok(u.content[1].type === 'text' && u.content[1].text === DEFAULT_IMAGE_PLACEHOLDER, '中段 user 帧图替换为占位');
  const kept = out[6] as {content: string};
  ok(kept.content.length === 2000, '保留区边界：下标 6 = cut，原样保留');
  ok(msgs[3].content === 'x'.repeat(2000), '入参未被改动（纯函数）');
}

// ====== 边界便签（草稿本注入点） ======
{
  const msgs = [
    sys, firstUser,
    {role: 'tool', tool_call_id: 'c1', name: 't', content: 'a'},
    {role: 'assistant', content: 'n1'},
    {role: 'user', content: [img('f.jpg')]},
    {role: 'assistant', content: 'n2'},
    {role: 'tool', tool_call_id: 'c2', name: 't', content: 'b'},
  ];
  const out = compactConversation(msgs, {keepLast: 2, boundaryNote: '【草稿】已完成开场；待做：转场'});
  const idx = out.findIndex((m) => m.role === 'user' && String(m.content).startsWith('【草稿】'));
  ok(idx >= 2, '草稿便签已注入');
  ok(out[out.length - 1] === msgs[6] && out[out.length - 2] === msgs[5], '便签后的消息与原数组引用一致（保留区）');
  ok(out[idx - 1] !== msgs[4] || String(out[idx - 1].content).includes('省略') || Array.isArray(out[idx - 1].content) === false || (out[idx - 1].content as {type?: string}[]).some((c) => c.type === 'text' && c.text?.includes('省略')), '便签前是压缩区');
  ok(out.filter((m) => m.role === 'user' && String(m.content).startsWith('【草稿】')).length === 1, '便签只注入一次');
}

// ====== countImages / shouldCompact ======
{
  const msgs = [sys, firstUser,
    {role: 'user', content: [img('a'), img('b'), txt('x')]},
    {role: 'user', content: [img('c')]},
    {role: 'user', content: '纯文本'},
  ];
  ok(countImages(msgs) === 3, 'countImages 数对帧图');
  ok(shouldCompact([...msgs].slice(0, 2)) === false, '短历史不触发');
  ok(shouldCompact(msgs, 26, 2) === true, '图片超阈值触发（消息数未超）');
  ok(shouldCompact(Array.from({length: 30}, () => ({role: 'user', content: 'x'}))) === true, '消息数超阈值触发');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
