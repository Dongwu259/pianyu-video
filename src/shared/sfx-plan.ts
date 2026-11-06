/**
 * 音效（SFX）自动放置规划（纯函数，无运行时依赖，Node 可直跑单测）。
 *
 * 输入片段时间模型（与 MultiSegmentPromo 的 segmentTimings 同构）与 BGM 节拍点，
 * 输出音效放置表：哪一帧、放哪类、用第几个变体。MultiSegmentPromo 据此渲染
 * <Sequence><Audio> 音效轨，预览与最终渲染同源。
 *
 * 规则（与 ROADMAP「音效设计」一致）：
 * - 转场高潮帧放「与转场类型匹配」的音效（TRANSITION_SFX_KIND）：滑动/推拉/甩镜
 *   配短促 swish，淡化/模糊配轻柔 sweep，缩放/运镜/翻转配低频 drop，闪白配
 *   impact，擦除/圆形展开/遮挡物配经典 whoosh。起点提前 SFX_LEAD_SEC[kind]，让各类
 *   音效的听感峰值压在高潮帧上（B3 骑跨模型：高潮帧 = 切点 = 拍点；crossfade 等
 *   peak=0 不骑跨的类型保持旧「窗口中点」锚）；映射类别缺货时降级 whoosh。
 * - 节拍落点放 impact：beatImpact 开启且有节拍数据时，跳过片头 riser 区与
 *   转场邻域（避免音效堆叠），相邻 impact 最小间隔 MIN_IMPACT_GAP_SEC 节流。
 * - 片头放 riser：第 0 帧起。
 * 变体按类别各自轮换（确定性），避免全片重复同一音效。
 */

import type {SfxConfig, SfxKind, Segment, TransitionType} from './types';
import {parseChatLines, bubbleEnterFrame} from './chat-conversation';
import {dragInTypingStartFrame} from './prompt-drag';
import {parseDocParagraphs, parseDocPlaceholders, docPanelTimeline} from './doc-panel';
import {TRANSITION_PEAK_PHASE} from './transition-style';

/** 转场类型 → 音效类别映射（none 不会用到，仅为完整性兜底） */
export const TRANSITION_SFX_KIND: Record<TransitionType, SfxKind> = {
  none: 'whoosh',
  crossfade: 'sweep',
  slide: 'swish',
  wipe: 'whoosh',
  iris: 'whoosh',
  push: 'swish',
  velocityPush: 'swish',
  zoom: 'drop',
  rotate: 'drop',
  blur: 'sweep',
  flash: 'impact',
  zoomIn: 'drop',
  zoomOut: 'drop',
  whip: 'swish',
  flyThrough: 'whoosh',
  panChase: 'whoosh',
  orbitSwipe: 'whoosh',
  cardSweep: 'whoosh',
  shapeBloom: 'whoosh',
};

/** whoosh 起点相对转场中点的提前量（秒）：让听感峰值压在转场中点上 */
export const WHOOSH_LEAD_SEC = 0.18;
/** 各类音效起点相对转场中点的提前量（秒）：峰值位置因合成包络而异 */
export const SFX_LEAD_SEC: Record<SfxKind, number> = {
  whoosh: WHOOSH_LEAD_SEC, // 峰值约 30% 处
  swish: 0.12, // 峰值约 28% 处（短促）
  sweep: 0.3, // 正弦包络，峰值在中点
  drop: 0.26, // 导入气流后 thump 约在 0.25s 处
  impact: 0.04, // 瞬态即峰值
  riser: 0,
  click: 0.02,
  pop: 0.01, // 瞬态即峰值
  ding: 0.01,
};
/** impact 不放的片头区域（秒）：让 riser 单独铺底 */
export const INTRO_RISER_ZONE_SEC = 1.0;
/** 转场中点邻域（秒）：该范围内的节拍不再放 impact，避免堆叠 */
export const TRANSITION_EXCLUSION_SEC = 0.35;
/** 相邻 impact 最小间隔（秒）：过密的节拍不全放，防止「敲鼓」 */
export const MIN_IMPACT_GAP_SEC = 0.8;
/** 片尾留白（秒）：全片淡黑收尾区不放 impact */
export const OUTRO_ZONE_SEC = 0.5;

/** 片段时间（与 MultiSegmentPromo segmentTimings 同构，只取放置需要的字段） */
export interface SfxSegmentTiming {
  contentStartFrame: number;
  contentEndFrame: number;
  /** 与下一段的转场重叠帧数（0 = 硬切/无转场） */
  outOverlap: number;
  isLast: boolean;
  transition: TransitionType;
  /** 该段出场转场的音效覆盖（'off' = 这个转场不出音效；缺省 = 按转场类型自动映射） */
  sfxOverride?: SfxKind | 'off';
}

export interface SfxPlacement {
  /** 音效播放起始帧（绝对帧） */
  frame: number;
  kind: SfxKind;
  /** 变体序号（对变体总数取模后的值） */
  variant: number;
}

/** 节拍律动：每 4 个有效拍一个 impact 重音，第 2 拍放轻 click，其余拍静默——
 *  取代旧的「每个合隔拍都敲 impact」（长视频全程咚咚咚的根源）。 */
const IMPACT_EVERY = 4;
const CLICK_EVERY = 2;
/** click 最小间隔（秒）：弱拍轻点也不能机枪式连发 */
const MIN_CLICK_GAP_SEC = 0.3;

/** 各类音效的 UI 元数据（时间轴轨道配色 / 中文标签；shared 单一数据源） */
export const SFX_KIND_META: Record<SfxKind, {label: string; color: string}> = {
  whoosh: {label: '风声', color: '#38BDF8'},
  swish: {label: '短嗖', color: '#818CF8'},
  sweep: {label: '轻扫', color: '#34D399'},
  drop: {label: '低坠', color: '#F59E0B'},
  impact: {label: '重音', color: '#F87171'},
  riser: {label: '上升音', color: '#A78BFA'},
  click: {label: '轻点', color: '#94A3B8'},
  pop: {label: '气泡', color: '#FBBF24'},
  ding: {label: '勾选', color: '#34D399'},
};

/** 各类音效的相对响度（在 sfx.volume 基础上再乘）：riser/sweep 铺底压一点，impact/drop 给足。
 *  渲染混音与时间轴「试听」同源：试听听到的就是导出听到的。 */
export const SFX_KIND_GAIN: Record<SfxKind, number> = {
  whoosh: 0.9,
  swish: 0.85,
  sweep: 0.75,
  drop: 1.0,
  impact: 1.0,
  riser: 0.6,
  click: 0.45, // 弱拍轻点：律动用，不能和重音一样响
  pop: 0.5, // UI 气泡：轻快不抢 BGM
  ding: 0.55, // 勾选：清亮提示
};

/**
 * 规划全片音效放置。
 * @param timings 各片段时间（仅可渲染片段；与画面渲染用同一数组）
 * @param beatsSec BGM 节拍点（秒；无 BGM 或未开 beatImpact 时传 []）
 * @param fps 帧率
 * @param config 音效配置（enabled=false 直接返回 []）
 * @param variantCounts 各类音效变体数量（缺货类别 = 0，转场音效降级 whoosh，其他不放）
 */
export const planSfxPlacements = (
  timings: SfxSegmentTiming[],
  beatsSec: number[],
  fps: number,
  config: SfxConfig,
  variantCounts: Record<SfxKind, number>,
): SfxPlacement[] => {
  if (!config.enabled || fps <= 0 || timings.length === 0) return [];
  const placements: SfxPlacement[] = [];
  const totalFrames = timings[timings.length - 1].contentEndFrame;

  // ---- 转场音效（按转场类型映射类别，各类别独立轮换变体；支持逐段覆盖）----
  const transitionMidFrames: number[] = [];
  if (config.transitionWhoosh) {
    const counters = {} as Record<SfxKind, number>;
    for (const t of timings) {
      if (t.isLast || t.outOverlap <= 0 || t.transition === 'none') continue;
      if (t.sfxOverride === 'off') continue; // 用户关掉了这个转场的音效
      let kind = t.sfxOverride ?? TRANSITION_SFX_KIND[t.transition] ?? 'whoosh';
      if (variantCounts[kind] <= 0) kind = 'whoosh'; // 覆盖/映射类别缺货 → 降级经典风声
      if (variantCounts[kind] <= 0) continue;
      // B3：骑跨转场（peak>0）的听感峰值压在高潮帧 = 切点（拍点）上；
      // crossfade（peak=0，窗口挂切点后）保持旧「窗口中点」锚。
      const peak = TRANSITION_PEAK_PHASE[t.transition] ?? 0;
      const mid = peak > 0 ? t.contentEndFrame : t.contentEndFrame + t.outOverlap / 2;
      transitionMidFrames.push(mid);
      const v = counters[kind] ?? 0;
      counters[kind] = v + 1;
      placements.push({
        frame: Math.max(0, Math.round(mid - SFX_LEAD_SEC[kind] * fps)),
        kind,
        variant: v % variantCounts[kind],
      });
    }
  }

  // ---- 片头 riser ----
  if (config.introRiser && variantCounts.riser > 0) {
    placements.push({frame: 0, kind: 'riser', variant: 0});
  }

  // ---- 节拍律动（impact 重音 + click 轻点）：每 4 拍一重、第 2 拍轻点，其余静默 ----
  if (config.beatImpact && (variantCounts.impact > 0 || variantCounts.click > 0) && beatsSec.length > 0) {
    const minGap = MIN_IMPACT_GAP_SEC * fps;
    const clickGap = MIN_CLICK_GAP_SEC * fps;
    const introZone = INTRO_RISER_ZONE_SEC * fps;
    const outroZone = OUTRO_ZONE_SEC * fps;
    const exclusion = TRANSITION_EXCLUSION_SEC * fps;
    let lastImpactFrame = -Infinity;
    let lastClickFrame = -Infinity;
    // 与转场共用 impact 池：闪白转场已消耗的变体序号纳入轮换，避免相邻重复
    let v = (placements.filter((p) => p.kind === 'impact').length) % Math.max(1, variantCounts.impact);
    let cv = 0;
    let idx = -1; // 有效拍序号（过片区过滤后计数，驱动 4 拍律动）
    for (const b of beatsSec) {
      const f = Math.round(b * fps);
      if (f < introZone || f >= totalFrames - outroZone) continue;
      if (transitionMidFrames.some((m) => Math.abs(f - m) < exclusion)) continue;
      idx++;
      if (idx % IMPACT_EVERY === 0 && variantCounts.impact > 0 && f - lastImpactFrame >= minGap) {
        placements.push({frame: f, kind: 'impact', variant: v % variantCounts.impact});
        v++;
        lastImpactFrame = f;
        continue;
      }
      // 弱拍：第 2 拍放轻点（无 click 库存或间隔太密则静默，绝不机关枪连发）
      const isClickSlot = idx % CLICK_EVERY === 0;
      if (isClickSlot && variantCounts.click > 0 && f - lastClickFrame >= clickGap) {
        placements.push({frame: f, kind: 'click', variant: cv % variantCounts.click});
        cv++;
        lastClickFrame = f;
      }
    }
  }

  return placements.sort((a, b) => a.frame - b.frame);
};

// ====== 手放音效片段（SfxClip，时间轴音效轨 v4）======

import type {SfxClip} from './types';

/** 音效块在时间轴上的名义显示时长（秒）：真实素材时长不一，UI 与车道分配统一用近似值 */
export const SFX_CLIP_VISUAL_SEC = 0.8;

/** 手放音效位置钳制：[0, 片长-0.1]，0.1 步进（与 UI 拖拽同口径） */
export const clampSfxClipAtSec = (atSec: number, totalSec: number): number =>
  Math.max(0, Math.min(Math.max(0, totalSec - 0.1), Math.round(atSec * 10) / 10));

/** 手放音效独立音量钳制 0..1 */
export const clampSfxClipVolume = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * 手放音效的确定性变体选择：按 clip id 哈希。
 * 自动放置按放置序号轮换变体，手放 clip 没有稳定序号（增删即变），
 * 用 id 哈希保证「同一 clip 每次渲染同一变体」——Remotion 导出可复现的前提。
 */
export const sfxClipVariant = (id: string, variantCount: number): number => {
  if (!Number.isFinite(variantCount) || variantCount <= 1) return 0;
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  }
  return h % variantCount;
};

export interface SfxClipLaneResult {
  /** 每个 clip 的车道号（下标与输入同序） */
  lanes: number[];
  /** 车道总数（≥1；无 clip 时为 0） */
  laneCount: number;
}

/**
 * 手放音效块的车道分配（时间轴 UI 用）：时间重叠的 clip 上下错开排布，
 * 视觉上呈现「多轨叠加」。贪心首适配：按 atSec 排序，放进第一个尾部空闲车道。
 */
export const assignSfxClipLanes = (clips: SfxClip[]): SfxClipLaneResult => {
  if (clips.length === 0) return {lanes: [], laneCount: 0};
  const order = clips.map((c, i) => ({i, start: c.atSec, end: c.atSec + SFX_CLIP_VISUAL_SEC}));
  order.sort((a, b) => a.start - b.start || a.i - b.i);
  const laneEnds: number[] = [];
  const lanes: number[] = new Array(clips.length).fill(0);
  for (const o of order) {
    let lane = laneEnds.findIndex((end) => o.start >= end);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = o.end;
    lanes[o.i] = lane;
  }
  return {lanes, laneCount: laneEnds.length};
};

// ====== UI 元素音效（P6）：随模板内部时间线自动放置 ======

/** 打字轻点间隔（帧）：哒哒声的 cadence，与真实打字节奏同量级 */
const UI_TYPE_TICK_FRAMES = 3;
/** 单段 UI 音效上限：防「音墙」（长脚本全量放点会糊） */
const UI_CUES_PER_SEGMENT_CAP = 30;

/**
 * 规划 UI 元素音效放置（对话框气泡 pop / 打字轻点 click / 勾选 ding）。
 * 时间线数学与模板同源（chat-conversation/prompt-drag/doc-panel 的共享纯函数），
 * 保证「看到的元素入场 = 听到的提示」。config.uiCues === false 时返回 []。
 * @param segments 故事板段（取 templateId/text/customParams/duration）
 * @param startFrames 各段绝对起始帧（与画面渲染同源的 contentStartFrame）
 */
export const planUiSfxPlacements = (
  segments: Array<Pick<Segment, 'templateId' | 'text' | 'duration' | 'customParams'>>,
  startFrames: number[],
  fps: number,
  config: SfxConfig,
  variantCounts: Record<SfxKind, number>,
): SfxPlacement[] => {
  if (!config.enabled || config.uiCues === false) return [];
  const placements: SfxPlacement[] = [];
  let vPop = 0;
  let vDing = 0;
  let vClick = 0;
  const push = (frame: number, kind: SfxKind, counts: Record<SfxKind, number>, cap: number) => {
    if (frame < 0) return false;
    if ((counts[kind] ?? 0) <= 0) return false;
    placements.push({
      frame: Math.max(0, Math.round(frame)),
      kind,
      variant: cap % counts[kind],
    });
    return true;
  };
  segments.forEach((seg, i) => {
    if (placements.length > 400) return; // 全局护栏
    const start = startFrames[i] ?? 0;
    const total = Math.max(1, Math.round((seg.duration || 6) * fps));
    const params = seg.customParams ?? {};
    let used = 0;
    if (seg.templateId === 'ChatConversation') {
      const lines = parseChatLines(seg.text?.features ?? []);
      const pace = Number(params.pace) || 1;
      const enters = lines.map((_, k) => bubbleEnterFrame(k, lines.length, total, fps, pace));
      for (const e of enters) {
        if (used >= UI_CUES_PER_SEGMENT_CAP) break;
        if (push(start + e, 'pop', variantCounts, vPop)) { vPop++; used++; }
      }
      const aiCount = lines.filter((l) => l.role === 'ai').length;
      if (Number(params.badge ?? 1) >= 0.5 && aiCount > 0 && enters.length > 0) {
        if (push(start + enters[enters.length - 1] + Math.round(0.3 * fps), 'ding', variantCounts, vDing)) { vDing++; used++; }
      }
    } else if (seg.templateId === 'AiPromptCard') {
      const prompt = seg.text?.title ?? '';
      const typeSpeed = Number(params.typeSpeed) || 12;
      const dragInOn = Number(params.dragIn ?? 0) >= 0.5;
      const typeStart = dragInTypingStartFrame(fps, dragInOn);
      const typeDurFrames = Math.round((prompt.length / Math.max(1, typeSpeed)) * fps);
      const enter = Math.max(24, Math.round(total * (Number(params.enterAt) || 0.45)));
      for (let f = typeStart; f < Math.min(typeStart + typeDurFrames, enter); f += UI_TYPE_TICK_FRAMES) {
        if (used >= UI_CUES_PER_SEGMENT_CAP) break;
        if (push(start + f, 'click', variantCounts, vClick)) { vClick++; used++; }
      }
      if (used < UI_CUES_PER_SEGMENT_CAP) {
        if (push(start + enter, 'ding', variantCounts, vDing)) { vDing++; used++; }
      }
    } else if (seg.templateId === 'DocPanel') {
      const paras = parseDocParagraphs(seg.text?.features ?? []);
      const cells = parseDocPlaceholders(seg.text?.features ?? []);
      const tl = docPanelTimeline(paras.length, cells.length, total, fps, Number(params.pace) || 1);
      for (let k = 0; k < paras.length; k++) {
        if (used >= UI_CUES_PER_SEGMENT_CAP) break;
        if (push(start + tl.paraEnter(k), 'pop', variantCounts, vPop)) { vPop++; used++; }
      }
      for (let k = 0; k < cells.length; k++) {
        if (used >= UI_CUES_PER_SEGMENT_CAP) break;
        if (push(start + tl.cellEnter(k), 'ding', variantCounts, vDing)) { vDing++; used++; }
      }
    }
  });
  return placements;
};
