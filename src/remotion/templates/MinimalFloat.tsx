/**
 * 模板 5: MinimalFloat - 极简悬浮展示
 *
 * 画面结构：
 * - 纯白/米色背景（苹果风格）
 * - 单段视频轻微 3D 倾斜悬浮于画面中央
 * - 视频下方极简产品标语
 * - 无多余装饰元素，留白 > 50%
 *
 * 个性化参数（paramSpecs: MINIMAL_FLOAT_PARAMS）：videoScale 画框大小 / floatAmp 悬浮幅度 / tiltZ 倾斜角度。
 */

import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Video3D} from '../layers/Video3D';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {calculateSlotTiming, trailingForExit} from '../utils/timing';
import {fadeIn} from '../animations/keyframes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {MINIMAL_FLOAT_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const MinimalFloat: React.FC<TemplateProps> = ({
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
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const slots = calculateSlotTiming(videoCount, totalDurationFrames, 20, trailingForExit(exitStyle, 40));

  // 个性化参数（故事板「参数」页滑块；未调整走 MINIMAL_FLOAT_PARAMS 默认值）
  const p = makeParamReader(MINIMAL_FLOAT_PARAMS, params);
  const videoScale = p('videoScale'); // 视频框尺寸倍率
  const floatAmp = p('floatAmp');     // 悬浮振幅倍率（0 = 静止）
  const tiltZ = p('tiltZ');           // Z 轴静态倾斜角（°，直接值）
  const flyVec = directionVector(p('direction'), canvasW * 0.3); // 飞入方向（null=默认原地淡入）

  // 极简：画框更大、留白更多
  const frameW = canvasW * (layout?.videoWidthRatio ?? 0.7) * videoScale;
  const frameH = canvasH * (layout?.videoHeightRatio ?? 0.45) * videoScale;
  const centerX = (canvasW - frameW) / 2 + canvasW * (layout?.videoOffsetX ?? 0);
  const frameY = canvasH * 0.2 + canvasH * (layout?.videoOffsetY ?? 0);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="solid-white" />
      )}
      <BackgroundEffectLayer />

      {/* 视频 */}
      {videos.map((video, i) => {
        const slot = slots[i];
        if (frame < slot.startFrame) return null;

        const localFrame = frame - slot.startFrame;

        // 缓慢浮动（floatAmp = 0 时静止）
        const floatY = Math.sin(localFrame * 0.025) * 6 * floatAmp;
        // 飞入方向：0.67s 入场包络驱动方向位移；0=自动时 flyVec=null 零位移
        const entry = flyVec
          ? interpolate(localFrame, [0, 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
          : 1;

        return (
          <Sequence key={video.id} from={slot.startFrame} durationInFrames={slot.durationInFrames + 30}>
            {/* 注意：Sequence 内 useCurrentFrame 是相对帧，淡入淡出用槽内相对帧（0 ~ durationInFrames） */}
            <Video3D
              src={video.src}
              mediaType={video.type}
              muted={video.muted}
              volume={video.volume}
              w={frameW}
              h={frameH}
              vw={video.width}
              vh={video.height}
              perspective={layout?.perspective ?? 1800}
              rotateX={layout?.rotateX ?? 3}
              rotateY={layout?.rotateY ?? -6}
              rotateZ={tiltZ}
              x={centerX + (flyVec ? (1 - entry) * flyVec.x : 0)}
              y={frameY + floatY + (flyVec ? (1 - entry) * flyVec.y : 0)}
              scale={layout?.scale ?? 1}
              shadow
              fit={video.fit}
              viewport={video.viewport}
              clicks={video.cursorClicks}

              cursorPoints={video.cursorPoints}
              borderRadius={layout?.borderRadius ?? 16}
              fadeInFrame={0}
              fadeOutFrame={slot.durationInFrames}
              startFrom={Math.round((video.trimStart || 0) * FPS)}
              endSec={clipEndSec(video)}
              cutsSec={video.cuts}
            />
          </Sequence>
        );
      })}

      {/* 极简文字 */}
      {text.title && (
        <div style={{position: 'absolute', bottom: canvasH * 0.12, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={20}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.75,
              fontWeight: style?.title?.fontWeight ?? 300, /* 细字重 → 高级感 */
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              letterSpacing: '0.05em',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: 16}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={30}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                  fontWeight: style?.subtitle?.fontWeight ?? 300,
                  color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
                  letterSpacing: '0.08em',
                  ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                  ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 片尾品牌名 */}
      {text.brandName && frame > totalDurationFrames - 40 && (
        <div
          style={{
            position: 'absolute',
            top: canvasH * 0.06,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: fadeIn(frame, totalDurationFrames - 40, 15),
            fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
            fontWeight: style?.brand?.fontWeight ?? 400,
            fontFamily: VIDEO_DESIGN.bodyFont,
            color: style?.brand?.color ?? VIDEO_DESIGN.colors.textMuted,
            letterSpacing: '0.15em',
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

export default MinimalFloat;
