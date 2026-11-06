/**
 * 本地曲库（扫描过滤 + 分析缓存）单元测试
 *
 * 运行方式：node tests/unit/music-library.test.ts
 * （被测模块 src/main/services/musicLibrary.ts 不依赖 electron，可在纯 Node 跑）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isMusicFileName,
  filterMusicNames,
  scanMusicDir,
  readMusicAnalysisCache,
  writeMusicAnalysisCache,
  lookupMusicAnalysis,
  upsertMusicAnalysis,
  MUSIC_ANALYSIS_CACHE_LIMIT,
  type MusicAnalysisCache,
} from '../../src/main/services/musicLibrary.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 建临时目录夹具，用完即删 */
const withTmpDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musiclib-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
};

// ====== 扩展名判断 / 过滤排序 ======

console.log('isMusicFileName / filterMusicNames:');
{
  // 收录的五种扩展名 + 大小写不敏感
  for (const n of ['a.mp3', 'b.WAV', 'c.M4a', 'd.ogg', 'e.FLAC', 'f.song.mp3']) {
    assert.equal(isMusicFileName(n), true, `${n} 应被收录`);
  }
  // 非音频 / 未收录扩展名 / 无扩展名一律排除（aac 不在曲库收录范围内）
  for (const n of ['g.txt', 'h.mp4', 'i.aac', 'noext', '.mp3']) {
    assert.equal(isMusicFileName(n), false, `${n} 不应收录`);
  }
  ok('扩展名过滤（大小写不敏感，aac/mp4/txt/无扩展名排除）');
}
{
  const sorted = filterMusicNames(['z.mp3', 'a.wav', 'm.txt', 'B.FLAC']);
  assert.deepEqual(sorted, ['a.wav', 'B.FLAC', 'z.mp3']);
  ok('过滤后按文件名排序');
}

// ====== 扫描目录 ======

console.log('scanMusicDir:');
withTmpDir((dir) => {
  // 夹具：音频（含大写扩展名）/ 非音频 / 名字像音频的子目录
  for (const n of ['b.mp3', 'A.WAV', 'c.m4a', 'd.ogg', 'e.flac', 'f.txt', 'g.mp4']) {
    fs.writeFileSync(path.join(dir, n), 'x');
  }
  fs.mkdirSync(path.join(dir, 'sub.mp3')); // 目录名含音频扩展名，不能当文件收录

  const tracks = scanMusicDir(dir);
  assert.deepEqual(tracks.map((t) => t.name), ['A.WAV', 'b.mp3', 'c.m4a', 'd.ogg', 'e.flac']);
  for (const t of tracks) {
    assert.equal(t.path, path.join(dir, t.name), 'path 应为完整路径');
  }
  ok('仅扫描一级音频文件（不递归、排除目录），按文件名排序');

  assert.deepEqual(scanMusicDir(''), [], '空目录设置应返回 []');
  assert.deepEqual(scanMusicDir(path.join(dir, 'not-exist')), [], '不存在目录应返回 []');
  ok('目录未设置 / 不存在返回空数组不报错');
});

// ====== 分析缓存：命中 / mtime 失效 / 上限淘汰 ======

console.log('分析缓存:');
withTmpDir((dir) => {
  const cacheFile = path.join(dir, 'music-analysis-cache.json');
  const audioPath = path.join(dir, 'a.mp3');
  fs.writeFileSync(audioPath, 'v1');
  const mtime1 = fs.statSync(audioPath).mtimeMs;

  // 写入 → 读取 → 同 mtime 命中
  let cache = readMusicAnalysisCache(cacheFile);
  assert.deepEqual(cache, {}, '缓存文件不存在时为空表');
  cache = upsertMusicAnalysis(cache, audioPath, mtime1, {duration: 3.2, peaks: [0.1, 0.9], beats: [0.5, 1.0], bpm: 120}, 1000);
  writeMusicAnalysisCache(cacheFile, cache);

  const loaded = readMusicAnalysisCache(cacheFile);
  const hit = lookupMusicAnalysis(loaded, audioPath, mtime1);
  assert.deepEqual(hit, {duration: 3.2, peaks: [0.1, 0.9], beats: [0.5, 1.0], bpm: 120});
  ok('写入后读取，同 mtime 命中（含节拍网格与 BPM）');

  // 旧格式条目（节拍检测升级前写入，无 beats 字段）按 miss 处理，触发重算补齐
  const legacy = upsertMusicAnalysis({}, audioPath, mtime1, {duration: 3.2, peaks: [0.1, 0.9]} as never, 1000);
  assert.equal(lookupMusicAnalysis(legacy, audioPath, mtime1), null);
  ok('旧格式缓存条目（无 beats）不命中，自动升级重算');

  // mtime 变化 → 失效（utimesSync 显式制造 mtime 差，避免文件系统时间粒度内同值）
  fs.writeFileSync(audioPath, 'v2-longer');
  fs.utimesSync(audioPath, new Date(), new Date(Math.ceil(mtime1) + 5000));
  const mtime2 = fs.statSync(audioPath).mtimeMs;
  assert.notEqual(mtime2, mtime1, '夹具 mtime 应变化');
  assert.equal(lookupMusicAnalysis(loaded, audioPath, mtime2), null);
  ok('mtime 变化后缓存失效');

  // 未知路径 → 未命中
  assert.equal(lookupMusicAnalysis(loaded, path.join(dir, 'other.mp3'), mtime1), null);
  ok('未知路径不命中');

  // 覆盖同一路径：新值替换旧值
  const over = upsertMusicAnalysis(loaded, audioPath, mtime2, {duration: 4.0, peaks: [0.5], beats: [], bpm: 0}, 2000);
  assert.deepEqual(lookupMusicAnalysis(over, audioPath, mtime2), {duration: 4.0, peaks: [0.5], beats: [], bpm: 0});
  assert.equal(lookupMusicAnalysis(over, audioPath, mtime1), null, '旧 mtime 记录已被替换');
  ok('同一路径重复写入覆盖旧记录');
});

// 上限淘汰：超过 200 条清最旧（cachedAt 最小）
{
  let cache: MusicAnalysisCache = {};
  for (let i = 0; i < MUSIC_ANALYSIS_CACHE_LIMIT + 5; i++) {
    cache = upsertMusicAnalysis(cache, `/music/t${i}.mp3`, 1, {duration: i, peaks: []}, i);
  }
  const keys = Object.keys(cache);
  assert.equal(keys.length, MUSIC_ANALYSIS_CACHE_LIMIT);
  for (let i = 0; i < 5; i++) {
    assert.equal(cache[`/music/t${i}.mp3`], undefined, `最旧的 t${i} 应被淘汰`);
  }
  assert.ok(cache[`/music/t${MUSIC_ANALYSIS_CACHE_LIMIT + 4}.mp3`], '最新的记录应保留');
  ok(`超过 ${MUSIC_ANALYSIS_CACHE_LIMIT} 条清最旧`);
}

// 损坏的缓存文件 → 空表不报错
withTmpDir((dir) => {
  const cacheFile = path.join(dir, 'broken.json');
  fs.writeFileSync(cacheFile, '{not json');
  assert.deepEqual(readMusicAnalysisCache(cacheFile), {});
  fs.writeFileSync(cacheFile, '[1,2]');
  assert.deepEqual(readMusicAnalysisCache(cacheFile), {}, '数组不是合法缓存表');
  ok('缓存文件损坏返回空表不报错');
});

console.log(`\nmusic-library: ${passed} 项全部通过`);
