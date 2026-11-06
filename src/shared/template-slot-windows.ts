/**
 * template-slot-windows - 3D 家族「槽位窗口」查询（编排侧单一事实源）
 *
 * 回答编排/LLM 最重要的问题：**给定模板/时长/参数，每块展板在成片里的哪段时间可见？**
 * 3D 画中画只在驻留窗口播放（模板内 previewWindow = dwell），素材精彩时刻必须落在
 * 「画中画播放的起点」即素材本地 0 ~ dwellDurSec——否则就是「内容还没放完就转场」。
 *
 * 本模块是 panel-timeline（机械学）之上的语义层：把七款 3D 模板共享的驻留调度常数
 * （开场/收尾占比、驻留节奏档、甩头时长档）与模板清单收敛到这里，供
 * - 模板渲染端（消掉各模板本地重复的 OPEN_END/OUTRO_START/DWELL_FRAC 常数）
 * - LLM 工具 get_template_slot_windows / auto_* 编排（查表代替猜窗口）
 * - 构建脚本（画中画裁剪窗与驻留窗对齐校验）
 * 三方共用。零依赖（不 import three/remotion），主进程/渲染端/脚本均可安全引用。
 */
import {buildPanelTimeline, focusWeights} from './panel-timeline';
import {getTemplateById} from './template-registry';

/** 开场时长占比（底层仰视/入口远景等） */
export const SLOT_OPEN_END = 0.12;
/** 收尾起点占比（最后 8%：升空俯瞰/回望等） */
export const SLOT_OUTRO_START = 0.92;
/** 驻留节奏档（dwellRatio 0快/1均衡/2长驻留/3特写驻留 → dwell 占比） */
export const SLOT_DWELL_FRAC = [0.45, 0.58, 0.7, 0.8];
/** camSpeed → 甩头时长倍率（与 rig-utils.CAM_SPEED_TRAVEL 同源，勿改一处漏一处） */
export const SLOT_CAM_SPEED_TRAVEL = [2, 1, 0.78];

/** 支持「槽位窗口」查询的 3D 模板（七款，全部同构驻留调度） */
export const SLOT_WINDOW_TEMPLATE_IDS = [
  'CameraJourney3D',
  'CityScape3D',
  'GalleryHall3D',
  'OrbitCarousel3D',
  'SpiralAtrium3D',
  'Starfield3D',
  'TimeTunnel3D',
] as const;

export type SlotWindowTemplateId = (typeof SLOT_WINDOW_TEMPLATE_IDS)[number];

export const isSlotWindowTemplate = (templateId: string): boolean =>
  (SLOT_WINDOW_TEMPLATE_IDS as readonly string[]).includes(templateId);

/** camSpeed 参数值 → 甩头时长倍率（与 rig-utils.travelScaleOf 同口径） */
export const slotTravelScaleOf = (camSpeed: number): number =>
  SLOT_CAM_SPEED_TRAVEL[Math.min(2, Math.max(0, Math.round(Number.isFinite(camSpeed) ? camSpeed : 1)))];

export interface TemplateSlot {
  /** 展板下标（0 基，对应段内第 index+1 个画中画素材） */
  index: number;
  /** 行进段起点/终点（秒）——相机从上一板甩向本板 */
  travelStartSec: number;
  travelEndSec: number;
  /** 驻留段起点/终点（秒）——画中画只在这段播放，本板文案同时显示 */
  dwellStartSec: number;
  dwellEndSec: number;
  /** 驻留时长（秒）＝画中画素材可见时长 */
  dwellDurSec: number;
}

export interface TemplateSlotWindows {
  templateId: string;
  /** 段总时长（秒） */
  durationSec: number;
  /** 展板数（＝画中画素材数上限内） */
  panelCount: number;
  /** 生效参数（回显，便于调用方核对） */
  effective: {dwellRatio: number; focusPanel: number; focusBoost: number; camSpeed: number};
  /** 开场段（0 ~ openSec）：无展板驻留 */
  openSec: number;
  /** 收尾段（outroSec ~ durationSec）：无展板驻留 */
  outroSec: number;
  slots: TemplateSlot[];
}

export interface SlotWindowQueryOpts {
  /** 驻留节奏档 0-3（缺省 2 长驻留，与模板参数默认一致） */
  dwellRatio?: number;
  /** 重点展板下标 0-5（缺省 0 无重点） */
  focusPanel?: number;
  /** 重点驻留倍率 1-2.5（缺省 1） */
  focusBoost?: number;
  /** 镜头速度档 0-2（缺省 0 舒缓） */
  camSpeed?: number;
  /** 帧率（缺省 30；内部按帧计算再折回秒） */
  fps?: number;
}

/** 模板参数缺省值（注册表单一数据源；槽位相关四参数的默认随模板走） */
const defaultOf = (templateId: string, key: string): number | undefined => {
  const specs = getTemplateById(templateId)?.paramSpecs;
  const spec = specs?.find((s) => s.key === key);
  if (!spec) return undefined;
  const v = Number(spec.default);
  return Number.isFinite(v) ? v : undefined;
};

/**
 * 查询某模板在给定时长下的逐板驻留窗口（秒）。
 * 非槽位模板返回 null；panelCount 钳到 [1, 6]（模板装配上限）。
 * 参数缺省值取模板注册表（dwellRatio/camSpeed 等随模板走，不硬编码）。
 * 编排纪律：画中画素材的精彩时刻应落在对应槽位「素材本地 0 ~ dwellDurSec」内
 * （画中画从驻留开始播放，素材本地时间 0 对齐 dwellStartSec）。
 */
export const getTemplateSlotWindows = (
  templateId: string,
  durationSec: number,
  panelCount: number,
  opts?: SlotWindowQueryOpts,
): TemplateSlotWindows | null => {
  if (!isSlotWindowTemplate(templateId)) return null;
  const fps = opts?.fps ?? 30;
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const n = Math.min(6, Math.max(1, Math.round(panelCount)));
  if (!(duration > 0) || n < 1) return null;
  const dwellRatio = Math.round(opts?.dwellRatio ?? defaultOf(templateId, 'dwellRatio') ?? 2);
  const camSpeed = Math.round(opts?.camSpeed ?? defaultOf(templateId, 'camSpeed') ?? 0);
  const focusPanel = Math.round(opts?.focusPanel ?? defaultOf(templateId, 'focusPanel') ?? 0);
  const focusBoost = opts?.focusBoost ?? defaultOf(templateId, 'focusBoost') ?? 1;
  const tl = buildPanelTimeline(
    n,
    Math.round(duration * fps),
    SLOT_DWELL_FRAC[Math.min(3, Math.max(0, dwellRatio))],
    focusWeights(n, focusPanel, focusBoost),
    SLOT_OPEN_END,
    SLOT_OUTRO_START,
    slotTravelScaleOf(camSpeed),
  );
  const toSec = (frames: number): number => Math.round(((frames / fps) * 100)) / 100;
  return {
    templateId,
    durationSec: duration,
    panelCount: n,
    effective: {
      dwellRatio: Math.min(3, Math.max(0, dwellRatio)),
      focusPanel: Math.min(5, Math.max(0, focusPanel)),
      focusBoost: Math.min(2.5, Math.max(1, focusBoost)),
      camSpeed: Math.min(2, Math.max(0, camSpeed)),
    },
    openSec: toSec(SLOT_OPEN_END * duration * fps),
    outroSec: toSec(SLOT_OUTRO_START * duration * fps),
    slots: tl.dwellStart.map((ds, i) => ({
      index: i,
      travelStartSec: toSec(tl.travelStart[i]),
      travelEndSec: toSec(tl.travelStart[i] + tl.travelDur),
      dwellStartSec: toSec(ds),
      dwellEndSec: toSec(ds + tl.dwellDur[i]),
      dwellDurSec: toSec(tl.dwellDur[i]),
    })),
  };
};
