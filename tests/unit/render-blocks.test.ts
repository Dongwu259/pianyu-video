/**
 * 段级渲染分块与缓存键（shared/render-blocks.ts）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/render-blocks.test.ts
 * （被测模块为纯函数、不依赖 electron）
 */

import assert from 'node:assert/strict';
import {
  computeRenderBlocks,
  blockCacheKey,
  concatListContent,
  normalizeMediaUrl,
  RENDER_CACHE_VERSION,
  type BlockKeyContext,
  type RenderBlock,
} from '../../src/shared/render-blocks.ts';
import type {Segment} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const seg = (id: string, templateId: string, duration: number, extra: Partial<Segment> = {}): Segment =>
  ({
    id,
    templateId,
    videos: [],
    text: {title: '', subtitle: '', features: [], brandName: ''},
    style: {},
    layout: {
      videoWidthRatio: 0.6, videoHeightRatio: 0.5, videoOffsetX: 0, videoOffsetY: 0,
      rotateX: 5, rotateY: 0, rotateZ: 0, perspective: 1200, scale: 1, borderRadius: 12,
    },
    duration,
    transition: 'crossfade',
    ...extra,
  }) as Segment;

const SEGMENTS = [
  seg('a', 'RevealSlide', 4),
  seg('b', 'KenBurns', 3),
  seg('c', 'TextSlide', 2),
  seg('d', 'MinimalFloat', 5),
];

console.log('computeRenderBlocks:');
{
  // 4 段 × 30fps：内容帧 120+90+60+150=420，末段淡黑 15 帧 → endFrame 434
  const plan = computeRenderBlocks(SEGMENTS, [], 30)!;
  assert.ok(plan);
  assert.equal(plan.blocks.length, 4);
  assert.equal(plan.totalFrames, 435);
  assert.deepEqual(
    plan.blocks.map((b) => [b.startFrame, b.endFrame]),
    [[0, 119], [120, 209], [210, 269], [270, 434]],
  );
  assert.deepEqual(plan.blocks.map((b) => b.frames), [120, 90, 60, 165]);
  assert.deepEqual(plan.blocks.map((b) => b.segIndex), [0, 1, 2, 3]);
  ok('块边界 = 各段内容起点；末块含尾部淡黑');
}
{
  // 中间夹一个引用已删除模板的段（时长 0）：不产生块，后续段边界连续
  const withDead = [seg('a', 'RevealSlide', 4), seg('x', 'gone-template', 9), seg('b', 'KenBurns', 3), seg('c', 'TextSlide', 2)];
  const plan = computeRenderBlocks(withDead, [], 30)!;
  assert.equal(plan.blocks.length, 3);
  assert.equal(plan.blocks[1].startFrame, 120);
  assert.equal(plan.blocks[1].segIndex, 2);
  ok('零时长段从时间线消失、不产生块');
}
{
  assert.equal(computeRenderBlocks([seg('a', 'RevealSlide', 4), seg('b', 'KenBurns', 3)], [], 30), null);
  assert.equal(computeRenderBlocks([], [], 30), null);
  ok('少于 3 个可渲染段返回 null（分块开销大于收益）');
}
{
  // 末段不可渲染：无尾部淡黑，末块终于最后一段内容末帧
  const tailDead = [seg('a', 'RevealSlide', 4), seg('b', 'KenBurns', 3), seg('c', 'TextSlide', 2), seg('x', 'gone', 9)];
  const plan = computeRenderBlocks(tailDead, [], 30)!;
  assert.equal(plan.totalFrames, 270);
  assert.equal(plan.blocks[2].endFrame, 269);
  ok('末段不可渲染时不追加淡黑帧');
}
{
  // 自定义模板：customTemplates 里有定义才算可渲染
  const custom = [seg('a', 'custom-x', 4), seg('b', 'custom-x', 3), seg('c', 'custom-x', 2)];
  assert.equal(computeRenderBlocks(custom, [], 30), null);
  assert.ok(computeRenderBlocks(custom, ['custom-x'], 30));
  ok('自定义模板按 customTemplates 定义判定可渲染');
}

console.log('blockCacheKey:');
const baseCtx = (over: Partial<BlockKeyContext> = {}): BlockKeyContext => ({
  appVersion: '1.0.0',
  compositionId: 'MultiSegment-16-9',
  width: 1920,
  height: 1080,
  fps: 30,
  codec: 'h264',
  audioCodec: 'aac',
  crf: 23,
  x264Preset: 'medium',
  muted: false,
  encoder: 'software',
  format: 'mp4',
  globalProps: {texture: 'clean', licensed: true},
  segments: SEGMENTS,
  ...over,
});
const blocksOf = (ctx: BlockKeyContext): string[] => {
  const plan = computeRenderBlocks(ctx.segments, [], 30)!;
  return plan.blocks.map((b) => blockCacheKey(ctx, b));
};
{
  const keys = blocksOf(baseCtx());
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4);
  ok('各段块键互不相同');
}
{
  // 改第 2 段文案（只动内容，不动时长/转场）：邻段窗口（块 0/1/2）变键，
  // 远处的块 3（窗口只含 seg 2/3）保持命中
  const edited = [...SEGMENTS];
  edited[1] = {...edited[1], text: {title: '新文案', subtitle: '', features: [], brandName: ''}};
  const before = blocksOf(baseCtx());
  const after = blocksOf(baseCtx({segments: edited}));
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[1], before[1]);
  assert.notEqual(after[2], before[2]);
  assert.equal(after[3], before[3]);
  ok('段内容变更只失效本块与相邻块（转场/旁白跨块）');
}
{
  // 改任意段时长：全片时间轴平移，BGM ducking/SFX 放置全变 → 所有块变键
  const edited = [...SEGMENTS];
  edited[0] = {...edited[0], duration: 6};
  const before = blocksOf(baseCtx());
  const after = blocksOf(baseCtx({segments: edited}));
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[3], before[3]);
  ok('时长变更平移全片音频事件 → 全部块失效');
}
{
  // 换编码器/画质：码流参数不同不可混拼
  const before = blocksOf(baseCtx());
  assert.notEqual(blocksOf(baseCtx({encoder: 'nvenc'}))[0], before[0]);
  assert.notEqual(blocksOf(baseCtx({crf: 20}))[0], before[0]);
  assert.notEqual(blocksOf(baseCtx({width: 1280, height: 720}))[0], before[0]);
  ok('编码器/CRF/分辨率变更使键失效');
}
{
  // 本地媒体服务的动态端口不参与键：跨会话端口变化仍命中
  const urlA = 'http://127.0.0.1:51777/video?path=D%3A%5Cclips%5Ca.mp4';
  const urlB = 'http://127.0.0.1:51888/video?path=D%3A%5Cclips%5Ca.mp4';
  assert.equal(normalizeMediaUrl(urlA), normalizeMediaUrl(urlB));
  const segsA = SEGMENTS.map((s, i) => ({...s, videos: i === 0 ? [{...seg('v', 'RevealSlide', 1).videos[0], id: 'v', src: urlA}] : s.videos}));
  const segsB = SEGMENTS.map((s, i) => ({...s, videos: i === 0 ? [{...seg('v', 'RevealSlide', 1).videos[0], id: 'v', src: urlB}] : s.videos}));
  assert.equal(
    blockCacheKey(baseCtx({segments: segsA as Segment[]}), {index: 0, segIndex: 0, startFrame: 0, endFrame: 119, frames: 120}),
    blockCacheKey(baseCtx({segments: segsB as Segment[]}), {index: 0, segIndex: 0, startFrame: 0, endFrame: 119, frames: 120}),
  );
  ok('本地媒体 URL 端口归一化：跨会话端口变化不破缓存');
  // 远程 URL 原样参与（不同地址视为不同内容）
  assert.notEqual(
    normalizeMediaUrl('https://cdn.a.com/x.mp4'),
    normalizeMediaUrl('https://cdn.b.com/x.mp4'),
  );
  ok('远程 URL 不归一化');
}
{
  // 全局 props 变化（如质感/授权）影响所有帧 → 全部块失效
  const before = blocksOf(baseCtx());
  const after = blocksOf(baseCtx({globalProps: {texture: 'film', licensed: true}}));
  assert.notEqual(after[2], before[2]);
  ok('全局视觉 props 变更使键失效');
}
{
  // 旁白存在性/时长是时间轴签名的一部分
  const withNarr = SEGMENTS.map((s, i) =>
    i === 1 ? {...s, narration: {text: 't', src: 'http://127.0.0.1:1/video?path=n.mp3', duration: 2.5, volume: 1}} : s,
  );
  const before = blocksOf(baseCtx());
  const after = blocksOf(baseCtx({segments: withNarr}));
  assert.notEqual(after[0], before[0]);
  assert.notEqual(after[3], before[3]);
  ok('旁白窗口变化影响全片 ducking 曲线 → 全部块失效');
}
{
  // 素材文件指纹（同名文件被替换）
  const ctxA = baseCtx({videoFingerprints: [['100:200'], [], [], []]});
  const ctxB = baseCtx({videoFingerprints: [['100:201'], [], [], []]});
  const block: RenderBlock = {index: 0, segIndex: 0, startFrame: 0, endFrame: 119, frames: 120};
  assert.notEqual(blockCacheKey(ctxA, block), blockCacheKey(ctxB, block));
  ok('素材文件指纹变更使键失效');
}

console.log('concatListContent:');
{
  assert.equal(
    concatListContent(['D:\\a b\\x.mp4', "it's.mp4"]),
    "file 'D:/a b/x.mp4'\nfile 'it'\\''s.mp4'\n",
  );
  ok('反斜杠转正斜杠、单引号按 concat 规则转义');
}
{
  assert.equal(
    concatListContent(['a.mp4', 'b.mp4'], [3, 2.5]),
    "file 'a.mp4'\nduration 3\nfile 'b.mp4'\nduration 2.5\n",
  );
  // 非法/缺省时长不输出 duration 行
  assert.equal(concatListContent(['a.mp4'], [NaN]), "file 'a.mp4'\n");
  assert.equal(concatListContent(['a.mp4'], [0]), "file 'a.mp4'\n");
  ok('显式视频时长行：防止 concat demuxer 按含 priming 的音频时长偏移下一块 PTS');
}
{
  assert.equal(typeof RENDER_CACHE_VERSION, 'number');
  ok('缓存结构版本常量存在');
}

console.log(`\nrender-blocks: ${passed} 组断言全部通过`);
if (passed < 14) process.exit(1);
