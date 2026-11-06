/**
 * 模板: PricingTiers - 定价档位（叙事补充场景）
 *
 * 效果: 档位卡片 stagger 上升入场，推荐档放大 + 品牌色描边脉冲 + 「推荐」徽标
 * （市场验证：SaaS promo 模板的标准定价场景）。
 * 横版 = 横排卡组；竖版 = 纵排列表（推荐档同样放大突出）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 页面标题（如「选择你的方案」）；subtitle 副标题可选
 * - features: 档位行「档位名 价格 描述」（空格分隔，前两段不含空格；≤4 档），
 *   如「基础版 ¥0 入门协作」「专业版 ¥99 全功能不限量」
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: PRICING_TIERS_PARAMS）：cardScale 卡片大小 /
 * stagger 入场节奏 / highlight 推荐档序号（0-3，0 = 无推荐档）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {entryEase} from '../animations/motion';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {parsePricingTier} from '../../shared/promo-text-parse';
import {PRICING_TIERS_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const PricingTiers: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(PRICING_TIERS_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const cardScale = p('cardScale'); // 卡片大小倍率
  const stagger = p('stagger');     // 卡片错峰倍率
  const highlightIdx = Math.round(p('highlight')); // 推荐档序号（0 = 无；1 起对应第 1 档）

  const tiers = (text.features ?? []).slice(0, 4).map(parsePricingTier);

  // ====== 节奏：标题 → 卡片逐张上升 ======
  const titleStart = 5 * pace;
  const cardBase = 18 * pace;
  const cardStagger = 12 * pace * stagger;
  // 推荐档呼吸脉冲（描边亮度缓动，不改变卡片尺寸——尺寸过冲会挤压邻卡）
  const pulse = 0.5 + 0.5 * Math.sin(frame * 0.07);

  // ====== 版式 ======
  const padX = canvasW * (isPortrait ? 0.09 : 0.12);
  const gap = canvasW * (isPortrait ? 0.035 : 0.03);
  const cardW = ((canvasW - padX * 2 - gap * (tiers.length - 1)) / Math.max(tiers.length, 1)) * cardScale;
  const cardH = (isPortrait ? canvasH * 0.17 : canvasH * 0.4) * cardScale;
  const nameFs = tokens.fontSize.body * 0.9;
  const priceFs = (isPortrait ? canvasW * 0.05 : canvasW * 0.026) * (0.85 + 0.15 * cardScale);
  const descFs = tokens.fontSize.caption * 1.05;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 标题 + 副标题 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: canvasH * (isPortrait ? 0.11 : 0.13),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={Math.round(titleStart)}
            duration={Math.round(16 * pace)}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.62,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              fontFamily: VIDEO_DESIGN.titleFont,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              textAlign: 'center',
              ...textStrokeCss(style?.title),
            }}
          />
        )}
        {text.subtitle && (
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={Math.round(12 * pace)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: tokens.fontSize.subtitle * 0.7,
              fontWeight: 400,
              color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              lineHeight: 1.35,
              marginTop: tokens.spacing.element * 0.6,
              ...textStrokeCss(style?.subtitle),
            }}
          />
        )}
      </div>

      {/* 卡组：横版横排居中；竖版纵排 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: canvasH * (isPortrait ? 0.26 : 0.3),
          bottom: safeBottom(canvasW, canvasH, canvasH * 0.14),
          display: 'flex',
          flexDirection: isPortrait ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap,
        }}
      >
        {tiers.map((tier, i) => {
          const start = cardBase + i * cardStagger;
          const prog = interpolate(frame, [start, start + 16 * pace], [0, 1], {
            easing: entry,
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const isHot = i === highlightIdx - 1;
          // 驻留微运动：普通档入场完成后保持呼吸+漂移；推荐档已有描边脉冲，跳过（P2 质感）
          const breathe = isHot ? 1 : dwellBreathe(frame, FPS, 0.012, 4.5, i * 1.37);
          const drift = isHot ? {x: 0, y: 0} : dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, i * 1.37);
          return (
            <div
              key={i}
              style={{
                position: 'relative',
                width: isPortrait ? Math.min(cardW, canvasW - padX * 2) : cardW,
                height: cardH,
                background: 'rgba(255, 255, 255, 0.94)',
                borderRadius: Math.max(12, cardW * 0.06),
                border: isHot
                  ? `2px solid ${ACCENT()}`
                  : '1px solid rgba(17, 24, 39, 0.08)',
                boxShadow: isHot
                  ? `0 ${24 * cardScale}px ${48 * cardScale}px -16px ${ACCENT()}55, 0 0 ${18 * pulse}px ${ACCENT()}${pulse > 0.5 ? '44' : '22'}`
                  : VIDEO_DESIGN.shadowSoft,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: `${cardH * 0.08}px ${cardW * 0.08}px`,
                opacity: prog,
                transform: `translateY(${(1 - prog) * 46 * pace + drift.y}px) translateX(${drift.x}px) scale(${(isHot ? 1.05 : 1) * breathe})`,
              }}
            >
              {/* 推荐徽标 */}
              {isHot && (
                <div
                  style={{
                    position: 'absolute',
                    top: -tokens.fontSize.caption * 0.75,
                    background: ACCENT(),
                    color: '#FFFFFF',
                    fontSize: tokens.fontSize.caption * 0.85,
                    fontWeight: 700,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    borderRadius: tokens.fontSize.caption,
                    padding: `${tokens.fontSize.caption * 0.12}px ${tokens.fontSize.caption * 0.6}px`,
                    opacity: fadeIn(frame, start + 8 * pace, 8 * pace),
                    lineHeight: 1.3,
                  }}
                >
                  推荐
                </div>
              )}
              {tier.name && (
                <AnimatedText
                  text={tier.name}
                  preset={textAnim ?? 'fadeIn'}
                  startFrame={Math.round(start + 4 * pace)}
                  duration={Math.round(10 * pace)}
                  style={{
                    fontSize: nameFs,
                    fontWeight: 600,
                    color: VIDEO_DESIGN.colors.textMuted,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    lineHeight: 1.3,
                  }}
                />
              )}
              {tier.price && (
                <AnimatedText
                  text={tier.price}
                  preset={textAnim ?? 'scaleIn'}
                  startFrame={Math.round(start + 6 * pace)}
                  duration={Math.round(12 * pace)}
                  style={{
                    fontSize: priceFs,
                    fontWeight: 800,
                    color: isHot ? ACCENT() : VIDEO_DESIGN.colors.textTitle,
                    fontFamily: VIDEO_DESIGN.titleFont,
                    lineHeight: 1.25,
                    letterSpacing: '-0.01em',
                    marginTop: cardH * 0.04,
                  }}
                />
              )}
              {tier.desc && (
                <AnimatedText
                  text={tier.desc}
                  preset={textAnim ?? 'fadeIn'}
                  startFrame={Math.round(start + 10 * pace)}
                  duration={Math.round(12 * pace)}
                  style={{
                    fontSize: descFs,
                    fontWeight: 400,
                    color: VIDEO_DESIGN.colors.textBody,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    lineHeight: 1.45,
                    marginTop: cardH * 0.07,
                    textAlign: 'center',
                    maxWidth: '100%',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* 品牌名 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.05),
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

export default PricingTiers;
