/**
 * chat-conversation.ts 纯函数单测（vitest 兼容 node 直跑：node server/node_modules/tsx/dist/cli.mjs）
 */
import assert from 'node:assert/strict';
import {parseChatLines, bubbleEnterFrame, chatGroupStarts, chatTimestampLabel, CHAT_META_LINE_EM, CHAT_TYPING_SEC, CHAT_PUSH_FRAMES, estimateChatRows} from '../../src/shared/chat-conversation.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  // 角色前缀解析：u:/a:/全角冒号/无前缀→AI/空行过滤
  const lines = parseChatLines(['u:改成 30 秒', 'a：好的', '没前缀这句', '', 'u:第二条']);
  assert.deepEqual(lines.map((l) => l.role), ['user', 'ai', 'ai', 'user']);
  assert.equal(lines[0].text, '改成 30 秒');
  assert.equal(lines[1].text, '好的');
  ok('角色前缀解析');
}

{
  // 首气泡 0.5s 基准；均分步长；短段 0.55s 下限；pace 单调
  const fps = 30;
  assert.equal(bubbleEnterFrame(0, 4, 8 * fps, fps), Math.round(0.5 * fps));
  // 足够长的段：step = 可用/count
  const total = 12 * fps;
  const step = Math.round((total - Math.round(0.5 * fps) - Math.round(0.6 * fps)) / 4);
  assert.equal(bubbleEnterFrame(2, 4, total, fps), Math.round(0.5 * fps) + 2 * step);
  // 段太短：step 有 0.55s 下限
  const short = 2.2 * fps;
  const e1 = bubbleEnterFrame(0, 4, short, fps);
  const e2 = bubbleEnterFrame(1, 4, short, fps);
  assert.ok(e2 - e1 >= Math.round(0.55 * fps), `短段 step 下限生效，实际 ${e2 - e1}`);
  // pace>1 拉快（step 变小）
  const fast = bubbleEnterFrame(1, 4, 12 * fps, fps, 2);
  const normal = bubbleEnterFrame(1, 4, 12 * fps, fps, 1);
  assert.ok(fast <= normal, 'pace=2 应不慢于 pace=1');
  // typing 常量口径
  assert.ok(CHAT_TYPING_SEC > 0.3 && CHAT_TYPING_SEC < 0.8);
  ok('首泡基准/均分步长/短段下限/pace 单调/typing 常量');
}

{
  // estimateChatRows：中文全宽 / ASCII 半宽 / 空文本=1 行 / 窄容器多行
  // 可用宽收 5% 保守余量（估行数 ≥ 实际——泡高固定盒的同源基准）
  const fs = 24;
  assert.equal(estimateChatRows('', 400, fs), 1);
  assert.equal(estimateChatRows('一句话', 4000, fs), 1);
  const one = estimateChatRows('帮我剪一条产品宣传片', 12 * fs, fs);
  assert.equal(one, 1);
  const two = estimateChatRows('帮我剪一条产品宣传片九字以上', 5 * fs, fs);
  assert.ok(two >= 3, `14 全宽字/120px 应 ≥3 行，实际 ${two}`);
  const ascii = estimateChatRows('abcdefghij', 10 * fs, fs);
  assert.equal(ascii, 1);
  assert.equal(CHAT_PUSH_FRAMES, 12);
  ok('estimateChatRows 行数估算/推挤窗常量');
}

{
  // chatGroupStarts：同角色连续=同组（组首 true）；交替对话每条都是组首
  const alt = chatGroupStarts(parseChatLines(['u:你好', 'a:在的', 'u:帮我剪片', 'a:好的']));
  assert.deepEqual(alt, [true, true, true, true], '交替对话每条都是组首');
  const burst = chatGroupStarts(parseChatLines(['u:一句话', 'u:两句话', 'u:三句话', 'a:收到', 'a:这就去']));
  assert.deepEqual(burst, [true, false, false, true, false], '连发只有首条是组首');
  assert.deepEqual(chatGroupStarts([]), [], '空脚本空数组');
  // chatTimestampLabel：m:ss 补零 / 负值钳 0
  assert.equal(chatTimestampLabel(2), '0:02');
  assert.equal(chatTimestampLabel(65), '1:05');
  assert.equal(chatTimestampLabel(-3), '0:00');
  // meta 行高系数：与模板 estHeights 同源（有 meta 的泡比无 meta 高出 fs×系数）
  assert.ok(CHAT_META_LINE_EM > 0.5 && CHAT_META_LINE_EM < 1.2, 'meta 行高系数在合理区间');
  ok('chatGroupStarts 分组/chatTimestampLabel 时间戳/meta 行高常量');
}

console.log(`\n共 ${passed} 项全部通过`);
