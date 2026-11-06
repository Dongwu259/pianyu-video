/**
 * 模板: FullbleedTitle - 全幅大标题（Fullbleed 素材主导族）
 *
 * 实拍素材撑满画幅是绝对主角，底部渐变上叠大标题/副标题——电影感开场/章节页。
 * 文字入场克制（fade + 8px 上滑），素材零动效（不推近/不呼吸）。
 * 与 3D 画中画族的分工：实拍画面禁止缩成小窗，要么满幅（本族）要么不出现。
 *
 * 多镜扩展（P1-5B）：≥2 条素材时轮转硬切；单素材 + autoShots=1 时按素材自身
 * 镜头边界（scan_media）段内切镜——「一段长实拍 + 大标题」即剪即成。
 *
 * 个性化参数（FULLBLEED_TITLE_PARAMS）：
 * dim 底部渐变强度（0.4-1）、titleScale 标题字号倍率（0.7-1.4）、
 * cutSec 多镜间隔秒（1.2-5）、autoShots 单素材镜头切分（0连续/1按镜头边界）
 */

import React from 'react';
import {AbsoluteFill, useVideoConfig, useCurrentFrame, interpolate} from 'remotion';
import {FullbleedStage, useRestrainedEntrance} from './FullbleedStage';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {FULLBLEED_TITLE_PARAMS} from '../../shared/template-registry';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';

export const FullbleedTitle: React.FC<TemplateProps> = ({
  videos,
  text,
  style,
  params,
  segmentDuration,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const p = makeParamReader(FULLBLEED_TITLE_PARAMS, params);
  const dim = p('dim');
  const titleScale = p('titleScale');
  const cutSec = p('cutSec');
  const autoShots = p('autoShots') >= 0.5;

  const entrance = useRestrainedEntrance(0.2);
  const subtitleEntrance = useRestrainedEntrance(0.45);

  // 结尾轻淡出（交出场转场前的呼吸，不与出场转场叠加冲突：只淡内容层不淡素材）
  const totalFrames = Math.max(1, Math.round((segmentDuration || 4) * FPS));
  const outroOpacity = interpolate(frame, [totalFrames - 10, totalFrames], [1, 0.55], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const titleStyle = {
    fontSize: tokens.fontSize.title * 1.15 * titleScale,
    fontFamily: VIDEO_DESIGN.titleFont,
    fontWeight: 700,
    lineHeight: 1.15,
    letterSpacing: '-0.01em',
    color: style?.title?.color ?? '#FFFFFF',
    textShadow: '0 2px 24px rgba(0,0,0,0.45)',
    margin: 0,
  } as const;

  return (
    <FullbleedStage
      videos={videos}
      dimScrim={0}
      bottomGradientRatio={0.15 + 0.35 * dim}
      emptyHint="「全幅大标题」需要 1 段实拍/录屏素材：请在右侧「素材」页添加"
      style={style}
      segmentDuration={segmentDuration}
      shotSec={cutSec}
      autoShots={autoShots}
    >
      {(videos.length > 0) && (
        <AbsoluteFill style={{opacity: outroOpacity}}>
          <div
            style={{
              position: 'absolute',
              left: canvasW * 0.07,
              right: canvasW * 0.07,
              bottom: Math.round(canvasH * 0.085),
              display: 'flex',
              flexDirection: 'column',
              gap: Math.round(canvasW * 0.012),
            }}
          >
            {text.title ? (
              <h1 style={{...titleStyle, opacity: entrance.opacity, transform: entrance.transform}}>
                {text.title}
              </h1>
            ) : null}
            {text.subtitle ? (
              <div
                style={{
                  fontSize: tokens.fontSize.subtitle,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  color: 'rgba(255,255,255,0.88)',
                  letterSpacing: '0.04em',
                  opacity: subtitleEntrance.opacity,
                  transform: subtitleEntrance.transform,
                  maxWidth: '72%',
                }}
              >
                {text.subtitle}
              </div>
            ) : null}
            {text.brandName ? (
              <div
                style={{
                  marginTop: Math.round(canvasW * 0.006),
                  fontSize: tokens.fontSize.caption,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  color: 'rgba(255,255,255,0.62)',
                  letterSpacing: '0.24em',
                  textTransform: 'uppercase',
                  opacity: subtitleEntrance.opacity,
                  transform: subtitleEntrance.transform,
                }}
              >
                {text.brandName}
              </div>
            ) : null}
          </div>
        </AbsoluteFill>
      )}
    </FullbleedStage>
  );
};

export default FullbleedTitle;
