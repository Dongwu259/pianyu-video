/**
 * 模板: TalkingPoint - 口播观点卡（口播讲解专属家族）
 *
 * 「出镜画面 + 大字观点」一体的成品卡——口播视频每观点一段的标配：
 * - 横版：左侧竖构图出镜画框（圆角/微倾/软阴影），右侧观点大字 + 副标题 + 要点
 * - 竖版：上方横构图出镜画框，下方观点文字区
 * - 无素材空态：纯文字观点页（照常渲染，不 return null）
 *
 * 文案约定：title = 观点句（一句话先给结论）；subtitle = 补充说明；features = 论据/关键词 ≤3 条。
 *
 * 个性化参数（paramSpecs: TALKING_POINT_PARAMS）：videoScale 画框大小 / titleScale 观点字号 / featureDelay 要点节奏。
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
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {TALKING_POINT_PARAMS} from '../../shared/template-registry';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {clipEndSec} from '../../shared/clipCuts';

/** 口播观点卡的静调色板：浅冷灰底 + 墨字 + 靛蓝强调（观点内容的「可信 + 有态度」） */
const INK = '#0F172A';
const INDIGO = '#4F46E5';
const BG_TOP = '#F8FAFC';
const BG_BOTTOM = '#EDF1F7';

export const TalkingPoint: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, textAnim, orientation}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.6);

  const p = makeParamReader(TALKING_POINT_PARAMS, params);
  const videoScale = p('videoScale');
  const titleScale = p('titleScale');
  const featureDelay = p('featureDelay');

  const features = (text.features ?? []).slice(0, 3);
  const video = videos[0];
  const portrait = orientation === 'portrait';

  // 出镜画框尺寸：横版左侧竖框 4:5，竖版顶部横框 16:9（出镜素材两种构图都常见）
  const frameW = portrait
    ? Math.min(canvasW * 0.86 * videoScale, canvasH * 0.4 * (16 / 9))
    : Math.min(canvasW * 0.34 * videoScale, canvasH * 0.62 * (4 / 5));
  const frameH = portrait ? (frameW * 9) / 16 : (frameW * 5) / 4;

  // 画框入场：轻微缩放落位（克制，出镜画面不宜乱动）
  const frameProg = spring({
    frame: frame - 2,
    fps: FPS,
    config: SPRINGS.cardSettle,
    durationInFrames: Math.round(FPS * 0.9),
  });
  const frameInScale = interpolate(frameProg, [0, 1], [0.94, 1]);
  const frameOpacity = fadeIn(frame, 2, 10 * pace);

  // 驻留微运动：入场完成后画框保持缓慢呼吸+漂移、文字区轻微漂移（P2 质感）
  const frameBreathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const frameDrift = dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, 0);
  const textDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, 1.37);

  const titleStart = Math.round(10 * pace);
  const subtitleStart = Math.round(22 * pace);
  const featureBase = Math.round(30 * pace);

  // 文字区几何：横版在画框右侧，竖版在画框下方
  const textLeft = portrait ? canvasW * 0.08 : canvasW * 0.08 + frameW + canvasW * 0.06;
  const textRight = canvasW * 0.08;
  const textTop = portrait ? canvasH * 0.46 : canvasH * 0.18;
  const textBottom = portrait ? canvasH * 0.07 : canvasH * 0.16;

  // 出镜画框（有素材才有）
  const renderFrame = () => {
    if (!video) return null;
    const fit = fitVideo(frameW, frameH, video.width, video.height, 'cover');
    const placed = applyViewport(frameW, frameH, fit, 'cover', video.viewport);
    const boxLeft = portrait ? (canvasW - frameW) / 2 : canvasW * 0.08;
    const boxTop = portrait ? canvasH * 0.06 : (canvasH - frameH) / 2;
    return (
      <div
        style={{
          position: 'absolute',
          left: boxLeft,
          top: boxTop,
          width: frameW,
          height: frameH,
          transform: `scale(${frameInScale * frameBreathe}) rotate(${portrait ? 0 : -1.5}deg) translate(${frameDrift.x}px, ${frameDrift.y}px)`,
          opacity: frameOpacity,
          borderRadius: Math.max(10, frameW * 0.05),
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(15, 23, 42, 0.22), 0 6px 18px rgba(15, 23, 42, 0.14)',
          border: '1px solid rgba(255, 255, 255, 0.6)',
          background: '#0B0F1A',
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
        {/* 出镜标：画框左上角小胶囊（谁在说话的锚点） */}
        {text.brandName && (
          <div
            style={{
              position: 'absolute',
              left: Math.max(8, frameW * 0.04),
              top: Math.max(8, frameW * 0.04),
              padding: `${tokens.fontSize.caption * 0.18}px ${tokens.fontSize.caption * 0.5}px`,
              borderRadius: 999,
              background: 'rgba(15, 23, 42, 0.55)',
              color: '#F8FAFC',
              fontSize: tokens.fontSize.caption * 0.82,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.08em',
              opacity: fadeIn(frame, Math.round(14 * pace), 10 * pace),
            }}
          >
            {text.brandName}
          </div>
        )}
      </div>
    );
  };

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill style={{background: `linear-gradient(150deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)`}} />
      )}
      {/* 观点引号装饰：右上角超大半透明引号（观点感的锚） */}
      <div
        style={{
          position: 'absolute',
          top: portrait ? canvasH * 0.005 : -canvasH * 0.02,
          right: canvasW * 0.03,
          fontSize: canvasW * (portrait ? 0.16 : 0.12),
          fontWeight: 800,
          color: INDIGO,
          opacity: 0.08 * fadeIn(frame, 0, 20 * pace),
          fontFamily: 'Georgia, serif',
          lineHeight: 1,
          pointerEvents: 'none',
        }}
      >
        ”
      </div>
      <BackgroundEffectLayer />

      {renderFrame()}

      {/* 观点文字区 */}
      <div
        style={{
          position: 'absolute',
          left: video ? textLeft : canvasW * 0.1,
          right: textRight,
          top: textTop,
          bottom: textBottom,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: portrait ? 'flex-start' : 'center',
          transform: `translate(${textDrift.x}px, ${textDrift.y}px)`,
        }}
      >
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={titleStart}
            duration={Math.round(16 * pace)}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * (portrait ? 0.78 : 0.9) * titleScale,
              fontWeight: style?.title?.fontWeight ?? 800,
              color: style?.title?.color ?? INK,
              letterSpacing: '-0.015em',
              lineHeight: 1.22,
              ...textStrokeCss(style?.title),
            }}
          />
        )}
        {text.subtitle && (
          <div style={{marginTop: tokens.spacing.element * 0.8}}>
            <AnimatedText
              text={text.subtitle}
              preset={textAnim ?? 'fadeIn'}
              startFrame={subtitleStart}
              duration={Math.round(14 * pace)}
              style={{
                fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle * 0.9,
                fontWeight: style?.subtitle?.fontWeight ?? 400,
                color: style?.subtitle?.color ?? 'rgba(15, 23, 42, 0.66)',
                fontFamily: VIDEO_DESIGN.bodyFont,
                letterSpacing: '0.02em',
                lineHeight: 1.4,
                ...textStrokeCss(style?.subtitle),
              }}
            />
          </div>
        )}
        {features.length > 0 && (
          <div
            style={{
              marginTop: tokens.spacing.section * 0.7,
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing.element * 0.7,
            }}
          >
            {features.map((feature, i) => {
              const start = featureBase + i * 9 * pace * featureDelay;
              return (
                <div key={i} style={{display: 'flex', alignItems: 'flex-start', gap: tokens.spacing.element * 0.7}}>
                  <div
                    style={{
                      width: Math.max(8, canvasW * 0.004),
                      height: Math.max(8, canvasW * 0.004),
                      borderRadius: '50%',
                      background: INDIGO,
                      marginTop: tokens.fontSize.body * 0.42,
                      flexShrink: 0,
                      opacity: fadeIn(frame, start, 8 * pace),
                    }}
                  />
                  <AnimatedText
                    text={feature}
                    preset={textAnim ?? 'fadeIn'}
                    startFrame={Math.round(start)}
                    duration={Math.round(10 * pace)}
                    style={{
                      fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * 0.92,
                      fontWeight: style?.feature?.fontWeight ?? 500,
                      color: style?.feature?.color ?? 'rgba(15, 23, 42, 0.82)',
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

export default TalkingPoint;
