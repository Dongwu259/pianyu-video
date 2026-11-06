/**
 * 渲染进程层死亡防护纯逻辑单测：错误分类 / 退避表 / 日志整形（第五十九轮）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/render-guard.test.ts
 */
import assert from 'node:assert/strict';
import {
  classifyRenderError, renderRetryDelayMs, summarizeRenderError, formatBrowserLogTail, buildProcessDeathError, BROWSER_LOG_RING_CAP,
} from '../../src/main/services/render-guard.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

t('分类：用户取消（got cancelled 文案，与 renderer.ts 口径一致）', () => {
  assert.equal(classifyRenderError(new Error('Error: The render got cancelled')), 'cancel');
  // 取消优先于其他特征（即使文案同时含 target closed）
  assert.equal(classifyRenderError(new Error('render got cancelled: Target closed')), 'cancel');
});

t('分类：渲染浏览器死亡特征（@remotion/renderer 4.0.390 实测文案族）', () => {
  const cases = [
    'Error: Page crashed!',
    'Protocol error (Runtime.callFunctionOn): Target closed',
    'Protocol error (Page.screenshot): Target closed (page disposed)',
    'Target closed. https://www.remotion.dev/docs/target-closed',
    'Browser has crashed',
    'Puppeteer: Browser has disconnected',
    'Lost connection to browser',
    'Session closed. Exceeded maximum retry time',
  ];
  for (const c of cases) assert.equal(classifyRenderError(new Error(c)), 'process-death', c);
});

t('分类：组合器（remotion.exe）死亡与代理失联', () => {
  const cases = [
    'Error while communicating with the compositor: compositor exited unexpectedly',
    'Failed to fetch http://localhost:1234/proxy?src=x.mp4',
    'network error during /proxy request',
    'connect ECONNREFUSED 127.0.0.1:41001',
    'write EPIPE',
  ];
  for (const c of cases) assert.equal(classifyRenderError(new Error(c)), 'process-death', c);
});

t('分类：非进程死亡错误不重试（重试无意义，交原有降级链）', () => {
  assert.equal(classifyRenderError(new Error('Composition "MultiSegment-16x9" not found')), 'other');
  assert.equal(classifyRenderError(new Error('ffmpeg exited with code 1')), 'other');
  assert.equal(classifyRenderError(new Error('frame 30 failed: timeout 33000ms exceeded')), 'other');
  assert.equal(classifyRenderError('字符串错误'), 'other');
  assert.equal(classifyRenderError(undefined), 'other');
});

t('退避表：2 次重试机会（1500/4000ms），之后 null（用尽交上层）', () => {
  assert.equal(renderRetryDelayMs(0), 1500);
  assert.equal(renderRetryDelayMs(1), 4000);
  assert.equal(renderRetryDelayMs(2), null);
  assert.equal(renderRetryDelayMs(99), null);
});

t('summarizeRenderError：压单行 + 限长省略号', () => {
  assert.equal(summarizeRenderError(new Error('a\n  b\t c')), 'Error: a b c');
  const long = 'x'.repeat(500);
  const s = summarizeRenderError(new Error(long), 100);
  assert.ok(s.length <= 102 && s.endsWith('…'));
});

t('formatBrowserLogTail：空缓冲空串 / 尾部截取 / 省略计数 / 单条限长', () => {
  assert.equal(formatBrowserLogTail([]), '');
  const lines = Array.from({length: 20}, (_, i) => `line${i}`);
  const tail = formatBrowserLogTail(lines, 5);
  assert.ok(tail.startsWith('（前 15 条略）'));
  assert.ok(tail.includes('line19') && !tail.includes('line14\n'));
  const long = formatBrowserLogTail(['y'.repeat(500)], 5, 100);
  assert.ok(long.length < 110 && long.endsWith('…'));
  assert.equal(BROWSER_LOG_RING_CAP, 120);
});

t('buildProcessDeathError：分类 + 原始摘要 + 日志尾 + cause 保留（bench 日志可诊断）', () => {
  const orig = new Error('Target closed. https://www.remotion.dev/docs/target-closed');
  const e = buildProcessDeathError(orig, 'console.log: THREE.WebGLRenderer: Context Lost.');
  assert.ok(/进程死亡/.test(e.message) && /自动重试后仍失败/.test(e.message));
  assert.ok(e.message.includes('Target closed'));
  assert.ok(e.message.includes('浏览器日志尾') && e.message.includes('Context Lost'));
  assert.equal((e as Error & {cause?: unknown}).cause, orig);
  // 空日志尾：不带日志段（不打印空标题）
  const e2 = buildProcessDeathError(orig, '');
  assert.ok(!e2.message.includes('浏览器日志尾'));
});

console.log(`\nrender-guard: ${passed} 组断言通过`);
if (process.exitCode) process.exit(1);
