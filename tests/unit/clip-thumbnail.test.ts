/**
 * 素材缩略图生成（clipThumbnail，录制/AI 链路补齐）单元测试
 *
 * 覆盖：抽帧时间点纯函数（10% 处且 ≤1s、短素材/异常 duration 取 0）、
 * makeClipThumbnail 的成功/失败路径（失败静默 undefined 不阻塞入段）与
 * 传参口径（长边 192、与文件导入链路一致）。checks 顺序执行（共享 calls 记录）。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/clip-thumbnail.test.ts
 */

import assert from 'node:assert/strict';
import {clipThumbnailTimeSec, makeClipThumbnail, CLIP_THUMBNAIL_MAX_DIM} from '../../src/renderer/utils/clipThumbnail.ts';

// window.api mock（makeClipThumbnail 只依赖 extractFrame 一个 IPC 面）
const calls: Array<[string, number, number | undefined]> = [];
(globalThis as unknown as {window: unknown}).window = {
  api: {
    extractFrame: async (filePath: string, timeSec: number, maxDim?: number) => {
      calls.push([filePath, timeSec, maxDim]);
      if (filePath === 'boom.mp4') throw new Error('抽帧失败');
      return {dataUrl: 'data:image/jpeg;base64,xxx', width: 192, height: 108};
    },
  },
};

const checks: Array<[string, () => void | Promise<void>]> = [
  ['clipThumbnailTimeSec：10% 处且封顶 1s（100s→1s、6s→0.6s、5s→0.5s）', () => {
    assert.equal(clipThumbnailTimeSec(100), 1);
    assert.ok(Math.abs(clipThumbnailTimeSec(6) - 0.6) < 1e-9);
    assert.equal(clipThumbnailTimeSec(5), 0.5);
  }],
  ['clipThumbnailTimeSec：短素材/异常 duration 取 0（0.2/0/NaN/负数）', () => {
    assert.equal(clipThumbnailTimeSec(0.2), 0);
    assert.equal(clipThumbnailTimeSec(0), 0);
    assert.equal(clipThumbnailTimeSec(Number.NaN), 0);
    assert.equal(clipThumbnailTimeSec(-3), 0);
  }],
  ['makeClipThumbnail 成功：返回 dataUrl，传参=（路径, 时间点, 192）', async () => {
    const r = await makeClipThumbnail('rec.webm', 30);
    assert.equal(r, 'data:image/jpeg;base64,xxx');
    const last = calls[calls.length - 1];
    assert.equal(last[0], 'rec.webm');
    assert.equal(last[1], 1); // 30s 的 10% = 3s 封顶 1s
    assert.equal(last[2], CLIP_THUMBNAIL_MAX_DIM);
    assert.equal(CLIP_THUMBNAIL_MAX_DIM, 192);
  }],
  ['makeClipThumbnail 失败静默 undefined（不阻塞入段链路）', async () => {
    const r = await makeClipThumbnail('boom.mp4', 10);
    assert.equal(r, undefined);
  }],
  ['makeClipThumbnail duration 异常走 0s 抽帧（录屏 webm 无元数据兜底）', async () => {
    await makeClipThumbnail('norec.webm', 0);
    const last = calls[calls.length - 1];
    assert.equal(last[0], 'norec.webm');
    assert.equal(last[1], 0);
  }],
];

const main = async () => {
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nclip-thumbnail: ${passed} 组断言${failed === 0 ? '全部通过' : `（失败 ${failed}）`}`);
  if (failed > 0 || passed < checks.length) process.exit(1);
};

void main();
