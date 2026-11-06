/**
 * 工程核命令层（timeline-master-plan M1.5 切片一——「包」阶段）
 *
 * 定位（总纲 §三）：时间线写动作的唯一命令入口。user / agent / materialize 三源同构
 * 发命令；一条命令 = 一条事务 = 一步撤销（before 快照 + 来源标 + 操作名即时入史），
 * 替代该域内「500ms 防抖合并」的快照语义（快照机制保留为未覆盖域的兜底）。
 *
 * 纪律（红线）：
 * - **先包后拆**：命令分发表只转发既有 store 动作（零写逻辑复制）；state 结构不动。
 *   后续切片在此稳定缝上做 state 分片/物化层，UI 调用方零感知。
 * - **幂等无痕**：命令未引起内容变化（越界/同值）不入史——历史栈不被空事务污染。
 * - **HEADLESS**：本模块不依赖 zustand/React/Electron（依赖注入），可在 Node 单测直跑；
 *   projectStore.runTimelineCommand 是唯一绑定层。
 * - 覆盖域内的 sync+load 语义由底层动作的工作副本双写保持（moveVideoAcrossSegments/
 *   updateSegmentVideoAudio 等），命令层不再额外配对——铁律在未覆盖域继续有效。
 */

import type {ClipCut} from '../../shared/clipCuts';
import type {ValidatedSegmentPatch} from '../../shared/llm-tools';
import type {
  BgmTrack,
  CaptionLine,
  SegmentBeat,
  SegmentNarration,
  SfxClip,
  SfxKind,
  TransitionParams,
  TransitionType,
} from '../../shared/types';
import type {HistorySnapshot, HistorySource} from './historyUtils';

// ====== 命令族（时间线写动作全集：split/reorder/trim/BGM/旁白/音效；枚举只增不改） ======

export type TimelineCommand =
  | {kind: 'segmentTiming'; index: number; patch: {duration?: number; transition?: TransitionType; transitionParams?: Partial<TransitionParams>; transitionSfx?: SfxKind | 'off' | null}}
  | {kind: 'segmentVideoTrim'; index: number; videoIndex: number; trimStart: number; trimEnd: number; cuts?: ClipCut[]}
  | {kind: 'segmentVideoAudio'; index: number; videoIndex: number; muted: boolean}
  | {kind: 'segmentNarration'; index: number; patch: Partial<SegmentNarration>}
  | {kind: 'segmentCaptions'; index: number; captions: CaptionLine[] | undefined}
  // AI 段补丁整包事务（HANDOVER 122 移植根治：update_segment 此前直写动作，历史走
  // 500ms 防抖采集器且 agent 标在工具 finally 被 drop——程序化调用时后台无标改动抢栈顶、
  // undo 弹陈旧条目；收进命令层 = before 快照+来源标即时入史，一步撤销语义精确）
  | {kind: 'segmentUpdate'; index: number; patch: ValidatedSegmentPatch}
  | {kind: 'reorderSegments'; order: number[]}
  | {kind: 'moveSegment'; index: number; to: number}
  | {kind: 'splitSegment'; index: number; atSec: number}
  | {kind: 'moveShot'; fromSegment: number; clipIndex: number; toSegment: number; position?: number}
  | {kind: 'bgm'; patch: Partial<BgmTrack>}
  | {kind: 'sfxClipAdd'; sfxKind: SfxKind; atSec: number}
  | {kind: 'sfxClipUpdate'; id: string; patch: Partial<Pick<SfxClip, 'kind' | 'atSec' | 'volume'>>}
  | {kind: 'sfxClipRemove'; id: string}
  // M2 回写环（plan 原语编辑 → 反解/冻结；slover 见 shared/plan-writeback）
  | {kind: 'planCaptionText'; index: number; captionIndex: number; text: string}
  | {kind: 'planCaptionWindow'; index: number; captionIndex: number; startSec: number; endSec: number}
  | {kind: 'planMediaWindow'; index: number; videoIndex: number; mediaInSec: number; mediaOutSec: number}
  // M3 L2 节拍层（v1.4）：手放节拍标记整组设置/清除（undefined = 清除）
  | {kind: 'segmentBeats'; index: number; beats: SegmentBeat[] | undefined};

/** 命令人话名（历史条目 opName 兜底与未来历史面板显示用） */
export const COMMAND_LABELS: Record<TimelineCommand['kind'], string> = {
  segmentTiming: '改片段时长/转场',
  segmentVideoTrim: '裁剪素材窗',
  segmentVideoAudio: '素材静音',
  segmentNarration: '旁白时序',
  segmentCaptions: '字幕行',
  segmentUpdate: '改片段内容',
  reorderSegments: '重排片段',
  moveSegment: '移动片段',
  splitSegment: '拆分片段',
  moveShot: '搬移 shot',
  bgm: 'BGM 定位',
  sfxClipAdd: '加音效点',
  sfxClipUpdate: '调音效点',
  sfxClipRemove: '删音效点',
  planCaptionText: '时间线改排版文案',
  planCaptionWindow: '排版字幕窗调整（冻结接管）',
  planMediaWindow: '素材窗调整',
  segmentBeats: '节拍标记',
};

/** 命令目标 store 的最小结构面（projectStore 与测试 mock 都满足） */
export interface TimelineCommandStore {
  /** 段时序原始写（updateSegmentDirect 薄壳化的前身）——命令分发自用；拖拽括号内逐帧直写也走它 */
  writeSegmentTiming: (index: number, patch: {duration?: number; transition?: TransitionType; transitionParams?: Partial<TransitionParams>; transitionSfx?: SfxKind | 'off' | null}) => void;
  updateSegmentVideoTrim: (segmentIndex: number, videoIndex: number, trimStart: number, trimEnd: number, cuts?: ClipCut[]) => void;
  updateSegmentVideoAudio: (segmentIndex: number, videoIndex: number, muted: boolean) => void;
  updateSegmentNarration: (index: number, patch: Partial<SegmentNarration>) => void;
  setSegmentCaptions: (index: number, captions: CaptionLine[] | undefined) => void;
  /** AI 段补丁整包应用（update_segment/apply_cut_list 时长对齐；部分更新语义+工作副本双写在动作内） */
  applyAiSegmentPatch: (index: number, patch: ValidatedSegmentPatch) => void;
  applySegmentOrder: (order: number[]) => void;
  reorderSegments: (index: number, to: number) => void;
  splitSegment: (index: number, atSec: number) => boolean;
  moveVideoAcrossSegments: (fromSegment: number, clipIndex: number, toSegment: number, position?: number) => boolean;
  updateBgm: (partial: Partial<BgmTrack>) => void;
  addSfxClip: (kind: SfxKind, atSec: number) => string;
  updateSfxClip: (id: string, patch: Partial<Pick<SfxClip, 'kind' | 'atSec' | 'volume'>>) => void;
  removeSfxClip: (id: string) => void;
  /** M2 回写环薄动作（反解逻辑在 shared/plan-writeback；返回 false = 反解失败/无变化） */
  applySegmentPlanText: (index: number, captionIndex: number, text: string) => boolean;
  applySegmentPlanFreeze: (index: number, captionIndex: number, startSec: number, endSec: number) => boolean;
  /** 物化字幕窗原始写（拖拽括号内逐帧直写；段须已冻结接管） */
  writeSegmentCaptionWindows: (index: number, windows: {startSec: number; endSec: number}[]) => void;
  applySegmentPlanMediaWindow: (index: number, videoIndex: number, mediaInSec: number, mediaOutSec: number) => boolean;
  /** M3 L2：手放节拍标记整组设置/清除（beats=undefined 清除） */
  setSegmentBeats: (index: number, beats: SegmentBeat[] | undefined) => void;
  /** M3 L2：节拍标记原始写（拖拽括号内逐帧直写；零历史语义） */
  writeSegmentBeats: (index: number, beats: SegmentBeat[]) => void;
  /** 前置同步（工作副本刷入 segments）：reorder/moveSegment/moveShot 命令自含——覆盖域内 sync+load
   *  配对责任从调用方收进命令层（作用域豁免内执行，AI 标记不被防抖采集器半路消费） */
  syncCurrentToSegment: () => void;
}

/** 合并事务窗口（ms）：同键连续命令并入既有条目——覆盖弹层 number 输入逐键 / 滑杆逐 tick 的间隔 */
export const COALESCE_WINDOW_MS = 1200;

/**
 * 合并事务判定（纯函数，切片三）：栈顶条目与本命令同键且在窗口内 → 本命令并入既有条目
 * （既有条目的 before 即整串编辑的起点；不新入史）。无键/无栈顶/异键/超窗 = false。
 */
export const shouldCoalesce = (
  top: {coalesceKey?: string; coalesceAt?: number} | undefined,
  coalesceKey: string | undefined,
  now: number = Date.now(),
): boolean => {
  if (!coalesceKey || !top) return false;
  return top.coalesceKey === coalesceKey && now - (top.coalesceAt ?? 0) < COALESCE_WINDOW_MS;
};

/**
 * 命令分发（纯转发，零逻辑复制）。返回 false = 命令显式失败（拆分点越界等）；
 * void 动作恒 true——内容级无变化由事务层的快照判等兜住。
 */
export const applyTimelineCommand = (store: TimelineCommandStore, cmd: TimelineCommand): boolean => {
  switch (cmd.kind) {
    case 'segmentTiming':
      store.writeSegmentTiming(cmd.index, cmd.patch);
      return true;
    case 'segmentVideoTrim':
      store.updateSegmentVideoTrim(cmd.index, cmd.videoIndex, cmd.trimStart, cmd.trimEnd, cmd.cuts);
      return true;
    case 'segmentVideoAudio':
      store.updateSegmentVideoAudio(cmd.index, cmd.videoIndex, cmd.muted);
      return true;
    case 'segmentNarration':
      store.updateSegmentNarration(cmd.index, cmd.patch);
      return true;
    case 'segmentCaptions':
      store.setSegmentCaptions(cmd.index, cmd.captions);
      return true;
    case 'segmentUpdate':
      store.applyAiSegmentPatch(cmd.index, cmd.patch);
      return true;
    case 'reorderSegments':
      // 前置同步在命令作用域内（豁免采集）：AI 标记不被消费、同步改动并入本命令事务
      store.syncCurrentToSegment();
      store.applySegmentOrder(cmd.order);
      return true;
    case 'moveSegment':
      // UI 时间轴拖拽重排的释放提交（index→to 单步移动；同款前置同步）
      store.syncCurrentToSegment();
      store.reorderSegments(cmd.index, cmd.to);
      return true;
    case 'splitSegment':
      return store.splitSegment(cmd.index, cmd.atSec);
    case 'moveShot':
      store.syncCurrentToSegment();
      return store.moveVideoAcrossSegments(cmd.fromSegment, cmd.clipIndex, cmd.toSegment, cmd.position);
    case 'bgm':
      store.updateBgm(cmd.patch);
      return true;
    case 'sfxClipAdd':
      store.addSfxClip(cmd.sfxKind, cmd.atSec);
      return true;
    case 'sfxClipUpdate':
      store.updateSfxClip(cmd.id, cmd.patch);
      return true;
    case 'sfxClipRemove':
      store.removeSfxClip(cmd.id);
      return true;
    // M2 回写环：反解在薄动作内（shared/plan-writeback 纯函数）；false = 反解失败无痕
    case 'planCaptionText':
      return store.applySegmentPlanText(cmd.index, cmd.captionIndex, cmd.text);
    case 'planCaptionWindow':
      return store.applySegmentPlanFreeze(cmd.index, cmd.captionIndex, cmd.startSec, cmd.endSec);
    case 'planMediaWindow':
      return store.applySegmentPlanMediaWindow(cmd.index, cmd.videoIndex, cmd.mediaInSec, cmd.mediaOutSec);
    case 'segmentBeats':
      store.setSegmentBeats(cmd.index, cmd.beats);
      return true;
  }
};

// ====== 事务编排（依赖注入，headless 可单测） ======

export interface CommandTransactionDeps {
  /** 当前态快照（含工作副本双份） */
  snapshot: () => HistorySnapshot;
  snapshotsEqual: (a: HistorySnapshot, b: HistorySnapshot) => boolean;
  /** 作用域豁免内执行命令（命令引发的 set 不进防抖采集） */
  applyInScope: (cmd: TimelineCommand) => boolean;
  pushHistory: (snap: HistorySnapshot) => void;
  /** 来源标：显式 opts 优先，其次 AI 标记窥视（不消费），兜底 user */
  label: () => {source: HistorySource; opName?: string};
  bumpEpoch: () => void;
}

/**
 * 执行一条时间线命令 = 一条事务：
 * ① before 快照 → ② 作用域豁免内分发 → ③ 内容判等（无变化=无痕 false）
 * → ④ before+来源标 入史 + 命令纪元自增（App 采集器 pending 让位，防时序倒挂）。
 * 撤销语义：undo 弹出本条 before = 一步撤回这一命令（AI 连续操作逐步可撤）。
 */
export const executeTimelineCommand = (
  deps: CommandTransactionDeps,
  cmd: TimelineCommand,
): boolean => {
  const before = deps.snapshot();
  if (deps.applyInScope(cmd) === false) return false;
  if (deps.snapshotsEqual(before, deps.snapshot())) return false;
  const label = deps.label();
  deps.pushHistory({...before, source: label.source, ...(label.opName ? {opName: label.opName} : {})});
  deps.bumpEpoch();
  return true;
};
