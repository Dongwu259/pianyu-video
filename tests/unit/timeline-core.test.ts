/**
 * timeline-core 单测（M1.5 切片一「包」阶段）
 *
 * 锚定：
 * - 分发正确性：每类命令打到正确的 store 动作+参数（纯转发，参数不改写）；
 * - 事务语义：一命令=一事务=一 before 快照入史（带来源标+操作名）；显式失败/幂等无变化
 *   = 无痕不入史；纪元只在入史时自增；
 * - 撤销链：连续 N 命令 → N 条事务 → 按序弹栈逐步恢复到 origin（「连续 AI 操作 Ctrl+Z
 *   逐步可撤」的 headless 版验收）；
 * - 来源标优先级：显式 opts > peekAgentOp（不消费）> user+命令人话名。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs --test tests/unit/timeline-core.test.ts
 */
import assert from 'node:assert/strict';
import {applyTimelineCommand, executeTimelineCommand, COMMAND_LABELS, shouldCoalesce, COALESCE_WINDOW_MS, type TimelineCommand, type CommandTransactionDeps, type TimelineCommandStore} from '../../src/renderer/store/timeline-core.ts';
import {snapshotsEqual, type HistorySnapshot, type HistorySource} from '../../src/renderer/store/historyUtils.ts';
import {markAgentOp, peekAgentOp, dropAgentOp, runWithHistorySuppressed, isHistoryScopeActive, bumpCommandEpoch, commandEpochAt, beginSuppressedScope} from '../../src/renderer/store/historyUtils.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== 分发正确性：命令 → store 动作（spy mock，纯转发不改写参数） ======
{
  const calls: Array<[string, unknown[]]> = [];
  const spy = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    return true;
  };
  const store = {
    writeSegmentTiming: spy('writeSegmentTiming'),
    updateSegmentVideoTrim: spy('updateSegmentVideoTrim'),
    updateSegmentVideoAudio: spy('updateSegmentVideoAudio'),
    updateSegmentNarration: spy('updateSegmentNarration'),
    setSegmentCaptions: spy('setSegmentCaptions'),
    applyAiSegmentPatch: spy('applyAiSegmentPatch'),
    applySegmentOrder: spy('applySegmentOrder'),
    reorderSegments: spy('reorderSegments'),
    splitSegment: spy('splitSegment'),
    moveVideoAcrossSegments: spy('moveVideoAcrossSegments'),
    updateBgm: spy('updateBgm'),
    addSfxClip: spy('addSfxClip'),
    updateSfxClip: spy('updateSfxClip'),
    removeSfxClip: spy('removeSfxClip'),
    syncCurrentToSegment: spy('syncCurrentToSegment'),
    applySegmentPlanText: spy('applySegmentPlanText'),
    applySegmentPlanFreeze: spy('applySegmentPlanFreeze'),
    writeSegmentCaptionWindows: spy('writeSegmentCaptionWindows'),
    applySegmentPlanMediaWindow: spy('applySegmentPlanMediaWindow'),
    setSegmentBeats: spy('setSegmentBeats'),
    writeSegmentBeats: spy('writeSegmentBeats'),
  } as unknown as TimelineCommandStore;
  const cmds: TimelineCommand[] = [
    {kind: 'segmentTiming', index: 2, patch: {duration: 5.5, transition: 'whip'}},
    {kind: 'segmentVideoTrim', index: 1, videoIndex: 0, trimStart: 2, trimEnd: 8, cuts: []},
    {kind: 'segmentVideoAudio', index: 0, videoIndex: 1, muted: true},
    {kind: 'segmentNarration', index: 3, patch: {offsetSec: 1.2}},
    {kind: 'segmentCaptions', index: 0, captions: [{text: '你好', startSec: 0, endSec: 2}]},
    // AI 段补丁整包（HANDOVER 122 移植根治：update_segment 收进命令层）
    {kind: 'segmentUpdate', index: 1, patch: {templateId: 'KineticType', duration: 5, transition: undefined, videoEffect: undefined, backgroundEffect: undefined, textAnim: undefined, exitStyle: undefined, narration: undefined, captions: undefined, text: {title: '新标题'}, customParams: undefined, transitionParams: undefined, cursorScript: undefined, muted: undefined, volume: undefined}},
    {kind: 'reorderSegments', order: [2, 0, 1]},
    {kind: 'moveSegment', index: 0, to: 2},
    {kind: 'splitSegment', index: 0, atSec: 3},
    {kind: 'moveShot', fromSegment: 0, clipIndex: 1, toSegment: 2, position: 0},
    {kind: 'bgm', patch: {volume: 0.6}},
    {kind: 'sfxClipAdd', sfxKind: 'whoosh', atSec: 4.5},
    {kind: 'sfxClipUpdate', id: 'sfx-1', patch: {volume: 0.9}},
    {kind: 'sfxClipRemove', id: 'sfx-1'},
    // M2 回写环三命令（反解在薄动作内；false = 反解失败无痕）
    {kind: 'planCaptionText', index: 1, captionIndex: 0, text: '新标题'},
    {kind: 'planCaptionWindow', index: 1, captionIndex: 0, startSec: 1.2, endSec: 8},
    {kind: 'planMediaWindow', index: 0, videoIndex: 0, mediaInSec: 1, mediaOutSec: 9},
    // M3 L2 节拍层（v1.4）：手放节拍标记整组设置/清除
    {kind: 'segmentBeats', index: 0, beats: [{t: 1.2, kind: 'accent'}]},
  ];
  for (const c of cmds) assert.equal(applyTimelineCommand(store, c), true, `${c.kind} 分发成功`);
  const names = calls.map((c) => c[0]);
  // reorder/moveSegment/moveShot 分发内含前置 sync（sync+load 退役处方）→ 名单里各多一次
  assert.deepEqual(
    names,
    ['writeSegmentTiming', 'updateSegmentVideoTrim', 'updateSegmentVideoAudio', 'updateSegmentNarration', 'setSegmentCaptions', 'applyAiSegmentPatch', 'syncCurrentToSegment', 'applySegmentOrder', 'syncCurrentToSegment', 'reorderSegments', 'splitSegment', 'syncCurrentToSegment', 'moveVideoAcrossSegments', 'updateBgm', 'addSfxClip', 'updateSfxClip', 'removeSfxClip', 'applySegmentPlanText', 'applySegmentPlanFreeze', 'applySegmentPlanMediaWindow', 'setSegmentBeats'],
    '18 类命令各达其动作（reorder/moveSegment/moveShot 先 sync）',
  );
  assert.deepEqual(calls[0][1], [2, {duration: 5.5, transition: 'whip'}], '参数原样转发');
  assert.deepEqual(calls[10][1], [0, 3], 'split 参数');
  assert.deepEqual(calls[12][1], [0, 1, 2, 0], 'moveShot 参数');
  assert.deepEqual(calls[4][1], [0, [{text: '你好', startSec: 0, endSec: 2}]], 'captions 参数');
  assert.equal(calls[5][0], 'applyAiSegmentPatch', 'segmentUpdate → applyAiSegmentPatch');
  assert.equal(calls[5][1][0], 1, 'segmentUpdate index 转发');
  assert.equal((calls[5][1][1] as {text?: {title?: string}}).text?.title, '新标题', 'segmentUpdate patch 整包转发');
  assert.deepEqual(calls[17][1], [1, 0, '新标题'], 'planCaptionText 参数');
  assert.deepEqual(calls[18][1], [1, 0, 1.2, 8], 'planCaptionWindow 参数');
  assert.deepEqual(calls[19][1], [0, 0, 1, 9], 'planMediaWindow 参数');
  assert.deepEqual(calls[20][1], [0, [{t: 1.2, kind: 'accent'}]], 'segmentBeats 参数');
  ok('18 类命令分发表一一对应（纯转发；segmentUpdate=AI 段补丁整包，HANDOVER 122 根治）');
}
{
  // 前置同步收进命令（sync+load 退役）：reorder/moveShot 命令先 sync 再写；其余命令不 sync
  const calls: string[] = [];
  const mk = (): TimelineCommandStore =>
    ({
      updateSegmentDirect: () => {},
      updateSegmentVideoTrim: () => {},
      updateSegmentVideoAudio: () => {},
      updateSegmentNarration: () => {},
      applySegmentOrder: () => calls.push('reorder'),
      splitSegment: () => true,
      moveVideoAcrossSegments: () => {
        calls.push('move');
        return true;
      },
      updateBgm: () => {},
      addSfxClip: () => 'id',
      updateSfxClip: () => {},
      removeSfxClip: () => {},
      syncCurrentToSegment: () => calls.push('sync'),
    }) as unknown as TimelineCommandStore;
  const s1 = mk();
  applyTimelineCommand(s1, {kind: 'reorderSegments', order: [1, 0]});
  assert.deepEqual(calls, ['sync', 'reorder'], 'reorder：先 sync 再重排');
  const s2 = mk();
  applyTimelineCommand(s2, {kind: 'moveShot', fromSegment: 0, clipIndex: 0, toSegment: 1});
  assert.deepEqual(calls, ['sync', 'reorder', 'sync', 'move'], 'moveShot：先 sync 再搬');
  const s3 = mk();
  calls.length = 0;
  applyTimelineCommand(s3, {kind: 'bgm', patch: {}});
  assert.deepEqual(calls, [], 'bgm 命令不 sync（无工作副本语义）');
  ok('前置同步收进命令层（reorder/moveShot 自含 sync）');
}

// ====== 事务编排：入史/无痕/纪元/来源标（依赖注入的 headless 假 store） ======
{
  // 迷你状态机：counter 即「内容」；apply 改 counter；snapshot 读 counter
  let counter = 0;
  let applyResult: boolean | undefined;
  const pushed: HistorySnapshot[] = [];
  let epoch = 0;
  const deps: CommandTransactionDeps = {
    snapshot: () => ({counter} as unknown as HistorySnapshot),
    snapshotsEqual: snapshotsEqual,
    applyInScope: (cmd) => {
      if (applyResult === false) return false;
      counter += 1;
      return true;
    },
    pushHistory: (snap) => pushed.push(snap),
    label: () => labelProvider(),
    bumpEpoch: () => {
      epoch++;
    },
  };
  let labelProvider: () => {source: HistorySource; opName?: string} = () => ({source: 'user', opName: '测试'});

  // ① 正常命令：before 快照（counter 改前值）+ 标注入史 + 纪元 +1
  counter = 10;
  applyResult = undefined;
  assert.equal(executeTimelineCommand(deps, {kind: 'bgm', patch: {}}), true, '执行成功');
  assert.equal(pushed.length, 1, '入史一条');
  assert.equal((pushed[0] as any).counter, 10, '入史的是 before 快照');
  assert.equal(pushed[0].source, 'user', '来源标随事务');
  assert.equal(pushed[0].opName, '测试', '操作名随事务');
  assert.equal(epoch, 1, '纪元自增');
  assert.equal(counter, 11, '命令已应用');

  // ② 显式失败：无痕
  applyResult = false;
  assert.equal(executeTimelineCommand(deps, {kind: 'splitSegment', index: 0, atSec: 1}), false);
  assert.equal(pushed.length, 1, '失败不入史');
  assert.equal(epoch, 1, '失败不动纪元');

  // ③ 幂等无变化（apply 成功但内容没变）：无痕
  applyResult = undefined;
  const before = counter;
  const depsNoop: CommandTransactionDeps = {...deps, applyInScope: () => true, snapshot: () => ({counter: before}) as unknown as HistorySnapshot};
  assert.equal(executeTimelineCommand(depsNoop, {kind: 'bgm', patch: {}}), false, '无变化 false');
  assert.equal(pushed.length, 1, '无变化不入史');
  ok('事务三态：入史/显式失败无痕/幂等无变化无痕');
}

// ====== 来源标优先级 + peekAgentOp 不消费 ======
{
  dropAgentOp();
  markAgentOp('reorder_segments');
  assert.ok(peekAgentOp(), 'peek 可见');
  assert.ok(peekAgentOp(), 'peek 不消费（仍可见）');
  assert.ok(peekAgentOp()!.opName === 'reorder_segments', '操作名保留');
  dropAgentOp();
  assert.equal(peekAgentOp(), null, '丢弃后无');
  ok('peekAgentOp 窥视不消费（标记留给采集器兜底）');
}
{
  // COMMAND_LABELS 全覆盖（新命令类型忘配人话名 = 这里红）
  const kinds: TimelineCommand['kind'][] = ['segmentTiming', 'segmentVideoTrim', 'segmentVideoAudio', 'segmentNarration', 'reorderSegments', 'splitSegment', 'moveShot', 'bgm', 'sfxClipAdd', 'sfxClipUpdate', 'sfxClipRemove'];
  for (const k of kinds) assert.ok(COMMAND_LABELS[k], `${k} 有人话名`);
  ok('COMMAND_LABELS 全覆盖');
}
{
  // 合并事务判定（切片三）：同键窗内 true；无键/无栈顶/异键/超窗 false
  const now = 1_000_000;
  assert.equal(shouldCoalesce(undefined, 'k', now), false, '无栈顶 false');
  assert.equal(shouldCoalesce({coalesceKey: 'k', coalesceAt: now - 500}, undefined, now), false, '无键 false');
  assert.equal(shouldCoalesce({coalesceKey: 'k', coalesceAt: now - 500}, 'k', now), true, '同键窗内 true');
  assert.equal(shouldCoalesce({coalesceKey: 'k', coalesceAt: now - 500}, 'other', now), false, '异键 false');
  assert.equal(shouldCoalesce({coalesceKey: 'k', coalesceAt: now - COALESCE_WINDOW_MS - 1}, 'k', now), false, '超窗 false');
  assert.equal(shouldCoalesce({coalesceKey: 'k', coalesceAt: now - COALESCE_WINDOW_MS + 100}, 'k', now), true, '窗沿内 true');
  assert.equal(shouldCoalesce({}, 'k', now), false, '栈顶无合并键 false（普通事务条目不分流）');
  ok('shouldCoalesce 四态 + 窗沿（合并事务判定）');
}

// ====== 作用域豁免 + 命令纪元（historyUtils 直测） ======
{
  assert.equal(isHistoryScopeActive(), false, '外部无作用域');
  const r = runWithHistorySuppressed(() => {
    assert.equal(isHistoryScopeActive(), true, '作用域内');
    // 嵌套安全
    return runWithHistorySuppressed(() => 42);
  });
  assert.equal(r, 42, '嵌套返回值穿透');
  assert.equal(isHistoryScopeActive(), false, '退出后恢复');
  const e0 = commandEpochAt();
  bumpCommandEpoch();
  assert.equal(commandEpochAt(), e0 + 1, '纪元单调');
  ok('作用域豁免（可嵌套）+ 命令纪元单调');
}
{
  // 拖拽括号 beginSuppressedScope：悬挂自愈（新括号收旧括号）+ 重复收口幂等 + 深度不为负
  assert.equal(isHistoryScopeActive(), false, '前置：无作用域');
  const fin1 = beginSuppressedScope();
  assert.equal(isHistoryScopeActive(), true, '括号内抑制');
  const fin2 = beginSuppressedScope(); // 新拖拽开始 → 旧括号被自愈收口（悬挂泄漏兜底）
  assert.equal(isHistoryScopeActive(), true, '新括号仍抑制');
  fin1(); // 旧收口重复调 → 幂等无害
  assert.equal(isHistoryScopeActive(), true, '重复收口不减深度');
  fin2();
  assert.equal(isHistoryScopeActive(), false, '收口后恢复');
  fin2(); // 再重复 → 仍幂等
  assert.equal(isHistoryScopeActive(), false, '深度不为负');
  ok('拖拽括号：悬挂自愈 + 重复收口幂等');
}

// ====== 撤销链：连续 3 命令逐步可撤（headless 版 M1.5 验收） ======
{
  // 假世界：state = {n}；三条命令各 +1；事务栈按真实 undo 语义弹栈恢复
  let n = 0;
  const past: HistorySnapshot[] = [];
  const applyN = () => {
    n += 1;
    return true;
  };
  const mkDeps = (): CommandTransactionDeps => ({
    snapshot: () => ({n}) as unknown as HistorySnapshot,
    snapshotsEqual,
    applyInScope: () => applyN(),
    pushHistory: (snap) => past.push(snap),
    label: () => ({source: 'agent', opName: 'reorder_segments'}),
    bumpEpoch: () => {},
  });
  const d = mkDeps();
  executeTimelineCommand(d, {kind: 'bgm', patch: {}});
  executeTimelineCommand(d, {kind: 'reorderSegments', order: [1, 0]});
  executeTimelineCommand(d, {kind: 'splitSegment', index: 0, atSec: 1});
  assert.equal(n, 3, '三命令全部应用');
  assert.equal(past.length, 3, '三条事务');
  assert.ok(past.every((p) => p.source === 'agent' && p.opName === 'reorder_segments'), '每条带 agent 标');
  // undo ×3（真实 undo = 恢复栈顶 before）
  for (let i = 0; i < 3; i++) {
    const snap = past.pop()!;
    n = (snap as any).n;
  }
  assert.equal(n, 0, '逐步撤回到 origin');
  ok('连续 3 命令 = 3 条事务，Ctrl+Z×3 逐步可撤');
}

console.log(`timeline-core: ${passed} 组全 PASS`);
