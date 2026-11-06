/**
 * 音乐结构重排（纯函数，无运行时依赖，Node 可直跑单测）——RESEARCH-TRANSITIONS.md §三/B4。
 *
 * 把 planBeatMontage 的「段落能量 → 切镜密度」从 VideoCut 混剪推广到常规模板故事板：
 * 1. 段落边界对齐：故事板累计边界吸附到音乐段落边界（music-map 的段落边界已吸附重拍，
 *    对齐后 drop 起点恰好落在数据/高光段的起点上，intro/outro 对应钩子/CTA 段）；
 * 2. 转场类型随段能量选择：drop/高能量边界 whip/flyThrough/cardSweep（轮换防重复），
 *    build 中能量 slide/push/zoomIn，intro/outro/break 安静段 crossfade。
 *
 * 只改时长与转场类型（决策层），不动模板/文案/素材——LLM 的叙事创意不被覆盖；
 * durationSec 等转场参数保持原样（时长吸附仍由 align_beats 的半拍网格负责）。
 * 输出纯数据，落地由调用方（align_music_structure 工具 / 流水线步）写回故事板。
 */

import type {MusicMap, MusicSection} from './music-map.ts';
import type {Segment, TransitionType} from './types.ts';

export interface StructureRearrangeOptions {
  /** 累计边界吸附段落边界的容差（秒，缺省 1.5）：超出则不动，防大幅改变内容时长 */
  toleranceSec?: number;
  /** 段时长下限（秒，缺省 1.5；吸附不把段压扁） */
  minSegmentSec?: number;
  /** 转场选型：fill=只补硬切（保显式选择，手动工程默认）；all=全部按段能量重选（流水线新生故事板用） */
  transitionMode?: 'fill' | 'all';
}

export interface StructureRearrangePlan {
  /** 对齐后的各段时长（秒；最后一段不调整） */
  durations: number[];
  /** 选型后的各段转场（段 i 的转场驱动边界 i → i+1） */
  transitions: TransitionType[];
  /** 发生移动的切点数量 */
  boundaryMovedCount: number;
  /** 被改写的转场数量 */
  transitionChangedCount: number;
  /** 决策明细（给用户/LLM 看） */
  notes: string[];
  summary: string;
}

/** 段落能量档位 → 转场候选（同类轮换防全片同款） */
const STRONG_TRANSITIONS: TransitionType[] = ['whip', 'flyThrough', 'cardSweep'];
const MEDIUM_TRANSITIONS: TransitionType[] = ['slide', 'push', 'zoomIn'];

/** 边界目标段的能量 → 转场类型；strongIdx/mediumIdx 为同类内的轮换游标 */
const pickTransitionByEnergy = (
  section: MusicSection | undefined,
  strongIdx: number,
  mediumIdx: number,
): TransitionType => {
  const label = section?.label;
  const energy = section?.energy ?? 0.5;
  if (label === 'drop' || energy >= 0.7) return STRONG_TRANSITIONS[strongIdx % STRONG_TRANSITIONS.length];
  if (label === 'intro' || label === 'outro' || label === 'break' || energy < 0.45) return 'crossfade';
  return MEDIUM_TRANSITIONS[mediumIdx % MEDIUM_TRANSITIONS.length];
};

const sectionAt = (sections: MusicSection[], t: number): MusicSection | undefined =>
  sections.find((s) => t >= s.startSec - 1e-6 && t < s.endSec) ?? sections[sections.length - 1];

/**
 * 主入口：故事板段落 × 音乐结构 → 边界对齐 + 转场选型计划。
 * 音乐无段落（sections < 2）或故事板 < 2 段时返回 null（调用方跳过，不影响既有排片）。
 */
export const planMusicStructureRearrange = (
  segments: Array<Pick<Segment, 'duration' | 'transition'>>,
  music: Pick<MusicMap, 'sections'>,
  opts: StructureRearrangeOptions = {},
): StructureRearrangePlan | null => {
  const tolerance = opts.toleranceSec ?? 1.5;
  const minSec = opts.minSegmentSec ?? 1.5;
  const mode = opts.transitionMode ?? 'fill';
  const sections = music.sections ?? [];
  if (segments.length < 2 || sections.length < 2) return null;

  // ---- 1. 段落边界对齐（累计边界吸附到段落起点；顺序推进，后续边界从吸附后继续累计）----
  const anchors = [...new Set(sections.map((s) => s.startSec).filter((t) => t > 0.1))].sort((a, b) => a - b);
  const durations = segments.map((s) => s.duration || 8);
  const snappedBoundaries: number[] = [];
  let boundaryMovedCount = 0;
  let prevBoundary = 0;
  for (let i = 0; i < durations.length - 1; i++) {
    const boundary = prevBoundary + durations[i];
    let best: number | null = null;
    for (const a of anchors) {
      if (best === null || Math.abs(a - boundary) < Math.abs(best - boundary)) best = a;
    }
    if (best !== null && Math.abs(best - boundary) <= tolerance) {
      const newDur = Math.min(60, Math.max(minSec, best - prevBoundary));
      if (Math.abs(newDur - durations[i]) > 0.01) {
        durations[i] = newDur;
        boundaryMovedCount++;
        snappedBoundaries.push(best);
      } else {
        snappedBoundaries.push(boundary);
      }
    } else {
      snappedBoundaries.push(boundary);
    }
    prevBoundary += durations[i];
  }

  // ---- 2. 转场类型随目标段（下一段落座的音乐段）能量选型 ----
  const transitions = segments.map((s) => s.transition);
  let transitionChangedCount = 0;
  let strongIdx = 0;
  let mediumIdx = 0;
  const notes: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    if (mode === 'fill' && segments[i].transition !== 'none') continue; // fill 只补硬切，显式选择不动
    const target = sectionAt(sections, snappedBoundaries[i]);
    const picked = pickTransitionByEnergy(target, strongIdx, mediumIdx);
    if (picked === 'whip' || picked === 'flyThrough' || picked === 'cardSweep') strongIdx++;
    else if (picked !== 'crossfade') mediumIdx++;
    if (transitions[i] !== picked) {
      notes.push(`边界${i}→${i + 1}（${target?.label ?? '?'}段 能量${(target?.energy ?? 0).toFixed(2)}）：${transitions[i] || 'none'} → ${picked}`);
      transitions[i] = picked;
      transitionChangedCount++;
    }
  }

  const parts: string[] = [];
  if (boundaryMovedCount > 0) parts.push(`${boundaryMovedCount} 个切点对齐音乐段落边界`);
  if (transitionChangedCount > 0) parts.push(`${transitionChangedCount} 个转场按段能量选型`);
  const summary = parts.length > 0
    ? `${parts.join('，')}（音乐段落 ${sections.length} 个）`
    : `故事板已与音乐段落结构对齐（段落 ${sections.length} 个，无需调整）`;
  return {durations, transitions, boundaryMovedCount, transitionChangedCount, notes, summary};
};
