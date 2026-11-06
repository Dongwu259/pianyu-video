/**
 * Background - 背景层
 *
 * 支持多种背景变体：纯色、渐变、暗色等
 *
 * 用法示例：
 * <Background variant="gradient-light" />
 */

import {AbsoluteFill} from 'remotion';
import {VIDEO_DESIGN} from '../config/designTokens';

type BackgroundVariant =
  | 'solid-white'
  | 'solid-light'
  | 'gradient-light'
  | 'gradient-dark'
  | 'solid-dark';

interface BackgroundProps {
  variant?: BackgroundVariant;
  color?: string;       // 自定义背景色（优先级高于 variant）
  tint?: string;        // 主题色晕染（在 variant 之上叠一层低透明径向光晕，3D 场景主题色用）
}

export const Background: React.FC<BackgroundProps> = ({
  variant = 'gradient-light',
  color,
  tint,
}) => {
  const variantStyles: Record<BackgroundVariant, React.CSSProperties> = {
    'solid-white': {
      backgroundColor: '#FFFFFF',
    },
    'solid-light': {
      backgroundColor: VIDEO_DESIGN.colors.bgAlt,
    },
    'gradient-light': {
      background: 'linear-gradient(135deg, #F8F9FA 0%, #FFFFFF 50%, #F1F5F9 100%)',
    },
    'gradient-dark': {
      background: 'linear-gradient(135deg, #1A1A2E 0%, #16213E 50%, #0F3460 100%)',
    },
    'solid-dark': {
      backgroundColor: '#111827',
    },
  };

  return (
    <AbsoluteFill
      style={{
        ...variantStyles[variant],
        ...(color ? {background: color} : {}),
      }}
    >
      {tint && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse 90% 70% at 50% 42%, ${tint}26 0%, ${tint}0D 46%, transparent 72%)`,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default Background;
