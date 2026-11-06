/**
 * 模板: PriceAnchorPro - 价格锚点复合（2026-10-13 真缺口批）
 *
 * 效果: 价格大数字（锚点脉冲）+ 卖点对勾清单 + 信赖徽章行一屏——单档锚定式定价页。
 * 与 PricingTiers（多档对比）分工：锚定讲「一个价格值不值」，档位讲「选哪档」。
 * v13 StatCounter 判读教训（features 行对比度偏弱）：卖点行深色 600 字重 + 品牌色对勾，
 * 对比度向标题看齐。
 *
 * 文案编码（复用 PromoText，前缀语义与 [t]/[v]、u:/a: 同款惯例）：
 * - title: 价格大字（如「¥8/月」）；subtitle = 锚点补充语（如「解锁自有模型 · 随时可退」）
 * - features: 卖点行（≤4，带对勾）；行前加「!」= 信赖徽章（≤3，如「!30 天可退」）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（PRICE_ANCHOR_PRO_PARAMS）：priceScale 价格字号 / stagger 逐条节奏 /
 * pulse 价格脉冲（大数字品牌色辉光呼吸，0 关）。
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
import {parsePriceAnchor} from '../../shared/promo-text-parse';
import {PRICE_ANCHOR_PRO_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const PriceAnchorPro: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(PRICE_ANCHOR_PRO_PARAMS, params);
  const priceScale = p('priceScale');
  const stagger = p('stagger');
  const pulse = p('pulse');

  const {perks, badges} = parsePriceAnchor(text.features);

  // ====== 节奏：价格 → 卖点逐条 → 徽章行 ======
  const priceStart = 5 * pace;
  const perkBase = 16 * pace;
  const perkStagger = 10 * pace * stagger;
  const badgeStart = perkBase + perks.length * perkStagger + 6 * pace;
  // 价格脉冲：品牌色辉光呼吸（不改变字号——尺寸过冲在锚点语境是「价格在变」的误读）
  const pulseGlow = pulse > 0.5 ? 0.5 + 0.5 * Math.sin(frame * 0.06) : 0;

  // ====== 版式 ======
  const padX = canvasW * (isPortrait ? 0.1 : 0.13);
  const priceFs = (isPortrait ? canvasW * 0.19 : canvasH * 0.19) * priceScale;
  const perkFs = tokens.fontSize.body * (isPortrait ? 0.95 : 1.02);
  const rowGap = canvasH * (isPortrait ? 0.028 : 0.024);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: canvasH * (isPortrait ? 0.12 : 0.16),
          bottom: safeBottom(canvasW, canvasH, canvasH * (badges.length > 0 ? 0.2 : 0.1)),
          display: 'flex',
          flexDirection: isPortrait ? 'column' : 'row',
          alignItems: isPortrait ? 'center' : 'stretch',
          justifyContent: isPortrait ? 'flex-start' : 'space-between',
          gap: isPortrait ? canvasH * 0.04 : canvasW * 0.07,
        }}
      >
        {/* 价格锚点块 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: isPortrait ? 'center' : 'flex-start',
            justifyContent: isPortrait ? 'flex-start' : 'center',
            flex: isPortrait ? 'none' : '0 0 auto',
            minWidth: isPortrait ? undefined : canvasW * 0.34,
          }}
        >
          {text.title && (
            <AnimatedText
              text={text.title}
              preset={textAnim ?? 'scaleIn'}
              startFrame={Math.round(priceStart)}
              duration={Math.round(16 * pace)}
              style={{
                fontSize: priceFs,
                fontWeight: 800,
                color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
                fontFamily: VIDEO_DESIGN.titleFont,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                textShadow:
                  pulseGlow > 0
                    ? `0 0 ${priceFs * 0.16 * pulseGlow + priceFs * 0.04}px ${ACCENT()}${pulseGlow > 0.5 ? '4D' : '2E'}`
                    : undefined,
                ...textStrokeCss(style?.title),
              }}
            />
          )}
          {text.subtitle && (
            <AnimatedText
              text={text.subtitle}
              preset={textAnim ?? 'fadeIn'}
              startFrame={Math.round(priceStart + 8 * pace)}
              duration={Math.round(12 * pace)}
              style={{
                fontSize: tokens.fontSize.subtitle * 0.82,
                fontWeight: 500,
                color: style?.subtitle?.color ?? ACCENT(),
                fontFamily: VIDEO_DESIGN.bodyFont,
                lineHeight: 1.4,
                marginTop: canvasH * 0.018,
                ...textStrokeCss(style?.subtitle),
              }}
            />
          )}
        </div>

        {/* 卖点对勾清单（对比度向标题看齐：深色 600 字重 + 品牌色对勾圆环） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: isPortrait ? 'flex-start' : 'center',
            gap: rowGap,
            flex: isPortrait ? 'none' : '0 1 auto',
          }}
        >
          {perks.map((perk, i) => {
            const start = perkBase + i * perkStagger;
            const pop = spring({frame: frame - start, fps: FPS, config: SPRINGS.cardSettle});
            const breathe = dwellBreathe(frame, FPS, 0.008, 5.5, i * 1.31);
            const ring = perkFs * 1.15;
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing.element * 0.9,
                  opacity: Math.min(1, pop * 1.4),
                  transform: `translateX(${(1 - Math.min(1, pop * 1.4)) * -28 * pace}px) scale(${breathe})`,
                }}
              >
                <div
                  style={{
                    width: ring,
                    height: ring,
                    borderRadius: '50%',
                    border: `2px solid ${ACCENT()}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                  }}
                >
                  {/* 对勾用描边画（字体对勾跨平台形态不稳） */}
                  <div
                    style={{
                      width: ring * 0.4,
                      height: ring * 0.22,
                      borderLeft: `2.5px solid ${ACCENT()}`,
                      borderBottom: `2.5px solid ${ACCENT()}`,
                      transform: `rotate(-45deg) translateY(-${ring * 0.04}px)`,
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: perkFs,
                    fontWeight: 600,
                    color: style?.feature?.color ?? VIDEO_DESIGN.colors.textTitle,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    lineHeight: 1.35,
                  }}
                >
                  {perk}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 信赖徽章行 */}
      {badges.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            right: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.085),
            display: 'flex',
            alignItems: 'center',
            justifyContent: isPortrait ? 'center' : 'flex-start',
            gap: tokens.spacing.element,
            opacity: interpolate(frame, [badgeStart, badgeStart + 12 * pace], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
          }}
        >
          {badges.map((badge, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.fontSize.caption * 0.45,
                border: `1.5px solid ${ACCENT()}66`,
                borderRadius: tokens.fontSize.caption * 1.4,
                padding: `${tokens.fontSize.caption * 0.28}px ${tokens.fontSize.caption * 0.95}px`,
                background: 'rgba(255, 255, 255, 0.72)',
              }}
            >
              <div style={{width: tokens.fontSize.caption * 0.32, height: tokens.fontSize.caption * 0.32, borderRadius: '50%', background: ACCENT()}} />
              <span style={{fontSize: tokens.fontSize.caption * 1.02, fontWeight: 600, color: VIDEO_DESIGN.colors.textBody, fontFamily: VIDEO_DESIGN.bodyFont, letterSpacing: '0.02em'}}>
                {badge}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 品牌名 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            right: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.045),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: interpolate(frame, [12 * pace, 22 * pace], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
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

export default PriceAnchorPro;
