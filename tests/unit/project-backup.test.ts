/**
 * 工程保存滚动备份（projectBackup.ts）单元测试
 *
 * 运行方式：npx tsx tests/unit/project-backup.test.ts
 * （被测模块不依赖 electron；集成段用 os.tmpdir() 真实文件系统跑一轮）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatBackupStamp,
  buildBackupName,
  listBackupsFor,
  planBackupPrune,
  createRollingBackup,
  PROJECT_BACKUP_KEEP,
} from '../../src/main/services/projectBackup.ts';
import {buildProjectFile, saveProjectFile, parseProjectFile} from '../../src/main/services/projectFile.ts';
import type {ProjectFileData} from '../../src/main/services/projectFile.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 最小合法工程数据（保存/解析 round-trip 用） */
const makeData = (title: string): ProjectFileData => ({
  aspectRatioId: '16-9',
  orientation: 'landscape',
  segments: [
    {
      id: 'seg-1',
      templateId: 'RevealSlide',
      videos: [],
      text: {title, subtitle: '', features: [], brandName: ''},
      style: {},
      layout: {},
      duration: 5,
      transition: 'crossfade',
      videoEffect: 'none',
      backgroundEffect: 'none',
    } as ProjectFileData['segments'][number],
  ],
  bgm: null,
  logo: null,
  captionStyle: {} as ProjectFileData['captionStyle'],
  renderSettings: {} as ProjectFileData['renderSettings'],
  activeSegmentIndex: 0,
});

// ====== 1. 时间戳与备份文件名 ======

console.log('时间戳与备份文件名:');
{
  assert.equal(formatBackupStamp(new Date(2026, 8, 2, 9, 5, 3)), '20260902-090503', '月日时分秒应补零');
  assert.equal(formatBackupStamp(new Date(2026, 11, 31, 23, 59, 59)), '20261231-235959');
  ok('formatBackupStamp 定长补零（字典序 = 时间序）');

  assert.equal(buildBackupName('我的工程.vtproj', '20260902-153000'), '我的工程.vtproj.20260902-153000.vtproj');
  ok('buildBackupName 形如 <目标文件名>.<yyyyMMdd-HHmmss>.vtproj');
}

// ====== 2. listBackupsFor：只认本目标前缀 + 严格时间戳形态 ======

console.log('listBackupsFor 前缀筛选:');
{
  const dirFiles = [
    'a.vtproj.20260901-100000.vtproj',
    'a.vtproj.20260902-100000.vtproj',
    'a.vtproj', // 工程本体不是备份
    'other.vtproj.20260901-100000.vtproj', // 别的工程
    'a.vtproj.2026091-100000.vtproj', // 时间戳 7 位，malformed
    'a.vtproj.bak.vtproj', // 非时间戳后缀
    'a.vtproj2.20260901-100000.vtproj', // 同前缀干扰项
    '随便.txt',
  ];
  assert.deepEqual(
    listBackupsFor(dirFiles, 'a.vtproj').sort(),
    ['a.vtproj.20260901-100000.vtproj', 'a.vtproj.20260902-100000.vtproj'],
  );
  ok('只匹配 <目标名>.<合法时间戳>.vtproj，干扰项全部排除');
  assert.deepEqual(listBackupsFor([], 'a.vtproj'), []);
  ok('空目录返回空数组');
}

// ====== 3. planBackupPrune：保留最新 keep 份 ======

console.log('planBackupPrune 决策:');
{
  const names = [1, 2, 3, 4, 5, 6, 7].map((i) => `a.vtproj.2026090${i}-100000.vtproj`);
  const {keep, remove} = planBackupPrune([...names].reverse(), 5);
  assert.deepEqual(keep, names.slice(2).reverse(), '保留最新 5 份（7→5）');
  assert.deepEqual([...remove].sort(), names.slice(0, 2), '删除最旧 2 份');
  ok('7 份输入 → 留 5 删 2，乱序输入也按时间排序');

  const few = planBackupPrune(names.slice(0, 3), 5);
  assert.deepEqual(few.keep.length, 3);
  assert.deepEqual(few.remove, []);
  ok('不足 keep 份时全保留');
  assert.deepEqual(planBackupPrune([], 5), {keep: [], remove: []});
  ok('空输入 → 空结果');
}

// ====== 4. 集成：tmpdir 真实文件系统跑「保存→备份→第 7 次保存只剩 5 份」 ======

console.log('集成：7 次保存只剩 5 份备份:');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtproj-backup-test-'));
  const target = path.join(tmpDir, '演示工程.vtproj');
  const backupDir = path.join(tmpDir, 'project-backups');
  // 注入递增时钟：避免同秒保存撞同名备份，模拟跨天连续保存
  let tick = 0;
  const now = () => new Date(2026, 8, 2 + tick, 10, 0, 0);

  // 模拟 ipc handler 的保存流程：覆盖前备份 → 原子写
  const saveLikeHandler = (i: number) => {
    const r = createRollingBackup(target, backupDir, {now});
    assert.equal(r.warning, undefined, `第 ${i} 次备份不应告警`);
    saveProjectFile(target, buildProjectFile(`演示工程-v${i}`, makeData(`第 ${i} 版`)));
    return r;
  };

  const r1 = saveLikeHandler(1);
  assert.equal(r1.backedUp, false, '首次保存（目标不存在）不备份');
  assert.equal(fs.existsSync(backupDir), false, '首次保存不应创建备份目录');
  ok('首次保存不备份、不建目录');

  for (let i = 2; i <= 7; i++) {
    tick = i;
    const r = saveLikeHandler(i);
    assert.equal(r.backedUp, true, `第 ${i} 次保存应产生备份`);
  }

  const backups = listBackupsFor(fs.readdirSync(backupDir), '演示工程.vtproj');
  assert.equal(backups.length, PROJECT_BACKUP_KEEP, '第 7 次保存后只剩 5 份备份');
  // 备份于第 i 次保存前 → 内容是第 i-1 版；最旧的第 1 版内容（0904 时间戳）应已被 prune
  const sorted = [...backups].sort();
  assert.ok(!sorted.some((n) => n.includes('20260904-100000')), '最旧一份（第 1 版内容）已被 prune');
  const oldestKept = parseProjectFile(fs.readFileSync(path.join(backupDir, sorted[0]), 'utf8'));
  assert.equal(oldestKept.name, '演示工程-v2', '保留的最旧备份是第 2 版内容');
  const newestKept = parseProjectFile(fs.readFileSync(path.join(backupDir, sorted[sorted.length - 1]), 'utf8'));
  assert.equal(newestKept.name, '演示工程-v6', '最新备份是第 7 次保存前的第 6 版内容');
  ok('备份内容逐版对应，prune 删最旧留最新');

  const current = parseProjectFile(fs.readFileSync(target, 'utf8'));
  assert.equal(current.name, '演示工程-v7', '目标文件是最新第 7 版');
  ok('备份/prune 不影响目标文件最新内容');

  fs.rmSync(tmpDir, {recursive: true, force: true});
}

// ====== 5. 失败路径：备份目录不可创建 → 只告警不 throw，保存照常 ======

console.log('失败路径只告警不阻断:');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtproj-backup-test-'));
  const target = path.join(tmpDir, 'a.vtproj');
  saveProjectFile(target, buildProjectFile('a', makeData('v1')));
  // backupDir 落在已存在的文件下面 → mkdir 必失败（ENOTDIR），模拟权限/磁盘类故障
  const badBackupDir = path.join(target, 'project-backups');

  const r = createRollingBackup(target, badBackupDir);
  assert.equal(r.backedUp, false);
  assert.ok(r.warning, '备份失败应返回 warning 而不是 throw');
  ok('备份失败收敛为 warning，不 throw');

  // 调用方照常被保存（模拟 handler：warning 不阻断）
  saveProjectFile(target, buildProjectFile('a', makeData('v2')));
  assert.equal(parseProjectFile(fs.readFileSync(target, 'utf8')).data.segments[0].text.title, 'v2');
  ok('备份失败后保存动作照常完成');

  fs.rmSync(tmpDir, {recursive: true, force: true});
}

console.log(`\n全部通过（${passed} 组断言）`);
