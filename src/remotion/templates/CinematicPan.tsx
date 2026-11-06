/**
 * 模板 3: CinematicPan - 电影感环绕运镜
 *
 * 画面结构：
 * - 暗色渐变背景
 * - 视频片段在画面中缓慢"漂浮"
 * - rotateY 在 -10° 到 +10° 之间缓动摆动
 * - 每段视频配有独立的功能描述文字，渐显出现在视频上方
 *
 * 个性化参数（paramSpecs: CINEMATIC_PAN_PARAMS）：videoScale 视频画框大小 / floatAmp 漂浮幅度（0 = 静止） / orbitSpeed 环绕运镜速度。
 */

import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video3D} from '../layers/Video3D';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {calculateSlotTiming, trailingForExit} from '../utils/timing';
import {gentleRotate, fadeIn} from '../animations/keyframes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {CINEMATIC_PAN_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const CinematicPan: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
  exitStyle,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const videoCount = Math.max(videos.length, 1);
  const totalDurationFrames = Math.round((segmentDuration || 10) * FPS);
  const slots = calculateSlotTiming(videoCount, totalDurationFrames, 30, trailingForExit(exitStyle, 60));

  // 个性化参数（故事板「参数」页滑块；未调整走 CINEMATIC_PAN_PARAMS 默认值）
  const p = makeParamReader(CINEMATIC_PAN_PARAMS, params);
  const videoScale = p('videoScale');  // 视频画框尺寸倍率
  const floatAmp = p('floatAmp');      // 漂浮运动振幅倍率（0 = 静止）
  const orbitSpeed = p('orbitSpeed');  // 环绕运镜速度倍率

  const frameW = canvasW * (layout?.videoWidthRatio ?? 0.65) * videoScale;
  const frameH = canvasH * (layout?.videoHeightRatio ?? 0.45) * videoScale;
  const centerX = (canvasW - frameW) / 2 + canvasW * (layout?.videoOffsetX ?? 0);
  const videoY = canvasH * 0.28 + canvasH * (layout?.videoOffsetY ?? 0);
  // 固定 px 偏移按 1920 基准画宽等比缩放（竖版不压到画框外）
  const u = canvasW / 1920;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 标题 */}
      {text.title && (
        <div style={{position: 'absolute', top: canvasH * 0.1, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'scaleIn'}
            startFrame={8}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.85,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              letterSpacing: '-0.01em',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
        </div>
      )}

      {/* 视频序列 */}
      {videos.map((video, i) => {
        const slot = slots[i];
        if (frame < slot.startFrame) return null;

        const localFrame = frame - slot.startFrame;
        const slotDuration = slot.durationInFrames;

        // 漂浮 Y 轴（缓慢上下浮动，振幅倍率 0 = 静止）
        const floatY = Math.sin(localFrame * 0.03) * 8 * floatAmp;

        // 3D 环绕摆动（运镜速度倍率可调）
        const rotateY = gentleRotate(localFrame, 10, 0.015 * orbitSpeed);
        const rotateX = gentleRotate(localFrame + 30, 3, 0.008 * orbitSpeed);

        return (
          <Sequence key={video.id} from={slot.startFrame} durationInFrames={slotDuration + 30}>
            {/* 注意：Sequence 内 useCurrentFrame 是相对帧，淡入淡出及功能文字帧均用槽内相对帧 */}
            <Video3D
              src={video.src}
              mediaType={video.type}
              muted={video.muted}
              volume={video.volume}
              w={frameW}
              h={frameH}
              vw={video.width}
              vh={video.height}
              perspective={layout?.perspective ?? 2000}
              rotateX={(layout?.rotateX ?? 0) + rotateX}
              rotateY={(layout?.rotateY ?? 0) + rotateY}
              x={centerX + Math.sin(localFrame * 0.01) * 20 * floatAmp}
              y={videoY + floatY}
              scale={layout?.scale ?? 1}
              borderRadius={layout?.borderRadius ?? 12}
              shadow
              fit={video.fit}
              viewport={video.viewport}
              clicks={video.cursorClicks}

              cursorPoints={video.cursorPoints}
              fadeInFrame={0}
              fadeOutFrame={slotDuration}
              startFrom={Math.round((video.trimStart || 0) * FPS)}
              endSec={clipEndSec(video)}
              cutsSec={video.cuts}
            />

              {/* 功能描述文字 */}
              {text.features?.[i] && (
                <div
                  style={{
                    position: 'absolute',
                    left: canvasW * 0.15,
                    top: videoY - 60 * u,
                    opacity: fadeIn(localFrame, 15, 20),
                  }}
                >
                  <AnimatedText
                    text={text.features[i]}
                    preset={textAnim ?? 'fadeIn'}
                    startFrame={15}
                    style={{
                      fontSize: style?.feature?.fontSize ?? tokens.fontSize.body,
                      color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                      ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                      ...textStrokeCss(style?.feature),
                    }}
                  />
                </div>
              )}
          </Sequence>
        );
      })}

      {/* 光晕装饰 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'radial-gradient(ellipse at 50% 50%, rgba(37, 99, 235, 0.08) 0%, transparent 60%)',
          pointerEvents: 'none',
        }}
      />

      {/* 片尾品牌名 */}
      {text.brandName && frame > totalDurationFrames - 60 && (
        <div
          style={{
            position: 'absolute',
            bottom: canvasH * 0.1,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: fadeIn(frame, totalDurationFrames - 60, 20),
            fontSize: style?.brand?.fontSize ?? tokens.fontSize.brand,
            fontWeight: style?.brand?.fontWeight ?? 600,
            fontFamily: VIDEO_DESIGN.titleFont,
            color: style?.brand?.color ?? VIDEO_DESIGN.colors.accent,
            ...(style?.brand?.textDecoration ? {textDecoration: style.brand.textDecoration} : {}),
            ...(style?.brand?.fontStyle ? {fontStyle: style.brand.fontStyle} : {}),
            ...textStrokeCss(style?.brand),
          }}
        >
          {text.brandName}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default CinematicPan;
