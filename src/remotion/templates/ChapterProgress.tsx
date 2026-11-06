/**
 * 模板: ChapterProgress - 章节进度卡（2026-10-13 真缺口批）
 *
 * 效果: 「第 X 幕」的推进感——章节词小标 → 章节号大数字滚动 → 进度点逐个亮起 → 大字标题。
 * KineticType 兼职章节但没有进度语义；多幕叙事（A/B 线转折）需要明确的「第 X / 共 N」推进。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 章节大字（如「自动分镜」）；subtitle = 章节副题（如「素材进来，结构出去」）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（CHAPTER_PROGRESS_PARAMS）：chapter 章节序号 / total 总章数（进度点亮到当前章）/
 * numScale 数字字号。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {SPRINGS} from '../animations/motion';
import {dwellBreathe} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {CHAPTER_PROGRESS_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const ChapterProgress: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.5);

  const p = makeParamReader(CHAPTER_PROGRESS_PARAMS, params);
  const numScale = p('numScale');
  const chapter = Math.max(1, Math.round(p('chapter')));
  const total = Math.max(1, Math.round(p('total')));

  // ====== 节奏：章节词 → 数字滚动 → 进度点亮 → 标题 ======
  const numStart = 6 * pace;
  const numRoll = 20 * pace; // 数字滚动时长
  const rollNum = Math.round(interpolate(frame, [numStart, numStart + numRoll], [0, chapter], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }));
  const dotsStart = numStart + numRoll * 0.6;
  const titleStart = numStart + numRoll + 4 * pace;

  // ====== 版式 ======
  const numFs = (isPortrait ? canvasW * 0.34 : canvasH * 0.3) * numScale;
  const dotR = Math.max(5, canvasW * (isPortrait ? 0.016 : 0.008));
  const breathe = dwellBreathe(frame, FPS, 0.01, 5, 0.7);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: canvasH * 0.035,
          paddingBottom: canvasH * 0.06,
        }}
      >
        {/* 章节词小标：第 · 幕 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.element,
            opacity: interpolate(frame, [2 * pace, 8 * pace], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
          }}
        >
          <div style={{width: canvasW * 0.06, height: 2, background: `${ACCENT()}88`}} />
          <span style={{fontSize: tokens.fontSize.subtitle * 0.85, fontWeight: 500, letterSpacing: '0.5em', paddingLeft: '0.5em', color: style?.feature?.color ?? VIDEO_DESIGN.colors.textMuted, fontFamily: VIDEO_DESIGN.bodyFont}}>
            第 · 幕
          </span>
          <div style={{width: canvasW * 0.06, height: 2, background: `${ACCENT()}88`}} />
        </div>

        {/* 章节号大数字（滚动 + 弹入 + 驻留呼吸） */}
        <div
          style={{
            fontSize: numFs,
            fontWeight: 800,
            lineHeight: 1,
            fontFamily: VIDEO_DESIGN.titleFont,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
            color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
            transform: `scale(${spring({frame: frame - numStart, fps: FPS, config: SPRINGS.cardSettle}) * breathe})`,
            ...textStrokeCss(style?.title),
          }}
        >
          {String(rollNum).padStart(2, '0')}
        </div>

        {/* 进度点：亮到当前章（含当前），其后空心 */}
        <div style={{display: 'flex', alignItems: 'center', gap: dotR * 1.4, marginTop: canvasH * 0.005}}>
          {Array.from({length: total}, (_, i) => {
            const lit = i < chapter;
            const dotStart = dotsStart + i * Math.max(2, 4 * pace);
            const pop = spring({frame: frame - dotStart, fps: FPS, config: SPRINGS.charPop});
            return (
              <div
                key={i}
                style={{
                  width: lit ? dotR * 1.15 : dotR * 0.7,
                  height: lit ? dotR * 1.15 : dotR * 0.7,
                  borderRadius: '50%',
                  background: lit ? ACCENT() : 'transparent',
                  border: lit ? 'none' : `1.5px solid ${ACCENT()}55`,
                  opacity: pop > 0 ? Math.min(1, pop * 1.6) : 0,
                  transform: `scale(${0.5 + pop * 0.5})`,
                  boxShadow: lit && i === chapter - 1 ? `0 0 ${dotR * 2}px ${ACCENT()}66` : 'none',
                }}
              />
            );
          })}
        </div>

        {/* 章节大字 */}
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={Math.round(titleStart)}
            duration={Math.round(16 * pace)}
            style={{
              fontSize: (isPortrait ? canvasW * 0.088 : canvasH * 0.084) / numScale * Math.max(numScale, 0.85),
              fontWeight: 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              fontFamily: VIDEO_DESIGN.titleFont,
              letterSpacing: '0.02em',
              lineHeight: 1.25,
              textAlign: 'center',
              marginTop: canvasH * 0.02,
              ...textStrokeCss(style?.title),
            }}
          />
        )}
        {text.subtitle && (
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={Math.round(titleStart + 8 * pace)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: tokens.fontSize.subtitle * 0.78,
              fontWeight: 400,
              color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              lineHeight: 1.4,
              marginTop: canvasH * 0.008,
              ...textStrokeCss(style?.subtitle),
            }}
          />
        )}
      </div>

      {/* 品牌名 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * (isPortrait ? 0.09 : 0.12),
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.05),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: interpolate(frame, [10 * pace, 20 * pace], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
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
              color: style?.brand?.color ?? VIDEO_DESIGN.colors.textMuted,
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

export default ChapterProgress;
