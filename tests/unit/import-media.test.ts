/**
 * import_segment_media 工具（shared/llm-tools.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/import-media.test.ts
 * （被测模块在 src/shared 下，不依赖 electron，可被 tsx 直接加载）
 *
 * 覆盖：工具注册（schema/required/sideEffect）→ validateImportMediaArgs 参数校验。
 */

import assert from 'node:assert/strict';
import {LLM_TOOL_REGISTRY, validateImportMediaArgs} from '../../src/shared/llm-tools.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 工具注册 ======

console.log('工具注册:');
{
  const entry = LLM_TOOL_REGISTRY.find((t) => t.name === 'import_segment_media');
  assert.ok(entry, 'import_segment_media 未注册');
  assert.deepEqual(entry.parameters.required, ['index', 'path']);
  assert.equal(entry.sideEffect, true, '读取本地文件应标记 sideEffect 弹确认卡');
  assert.ok(entry.description.includes('导入'), 'description 缺「导入」');
  ok('import_segment_media 已注册（required=[index,path]，sideEffect）');
}

// ====== validateImportMediaArgs ======

console.log('validateImportMediaArgs:');
{
  const r = validateImportMediaArgs({index: 0, path: 'D:\\media\\rec.mp4'});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.index, 0);
    assert.equal(r.args.path, 'D:\\media\\rec.mp4');
  }
  ok('index=0 + 合法路径通过（下标含 0）');
}
{
  const r = validateImportMediaArgs({path: '/tmp/a.png'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /index/);
  ok('缺 index 报错');
}
{
  const r = validateImportMediaArgs({index: -1, path: '/tmp/a.png'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /index/);
  ok('负 index 报错');
}
{
  const r = validateImportMediaArgs({index: 1.5, path: '/tmp/a.png'});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /index/);
  ok('非整数 index 报错');
}
{
  const r = validateImportMediaArgs({index: 0});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /path/);
  ok('缺 path 报错');
}
{
  const r = validateImportMediaArgs({index: 0, path: ''});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /path/);
  ok('空 path 报错');
}
{
  const r = validateImportMediaArgs(null);
  assert.equal(r.ok, false);
  ok('null 参数报错（index 缺失优先）');
}

console.log(`\n共 ${passed} 项全部通过`);
