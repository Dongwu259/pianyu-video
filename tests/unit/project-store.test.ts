/**
 * projectStore（src/renderer/store/projectStore.ts）单元测试
 *
 * 覆盖评审认定的「最脆弱且零覆盖」核心逻辑：
 * - undo/redo：快照恢复（含工作副本）、重做栈、活动下标钳制
 * - 工作副本 ↔ segments 同步：syncCurrentToSegment / loadSegmentToCurrent
 * - saveProject 保存前强制同步工作副本（丢稿盲区回归）
 * - applyAiSegmentPatch：部分更新语义（undefined 保留、captions [] 清除、旁白 src 保留）
 * - splitSegment：拆段 trim/时长划分、新段位置、活动段与工作副本跟随、一步撤销、非法拆点
 * - relinkMissingMedia：换素材保留 trim/viewport 并钳到新时长、活动段工作副本同步
 * - setCurrentDuration 钳制（0.5-60）、reorderSegments 活动段按 id 跟随
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/project-store.test.ts
 * （store 不依赖 React；window.api 仅保存链路用到，此处 stub）
 */

import assert from 'node:assert/strict';

// window stub：saveProject/pushRecentProject/clearAutosave 链路用到；confirm 恒 true
let lastSaved: {path: string; name: string; data: any} | null = null;
(globalThis as any).window = {
  api: {
    saveProject: async (path: string, name: string, data: any) => {
      lastSaved = {path, name, data};
      return {success: true, path};
    },
    getStore: async () => [],
    setStore: async () => true,
    clearAutosave: async () => ({success: true}),
  },
  alert: () => {},
  confirm: () => true,
};

const {useProjectStore, takeSnapshot, createEmptySegment} = await import('../../src/renderer/store/projectStore.ts');
const {deepClone} = await import('../../src/renderer/store/historyUtils.ts');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ===== 状态快照与重置（zustand 单例，测试间必须复位）=====
const DATA_KEYS = [
  'segments', 'activeSegmentIndex', 'orientation', 'aspectRatioId',
  'templateId', 'videos', 'text', 'style', 'layout', 'customParams',
  'renderSettings', 'appSettings', 'bgm', 'logo', 'captionStyle',
  'projectName', 'projectFilePath', 'isDirty', 'missingMedia',
  'historyPast', 'historyFuture', 'customTemplates', 'step', 'licenseStatus',
  'isRendering', 'renderProgress', 'renderOutputPath',
  'mediaIntelligence', 'editPlan',
] as const;
const initial: Record<string, unknown> = {};
{
  const s0 = useProjectStore.getState() as unknown as Record<string, unknown>;
  for (const k of DATA_KEYS) initial[k] = deepClone(s0[k]);
}
const reset = () => useProjectStore.setState(deepClone(initial) as never);
const S = () => useProjectStore.getState();

// ===== 1. undo/redo =====
console.log('undo/redo:');
{
  reset();
  // 模拟 App 历史采集：改动前快照 → 改动 → pushHistory
  const before = takeSnapshot(S());
  S().updateCurrentText({title: '标题A'});
  S().pushHistory(before);
  assert.equal(S().text.title, '标题A');
  assert.equal(S().historyPast.length, 1);

  S().undo();
  assert.equal(S().text.title, '', 'undo 恢复工作副本到改动前');
  assert.equal(S().historyFuture.length, 1, 'undo 后当前状态进重做栈');

  S().redo();
  assert.equal(S().text.title, '标题A', 'redo 重做改动');
  assert.equal(S().historyPast.length, 1);
  ok('工作副本 undo/redo 往返一致');

  // 双片段 undo 后片段数恢复；活动下标保留当前值（钳制到快照范围内），不回跳
  reset();
  S().addSegment('StackCards');
  assert.equal(S().segments.length, 2);
  S().loadSegmentToCurrent(1);
  const snap = takeSnapshot(S());
  S().removeSegment(1);
  assert.equal(S().segments.length, 1);
  S().pushHistory(snap);
  // undo 恢复双片段；当前活动下标是 0（删活动段后回退的），恢复快照后保持 0
  S().undo();
  assert.equal(S().segments.length, 2, 'undo 恢复被删片段');
  assert.equal(S().activeSegmentIndex, 0, '活动下标保留当前值（不随快照回跳）');
  assert.equal(S().templateId, S().segments[0].templateId, '工作副本与恢复后的活动段一致');
  ok('undo 恢复片段数与活动下标');
}

// ===== 2. 工作副本同步 + 保存前强制同步（丢稿回归）=====
console.log('工作副本同步 / saveProject:');
{
  reset();
  S().updateCurrentText({title: '未同步标题'});
  // 未 sync 时 segments 还是旧值
  assert.equal(S().segments[0].text.title, '');
  useProjectStore.setState({projectFilePath: 'D:\\test\\x.vtproj', isDirty: true});
  lastSaved = null;
  const saved = await S().saveProject();
  assert.equal(saved, true);
  assert.equal(lastSaved?.data.segments[0].text.title, '未同步标题', 'saveProject 必须先同步工作副本再序列化');
  assert.equal(S().isDirty, false);
  ok('saveProject 保存前强制同步工作副本（丢稿盲区回归）');

  // syncCurrentToSegment / loadSegmentToCurrent 往返
  reset();
  S().updateCurrentText({title: '第一段'});
  S().syncCurrentToSegment();
  S().addSegment('StackCards'); // addSegment 会切到新段并清空工作副本
  assert.equal(S().text.title, '', '新段工作副本为空白');
  S().loadSegmentToCurrent(0);
  assert.equal(S().text.title, '第一段', '切回第一段工作副本还原');
  ok('工作副本 ↔ segments 同步往返');
}

// ===== 3. applyAiSegmentPatch 部分更新语义 =====
console.log('applyAiSegmentPatch:');
{
  reset();
  useProjectStore.setState((s) => ({
    segments: s.segments.map((seg, i) =>
      i === 0
        ? {
            ...seg,
            narration: {text: '旧旁白', src: 'http://x/n.mp3', path: 'D:\\n.mp3', duration: 2.5, source: 'tts' as const, volume: 0.8},
            captions: [{text: '字幕1', startSec: 0, endSec: 1}],
          }
        : seg),
  }));
  // 只改文案：duration/transition/旁白/字幕都应保留
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', text: {title: 'AI改', subtitle: '', features: [], brandName: ''}} as never);
  let seg = S().segments[0];
  assert.equal(seg.text.title, 'AI改');
  assert.equal(seg.duration, 8, '未指定的 duration 保留');
  assert.equal(seg.narration?.text, '旧旁白', '未指定 narration 保留');
  assert.equal(seg.captions?.length, 1, '未指定 captions 保留');
  ok('undefined 字段一律保留');

  // narration 带新文案：保留已有 src（不重新合成也能播）
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', narration: {text: '新旁白'}} as never);
  seg = S().segments[0];
  assert.equal(seg.narration?.text, '新旁白');
  assert.equal(seg.narration?.src, 'http://x/n.mp3', '旁白音频 src 保留');
  ok('narration.text 更新保留 src');

  // captions 空数组 = 显式清除；narration 空 text = 清除旁白
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', captions: [], narration: {text: ''}} as never);
  seg = S().segments[0];
  assert.equal(seg.captions, undefined);
  assert.equal(seg.narration, undefined);
  ok('空值显式清除 captions/narration');

  // 活动段 patch 后工作副本同步刷新
  assert.equal(S().text.title, 'AI改', '活动段工作副本跟随 patch');
  ok('活动段工作副本同步');

  // 蒸馏 D2 批报的「text 部分补丁静默不落盘」复现：只给 features:[] → 其余子字段保留、features 清空
  reset();
  useProjectStore.setState((s) => ({
    segments: s.segments.map((seg, i) =>
      i === 0 ? {...seg, text: {title: '原标题', subtitle: '原副题', features: ['旧要点'], brandName: '墨息'}} : seg),
  }));
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', text: {features: []}} as never);
  seg = S().segments[0];
  assert.equal(seg.text.title, '原标题', '未指定的 title 保留');
  assert.equal(seg.text.subtitle, '原副题', '未指定的 subtitle 保留');
  assert.equal(seg.text.brandName, '墨息', '未指定的 brandName 保留');
  assert.deepEqual(seg.text.features, [], 'features:[] 显式清空');
  ok('text 部分补丁（仅 features:[]）语义正确');
}

// ===== 3b. customParams：patch 按键合并 / storyboard 直接应用 =====
console.log('customParams:');
{
  reset();
  useProjectStore.setState((s) => ({
    segments: s.segments.map((seg, i) => (i === 0 ? {...seg, customParams: {pipScale: 1.2, tiltX: 5}} : seg)),
  }));
  // patch 给出的键覆盖、未给出的键保留；未指定 customParams 时整包保留
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', customParams: {pipScale: 0.8}} as never);
  let seg = S().segments[0];
  assert.deepEqual(seg.customParams, {pipScale: 0.8, tiltX: 5}, 'patch 按键合并：覆盖 pipScale、保留 tiltX');
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', duration: 6} as never);
  seg = S().segments[0];
  assert.deepEqual(seg.customParams, {pipScale: 0.8, tiltX: 5}, '未指定 customParams 时保留');
  ok('applyAiSegmentPatch customParams 合并语义');
}
{
  reset();
  S().applyAiStoryboard([
    {templateId: 'RevealSlide', duration: 8, transition: 'crossfade', videoEffect: 'none', backgroundEffect: 'none',
      textAnim: undefined, narration: undefined, captions: undefined,
      text: {title: '', subtitle: '', features: [], brandName: ''},
      customParams: {pipScale: 1.4}},
    {templateId: 'KenBurns', duration: 6, transition: 'crossfade', videoEffect: 'none', backgroundEffect: 'none',
      textAnim: undefined, narration: undefined, captions: undefined,
      text: {title: '', subtitle: '', features: [], brandName: ''},
      customParams: undefined},
  ]);
  assert.deepEqual(S().segments[0].customParams, {pipScale: 1.4}, 'storyboard 应用 customParams');
  assert.equal(S().segments[1].customParams, undefined, '未指定则全走模板默认');
  ok('applyAiStoryboard 应用 customParams');
}

// ===== 3c. EditPlan 过期标记 =====
console.log('EditPlan stale:');
{
  reset();
  S().setEditPlan({version: 1, assignments: [], notes: [], beats: [], scenes: [], shots: []});
  S().applyAiSegmentPatch(0, {templateId: 'RevealSlide', duration: 5} as never);
  assert.equal(S().editPlan?.stale, true);
  assert.match(S().editPlan?.staleReason ?? '', /segment 0 updated/);
  ok('applyAiSegmentPatch marks EditPlan stale');
}

// ===== 4. relinkMissingMedia =====
console.log('relinkMissingMedia:');
{
  reset();
  useProjectStore.setState((s) => ({
    segments: s.segments.map((seg, i) =>
      i === 0
        ? {
            ...seg,
            videos: [{
              id: 'v1', src: '', name: 'gone.mp4', type: 'video' as const,
              width: 1920, height: 1080, duration: 30,
              trimStart: 5, trimEnd: 25, trimmedDuration: 20,
              viewport: {scale: 2, offsetX: 0.3, offsetY: -0.2},
            }],
          }
        : seg),
    videos: (s.segments[0]?.videos ?? []) as never,
  }));
  // 工作副本与 segments 对齐（模拟编辑器现状）
  useProjectStore.setState((s) => ({videos: deepClone(s.segments[0].videos) as never}));
  S().relinkMissingMedia(
    {segmentIndex: 0, videoIndex: 0, path: 'D:\\gone.mp4', name: 'gone.mp4'},
    {src: 'http://127.0.0.1:9/video?path=new', path: 'D:\\new.mp4', name: 'new.mp4', width: 1280, height: 720, duration: 10},
  );
  const v = S().segments[0].videos[0];
  assert.equal(v.name, 'new.mp4');
  assert.equal(v.trimEnd, 10, 'trimEnd 钳到新素材时长');
  assert.equal(v.trimStart, 5, 'trimStart 保留（未超新时长）');
  assert.deepEqual(v.viewport, {scale: 2, offsetX: 0.3, offsetY: -0.2}, 'viewport 取景保留');
  assert.equal(S().videos[0].name, 'new.mp4', '活动段工作副本同步');
  ok('视频 relink 保留 trim/viewport 并钳制时长');

  // BGM relink：保留音量等设置
  useProjectStore.setState({
    bgm: {name: 'old.mp3', path: 'D:\\old.mp3', src: '', duration: 60, volume: 0.4, fadeIn: 1, fadeOut: 2, peaks: []},
    missingMedia: [],
  });
  S().relinkMissingMedia(
    {segmentIndex: -1, videoIndex: -1, path: 'D:\\old.mp3', name: 'old.mp3'},
    {src: 'http://x/b.mp3', path: 'D:\\b.mp3', name: 'b.mp3'},
  );
  assert.equal(S().bgm?.name, 'b.mp3');
  assert.equal(S().bgm?.volume, 0.4, 'BGM 音量保留');
  ok('BGM relink 保留音量设置');
}

// ===== 5. 时长钳制与排序跟随 =====
console.log('时长钳制 / 排序:');
{
  reset();
  S().setCurrentDuration(999);
  assert.equal(S().segments[0].duration, 60, '上限钳到 60');
  S().setCurrentDuration(-5);
  assert.equal(S().segments[0].duration, 0.5, '下限钳到 0.5（快切蒙太奇）');
  S().setCurrentDuration(4.8);
  assert.equal(S().segments[0].duration, 4.8, '小数时长保留（节拍对齐）');
  ok('setCurrentDuration 钳制 0.5-60 且保小数');

  // reorderSegments：活动段按 id 跟随（addSegment 后活动段是最新段，即下标 2）
  reset();
  S().addSegment('StackCards');
  S().addSegment('MinimalFloat');
  const activeId = S().segments[2].id;
  S().reorderSegments(0, 2); // [seg0,seg1,seg2] → [seg1,seg2,seg0]，活动段 seg2 移到下标 1
  assert.equal(S().segments[1].id, activeId);
  assert.equal(S().activeSegmentIndex, 1, '活动下标跟随原活动片段');
  assert.equal(S().templateId, S().segments[1].templateId, '工作副本仍对应活动片段');
  ok('reorderSegments 活动段按 id 跟随');
}

// ===== 6. splitSegment =====
console.log('splitSegment:');
// 装扮段 0：30s 视频素材裁到 5-25、段时长 20，另带一张图片 clip、文案/字幕/旁白
const setupSplitFixture = () => {
  reset();
  S().addSegment('StackCards'); // 2 段；活动段切到新段（下标 1）
  useProjectStore.setState((s) => ({
    segments: s.segments.map((seg, i) =>
      i === 0
        ? {
            ...seg,
            duration: 20,
            videos: [
              {
                id: 'v1', src: 'http://x/a.mp4', name: 'a.mp4', type: 'video' as const,
                width: 1920, height: 1080, duration: 30,
                trimStart: 5, trimEnd: 25, trimmedDuration: 20,
              },
              {
                id: 'v2', src: 'http://x/b.png', name: 'b.png', type: 'image' as const,
                width: 800, height: 600, duration: 5,
                trimStart: 0, trimEnd: 5, trimmedDuration: 5,
              },
            ],
            text: {title: '标题', subtitle: '副标题', features: ['要点1'], brandName: ''},
            captions: [{text: '字幕1', startSec: 0, endSec: 2}],
            narration: {text: '旁白'},
          }
        : seg),
  }));
};
{
  // 拆非活动段（活动段在下标 1，拆下标 0）：trim/时长划分 + 新段位置 + 活动下标顺延
  setupSplitFixture();
  const originalId = S().segments[0].id;
  const activeId = S().segments[1].id;
  const okSplit = S().splitSegment(0, 8);
  assert.equal(okSplit, true);
  assert.equal(S().segments.length, 3, '拆成两段后总数 +1');
  const [first, second] = S().segments;
  assert.equal(first.id, originalId, '前半段保留原 id');
  assert.equal(first.duration, 8, '前半段时长 = atSec');
  assert.equal(first.videos[0].trimStart, 5, '前半段 trimStart 不变');
  assert.equal(first.videos[0].trimEnd, 13, '前半段 trimEnd = trimStart + atSec');
  assert.equal(first.videos[0].trimmedDuration, 8, '前半段 trimmedDuration 同步');
  assert.notEqual(second.id, originalId, '后半段使用新 id');
  assert.equal(second.duration, 12, '后半段时长 = 原时长 - atSec');
  assert.equal(second.videos[0].trimStart, 13, '后半段 trimStart = 原 trimStart + atSec');
  assert.equal(second.videos[0].trimEnd, 25, '后半段 trimEnd 不变');
  assert.equal(second.videos[0].trimmedDuration, 12, '后半段 trimmedDuration 同步');
  // 图片 clip 两段都原样复制（trim 字段不动）
  assert.equal(first.videos[1].trimEnd, 5, '图片 clip 前半段原样');
  assert.equal(second.videos[1].trimEnd, 5, '图片 clip 后半段原样');
  // 文案/字幕/旁白两段各保留一份；后半段为深拷贝（改它不影响前半段）
  assert.equal(second.text.title, '标题');
  assert.deepEqual(second.captions, [{text: '字幕1', startSec: 0, endSec: 2}]);
  assert.equal(second.narration?.text, '旁白');
  second.captions![0].text = '改';
  assert.equal(S().segments[0].captions![0].text, '字幕1', '后半段字幕是独立副本');
  // 活动段（原下标 1）在被拆段之后 → 下标 +1 且仍指向同一片段，工作副本不跑偏
  assert.equal(S().activeSegmentIndex, 2, '活动下标顺延 +1');
  assert.equal(S().segments[2].id, activeId, '活动段内容不变');
  assert.equal(S().templateId, S().segments[2].templateId, '工作副本仍对应活动段');
  ok('拆非活动段：trim/时长/新段位置/活动下标跟随');
}
{
  // 拆活动段：活动下标不变（指向前半段），工作副本视频同步前半段裁剪
  setupSplitFixture();
  useProjectStore.setState((s) => ({
    activeSegmentIndex: 0,
    templateId: s.segments[0].templateId,
    videos: deepClone(s.segments[0].videos) as never,
    text: deepClone(s.segments[0].text) as never,
  }));
  const okSplit = S().splitSegment(0, 8);
  assert.equal(okSplit, true);
  assert.equal(S().activeSegmentIndex, 0, '活动下标保持指向前半段');
  assert.equal(S().videos[0].trimEnd, 13, '工作副本视频同步前半段 trimEnd');
  assert.equal(S().videos[0].trimmedDuration, 8);
  assert.equal(S().segments[1].videos[0].trimStart, 13, '后半段从拆点起播');
  ok('拆活动段：工作副本跟随前半段');
}
{
  // 一步撤销：单次 set → 单条历史快照，undo 一次完整还原
  setupSplitFixture();
  const before = takeSnapshot(S());
  S().splitSegment(0, 8);
  S().pushHistory(before);
  assert.equal(S().segments.length, 3);
  S().undo();
  assert.equal(S().segments.length, 2, 'undo 一步还原段数');
  assert.equal(S().segments[0].duration, 20, 'undo 还原时长');
  assert.equal(S().segments[0].videos[0].trimEnd, 25, 'undo 还原裁剪区间');
  assert.equal(S().activeSegmentIndex, 1, 'undo 后活动下标钳回快照范围内（与既有 undo 语义一致）');
  ok('拆段可一步撤销');
}
{
  // 非法拆点/越界：返回 false 且故事板不变
  setupSplitFixture();
  assert.equal(S().splitSegment(0, 0.2), false, '拆点 <0.5 拒绝');
  assert.equal(S().splitSegment(0, 19.8), false, '后半不足 0.5s 拒绝');
  assert.equal(S().splitSegment(0, NaN), false, 'NaN 拒绝');
  assert.equal(S().splitSegment(9, 8), false, '下标越界拒绝');
  assert.equal(S().segments.length, 2, '非法拆点不变更故事板');
  assert.equal(S().segments[0].duration, 20);
  ok('非法拆点返回 false 且不变更');
}

// ===== 8. removeVideoFromSegment =====
console.log('removeVideoFromSegment:');
// 两段各带两个素材，活动段在下标 0
const setupRemoveFixture = () => {
  reset();
  S().addSegment('StackCards'); // 造出第 2 段（默认 1 段，addSegment 后共 2 段）
  useProjectStore.setState((s) => {
    const mk = (i: number) => [
      {id: `s${i}-v1`, src: `http://x/${i}a.mp4`, name: `${i}a.mp4`, type: 'video' as const,
        width: 1920, height: 1080, duration: 10, trimStart: 0, trimEnd: 10, trimmedDuration: 10},
      {id: `s${i}-v2`, src: `http://x/${i}b.png`, name: `${i}b.png`, type: 'image' as const,
        width: 800, height: 600, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5},
    ];
    return {
      segments: s.segments.map((seg, i) => ({...seg, videos: mk(i)})),
      activeSegmentIndex: 0,
      // 工作副本与活动段（下标 0）的素材保持同步（生产环境由 loadSegmentToCurrent 维护）
      videos: mk(0),
    };
  });
};
{
  // 移除活动段（下标 0）的素材 0：segments 与工作副本同步删除
  setupRemoveFixture();
  S().removeVideoFromSegment(0, 0);
  assert.equal(S().segments[0].videos.length, 1);
  assert.equal(S().segments[0].videos[0].id, 's0-v2', '剩余素材保持原顺序');
  assert.equal(S().videos.length, 1, '活动段工作副本同步移除');
  assert.equal(S().videos[0].id, 's0-v2');
  ok('移除活动段素材：segments 与工作副本同步');
}
{
  // 移除非活动段素材：工作副本不受影响
  setupRemoveFixture();
  S().setActiveSegmentIndex(1);
  S().loadSegmentToCurrent(1); // 与 UI 切段同口径：切换后工作副本重载为目标段
  S().removeVideoFromSegment(0, 1);
  assert.equal(S().segments[0].videos.length, 1);
  assert.equal(S().segments[0].videos[0].id, 's0-v1');
  assert.equal(S().videos[0].id, 's1-v1', '非活动段操作不动工作副本');
  ok('移除非活动段素材：工作副本不受影响');
}
{
  // 越界（段/素材不存在）为无操作，不抛错
  setupRemoveFixture();
  S().removeVideoFromSegment(5, 0);
  S().removeVideoFromSegment(0, 9);
  assert.equal(S().segments[0].videos.length, 2);
  ok('越界下标安全无操作');
}

// ===== 9. 裁剪 + 挖段（updateSegmentVideoTrim 的 cuts 参数）=====
console.log('updateSegmentVideoTrim 挖段:');
const setupCutFixture = () => {
  reset();
  useProjectStore.setState((s) => ({
    segments: s.segments.map((seg, i) =>
      i === 0
        ? {
            ...seg,
            duration: 12,
            videos: [
              {id: 'c1', src: 'http://x/a.mp4', name: 'a.mp4', type: 'video' as const,
                width: 1920, height: 1080, duration: 30,
                trimStart: 2, trimEnd: 14, trimmedDuration: 12,
                cuts: [{start: 5, end: 8}]},
            ],
          }
        : seg,
    ),
    videos: [
      {id: 'c1', src: 'http://x/a.mp4', name: 'a.mp4', type: 'video' as const,
        width: 1920, height: 1080, duration: 30,
        trimStart: 2, trimEnd: 14, trimmedDuration: 12,
        cuts: [{start: 5, end: 8}]},
    ],
  }));
};
{
  // 只改 trim 不传 cuts：现有挖段保留并按新区间钳制，有效时长重算
  setupCutFixture();
  S().updateSegmentVideoTrim(0, 0, 0, 6);
  const clip = S().segments[0].videos[0];
  assert.equal(clip.trimStart, 0);
  assert.equal(clip.trimEnd, 6);
  assert.deepEqual(clip.cuts, [{start: 5, end: 6}], '挖段钳到新 trimEnd');
  assert.equal(clip.trimmedDuration, 5, '有效时长 = 6 − 1（钳后挖段）');
  assert.equal(S().videos[0].trimmedDuration, 5, '工作副本同步');
  ok('缩选区时挖段被钳制、有效时长重算');
}
{
  // 传 cuts 整体替换：[] 清空
  setupCutFixture();
  S().updateSegmentVideoTrim(0, 0, 2, 14, []);
  const clip = S().segments[0].videos[0];
  assert.equal(clip.cuts, undefined);
  assert.equal(clip.trimmedDuration, 12);
  ok('空数组清空全部挖段');
}
{
  // 传新挖段替换旧挖段（越界部分被钳）
  setupCutFixture();
  S().updateSegmentVideoTrim(0, 0, 2, 14, [{start: 4, end: 6}, {start: 9, end: 20}]);
  const clip = S().segments[0].videos[0];
  assert.deepEqual(clip.cuts, [{start: 4, end: 6}, {start: 9, end: 14}]);
  assert.equal(clip.trimmedDuration, 5, '有效 = 12 − 2 − 5');
  ok('新挖段整体替换并钳制');
}

// ===== 10. splitSegment 挖段分配 =====
console.log('splitSegment 挖段分配:');
{
  // 段 0：trim 2-14（12s），挖段 [5,8]（3s）→ 有效 9s。
  // 时间轴 atSec=4：洞前可播 3s（媒体 2-5），4s = 洞出口后 1s → 媒体拆点 9
  setupCutFixture();
  const okSplit = S().splitSegment(0, 4);
  assert.equal(okSplit, true);
  const [first, second] = S().segments;
  const f = first.videos[0];
  const s = second.videos[0];
  assert.equal(f.trimEnd, 9, '前半 trimEnd = 媒体拆点 9');
  assert.deepEqual(f.cuts, [{start: 5, end: 8}], '挖段整体归前半');
  assert.equal(f.trimmedDuration, 4, '前半有效时长 = atSec');
  assert.equal(s.trimStart, 9);
  assert.equal(s.trimEnd, 14);
  assert.equal(s.cuts, undefined);
  assert.equal(s.trimmedDuration, 5, '后半有效 5 + 前半 4 = 总有效 9');
  ok('拆点落在挖段内时按洞出口划分');
}
{
  // 拆点在挖段之前：挖段整体归后半
  setupCutFixture();
  S().splitSegment(0, 2); // 媒体拆点 4（< 挖段 5）
  const [first, second] = S().segments;
  assert.equal(first.videos[0].cuts, undefined);
  assert.deepEqual(second.videos[0].cuts, [{start: 5, end: 8}]);
  assert.equal(second.videos[0].trimmedDuration, 7, '14−4 −3 挖段');
  ok('拆点在挖段前：挖段整体归后半');
}
{
  // 回归：无挖段拆分与旧语义一致（trimStart + atSec 线性拆点）
  setupCutFixture();
  S().updateSegmentVideoTrim(0, 0, 2, 14, []);
  S().splitSegment(0, 8);
  const [first, second] = S().segments;
  assert.equal(first.videos[0].trimEnd, 10, '旧语义：trimStart+atSec = 2+8');
  assert.equal(second.videos[0].trimStart, 10);
  ok('无挖段拆分保持旧语义（回归）');
}

// ===== 11. 「屏幕录制」模板（原样导出）联动 =====
console.log('屏幕录制模板:');
{
  const {TEMPLATES, isRawOutputTemplate} = await import('../../src/shared/template-registry.ts');
  const meta = TEMPLATES.find((t) => t.id === 'ScreenRecord');
  assert.ok(meta, 'ScreenRecord 已注册');
  assert.equal(meta?.name, '屏幕录制');
  assert.equal(meta?.minVideos, 1);
  assert.equal(meta?.maxVideos, 1);
  assert.equal(isRawOutputTemplate('ScreenRecord'), true);
  assert.equal(isRawOutputTemplate('VideoCut'), false);
  assert.equal(isRawOutputTemplate(undefined), false);
  ok('注册表条目与原样输出标记正确');
}
{
  // 素材入段：段时长自动对齐素材可用时长（0.1s 取整，最低 0.5s）
  reset();
  useProjectStore.setState((s) => ({segments: s.segments.map((seg) => ({...seg, templateId: 'ScreenRecord'}))}));
  S().addVideosToSegment(0, [
    {id: 'rec1', src: 'http://x/rec.webm', name: 'rec.webm', type: 'video' as const,
      width: 3380, height: 1080, duration: 45, trimStart: 2, trimEnd: 43.7, trimmedDuration: 41.7},
  ]);
  assert.equal(S().segments[0].duration, 41.7, '段时长 = 素材可用时长');
  ok('ScreenRecord 段加素材自动对齐时长');
}
{
  // 非本模板不加对齐逻辑；一次加两段素材也不对齐（模板只支持 1 段，多余交给用户处理）
  reset();
  const before = S().segments[0].duration;
  S().addVideosToSegment(0, [
    {id: 'v1', src: 'http://x/1.mp4', name: '1.mp4', type: 'video' as const,
      width: 1920, height: 1080, duration: 30, trimStart: 0, trimEnd: 30, trimmedDuration: 30},
  ]);
  assert.equal(S().segments[0].duration, before, '普通模板段时长不动');
  reset();
  useProjectStore.setState((s) => ({segments: s.segments.map((seg) => ({...seg, templateId: 'ScreenRecord'}))}));
  S().addVideosToSegment(0, [
    {id: 'v1', src: 'http://x/1.mp4', name: '1.mp4', type: 'video' as const,
      width: 1920, height: 1080, duration: 30, trimStart: 0, trimEnd: 30, trimmedDuration: 30},
    {id: 'v2', src: 'http://x/2.mp4', name: '2.mp4', type: 'video' as const,
      width: 1920, height: 1080, duration: 12, trimStart: 0, trimEnd: 12, trimmedDuration: 12},
  ]);
  assert.notEqual(S().segments[0].duration, 30, '多素材不触发对齐');
  ok('对齐仅限 ScreenRecord 单视频入段');
}

// ===== 12. setVideoStabilization（跟踪稳定写入/保留/移除）=====
console.log('setVideoStabilization:');
{
  reset();
  S().addVideosToSegment(0, [
    {id: 'sv1', src: 'http://x/shaky.mp4', name: 'shaky.mp4', type: 'video' as const,
      width: 1920, height: 1080, duration: 10, trimStart: 0, trimEnd: 10, trimmedDuration: 10},
  ]);
  const stab = {trackPath: 'D:/m/shaky.stab.json', points: [{x: 100, y: 200}], smoothSec: 0.8, enabled: true, lostRatio: 0.05};
  const corrections = [{t: 0, cx: 1, cy: 2, crot: 0, cscale: 1}];
  S().setVideoStabilization(0, {stabilization: stab, stabCorrections: corrections, stabZoom: 1.12, stabSampleFps: 15});
  {
    const v = S().segments[0].videos[0];
    assert.deepEqual(v.stabilization, stab);
    assert.equal(v.stabCorrections, corrections, '内存态校正表写入 segments');
    assert.equal(v.stabZoom, 1.12);
    assert.equal(v.stabSampleFps, 15);
    // 活动段工作副本同步
    assert.deepEqual(S().videos[0].stabilization, stab, '活动段工作副本同步写入');
  }
  ok('写入：持久化 + 内存态三字段，segments 与工作副本同步');
}
{
  // 内存态省略 = 保留旧值（AI 开关稳定不清数据：关→开回来不用重算）
  const before = S().segments[0].videos[0];
  assert.ok(before.stabilization && before.stabCorrections);
  S().setVideoStabilization(0, {stabilization: {...before.stabilization!, enabled: false}});
  const v = S().segments[0].videos[0];
  assert.equal(v.stabilization?.enabled, false);
  assert.equal(v.stabCorrections, before.stabCorrections, '内存态省略时保留');
  assert.equal(v.stabZoom, before.stabZoom);
  ok('开关切换：内存态省略 = 保留（不清数据）');
}
{
  // 移除：持久化与内存态全剥离，其余字段不动
  S().setVideoStabilization(0, {stabilization: undefined});
  const v = S().segments[0].videos[0];
  assert.equal(v.stabilization, undefined);
  assert.equal(v.stabCorrections, undefined);
  assert.equal(v.stabZoom, undefined);
  assert.equal(v.stabSampleFps, undefined);
  assert.equal(v.name, 'shaky.mp4', '素材其余字段保留');
  assert.equal(S().videos[0].stabilization, undefined, '工作副本同步剥离');
  ok('移除：持久化 + 内存态全剥离');
}
{
  // 非活动段：segments 更新但工作副本不动
  reset();
  S().addVideosToSegment(0, [
    {id: 'a1', src: 'http://x/a.mp4', name: 'a.mp4', type: 'video' as const,
      width: 1920, height: 1080, duration: 8, trimStart: 0, trimEnd: 8, trimmedDuration: 8},
  ]);
  const second = createEmptySegment();
  useProjectStore.setState((s) => ({segments: [...s.segments, second]}));
  S().addVideosToSegment(1, [
    {id: 'b1', src: 'http://x/b.mp4', name: 'b.mp4', type: 'video' as const,
      width: 1280, height: 720, duration: 6, trimStart: 0, trimEnd: 6, trimmedDuration: 6},
  ]);
  const stab = {trackPath: 'D:/m/b.stab.json', points: [{x: 10, y: 20}], smoothSec: 1.2, enabled: true};
  S().setVideoStabilization(0, {stabilization: stab, stabCorrections: [{t: 0, cx: 0, cy: 0, crot: 0, cscale: 1}]}, 1);
  assert.deepEqual(S().segments[1].videos[0].stabilization, stab);
  assert.equal(S().videos[0].stabilization, undefined, '非活动段不动工作副本');
  ok('非活动段：只更新 segments，工作副本不动');
}

// ===== 13. EditPlan stale 失效 =====
console.log('EditPlan stale 失效:');
const seedPlan = () => S().setEditPlan({version: 1, assignments: [], notes: [], beats: [], scenes: [], shots: []});
const assertStaleAfter = (label: string, action: () => void) => {
  reset();
  seedPlan();
  action();
  assert.equal(S().editPlan?.stale, true, `${label} 应标记 EditPlan 过期`);
  assert.ok(S().editPlan?.staleReason, `${label} 应记录过期原因`);
};
assertStaleAfter('片段时长修改', () => S().setCurrentDuration(5));
assertStaleAfter('转场修改', () => S().setCurrentTransition('fade'));
assertStaleAfter('新增片段', () => S().addSegment('StackCards'));
assertStaleAfter('复制片段', () => S().duplicateSegment(0));
assertStaleAfter('移动片段', () => {
  S().addSegment('StackCards');
  S().reorderSegments(0, 1);
});
assertStaleAfter('新增素材', () => S().addVideosToSegment(0, [{id: 'stale-v', src: 'http://x/a.mp4', name: 'a.mp4', type: 'video', width: 1920, height: 1080, duration: 5, trimStart: 0, trimEnd: 5, trimmedDuration: 5}]));
ok('时间线与素材编辑统一标记 EditPlan stale');

console.log(`\n全部通过（${passed} 组断言）`);
