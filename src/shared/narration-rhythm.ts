/**
 * 旁白驱动的节奏规划（卡点自动化第二步：旁白 manifest 词表 → 段长）
 *
 * 此前闭环是「手排段长 → 渲前断言拦装不下」（mixNarration 双向断言）。本模块把「装得下」
 * 提前到规划：按旁白实测/估测时长给段长下限（句长+0.4s 尾余量，与断言同口径），只向上
 * 拉长、不压缩内容，再向上吸附到 BGM 节拍格。输出全在格上 ⇒ 后续 snapDurationsToBeats
 * 对这些段零移动（边界全在格上），压拍断言照旧——旁白重建段长，BGM 卡点语义不变。
 *
 * 时长来源：mp3 在盘=实测（ffprobe 由装配侧注入）；缺席（TTS 403 波）=字数估测——
 * v11 全 13 句实测最小二乘标定 dur = 0.660 + 0.1808×字数（残差均值 0.15s/最大 0.40s，
 * XiaoxiaoNeural rate=+8%）。估测是暂座：mp3 生成到位那天重跑同一条装配命令即换实测。
 *
 * 口径：一行一段（v11 起惯例；同段多句按 Σ句长+逐句余量 给下限并告警——现混音器把同段
 * 多句叠在同一起点，装配侧仍须一行一段）。
 * 纪律：板文件保持编辑最小意图（内容下限），旁白下限是装配期约束——本模块不改板，
 * 只在 runPromoAssembly 以 max(板长, 旁白下限) 生效（板级 opt-in rhythmFromNarration，
 * 冻结板 v11/v12 不开）。
 */

import type {NarLine} from './promo-storyboard.ts';

export interface RhythmLineTiming {
  file: string;
  seg: number;
  durSec: number;
  /** true=mp3 实测；false=字数估测（TTS 到位后重跑装配即换实测） */
  measured: boolean;
}

export interface RhythmRaised {
  seg: number;
  from: number;
  to: number;
  /** 拉长原因（哪句旁白、实测还是估测） */
  reason: string;
}

export interface RhythmPlan {
  /** 规划后段长（全在节拍格上；交 snapAndAssert 前直接写回 segment.duration） */
  durations: number[];
  raised: RhythmRaised[];
  /** 用了估测的行——渲染日志提示 TTS 到位后重跑 */
  estimated: RhythmLineTiming[];
  /** 规划期告警（同段多句等）；装配侧负责打日志 */
  warnings: string[];
}

/** 最小节拍 ≥ d（向上吸附；与 narration-manifest.suggestMinSegmentSec 同格口径，不带余量） */
export const upSnapSec = (d: number, beats: number[]): number => {
  const hit = beats.filter((b) => b >= d - 1e-9).sort((a, b) => a - b)[0];
  return hit !== undefined ? Math.round(hit * 100) / 100 : Math.round((d + 0.1) * 100) / 100;
};

/** 字数估测（v11 13 句 TTS 实测 lsq 标定，见文件头） */
export const estimateNarrationSec = (text: string): number => {
  const chars = [...text.trim()].length;
  return Math.max(1.2, 0.66 + 0.1808 * chars);
};

export const planNarrationRhythm = (opts: {
  boardDurations: number[];
  timing: RhythmLineTiming[];
  beats: number[];
  tailMargin?: number;
}): RhythmPlan => {
  const margin = opts.tailMargin ?? 0.4;
  const bySeg = new Map<number, RhythmLineTiming[]>();
  for (const t of opts.timing) {
    const list = bySeg.get(t.seg) ?? [];
    list.push(t);
    bySeg.set(t.seg, list);
  }
  const raised: RhythmRaised[] = [];
  const estimated = opts.timing.filter((t) => !t.measured);
  const warnings: string[] = [];
  const durations = opts.boardDurations.map((boardDur, i) => {
    const lines = bySeg.get(i);
    if (!lines || lines.length === 0) return boardDur;
    if (lines.length > 1) {
      warnings.push(`第 ${i} 段有 ${lines.length} 句旁白——按 Σ句长+逐句余量给下限，但现混音器同段多句叠在同一起点，装配须一行一段`);
    }
    const need = lines.reduce((s, t) => s + t.durSec, 0) + margin * lines.length;
    const to = upSnapSec(Math.max(boardDur, need), opts.beats);
    if (to > boardDur + 1e-9) {
      raised.push({
        seg: i,
        from: boardDur,
        to,
        reason: lines.map((t) => `${t.file} ${t.durSec.toFixed(2)}s${t.measured ? '' : '（估）'}`).join(' + '),
      });
    }
    return to;
  });
  return {durations, raised, estimated, warnings};
};
