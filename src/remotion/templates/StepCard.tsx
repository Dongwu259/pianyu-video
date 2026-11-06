/**
 * 模板: StepCard - 教程步骤卡（教程演示专属家族）
 *
 * 「步骤 N · 名称」的成品卡——教程每步一段的标配：
 * - 大号步骤序号（参数 stepNumber，两位补零，弹簧砸落）+ STEP 小标签
 * - 步骤名大字 + 说明副标题 + 操作要点（带序号圆标，逐条入场）
 * - 可选 1 段操作画面画框（横版右侧 / 竖版顶部；无素材 = 纯文字步骤页）
 *
 * 文案约定：title = 步骤名（如「导出成片」）；subtitle = 这一步达成什么；features = 操作要点 ≤4 条。
 *
 * 个性化参数（paramSpecs: STEP_CARD_PARAMS）：stepNumber 步骤序号（1-99，跨段保持连贯）/
 * videoScale 画框大小 / titleScale 步骤名字号。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {SPRINGS} from '../animations/motion';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {STEP_CARD_PARAMS} from '../../shared/template-registry';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {clipEndSec} from '../../shared/clipCuts';

/** 教程步骤卡的静调色板：白净底 + 深青墨字 + 青绿强调（「可跟着做」的行动感） */
const INK = '#113B36';
const TEAL = '#0D9488';
const BG_TOP = '#FCFDFD';
const BG_BOTTOM = '#EDF6F4';

export const StepCard: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, textAnim, orientation}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.6);

  const p = makeParamReader(STEP_CARD_PARAMS, params);
  const stepNumber = Math.max(1, Math.round(p('stepNumber')));
  const videoScale = p('videoScale');
  const titleScale = p('titleScale');
  const flyVec = directionVector(p('direction'), canvasW * 0.3); // 飞入方向（null=默认原地弹入）

  const features = (text.features ?? []).slice(0, 4);
  const video = videos[0];
  const portrait = orientation === 'portrait';
  const stepLabel = String(stepNumber).padStart(2, '0');

  // 序号砸落（同 vlog 打卡的印章语感，但更利落）
  const stamp = spring({
    frame: frame - 2,
    fps: FPS,
    config: SPRINGS.cardSettle,
    durationInFrames: Math.round(FPS * 0.7),
  });
  const stampScale = interpolate(stamp, [0, 1], [1.45, 1]);
  const stampOpacity = interpolate(frame - 2, [0, 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const titleStart = Math.round(12 * pace);
  const subtitleStart = Math.round(22 * pace);
  const featureBase = Math.round(30 * pace);

  // 操作画面画框：16:9，横版右侧 / 竖版顶部
  const frameW = portrait
    ? Math.min(canvasW * 0.86 * videoScale, canvasH * 0.38 * (16 / 9))
    : Math.min(canvasW * 0.4 * videoScale, canvasH * 0.58 * (16 / 9));
  const frameH = (frameW * 9) / 16;
  const frameProg = spring({
    frame: frame - Math.round(6 * pace),
    fps: FPS,
    config: SPRINGS.cardSettle,
    durationInFrames: Math.round(FPS * 0.9),
  });
  const frameInScale = interpolate(frameProg, [0, 1], [0.95, 1]);

  // 驻留微运动：入场完成后画框保持缓慢呼吸+漂移、文字区轻微漂移（P2 质感）
  const frameBreathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const frameDrift = dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, 0);
  const textDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, 1.37);

  const renderFrame = () => {
    if (!video) return null;
    const fit = fitVideo(frameW, frameH, video.width, video.height, 'cover');
    const placed = applyViewport(frameW, frameH, fit, 'cover', video.viewport);
    const boxLeft = portrait ? (canvasW - frameW) / 2 : canvasW - frameW - canvasW * 0.07;
    const boxTop = portrait ? canvasH * 0.06 : (canvasH - frameH) / 2;
    return (
      <div
        style={{
          position: 'absolute',
          left: boxLeft,
          top: boxTop,
          width: frameW,
          height: frameH,
          transform: `scale(${frameInScale * frameBreathe})${flyVec ? ` translate(${(1 - frameProg) * flyVec.x}px, ${(1 - frameProg) * flyVec.y}px)` : ''} translate(${frameDrift.x}px, ${frameDrift.y}px)`,
          opacity: fadeIn(frame, Math.round(6 * pace), 10 * pace),
          borderRadius: Math.max(10, frameW * 0.035),
          overflow: 'hidden',
          boxShadow: '0 20px 50px rgba(17, 59, 54, 0.18), 0 5px 14px rgba(17, 59, 54, 0.12)',
          border: '1px solid rgba(13, 148, 136, 0.25)',
          background: '#0B1514',
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
            objectFit: 'cover',
          }}
        />
      </div>
    );
  };

  // 文字区几何：横版在画框左侧，竖版在画框下方
  const textLeft = canvasW * 0.08;
  const textRight = portrait ? canvasW * 0.08 : frameW + canvasW * 0.1;
  const textTop = portrait ? canvasH * 0.46 : canvasH * 0.16;
  const textBottom = portrait ? canvasH * 0.07 : canvasH * 0.14;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill style={{background: `linear-gradient(150deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)`}} />
      )}
      <BackgroundEffectLayer />

      {renderFrame()}

      {/* 步骤文字区（无素材时是主视觉，跟随飞入方向） */}
      <div
        style={{
          position: 'absolute',
          left: textLeft,
          right: textRight,
          top: textTop,
          bottom: textBottom,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: portrait ? 'flex-start' : 'center',
          transform: `${flyVec && !video ? `translate(${(1 - stamp) * flyVec.x}px, ${(1 - stamp) * flyVec.y}px) ` : ''}translate(${textDrift.x}px, ${textDrift.y}px)`,
        }}
      >
        {/* STEP 标签 + 大号序号 */}
        <div style={{display: 'flex', alignItems: 'baseline', gap: tokens.spacing.element}}>
          <span
            style={{
              fontSize: tokens.fontSize.caption,
              fontWeight: 700,
              color: TEAL,
              letterSpacing: '0.3em',
              fontFamily: VIDEO_DESIGN.bodyFont,
              opacity: fadeIn(frame, 0, 10 * pace),
            }}
          >
            STEP
          </span>
          <span
            style={{
              fontSize: tokens.fontSize.title * 1.3,
              fontWeight: 800,
              color: TEAL,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              fontFamily: VIDEO_DESIGN.titleFont,
              transform: `scale(${stampScale})`,
              transformOrigin: 'left bottom',
              opacity: stampOpacity,
              display: 'inline-block',
            }}
          >
            {stepLabel}
          </span>
          {/* 序号底部短横（与标题区的连接件） */}
          <span
            style={{
              flex: 1,
              maxWidth: canvasW * 0.14,
              height: Math.max(3, canvasW * 0.004),
              borderRadius: 2,
              background: TEAL,
              opacity: 0.35 * stampOpacity,
              alignSelf: 'center',
            }}
          />
        </div>
        {/* 步骤名 */}
        {text.title && (
          <div style={{marginTop: tokens.spacing.element * 0.7}}>
            <AnimatedText
              text={text.title}
              preset={textAnim ?? 'charPop'}
              startFrame={titleStart}
              duration={Math.round(16 * pace)}
              style={{
                fontSize: style?.title?.fontSize ?? tokens.fontSize.title * (portrait ? 0.72 : 0.82) * titleScale,
                fontWeight: style?.title?.fontWeight ?? 800,
                color: style?.title?.color ?? INK,
                letterSpacing: '-0.015em',
                lineHeight: 1.2,
                ...textStrokeCss(style?.title),
              }}
            />
          </div>
        )}
        {text.subtitle && (
          <div style={{marginTop: tokens.spacing.element * 0.6}}>
            <AnimatedText
              text={text.subtitle}
              preset={textAnim ?? 'fadeIn'}
              startFrame={subtitleStart}
              duration={Math.round(14 * pace)}
              style={{
                fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle * 0.88,
                fontWeight: style?.subtitle?.fontWeight ?? 400,
                color: style?.subtitle?.color ?? 'rgba(17, 59, 54, 0.68)',
                fontFamily: VIDEO_DESIGN.bodyFont,
                letterSpacing: '0.02em',
                lineHeight: 1.4,
                ...textStrokeCss(style?.subtitle),
              }}
            />
          </div>
        )}
        {/* 操作要点：序号圆标逐条入场 */}
        {features.length > 0 && (
          <div
            style={{
              marginTop: tokens.spacing.section * 0.65,
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing.element * 0.65,
            }}
          >
            {features.map((feature, i) => {
              const start = featureBase + i * 9 * pace;
              return (
                <div key={i} style={{display: 'flex', alignItems: 'flex-start', gap: tokens.spacing.element * 0.7}}>
                  <div
                    style={{
                      width: tokens.fontSize.body * 0.88,
                      height: tokens.fontSize.body * 0.88,
                      borderRadius: '50%',
                      background: 'rgba(13, 148, 136, 0.12)',
                      border: `${Math.max(1.5, canvasW * 0.0018)}px solid ${TEAL}`,
                      color: TEAL,
                      fontSize: tokens.fontSize.body * 0.55,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      marginTop: tokens.fontSize.body * 0.1,
                      opacity: fadeIn(frame, start, 8 * pace),
                      fontFamily: VIDEO_DESIGN.bodyFont,
                    }}
                  >
                    {i + 1}
                  </div>
                  <AnimatedText
                    text={feature}
                    preset={textAnim ?? 'fadeIn'}
                    startFrame={Math.round(start)}
                    duration={Math.round(10 * pace)}
                    style={{
                      fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * 0.9,
                      fontWeight: style?.feature?.fontWeight ?? 500,
                      color: style?.feature?.color ?? 'rgba(17, 59, 54, 0.85)',
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      letterSpacing: '0.02em',
                      lineHeight: 1.4,
                      ...textStrokeCss(style?.feature),
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

export default StepCard;
