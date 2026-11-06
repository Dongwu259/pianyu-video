/**
 * ffcheck 报告层（管线路线图 P1-5）——blackdetect/freezedetect 事件解析与设计内排除（纯函数，单测锚定）
 *
 * 三份旧 ffcheck 脚本（v8/v9/vertical）是 25 行复制粘贴、段界内嵌、排除规则只存在于人的
 * 脑子里。本模块把「事件 → 判定」变成吃 manifest 的纯函数：
 *
 * - blackdetect 事件三判：**设计内淡出**（末段尾帧黑场机制，事件结束点落在片尾余量内——
 *   v11 竖版实测 69.83-69.97s 事件即此形态）/ **设计内暗场**（事件全程落在暗底模板段内——
 *   AiPromptCard bgStyle 2 纯黑档、OutroCTA；v11 实测未触发但规则保留给纯黑底档）/
 *   **suspect**（其余=段外/段间异常黑场，按事件起点归属段报告）
 * - freezedetect 事件：无设计内冻结形态，全部 suspect 按起点归属段
 *
 * 阈值口径沿用旧脚本：blackdetect d=0.1 pix_th=0.10；freezedetect n=0.003 d=2。
 */

export interface BlackEvent {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface FreezeEvent {
  startSec: number;
  endSec: number;
  durationSec: number;
}

/** ffmpeg -v info 跑检测的 stderr 全文 → 事件列表（键序容错，black/freeze 两族键名各不相同） */
const parseEvents = <T extends BlackEvent | FreezeEvent>(
  log: string,
  kind: 'black' | 'freeze',
): T[] => {
  const events: T[] = [];
  const re =
    kind === 'black'
      ? /black_start:(?<s>[\d.]+)\s+black_end:(?<e>[\d.]+)\s+black_duration:(?<d>[\d.]+)/g
      : /freeze_start:(?<s>[\d.]+)\s+freeze_duration:(?<d>[\d.]+)\s+freeze_end:(?<e>[\d.]+)/g;
  for (const m of log.matchAll(re)) {
    const g = m.groups as {s: string; e: string; d: string};
    events.push({startSec: Number(g.s), endSec: Number(g.e), durationSec: Number(g.d)} as T);
  }
  return events;
};

export const parseBlackEvents = (log: string): BlackEvent[] => parseEvents(log, 'black');
export const parseFreezeEvents = (log: string): FreezeEvent[] => parseEvents(log, 'freeze');

/** 检查侧的段（lib-promo ManifestSeg 结构兼容：id/templateId/startSec/endSec） */
export interface CheckSegment {
  id: string;
  templateId: string;
  startSec: number;
  endSec: number;
}

export type BlackVerdict = 'design-fade' | 'design-dark' | 'suspect';

export interface ClassifiedBlackEvent extends BlackEvent {
  verdict: BlackVerdict;
  /** 事件起点所在段（design 类也标，人好回看） */
  segId: string | null;
}

/** 末段尾帧黑场的设计余量（getOutroFadeFrames ~1.2s + 编码容差；v11 竖版实测事件距片尾 <0.2s） */
export const TAIL_FADE_MARGIN_SEC = 1.5;
/** 暗底模板（底色即黑，blackdetect 触发不算事故；来源=模板 bgStyle 纯黑档与 CTA 尾） */
export const DARK_TEMPLATES = new Set(['AiPromptCard', 'OutroCTA']);

const segAt = (segs: CheckSegment[], t: number): CheckSegment | null =>
  segs.find((s) => t >= s.startSec && t < s.endSec) ?? null;

export const classifyBlackEvents = (
  events: BlackEvent[],
  segs: CheckSegment[],
  totalSec: number,
): ClassifiedBlackEvent[] =>
  events.map((e) => {
    const seg = segAt(segs, e.startSec);
    let verdict: BlackVerdict = 'suspect';
    if (e.endSec >= totalSec - TAIL_FADE_MARGIN_SEC) {
      verdict = 'design-fade'; // 片尾淡出黑场（OutroCTA/裸输出模板的尾帧机制）
    } else {
      const fullyInDark = segs.some(
        (s) => DARK_TEMPLATES.has(s.templateId) && e.startSec >= s.startSec - 0.05 && e.endSec <= s.endSec + 0.05,
      );
      if (fullyInDark) verdict = 'design-dark';
    }
    return {...e, verdict, segId: seg ? seg.id : null};
  });

export interface ClassifiedFreezeEvent extends FreezeEvent {
  segId: string | null;
}

export const classifyFreezeEvents = (events: FreezeEvent[], segs: CheckSegment[]): ClassifiedFreezeEvent[] =>
  events.map((e) => ({...e, segId: segAt(segs, e.startSec)?.id ?? null}));

// ---- 每段拼条规划（ffmpeg fps=1/step + tile=4xN 的数学）----

export interface SegSheetPlan {
  /** 应抽帧数（段窗内 step 网格，含头不含尾） */
  frames: number;
  cols: number;
  rows: number;
  /** 每格时刻（秒）——图上不写字，stdout 图例用（drawtext 中文字体在系统/裁剪 ffmpeg 间行为不一致） */
  times: number[];
}

export const segSheetPlan = (seg: CheckSegment, stepSec: number, cols = 4): SegSheetPlan => {
  const span = seg.endSec - seg.startSec;
  const frames = Math.max(1, Math.ceil(span / stepSec - 1e-9));
  const rows = Math.ceil(frames / cols);
  const times: number[] = [];
  for (let i = 0; i < frames; i++) times.push(seg.startSec + i * stepSec);
  return {frames, cols, rows, times};
};
