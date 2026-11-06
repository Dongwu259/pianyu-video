/**
 * 遮挡物转场几何（纯函数，无运行时依赖，Node 可直跑单测）——RESEARCH-TRANSITIONS.md 二期 T2。
 *
 * 转场窗口内由合成器（MultiSegmentPromo）渲染一个不属于任何模板的过场元素（品牌色卡片/
 * 几何形，挂载先例 = flash 白覆盖层），盖住画面的瞬间完成前后段切换：
 * - cardSweep：品牌色圆角卡片从一侧扫入，驻留 [0.45,0.55] 完全覆盖画面（切换时刻），
 *   再从另一侧扫出；扫出时后段已在卡后就位。
 * - shapeBloom：圆形从焦点（focusX/focusY，缺省自动焦点 = 下一段视频画框中心）绽放，
 *   q 前半放大盖满全屏，q 后半收拢回焦点——收拢过程中后段显露。
 *
 * 前后段可见性由「覆盖锁存」驱动（transition-style 两条路径都调 occluderSwitched）：
 * 遮挡物首次盖满画面的瞬间切换（入段就位、出段隐藏），之后扫出/收拢阶段不再切回——
 * 扫出时显露的是已在底层就位的入段，出段全程不再出现，零穿帮。
 * 与 virtualCameraStyle 同语义：progress 参数是「已缓动进度」（无曲线路径传原始 q，
 * mechanicalStyle 曲线路径传曲线输出 p），本模块不再施加缓动；几何通道内部钳制到 [0,1]，
 * 曲线越界点（bounce/anticipate）表现为遮挡物过冲/回退，正是回弹观感。
 */

import {easeInCubic, easeOutCubic} from './easings.ts';
import {evalEasingCurve, type EasingCurve} from './easing-curve.ts';

/** 走遮挡物系统的转场类型 */
export type OccluderTransition = 'cardSweep' | 'shapeBloom';

export const isOccluderTransition = (t: string): t is OccluderTransition =>
  t === 'cardSweep' || t === 'shapeBloom';

export interface OccluderOpts {
  /** shapeBloom 绽放/收拢的圆心（归一化 0-1，缺省画面中心；合成器侧已 resolveFocus） */
  focus?: {x: number; y: number};
  /** cardSweep 扫入运动朝向：1上 2下 3左 4右；缺省 3（卡从右侧扫入、向左扫出，与 slide 同口径） */
  direction?: number;
}

/** 遮挡物进度求值：与 transitionStyle 同政策——设置 curve（≥2 点）时用曲线缓动 q，否则原样 */
export const evalOccluderProgress = (q: number, curve?: EasingCurve): number =>
  curve && curve.points && curve.points.length >= 2 ? evalEasingCurve(curve, q) : q;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 负零归一：-0 === 0 但 Object.is(-0, 0) = false（严格相等断言会踩坑），输出分量一律过它 */
const nz = (v: number): number => (v === 0 ? 0 : v);

// ====== cardSweep 卡片扫场 ======

/** 卡片宽/高 = 屏宽/高的倍数（正方形卡：1.4 在旋转 6° 后横竖画幅都留覆盖余量） */
export const OCCLUDER_CARD_FRAC = 1.4;
/** 卡片半行程（屏分数）：端点 |c|=1.35 > 0.5+卡有效半径 0.77（带旋转）→ 端点完全离屏（无形） */
export const OCCLUDER_CARD_TRAVEL = 1.35;
/** 扫动中的倾斜角峰值（度）：端点 ±6°、盖满驻留时归零（轻微透视动感，不抢戏） */
export const OCCLUDER_CARD_ROT_DEG = 6;
/** 未旋转/未放大时的卡片半宽（屏分数）：覆盖判定保守取下限（旋转与 scale 只增大有效半径） */
const CARD_COVER_HALF = OCCLUDER_CARD_FRAC / 2; // 0.7

/** direction 档位 → 扫入运动朝向单位向量；非法/未给 = 向左（3），与转场方向参数同口径 */
const occluderDirVec = (direction: number | undefined): {x: number; y: number} => {
  switch (Math.round(direction ?? 3)) {
    case 1: return {x: 0, y: -1};
    case 2: return {x: 0, y: 1};
    case 4: return {x: 1, y: 0};
    default: return {x: -1, y: 0};
  }
};

/**
 * 驻留行程曲线：p∈[0,0.45] easeOut 冲入居中（高速扫入减速到位），[0.45,0.55] 驻留
 * （盖满帧 = 前后段切换窗口），[0.55,0.92] easeIn 加速扫出，[0.92,1] 屏外待命
 * （保证窗口末帧卡片已完全离屏，转场收尾不跳）。
 * 返回卡片中心沿运动轴的偏移（屏分数，负 = 入场侧）。
 */
const cardDwellTravel = (p: number): number => {
  const T = OCCLUDER_CARD_TRAVEL;
  if (p <= 0) return -T;
  if (p < 0.45) return -T * (1 - easeOutCubic(p / 0.45));
  if (p <= 0.55) return 0;
  if (p < 0.92) return T * easeInCubic((p - 0.55) / 0.37);
  return T;
};

export interface CardSweepState {
  /** 卡片中心偏移（屏分数，已沿 direction 轴分解到 x/y） */
  x: number;
  y: number;
  rotateDeg: number;
  scale: number;
  /** 覆盖度：≥1 = 完全盖住画面（前后段切换点）；<1 为余量线性映射（供判定/测试） */
  cover: number;
}

// ====== shapeBloom 形状绽放 ======

/**
 * CSS clip-path circle 百分比参考长度 L = √(w²+h²)/√2：焦点在画面角上时盖满需
 * 角到角距离 √(w²+h²) = √2·L ≈ 141.42%——任意焦点/画幅的盖满上界。
 */
export const OCCLUDER_BLOOM_COVER_PCT = Math.SQRT2 * 100;
/** 绽放峰值半径（%）：盖满上界 141.42% 留 6% 余量（奇数帧网格上 0.5±半格仍盖满） */
export const OCCLUDER_BLOOM_MAX_PCT = 150;

export interface ShapeBloomState {
  /** 圆心（归一化 0-1 = 焦点） */
  cx: number;
  cy: number;
  /** clip-path circle 半径（%）：progress 0/1 → 0（无形），0.5 → 峰值 150（盖满） */
  radiusPct: number;
  cover: number;
}

export type OccluderState =
  | {kind: 'cardSweep'; card: CardSweepState}
  | {kind: 'shapeBloom'; bloom: ShapeBloomState};

/**
 * 遮挡物几何状态。progress 为已缓动进度（可越界；几何通道内部钳制——clip-path 负半径
 * 非法，卡片行程越界直接呈现过冲，同 transition-style 的 pc 政策）。
 */
export const occluderState = (
  type: OccluderTransition,
  progress: number,
  opts?: OccluderOpts,
): OccluderState => {
  const p = clamp01(progress);
  if (type === 'cardSweep') {
    const v = occluderDirVec(opts?.direction);
    const c = cardDwellTravel(p);
    // 盖满 ⟺ |c| ≤ 卡半宽 − 0.5（屏半宽）；cover 把该余量线性映射到 1 为界
    const cover = (CARD_COVER_HALF - Math.abs(c)) / (CARD_COVER_HALF - 0.5);
    return {
      kind: 'cardSweep',
      card: {
        x: nz(c * v.x),
        y: nz(c * v.y),
        rotateDeg: nz(OCCLUDER_CARD_ROT_DEG * (c / OCCLUDER_CARD_TRAVEL)),
        scale: 1 + 0.05 * (1 - Math.abs(c) / OCCLUDER_CARD_TRAVEL),
        cover,
      },
    };
  }
  const focus = opts?.focus ?? {x: 0.5, y: 0.5};
  // sin² 剖面：起止利落（起 ~p²、收 ~(1-p)² 加速）、峰顶平滑；比 sin 瘦——
  // 盖满驻留压缩到约窗口 1/3，收拢显露阶段（p 后半）足够长，后段显露过程看得清。
  // 峰值 150 ≥ 盖满上界 141.42：角上焦点也在 p∈[0.42,0.58] 真实盖满。
  const sin = Math.sin(Math.PI * p);
  const radiusPct = OCCLUDER_BLOOM_MAX_PCT * sin * sin;
  return {
    kind: 'shapeBloom',
    bloom: {
      cx: clamp01(focus.x),
      cy: clamp01(focus.y),
      radiusPct,
      cover: radiusPct / OCCLUDER_BLOOM_COVER_PCT,
    },
  };
};

/** 当前进度遮挡物是否完全盖住画面（瞬时覆盖度，供调试/测试） */
export const occluderCovered = (type: OccluderTransition, progress: number, opts?: OccluderOpts): boolean => {
  const st = occluderState(type, progress, opts);
  return st.kind === 'cardSweep' ? st.card.cover >= 1 : st.bloom.cover >= 1;
};

/**
 * 前后段是否已完成切换（覆盖锁存）：遮挡物「曾」盖满过即切换，之后扫出/收拢阶段
 * 不再切回——出段从切换瞬间起全程隐藏，扫出时显露的是已在底层就位的入段。
 * 对单调进度精确；curve 中途倒退的奇异曲线下与几何瞬时覆盖一致回退（同样无接缝）。
 */
export const occluderSwitched = (type: OccluderTransition, progress: number, opts?: OccluderOpts): boolean => {
  const p = clamp01(progress);
  if (type === 'cardSweep') {
    // cardDwellTravel 单调不减：进入盖满区（c ≥ -(卡半宽-0.5)）后不会再退回入场侧，
    // 出场段 c 继续增大，锁存自然保持
    return cardDwellTravel(p) >= -(CARD_COVER_HALF - 0.5);
  }
  // sin² 剖面前半单调升、峰值在 p=0.5（峰值半径 150 ≥ 盖满上界 141.42，必曾盖满）；
  // 前半程看瞬时半径
  return p >= 0.5 || occluderCovered(type, p, opts);
};
