/**
 * 模板: ComingSoon - 新品预告 / 倒计时（叙事补充场景）
 *
 * 效果: 深色底 + 双光斑缓慢漂移，主文案 charPop、日期分段数字滚动
 * （2026.09.01 → 三组数字各自 00→目标值滚入，保留前导零）、副文案渐入。
 * 市场验证：CapCut 竖版使用量第一的模板原型（81.4K 使用）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 主文案（如「全新 2.0 即将上线」；缺省「敬请期待」）
 * - features[0]: 日期/倒计时文本（「2026.09.01」按 .-/年月日 分段滚动；
 *   非日期文本整段弹入），features 其余行忽略
 * - subtitle: 副文案（如「预约抢先体验」）
 * - brandName: 左下角品牌小字（竖版抬到安全区）
 *
 * 个性化参数（paramSpecs: COMING_SOON_PARAMS）：dateScale 日期字号 /
 * revealSpeed 节奏 / glow 光斑强度。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {entryEase, SPRINGS} from '../animations/motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {parseDateSegments} from '../../shared/promo-text-parse';
import {COMING_SOON_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const ComingSoon: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.5);

  const p = makeParamReader(COMING_SOON_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 数字滚入缓动档位：0=模板原曲线（C 批统一时间语言）
  const dateScale = p('dateScale');     // 日期字号倍率
  const revealSpeed = p('revealSpeed'); // 节奏倍率
  const glow = p('glow');               // 光斑强度（0 = 关）

  const dateText = (text.features ?? [])[0] ?? '';
  const segments = parseDateSegments(dateText);
  const isDate = segments.length >= 2; // 单段（非日期）整段弹入

  // ====== 节奏 ======
  const titleStart = 4 * pace;
  const dateBase = 14 * pace;
  const segStagger = Math.max(3, 6 / revealSpeed) * pace;
  const subtitleStart = dateBase + segments.length * segStagger + 16 * pace;

  // ====== 版式 ======
  const padX = canvasW * 0.1;
  const dateFs = (isPortrait ? canvasW * 0.13 : canvasW * 0.058) * dateScale;
  // 光斑：两个大径向渐变缓慢反向漂移（克制，opacity 随 glow）
  const glowA = glow * 0.16;
  const driftAX = Math.sin(frame * 0.012) * canvasW * 0.06;
  const driftBY = Math.cos(frame * 0.01) * canvasH * 0.05;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}

      {/* 漂移光斑（大气渐变趋势的克制应用：渐变当光用，不当色块用） */}
      {glow > 0 && (
        <>
          <div
            style={{
              position: 'absolute',
              left: canvasW * 0.12 + driftAX,
              top: canvasH * 0.1,
              width: canvasW * 0.55,
              height: canvasW * 0.55,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${ACCENT()}${Math.round(glowA * 255).toString(16).padStart(2, '0')} 0%, transparent 70%)`,
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: canvasW * 0.05,
              bottom: canvasH * 0.12 + driftBY,
              width: canvasW * 0.42,
              height: canvasW * 0.42,
              borderRadius: '50%',
              background: `radial-gradient(circle, #7C3AED${Math.round(glowA * 200).toString(16).padStart(2, '0')} 0%, transparent 70%)`,
              pointerEvents: 'none',
            }}
          />
        </>
      )}
      <BackgroundEffectLayer />

      {/* 内容列：主文案 → 日期分段 → 副文案 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing.paragraph,
        }}
      >
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={Math.round(titleStart)}
            duration={Math.round(18 * pace)}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.78,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              fontFamily: VIDEO_DESIGN.titleFont,
              letterSpacing: '-0.01em',
              lineHeight: 1.25,
              textAlign: 'center',
              ...textStrokeCss(style?.title),
            }}
          />
        )}

        {/* 日期分段：数字滚动（保留前导零）；非日期整段弹入 */}
        {dateText && (
          <div style={{display: 'flex', alignItems: 'baseline', gap: dateFs * 0.12}}>
            {segments.map((seg, i) => {
              const start = dateBase + i * segStagger;
              const value = /^\d+$/.test(seg) ? Number(seg) : null;
              const current =
                value !== null
                  ? Math.round(
                      interpolate(frame, [start, start + 22 * pace], [0, value], {
                        easing: entry,
                        extrapolateLeft: 'clamp',
                        extrapolateRight: 'clamp',
                      }),
                    )
                  : null;
              const appear = spring({frame: frame - Math.round(start), fps: FPS, config: SPRINGS.scaleIn});
              return (
                <React.Fragment key={i}>
                  {i > 0 && isDate && (
                    <span
                      style={{
                        fontSize: dateFs * 0.5,
                        color: ACCENT(),
                        fontWeight: 800,
                        opacity: appear,
                        transform: `scale(${0.5 + appear * 0.5})`,
                      }}
                    >
                      ·
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: dateFs,
                      fontWeight: 800,
                      color: style?.title?.color ?? '#FFFFFF',
                      fontFamily: VIDEO_DESIGN.titleFont,
                      lineHeight: 1.1,
                      letterSpacing: '0.02em',
                      fontVariantNumeric: 'tabular-nums',
                      opacity: value !== null ? Math.min(1, appear * 2) : appear,
                      transform: value === null ? `scale(${0.6 + appear * 0.4})` : undefined,
                      display: 'inline-block',
                    }}
                  >
                    {value !== null ? String(current).padStart(seg.length, '0') : seg}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        )}

        {text.subtitle && (
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeUp'}
            startFrame={Math.round(subtitleStart)}
            duration={Math.round(14 * pace)}
            style={{
              fontSize: tokens.fontSize.subtitle * 0.8,
              fontWeight: 400,
              color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textBodyDark,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.28em',
              lineHeight: 1.4,
              textAlign: 'center',
              ...textStrokeCss(style?.subtitle),
            }}
          />
        )}
      </div>

      {/* 品牌名（深底反白，竖版抬到安全区） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.06),
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
              background: ACCENT(),
            }}
          />
          <span
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
              fontWeight: style?.brand?.fontWeight ?? 500,
              color: style?.brand?.color ?? VIDEO_DESIGN.colors.textBodyDark,
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

export default ComingSoon;
