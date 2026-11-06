/**
 * 标量缓动函数（纯函数，无运行时依赖，Node 可直跑单测）。
 *
 * 历史上 easeOutCubic 有三处手写变体（transition-style 局部函数、AnimatedText 内联
 * `1-(1-p)^3`），收敛于此作为 shared 侧单一事实源；Remotion 侧的 Easing 包装与
 * spring/stagger token 见 src/remotion/animations/motion.ts（其 easeOutQuint 从本模块复用）。
 */

/** cubic-out：现行口音，位移类入场的旧默认 */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** cubic-in：加速离场（遮挡物转场卡片扫出段等） */
export const easeInCubic = (t: number): number => t * t * t;

/** cubic-in-out：对称进出（push/whip 类双片同移） */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** quint-out：商业 MG 标志性曲线（等价 cubic-bezier(0.16,1,0.3,1)），初段快、尾段极柔 */
export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);

/** smootherstep：两端慢的对称曲线（DogSC smooth 同款；「柔和」档，适合全程运动型镜头） */
export const easeInOutSmootherstep = (t: number): number =>
  t * t * t * (t * (t * 6 - 15) + 10);

/** easeOutBack：轻微过冲回落（与 ThreeText 逐字入场同系数，「弹性」档口音一致） */
export const easeOutBack = (t: number): number =>
  1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/**
 * motionEase 档位 → 归一化缓动曲线（统一时间语言，DogSC 命名档位路线）。
 * 0=默认=模板现状（线性模板即线性，老工程零变化）/ 1=干脆（快进缓停 cubic-out）/
 * 2=柔和（慢起慢停 smootherstep）/ 3=弹性（约 +10% 过冲回落）。
 * 同一曲线同时管运动的入场与收尾（DogSC 出入场对称复用同曲线的省参数做法）；
 * 多停点 interpolate 逐段应用（Remotion 语义），档位对每段腿各自生效。
 */
export const easeTierCurve = (tier: number): ((t: number) => number) => {
  switch (Math.round(tier)) {
    case 1: return easeOutCubic;
    case 2: return easeInOutSmootherstep;
    case 3: return easeOutBack;
    default: return (t) => t;
  }
};
