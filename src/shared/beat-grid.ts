/**
 * beatGrid 契约（B2 模板感知节拍，研究档 RESEARCH-TRANSITIONS.md §三/B2）
 *
 * 合成器把 BGM 节拍网格按段窗口切片，经模板 props 的可选字段 beatGrid 下发；
 * 模板自愿消费（逐词踩拍/逐拍生长/入场落拍），不消费零影响——与 trailingForExit
 * 同一模式：无 BGM / BGM 未检出 beats 时 beatGrid 为 undefined，模板走原有时间模型。
 *
 * 时间口径：beatsSec 相对「模板时间轴起点」= 段内容起点 − startOffsetSec
 * （模板被负 from 的 Sequence 整体后移 startOffsetSec，其 useCurrentFrame 原点随之提前；
 * 常规 startOffsetSec=0 时即段内相对秒）。因此 startOffsetSec>0 时 beatsSec 可超出
 * [0, duration] ——落在段内容窗口外的拍点由消费方自行忽略（distributeOnBeats 已钳位）。
 *
 * 工程持久化只有 beats/bpm（BgmTrack），逐拍能量（B1 的 kick/snare）渲染期不可得，
 * 故契约只带 beatsSec + bpm；重拍按「每 4 拍」（4/4 拍下拍）从拍点序号推导。
 *
 * 纯函数，无运行时依赖，Node 可直跑单测（tests/unit/beat-grid.test.ts）。
 */

/** 模板可消费的段内节拍网格 */
export interface BeatGrid {
  /** 拍点时间（秒，升序，相对模板时间轴起点；仅段窗口 ±startOffsetSec 内的拍点） */
  beatsSec: number[];
  /** BGM 速度（拍/分钟；0 = 未知，消费方不得依赖） */
  bpm: number;
}

/**
 * 把全片 BGM 拍点网格切成某段的 beatGrid。
 * 窗口 [segStartSec, segStartSec + segDurationSec)：起点界上的拍点归本段（相对 0），
 * 终点界上的拍点归下一段。窗口内无拍点 / 无 beats → undefined（模板零影响路径）。
 */
export const sliceBeatGrid = (
  beatsSec: readonly number[] | null | undefined,
  bpm: number | null | undefined,
  segStartSec: number,
  segDurationSec: number,
): BeatGrid | undefined => {
  if (!beatsSec || beatsSec.length === 0) return undefined;
  if (!(segDurationSec > 0)) return undefined;
  const EPS = 1e-6;
  const end = segStartSec + segDurationSec;
  const inWin: number[] = [];
  for (const t of beatsSec) {
    if (t >= segStartSec - EPS && t < end - EPS) {
      // ms 精度规整：吸收 beats 与段起点（帧/FPS）各自的浮点尾差
      inWin.push(Math.round((t - segStartSec) * 1000) / 1000);
    }
  }
  if (inWin.length === 0) return undefined;
  return {beatsSec: inWin, bpm: typeof bpm === 'number' && bpm > 0 ? bpm : 0};
};

/** 拍距（秒）：拍点足够时取相邻间隔中位数，否则由 bpm 换算；都不可得返回 null */
export const beatGapSec = (beatsSec: readonly number[], bpm?: number): number | null => {
  if (beatsSec.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < beatsSec.length; i++) {
      const g = beatsSec[i] - beatsSec[i - 1];
      if (g > 0.1 && g < 3) gaps.push(g); // 忽略静音/间奏造成的异常间隔
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)];
    }
  }
  if (bpm && bpm > 0) return 60 / bpm;
  return null;
};

/**
 * M3 L2 节拍层：手放节拍标记与 BGM 拍点网格并流（合成器每段调用一次）。
 * 语义（v1.4）：用户/agent 标记是**补充**不是替换——与 BGM 拍点合并排序、同值（±5ms）去重；
 * 无 BGM 网格时手放标记独立成网格（bpm=0，消费方不得依赖）。段窗外（t<0 或 ≥durationSec）
 * 的标记忽略。手放标记为空 → 原网格原样返回（未手放段零漂移）。
 */
export const mergeUserBeats = (
  grid: BeatGrid | undefined,
  userBeats: readonly {t: number}[] | undefined,
  durationSec: number,
): BeatGrid | undefined => {
  if (!userBeats || userBeats.length === 0) return grid;
  const inSeg = userBeats
    .map((b) => Math.round(b.t * 1000) / 1000)
    .filter((t) => t >= 0 && t < durationSec);
  if (inSeg.length === 0) return grid;
  const merged = [...(grid?.beatsSec ?? []), ...inSeg]
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.005);
  return {beatsSec: merged, bpm: grid?.bpm ?? 0};
};

export interface SnapToBeatOptions {
  /** 最大平移（秒，缺省 0.25）：最近拍点距 frame 超过此不吸附（宁可漂移不抢拍） */
  maxShiftSec?: number;
  /** nearest = 双向取最近（缺省）；next = 只取不早于 frame 的拍点 */
  direction?: 'nearest' | 'next';
}

/**
 * 把帧吸附到最近拍点帧（入场「到位帧」落拍：在拍上落定而非漂移在拍间）。
 * 窗口内无可用拍点 / 无 beats 时原样返回（零影响路径）。
 */
export const snapFrameToBeat = (
  frame: number,
  fps: number,
  beatsSec: readonly number[],
  opts?: SnapToBeatOptions,
): number => {
  if (!beatsSec || beatsSec.length === 0) return frame;
  const maxShiftSec = opts?.maxShiftSec ?? 0.25;
  const direction = opts?.direction ?? 'nearest';
  const t = frame / fps;
  const EPS = 1e-6;
  let best: number | null = null;
  for (const b of beatsSec) {
    if (direction === 'next' && b < t - EPS) continue;
    const d = Math.abs(b - t);
    if (d > maxShiftSec + EPS) continue;
    if (best === null || d < Math.abs(best - t)) best = b;
  }
  return best === null ? frame : Math.round(best * fps);
};

export interface BeatDistribution {
  /** 各元素的出现/到位帧（段内模板时间轴，单调不减，钳在 [0, totalFrames-1]） */
  frames: number[];
  /** 是否重拍元素（对齐到段内第 4k+1 拍 = 4/4 拍下拍；消费方可放大/加重） */
  accented: boolean[];
}

/**
 * 把 count 个元素的出现时刻对齐段内拍点序列（KineticType 逐行、数据 3D 逐拍生长共用）。
 *
 * 分档：
 * - count ≤ 拍点数：一拍一个，取前 count 拍；accented = 拍点序号 % 4 === 0（下拍）。
 * - 拍点不够：先细分出半拍网格（相邻拍中点，首尾按拍距外推），一拍变半拍一个；
 *   落在整拍上的元素保留重拍标记。
 * - 半拍仍不够：退化为段内均匀分配（尾部留 20% 余量，不出段尾溢出），无重拍。
 *
 * beatsSec 空数组 → 直接均匀分配（调用方保证 beatGrid 存在时才进来，这里兜底）。
 */
export const distributeOnBeats = (
  count: number,
  beatsSec: readonly number[],
  durationSec: number,
  fps: number,
): BeatDistribution => {
  const totalFrames = Math.max(1, Math.round(durationSec * fps));
  const clampFrame = (f: number): number => Math.min(totalFrames - 1, Math.max(0, Math.round(f)));

  // 均匀分配兜底：尾部留 20%（至多 1s）余量，保证末元素落定/生长不出段尾
  const even = (): BeatDistribution => {
    const tail = Math.max(1, Math.min(fps, totalFrames * 0.2));
    const usable = Math.max(1, totalFrames - tail);
    const frames = Array.from({length: count}, (_, i) => clampFrame((i * usable) / count));
    return {frames, accented: frames.map(() => false)};
  };

  if (count <= 0) return {frames: [], accented: []};
  const beatFrames = beatsSec.filter((b) => b >= 0).map((b) => b * fps);
  if (beatFrames.length === 0) return even();

  // 一拍一个（拍点充足）
  if (count <= beatFrames.length) {
    const frames = beatFrames.slice(0, count).map(clampFrame);
    return {frames, accented: frames.map((_, i) => i % 4 === 0)};
  }

  // 半拍细分：相邻拍中点 + 首尾按拍距外推（不早于 0、不晚于段尾）
  const gap = beatGapSec(beatsSec) ?? 0.5;
  const half: Array<{f: number; beatIdx: number}> = beatFrames.map((f, i) => ({f, beatIdx: i}));
  for (let i = 1; i < beatFrames.length; i++) {
    half.push({f: (beatFrames[i - 1] + beatFrames[i]) / 2, beatIdx: -1});
  }
  const firstHalf = beatFrames[0] - (gap * fps) / 2;
  if (firstHalf >= 0) half.push({f: firstHalf, beatIdx: -1});
  const lastHalf = beatFrames[beatFrames.length - 1] + (gap * fps) / 2;
  if (lastHalf < totalFrames) half.push({f: lastHalf, beatIdx: -1});
  half.sort((a, b) => a.f - b.f);

  if (count <= half.length) {
    const picked = half.slice(0, count);
    return {
      frames: picked.map((p) => clampFrame(p.f)),
      accented: picked.map((p) => p.beatIdx >= 0 && p.beatIdx % 4 === 0),
    };
  }

  return even();
};
