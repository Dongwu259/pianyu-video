/**
 * 模板 10: BrandIntro - 品牌片头
 *
 * 画面结构：
 * - 深色品牌渐变背景 + 中心微光晕
 * - logo（素材槽：图片/视频；无素材时降级为品牌名首字圆形徽标）弹性入场
 * - brandName 品牌名缩放淡入，下方 accent 装饰线展开
 * - title 标语渐入
 * - 收尾一道斜向光带扫过全屏
 *
 * 素材槽 0-1 个：放 logo 图最佳；无素材也能用（纯文字版）。
 * 个性化参数（paramSpecs: BRAND_INTRO_PARAMS）：logoScale 标志大小 / brandScale 品牌名字号 / glow 光晕 / sweep 光扫。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn, popIn} from '../animations/keyframes';
import {entryEase} from '../animations/motion';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {BRAND_INTRO_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const BrandIntro: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.round((segmentDuration || 4) * FPS);

  // 个性化参数（故事板「参数」页滑块；未调整走 BRAND_INTRO_PARAMS 默认值）
  const p = makeParamReader(BRAND_INTRO_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 分隔线生长缓动档位：0=模板原曲线（C 批统一时间语言）
  const logoScale = p('logoScale');     // 标志/素材大小倍率
  const brandScale = p('brandScale');   // 品牌名字号倍率
  const glowIntensity = p('glow');      // 光晕强度倍率
  const sweepIntensity = p('sweep');    // 光扫强度（0 = 关闭光扫）

  const logo = videos[0];
  // logo / 徽标尺寸：基础约 2 倍标题字号，再乘用户倍率（默认 2 → 1920 宽时约 288px）
  const logoSize = tokens.fontSize.title * 2 * logoScale;
  // 无素材时降级：品牌名首字圆形徽标
  const badgeChar = (text.brandName || text.title || '').trim().charAt(0) || '◆';

  // 入场时间轴（片头较短，节奏紧凑）——按片段时长伸缩（设计基准 4s，即注册表 defaultDuration×FPS；
  // 超短片段按同一比例提前，保证元素都能出场）
  const pace = totalFrames / (4 * FPS);
  const logoStart = 6 * pace;
  const brandStart = 14 * pace;
  const dividerStart = 26 * pace;
  const titleStart = 32 * pace;

  // 光扫：片段过半后一道斜向光带从左下扫到右上
  const sweepStart = Math.round(totalFrames * 0.5);
  const sweepDuration = Math.round(FPS * 1.2);
  const sweepX = interpolate(frame, [sweepStart, sweepStart + sweepDuration], [-canvasW * 0.5, canvasW * 1.3], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  // accent 装饰线展开
  const dividerW = interpolate(frame, [dividerStart, dividerStart + 16], [0, tokens.fontSize.title * 1.6], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: entry,
  });

  const logoPop = popIn(frame, logoStart, FPS);

  // 驻留微运动：入场完成后 logo 保持缓慢呼吸，内容层整体轻微漂移（logo 与文字不错位，P2 质感）
  const u = canvasW / 1920;
  const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const drift = dwellDrift(frame, FPS, 3 * u, 2.5 * u, 9, 0);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 中心微光晕，聚拢视线（强度可调，0 = 关闭） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse at 50% 46%, ${VIDEO_DESIGN.colors.accentGlow} 0%, transparent 55%)`,
          opacity: Math.min(1, fadeIn(frame, 0, 30) * glowIntensity),
          pointerEvents: 'none',
        }}
      />

      {/* 内容层：logo + 品牌名 + 装饰线 + 标语，整体居中 */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing.paragraph,
          transform: `translate(${drift.x}px, ${drift.y}px)`,
        }}
      >
        {/* logo / 首字徽标 */}
        <div
          style={{
            width: logoSize,
            height: logoSize,
            opacity: fadeIn(frame, logoStart, 10),
            transform: `scale(${logoPop * breathe})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {logo ? (
            <ClipMedia
              src={logo.src}
              mediaType={logo.type}
              muted={logo.muted}
              volume={logo.volume}
              startFrom={Math.round((logo.trimStart || 0) * FPS)}
              endSec={clipEndSec(logo)}
              cutsSec={logo.cuts}
              style={{
                width: logoSize,
                height: logoSize,
                objectFit: 'contain',
                borderRadius: logoSize * 0.22,
                filter: 'drop-shadow(0 12px 32px rgba(0, 0, 0, 0.45))',
              }}
            />
          ) : (
            <div
              style={{
                width: logoSize,
                height: logoSize,
                borderRadius: '50%',
                background: `linear-gradient(135deg, ${VIDEO_DESIGN.colors.accent} 0%, #1D4ED8 100%)`,
                boxShadow: `0 0 0 ${Math.max(2, logoSize * 0.03)}px rgba(255, 255, 255, 0.18), 0 16px 40px rgba(37, 99, 235, 0.35)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: logoSize * 0.46,
                fontWeight: 700,
                fontFamily: VIDEO_DESIGN.titleFont,
                color: '#FFFFFF',
              }}
            >
              {badgeChar}
            </div>
          )}
        </div>

        {/* 品牌名：缩放淡入 */}
        {text.brandName && (
          <AnimatedText
            text={text.brandName}
            preset={textAnim ?? 'scaleIn'}
            startFrame={brandStart}
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.title * brandScale,
              fontWeight: style?.brand?.fontWeight ?? 700,
              color: style?.brand?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              letterSpacing: '0.02em',
              lineHeight: 1.15,
              ...(style?.brand?.textDecoration ? {textDecoration: style.brand.textDecoration} : {}),
              ...(style?.brand?.fontStyle ? {fontStyle: style.brand.fontStyle} : {}),
              ...textStrokeCss(style?.brand),
            }}
          />
        )}

        {/* accent 装饰线：从中心向两边展开 */}
        <div
          style={{
            width: dividerW,
            height: Math.max(3, tokens.fontSize.title * 0.07),
            borderRadius: 999,
            background: VIDEO_DESIGN.colors.accent,
            opacity: fadeIn(frame, dividerStart, 8),
          }}
        />

        {/* 标语：渐入上移 */}
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={titleStart}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.subtitle,
              fontWeight: style?.title?.fontWeight ?? 400,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textBodyDark,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.08em',
              textAlign: 'center',
              lineHeight: 1.4,
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
        )}
      </AbsoluteFill>

      {/* 收尾光扫：斜向光带横穿全屏（强度可调，0 = 关闭） */}
      {sweepIntensity > 0 && (
        <AbsoluteFill style={{overflow: 'hidden', pointerEvents: 'none', opacity: sweepIntensity}}>
          <div
            style={{
              position: 'absolute',
              left: sweepX,
              top: -canvasH * 0.2,
              width: canvasW * 0.28,
              height: canvasH * 1.4,
              transform: 'rotate(18deg)',
              background:
                'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.16) 45%, rgba(255, 255, 255, 0.32) 50%, rgba(255, 255, 255, 0.16) 55%, transparent 100%)',
            }}
          />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

export default BrandIntro;
