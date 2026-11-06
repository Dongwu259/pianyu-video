/**
 * Watermark - 免费版水印层
 *
 * 未授权（免费版）导出/预览时叠加在画面右下角的半透明角标；
 * 授权版（licensed !== false）不渲染。
 * 尺寸随画布宽度等比缩放（getScaledTokens），竖屏/方形画布自动缩小。
 */

import {AbsoluteFill, useVideoConfig} from 'remotion';
import {getScaledTokens} from '../config/designTokens';

export const Watermark: React.FC = () => {
  const {width, height} = useVideoConfig();
  const tokens = getScaledTokens(width, height);

  // 基于 caption 字号略收小，保持低调不抢眼
  const fontSize = Math.round(tokens.fontSize.caption * 0.85);
  const paddingX = Math.round(tokens.spacing.element * 1.2);
  const paddingY = Math.round(tokens.spacing.tight * 0.9);
  const margin = Math.round(tokens.spacing.element * 1.5);

  return (
    <AbsoluteFill style={{pointerEvents: 'none', zIndex: 999}}>
      <div
        style={{
          position: 'absolute',
          right: margin,
          bottom: margin,
          padding: `${paddingY}px ${paddingX}px`,
          borderRadius: Math.round(fontSize * 0.5),
          background: 'rgba(0, 0, 0, 0.45)',
          color: 'rgba(255, 255, 255, 0.9)',
          fontSize,
          fontFamily: tokens.bodyFont,
          fontWeight: 500,
          letterSpacing: '0.05em',
          lineHeight: 1.4,
        }}
      >
        由 片语 生成
      </div>
    </AbsoluteFill>
  );
};

export default Watermark;
