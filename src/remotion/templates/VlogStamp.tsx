/**
 * 模板: VlogStamp - vlog 日期地点打卡（vlog 专属家族）
 *
 * 画面结构（手账/印章风，零素材）：
 * - 暖纸色渐变背景 + 细边框（像一页旅行手帐）
 * - 大号日期/天数（title，印章式砸落：大缩放回弹 + 轻微旋转），地点行（subtitle）带琥珀色标记条
 * - features 每行一枚圆角胶囊标签（「自驾」「日出」「篝火」…≤4 枚，依次弹入）
 * - 右上角 REC 红点呼吸 + 左下角可选 brandName 小字（同全站惯例）
 *
 * 文案约定：title = 日期或 DAY N（如「07·21」/「DAY 1」）；subtitle = 地点；features = 小标签。
 *
 * 个性化参数（paramSpecs: VLOG_STAMP_PARAMS）：titleScale 日期字号 / tagDelay 标签节奏。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {SPRINGS} from '../animations/motion';
import {dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {textStrokeCss} from '../utils/textStroke';
import {VLOG_STAMP_PARAMS} from '../../shared/template-registry';

/** vlog 家族暖色（区别于品牌蓝的商务感）：墨色字 + 琥珀强调 + 纸色底 */
const INK = '#292524';
const AMBER = '#D97706';
const PAPER_TOP = '#FBF7EF';
const PAPER_BOTTOM = '#F1E8D8';

export const VlogStamp: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 3) * FPS);
  // 3s 基准伸缩动效节奏（下限 0.5 防 1s 短卡挤成一团）
  const pace = Math.max(totalDurationFrames / (3 * FPS), 0.5);

  const p = makeParamReader(VLOG_STAMP_PARAMS, params);
  const titleScale = p('titleScale');
  const tagDelay = p('tagDelay');

  const features = (text.features ?? []).slice(0, 4);
  // 印章砸落：scale 1.5 → 1 + 轻微旋正（spring 过冲一次），opacity 前几帧快进
  const stamp = spring({
    frame: frame - Math.round(3 * pace),
    fps: FPS,
    config: SPRINGS.cardSettle,
    durationInFrames: Math.round(FPS * 0.7),
  });
  const stampScale = interpolate(stamp, [0, 1], [1.5, 1]);
  const stampRot = interpolate(stamp, [0, 1], [-6, 0]);
  const stampOpacity = interpolate(frame - Math.round(3 * pace), [0, 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // REC 红点呼吸（1.2s 一个周期）
  const recPulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(frame / (FPS * 1.2) * Math.PI * 2));
  const subtitleStart = Math.round((14 + 10 * (1 - stamp)) * pace);

  // 驻留微运动：入场完成后印章/标签保持缓慢漂移（纯文字不加缩放，P2 质感）
  const stampDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, 0);

  const padX = canvasW * 0.1;
  const titleSize = style?.title?.fontSize ?? tokens.fontSize.title * 1.15 * titleScale;

  return (
    <AbsoluteFill>
      {/* 暖纸底（可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill style={{background: `linear-gradient(160deg, ${PAPER_TOP} 0%, ${PAPER_BOTTOM} 100%)`}} />
      )}
      {/* 手帐内边框（细双线感：外细线 + 内留白） */}
      <div
        style={{
          position: 'absolute',
          inset: Math.min(canvasW, canvasH) * 0.035,
          border: `${Math.max(2, Math.round(canvasW * 0.003))}px solid rgba(41, 37, 36, 0.22)`,
          borderRadius: Math.max(10, canvasW * 0.012),
          pointerEvents: 'none',
        }}
      />
      <BackgroundEffectLayer />

      {/* 右上角 REC 取景标记 */}
      <div
        style={{
          position: 'absolute',
          top: Math.min(canvasW, canvasH) * 0.07,
          right: Math.min(canvasW, canvasH) * 0.07,
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing.tight,
          opacity: fadeIn(frame, 2, 10 * pace),
          fontFamily: VIDEO_DESIGN.bodyFont,
          letterSpacing: '0.22em',
          fontSize: tokens.fontSize.caption,
          color: 'rgba(41, 37, 36, 0.65)',
        }}
      >
        <div
          style={{
            width: tokens.fontSize.caption * 0.55,
            height: tokens.fontSize.caption * 0.55,
            borderRadius: '50%',
            background: '#DC2626',
            opacity: recPulse,
          }}
        />
        REC
      </div>

      {/* 主体：日期印章 + 地点 + 标签胶囊 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: canvasH * 0.16,
          bottom: canvasH * 0.16,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        {text.title && (
          <div
            style={{
              transform: `scale(${stampScale}) rotate(${stampRot}deg) translate(${stampDrift.x}px, ${stampDrift.y}px)`,
              transformOrigin: 'left center',
              opacity: stampOpacity,
            }}
          >
            <AnimatedText
              text={text.title}
              preset={textAnim ?? 'fadeIn'}
              startFrame={Math.round(3 * pace)}
              duration={Math.round(10 * pace)}
              style={{
                fontSize: titleSize,
                fontWeight: style?.title?.fontWeight ?? 800,
                color: style?.title?.color ?? INK,
                letterSpacing: '-0.01em',
                lineHeight: 1.05,
                ...textStrokeCss(style?.title),
              }}
            />
          </div>
        )}
        {/* 地点行：琥珀标记条 + 副标题（无标题时独立承担主文案） */}
        {(text.subtitle || !text.title) && text.subtitle && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing.element,
              marginTop: tokens.spacing.element,
              opacity: fadeIn(frame, subtitleStart, 12 * pace),
              transform: `translateY(${interpolate(frame, [subtitleStart, subtitleStart + 12 * pace], [14, 0], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}px)`,
            }}
          >
            <div style={{width: Math.max(6, canvasW * 0.008), height: tokens.fontSize.subtitle * 0.9, borderRadius: 4, background: AMBER, flexShrink: 0}} />
            <AnimatedText
              text={text.subtitle}
              preset={textAnim ?? 'fadeIn'}
              startFrame={subtitleStart}
              duration={Math.round(12 * pace)}
              style={{
                fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle,
                fontWeight: style?.subtitle?.fontWeight ?? 500,
                color: style?.subtitle?.color ?? 'rgba(41, 37, 36, 0.78)',
                fontFamily: VIDEO_DESIGN.bodyFont,
                letterSpacing: '0.04em',
                lineHeight: 1.3,
                ...textStrokeCss(style?.subtitle),
              }}
            />
          </div>
        )}
        {/* 标签胶囊：依次弹入 */}
        {features.length > 0 && (
          <div
            style={{
              marginTop: tokens.spacing.section * 0.8,
              display: 'flex',
              flexWrap: 'wrap',
              gap: tokens.spacing.element * 0.8,
            }}
          >
            {features.map((feature, i) => {
              const start = Math.round((26 + i * 8 * tagDelay) * pace);
              const pop = spring({
                frame: frame - start,
                fps: FPS,
                config: SPRINGS.cardSettle,
                durationInFrames: Math.round(FPS * 0.5),
              });
              const popScale = interpolate(pop, [0, 1], [0.6, 1]);
              const tagDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, i * 1.37);
              return (
                <div
                  key={i}
                  style={{
                    transform: `scale(${popScale}) translate(${tagDrift.x}px, ${tagDrift.y}px)`,
                    opacity: interpolate(frame - start, [0, 3], [0, 1], {
                      extrapolateLeft: 'clamp',
                      extrapolateRight: 'clamp',
                    }),
                    padding: `${tokens.fontSize.caption * 0.28}px ${tokens.fontSize.caption * 0.72}px`,
                    borderRadius: 999,
                    border: `${Math.max(1.5, canvasW * 0.0022)}px solid rgba(217, 119, 6, 0.55)`,
                    color: AMBER,
                    background: 'rgba(217, 119, 6, 0.08)',
                    fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * 0.86,
                    fontWeight: style?.feature?.fontWeight ?? 500,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    letterSpacing: '0.08em',
                    lineHeight: 1.2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {feature}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 品牌名小字（惯例左下角） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.07),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: fadeIn(frame, 12 * pace, 14 * pace),
          }}
        >
          <div
            style={{
              width: Math.max(8, Math.round(tokens.fontSize.caption * 0.45)),
              height: Math.max(8, Math.round(tokens.fontSize.caption * 0.45)),
              borderRadius: '50%',
              background: AMBER,
            }}
          />
          <span
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
              fontWeight: style?.brand?.fontWeight ?? 500,
              color: style?.brand?.color ?? 'rgba(41, 37, 36, 0.6)',
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.14em',
              ...textStrokeCss(style?.brand),
            }}
          >
            {text.brandName}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default VlogStamp;
