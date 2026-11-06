/**
 * 模板: Ken Burns 推拉镜头
 *
 * 效果: 缓慢推拉缩放镜头效果（经典纪录片风格）
 * 适用: 单段视频的叙事感展示
 * 个性化参数（paramSpecs: KEN_BURNS_PARAMS）：zoomAmount 缩放幅度 / panAmount 平移幅度 /
 * motionEase 缓动曲线档位（0默认线性 1干脆 2柔和 3弹性）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {TemplateProps} from '../../shared/types';
import type {FitMode} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {easeTierCurve} from '../animations/motion';
import {textStrokeCss} from '../utils/textStroke';
import {KEN_BURNS_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const KenBurns: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();

  const video = videos[0];
  // 无素材空态：不提前 return，照常渲染背景与 title/subtitle（参考 TextSlide 空态处理）

  const totalFrames = Math.round((segmentDuration || 6) * FPS);
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);

  // 个性化参数（故事板「参数」页滑块；未调整走 KEN_BURNS_PARAMS 默认值）
  const p = makeParamReader(KEN_BURNS_PARAMS, params);
  const zoomAmount = p('zoomAmount'); // 推拉目标缩放倍率（直接值，从 1.0 推到 zoomAmount）
  const panAmount = p('panAmount');   // 平移幅度倍率（0 = 纯缩放不平移）
  // 缓动档位：缩放与平移共用同一条曲线 → 每轴都是同一 eased progress 的线性函数，
  // 画面任意点的屏幕轨迹仍是直线（抗漂移结论，同 B 项 blendCameraFrame 的前提）
  const ease = easeTierCurve(p('motionEase'));

  // Ken Burns 效果: 从 1.0 缓慢推拉到目标倍率，同时按 panAmount 做微小位移
  const scale = interpolate(frame, [0, totalFrames], [1.0, zoomAmount], {
    easing: ease,
    extrapolateRight: 'clamp',
  });
  const translateX = interpolate(frame, [0, totalFrames], [0, -15 * panAmount], {
    easing: ease,
    extrapolateRight: 'clamp',
  });
  const translateY = interpolate(frame, [0, totalFrames], [0, -8 * panAmount], {
    easing: ease,
    extrapolateRight: 'clamp',
  });

  // 淡入（结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责，
  // 否则会把出场转场退化为 dip-to-black 并与全片淡黑双重叠加）
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 画框尺寸（支持 layout 自定义）
  const frameW = canvasW * (layout?.videoWidthRatio ?? 0.8);
  const frameH = canvasH * (layout?.videoHeightRatio ?? 0.6);
  const centerX = (canvasW - frameW) / 2 + canvasW * (layout?.videoOffsetX ?? 0);
  const centerY = canvasH * 0.22 + canvasH * (layout?.videoOffsetY ?? 0);
  const borderRadius = layout?.borderRadius ?? 16;
  const layoutScale = layout?.scale ?? 1;
  const perspective = layout?.perspective ?? 1200;
  const rotateX = layout?.rotateX ?? 0;
  const rotateY = layout?.rotateY ?? 0;
  const rotateZ = layout?.rotateZ ?? 0;

  // 适配模式：片段显式指定优先；图片默认 cover，视频默认 contain（与 Video3D 一致）
  const fitMode: FitMode = video?.fit ?? (video?.type === 'image' ? 'cover' : 'contain');
  // 叠加取景视口（缩放 + 平移）；无视口时与原 fit 居中行为一致；无素材时跳过画框
  const placed = video
    ? applyViewport(
        frameW,
        frameH,
        fitVideo(frameW, frameH, video.width, video.height, fitMode),
        fitMode,
        video.viewport
      )
    : null;

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {video && placed && (
      <div
        style={{
          position: 'absolute',
          left: centerX,
          top: centerY,
          width: frameW,
          height: frameH,
          transform: `perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale * layoutScale}) translate(${translateX}px, ${translateY}px)`,
          borderRadius,
          overflow: 'hidden',
          boxShadow: '0 40px 80px -20px rgba(0, 0, 0, 0.5)',
        }}
      >
        <ClipMedia
          src={video.src}
          mediaType={video.type}
          muted={video.muted}
          volume={video.volume}
          startFrom={Math.round((video.trimStart || 0) * FPS)}
          endSec={clipEndSec(video)}
          cutsSec={video.cuts}
          style={{
            width: placed.width,
            height: placed.height,
            transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
            objectFit: fitMode,
          }}
        />
      </div>
      )}

      {/* 文字层 */}
      {text.title && (
        <div style={{position: 'absolute', bottom: canvasH * 0.1, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'fadeIn'}
            startFrame={20}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.75,
              fontWeight: style?.title?.fontWeight ?? 300,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              letterSpacing: '0.05em',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: 10}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={35}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                  color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                  ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                  ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
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

export default KenBurns;
