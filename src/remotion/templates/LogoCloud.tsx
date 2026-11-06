/**
 * 模板: LogoCloud - 客户/媒体 logo 云（叙事补充场景）
 *
 * 效果: 社会证明的标配场景——logo 图以白色卡片网格 stagger 弹入（柔和投影）；
 * 没有素材时退化为「客户名文字芯片」网格（首字圆徽 + 名称），同样成立。
 * 横版 ≤4 个一行、5-8 个两行；竖版固定 2 列。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 标题（如「他们都在用」）；subtitle 副标题可选
 * - videos: logo 图片（≤8 张，type=image 最佳；视频按封面帧展示）
 * - features: 无素材时的客户名列表（≤8 条）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: LOGO_CLOUD_PARAMS）：cloudScale 大小 /
 * stagger 错峰 / cardOpacity 卡片白底不透明度。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {entryEase, SPRINGS} from '../animations/motion';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {LOGO_CLOUD_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const LogoCloud: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.5);

  const p = makeParamReader(LOGO_CLOUD_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 卡片上升入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const cloudScale = p('cloudScale');   // 网格大小倍率
  const stagger = p('stagger');         // 错峰倍率
  const cardOpacity = p('cardOpacity'); // 卡片白底不透明度（直接值）

  const logos = videos.slice(0, 8);
  const names = (text.features ?? []).slice(0, 8);
  const items = logos.length > 0 ? logos : names;

  // ====== 网格：横版 ≤4/行（5-8 个两行）；竖版 2 列 ======
  const cols = isPortrait ? 2 : items.length <= 4 ? Math.max(items.length, 1) : 4;
  const rows = Math.ceil(items.length / cols);
  const gridW = canvasW * 0.78 * cloudScale;
  const gap = gridW * 0.045;
  const cellW = (gridW - gap * (cols - 1)) / cols;
  const cellH = isPortrait ? cellW * 0.62 : Math.max(cellW * 0.56, canvasH * 0.13);
  const gridH = cellH * rows + gap * (rows - 1);

  // ====== 节奏 ======
  const titleStart = 4 * pace;
  const itemBase = 14 * pace;
  const itemStagger = Math.max(2, 5 * stagger) * pace;

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
          left: canvasW * 0.1,
          right: canvasW * 0.1,
          top: canvasH * (isPortrait ? 0.12 : 0.14),
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
            startFrame={Math.round(11 * pace)}
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

      {/* logo 网格 / 文字芯片网格 */}
      <div
        style={{
          position: 'absolute',
          left: (canvasW - gridW) / 2,
          top: canvasH * 0.5 - gridH / 2 + canvasH * 0.03,
          width: gridW,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap,
        }}
      >
        {items.map((item, i) => {
          const start = itemBase + i * itemStagger;
          const pop = spring({frame: frame - Math.round(start), fps: FPS, config: SPRINGS.cardPop});
          const rise = interpolate(frame, [start, start + 12 * pace], [0, 1], {
            easing: entry,
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          // 驻留微运动：卡片入场完成后保持呼吸+缓慢漂移（P2 质感）
          const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, i * 1.37);
          const drift = dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, i * 1.37);
          const logo: typeof logos[number] | null = logos.length > 0 ? (item as typeof logos[number]) : null;
          const name = logos.length > 0 ? null : (item as string);
          return (
            <div
              key={i}
              style={{
                width: cellW,
                height: cellH,
                background: `rgba(255, 255, 255, ${cardOpacity})`,
                borderRadius: Math.max(10, cellW * 0.07),
                border: '1px solid rgba(17, 24, 39, 0.06)',
                boxShadow: VIDEO_DESIGN.shadowSoft,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                opacity: rise,
                transform: `translateY(${(1 - rise) * 18 + drift.y}px) translateX(${drift.x}px) scale(${(0.7 + pop * 0.3) * breathe})`,
              }}
            >
              {logo ? (
                <ClipMedia
                  src={logo.src}
                  mediaType={logo.type}
                  muted
                  volume={0}
                  startFrom={Math.round((logo.trimStart || 0) * FPS)}
                  endSec={clipEndSec(logo)}
                  cutsSec={logo.cuts}
                  style={{width: '78%', height: '72%', objectFit: 'contain'}}
                />
              ) : (
                <div style={{display: 'flex', alignItems: 'center', gap: cellW * 0.05, maxWidth: '86%'}}>
                  <div
                    style={{
                      width: cellH * 0.44,
                      height: cellH * 0.44,
                      borderRadius: '50%',
                      background: VIDEO_DESIGN.colors.accentLight,
                      color: ACCENT(),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: cellH * 0.2,
                      fontWeight: 600,
                      fontFamily: VIDEO_DESIGN.titleFont,
                      flexShrink: 0,
                    }}
                  >
                    {(name ?? '').slice(0, 1)}
                  </div>
                  <span
                    style={{
                      fontSize: tokens.fontSize.body * 0.85,
                      fontWeight: 600,
                      color: VIDEO_DESIGN.colors.textTitle,
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {name}
                  </span>
                </div>
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
            left: canvasW * 0.08,
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

export default LogoCloud;
