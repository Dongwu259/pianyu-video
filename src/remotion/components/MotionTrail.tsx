/**
 * MotionTrail - 窗口化运动模糊包装
 *
 * 基于 @remotion/motion-blur 的 <Trail>：拖尾层以时间冻结（Freeze）方式把子树
 * 在早前帧的姿态垫在主元素后面，形成方向性运动模糊。适用于大幅快速位移的元素
 * （卡片飞入、甩入等，单帧位移 100px 级）；小位移文字入场不要包（不可见，纯浪费渲染）。
 *
 * 关键约束（Trail 文档）：
 * - 子元素必须绝对定位（多层叠加不参与布局）
 * - 子元素的动效必须由其内部 useCurrentFrame() 驱动；外部只能传静态 props
 *   （本组件的 active 开关由父组件用 frame 计算，属于布尔门控，不注入动效值）
 *
 * 窗口化（active）设计：Trail 会让子树渲染 1+layers 遍，静止后拖尾与主体完全
 * 重合、视觉无效纯耗性能——尤其卡片内是 OffthreadVideo，多层并发解码需要控制。
 * 入场收敛后卸载 Trail 回到普通渲染。最终渲染每帧独立出图，卸载不影响成片；
 * 仅 Player 预览划过窗口边界时子树重挂载一次（可接受的瞬时加载）。
 *
 * 参数缺省取 MOTION_BLUR token（src/remotion/animations/motion.ts），全局口音统一。
 */

import {Trail} from '@remotion/motion-blur';
import {MOTION_BLUR} from '../animations/motion';

interface MotionTrailProps {
  /** 运动窗口开关：元素仍在快速位移时为 true，静止后置 false 卸载拖尾层 */
  active: boolean;
  children: React.ReactNode;
  /** 拖尾层数（整数，>=0） */
  layers?: number;
  /** 层间时间延迟（帧，可为小数） */
  lagInFrames?: number;
  /** 最近一层拖尾的最大不透明度 */
  trailOpacity?: number;
}

export const MotionTrail: React.FC<MotionTrailProps> = ({
  active,
  children,
  layers = MOTION_BLUR.layers,
  lagInFrames = MOTION_BLUR.lagInFrames,
  trailOpacity = MOTION_BLUR.trailOpacity,
}) => {
  if (!active) return <>{children}</>;
  return (
    <Trail layers={layers} lagInFrames={lagInFrames} trailOpacity={trailOpacity}>
      {children}
    </Trail>
  );
};
