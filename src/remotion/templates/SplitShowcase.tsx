/**
 * 模板 4: SplitShowcase - 分屏对比展示
 *
 * 画面结构：
 * - 画面左右（横屏）或上下（竖屏）分屏
 * - 左侧/上方播放操作视频（3D 倾斜嵌入）
 * - 右侧/下方是功能文字排版区
 * - 视频切换时左侧退出、下一段进入
 *
 * 个性化参数（paramSpecs: SPLIT_SHOWCASE_PARAMS）：videoRatio 视频区占比 / textScale 文字大小 / featureDelay 要点节奏。
 */

import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video3D} from '../layers/Video3D';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {calculateSlotTiming, trailingForExit} from '../utils/timing';
import {fadeIn} from '../animations/keyframes';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {SPLIT_SHOWCASE_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const SplitShowcase: React.FC<TemplateProps> = ({
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
  const videoCount = Math.max(videos.length, 1);
  const totalDurationFrames = Math.round((segmentDuration || 10) * FPS);
  const slots = calculateSlotTiming(videoCount, totalDurationFrames, 20, trailingForExit(exitStyle, 60));

  const isLandscape = orientation === 'landscape';
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);

  // 个性化参数（故事板「参数」页滑块；未调整走 SPLIT_SHOWCASE_PARAMS 默认值）
  const p = makeParamReader(SPLIT_SHOWCASE_PARAMS, params);
  const videoRatio = p('videoRatio');     // 视频区宽度占比（直接值，仅横屏左右分栏生效）
  const textScale = p('textScale');       // 右侧文字字号倍率
  const featureDelay = p('featureDelay'); // 要点逐条出现的时间间隔倍率（>1 更慢）

  // 分屏布局（横屏时左右分栏比例随 videoRatio 滑动：默认 0.55，边距/间隔各 5%）
  const videoArea = isLandscape
    ? {x: canvasW * 0.05, y: canvasH * 0.1, w: canvasW * (videoRatio - 0.05), h: canvasH * 0.8}
    : {x: canvasW * 0.08, y: canvasH * 0.05, w: canvasW * 0.84, h: canvasH * 0.45};

  const textArea = isLandscape
    ? {x: canvasW * (videoRatio + 0.05), y: canvasH * 0.25, w: canvasW * (0.9 - videoRatio), h: canvasH * 0.5}
    : {x: canvasW * 0.1, y: canvasH * 0.55, w: canvasW * 0.8, h: canvasH * 0.35};

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 视频区 */}
      <div
        style={{
          position: 'absolute',
          left: videoArea.x,
          top: videoArea.y,
          width: videoArea.w,
          height: videoArea.h,
        }}
      >
        {videos.map((video, i) => {
          const slot = slots[i];
          if (frame < slot.startFrame) return null;

          // 驻留微运动：入场完成后视频保持缓慢呼吸+漂移（P2 质感，phase 按片段错开）
          const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, i * 1.37);
          const drift = dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, i * 1.37);

          return (
            <Sequence key={video.id} from={slot.startFrame} durationInFrames={slot.durationInFrames + 30}>
              {/* 注意：Sequence 内 useCurrentFrame 是相对帧，淡入淡出用槽内相对帧（0 ~ durationInFrames） */}
              <Video3D
                src={video.src}
                mediaType={video.type}
                muted={video.muted}
                volume={video.volume}
                w={videoArea.w}
                h={videoArea.h}
                vw={video.width}
                vh={video.height}
                perspective={layout?.perspective ?? 1400}
                rotateX={layout?.rotateX ?? (isLandscape ? 3 : 2)}
                rotateY={layout?.rotateY ?? (isLandscape ? -8 : -5)}
                x={videoArea.w * (layout?.videoOffsetX ?? 0) + drift.x}
                y={videoArea.h * (layout?.videoOffsetY ?? 0) + drift.y}
                scale={(layout?.scale ?? 1) * breathe}
                borderRadius={layout?.borderRadius ?? 12}
                shadow
                fit={video.fit}
              viewport={video.viewport}
              clicks={video.cursorClicks}

              cursorPoints={video.cursorPoints}
                fadeInFrame={0}
                fadeOutFrame={slot.durationInFrames}
                startFrom={Math.round((video.trimStart || 0) * FPS)}
                endSec={clipEndSec(video)}
                cutsSec={video.cuts}
              />
            </Sequence>
          );
        })}
      </div>

      {/* 文字区 */}
      <div
        style={{
          position: 'absolute',
          left: textArea.x,
          top: textArea.y,
          width: textArea.w,
          height: textArea.h,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          paddingLeft: isLandscape ? 20 : 0,
        }}
      >
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={10}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.7 * textScale,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              marginBottom: 20,
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
        )}

        {text.subtitle && (
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={20}
            style={{
              fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle * 0.85 * textScale,
              color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
              marginBottom: 24,
              ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
              ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
              ...textStrokeCss(style?.subtitle),
            }}
          />
        )}

        {/* 功能要点 */}
        {text.features?.map((feat, i) => {
          const featFrame = 30 + i * 35 * featureDelay;
          return (
            <AnimatedText
              key={i}
              text={`✦ ${feat}`}
              preset={textAnim ?? 'charPop'}
              startFrame={featFrame}
              style={{
                fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * 0.9 * textScale,
                color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBody,
                fontFamily: VIDEO_DESIGN.bodyFont,
                marginBottom: 12,
                ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                ...textStrokeCss(style?.feature),
              }}
            />
          );
        })}
      </div>

      {/* 片尾品牌名 */}
      {text.brandName && frame > totalDurationFrames - 50 && (
        <div
          style={{
            position: 'absolute',
            bottom: canvasH * 0.05,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: fadeIn(frame, totalDurationFrames - 50, 20),
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

export default SplitShowcase;
