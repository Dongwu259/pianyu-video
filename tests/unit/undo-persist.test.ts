/**
 * 基建④ 撤销历史持久化单测（timeline-master-plan 持续基建带④；降级序列化纯函数）
 *
 * 锚定：降级三件（clip src 会话 URL→路径 + 内存态剥离；段=旁白/悬浮层同款；快照=bgm/logo 剥 src）；
 * 与 serializeProject 主数据同款纪律（对拍断言）；往返不变量（降级不丢纯配置字段）。
 * 跨会话端到端（保存→重开→undo 撤回上次会话编辑）由 scripts/verify-undo-persist.cjs 覆盖。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs --test tests/unit/undo-persist.test.ts
 */
import assert from 'node:assert/strict';
import './asset-stub.cjs';
import {persistClipForFile, persistSegmentForFile, persistHistorySnapshotForFile, PERSIST_UNDO_DEPTH} from '../../src/renderer/store/projectStore.ts';
import type {HistorySnapshot} from '../../src/renderer/store/historyUtils.ts';
import type {Segment, VideoClip} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const mkClip = (over: Partial<VideoClip> = {}): VideoClip =>
  ({
    id: 'c1', src: 'http://127.0.0.1:1789/video?path=D%3A%2Fmedia%2Fa.mp4', name: 'a.mp4', type: 'video',
    duration: 20, width: 1920, height: 1080, trimStart: 2, trimEnd: 10,
    cursorPoints: [{t: 0, x: 1, y: 1}], cursorClicks: [{t: 100, x: 2, y: 2}], cursorEvents: [],
    stabCorrections: [{dx: 0.1}], stabZoom: 1.02, stabSampleFps: 30, groundData: {anchors: [], samples: []},
    proxyStatus: 'ready',
    ...over,
  }) as VideoClip;

// ====== clip 降级：src→路径 + 内存态剥离（与主数据同款清单） ======
{
  const out = persistClipForFile(mkClip());
  assert.equal(out.src, 'D:/media/a.mp4', '会话 URL → 原始路径');
  assert.equal((out as {cursorPoints?: unknown}).cursorPoints, undefined, 'cursorPoints 剥离');
  assert.equal((out as {stabCorrections?: unknown}).stabCorrections, undefined, 'stabCorrections 剥离');
  assert.equal((out as {groundData?: unknown}).groundData, undefined, 'groundData 剥离');
  assert.equal((out as {proxyStatus?: unknown}).proxyStatus, undefined, 'proxyStatus 剥离');
  assert.equal(out.trimStart, 2, '纯配置保留');
  // 非 http src（已是路径/空）原样
  assert.equal(persistClipForFile(mkClip({src: ''})).src, '', '空 src 原样');
  ok('clip 降级（src→路径 + 六类内存态剥离 + 纯配置保留）');
}

// ====== 段降级：旁白/悬浮层同主数据口径 ======
{
  const seg = {
    id: 's1', templateId: 'RevealSlide', videos: [mkClip()], duration: 8, transition: 'none',
    text: {title: 'T', subtitle: '', features: [], brandName: ''}, style: {}, layout: {},
    narration: {text: '文案', source: 'import', src: 'http://127.0.0.1:1789/video?path=D%3A%2Fn.mp3', path: 'D:/n.mp3', duration: 3, volume: 1},
    overlay: {src: 'http://127.0.0.1:1789/video?path=D%3A%2Fo.png', path: 'D:/o.png', name: 'o.png', width: 100, height: 100, x: 0.5, y: 0.5, scale: 0.4},
  } as unknown as Segment;
  const out = persistSegmentForFile(seg);
  assert.equal((out.narration as {src?: string}).src, undefined, '旁白 src 剥离（path 保留待重建）');
  assert.equal(out.narration?.path, 'D:/n.mp3', '旁白 path 保留');
  assert.equal(out.overlay?.src, 'D:/o.png', '悬浮层 src → 路径');
  assert.equal(out.videos[0].src, 'D:/media/a.mp4', '段内 clip 走降级');
  const tts = persistSegmentForFile({...seg, narration: {text: 'x', source: 'tts', volume: 1}} as Segment);
  assert.deepEqual(tts.narration, {text: 'x', source: 'tts', volume: 1}, 'tts 旁白只留 text/source/volume（与主数据同款）');
  ok('段降级（旁白两态/悬浮层/clip）');
}

// ====== 快照降级：工作副本 + bgm/logo 剥 src + 纯配置往返不变 ======
{
  const snap = {
    segments: [persistSegmentForFile({id: 's1', templateId: 'RevealSlide', videos: [mkClip()], duration: 8, transition: 'none', text: {title: 'T'}, style: {}, layout: {}} as unknown as Segment)],
    activeSegmentIndex: 0,
    templateId: 'RevealSlide',
    videos: [mkClip()],
    text: {title: 'T', subtitle: '', features: [], brandName: ''},
    style: {}, layout: {}, customParams: {zoom: 1.5},
    bgm: {name: 'b', src: 'http://127.0.0.1:1789/video?path=D%3A%2Fb.mp3', path: 'D:/b.mp3', duration: 30, volume: 0.6},
    logo: {name: 'l', src: 'http://127.0.0.1:1789/video?path=D%3A%2Fl.png', path: 'D:/l.png'},
    captionStyle: {position: 'bottom'} as HistorySnapshot['captionStyle'],
    finePrint: {} as HistorySnapshot['finePrint'],
    colorGrade: {} as HistorySnapshot['colorGrade'],
    brandColor: null,
    fontMood: 'calm' as const,
    sfx: {enabled: true} as HistorySnapshot['sfx'],
    texture: 'film' as const,
    beatPulse: true,
    cursor: true,
    aspectRatioId: '16-9',
    orientation: 'landscape' as const,
    publish: {cover: {}, metadata: {title: 'x', description: '', tags: []}} as HistorySnapshot['publish'],
    source: 'user' as const,
    opName: '改片段时长/转场',
  } as unknown as HistorySnapshot;
  const out = persistHistorySnapshotForFile(snap);
  assert.equal(out.opName, '改片段时长/转场', '来源标/操作名保留（跨会话历史面板可见）');
  assert.equal((out.bgm as {src?: string}).src, undefined, '快照 bgm 剥 src');
  assert.equal((out.logo as {src?: string}).src, undefined, '快照 logo 剥 src');
  assert.equal(out.videos[0].src, 'D:/media/a.mp4', '工作副本 clip 降级');
  assert.equal(out.segments[0].videos[0].src, 'D:/media/a.mp4', '段 clip 降级');
  assert.deepEqual(out.customParams, {zoom: 1.5}, '纯配置原样');
  assert.equal(PERSIST_UNDO_DEPTH, 50, '深度上限护栏');
  ok('快照降级（工作副本/bgm/logo/来源标保留；深度 50）');
}

console.log(`\nundo-persist: ${passed} 组全过`);
