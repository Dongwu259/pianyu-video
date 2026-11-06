/**
 * 模板: ProductFloat - 产品悬浮（1.6 M3，Apple hero 派）
 *
 * 主体（录屏窗口卡/产品图/视频）悬浮在纯色舞台上缓浮漂移——第二轮参照研究的
 * Apple 三语言落地：白境（AirPods：产品悬浮+大量留白）/ 黑底轮廓光（MacBook：
 * 全黑舞台+辉光描边）/ 品牌渐变（色板舞台）。缓浮 sin 漂移 ±1.5% + 镜内缓推消静止帧，
 * 柔投影托底，标题落底部（白境自动换深色字）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {PRODUCT_FLOAT_PARAMS} from '../../shared/template-registry';
import {
  STAGE_PALETTES, LIGHT_STAGE_PALETTES, STAGE_CARD_RADIUS, STAGE_CARD_BORDER, STAGE_CARD_BORDER_LIGHT, STAGE_CARD_SHADOW,
  stageCardGlowShadow,
} from '../../shared/stage-bg';
import {clipEndSec} from '../../shared/clipCuts';

export const ProductFloat: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 6) * FPS));

  const p = makeParamReader(PRODUCT_FLOAT_PARAMS, params);
  const bgMode = Math.round(p('bgMode'));
  const paletteIdx = Math.round(p('stagePalette'));
  const cardScale = p('cardScale');
  const floatAmp = p('floatAmp');
  const floatSpeed = p('floatSpeed');
  const glowRing = p('glowRing') >= 0.5;
  const kenBurnsOn = p('kenBurns') >= 0.5;

  const palette = STAGE_PALETTES[Math.max(0, Math.min(STAGE_PALETTES.length - 1, paletteIdx))];
  const isWhite = bgMode === 0;

  const video = videos[0];
  const videoW = video?.width || canvasW;
  const videoH = video?.height || canvasH;

  const opacity = interpolate(frame, [0, 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  // 主体卡：84% 宽 × 74% 高的框内装视频宽高比
  const boxW = canvasW * 0.84 * cardScale;
  const boxH = canvasH * 0.74 * cardScale;
  const ar = videoW / videoH;
  let cardH = Math.min(boxH, boxW / ar);
  let cardW = cardH * ar;

  // 缓浮：sin 垂直漂移 ±1.5% + cos 水平微漂移 ±0.6%，周期 8s/速度
  const period = 8 / Math.max(0.3, floatSpeed);
  const phase = (frame / FPS) * Math.PI * 2 / period;
  const dy = Math.sin(phase) * canvasH * 0.015 * floatAmp;
  const dx = Math.cos(phase * 0.618) * canvasW * 0.006 * floatAmp;

  // 镜内缓推 1 → +5%（消静止帧）
  const zoom = kenBurnsOn ? interpolate(frame, [0, totalFrames], [1, 1.05], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;

  const bg =
    bgMode === 0
      ? 'radial-gradient(120% 100% at 50% 30%, #FFFFFF 0%, #EEF0F4 68%, #E3E6EC 100%)'
      : bgMode === 1
        ? '#050507'
        : `linear-gradient(135deg, ${palette.solid} 0%, ${palette.to} 62%, ${palette.solid} 100%)`;

  const cardShadow = isWhite
    ? '0 70px 130px -34px rgba(15, 23, 42, 0.38), 0 24px 48px -20px rgba(15, 23, 42, 0.22)'
    : bgMode === 1
      ? `0 0 90px ${palette.glow}33, 0 50px 110px -30px rgba(0, 0, 0, 0.85)`
      : `${STAGE_CARD_SHADOW}`;

  const titleColor = style?.title?.color ?? (isWhite ? '#111827' : VIDEO_DESIGN.colors.textTitleDark);
  const subColor = style?.subtitle?.color ?? (isWhite ? '#374151' : VIDEO_DESIGN.colors.textBodyDark);

  return (
    <AbsoluteFill style={{opacity, background: style?.background ?? bg}}>
      {video && (
        <AbsoluteFill>
          <div
            style={{
              position: 'absolute',
              left: canvasW / 2 - cardW / 2 + dx,
              top: canvasH * 0.46 - cardH / 2 + dy,
              width: cardW,
              height: cardH,
              overflow: 'hidden',
              borderRadius: STAGE_CARD_RADIUS,
              background: '#000',
              boxShadow: [
                cardShadow,
                ...(glowRing ? [bgMode === 1 ? stageCardGlowShadow(paletteIdx) : `0 0 0 1px ${palette.glow}55`] : []),
                ...(isWhite ? [] : LIGHT_STAGE_PALETTES.has(paletteIdx) ? [STAGE_CARD_BORDER_LIGHT] : [STAGE_CARD_BORDER]),
              ].join(', '),
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: '100%',
                height: '100%',
                transform: `translate(-50%, -50%) scale(${zoom})`,
              }}
            >
              <ClipMedia
                src={video.src}
                mediaType={video.type}
                muted={video.type === 'video' ? true : undefined}
                startFrom={Math.round((video.trimStart || 0) * FPS)}
                endSec={video.type === 'video' ? clipEndSec(video) : undefined}
                cutsSec={video.cuts}
                style={{width: '100%', height: '100%', objectFit: 'cover'}}
              />
            </div>
          </div>
        </AbsoluteFill>
      )}

      {!video && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: tokens.fontSize.body,
            color: isWhite ? '#6B7280' : VIDEO_DESIGN.colors.textMuted,
            fontFamily: VIDEO_DESIGN.bodyFont,
          }}
        >
          「产品悬浮」需要 1 段视频或图片素材
        </div>
      )}

      {/* 文字层：底部标题/副标题（白境自动深色字） */}
      {text.title && (
        <div style={{position: 'absolute', bottom: canvasH * 0.08, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={15}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.75,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: titleColor,
              letterSpacing: '-0.01em',
              textShadow: isWhite ? '0 1px 8px rgba(255,255,255,0.6)' : '0 2px 16px rgba(0, 0, 0, 0.65)',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: 10}}>
              <AnimatedText
                text={text.subtitle}
                preset="fadeIn"
                startFrame={28}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: subColor,
                  textShadow: isWhite ? 'none' : '0 1px 10px rgba(0, 0, 0, 0.6)',
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default ProductFloat;
