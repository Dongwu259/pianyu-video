/**
 * 阶段三单测：contact sheet 规划（frame-sheet）+ scan_media / view_media_frames
 * contact-sheet 模式 / set_project_style frameBudget 的参数校验。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/frame-sheet.test.ts
 */

import assert from 'node:assert/strict';
import {cellOrigin, cellSize, CONTACT_SHEET_DEFAULT_CELLS, CONTACT_SHEET_MAX_CELLS, planContactSheet} from '../../src/shared/frame-sheet.ts';
import {validateScanMediaArgs, validateViewMediaFramesArgs, validateSetProjectStyleArgs} from '../../src/shared/llm-tools.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('frame-sheet（缩略图墙规划 + 阶段三校验器）');

t('planContactSheet：中点均匀采样 + 网格钳制 + 钳 144 格', () => {
  const p = planContactSheet(100, 100);
  assert.equal(p.timesSec.length, 100);
  assert.ok(Math.abs(p.timesSec[0] - 0.5) < 0.01, '首格应 0.5s（中点采样防首帧黑场）');
  assert.ok(Math.abs(p.timesSec[99] - 99.5) < 0.01, '末格应 99.5s');
  assert.ok(p.cols * p.rows >= 100, `网格应容下全部格（${p.cols}×${p.rows}）`);
  assert.ok(p.cols <= 12);
  assert.equal(planContactSheet(100, 999).timesSec.length, CONTACT_SHEET_MAX_CELLS, '格数钳 144');
  assert.equal(planContactSheet(100, 30).timesSec.length, 30, '小格数不放大');
});

t('planContactSheet：时长未知退化为单帧 0s', () => {
  const p = planContactSheet(0, 100);
  assert.equal(p.timesSec.length, 1);
  assert.equal(p.timesSec[0], 0);
});

t('cellSize/cellOrigin：格内比例 + 行优先网格定位', () => {
  const c169 = cellSize(96, 1920, 1080);
  assert.equal(c169.w, 96);
  assert.equal(c169.h, 54);
  const c916 = cellSize(96, 1080, 1920); // 竖拍素材
  assert.ok(c916.h > c916.w, '竖拍格高应大于格宽');
  const plan = planContactSheet(50, 100);
  const o0 = cellOrigin(plan, 0, 54);
  const o1 = cellOrigin(plan, 1, 54);
  const oCols = cellOrigin(plan, plan.cols, 54);
  assert.equal(o0.x, 0);
  assert.equal(o1.x, 96, '第 2 格应右移一格');
  assert.equal(oCols.x, 0, '换行回 x=0');
  assert.ok(oCols.y > 0, '换行下移');
});

t('validateViewMediaFramesArgs：mode/cells 新参数', () => {
  assert.ok(validateViewMediaFramesArgs({index: 0, mode: 'contact-sheet'}).ok);
  assert.ok(validateViewMediaFramesArgs({index: 0, mode: 'contact-sheet', cells: 60}).ok);
  assert.ok(!validateViewMediaFramesArgs({index: 0, mode: 'tile'}).ok, '非法 mode 拒绝');
  assert.ok(!validateViewMediaFramesArgs({index: 0, cells: 9}).ok, 'cells<10 拒绝');
  assert.ok(!validateViewMediaFramesArgs({index: 0, cells: 200}).ok, 'cells>144 拒绝');
  assert.ok(validateViewMediaFramesArgs({index: 0}).ok, '缺省普通模式不受影响');
});

t('validateScanMediaArgs：index 必填 + videoIndex 可选', () => {
  assert.ok(validateScanMediaArgs({index: 2}).ok);
  assert.ok(validateScanMediaArgs({index: 2, videoIndex: 1}).ok);
  assert.ok(!validateScanMediaArgs({}).ok);
  assert.ok(!validateScanMediaArgs({index: -1}).ok);
  assert.ok(!validateScanMediaArgs({index: 0, videoIndex: -2}).ok);
});

t('validateSetProjectStyleArgs：frameBudget 0-200 整数', () => {
  assert.ok(validateSetProjectStyleArgs({frameBudget: 24}).ok);
  assert.ok(validateSetProjectStyleArgs({frameBudget: 0}).ok, '0=不限合法');
  assert.ok(!validateSetProjectStyleArgs({frameBudget: -1}).ok);
  assert.ok(!validateSetProjectStyleArgs({frameBudget: 201}).ok);
  assert.ok(!validateSetProjectStyleArgs({frameBudget: 12.5}).ok, '非整数拒绝');
  assert.ok(validateSetProjectStyleArgs({frameBudget: 12, texture: 'film'}).ok);
  void CONTACT_SHEET_DEFAULT_CELLS;
});

console.log(`\n${passed} 项通过`);
