/**
 * consolidate（收集工程素材）纯函数单元测试：
 * 本地路径判定、素材会话 URL 还原、同名冲突改名、工程引用路径收集
 *
 * 运行方式：node tests/unit/consolidate.test.ts
 * （Node >= 22.6 内置 TS 类型擦除，可直接运行 .ts；被测模块不依赖 electron）
 */

import assert from 'node:assert/strict';
import {isLocalFilePath, unwrapMediaSrc, uniqueCopyName, collectProjectMediaPaths} from '../../src/shared/consolidate.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('isLocalFilePath 本地/远程判定:');
assert.equal(isLocalFilePath('D:\\media\\a.mp4'), true);
assert.equal(isLocalFilePath('/home/u/a.mp4'), true);
assert.equal(isLocalFilePath('C:/a/b.png'), true);
for (const p of ['http://x.com/a.mp4', 'https://cdn.x.com/a.mp4', 'data:image/png;base64,xxx', 'blob:http://x/1', '', null, undefined]) {
  assert.equal(isLocalFilePath(p), false, `${String(p)} 应为非本地`);
}
ok('Windows/POSIX 路径为本地，http(s)/data/blob/空值跳过');

console.log('unwrapMediaSrc 会话 URL 还原:');
{
  const url = `http://127.0.0.1:17890/video?path=${encodeURIComponent('D:\\media\\a b.mp4')}`;
  assert.equal(unwrapMediaSrc(url), 'D:\\media\\a b.mp4', '视频服务器 URL 应还原为原始路径');
  assert.equal(unwrapMediaSrc('D:\\media\\a.mp4'), 'D:\\media\\a.mp4', '本地路径原样返回');
  assert.equal(unwrapMediaSrc('https://cdn.x.com/a.mp4'), 'https://cdn.x.com/a.mp4', '无 path 参数的远程 URL 原样返回');
  assert.equal(unwrapMediaSrc(''), '', '空串原样返回');
  // 不同会话端口的同一素材还原结果一致（跨会话可比的关键）
  const url2 = `http://127.0.0.1:9999/video?path=${encodeURIComponent('D:\\media\\a b.mp4')}`;
  assert.equal(unwrapMediaSrc(url2), unwrapMediaSrc(url));
  ok('会话 URL（含端口/空格）还原路径，非 URL 原样返回');
}

console.log('uniqueCopyName 同名冲突改名:');
{
  const noneTaken = () => false;
  assert.equal(uniqueCopyName('a.mp4', noneTaken), 'a.mp4', '无冲突原名返回');
  const taken = new Set(['a.mp4']);
  assert.equal(uniqueCopyName('a.mp4', (c) => taken.has(c)), 'a-1.mp4', '冲突 → -1 后缀');
  taken.add('a-1.mp4');
  assert.equal(uniqueCopyName('a.mp4', (c) => taken.has(c)), 'a-2.mp4', '再冲突 → -2 后缀');
  assert.equal(uniqueCopyName('archive.tar.gz', (c) => c === 'archive.tar.gz'), 'archive.tar-1.gz', '多点名按最后一个扩展名改名');
  assert.equal(uniqueCopyName('noext', (c) => c === 'noext'), 'noext-1', '无扩展名也能加后缀');
  assert.equal(uniqueCopyName('.hidden', () => false), '.hidden', '点开头文件原名可用时原样返回');
  ok('a.mp4 → a-1.mp4 → a-2.mp4，扩展名保留');
}

console.log('collectProjectMediaPaths 工程引用收集:');
{
  const srv = (p: string) => `http://127.0.0.1:17890/video?path=${encodeURIComponent(p)}`;
  const refs = {
    segments: [
      {
        videos: [
          {src: srv('D:\\m\\v1.mp4'), cursorTrack: 'D:\\m\\v1.cursor.json', stabilization: {trackPath: 'D:\\m\\v1.stab.json'}},
          {src: srv('D:\\m\\img.png')},
          {src: 'https://cdn.x.com/remote.mp4'}, // 远程：跳过
        ],
        narration: {path: 'D:\\m\\vo.mp3', source: 'import'},
        overlay: {path: 'D:\\m\\ov.png'},
      },
      {
        videos: [{src: srv('D:\\m\\v1.mp4')}], // 与第一段重复：去重
        narration: {path: 'C:\\cache\\tts.mp3', source: 'tts'}, // tts：跳过
        overlay: null,
      },
    ],
    bgm: {path: 'D:\\m\\bgm.mp3'},
    logo: {path: 'D:\\m\\logo.png'},
  };
  const paths = collectProjectMediaPaths(refs);
  assert.deepEqual(paths, [
    'D:\\m\\v1.mp4',
    'D:\\m\\v1.cursor.json',
    'D:\\m\\v1.stab.json',
    'D:\\m\\img.png',
    'D:\\m\\vo.mp3',
    'D:\\m\\ov.png',
    'D:\\m\\bgm.mp3',
    'D:\\m\\logo.png',
  ]);
  ok('素材/轨迹/稳定 sidecar/import 旁白/悬浮层/BGM/Logo 全收，远程与 tts 跳过，按序去重');
}
{
  assert.deepEqual(collectProjectMediaPaths({segments: []}), [], '空工程 → 空清单');
  assert.deepEqual(
    collectProjectMediaPaths({segments: [{videos: [{src: ''}]}], bgm: null, logo: null}),
    [],
    '空 src 不收集',
  );
  ok('边界：空工程/空 src → 空清单');
}

console.log(`\nconsolidate：${passed} 项断言通过`);
