/**
 * 模板: 分屏对比切换
 *
 * 效果: 左右两段视频动态分屏对比，分屏线可滑动
 * 适用: A/B 展示、前后对比、功能对比
 *
 * 个性化参数（paramSpecs: SPLIT_COMPARE_PARAMS）：dividerPos 分屏线静止位置 / sweepSpeed 滑动速度 /
 * motionEase 缓动曲线档位（0默认匀速 1干脆 2柔和 3弹性；多停点逐段生效，3=每段腿轻过冲）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ClipMedia} from '../layers/ClipMedia';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import type {FitMode} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {easeTierCurve} from '../animations/motion';
import {textStrokeCss} from '../utils/textStroke';
import {SPLIT_COMPARE_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const SplitCompare: React.FC<TemplateProps> = ({
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

  const videoLeft = videos[0];
  const videoRight = videos[1] || videos[0];

  const totalFrames = Math.round((segmentDuration || 8) * FPS);
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);

  // 个性化参数（故事板「参数」页滑块；未调整走 SPLIT_COMPARE_PARAMS 默认值）
  const p = makeParamReader(SPLIT_COMPARE_PARAMS, params);
  const dividerPos = p('dividerPos');   // 分屏线静止位置（直接值，画面占比）
  const sweepSpeed = p('sweepSpeed');   // 分屏线滑动动画速度倍率

  const third = totalFrames / 3;
  const two_thirds = (totalFrames * 2) / 3;

  // 分屏线位置: 围绕静止位 dividerPos 滑过 ±0.2 后停住（默认 0.5 → 0.3 → 0.7 → 0.5）
  // sweepSpeed 倍率压缩滑动用时，>1 提前到位停住；Math.max 防除零
  // motionEase：Remotion 多停点逐段应用 easing（段内 progress 归一后过曲线），每段腿各自缓动
  const sweep = Math.max(sweepSpeed, 0.05);
  const splitPos = interpolate(
    frame,
    [0, third / sweep, two_thirds / sweep, totalFrames / sweep],
    [dividerPos - 0.2, dividerPos + 0.2, dividerPos, dividerPos],
    {easing: easeTierCurve(p('motionEase')), extrapolateRight: 'clamp'}
  );

  // 淡入（结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责，
  // 否则会把出场转场退化为 dip-to-black 并与全片淡黑双重叠加）
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 适配模式：片段显式指定优先；图片默认 cover，视频默认 contain（与 Video3D 一致）
  const getPlacement = (video: typeof videoLeft) => {
    if (!video) return {width: canvasW, height: canvasH, translateX: 0, translateY: 0, fitMode: 'cover' as FitMode};
    const fitMode: FitMode = video.fit ?? (video.type === 'image' ? 'cover' : 'contain');
    const baseFit = fitVideo(canvasW, canvasH, video.width, video.height, fitMode);
    // 叠加取景视口（缩放 + 平移）；无视口时与原 fit 居中行为一致
    return {...applyViewport(canvasW, canvasH, baseFit, fitMode, video.viewport), fitMode};
  };

  const fitLeft = getPlacement(videoLeft);
  const fitRight = getPlacement(videoRight);

  // 竖版画幅走上下分屏（左右两列在 9:16 下各只剩半幅宽，构图失衡）；
  // 固定 px 元素（分隔线/手柄）按 1920 基准画宽等比缩放，下限 0.6 保证竖版仍可辨识
  const isPortrait = canvasH > canvasW;
  const u = Math.max(0.6, canvasW / 1920);

  // 驻留微运动：分屏停稳后两侧媒体保持缓慢呼吸+漂移（P2 质感，左右错相防同频）。
  // 充满式 cover 布局：呼吸只做扩张相（[1,1.012]，收缩半周会在外缘露底），漂移收敛到 2.5px
  const breatheL = dwellBreathe(frame, FPS, 0.006, 4.5, 0) + 0.006;
  const driftL = dwellDrift(frame, FPS, 2.5 * u, 2 * u, 9, 0);
  const breatheR = dwellBreathe(frame, FPS, 0.006, 4.5, 1.37) + 0.006;
  const driftR = dwellDrift(frame, FPS, 2.5 * u, 2 * u, 9, 1.37);

  // layout 自定义参数
  const layoutScale = layout?.scale ?? 1;
  // 分屏是充满式布局：不乘 videoWidthRatio/HeightRatio（Segment.layout 恒有默认 0.6/0.5，
  // 乘上会把分屏非均匀缩到画面中心、视频形变）；rotateX 用模板设计默认 0°，不读 layout 默认（恒为 5°）
  const scaleX = layoutScale;
  const scaleY = layoutScale;
  const offsetX = canvasW * (layout?.videoOffsetX ?? 0);
  const offsetY = canvasH * (layout?.videoOffsetY ?? 0);
  const perspective = layout?.perspective ?? 1200;
  const rotateX = 0;
  const rotateY = layout?.rotateY ?? 0;
  const rotateZ = layout?.rotateZ ?? 0;
  const borderRadius = layout?.borderRadius ?? 0;
  const splitTransform = `translate(${offsetX}px, ${offsetY}px) perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scaleX}, ${scaleY})`;

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="solid-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 分屏容器（应用 layout 3D 变换） */}
      <div style={{
        position: 'absolute',
        inset: 0,
        transform: splitTransform,
        transformOrigin: 'center center',
        borderRadius,
        overflow: borderRadius ? 'hidden' : 'visible',
      }}>
      {/* 上/左视频（竖版上下分屏，横版左右分屏） */}
      {videoLeft && (
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: isPortrait ? canvasW : canvasW * splitPos,
          height: isPortrait ? canvasH * splitPos : canvasH,
          overflow: 'hidden',
        }}>
          <ClipMedia
            src={videoLeft.src}
            mediaType={videoLeft.type}
            muted={videoLeft.muted}
            volume={videoLeft.volume}
            startFrom={Math.round((videoLeft.trimStart || 0) * FPS)}
            endSec={clipEndSec(videoLeft)}
            cutsSec={videoLeft.cuts}
            style={{
              width: fitLeft.width,
              height: fitLeft.height,
              transform: `translate(${fitLeft.translateX + driftL.x}px, ${fitLeft.translateY + driftL.y}px) scale(${breatheL})`,
              objectFit: fitLeft.fitMode,
              position: 'absolute',
              left: 0,
              top: 0,
            }}
          />
        </div>
      )}

      {/* 下/右视频 */}
      {videoRight && (
        <div style={{
          position: 'absolute',
          left: isPortrait ? 0 : canvasW * splitPos,
          top: isPortrait ? canvasH * splitPos : 0,
          width: isPortrait ? canvasW : canvasW * (1 - splitPos),
          height: isPortrait ? canvasH * (1 - splitPos) : canvasH,
          overflow: 'hidden',
        }}>
          <ClipMedia
            src={videoRight.src}
            mediaType={videoRight.type}
            muted={videoRight.muted}
            volume={videoRight.volume}
            startFrom={Math.round((videoRight.trimStart || 0) * FPS)}
            endSec={clipEndSec(videoRight)}
            cutsSec={videoRight.cuts}
            style={{
              width: fitRight.width,
              height: fitRight.height,
              transform: `translate(${fitRight.translateX + driftR.x}px, ${fitRight.translateY + driftR.y}px) scale(${breatheR})`,
              objectFit: fitRight.fitMode,
              position: 'absolute',
              // 反向抵消容器偏移，媒体保持全画幅布局（分屏裁切效果）
              left: isPortrait ? 0 : -(canvasW * splitPos),
              top: isPortrait ? -(canvasH * splitPos) : 0,
            }}
          />
        </div>
      )}

      {/* 分屏分隔线（竖版为水平线） */}
      <div style={{
        position: 'absolute',
        left: isPortrait ? 0 : canvasW * splitPos - 2 * u,
        top: isPortrait ? canvasH * splitPos - 2 * u : 0,
        width: isPortrait ? canvasW : 4 * u,
        height: isPortrait ? 4 * u : canvasH,
        background: 'white',
        boxShadow: '0 0 12px rgba(255,255,255,0.5)',
        zIndex: 10,
      }}>
        {/* 中间的指示手柄 */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 36 * u,
          height: 36 * u,
          borderRadius: '50%',
          background: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          fontSize: 16 * u,
          color: '#111827',
        }}>
          {isPortrait ? '⇅' : '⇋'}
        </div>
      </div>
      </div>

      {/* 文字标签 */}
      {text.title && (
        <div style={{
          position: 'absolute',
          top: 20 * u,
          left: 0,
          right: 0,
          textAlign: 'center',
          zIndex: 20,
        }}>
          <span style={{
            background: 'rgba(0,0,0,0.6)',
            color: style?.title?.color ?? 'white',
            padding: '6px 16px',
            borderRadius: 20,
            fontSize: style?.title?.fontSize ?? tokens.fontSize.body * 0.85,
            fontWeight: style?.title?.fontWeight ?? 600,
            fontFamily: VIDEO_DESIGN.titleFont,
            ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
            ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
            ...textStrokeCss(style?.title),
          }}>
            {text.title}
          </span>
        </div>
      )}

      {/* 功能要点 */}
      {text.features && text.features.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: 20 * u,
          left: 0,
          right: 0,
          textAlign: 'center',
          zIndex: 20,
        }}>
          {text.features.slice(0, 2).map((feat, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                background: i === 0 ? 'rgba(255,255,255,0.9)' : 'rgba(37,99,235,0.9)',
                color: style?.feature?.color ?? (i === 0 ? '#111827' : 'white'),
                padding: '4px 12px',
                borderRadius: 12,
                fontSize: style?.feature?.fontSize ?? tokens.fontSize.caption * 0.9,
                fontWeight: style?.feature?.fontWeight ?? 600,
                fontFamily: VIDEO_DESIGN.bodyFont,
                margin: '0 4px',
                ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                ...textStrokeCss(style?.feature),
              }}
            >
              ✦ {feat}
            </span>
          ))}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default SplitCompare;
