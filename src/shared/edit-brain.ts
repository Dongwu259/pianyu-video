/**
 * 剪辑决策（edit-brain）——把「音乐结构图 × 素材镜头表」变成卡点切镜计划
 *
 * 规则（v1，确定性、可单测；LLM 层在此之上做创意选择而非基础对齐）：
 * 1. 槽位：按音乐段落定切镜密度——drop 每拍一刀、build/break 两拍、intro/outro 四拍；
 *    全部切点落在节拍网格上（这是「真卡点」，不是加特效）。
 * 2. 选镜：镜头运动强度向所在段落能量靠拢（|motion−energy| 小者优先）；
 *    惩罚：同素材连出 +0.5、已用过 +0.3/次；素材池轮流，避免一条素材撑全场。
 * 3. 取窗：镜头长于槽位取槽长（首用对齐镜头能量峰，复用窗口后错）；
 *    短于槽位则向下取整到拍（不足 1 拍的镜头直接淘汰），保证切点永不出格。
 * 4. 创意层（LLM 创意指令，可选）：钉镜（开篇/收尾/首 drop 高光镜）与禁镜——
 *    LLM 拿着 get_music_map + get_footage_map 两张表做排片决策，基础对齐仍由本层保证。
 *
 * 输出纯数据（素材名 + 入出点 + 顺序），不碰工程——落地由调用方（auto_beat_montage
 * 工具）翻译成故事板片段，转场方向交给 motion-chain 衔接。
 */

import type {MusicMap, MusicSection, SectionLabel} from './music-map.ts';
import type {FootageShot} from '../main/services/footage.ts';

export interface SourceShots {
  /** 素材标识（文件名/clip id） */
  source: string;
  shots: FootageShot[];
  /** 运动能量曲线（可选，来自 footage 分析；给了则取窗对齐能量峰） */
  energies?: number[];
  /** energies 的采样率（每秒点数，随 energies 提供） */
  sampleFps?: number;
}

export interface EditClip {
  source: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  motionScore: number;
  /** 所在音乐段落 */
  section: SectionLabel;
}

export interface EditDecision {
  clips: EditClip[];
  /** 成片时间轴切点（秒，全部在节拍上） */
  cutPoints: number[];
  totalSec: number;
  /** 决策说明（给用户/LLM 看的一句话） */
  summary: string;
  /** 创意层执行明细（钉镜生效/回退原因等；无指令时为空数组） */
  notes: string[];
}

/** 镜头引用（创意层指令用）：素材标识 + 该素材 shots 数组下标（与 get_footage_map 返回一致） */
export interface ShotRef {
  source: string;
  shot: number;
}

/**
 * LLM 创意指令——叙事/高光语义层。全部可选；不给则行为与纯确定性版完全一致。
 * 钉镜是「强制选择」：该槽位无视 cost 直接用指定镜头（仍须满足 ≥1 拍，否则回退并记 notes）。
 */
export interface MontageDirectives {
  /** 开篇镜：第一个槽位（观众第一眼，定调） */
  openingShot?: ShotRef;
  /** 收尾镜：最后一个槽位（落版/记忆点） */
  closingShot?: ShotRef;
  /** 高光镜：全片第一个 drop 段的第一拍（「高光与卡点联动」的核心钩子） */
  firstDropShot?: ShotRef;
  /** 禁用镜头：从素材池剔除（画面差/黑场/内容重复等，LLM 经 review_render 或用户反馈判定） */
  excludeShots?: ShotRef[];
}

export interface EditBrainOptions {
  /** 目标成片时长（秒；缺省 = 音乐全长） */
  targetSec?: number;
  /** 段落 → 槽位拍数（缺省 drop 1 / build 2 / break 2 / intro 4 / outro 4） */
  slotBeats?: Partial<Record<SectionLabel, number>>;
  /** LLM 创意指令（可选） */
  directives?: MontageDirectives;
}

const DEFAULT_SLOT_BEATS: Record<SectionLabel, number> = {
  intro: 4, build: 2, break: 2, drop: 1, outro: 4,
};

const sectionAt = (sections: MusicSection[], t: number): MusicSection | undefined =>
  sections.find((s) => t >= s.startSec && t < s.endSec) ?? sections[sections.length - 1];

/** 镜头内的能量峰（位置秒 + 峰值；energies 为差分能量曲线，i 对应 (i+1)/fps 时刻）；无数据返回 null */
export const shotEnergyPeak = (
  energies: number[] | undefined,
  fps: number | undefined,
  t0: number,
  t1: number,
): {sec: number; value: number} | null => {
  if (!energies || !fps || fps <= 0) return null;
  const a = Math.max(0, Math.floor(t0 * fps));
  const b = Math.min(energies.length - 1, Math.ceil(t1 * fps));
  if (b <= a) return null;
  let peak = a;
  for (let i = a + 1; i <= b; i++) if (energies[i] > energies[peak]) peak = i;
  return {sec: (peak + 1) / fps, value: energies[peak]};
};

/** 镜头内的能量峰位置（秒）；无数据返回 null */
const peakInRange = (energies: number[] | undefined, fps: number | undefined, t0: number, t1: number): number | null =>
  shotEnergyPeak(energies, fps, t0, t1)?.sec ?? null;

/** 全场「高光镜」：能量峰值最高的镜头（autoMoneyShot 与 get_footage_map 的首 drop 推荐共用） */
export const findMoneyShot = (sources: SourceShots[]): ShotRef | null => {
  let best: ShotRef | null = null;
  let bestV = -1;
  for (const s of sources) {
    s.shots.forEach((shot, i) => {
      const p = shotEnergyPeak(s.energies, s.sampleFps, shot.startSec, shot.endSec);
      if (p && p.value > bestV) {
        bestV = p.value;
        best = {source: s.source, shot: i};
      }
    });
  }
  return best;
};

/**
 * 主入口：音乐结构图 + 各素材镜头表 → 卡点切镜计划。
 * beats 为空或素材池为空时返回空计划（clips: []），由调用方回退手工流程。
 */
export const planBeatMontage = (
  music: MusicMap,
  sources: SourceShots[],
  opts: EditBrainOptions = {},
): EditDecision => {
  const slotBeats = {...DEFAULT_SLOT_BEATS, ...(opts.slotBeats ?? {})};
  const directives = opts.directives ?? {};
  const notes: string[] = [];
  const beats = music.beats.filter((b) => b > 0.01);
  const targetSec = Math.min(opts.targetSec ?? music.durationSec, music.durationSec);
  if (beats.length < 4 || sources.length === 0 || targetSec <= 0) {
    return {clips: [], cutPoints: [], totalSec: 0, summary: '节拍或素材不足，无法自动剪辑', notes};
  }

  const beatSecOf = (i: number): number => (i + 1 < beats.length ? beats[i + 1] - beats[i] : (music.barSec > 0 ? music.barSec / 4 : 0.5));

  // 素材池展开：每镜一条（带源与能量曲线），按运动强度排序候选；禁镜在入池时剔除
  interface Cand {source: string; shotIdx: number; shot: FootageShot; uses: number; energies?: number[]; sampleFps?: number}
  const excluded = new Set((directives.excludeShots ?? []).map((r) => `${r.source}#${r.shot}`));
  const pool: Cand[] = [];
  for (const s of sources) {
    s.shots.forEach((shot, shotIdx) => {
      if (excluded.has(`${s.source}#${shotIdx}`)) return;
      if (shot.endSec - shot.startSec >= beatSecOf(0) * 0.9) {
        pool.push({source: s.source, shotIdx, shot, uses: 0, energies: s.energies, sampleFps: s.sampleFps});
      }
    });
  }
  if (pool.length === 0) {
    return {clips: [], cutPoints: [], totalSec: 0, summary: '没有满足最短时长的镜头', notes};
  }

  // 钉镜解析：找候选（须在池内且满足当拍最短时长）；找不到/太短 → 回退并记 notes，只报一次
  const reported = new Set<string>();
  const resolvePin = (label: string, ref: ShotRef | undefined, beatIdx: number): Cand | null => {
    if (!ref) return null;
    const key = `${label}:${ref.source}#${ref.shot}`;
    const cand = pool.find((c) => c.source === ref.source && c.shotIdx === ref.shot);
    if (!cand) {
      if (!reported.has(key)) {
        reported.add(key);
        notes.push(`钉镜「${label}」无效（${ref.source} 无 #${ref.shot} 镜头或已被禁用），按自动选镜`);
      }
      return null;
    }
    const dur = cand.shot.endSec - cand.shot.startSec;
    if (Math.floor(dur / beatSecOf(beatIdx)) < 1) {
      if (!reported.has(key)) {
        reported.add(key);
        notes.push(`钉镜「${label}」镜头太短（${dur.toFixed(1)}s 不足 1 拍），按自动选镜`);
      }
      return null;
    }
    notes.push(`已钉：${label}=${ref.source}#${ref.shot}`);
    return cand;
  };

  const clips: EditClip[] = [];
  const cutPoints: number[] = [];
  let t = beats[0];
  let beatIdx = 0;
  let prevSource: string | null = null;
  let prevPrevSource: string | null = null;
  let openingApplied = !directives.openingShot;
  let firstDropApplied = !directives.firstDropShot;
  let closingApplied = !directives.closingShot;
  let dropPlaced = false;

  while (t < targetSec - 0.01 && beatIdx < beats.length) {
    const sec = sectionAt(music.sections, t);
    const label: SectionLabel = sec?.label ?? 'build';
    const secEnergy = sec?.energy ?? 0.5;
    // 槽位不跨段：段落边界处强制收刀（drop 的第一拍永远落在剪点上）
    const secEnd = Math.min(sec?.endSec ?? targetSec, targetSec);
    const avail = secEnd - t;
    const beatsAvail = Math.floor((avail + 1e-6) / beatSecOf(beatIdx));
    if (beatsAvail <= 0) {
      t = secEnd;
      continue;
    }
    const nBeats = Math.min(slotBeats[label] ?? 2, beatsAvail);
    const slotSec = Array.from({length: nBeats}, (_, k) => beatSecOf(beatIdx + k)).reduce((a, b) => a + b, 0);

    // 创意层钉镜：开篇（首槽）/ 首 drop 第一拍（高光钩子）/ 收尾（预测末槽）；各只生效一次
    let pinned: Cand | null = null;
    if (!openingApplied && clips.length === 0) {
      pinned = resolvePin('开篇', directives.openingShot, beatIdx);
      openingApplied = true;
    } else if (!firstDropApplied && label === 'drop' && !dropPlaced) {
      pinned = resolvePin('首drop高光', directives.firstDropShot, beatIdx);
      firstDropApplied = true;
    } else if (!closingApplied && t + slotSec >= targetSec - 0.01) {
      pinned = resolvePin('收尾', directives.closingShot, beatIdx);
      closingApplied = true;
    }

    // 选镜：钉镜优先；否则运动强度向段落能量靠拢 + 同素材连出/同镜复用惩罚
    let best: Cand | null = pinned;
    if (!best) {
      // 硬上限：同素材最多连出 2 镜（soft 惩罚压不住能量匹配差距时兜底）；
      // 候选枯竭（如单素材）时回退无上限，保证计划不中断
      const capped = prevSource !== null && prevSource === prevPrevSource;
      for (let pass = 0; pass < 2 && !best; pass++) {
        let bestCost = Infinity;
        for (const c of pool) {
          const dur = c.shot.endSec - c.shot.startSec;
          const beatFloor = Math.floor(dur / beatSecOf(beatIdx));
          if (beatFloor < 1) continue; // 不足 1 拍淘汰
          if (pass === 0 && capped && c.source === prevSource) continue; // 连出上限
          const match = Math.abs(c.shot.motionScore - secEnergy);
          // 惩罚随段落能量缩放：快切段（≥0.7）镜头一闪而过，复用不显眼——轻罚让位能量匹配；
          // 慢段复用显眼——全罚保轮换。同素材连出 0.3（<典型能量差，高能量段以高运动素材为主）、
          // 同镜复用 0.6（配取窗后错避免重复画面）
          const penaltyScale = secEnergy >= 0.7 ? 0.35 : 1;
          const cost = match + (c.source === prevSource ? 0.3 : 0) * penaltyScale + c.uses * 0.6 * penaltyScale;
          if (cost < bestCost) {
            bestCost = cost;
            best = c;
          }
        }
      }
    }
    if (!best) break; // 素材池耗尽（都太短）

    // 取窗：槽长与镜头向下取整到拍，取小者；首用对齐镜头能量峰（峰值落在窗内 40% 处），
    // 复用同一镜头时窗口向后错开（避免重复画面）
    const shotDur = best.shot.endSec - best.shot.startSec;
    const maxWhole = Math.floor(shotDur / beatSecOf(beatIdx)) * beatSecOf(beatIdx);
    const clipSec = Math.max(beatSecOf(beatIdx), Math.min(slotSec, maxWhole, targetSec - t));
    const maxOffset = Math.max(0, shotDur - clipSec);
    const peakT = peakInRange(best.energies, best.sampleFps, best.shot.startSec, best.shot.endSec);
    const offset = best.uses === 0 && peakT !== null
      ? Math.min(Math.max(peakT - 0.4 * clipSec - best.shot.startSec, 0), maxOffset)
      : Math.min(best.uses * slotSec, maxOffset);
    const startSec = best.shot.startSec + offset;
    clips.push({
      source: best.source,
      startSec,
      endSec: startSec + clipSec,
      durationSec: clipSec,
      motionScore: best.shot.motionScore,
      section: label,
    });
    best.uses++;
    prevPrevSource = prevSource;
    prevSource = best.source;
    if (label === 'drop') dropPlaced = true;

    // 推进时间轴到 clip 实际结束对应的拍索引
    t += clipSec;
    cutPoints.push(t);
    while (beatIdx < beats.length && beats[beatIdx] < t - 0.001) beatIdx++;
    // 下一刀从 ≥t 的拍开始；若 t 未压拍（clipSec 非拍整数倍时不会——clipSec 恒为拍整数倍），防死循环
    if (beatIdx >= beats.length) break;
    t = Math.max(t, beats[beatIdx]);
  }

  const totalSec = clips.reduce((a, c) => a + c.durationSec, 0);
  const drops = clips.filter((c) => c.section === 'drop').length;
  const summary = clips.length === 0
    ? '素材池无法覆盖目标时长'
    : `按音乐结构切 ${clips.length} 镜（drop 段 ${drops} 镜一拍一刀），切点全部压拍`;
  return {clips, cutPoints, totalSec, summary, notes};
};
