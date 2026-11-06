/**
 * 模板 1: RevealSlide - 3D 倾斜平推展示
 *
 * 画面结构：
 * - 浅色渐变背景
 * - 视频片段以 3D 倾斜角度从左到右平推展示
 * - 多段视频依次序列化出现
 * - 底部标题文字从下方淡入
 *
 * 个性化参数（paramSpecs: REVEAL_SLIDE_PARAMS）：pipScale 画框大小 / tiltX 倾斜角 / swingAngle 进出摆角 / slideDistance 平推距离 / titleScale 标题字号。
 */

import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate as remotionInterpolate} from 'remotion';
import {Video3D} from '../layers/Video3D';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {calculateSlotTiming, trailingForExit} from '../utils/timing';
import {fadeIn, leftToRight} from '../animations/keyframes';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {REVEAL_SLIDE_PARAMS} from '../../shared/template-registry';
import {beatGapSec, snapFrameToBeat} from '../../shared/beat-grid';
import {clipEndSec} from '../../shared/clipCuts';

export const RevealSlide: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
  exitStyle,
  beatGrid,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const videoCount = Math.max(videos.length, 1);
  const totalDurationFrames = Math.round((segmentDuration || 8) * FPS);

  // 个性化参数（故事板「参数」页滑块；未调整走 REVEAL_SLIDE_PARAMS 默认值）
  const p = makeParamReader(REVEAL_SLIDE_PARAMS, params);
  const pipScale = p('pipScale');           // 视频画框整体尺寸倍率
  const tiltX = p('tiltX');                 // 3D 倾斜角（度，直接值，作用在视频框 rotateX）
  const swingAngle = p('swingAngle');       // 进出摆角幅度（度，rotateY 摆入/摆出峰值，0 = 无摆动）
  const slideDistance = p('slideDistance'); // 入场平推行程倍率（0 = 原地静止）
  const titleScale = p('titleScale');       // 底部标题字号倍率
  // 平推方向（0=自动=从左到右）：单位来向向量（上(0,-1)/下(0,1)/左(-1,0)/右(1,0)）
  const dirVec = directionVector(p('direction'), 1);
  const verticalPan = !!dirVec && dirVec.y !== 0; // 垂直平推时摆角从 rotateY 换到 rotateX

  const slots = calculateSlotTiming(videoCount, totalDurationFrames, 15, trailingForExit(exitStyle, 45));

  // 入场落拍（B2）：beatGrid 存在时把入场「到位帧」吸附到最近拍点（平移上限半拍距、
  // 至多 0.3s，拍点太远宁可漂移不抢拍）；缺省零改动。标题入场同理。
  const beatMaxShift = beatGrid ? Math.min(0.3, (beatGapSec(beatGrid.beatsSec, beatGrid.bpm) ?? 0.5) / 2) : 0;
  const snapToBeat = (frame: number): number =>
    beatGrid ? snapFrameToBeat(frame, FPS, beatGrid.beatsSec, {maxShiftSec: beatMaxShift}) : frame;
  const titleStartFrame = snapToBeat(15);

  const frameW = canvasW * (layout?.videoWidthRatio ?? 0.6) * pipScale;
  const frameH = canvasH * (layout?.videoHeightRatio ?? 0.5) * pipScale;
  const offsetX = canvasW * (layout?.videoOffsetX ?? 0);
  const offsetY = canvasH * (layout?.videoOffsetY ?? 0);
  const frameY = canvasH * 0.25 + offsetY;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {videos.map((video, i) => {
        const slot = slots[i];
        if (frame < slot.startFrame) return null;

        const localFrame = frame - slot.startFrame;
        const slotDuration = slot.durationInFrames;

        // 平推行程按倍率缩放（围绕原行程中心，倍率 1 时 offsetRatio 恰为默认 0.3，0 = 静止不动）
        // 终点锚定画框水平居中基准（而非固定 −0.2W 偏移），slideDistance = 0 时停在居中位置
        const centerBase = (canvasW - frameW) / 2;
        const s = leftToRight(localFrame, slotDuration, canvasW, 0.3 * slideDistance);
        // 方向平推：从来向一侧穿到对侧（dir=3 左→右与原默认一致）；0=自动保持原不对称漂移公式零回归
        const x = dirVec
          ? centerBase + offsetX - dirVec.x * s
          : s - 0.3 * slideDistance * canvasW + centerBase + offsetX;
        const y = dirVec ? frameY - dirVec.y * s : frameY;

        // 进出倾斜角（beatGrid 存在时入场到位帧吸附拍点：落拍而非漂移在拍间，
        // 钳 [8, 60%槽长] 防吞槽；无 beatGrid 走原 30% 槽长零回归）
        const naturalEnd = Math.floor(slotDuration * 0.3);
        const entranceEnd = beatGrid
          ? Math.min(
              Math.floor(slotDuration * 0.6),
              Math.max(8, snapToBeat(slot.startFrame + naturalEnd) - slot.startFrame),
            )
          : naturalEnd;
        const exitStart = Math.floor(slotDuration * 0.7);
        const tiltSign = i % 2 === 0 ? 1 : -1;

        let rotateY = 0;
        if (localFrame < entranceEnd) {
          rotateY = remotionInterpolate(localFrame, [0, entranceEnd], [swingAngle * tiltSign, 0], {extrapolateRight: 'clamp'});
        } else if (localFrame > exitStart) {
          rotateY = remotionInterpolate(localFrame, [exitStart, slotDuration], [0, -swingAngle * tiltSign], {extrapolateLeft: 'clamp'});
        }

        // 驻留微运动：入场完成后画框保持缓慢呼吸+漂移（P2 质感，phase 按片段错开）
        const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, i * 1.37);
        const drift = dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, i * 1.37);

        return (
          <Sequence key={video.id} from={slot.startFrame} durationInFrames={slotDuration + 30}>
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
              perspective={layout?.perspective ?? VIDEO_DESIGN.perspective}
              rotateX={tiltX + (verticalPan ? rotateY : 0)}
              rotateY={(layout?.rotateY ?? 0) + (verticalPan ? 0 : rotateY)}
              x={x + drift.x}
              y={y + drift.y}
              scale={(layout?.scale ?? 1) * breathe}
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
          </Sequence>
        );
      })}

      {/* 标题文字 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            bottom: canvasH * 0.12,
            left: 0,
            right: 0,
            textAlign: 'center',
          }}
        >
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={titleStartFrame}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * titleScale,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              letterSpacing: '-0.02em',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: 12}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={titleStartFrame + 10}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
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
      {text.brandName && frame > totalDurationFrames - 60 && (
        <div
          style={{
            position: 'absolute',
            top: canvasH * 0.08,
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
