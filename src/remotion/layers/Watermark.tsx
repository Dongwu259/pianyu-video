/**
 * Watermark - 曾经的免费版水印层（2026-11-06 起默认不渲染）
 *
 * 开源转型后编辑器不设限制：main/ipc/render.ts 恒注入 licensed=true（EDITOR_UNRESTRICTED），
 * 本组件因此不会出现在成片里。保留代码是为将来「可选品牌角标」留实现，
 * 不要把 licensed=false 当成可达状态来理解。
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
