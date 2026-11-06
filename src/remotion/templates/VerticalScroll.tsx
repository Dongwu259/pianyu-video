/**
 * 模板: 竖屏滚动文字卡
 *
 * 效果: 带大段说明文字的竖屏卡片向上滚动
 * 适用: 抖音/小红书风格、功能介绍
 *
 * 个性化参数（paramSpecs: VERTICAL_SCROLL_PARAMS）：cardScale 卡片大小 / scrollSpeed 滚动速度 /
 * motionEase 缓动曲线档位（0默认线性 1干脆 2柔和 3弹性）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ClipMedia} from '../layers/ClipMedia';
import {fitVideo} from '../utils/fitVideo';
import {dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {easeTierCurve} from '../animations/motion';
import {textStrokeCss} from '../utils/textStroke';
import {VERTICAL_SCROLL_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const VerticalScroll: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();

  const video = videos[0];
  const totalFrames = Math.round((segmentDuration || 8) * FPS);
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);

  // 个性化参数（故事板「参数」页滑块；未调整走 VERTICAL_SCROLL_PARAMS 默认值）
  const p = makeParamReader(VERTICAL_SCROLL_PARAMS, params);
  const cardScaleMul = p('cardScale');   // 滚动卡片尺寸倍率（乘在 layout 缩放之上）
  const scrollSpeed = p('scrollSpeed');  // 向上滚动速度倍率（压缩滚动用时）
  // 滚动方向（0=自动=从下往上）：单位来向向量；null 时走默认垂直滚动公式（零回归）
  const scrollVec = directionVector(p('direction'), 1);

  // layout 自定义参数（应用到文字卡片）
  // 卡片宽度用模板设计默认 0.84：不读 layout.videoWidthRatio（Segment.layout 恒有默认 0.6，与设计不符）
  const cardWidthRatio = 0.84;
  const cardMargin = canvasW * (1 - cardWidthRatio) / 2;
  const cardOffsetX = canvasW * (layout?.videoOffsetX ?? 0);
  const cardOffsetY = canvasH * (layout?.videoOffsetY ?? 0);
  const cardRadius = layout?.borderRadius ?? 20;
  const cardScale = (layout?.scale ?? 1) * cardScaleMul;
  const perspective = layout?.perspective ?? 1200;
  // rotateX 用模板设计默认 0°：不读 layout.rotateX（恒为 5°，与设计不符）
  const rotateX = 0;
  const rotateY = layout?.rotateY ?? 0;
  const rotateZ = layout?.rotateZ ?? 0;
  const cardTransform = `perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${cardScale})`;

  // 文字卡片滚动行程（scrollSpeed 倍率压缩用时，>1 提前滚完停住；Math.max 防除零）
  // motionEase 档位换滚动手感（3=弹性时卡片略滚过头再回弹落位）
  const scrollFrames = Math.max(1, Math.round(totalFrames / Math.max(scrollSpeed, 0.05)));
  const travel = interpolate(frame, [0, scrollFrames], [canvasH * 0.3, -canvasH * 0.1], {
    easing: easeTierCurve(p('motionEase')),
    extrapolateRight: 'clamp',
  });
  // 方向滚动：沿来向向量分解行程（下(0,1) 时与原默认完全一致）；0=自动保持原垂直滚动。
  // 水平分量走 transform（不改 left/right，否则卡宽随滚动形变）
  const scrollX = scrollVec ? scrollVec.x * travel : 0;
  const scrollY = scrollVec ? scrollVec.y * travel : travel;

  // 淡入（结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责，
  // 否则会把出场转场退化为 dip-to-black 并与全片淡黑双重叠加）
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 驻留微运动：滚动停住后卡片保持缓慢漂移（纯文字卡不做呼吸缩放防糊，P2 质感）
  const drift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, 0);

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 视频背景（模糊放大） */}
      {video && (
        <div style={{position: 'absolute', inset: 0}}>
          {(() => {
            const {width: fitW, height: fitH, offsetX, offsetY} = fitVideo(
              canvasW, canvasH, video.width, video.height, 'cover'
            );
            return (
              <ClipMedia
                src={video.src}
                mediaType={video.type}
                muted={video.muted}
                volume={video.volume}
                startFrom={Math.round((video.trimStart || 0) * FPS)}
                endSec={clipEndSec(video)}
                cutsSec={video.cuts}
                style={{
                  width: fitW,
                  height: fitH,
                  transform: `translate(-${offsetX}px, -${offsetY}px)`,
                  objectFit: 'cover',
                  filter: 'brightness(0.5)',
                }}
              />
            );
          })()}
        </div>
      )}

      {/* 滚动文字卡片 */}
      <div
        style={{
          position: 'absolute',
          left: cardMargin + cardOffsetX,
          right: cardMargin - cardOffsetX,
          top: scrollY + cardOffsetY,
          padding: '24px 20px',
          background: 'rgba(255, 255, 255, 0.95)',
          borderRadius: cardRadius,
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          transform: `${cardTransform} translateX(${scrollX + drift.x}px) translateY(${drift.y}px)`,
          transformOrigin: 'center top',
        }}
      >
        {text.title && (
          <h2 style={{
            fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.65,
            fontWeight: style?.title?.fontWeight ?? 800,
            color: style?.title?.color ?? '#111827',
            fontFamily: VIDEO_DESIGN.titleFont,
            margin: 0,
            marginBottom: 12,
            lineHeight: 1.2,
            ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
            ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
            ...textStrokeCss(style?.title),
          }}>
            {text.title}
          </h2>
        )}

        {text.subtitle && (
          <p style={{
            fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body * 0.9,
            color: style?.subtitle?.color ?? '#6B7280',
            fontFamily: VIDEO_DESIGN.bodyFont,
            margin: 0,
            marginBottom: 16,
            lineHeight: 1.6,
            ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
            ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
            ...textStrokeCss(style?.subtitle),
          }}>
            {text.subtitle}
          </p>
        )}

        {(text.features?.length || 0) > 0 && (
          <ul style={{listStyle: 'none', padding: 0, margin: 0}}>
            {(text.features || []).map((feat, i) => (
              <li
                key={i}
                style={{
                  fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * 0.85,
                  color: style?.feature?.color ?? '#374151',
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  padding: '8px 0',
                  borderBottom: i < (text.features || []).length - 1 ? '1px solid #E5E7EB' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                  ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                  ...textStrokeCss(style?.feature),
                }}
              >
                <span style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: VIDEO_DESIGN.colors.accent,
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}>
                  {i + 1}
                </span>
                {feat}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 品牌名 */}
      {text.brandName && (
        <div style={{
          position: 'absolute',
          bottom: 20,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
          color: style?.brand?.color ?? 'rgba(255,255,255,0.5)',
          fontFamily: VIDEO_DESIGN.bodyFont,
          fontWeight: style?.brand?.fontWeight ?? 600,
          letterSpacing: '0.1em',
          ...(style?.brand?.textDecoration ? {textDecoration: style.brand.textDecoration} : {}),
          ...(style?.brand?.fontStyle ? {fontStyle: style.brand.fontStyle} : {}),
          ...textStrokeCss(style?.brand),
        }}>
          {text.brandName}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default VerticalScroll;
