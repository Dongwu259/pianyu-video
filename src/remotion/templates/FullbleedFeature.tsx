/**
 * 模板: FullbleedFeature - 全幅功能点（Fullbleed 素材主导族）
 *
 * 实拍素材满幅 + 底部渐变上浮层功能点列表（每条前一个小圆点/短横，克制不抢画面）。
 * 适合「画面讲主体、文字讲卖点」的展示段——实拍是主角，功能点只是浮层注释。
 * 文字入场：标题先入，功能点随后逐条 stagger（每条间隔 0.22s，fade + 8px 上滑）。
 *
 * 多镜扩展（P1-5B）：≥2 条素材时轮转硬切；单素材 + autoShots=1 时按素材自身
 * 镜头边界（scan_media）段内切镜——多段实拍轮着讲各自的卖点。
 *
 * 个性化参数（FULLBLEED_FEATURE_PARAMS）：
 * dim 底部渐变强度（0.4-1）、maxPoints 展示条数上限（2-4）、
 * cutSec 多镜间隔秒（1.2-5）、autoShots 单素材镜头切分（0连续/1按镜头边界）
 */

import React from 'react';
import {AbsoluteFill, useVideoConfig} from 'remotion';
import {FullbleedStage, useRestrainedEntrance} from './FullbleedStage';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {FULLBLEED_FEATURE_PARAMS} from '../../shared/template-registry';
import {TemplateProps} from '../../shared/types';

export const FullbleedFeature: React.FC<TemplateProps> = ({
  videos,
  text,
  style,
  params,
  segmentDuration,
}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const p = makeParamReader(FULLBLEED_FEATURE_PARAMS, params);
  const dim = p('dim');
  const maxPoints = Math.round(p('maxPoints'));
  const cutSec = p('cutSec');
  const autoShots = p('autoShots') >= 0.5;

  const features = (text.features ?? []).slice(0, Math.max(1, maxPoints));
  const titleEntrance = useRestrainedEntrance(0.2);

  return (
    <FullbleedStage
      videos={videos}
      dimScrim={0}
      bottomGradientRatio={0.2 + 0.4 * dim}
      emptyHint="「全幅功能点」需要 1 段实拍/录屏素材：请在右侧「素材」页添加"
      style={style}
      segmentDuration={segmentDuration}
      shotSec={cutSec}
      autoShots={autoShots}
    >
      {(videos.length > 0) && (
        <AbsoluteFill>
          <div
            style={{
              position: 'absolute',
              left: canvasW * 0.07,
              right: canvasW * 0.07,
              bottom: Math.round(canvasH * 0.085),
              display: 'flex',
              flexDirection: 'column',
              gap: Math.round(canvasW * 0.014),
            }}
          >
            {text.title ? (
              <div
                style={{
                  fontSize: tokens.fontSize.title,
                  fontFamily: VIDEO_DESIGN.titleFont,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  color: style?.title?.color ?? '#FFFFFF',
                  textShadow: '0 2px 20px rgba(0,0,0,0.5)',
                  marginBottom: Math.round(canvasW * 0.008),
                  opacity: titleEntrance.opacity,
                  transform: titleEntrance.transform,
                }}
              >
                {text.title}
              </div>
            ) : null}
            {features.map((f, i) => (
              <FeatureRow key={i} index={i} canvasW={canvasW} tokens={tokens}>
                {f}
              </FeatureRow>
            ))}
          </div>
        </AbsoluteFill>
      )}
    </FullbleedStage>
  );
};

/** 单条功能点：stagger 逐条入场（标题后 0.35s 起，每条间隔 0.22s） */
const FeatureRow: React.FC<{index: number; canvasW: number; tokens: ReturnType<typeof getScaledTokens>; children: string}> = ({
  index, canvasW, tokens, children,
}) => {
  const entrance = useRestrainedEntrance(0.35 + index * 0.22);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: Math.round(canvasW * 0.012),
        opacity: entrance.opacity,
        transform: entrance.transform,
      }}
    >
      <span
        style={{
          width: Math.round(canvasW * 0.007),
          height: Math.round(canvasW * 0.007),
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.9)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: tokens.fontSize.body,
          fontFamily: VIDEO_DESIGN.bodyFont,
          color: 'rgba(255,255,255,0.92)',
          letterSpacing: '0.02em',
          textShadow: '0 1px 12px rgba(0,0,0,0.55)',
        }}
      >
        {children}
      </span>
    </div>
  );
};

export default FullbleedFeature;
