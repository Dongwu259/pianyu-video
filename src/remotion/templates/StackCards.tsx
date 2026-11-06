/**
 * 模板 2: StackCards - 卡片堆叠翻转
 *
 * 画面结构：
 * - 浅色背景，中央"卡片堆叠"排列
 * - 前景卡片 3D 倾斜展示当前视频
 * - 背景卡片虚化缩小显示"即将播放"
 * - 切换时卡片沿 Y 轴翻转 90°
 * - 功能要点文字以打字效果逐条出现
 *
 * 个性化参数（paramSpecs: STACK_CARDS_PARAMS）：cardScale 卡片大小 / cardGap 堆叠间距 / flipSpeed 翻转速度 / titleScale 标题与要点字号。
 */

import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Video3D} from '../layers/Video3D';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {calculateSlotTiming, trailingForExit} from '../utils/timing';
import {popIn} from '../animations/keyframes';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {STACK_CARDS_PARAMS} from '../../shared/template-registry';
import {beatGapSec, snapFrameToBeat} from '../../shared/beat-grid';
import {clipEndSec} from '../../shared/clipCuts';

export const StackCards: React.FC<TemplateProps> = ({
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
  const totalDurationFrames = Math.round((segmentDuration || 10) * FPS);
  const slots = calculateSlotTiming(videoCount, totalDurationFrames, 20, trailingForExit(exitStyle, 60));

  // 个性化参数（故事板「参数」页滑块；未调整走 STACK_CARDS_PARAMS 默认值）
  const p = makeParamReader(STACK_CARDS_PARAMS, params);
  const cardScale = p('cardScale');   // 卡片尺寸倍率
  const cardGap = p('cardGap');       // 堆叠卡片偏移距离倍率
  const flipSpeed = p('flipSpeed');   // 翻转动画速度倍率（>1 更快）
  const titleScale = p('titleScale'); // 标题/要点字号倍率
  const flyVec = directionVector(p('direction'), canvasW * 0.35); // 飞入方向（null=默认原地弹入）

  // 入场落拍（B2）：beatGrid 存在时把翻转/要点的「到位帧」吸附到最近拍点
  // （平移上限半拍距、至多 0.3s，拍点太远宁可漂移不抢拍）；缺省零改动。
  const beatMaxShift = beatGrid ? Math.min(0.3, (beatGapSec(beatGrid.beatsSec, beatGrid.bpm) ?? 0.5) / 2) : 0;
  const snapToBeat = (frame: number): number =>
    beatGrid ? snapFrameToBeat(frame, FPS, beatGrid.beatsSec, {maxShiftSec: beatMaxShift}) : frame;

  // 固定 px 元素（标题边距/堆叠偏移/序号徽标）按 1920 基准画宽等比缩放
  const u = canvasW / 1920;
  const frameW = canvasW * (layout?.videoWidthRatio ?? 0.55) * cardScale;
  const frameH = canvasH * (layout?.videoHeightRatio ?? 0.55) * cardScale;
  const centerX = (canvasW - frameW) / 2 + canvasW * (layout?.videoOffsetX ?? 0);
  const centerY = canvasH * 0.18 + canvasH * (layout?.videoOffsetY ?? 0);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 标题 */}
      {text.title && (
        <div style={{position: 'absolute', top: 40 * u, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={5}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.8 * titleScale,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
        </div>
      )}

      {/* 视频卡片堆叠 */}
      {videos.map((video, i) => {
        const slot = slots[i];
        if (frame < slot.startFrame) return null;
        if (frame > slot.endFrame + 20) return null;

        const localFrame = frame - slot.startFrame;
        const slotDuration = slot.durationInFrames;

        const stackOffset = (i % 3) * 12 * u * cardGap; // 视觉堆叠偏移（间距倍率可调；px 随画幅缩放）
        const scale = popIn(localFrame, 0, FPS);
        // 飞入方向：入场进度（弹簧回弹截到 [0,1]）驱动方向位移；0=自动时 flyVec=null 零位移
        const entry = Math.min(1, Math.max(0, scale));
        const flyX = flyVec ? (1 - entry) * flyVec.x : 0;
        const flyY = flyVec ? (1 - entry) * flyVec.y : 0;

        // 翻转效果（进场时；速度倍率 >1 更快，除零保护）
        // beatGrid 存在时翻转到位帧吸附最近拍点（落拍；钳 [6,40] 帧防拖垮/瞬移），缺省零回归
        const naturalFlip = 20 / Math.max(flipSpeed, 0.05);
        const flipLen = beatGrid
          ? Math.min(40, Math.max(6, snapToBeat(slot.startFrame + Math.round(naturalFlip)) - slot.startFrame))
          : naturalFlip;
        const flipY = interpolate(localFrame, [0, flipLen], [-60, 0], {extrapolateRight: 'clamp'});

        // 驻留微运动：入场完成后卡片保持缓慢呼吸+漂移（phase 按卡片错开，防同频）
        const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, i * 1.37);
        const drift = dwellDrift(frame, FPS, 4 * u, 3 * u, 9, i * 1.37);

        return (
          <Sequence key={video.id} from={slot.startFrame} durationInFrames={slotDuration + 40}>
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
              perspective={layout?.perspective ?? 1500}
              rotateX={layout?.rotateX ?? 0}
              rotateY={(layout?.rotateY ?? 0) + flipY}
              x={centerX + stackOffset + flyX + drift.x}
              y={centerY + stackOffset + flyY + drift.y}
              scale={Math.min(1, scale) * (layout?.scale ?? 1) * breathe}
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

            {/* 卡片编号指示器 */}
            <div
              style={{
                position: 'absolute',
                left: centerX + stackOffset + flyX + drift.x + frameW / 2 - 16 * u,
                top: centerY + stackOffset + flyY + drift.y - 40 * u,
                width: 32 * u,
                height: 32 * u,
                borderRadius: '50%',
                backgroundColor: VIDEO_DESIGN.colors.accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontFamily: VIDEO_DESIGN.bodyFont,
                fontSize: 16 * u,
                fontWeight: 600,
                opacity: interpolate(localFrame, [10, 20], [0, 1], {extrapolateRight: 'clamp'}),
              }}
            >
              {i + 1}
            </div>
          </Sequence>
        );
      })}

      {/* 功能要点文字区 */}
      {text.features && text.features.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: canvasH * 0.08,
            left: canvasW * 0.1,
            right: canvasW * 0.1,
            textAlign: 'center',
          }}
        >
          {text.features.map((feat, i) => {
            // 要点逐条压拍（beatGrid 存在时吸附最近拍点，缺省 30+i*40 零回归）
            const featStartFrame = snapToBeat(30 + i * 40);
            return (
              <div key={i} style={{marginBottom: 8}}>
                <AnimatedText
                  text={`• ${feat}`}
                  preset={textAnim ?? 'fadeIn'}
                  startFrame={featStartFrame}
                  style={{
                    fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * titleScale,
                    color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBody,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                    ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                    ...textStrokeCss(style?.feature),
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* 片尾品牌名 */}
      {text.brandName && frame > totalDurationFrames - 50 && (
        <div
          style={{
            position: 'absolute',
            top: canvasH * 0.45,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: interpolate(frame, [totalDurationFrames - 50, totalDurationFrames - 30], [0, 1], {}),
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

export default StackCards;
