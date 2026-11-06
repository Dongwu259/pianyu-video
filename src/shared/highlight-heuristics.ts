/**
 * 高光候选启发式排序（纯函数，零模型 token）
 *
 * mine_highlights 的预筛层：对场景检测切出的 shot 打多维分，输出 top-N 候选
 * （模型看图选美只看这 N 个，未配 AI 时启发式结果直接可用）。
 *
 * 信号（人脸检测拍板不补：ffmpeg 标准构建无开箱人脸滤镜，换 GPL full/引 OpenCV
 * 都是重依赖，而候选+用户确认面板已兜底；「人物概率」是零成本弱信号——纯数学
 * 肤色统计，标注不冒充人脸）：
 * - 运动强度（footage 差分中位数归一）权重 0.35：观众注意力跟运动走
 * - 音轨能量（8kHz 峰值桶映射到 shot 区间）权重 0.25：说话/音效/动作的高光载体
 * - 曝光质量（shot 代表帧直方图分位）权重 0.15：中间调均衡加分，死黑/死白减分
 * - 人物概率（肤色占比 + 中心构图）权重 0.15：人物特写/出镜段的高光倾向
 * - 时长适配权重 0.10：3-15s 是叙事舒适窗（挖掘产物要能直接进时间线）
 */

/**
 * 镜头结构类型（与 main/services/footage 的 FootageShot 结构兼容；
 * 本模块进渲染端 bundle，不反向 import 主进程模块）
 */
export interface ShotLike {
  startSec: number;
  endSec: number;
  motionScore: number;
}

export interface ShotLumaStats {
  /** 代表帧灰度直方图分位（0-255） */
  p5: number;
  p50: number;
  p95: number;
  /** 肤色像素占比 0-1（YCbCr 肤色区间；缺省按无人物处理不惩罚） */
  skinRatio?: number;
  /** 中央区域（画面 50%）的肤色占比 0-1（中心聚集 = 人物主体居中构图） */
  centerSkinRatio?: number;
}

export interface HeuristicInput {
  shots: ShotLike[];
  /** 音频峰值桶（analyzeAudio 的 peaks，240 桶覆盖全片；缺省全 0） */
  audioPeaks?: number[];
  /** 每镜头代表帧直方图分位（与 shots 同长；缺省按中间调计） */
  shotLuma?: ShotLumaStats[];
  /** 目标成片时长（秒，时长适配项参照） */
  targetSec?: number;
}

export interface HighlightCandidate {
  startSec: number;
  endSec: number;
  /** 综合分 0-1 */
  score: number;
  /** 分项分（0-1）与文本理由（面板/模型提示词共用） */
  motion: number;
  audio: number;
  exposure: number;
  /** 人物概率 0-1（肤色占比+中心构图的纯数学弱信号，非人脸检测） */
  person: number;
  durationFit: number;
  reasons: string[];
}

/** 精选面板数据（mine_highlights 预筛产物；渲染端 store 会话态，不持久化） */
export interface HighlightCandidatesData {
  mediaName: string;
  durationSec: number;
  candidates: HighlightCandidate[];
  /** 与 candidates 同序的中点帧缩略图 dataUrl */
  thumbnails: string[];
  /** 看图精选是否参与（模型调用成功后回写） */
  usedAi: boolean;
}

/** 音频桶峰值能量映射到 [t0, t1) 区间的均值（peaks 按全片时长均匀分桶） */
export const audioEnergyIn = (peaks: number[] | undefined, t0: number, t1: number, durationSec: number): number => {
  if (!peaks || peaks.length === 0 || durationSec <= 0) return 0;
  const i0 = Math.max(0, Math.floor((t0 / durationSec) * peaks.length));
  const i1 = Math.min(peaks.length - 1, Math.ceil((t1 / durationSec) * peaks.length) - 1);
  if (i1 < i0) return peaks[i0] ?? 0;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += peaks[i];
  return sum / (i1 - i0 + 1);
};

/** 曝光分：中间调均衡最高，死黑（p95 低）/死白（p5 高）衰减 */
export const exposureScoreOf = (l: ShotLumaStats | undefined): number => {
  if (!l) return 0.6; // 无直方图按中性给分（不惩罚）
  let s = 1;
  // 中灰偏移：p50 离 128 太远减分（每偏 60 减 0.3）
  s -= Math.min(0.6, Math.abs(l.p50 - 128) / 200);
  // 死黑：95 分位仍 <60 说明几乎全画面欠曝
  if (l.p95 < 60) s -= 0.4;
  // 死白：5 分位已 >210 说明高光大面积截断
  if (l.p5 > 210) s -= 0.4;
  // 反差过低（灰片）：p95-p5 < 40 判为平淡
  if (l.p95 - l.p5 < 40) s -= 0.25;
  return Math.max(0, Math.min(1, s));
};

/**
 * 人物概率（弱信号，非人脸检测）：肤色占比 + 中心构图加权。
 * 人物特写肤色占比典型 10-40%、中景 3-15%、空镜 ~0——12% 肤色即满概率；
 * 中央 50% 区域的肤色聚集（人物主体居中）再补三成权重。
 * 无肤色统计（旧调用方/采集失败）返回 0（不惩罚也不加分）。
 */
export const personLikelihoodOf = (l: ShotLumaStats | undefined): number => {
  if (!l || l.skinRatio === undefined) return 0;
  const skin = Math.max(0, Math.min(1, l.skinRatio / 0.12));
  const center = l.centerSkinRatio === undefined ? skin : Math.max(0, Math.min(1, l.centerSkinRatio / 0.20));
  return Math.round(Math.min(1, skin * 0.7 + center * 0.3) * 100) / 100;
};

/** 时长适配分：3-15s 舒适窗满分，向两侧线性衰减（<1s 或 >30s 归零） */
export const durationFitOf = (dur: number): number => {
  if (dur >= 3 && dur <= 15) return 1;
  if (dur < 1 || dur > 30) return 0;
  if (dur < 3) return (dur - 1) / 2;
  return Math.max(0, 1 - (dur - 15) / 15);
};

const W_MOTION = 0.35;
const W_AUDIO = 0.25;
const W_EXPOSURE = 0.15;
const W_PERSON = 0.15;
const W_DUR = 0.1;

/**
 * 启发式排序：shots → 加权打分 → top-N 候选（按分数降序）。
 * 相邻高能镜头自动合并（间隙 <0.8s 且双双重叠窗口能量高时并成一个更完整的候选）。
 */
export const rankHighlightCandidates = (input: HeuristicInput, topN = 8): HighlightCandidate[] => {
  const {shots, audioPeaks, shotLuma, targetSec} = input;
  if (!shots || shots.length === 0) return [];
  const durationSec = shots[shots.length - 1]?.endSec ?? 0;
  // 音频能量全片归一（p90），缺音轨时全部 0 不参与区分
  const peakSorted = [...(audioPeaks ?? [])].sort((a, b) => a - b);
  const audioNorm = peakSorted.length > 0 ? (peakSorted[Math.floor(peakSorted.length * 0.9)] || 1e-6) : 0;

  const scored = shots.map((s, i) => {
    const dur = s.endSec - s.startSec;
    const rawAudio = audioNorm > 0 ? Math.min(1, audioEnergyIn(audioPeaks, s.startSec, s.endSec, durationSec) / audioNorm) : 0;
    const motion = Math.max(0, Math.min(1, s.motionScore));
    const exposure = exposureScoreOf(shotLuma?.[i]);
    const person = personLikelihoodOf(shotLuma?.[i]);
    const durationFit = durationFitOf(dur);
    const score = W_MOTION * motion + W_AUDIO * rawAudio + W_EXPOSURE * exposure + W_PERSON * person + W_DUR * durationFit;
    return {shot: s, i, motion, audio: rawAudio, exposure, person, durationFit, score};
  });

  // 相邻合并：分数都过基线（≥0.45）且间隙 <0.8s → 合并成跨镜头候选（完整叙事单元）
  const BASE = 0.45;
  const merged: typeof scored = [];
  for (const item of scored) {
    const last = merged[merged.length - 1];
    if (last && item.score >= BASE && last.score >= BASE &&
        item.shot.startSec - last.shot.endSec < 0.8 &&
        // 合并后总长仍 ≤ targetSec（挖掘产物要装得进成片）
        (!targetSec || item.shot.endSec - last.shot.startSec <= targetSec * 1.5)) {
      last.shot = {startSec: last.shot.startSec, endSec: item.shot.endSec,
        motionScore: Math.max(last.shot.motionScore, item.shot.motionScore)};
      last.audio = Math.max(last.audio, item.audio);
      last.exposure = (last.exposure + item.exposure) / 2;
      last.person = Math.max(last.person, item.person);
      last.durationFit = durationFitOf(item.shot.endSec - last.shot.startSec);
      last.score = W_MOTION * last.shot.motionScore + W_AUDIO * last.audio + W_EXPOSURE * last.exposure + W_PERSON * last.person + W_DUR * last.durationFit;
    } else {
      merged.push({...item});
    }
  }

  // 宁缺毋滥：低于绝对下限的低分镜头不进 top-N 凑数（与挖矿挑选原则一致）；
  // 全军覆没时保底留 top-1（面板至少有一点东西可看/可否决）
  const MIN_SCORE = 0.32;
  const ranked = merged.sort((a, b) => b.score - a.score);
  const qualified = ranked.filter((m) => m.score >= MIN_SCORE).slice(0, Math.max(1, topN));
  const final = qualified.length > 0 ? qualified : ranked.slice(0, 1);
  return final
    .map((m) => {
      const reasons: string[] = [];
      if (m.motion >= 0.5) reasons.push(`运动强（${m.motion.toFixed(2)}）`);
      if (m.audio >= 0.5) reasons.push(`音轨活跃（${m.audio.toFixed(2)}）`);
      if (m.person >= 0.5) reasons.push(`疑似人物画面（人物概率 ${m.person.toFixed(2)}）`);
      if (m.exposure >= 0.7) reasons.push('曝光均衡');
      else if (m.exposure < 0.4) reasons.push('曝光欠佳（偏暗/过曝/平淡）');
      const dur = m.shot.endSec - m.shot.startSec;
      reasons.push(dur >= 3 && dur <= 15 ? `${dur.toFixed(1)}s 叙事舒适窗` : `${dur.toFixed(1)}s`);
      return {
        startSec: Math.round(m.shot.startSec * 100) / 100,
        endSec: Math.round(m.shot.endSec * 100) / 100,
        score: Math.round(m.score * 100) / 100,
        motion: Math.round(m.motion * 100) / 100,
        audio: Math.round(m.audio * 100) / 100,
        exposure: Math.round(m.exposure * 100) / 100,
        person: Math.round(m.person * 100) / 100,
        durationFit: Math.round(m.durationFit * 100) / 100,
        reasons,
      };
    });
};
