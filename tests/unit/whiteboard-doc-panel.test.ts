/**
 * P2 白板画布（whiteboard-canvas）与 P4 文档面板（doc-panel）纯函数单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/whiteboard-doc-panel.test.ts
 */

import assert from 'node:assert/strict';
import {parseWhiteboardCards, layoutWhiteboard, whiteboardCameraAt, WHITEBOARD_WORLD_W} from '../../src/shared/whiteboard-canvas.ts';
import {parseDocParagraphs, parseDocPlaceholders} from '../../src/shared/doc-panel.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('parseWhiteboardCards:');
{
  const cards = parseWhiteboardCards([
    '[v]角色三视图|一致性设定',
    '[t]三幕剧本|反转结构',
    '无前缀也是文字卡',
    '[x]未知前缀归文字卡',
    '',
    '[v]',
  ]);
  assert.equal(cards.length, 4);
  assert.equal(cards[0].type, 'video');
  assert.equal(cards[0].sub, '一致性设定');
  assert.equal(cards[1].type, 'text');
  assert.equal(cards[2].type, 'text');
  assert.equal(cards[2].sub, undefined);
  assert.equal(cards[3].title, '未知前缀归文字卡', '未知单字母前缀剥标记归文字卡');
  // 封顶 6
  const many = parseWhiteboardCards(Array.from({length: 9}, (_, i) => `卡${i}`));
  assert.equal(many.length, 6);
  assert.deepEqual(parseWhiteboardCards([]), []);
  ok('前缀/副题/未知前缀归文字卡/空过滤/封顶');
}

console.log('layoutWhiteboard:');
{
  const rects = layoutWhiteboard(parseWhiteboardCards(['[t]A', '[v]B', '[t]C']));
  assert.equal(rects.length, 3);
  // 槽位互不重叠（中心距足够）
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const d = Math.hypot(rects[i].cx - rects[j].cx, rects[i].cy - rects[j].cy);
      assert.ok(d > 0.15, `卡 ${i}/${j} 中心距 ${d.toFixed(2)} 过近`);
    }
  }
  assert.ok(rects[1].w > rects[0].w, '视频卡宽于文字卡');
  assert.ok(rects.every((r) => Math.abs(r.rot) <= 2), '旋转微差 ±2°');
  // 确定性
  assert.deepEqual(layoutWhiteboard(parseWhiteboardCards(['[t]A', '[v]B', '[t]C'])), rects);
  ok('槽位布局/类型尺寸/旋转微差/确定性');
}

console.log('whiteboardCameraAt:');
{
  const rects = layoutWhiteboard(parseWhiteboardCards(['[t]A', '[t]B', '[t]C']));
  const total = 9 * 30;
  // 首帧（intro 内）= 全景
  const first = whiteboardCameraAt(0, total, rects);
  assert.ok(Math.abs(first.scale - 1 / WHITEBOARD_WORLD_W) < 1e-9, 'intro 全景基准');
  // 末帧（拉远）≈ 全景
  const last = whiteboardCameraAt(total - 1, total, rects);
  assert.ok(Math.abs(last.scale - 1 / WHITEBOARD_WORLD_W) < 0.02, `拉远回全景，实际 ${last.scale.toFixed(3)}`);
  // 中段某卡驻留：scale 明显大于全景（推近）且注视点接近某卡中心
  let pushed = false;
  for (let f = 0; f < total; f += 3) {
    const cam = whiteboardCameraAt(f, total, rects);
    if (cam.scale > (1 / WHITEBOARD_WORLD_W) * 1.3) {
      pushed = true;
      break;
    }
  }
  assert.ok(pushed, '存在推近段（scale > 全景×1.3）');
  // 无卡回退全景居中
  const none = whiteboardCameraAt(30, total, []);
  assert.equal(none.scale, 1 / WHITEBOARD_WORLD_W);
  // 确定性
  assert.deepEqual(whiteboardCameraAt(120, total, rects), whiteboardCameraAt(120, total, rects));
  ok('intro 全景/拉远收束/驻留推近/无卡回退/确定性');
}

console.log('parseDocParagraphs:');
{
  const paras = parseDocParagraphs([
    '本片采用[[三幕反转结构]]，先立主角再毁设定。',
    'img:分镜占位一',
    '第二段无选区。',
    'img:分镜占位二',
  ]);
  assert.equal(paras.length, 2, 'img 行不入段落');
  assert.equal(paras[0].segments.length, 3, '选区拆三段');
  assert.equal(paras[0].segments[0].selected, false);
  assert.equal(paras[0].segments[1].selected, true);
  assert.equal(paras[0].segments[1].text, '三幕反转结构');
  assert.equal(paras[0].segments[2].text, '，先立主角再毁设定。');
  assert.equal(paras[1].segments.length, 1);
  assert.equal(paras[1].segments[0].selected, false);
  // 封顶
  const many = parseDocParagraphs(Array.from({length: 9}, (_, i) => `段${i}`));
  assert.equal(many.length, 6);
  assert.deepEqual(parseDocParagraphs([]), []);
  ok('选区拆段/img 行排除/封顶/空输入');
}

console.log('parseDocPlaceholders:');
{
  const cells = parseDocPlaceholders(['img:分镜一', '正文', 'img：分镜二', 'img:', 'img:三', 'img:四', 'img:五']);
  assert.deepEqual(cells, ['分镜一', '分镜二', '三', '四'], '全角冒号/空标签过滤/封顶 4');
  assert.deepEqual(parseDocPlaceholders(['正文']), []);
  ok('占位格提取/全角冒号/封顶');
}

{
  // panMode 跨段连续性（v8 实锤：驻留推到段尾、下一段回全景=硬跳瞬移）：拱形回落保证相邻采样零跳
  const rects9 = layoutWhiteboard(parseWhiteboardCards(['[t]A','[v]B','[t]C','[t]D','[v]E','[t]F','[t]G','[v]H','[t]I'], 9)); // 显式 9——缺省封顶 6（v6-v8 实锤）
  const fps = 30, total = 12.5 * fps;
  let maxJump = 0;
  let prevScale = whiteboardCameraAt(0, total, rects9, {zoomIn: 1.3, panMode: true}).scale;
  for (let f = 1; f <= total; f++) {
    const sc = whiteboardCameraAt(f, total, rects9, {zoomIn: 1.3, panMode: true}).scale;
    maxJump = Math.max(maxJump, Math.abs(sc - prevScale));
    prevScale = sc;
  }
  // 硬跳（v8 bug：段间 1.3→1.0 瞬移）= 0.3×fit ≈ 0.19；拱形连续动画的帧增量峰值 ≈0.022。
  // 阈值取 0.05：容纳拱形峰值、判死任何段间硬跳
  assert.ok(maxJump < 0.05, `panMode 相邻帧 scale 跳变 ${maxJump.toFixed(5)} 超限（疑似硬跳）`);
  // 拱形峰值存在：全程 max scale 应达到驻留轻推档（fit×(1+0.3×0.95)以上）
  let maxScale = 0;
  for (let f = 0; f <= total; f++) {
    maxScale = Math.max(maxScale, whiteboardCameraAt(f, total, rects9, {zoomIn: 1.3, panMode: true}).scale);
  }
  assert.ok(maxScale > (1 / WHITEBOARD_WORLD_W) * 1.25, `panMode 驻留峰值 ${maxScale.toFixed(4)} 未达轻推档`);
  ok('panMode 跨段连续性/拱形回落');
}

console.log(`\n共 ${passed} 项全部通过`);
