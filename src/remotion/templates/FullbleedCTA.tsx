/**
 * 模板: FullbleedCTA - 全幅收尾 CTA（Fullbleed 素材主导族）
 *
 * 结尾段：实拍素材满幅 + 整体暗化，居中大标题/副标题/品牌名——电影感收束。
 * 无素材时也可用（纯暗底居中 CTA，minVideos 0）。
 * 文字入场克制（fade + 8px 上滑），素材零动效。
 *
 * 个性化参数（FULLBLEED_CTA_PARAMS）：
 * dim 整体暗化（0.3-0.85）、titleScale 标题字号倍率（0.7-1.5）
 */

import React from 'react';
import {AbsoluteFill, useVideoConfig} from 'remotion';
import {FullbleedStage, useRestrainedEntrance} from './FullbleedStage';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {FULLBLEED_CTA_PARAMS} from '../../shared/template-registry';
import {TemplateProps} from '../../shared/types';

export const FullbleedCTA: React.FC<TemplateProps> = ({
  videos,
  text,
  style,
  params,
}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const p = makeParamReader(FULLBLEED_CTA_PARAMS, params);
  const dim = p('dim');
  const titleScale = p('titleScale');

  const titleEntrance = useRestrainedEntrance(0.25);
  const subEntrance = useRestrainedEntrance(0.5);
  const brandEntrance = useRestrainedEntrance(0.7);

  return (
    <FullbleedStage
      videos={videos}
      dimScrim={dim}
      bottomGradientRatio={0}
      emptyHint=""
      style={style}
    >
      {/* 居中 CTA 内容层（素材可缺省：minVideos 0，纯暗底居中） */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: Math.round(canvasW * 0.016),
          textAlign: 'center',
          padding: `0 ${Math.round(canvasW * 0.1)}px`,
        }}
      >
        {text.title ? (
          <div
            style={{
              fontSize: tokens.fontSize.title * 1.15 * titleScale,
              fontFamily: VIDEO_DESIGN.titleFont,
              fontWeight: 700,
              lineHeight: 1.18,
              letterSpacing: '-0.01em',
              color: style?.title?.color ?? '#FFFFFF',
              textShadow: '0 2px 32px rgba(0,0,0,0.55)',
              margin: 0,
              opacity: titleEntrance.opacity,
              transform: titleEntrance.transform,
            }}
          >
            {text.title}
          </div>
        ) : null}
        {text.subtitle ? (
          <div
            style={{
              fontSize: tokens.fontSize.subtitle,
              fontFamily: VIDEO_DESIGN.bodyFont,
              color: 'rgba(255,255,255,0.86)',
              letterSpacing: '0.06em',
              lineHeight: 1.6,
              opacity: subEntrance.opacity,
              transform: subEntrance.transform,
            }}
          >
            {text.subtitle}
          </div>
        ) : null}
        {text.brandName ? (
          <div
            style={{
              marginTop: Math.round(canvasW * 0.014),
              fontSize: tokens.fontSize.caption,
              fontFamily: VIDEO_DESIGN.bodyFont,
              color: 'rgba(255,255,255,0.65)',
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              opacity: brandEntrance.opacity,
              transform: brandEntrance.transform,
            }}
          >
            {text.brandName}
          </div>
        ) : null}
      </AbsoluteFill>
    </FullbleedStage>
  );
};

export default FullbleedCTA;
