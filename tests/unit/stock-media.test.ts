/**
 * Stock 素材搜索（Pexels/Pixabay 归一化 + 域名白名单）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/stock-media.test.ts
 */

import assert from 'node:assert/strict';
import {
  isAllowedStockUrl,
  orientationParam,
  pickPexelsVideoFile,
  pexelsVideosToItems,
  pexelsPhotosToItems,
  pixabayVideosToItems,
  pixabayPhotosToItems,
} from '../../src/shared/stock-media.ts';

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
};

console.log('isAllowedStockUrl（域名白名单）:');
check('两家官方 CDN 放行', () => {
  assert.ok(isAllowedStockUrl('https://videos.pexels.com/video/files/123/abc.mp4'));
  assert.ok(isAllowedStockUrl('https://images.pexels.com/photos/123/pexels-photo-123.jpeg'));
  assert.ok(isAllowedStockUrl('https://cdn.pixabay.com/download/video/2023/aa.mp4?token=x'));
  assert.ok(isAllowedStockUrl('https://i.pixabay.com/vi/abc-123_720.jpg'));
});
check('http / 任意他站 / 坏 URL 拒绝', () => {
  assert.ok(!isAllowedStockUrl('http://videos.pexels.com/x.mp4'));
  assert.ok(!isAllowedStockUrl('https://evil.com/pexels.mp4'));
  assert.ok(!isAllowedStockUrl('https://videos.pexels.com.evil.com/x.mp4'));
  assert.ok(!isAllowedStockUrl('not a url'));
});

console.log('orientationParam（方向参数映射）:');
check('pexels 原样 / pixabay 映射 / square 仅 pexels', () => {
  assert.equal(orientationParam('pexels', 'landscape'), 'landscape');
  assert.equal(orientationParam('pixabay', 'landscape'), 'horizontal');
  assert.equal(orientationParam('pixabay', 'portrait'), 'vertical');
  assert.equal(orientationParam('pixabay', 'square'), null);
  assert.equal(orientationParam('pexels', undefined), null);
});

console.log('pickPexelsVideoFile（变体挑选）:');
const files = [
  {link: 'https://videos.pexels.com/a.mp4', quality: 'hd', width: 3840, height: 2160, file_type: 'video/mp4'},
  {link: 'https://videos.pexels.com/b.mp4', quality: 'hd', width: 1920, height: 1080, file_type: 'video/mp4'},
  {link: 'https://videos.pexels.com/c.mp4', quality: 'sd', width: 640, height: 360, file_type: 'video/mp4'},
  {link: 'https://videos.pexels.com/d.mov', quality: 'hd', width: 4096, height: 2160, file_type: 'video/quicktime'},
];
check('≤1080p 里取最大；全超 1080p 取最小；非 mp4 排除', () => {
  assert.equal(pickPexelsVideoFile(files)?.link, 'https://videos.pexels.com/b.mp4');
  const over1080 = files.filter((f) => (f.width ?? 0) > 1920 && f.file_type === 'video/mp4');
  assert.equal(over1080.length, 1); // a.mp4（3840）超 1080p 且是 mp4，被 within 过滤掉不选中
  assert.equal(pickPexelsVideoFile([
    {link: 'https://x/4k.mp4', quality: 'uhd', width: 3840, height: 2160, file_type: 'video/mp4'},
    {link: 'https://x/2560.mp4', quality: 'uhd', width: 2560, height: 1440, file_type: 'video/mp4'},
  ])?.link, 'https://x/2560.mp4');
  assert.equal(pickPexelsVideoFile([{link: '', quality: 'sd', width: null, height: null, file_type: 'video/mp4'}]), null);
});

console.log('pexelsVideosToItems:');
check('归一化字段 + 下载链接取选中变体', () => {
  const items = pexelsVideosToItems({videos: [{
    id: 123, duration: 12, width: 1920, height: 1080, url: 'https://www.pexels.com/video/123/',
    image: 'https://images.pexels.com/videos/123/img.jpg', user: {name: 'Alice'},
    video_files: files,
  }]});
  assert.equal(items.length, 1);
  assert.equal(items[0].provider, 'pexels');
  assert.equal(items[0].id, '123');
  assert.equal(items[0].author, 'Alice');
  assert.equal(items[0].durationSec, 12);
  assert.equal(items[0].downloadUrl, 'https://videos.pexels.com/b.mp4');
});
check('无 mp4 变体的条目被跳过 / 非法输入空数组', () => {
  assert.deepEqual(pexelsVideosToItems({videos: [{id: 1, duration: 1, width: 1, height: 1, url: '', image: '', user: {name: ''}, video_files: []}]}), []);
  assert.deepEqual(pexelsVideosToItems({}), []);
  assert.deepEqual(pexelsVideosToItems(null), []);
});

console.log('pexelsPhotosToItems:');
check('归一化 + alt 缺省', () => {
  const items = pexelsPhotosToItems({photos: [
    {id: 9, width: 4000, height: 3000, url: 'https://www.pexels.com/photo/9/', photographer: 'Bob', src: {large2x: 'https://images.pexels.com/photos/9/l2x.jpeg', large: 'https://images.pexels.com/photos/9/l.jpeg'}, alt: 'a city'},
    {id: 10, width: 100, height: 100, url: '', photographer: '', src: {large2x: '', large: ''}, alt: null},
  ]});
  assert.equal(items.length, 2);
  assert.equal(items[0].downloadUrl, 'https://images.pexels.com/photos/9/l2x.jpeg');
  assert.equal(items[0].title, 'a city');
  assert.equal(items[1].title, 'Pexels 图片');
});

console.log('pixabayVideosToItems:');
check('large 优先 + 标签切分', () => {
  const items = pixabayVideosToItems({hits: [{
    id: 77, duration: 8, tags: 'city, night, drone', pageURL: 'https://pixabay.com/videos/77/', user: 'Carol',
    videos: {
      large: {url: 'https://cdn.pixabay.com/video/77/large.mp4', width: 1920, height: 1080, thumbnail: 'https://i.pixabay.com/vi/77.jpg'},
      small: {url: 'https://cdn.pixabay.com/video/77/small.mp4', width: 640, height: 360, thumbnail: ''},
    },
  }]});
  assert.equal(items.length, 1);
  assert.equal(items[0].downloadUrl, 'https://cdn.pixabay.com/video/77/large.mp4');
  assert.deepEqual(items[0].tags, ['city', 'night', 'drone']);
  assert.equal(items[0].durationSec, 8);
});
check('无可用变体跳过 / 非法输入', () => {
  assert.deepEqual(pixabayVideosToItems({hits: [{id: 1, duration: 1, tags: '', pageURL: '', user: '', videos: {}}]}), []);
  assert.deepEqual(pixabayVideosToItems({}), []);
});

console.log('pixabayPhotosToItems:');
check('webformatURL 下载 + previewURL 缩略', () => {
  const items = pixabayPhotosToItems({hits: [{
    id: 55, webformatURL: 'https://pixabay.com/get/abc.jpg', previewURL: 'https://cdn.pixabay.com/photo/2023/preview.jpg',
    imageWidth: 1920, imageHeight: 1080, user: 'Dan', pageURL: 'https://pixabay.com/photos/55/', tags: 'ocean, wave',
  }]});
  assert.equal(items[0].downloadUrl, 'https://pixabay.com/get/abc.jpg');
  assert.equal(items[0].previewUrl.includes('cdn.pixabay.com'), true);
  assert.equal(items[0].title, 'ocean / wave');
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
