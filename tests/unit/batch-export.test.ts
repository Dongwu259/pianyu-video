/**
 * 批量导出（多比例）队列状态机单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/batch-export.test.ts
 * （被测模块为纯函数，不依赖 electron / DOM）
 */

import assert from 'node:assert/strict';
import {
  createBatchJobs,
  nextJob,
  updateJobProgress,
  markJobDone,
  markJobFailed,
  cancelRest,
  isBatchRunning,
  ratioIdToSuffix,
  buildBatchFilename,
} from '../../src/renderer/render/batchQueue.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const makeJobs = () =>
  createBatchJobs([
    {aspectRatioId: '16-9', label: '16:9 横屏', filename: '片语-16x9'},
    {aspectRatioId: '1-1', label: '1:1 方形', filename: '片语-1x1'},
    {aspectRatioId: '4-3', label: '4:3 经典横屏', filename: '片语-4x3'},
  ]);

// ====== 1. 文件名后缀 ======

console.log('文件名后缀:');
{
  assert.equal(ratioIdToSuffix('16-9'), '16x9');
  assert.equal(ratioIdToSuffix('9-16'), '9x16');
  assert.equal(buildBatchFilename('片语', '16-9'), '片语-16x9');
  assert.equal(buildBatchFilename('my promo', '4-3'), 'my promo-4x3');
  ok('ratioIdToSuffix / buildBatchFilename 命名符合「片语-16x9」约定');
}

// ====== 2. 顺序推进（严格串行）======

console.log('顺序推进:');
{
  let jobs = makeJobs();
  assert.ok(isBatchRunning(jobs), '初始队列应在运行中');

  const step1 = nextJob(jobs);
  assert.equal(step1.job?.aspectRatioId, '16-9', '应取首个 pending');
  assert.equal(step1.job?.status, 'rendering');
  assert.equal(step1.jobs[1].status, 'pending', '其余 job 不受影响');
  assert.equal(jobs[0].status, 'pending', 'nextJob 不改入参（纯函数）');
  jobs = step1.jobs;

  jobs = updateJobProgress(jobs, '16-9', 42);
  assert.equal(jobs[0].progress, 42, '渲染中进度可更新');
  assert.equal(jobs[1].progress, 0, '未开始的 job 进度不动');

  jobs = markJobDone(jobs, '16-9', 'D:/out/片语-16x9.mp4');
  assert.equal(jobs[0].status, 'done');
  assert.equal(jobs[0].progress, 100);
  assert.equal(jobs[0].outputPath, 'D:/out/片语-16x9.mp4');

  const step2 = nextJob(jobs);
  assert.equal(step2.job?.aspectRatioId, '1-1', '完成后推进到下一个');
  jobs = markJobDone(step2.jobs, '1-1', 'D:/out/片语-1x1.mp4');

  const step3 = nextJob(jobs);
  assert.equal(step3.job?.aspectRatioId, '4-3');
  jobs = markJobDone(step3.jobs, '4-3', 'D:/out/片语-4x3.mp4');

  const step4 = nextJob(jobs);
  assert.equal(step4.job, null, '队列耗尽返回 null');
  assert.ok(!isBatchRunning(jobs), '全部完成后队列不再运行');
  ok('3 个 job 按勾选顺序逐个渲染直至耗尽');
}

// ====== 3. 失败语义：当前失败 → 后续 pending 全部 skipped ======

console.log('失败语义（失败即停）:');
{
  let jobs = makeJobs();
  jobs = nextJob(jobs).jobs;                    // 16-9 rendering
  jobs = markJobDone(jobs, '16-9', 'D:/out/a.mp4');
  jobs = nextJob(jobs).jobs;                    // 1-1 rendering
  jobs = markJobFailed(jobs, '1-1', '磁盘已满');

  assert.equal(jobs[0].status, 'done', '已完成的保持 done');
  assert.equal(jobs[1].status, 'failed');
  assert.equal(jobs[1].error, '磁盘已满');
  assert.equal(jobs[2].status, 'skipped', '后续 pending 应标记跳过');
  assert.ok(!isBatchRunning(jobs), '失败后队列停止');
  assert.equal(nextJob(jobs).job, null, '失败后 nextJob 不再派发');
  ok('当前失败 → 后续 skipped，队列停止且不可再推进');
}

// ====== 4. 取消：清空队列 ======

console.log('取消清空:');
{
  let jobs = makeJobs();
  jobs = nextJob(jobs).jobs; // 一个 rendering 中
  jobs = cancelRest();
  assert.deepEqual(jobs, [], '取消后队列清空');
  assert.ok(!isBatchRunning(jobs));
  ok('cancelRest 清空队列（当前渲染由 RENDER_CANCEL 终止）');
}

// ====== 5. 边界：空队列 / 对非 rendering job 的无效操作 ======

console.log('边界:');
{
  assert.equal(nextJob([]).job, null, '空队列 nextJob 返回 null');
  assert.ok(!isBatchRunning([]), '空队列不在运行');

  const jobs = makeJobs();
  assert.equal(updateJobProgress(jobs, '16-9', 50)[0].progress, 0, 'pending 不接受进度更新');
  assert.equal(markJobDone(jobs, '16-9', 'x')[0].status, 'pending', 'pending 不能直接 done');
  assert.equal(markJobFailed(jobs, '16-9', 'x')[0].status, 'pending', 'pending 不能直接 failed');
  ok('空队列与非法状态迁移安全无副作用');
}

console.log(`\n全部通过（${passed} 组断言）`);
