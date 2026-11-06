/**
 * 撤销/重做历史的纯逻辑工具
 *
 * 说明:
 * - 本模块不依赖 React / Electron / zustand，可在纯 Node 环境直接做单元测试；
 *   projectStore 与 App.tsx 的快照采集订阅共用这里的实现。
 * - 快照为 JSON 级深拷贝，与 live 状态完全脱钩，后续编辑不会串改已入栈的快照。
 */

import type {
  Segment,
  VideoClip,
  PromoText,
  PromoStyle,
  TemplateLayout,
  Orientation,
  BgmTrack,
  LogoConfig,
  CaptionStyle,
  FinePrintConfig,
  ColorGrade,
  SfxConfig,
  TexturePreset,
  PublishKit,
  FontMoodId,
} from '../../shared/types';

/** 历史栈容量上限（超出丢弃最旧条目） */
export const HISTORY_LIMIT = 50;

/**
 * 操作来源标（timeline-master-plan 持续基建带②：AI 事务标最小版）。
 * 条目标的是「把快照推入历史的这串改动」是谁干的——命令层（M1.5）落地前先让
 * AI 写操作在 500ms 防抖合并的历史条目上可辨识（历史面板/审计/一步撤销语义的地基）。
 */
export type HistorySource = 'user' | 'agent';

/** AI 写工具标记：executeLlmTool 对非只读工具打标；App.tsx 采集器在抓首个变化时消费 */
let pendingAgentOp: {source: 'agent'; opName: string} | null = null;
export const markAgentOp = (opName: string): void => {
  pendingAgentOp = {source: 'agent', opName};
};
/** 消费标记（一次性；无标记返回 null = 本串改动视为 user） */
export const consumeAgentOp = (): {source: 'agent'; opName: string} | null => {
  const m = pendingAgentOp;
  pendingAgentOp = null;
  return m;
};
/** 只读窥视（不消费）——命令层取来源标用：标记留给 App.tsx 采集器兜底剩余改动 */
export const peekAgentOp = (): {source: 'agent'; opName: string} | null => pendingAgentOp;
/** 丢弃未消费的标记（工具执行完没引起任何历史字段变化时——executeLlmTool 收尾调用） */
export const dropAgentOp = (): void => {
  pendingAgentOp = null;
};

/**
 * 命令纪元（M1.5 切片一）：runTimelineCommand 每次入史自增。App.tsx 防抖采集器的
 * pending 改动串若跨过命令边界（用户打字到一半时 AI 命令进来），该串整体让位——
 * 命令的 before 快照已包含未决改动（工作副本），撤销语义=「命令吸收本串」，避免
 * 旧 before 快照后入栈造成的时序倒挂。
 */
let commandEpoch = 0;
export const bumpCommandEpoch = (): void => {
  commandEpoch++;
};
export const commandEpochAt = (): number => commandEpoch;

/**
 * 作用域豁免（M1.5）：scope 内的所有 store 变化都不进防抖历史（命令事务自己管入史）。
 * 与一次性 suppressNextHistory 相互独立：后者按次消费（undo/redo/加载/新建整体 set），
 * 本作用域按区间（命令可能引发多个 set）。
 */
let suppressScopeDepth = 0;
export const runWithHistorySuppressed = <T>(fn: () => T): T => {
  suppressScopeDepth++;
  try {
    return fn();
  } finally {
    suppressScopeDepth--;
  }
};
/** 命令作用域是否活跃（projectStore.consumeSuppressHistory 末位兜底查询用） */
export const isHistoryScopeActive = (): boolean => suppressScopeDepth > 0;

/**
 * 手动作用域括号（M1.5 切片二）：拖拽事务用——pointerdown 开、pointerup 收，跨事件帧
 * 持续抑制（runWithHistorySuppressed 只能包同步段）。悬挂自愈：新括号开始时强制收掉
 * 上一只未闭合的（单指针拖拽不嵌套；面板卸载中断拖拽时旧括号在此收口，最坏漏一笔
 * 拖拽入史，作用域不会永久卡死）。
 */
let manualScopeFinish: (() => void) | null = null;
export const beginSuppressedScope = (): (() => void) => {
  manualScopeFinish?.(); // 悬挂自愈：收掉旧括号（done 守卫在 fin 内，用户后补收口不会双扣）
  suppressScopeDepth++;
  let done = false;
  const fin: () => void = () => {
    if (done) return;
    done = true;
    if (manualScopeFinish === fin) manualScopeFinish = null;
    suppressScopeDepth = Math.max(0, suppressScopeDepth - 1);
  };
  manualScopeFinish = fin;
  return fin;
};

/** 历史快照：故事板内容 + 当前片段工作副本（双份状态一起保存，恢复时一起恢复） */
export interface HistorySnapshot {
  segments: Segment[];
  /** 快照时的活动片段下标：undo/redo 据此判断快照里的工作副本对应恢复后的哪个片段 */
  activeSegmentIndex: number;
  templateId: string | null;
  videos: VideoClip[];
  text: PromoText;
  style: PromoStyle;
  layout: TemplateLayout;
  customParams: Record<string, number>;
  bgm: BgmTrack | null;
  logo: LogoConfig | null;
  captionStyle: CaptionStyle;
  finePrint: FinePrintConfig;
  colorGrade: ColorGrade;
  brandColor: string | null;
  fontMood: FontMoodId;
  sfx: SfxConfig;
  texture: TexturePreset;
  beatPulse: boolean;
  cursor: boolean;
  aspectRatioId: string;
  orientation: Orientation;
  /** 发布准备（封面 + 元数据，项目级） */
  publish: PublishKit;
  /** 改动来源标（基建②最小版；旧条目缺省 = user 语义，additive 不参与判等快照构造） */
  source?: HistorySource;
  /** 操作名（agent = 工具名；user 暂缺省——命令层 M1.5 起补全） */
  opName?: string;
  /** 合并事务键（切片三）：同键命令在窗口内并入既有条目（不新入史）——弹层逐键输入/滑杆的防灌史机制 */
  coalesceKey?: string;
  /** 合并窗锚点（ms 时间戳；超窗即分条） */
  coalesceAt?: number;
}

/** JSON 级深拷贝（快照字段均为纯数据，无函数 / Date / undefined 关键值） */
export const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * 两个纯数据值的内容判等（JSON 序列化比较）；引用相同直接判等，免去序列化开销。
 * 用于跳过「引用变了但内容没变」的伪改动（如切步骤时 syncCurrentToSegment 的整体同步）。
 */
export const jsonContentEqual = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * 快照内容判等（JSON 序列化比较）。
 * 用于跳过「引用变了但内容没变」的伪改动（如切步骤时的整体同步），避免历史栈被空条目污染。
 */
export const snapshotsEqual = (a: HistorySnapshot, b: HistorySnapshot): boolean =>
  jsonContentEqual(a, b);

/** 入栈并裁剪到上限（超出丢弃最旧） */
export const pushHistoryEntry = (
  past: HistorySnapshot[],
  snapshot: HistorySnapshot,
  limit: number = HISTORY_LIMIT
): HistorySnapshot[] => [...past, snapshot].slice(-limit);

/**
 * 历史订阅追踪的 state 字段清单（工作副本 + 故事板全局；渲染设置影响导出但不需要撤销，不入历史）。
 * App.tsx 历史订阅的「引用未变快速跳过」门与此清单遍历比较——
 * 新增工程内容字段时必须加入（曾经每加字段要手动同步多处，现在只改这里）。
 */
export const HISTORY_TRACKED_KEYS = [
  'segments', 'bgm', 'logo', 'captionStyle', 'finePrint', 'sfx', 'texture', 'beatPulse', 'cursor', 'aspectRatioId', 'orientation',
  'templateId', 'videos', 'text', 'style', 'layout', 'customParams', 'brandColor', 'fontMood',
] as const;

/** 脏标记追踪的字段 = 历史字段 + 渲染设置（影响导出结果但不需要撤销） */
export const DIRTY_TRACKED_KEYS = [...HISTORY_TRACKED_KEYS, 'renderSettings'] as const;

/** 引用级判等：全部追踪字段引用都没变 → false（历史订阅的快速跳过门） */
export const trackedRefsUnchanged = (s: Record<string, unknown>, prev: Record<string, unknown>): boolean =>
  HISTORY_TRACKED_KEYS.every((k) => s[k] === prev[k]);

/** 内容级判脏：任一追踪字段引用变了且内容不等 → true */
export const trackedContentDirty = (s: Record<string, unknown>, prev: Record<string, unknown>): boolean =>
  DIRTY_TRACKED_KEYS.some((k) => s[k] !== prev[k] && !jsonContentEqual(s[k], prev[k]));
