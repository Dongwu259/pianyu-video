/**
 * 工程文件（.vtproj）纯逻辑单元测试
 *
 * 运行方式：node tests/unit/project-file.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProjectFile,
  parseProjectFile,
  saveProjectFile,
  readProjectFile,
  collectMediaPaths,
  checkMediaMissing,
  PROJECT_FILE_VERSION,
} from '../../src/main/services/projectFile.ts';
import type {ProjectFileData} from '../../src/main/services/projectFile.ts';
import {clipSrcToPath} from '../../src/renderer/utils/clipPath.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 构造样例工程数据 ======

/** 模拟内存中 clip.src 的本地视频服务器 URL（端口每会话随机） */
const MEDIA_PATH = 'D:\\素材库\\片头 动画.mp4';
const SESSION_URL = `http://127.0.0.1:54321/video?path=${encodeURIComponent(MEDIA_PATH)}`;
const BGM_PATH = 'D:\\音乐\\bgm.mp3';

const makeData = (): ProjectFileData => ({
  aspectRatioId: '16-9',
  orientation: 'landscape',
  segments: [
    {
      id: 'seg-1',
      templateId: 'RevealSlide',
      videos: [
        {
          id: 'clip-1',
          src: SESSION_URL,
          name: '片头 动画.mp4',
          width: 1920,
          height: 1080,
          duration: 6.5,
          type: 'video',
          trimStart: 1,
          trimEnd: 5,
          trimmedDuration: 4,
        },
      ],
      text: {title: '标题', subtitle: '副标题', features: ['特点1', '特点2'], brandName: '品牌'},
      style: {},
      layout: {contentArea: {x: 0.1, y: 0.1, width: 0.8, height: 0.8}, videoArea: {x: 0.2, y: 0.2, width: 0.6, height: 0.6}},
      duration: 8,
      transition: 'crossfade',
      videoEffect: 'none',
      backgroundEffect: 'none',
    },
  ],
  bgm: {name: 'bgm.mp3', path: BGM_PATH, duration: 30, volume: 0.6, fadeIn: 1, fadeOut: 2, peaks: [0.1, 0.5, 0.9]},
  qualityPreset: 'high',
  renderSettings: {crf: 18, scale: 1, fps: 30},
  activeSegmentIndex: 0,
});

/** 模拟渲染进程 serializeProject：clip.src 由会话 URL 还原为原始路径，bgm 去掉 src */
const serializeLikeRenderer = (data: ProjectFileData): ProjectFileData => ({
  ...data,
  segments: data.segments.map((seg) => ({
    ...seg,
    videos: seg.videos.map((v) => ({...v, src: clipSrcToPath(v.src)})),
  })),
  bgm: data.bgm ? (({src: _src, ...rest}: typeof data.bgm & {src?: string}) => rest)(data.bgm) : null,
});

// ====== 1. round-trip：build → save → read → 字段一致 ======

console.log('round-trip 序列化/解析:');
{
  const data = serializeLikeRenderer(makeData());
  const payload = buildProjectFile('我的宣传片', data);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtproj-test-'));
  const filePath = path.join(tmpDir, '我的宣传片.vtproj');
  saveProjectFile(filePath, payload);

  // 原子写：完成后不应残留 .tmp
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, '原子写后不应残留 .tmp 文件');
  ok('原子写不残留 .tmp');

  const parsed = readProjectFile(filePath);
  assert.equal(parsed.app, 'promo-video-generator');
  assert.equal(parsed.format, 'vtproj');
  assert.equal(parsed.version, PROJECT_FILE_VERSION);
  assert.equal(parsed.name, '我的宣传片');
  assert.deepEqual(parsed.data, data, 'round-trip 后 data 字段应逐一相等');
  ok('round-trip 字段一致（name/data 深比较相等）');

  // 序列化后 clip.src 是原始路径，不含 127.0.0.1
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(!raw.includes('127.0.0.1'), '工程文件不应包含本地服务器地址 127.0.0.1');
  const clipSrc = parsed.data.segments[0].videos[0].src;
  assert.equal(clipSrc, MEDIA_PATH, 'clip.src 应还原为原始路径');
  ok('clip.src 序列化后是原始路径，不含 127.0.0.1');

  // bgm 不持久化 src，但 path 等字段保留
  assert.equal((parsed.data.bgm as Record<string, unknown>).src, undefined, 'bgm 不应持久化 src');
  assert.equal(parsed.data.bgm?.path, BGM_PATH);
  ok('bgm 去掉 src、保留 path/volume/peaks 等字段');

  // collectMediaPaths 覆盖片段素材与背景音乐
  assert.deepEqual(collectMediaPaths(parsed.data), [MEDIA_PATH, BGM_PATH]);
  ok('collectMediaPaths 收集片段素材 + 背景音乐路径');

  fs.rmSync(tmpDir, {recursive: true, force: true});
}

// ====== 2. clipSrcToPath：URL ↔ 路径 ======

console.log('clipSrcToPath 路径还原:');
{
  assert.equal(clipSrcToPath(SESSION_URL), MEDIA_PATH, '应解码出原始路径（含中文/空格）');
  assert.equal(clipSrcToPath(MEDIA_PATH), MEDIA_PATH, '已是路径的输入应原样返回');
  assert.equal(clipSrcToPath(''), '', '空字符串原样返回');
  assert.equal(clipSrcToPath('http://example.com/remote.mp4'), 'http://example.com/remote.mp4', '无 path 参数的 URL 原样返回');
  ok('会话 URL 正确还原原始路径，路径/空值/无 path 参数原样返回');
}

// ====== 3. 错误场景：坏 JSON / 错 format / 更高 version / 缺字段 ======

console.log('错误场景中文报错:');
{
  assert.throws(() => parseProjectFile('{ 这不是 json'), /工程文件已损坏或不是有效的 JSON 文件/);
  ok('坏 JSON → 报「工程文件已损坏」');

  const badFormat = JSON.stringify({...buildProjectFile('x', makeData()), format: 'other'});
  assert.throws(() => parseProjectFile(badFormat), /不是本软件的工程文件/);
  ok('错误 format → 报「不是本软件的工程文件」');

  const wrongApp = JSON.stringify({...buildProjectFile('x', makeData()), app: 'other-app'});
  assert.throws(() => parseProjectFile(wrongApp), /不是本软件的工程文件/);
  ok('错误 app 标识 → 报「不是本软件的工程文件」');

  const higherVersion = JSON.stringify({...buildProjectFile('x', makeData()), version: PROJECT_FILE_VERSION + 1});
  assert.throws(() => parseProjectFile(higherVersion), /更新版本的软件创建/);
  ok('更高 version → 报「由更新版本的软件创建」');

  const noSegments = JSON.stringify({...buildProjectFile('x', makeData()), data: {aspectRatioId: '16-9'}});
  assert.throws(() => parseProjectFile(noSegments), /片段数据缺失或已损坏/);
  ok('segments 缺失 → 报「片段数据缺失或已损坏」');

  const badSegment = serializeLikeRenderer(makeData());
  (badSegment.segments[0] as Record<string, unknown>).videos = 'not-an-array';
  const badSegRaw = JSON.stringify(buildProjectFile('x', badSegment));
  assert.throws(() => parseProjectFile(badSegRaw), /片段数据缺失或已损坏/);
  ok('片段 videos 非数组 → 报「片段数据缺失或已损坏」');
}

// ====== 4. checkMediaMissing：存在/不存在判断 ======

console.log('checkMediaMissing 存在性检查:');
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtproj-test-'));
  const existing = path.join(tmpDir, 'exists.mp4');
  fs.writeFileSync(existing, 'dummy');
  const missing = path.join(tmpDir, 'gone.mp4');

  assert.deepEqual(checkMediaMissing([existing]), [], '存在的文件不应判为缺失');
  assert.deepEqual(checkMediaMissing([existing, missing]), [missing], '只返回缺失路径');
  assert.deepEqual(checkMediaMissing([]), [], '空输入返回空数组');
  ok('存在/不存在/空输入判断正确');

  fs.rmSync(tmpDir, {recursive: true, force: true});
}

console.log(`\n全部通过（${passed} 组断言）`);
