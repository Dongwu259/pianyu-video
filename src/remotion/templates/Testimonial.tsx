/**
 * 模板: Testimonial - 客户证言卡（说服力场景）
 *
 * 效果: 市场缺口模板（Envato testimonial/quote/review 合计 ~1900 检索量）。
 * 白色证言卡居中：小标签 → 星级逐格弹亮 → 引言上浮 → 署名（头像圆徽 + 姓名/职位）淡入，
 * 大引号符号做背景装饰。星空用 ★ 字形 + amber，逐格 spring 弹入是「盖印」手感。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 卡内小标签（如「用户声音」；可空）
 * - features[0]: 引言正文；缺省回退 subtitle → title
 * - features[1]: 署名「姓名，职位」（分隔符支持 ，,、·|/）；可空
 * - features[2]: 星级 0-5（0=隐藏星级；缺省/非法按 5）
 * - brandName: 左下角品牌小字
 *
 * 画面结构：浅色渐变背景 + 居中白卡（柔和投影）。竖版卡片占宽 84%，字号随画幅放大。
 *
 * 个性化参数（paramSpecs: TESTIMONIAL_PARAMS）：quoteScale 引言字号 /
 * cardScale 卡片大小 / reveal 整体节奏。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
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
import {safeBottom} from '../utils/safeArea';
import {textStrokeCss} from '../utils/textStroke';
import {parseTestimonial} from '../../shared/promo-text-parse';
import {TESTIMONIAL_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;
const STAR_FILLED = '#F59E0B';
const STAR_EMPTY = '#D1D5DB';

export const Testimonial: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.5);

  const p = makeParamReader(TESTIMONIAL_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const quoteScale = p('quoteScale'); // 引言字号倍率
  const cardScale = p('cardScale');   // 卡片大小倍率
  const reveal = p('reveal');         // 整体节奏倍率（越大入场越快）

  // ====== 文案解析（引言回退链 subtitle → title） ======
  const content = parseTestimonial(text.features, text.subtitle || text.title);
  const hasAuthor = content.author.length > 0;

  // ====== 节奏（卡片 → 星级 → 引言 → 署名） ======
  const cardStart = 2 * pace;
  const starStart = 8 * pace;
  const starStagger = Math.max(1.5, 3 / reveal) * pace;
  // 引言等星级全部弹亮后再上浮（rating 0 时退化为固定 8 帧后）
  const quoteStart = 10 * pace + content.rating * starStagger;
  const authorStart = quoteStart + 22 * pace;

  // 卡片入场：淡入 + 轻微缩放归位（克制的「上桌」感）
  const cardProg = interpolate(frame, [cardStart, cardStart + 14 * pace], [0, 1], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ====== 版式 ======
  const u = canvasW / 1920; // 固定 px 元素的缩放单位
  const cardW = canvasW * (isPortrait ? 0.84 : 0.46) * cardScale;
  const cardPad = canvasW * 0.045;
  const quoteSize = (isPortrait ? canvasW * 0.042 : canvasW * 0.021) * quoteScale;
  const starSize = Math.max(18, quoteSize * 0.5);
  const avatarSize = Math.max(40, canvasW * (isPortrait ? 0.085 : 0.042));

  // 驻留微运动：入场完成后卡片保持呼吸+缓慢漂移（P2 质感）
  const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const drift = dwellDrift(frame, FPS, 4 * u, 3 * u, 9, 0);

  return (
    <AbsoluteFill>
      {/* 背景层：浅色渐变（可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 证言卡 */}
      <div
        style={{
          position: 'absolute',
          left: (canvasW - cardW) / 2,
          top: '50%',
          transform: `translateY(-50%) translate(${drift.x}px, ${drift.y}px) scale(${(0.97 + cardProg * 0.03) * breathe})`,
          width: cardW,
          opacity: cardProg,
        }}
      >
        <div
          style={{
            position: 'relative',
            background: 'rgba(255, 255, 255, 0.92)',
            borderRadius: Math.max(16, 28 * u),
            boxShadow: VIDEO_DESIGN.shadowFloat,
            border: `1px solid rgba(17, 24, 39, 0.06)`,
            padding: `${cardPad}px ${cardPad}px ${cardPad * 0.9}px`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            overflow: 'hidden',
          }}
        >
          {/* 背景大引号装饰（不参与内容阅读，只给「这是一句话」的暗示） */}
          <span
            style={{
              position: 'absolute',
              top: -quoteSize * 0.35,
              left: cardPad * 0.35,
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontSize: quoteSize * 2.6,
              lineHeight: 1,
              color: ACCENT(),
              opacity: 0.12 * cardProg,
              pointerEvents: 'none',
            }}
          >
            &ldquo;
          </span>

          {/* 小标签（title 可空） */}
          {text.title && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing.element * 0.7,
                marginBottom: tokens.spacing.paragraph,
                opacity: fadeIn(frame, cardStart + 6 * pace, 10 * pace),
              }}
            >
              <div style={{width: Math.max(5, Math.round(8 * u)), height: Math.max(5, Math.round(8 * u)), borderRadius: '50%', background: ACCENT()}} />
              <span
                style={{
                  fontSize: tokens.fontSize.caption,
                  fontWeight: 600,
                  color: ACCENT(),
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  letterSpacing: '0.2em',
                  ...textStrokeCss(style?.title),
                }}
              >
                {text.title}
              </span>
            </div>
          )}

          {/* 星级：逐格弹亮（rating 0 隐藏） */}
          {content.rating > 0 && (
            <div style={{display: 'flex', gap: starSize * 0.22, marginBottom: tokens.spacing.paragraph * 0.8}}>
              {Array.from({length: 5}, (_, i) => {
                const pop = spring({
                  frame: frame - (starStart + i * starStagger),
                  fps: FPS,
                  config: SPRINGS.pop,
                });
                const filled = i < content.rating;
                return (
                  <span
                    key={i}
                    style={{
                      fontSize: starSize,
                      lineHeight: 1,
                      color: filled ? STAR_FILLED : STAR_EMPTY,
                      opacity: pop,
                      transform: `scale(${0.3 + pop * 0.7})`,
                    }}
                  >
                    ★
                  </span>
                );
              })}
            </div>
          )}

          {/* 引言正文 */}
          {content.quote && (
            <AnimatedText
              text={content.quote}
              preset={textAnim ?? 'fadeUp'}
              startFrame={Math.round(quoteStart)}
              duration={Math.round(16 * pace)}
              style={{
                fontSize: quoteSize,
                fontWeight: style?.feature?.fontWeight ?? 500,
                color: style?.feature?.color ?? VIDEO_DESIGN.colors.textTitle,
                fontFamily: VIDEO_DESIGN.bodyFont,
                lineHeight: 1.6,
                letterSpacing: '0.01em',
                textAlign: 'center',
                maxWidth: '100%',
                ...textStrokeCss(style?.feature),
              }}
            />
          )}

          {/* 署名：头像圆徽（姓名首字）+ 姓名/职位 */}
          {hasAuthor && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing.element,
                marginTop: tokens.spacing.paragraph,
                opacity: fadeIn(frame, authorStart, 12 * pace),
                transform: `translateY(${(1 - Math.min(1, fadeIn(frame, authorStart, 12 * pace))) * 12}px)`,
              }}
            >
              <div
                style={{
                  width: avatarSize,
                  height: avatarSize,
                  borderRadius: '50%',
                  background: VIDEO_DESIGN.colors.accentLight,
                  border: `2px solid ${ACCENT()}33`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: avatarSize * 0.42,
                  fontWeight: 600,
                  color: ACCENT(),
                  fontFamily: VIDEO_DESIGN.titleFont,
                  flexShrink: 0,
                }}
              >
                {content.author.slice(0, 1)}
              </div>
              <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0}}>
                <span
                  style={{
                    fontSize: tokens.fontSize.body,
                    fontWeight: 600,
                    color: VIDEO_DESIGN.colors.textTitle,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    lineHeight: 1.3,
                  }}
                >
                  {content.author}
                </span>
                {content.role && (
                  <span
                    style={{
                      fontSize: tokens.fontSize.caption,
                      fontWeight: 400,
                      color: VIDEO_DESIGN.colors.textMuted,
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      lineHeight: 1.4,
                    }}
                  >
                    {content.role}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 品牌名：左下角小字（同家族约定） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.07,
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

export default Testimonial;
