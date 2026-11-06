/**
 * 动效 Token —— 全模板统一的运动语言单一事实源
 *
 * 商业动效的「口音一致」靠三件事：同一套弹簧参数、同一条缓动曲线、同一档错峰间隔。
 * 所有模板 / 图层的 spring 配置、Easing 引用、stagger 步长必须从本模块取值，
 * 不允许在组件内散落硬编码（历史上有 7 处 spring、3 处手写 cubic-out 变体，已收编于此）。
 *
 * 约定：
 * - SPRINGS 各预设的数值 = 收编前各调用点的原始值（零视觉回归），调整口音时改这里全局生效
 * - EASINGS.standard 是商业 MG 标志性 easeOutQuint 曲线（cubic-bezier(0.16,1,0.3,1)），
 *   出场初段快、尾段极柔 —— 行业入场标准（Apple/Material 系的「几乎察觉不到但感觉得到」）。
 *   历史上曾是 cubic-out，2026-08 全站迁移至 quint 曲线（模板视觉变化 → 渲染缓存版本同步升级）
 * - STAGGER 单位为帧（30fps）：tight=66ms / normal=100ms / loose=166ms
 */

import {Easing} from 'remotion';
import type {SpringConfig} from 'remotion';
import {easeOutQuint as easeOutQuintFn, easeTierCurve as easeTierCurveFn} from '../../shared/easings';

// ====== 弹簧预设 ======

export const SPRINGS = {
  /** 缩放入场（AnimatedText scaleIn）：干净无过冲 */
  scaleIn: {damping: 14, stiffness: 110, mass: 0.6},
  /** 弹出（AnimatedText popIn / keyframes popIn·卡片用）：强过冲的手感 */
  pop: {damping: 9, stiffness: 160, mass: 0.5},
  /** 卡片弹出（keyframes popIn 原值，StackCards 消费） */
  cardPop: {damping: 12, stiffness: 100, mass: 0.8},
  /** 弹跳（AnimatedText bounce）：低阻尼多次回弹 */
  bounce: {damping: 7, stiffness: 120, mass: 0.7},
  /** 逐字弹入（charPop）：快而起收利落 */
  charPop: {damping: 12, stiffness: 180, mass: 0.6},
  /** 卡片飞入落位（CardConverge）：一次轻微过冲，「砸到鼓点」的弹性 */
  cardSettle: {damping: 14, stiffness: 170, mass: 0.8},
  /** 悬浮卡片入场（FloatingCardLayer） */
  float: {damping: 14, stiffness: 120, mass: 0.8},
  /** 建议芯片弹入（AiPromptCard；C 批自内联配置收编，数值原样） */
  chipPop: {damping: 12, stiffness: 200, mass: 0.6},
  /** 结果卡生长（AiPromptCard；C 批自内联配置收编，数值原样） */
  resultGrow: {damping: 14, stiffness: 170, mass: 0.7},
  /** 数字/徽章砸落（TutorialStep；C 批自内联配置收编，数值原样） */
  stampSettle: {damping: 14, stiffness: 130},
} as const satisfies Record<string, Partial<SpringConfig>>;

// ====== 缓动曲线 ======

export const EASINGS = {
  /** 现行口音：easeOutQuint（0.16,1,0.3,1），一切入场/展开/位移的统一曲线 */
  standard: Easing.bezier(0.16, 1, 0.3, 1),
  /** 对称进出（push/whip 类双片同移） */
  inOut: Easing.inOut(Easing.cubic),
  /** 匀加速（结尾推近把动能交给转场；退场比入场快的手感也用它） */
  accel: Easing.in(Easing.quad),
} as const;

/** 纯函数版 premium 曲线（interpolate 手算进度的场合，不经过 Remotion Easing） */
export const easeOutQuint = easeOutQuintFn;

/**
 * motionEase 档位 → 缓动曲线（0默认/1干脆/2柔和/3弹性）。
 * 模板用 makeParamReader 读 motionEase 后经此取曲线喂给 interpolate 的 easing；
 * 实现与档位语义见 shared/easings（纯函数，Node 可直跑单测）。
 */
export const easeTierCurve = easeTierCurveFn;

/**
 * 入场曲线档位选择（C 批统一时间语言）：tier 0 = 模板原曲线 base（引用相等，零回归），
 * 1-3 = easeTierCurve 档位曲线。base 不传默认 EASINGS.standard（商业 MG 口音）；
 * 擦除/推近等以 inOut/accel 为现状的模板把自身曲线作 base 传入。
 */
export const entryEase = (
  tier: number,
  base: (t: number) => number = EASINGS.standard,
): ((t: number) => number) => (Math.round(tier) > 0 ? easeTierCurve(tier) : base);

// ====== 错峰编排 ======

export const STAGGER = {
  /** 逐字/紧凑级联：66ms */
  tight: 2,
  /** 常规元素级联（bar → 标题 → 副标题）：100ms */
  normal: 3,
  /** 宽松列表级联：166ms */
  loose: 5,
} as const;

/** 第 i 个元素的错峰延迟帧数 */
export const staggerDelay = (i: number, step: number = STAGGER.normal): number => i * step;

// ====== 运动模糊（@remotion/motion-blur Trail 参数） ======

export const MOTION_BLUR = {
  /** 拖尾层数（子树渲染遍数 = 1 + layers，控制在 3 以内保护渲染耗时） */
  layers: 3,
  /** 层间时间延迟（帧）：0.75 在 30fps 下约 25ms，拖尾短而实 */
  lagInFrames: 0.75,
  /** 单层最大不透明度 */
  trailOpacity: 0.55,
} as const;
