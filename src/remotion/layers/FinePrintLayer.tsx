/**
 * FinePrintLayer - 边缘小字 / 免责声明层（项目级，顶层常驻）
 *
 * 渲染免责声明、版权信息、「本片由 AI 生成」之类的常驻小字。
 * text 为空串时不渲染；位置/不透明度/字号由项目级 FinePrintConfig 决定。
 * 由 MultiSegmentPromo 顶层渲染（不随片段切换），因此全片时间轴内一直可见。
 */

import {AbsoluteFill, useVideoConfig} from 'remotion';
import type {FinePrintConfig} from '../../shared/types';
import {getScaledTokens} from '../config/designTokens';
import {safeBottom} from '../utils/safeArea';

interface FinePrintLayerProps {
  config: FinePrintConfig;
}

export const FinePrintLayer: React.FC<FinePrintLayerProps> = ({config}) => {
  const {width, height} = useVideoConfig();
  const tokens = getScaledTokens(width, height);
  if (!config.text || !config.text.trim()) return null;

  // 基准字号 ≈ 画布高 1.6%（1080p 下约 17px），边缘小字宜小宜淡
  const fontSize = Math.max(10, Math.round(height * 0.016 * (config.sizeScale || 1)));
  const marginX = Math.round(width * 0.02);
  // 竖版投放时底部抬到平台 UI 遮挡线之上（Reels/TikTok 底 ~18%），横版维持基础留白
  const marginBottom = safeBottom(width, height, Math.round(height * 0.015));

  const align = config.position === 'bottomLeft' ? 'flex-start' : config.position === 'bottomRight' ? 'flex-end' : 'center';

  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: marginX,
          right: marginX,
          bottom: marginBottom,
          display: 'flex',
          justifyContent: align,
        }}
      >
        <div
          style={{
            color: '#ffffff',
            fontSize,
            fontFamily: tokens.bodyFont,
            fontWeight: 400,
            lineHeight: 1.5,
            letterSpacing: '0.04em',
            textAlign: config.position === 'bottomLeft' ? 'left' : config.position === 'bottomRight' ? 'right' : 'center',
            whiteSpace: 'pre-line',
            opacity: config.opacity,
            // 轻投影保证在亮背景上也可读
            textShadow: '0 1px 3px rgba(0, 0, 0, 0.6)',
          }}
        >
          {config.text}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default FinePrintLayer;
