/**
 * 内置示例工程（sample:open）纯逻辑单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/sample-project.test.ts
 * （被测模块不依赖 electron；工作目录任意，仓库根路径由 import.meta.url 推导）
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  isRelativeMediaRef,
  rewriteMediaPathsToAbsolute,
  findSampleSourceDir,
  ensureSampleCopy,
  loadSampleProjectCopy,
  SAMPLE_PROJECT_FILENAME,
} from '../../src/main/services/sampleProject.ts';
import {parseProjectFile, collectMediaPaths} from '../../src/main/services/projectFile.ts';
import type {ProjectFileData} from '../../src/main/services/projectFile.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_SRC_DIR = path.join(REPO_ROOT, 'resources', 'sample-project');

/** 造一份带各类媒体引用的工程数据（相对/绝对/远程混合） */
const makeData = (): ProjectFileData => ({
  aspectRatioId: '16-9',
  orientation: 'landscape',
  segments: [
    {
      id: 'seg-1',
      templateId: 'RevealSlide',
      videos: [
        {id: 'c1', src: 'media/a.mp4', name: 'a.mp4', width: 1280, height: 720, duration: 5, type: 'video'},
        {id: 'c2', src: 'D:\\绝对路径\\b.mp4', name: 'b.mp4', width: 1280, height: 720, duration: 5, type: 'video'},
        {id: 'c3', src: 'https://example.com/c.mp4', name: 'c.mp4', width: 1280, height: 720, duration: 5, type: 'video'},
      ],
      text: {title: '标题'},
      style: {},
      layout: {
        videoWidthRatio: 0.6, videoHeightRatio: 0.5, videoOffsetX: 0, videoOffsetY: 0,
        rotateX: 5, rotateY: 0, rotateZ: 0, perspective: 1200, scale: 1, borderRadius: 12,
      },
      duration: 8,
      transition: 'crossfade',
      narration: {text: '旁白', source: 'import', path: 'media/voice.mp3'},
    },
  ],
  bgm: {name: 'bgm.mp3', path: 'media/bgm.mp3', duration: 30, volume: 0.6, fadeIn: 1, fadeOut: 2},
  logo: {path: 'media/logo.png', name: 'logo.png', position: 'topRight', size: 0.15, opacity: 1, visible: true},
  captionStyle: {position: 'bottom', fontSizeScale: 1, color: '#FFFFFF', bgOpacity: 0.45},
  renderSettings: {
    format: 'mp4', crf: 23, scale: 1, muted: false, filename: '',
    x264Preset: 'medium', encoder: 'auto', overwrite: true,
  },
  activeSegmentIndex: 0,
});

// ====== 1. isRelativeMediaRef：相对/绝对/远程/空 ======

console.log('isRelativeMediaRef 判定:');
{
  assert.equal(isRelativeMediaRef('media/a.mp4'), true, '正斜杠相对路径应重写');
  assert.equal(isRelativeMediaRef('media\\a.mp4'), true, '反斜杠相对路径应重写');
  assert.equal(isRelativeMediaRef('D:\\素材\\a.mp4'), false, '盘符绝对路径不重写');
  assert.equal(isRelativeMediaRef('/usr/local/a.mp4'), false, 'POSIX 绝对路径不重写');
  assert.equal(isRelativeMediaRef('\\\\NAS\\share\\a.mp4'), false, 'UNC 路径不重写');
  assert.equal(isRelativeMediaRef('http://example.com/a.mp4'), false, 'http URL 不重写');
  assert.equal(isRelativeMediaRef('https://example.com/a.mp4'), false, 'https URL 不重写');
  assert.equal(isRelativeMediaRef(''), false, '空串不重写');
  ok('相对/绝对/UNC/远程/空串判定正确');
}

// ====== 2. rewriteMediaPathsToAbsolute：注入目录前缀 ======

console.log('rewriteMediaPathsToAbsolute 相对路径重写:');
{
  const base = path.join(os.tmpdir(), 'sample-base');
  const data = makeData();
  const rewritten = rewriteMediaPathsToAbsolute(data, base);

  assert.equal(rewritten.segments[0].videos[0].src, path.resolve(base, 'media/a.mp4'), '相对素材路径应拼到 baseDir 下');
  assert.equal(rewritten.segments[0].videos[1].src, 'D:\\绝对路径\\b.mp4', '绝对路径原样保留');
  assert.equal(rewritten.segments[0].videos[2].src, 'https://example.com/c.mp4', '远程 URL 原样保留');
  assert.equal(rewritten.segments[0].narration?.path, path.resolve(base, 'media/voice.mp3'), '导入旁白 path 应重写');
  assert.equal(rewritten.bgm?.path, path.resolve(base, 'media/bgm.mp3'), '背景音乐 path 应重写');
  assert.equal(rewritten.logo?.path, path.resolve(base, 'media/logo.png'), 'Logo path 应重写');
  ok('片段素材/旁白/BGM/Logo 四类引用全部按规则重写');

  // 入参不被修改（纯函数）
  assert.equal(data.segments[0].videos[0].src, 'media/a.mp4', '入参不应被修改');
  ok('入参不被修改（纯函数）');

  // 重写结果可被 collectMediaPaths 收集且全为绝对路径
  const collected = collectMediaPaths(rewritten);
  assert.ok(collected.length > 0, '重写后媒体引用非空');
  for (const p of collected) {
    assert.ok(path.isAbsolute(p) || /^https?:\/\//i.test(p), `重写后应为绝对路径或远程 URL：${p}`);
  }
  ok('重写后 collectMediaPaths 收集结果均为绝对路径/远程 URL');

  // tts 旁白不参与重写（path 是 userData 缓存绝对路径，且本就不在 collectMediaPaths 内）
  const ttsData = makeData();
  ttsData.segments[0].narration = {text: '旁白', source: 'tts'};
  const ttsRewritten = rewriteMediaPathsToAbsolute(ttsData, base);
  assert.deepEqual(ttsRewritten.segments[0].narration, {text: '旁白', source: 'tts'}, 'tts 旁白原样保留');
  ok('tts 旁白不参与重写');
}

// ====== 3. findSampleSourceDir：候选目录定位 ======

console.log('findSampleSourceDir 候选定位:');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-find-'));
  const miss = path.join(tmp, 'miss');
  const hit = path.join(tmp, 'hit');
  fs.mkdirSync(miss, {recursive: true});
  fs.mkdirSync(hit, {recursive: true});
  fs.writeFileSync(path.join(hit, SAMPLE_PROJECT_FILENAME), '{}');

  assert.equal(findSampleSourceDir([miss, hit]), hit, '应返回第一个含 sample.vtproj 的候选');
  assert.equal(findSampleSourceDir([miss, path.join(tmp, 'nope')]), null, '都不含时返回 null');
  // 真实资源目录必须能被找到（开发环境布局）
  assert.equal(findSampleSourceDir([SAMPLE_SRC_DIR]), SAMPLE_SRC_DIR, '仓库内示例工程目录应存在');

  fs.rmSync(tmp, {recursive: true, force: true});
  ok('候选目录定位正确');
}

// ====== 4. ensureSampleCopy：递归复制 + 幂等跳过 ======

console.log('ensureSampleCopy 复制与幂等:');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-copy-'));
  const dest = path.join(tmp, 'copy');

  ensureSampleCopy(SAMPLE_SRC_DIR, dest);
  assert.ok(fs.existsSync(path.join(dest, SAMPLE_PROJECT_FILENAME)), '复制后工程文件应存在');
  assert.ok(fs.existsSync(path.join(dest, 'media', 'demo-clip-1.mp4')), '复制后媒体文件应存在');
  ok('递归复制完整（工程文件 + media 目录）');

  // 幂等：目标已有 sample.vtproj 时跳过，不覆盖用户对副本的修改
  const marker = path.join(dest, 'media', 'demo-clip-1.mp4');
  fs.writeFileSync(marker, 'user-modified');
  ensureSampleCopy(SAMPLE_SRC_DIR, dest);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'user-modified', '已存在的副本不应被覆盖');
  ok('副本已存在时跳过复制（不覆盖用户修改）');

  fs.rmSync(tmp, {recursive: true, force: true});
}

// ====== 5. 仓库内置 sample.vtproj：校验通过 + 媒体引用非空且为相对路径 ======

console.log('内置 sample.vtproj 校验:');
{
  const raw = fs.readFileSync(path.join(SAMPLE_SRC_DIR, SAMPLE_PROJECT_FILENAME), 'utf8');
  const payload = parseProjectFile(raw);
  const {data} = payload;

  assert.ok(data.segments.length >= 3 && data.segments.length <= 4, `示例工程应有 3~4 个片段，实际 ${data.segments.length}`);
  const templateIds = new Set(TEMPLATES.map((t) => t.id));
  for (const seg of data.segments) {
    assert.ok(templateIds.has(seg.templateId), `片段 ${seg.id} 使用了不存在的模板 ${seg.templateId}`);
    const meta = TEMPLATES.find((t) => t.id === seg.templateId)!;
    assert.ok(
      seg.videos.length >= meta.minVideos && seg.videos.length <= meta.maxVideos,
      `片段 ${seg.id}（${seg.templateId}）素材数 ${seg.videos.length} 超出模板要求 [${meta.minVideos}, ${meta.maxVideos}]`,
    );
  }
  ok('结构校验通过，模板 id 全部真实存在且素材数符合模板要求');

  const mediaPaths = collectMediaPaths(data);
  assert.ok(mediaPaths.length > 0, '媒体引用不能为空');
  for (const ref of mediaPaths) {
    assert.ok(isRelativeMediaRef(ref), `工程文件内媒体必须是相对路径（不写死机器绝对路径）：${ref}`);
    assert.ok(fs.existsSync(path.resolve(SAMPLE_SRC_DIR, ref)), `引用的媒体文件不存在：${ref}`);
  }
  ok(`媒体引用 ${mediaPaths.length} 条：全部相对路径且文件真实存在`);

  assert.ok(data.segments.some((s) => s.videos.some((v) => v.type === 'video')), '应至少一段带视频素材（画中画）');
  // 示例工程 v2（三款 3D 主打组合）不再预置烧录字幕——字幕交给用户按素材语言自行生成
  assert.ok(data.segments.every((s) => s.templateId), '每段都有模板');
  assert.ok(data.segments.length >= 4, '示例工程至少 4 段');
  ok('画中画素材 + 全段模板化（v2 结构）');
}

// ====== 6. loadSampleProjectCopy：复制后加载 → 绝对路径 + 回写 + 幂等 ======

console.log('loadSampleProjectCopy 端到端:');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-load-'));
  const dest = path.join(tmp, 'sample-project');
  ensureSampleCopy(SAMPLE_SRC_DIR, dest);

  const {payload, projectPath, mediaPaths} = loadSampleProjectCopy(dest);
  assert.ok(projectPath.endsWith(SAMPLE_PROJECT_FILENAME));
  assert.ok(mediaPaths.length > 0, '重写后媒体路径非空');
  for (const p of mediaPaths) {
    assert.ok(path.isAbsolute(p), `加载后应为绝对路径：${p}`);
    assert.ok(p.startsWith(path.resolve(dest)), `绝对路径应落在副本目录内：${p}`);
    assert.ok(fs.existsSync(p), `重写后的媒体文件应存在：${p}`);
  }
  ok('相对路径重写为副本目录下的绝对路径且文件存在');

  // 回写后的副本仍能通过校验（可被 project:openPath 再次打开）
  const reparsed = parseProjectFile(fs.readFileSync(projectPath, 'utf8'));
  assert.deepEqual(collectMediaPaths(reparsed.data), mediaPaths, '回写副本的媒体路径应与内存一致');
  ok('回写副本可再次通过工程校验（最近工程可直接打开）');

  // 幂等：再次加载已是绝对路径，不重复加前缀
  const again = loadSampleProjectCopy(dest);
  assert.deepEqual(again.mediaPaths, mediaPaths, '重复加载不应产生双重前缀');
  ok('重复加载幂等（无双重前缀）');

  fs.rmSync(tmp, {recursive: true, force: true});
}

console.log(`\n全部通过（${passed} 组断言）`);
