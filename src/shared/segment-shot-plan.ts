/**
 * 段内多镜切分计划（P1-5B，纯函数，模板/单测共用；诊断见 docs/real-footage-genre-diagnosis.md）。
 *
 * Fullbleed 族 / VideoCut 的「多素材段内硬切」共用大脑：把段时长切成镜头序列，
 * 轮转消耗各素材的可用窗口——
 * - 素材带 scan_media 镜头清单（shotList）时优先按素材自身镜头边界取窗：
 *   切点落在场景检测认定的内容切换处，而不是任意秒数处（镜头边界即「motionScore 切点」
 *   的落地形态——比固定节奏更像人剪的）；
 * - 无镜头清单时按固定 shotSec 节奏轮切（与 montage-plan 同思路，但本族硬切、零冲击动效）；
 * - 素材窗口耗尽从头循环；确定性：同输入同计划。
 *
 * 与 montage-plan 的分工：Montage 是「广告感」快切（变焦冲击/甩切/强制静音），
 * 本规划器是「真实感」直剪（硬切、保留素材原声）——vlog/真实素材体裁的剪辑动词。
 */

export interface SegmentShot {
  /** 素材下标（videos 数组过滤 video/image 后的下标） */
  videoIndex: number;
  /** 该素材可用窗口内的起点（相对 trimStart 的秒数；图片无意义忽略） */
  mediaStart: number;
  /** 本镜时长（秒；最后一镜可短于窗口） */
  durationSec: number;
}

export interface SegmentShotPlanClip {
  /** 可用时长（秒，= trimStart→clipEnd 的有效窗口时长；图片传大数即可） */
  durationSec: number;
  /** 可选：scan_media 产出的素材镜头清单（媒体绝对秒）；给出且与窗口有交集时按镜头边界取窗 */
  shots?: Array<{startSec: number; endSec: number; motionScore?: number}>;
  /** 素材窗口起点（媒体绝对秒 = trimStart），镜头清单与窗口对齐用 */
  windowStartSec?: number;
  /** 素材窗口终点（媒体绝对秒 = clipEnd）；缺省 = windowStartSec + durationSec */
  windowEndSec?: number;
}

/** 单镜头窗口的最短时长（秒）：低于此的场景切片直接跳过（场景检测本身 ≥0.8s，此处兜底） */
const MIN_WINDOW_SEC = 0.5;
/** 计划发射的镜头最短时长：剩余预算不足此时长即收尾（防末镜闪帧） */
const MIN_SHOT_SEC = 0.15;

/** 把一个素材的可用窗口拆成候选镜头窗口：优先素材镜头清单，缺省固定节奏 */
const buildWindows = (
  clip: SegmentShotPlanClip,
  shotSec: number,
): Array<{start: number; dur: number}> => {
  if (clip.shots && clip.shots.length > 0 && typeof clip.windowStartSec === 'number') {
    const ws = clip.windowStartSec;
    const we =
      typeof clip.windowEndSec === 'number' && Number.isFinite(clip.windowEndSec)
        ? clip.windowEndSec
        : ws + clip.durationSec;
    const out: Array<{start: number; dur: number}> = [];
    for (const s of clip.shots) {
      const a = Math.max(s.startSec, ws);
      const b = Math.min(s.endSec, we);
      if (b - a >= MIN_WINDOW_SEC) out.push({start: a - ws, dur: b - a});
    }
    if (out.length > 0) return out;
    // 镜头清单与窗口无交集（如 trim 区间落在两镜之间）→ 退固定节奏
  }
  const dur = Number.isFinite(clip.durationSec) && clip.durationSec > 0 ? clip.durationSec : 0;
  const out: Array<{start: number; dur: number}> = [];
  for (let t = 0; t < dur - 0.05; t += shotSec) {
    out.push({start: t, dur: Math.min(shotSec, dur - t)});
  }
  return out;
};

/**
 * 生成段内多镜切分计划。素材间轮转（一镜一素材轮着来，多素材时不连用同源）；
 * 窗口部分消耗时保留余量下轮继续；全部素材耗尽后各自从头循环。
 * 返回空数组 = 无可用素材或参数非法（调用方应退回单素材旧路径）。
 */
export const planSegmentShots = (args: {
  clips: SegmentShotPlanClip[];
  /** 段总时长（秒） */
  totalSec: number;
  /** 固定节奏的目标镜头时长（秒，0.8-6） */
  shotSec: number;
}): SegmentShot[] => {
  const {clips, totalSec, shotSec} = args;
  if (!(totalSec > 0.2) || !(shotSec > 0.2) || !Array.isArray(clips)) return [];

  // 每素材的候选窗口队列（复制，发射过程会推进指针/拆余量，不碰调用方输入）
  const queues = clips.map((c) => buildWindows(c, shotSec).filter((w) => w.dur >= MIN_WINDOW_SEC));
  const usableIdx = queues.map((q, i) => (q.length > 0 ? i : -1)).filter((i) => i >= 0);
  if (usableIdx.length === 0) return [];

  const ptr = queues.map(() => 0);
  const out: SegmentShot[] = [];
  let t = 0;
  let k = 0;
  while (t < totalSec - 0.05) {
    const vi = usableIdx[k % usableIdx.length];
    const q = queues[vi];
    const w = q[ptr[vi]];
    const dur = Math.min(w.dur, totalSec - t);
    if (dur < MIN_SHOT_SEC) break;
    out.push({videoIndex: vi, mediaStart: w.start, durationSec: dur});
    if (dur >= w.dur - 0.05) {
      // 窗口整段消耗：推进到下一窗口（到尾循环回 0）
      ptr[vi] = (ptr[vi] + 1) % q.length;
    } else {
      // 部分消耗（段预算先尽）：余量留在原位
      q[ptr[vi]] = {start: w.start + dur, dur: w.dur - dur};
    }
    t += dur;
    k += 1;
    if (k > 2000) break; // 防御：异常输入不挂死
  }
  return out;
};

/** 在已生成的镜头序列里定位 timeline 秒 t 所在的镜（越界取末镜；空序列返回 null） */
export const shotAt = (shots: SegmentShot[], tSec: number): SegmentShot | null => {
  if (shots.length === 0) return null;
  let t = 0;
  for (let i = 0; i < shots.length; i++) {
    if (tSec < t + shots[i].durationSec || i === shots.length - 1) return shots[i];
    t += shots[i].durationSec;
  }
  return shots[shots.length - 1];
};
