/**
 * 蒙太奇卡点切分计划（1.6 M3，纯函数，模板/单测共用）。
 *
 * 把段时长切成等长 cut 序列，轮转消耗各素材的可用区间（trimStart→trimEnd）——
 * 第二轮参照研究结论：蒙太奇派平均镜头 1.9-2.4s（gucci 2.2 / vision 1.9 / gopro 1.9），
 * 默认 cutSec 1.8 落在黄金档。素材耗尽后从头循环；只有 1 个素材时轮播其自身区间。
 * 确定性：同输入同计划。
 */

export interface MontageCut {
  /** 素材下标（videos 数组） */
  videoIndex: number;
  /** 该素材内的起点（相对 trimStart 的秒数） */
  mediaStart: number;
  /** 本切时长（秒；最后一切可短于 cutSec） */
  durationSec: number;
  /** 本切结束时是否甩切进下一切 */
  whip: boolean;
}

export const planMontageCuts = (args: {
  /** 每个素材的可用时长（秒，= trimmedDuration） */
  durations: number[];
  /** 段总时长（秒） */
  totalSec: number;
  /** 每切时长（秒，0.8-4） */
  cutSec: number;
  /** 每 N 切一次甩切（0 = 关） */
  whipEvery: number;
}): MontageCut[] => {
  const {durations, totalSec, cutSec, whipEvery} = args;
  const valid = durations.map((d) => (Number.isFinite(d) && d > 0.2 ? d : 0));
  const n = valid.filter((d) => d > 0).length;
  if (n === 0 || !(totalSec > 0) || !(cutSec > 0)) return [];

  const out: MontageCut[] = [];
  const consumed = valid.map(() => 0);
  let t = 0;
  let k = 0;
  // 视频下标只在实际可用的素材间轮转
  const usableIdx = valid.map((d, i) => (d > 0 ? i : -1)).filter((i) => i >= 0);
  while (t < totalSec - 0.05) {
    const dur = Math.min(cutSec, totalSec - t);
    const vi = usableIdx[k % usableIdx.length];
    // 素材剩余不足 0.3s 则从头循环
    let start = consumed[vi];
    if (valid[vi] - start < 0.3) start = 0;
    const realDur = Math.min(dur, valid[vi] - start);
    out.push({
      videoIndex: vi,
      mediaStart: start,
      durationSec: realDur,
      whip: whipEvery >= 1 && (k + 1) % Math.round(whipEvery) === 0 && t + dur < totalSec - 0.05,
    });
    consumed[vi] = start + realDur;
    t += dur;
    k += 1;
    if (k > 1000) break; // 防御：异常输入不挂死
  }
  return out;
};
