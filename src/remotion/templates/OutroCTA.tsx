/**
 * 模板 11: OutroCTA - 结尾行动号召
 *
 * 画面结构：
 * - 深色渐变背景 + 内置微光粒子（缓慢上浮闪烁）
 * - 品牌名（小字、宽字距）+「感谢观看」大标题（title 非空时可用自定义文案覆盖）
 * - CTA 文字行：复用 text.features 列表逐行渐入（如"官网 xxx.com""扫码下载"）
 * - 二维码图片槽：素材放 QR 图时带白色底卡弹性入场；无素材时优雅降级为纯文字版
 * - 横屏左文右码，竖屏居中堆叠
 *
 * 素材槽 0-1 个：放二维码图最佳；无素材也能用（纯文字版）。
 * 个性化参数（paramSpecs: OUTRO_CTA_PARAMS）：qrScale 素材/二维码大小 / textScale 文字字号 / particleDensity 粒子密度（0 = 无粒子）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn, popIn} from '../animations/keyframes';
import {rand} from '../utils/ink';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {REF_ASPECT} from '../utils/aspectLayout';
import {OUTRO_CTA_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

/** 内置微光粒子：缓慢上浮 + 闪烁（确定性伪随机，预览与渲染一致；density 为数量倍率，0 = 无粒子） */
const GlowParticles: React.FC<{frame: number; density: number}> = ({frame, density}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const unit = Math.min(canvasW, canvasH) / 1080; // 短边基准，保证各比例下大小一致
  return (
    <>
      {Array.from({length: Math.round(16 * density)}, (_, i) => {
        const size = (2.5 + rand(i * 5.3) * 4) * unit;
        const speed = 0.25 + rand(i * 7.7) * 0.55; // 每帧上浮 px
        const y0 = rand(i * 9.1) * canvasH;
        const range = canvasH + 40;
        const y = (((y0 - frame * speed) % range) + range) % range - 20;
        const twinkle = 0.5 + 0.5 * Math.sin(frame * 0.06 + i * 1.7);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: rand(i * 3.1) * canvasW,
              top: y,
              width: size,
              height: size,
              borderRadius: '50%',
              background: 'rgba(191, 219, 254, 0.9)',
              boxShadow: `0 0 ${size * 3}px rgba(147, 197, 253, 0.55)`,
              opacity: 0.12 + twinkle * 0.3,
            }}
          />
        );
      })}
    </>
  );
};

export const OutroCTA: React.FC<TemplateProps> = ({
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
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 5) * FPS);

  // 个性化参数（故事板「参数」页滑块；未调整走 OUTRO_CTA_PARAMS 默认值）
  const p = makeParamReader(OUTRO_CTA_PARAMS, params);
  const qrScale = p('qrScale');             // 素材/二维码大小倍率
  const textScale = p('textScale');         // 文字字号倍率
  const particleDensity = p('particleDensity'); // 粒子数量倍率（0 = 无粒子）

  const qr = videos[0];
  // 二维码边长：短边 20%（1920x1080 / 1080x1920 → 216px），再乘用户倍率
  const qrSize = Math.min(canvasW, canvasH) * 0.2 * qrScale;

  // 大标题：title 为空时用固定文案「感谢观看」
  const heading = text.title?.trim() ? text.title : '感谢观看';
  const features = (text.features || []).filter(Boolean).slice(0, 4);

  // 入场时间轴——按片段时长伸缩（设计基准 5s，即注册表 defaultDuration×FPS；
  // 超短片段按同一比例提前，保证元素都能出场）
  const pace = totalFrames / (5 * FPS);
  const brandStart = 5 * pace;
  const headingStart = 12 * pace;
  const featureBase = 30 * pace;
  const qrStart = 42 * pace;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 背景微光粒子 */}
      <GlowParticles frame={frame} density={particleDensity} />

      {/* 内容层：横屏左文右码，竖屏居中堆叠 */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: isPortrait ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing.section,
          padding: tokens.spacing.section,
        }}
      >
        {/* 文字块：品牌名 + 大标题 + CTA 行（内容盒宽度封顶 16:9 等效值——画幅审计
              P1-5：21:9 按画布宽 0.52 会拉出 1310px 级文本列，重心散架；16:9 恰不触顶零漂移） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: isPortrait ? 'center' : 'flex-start',
            textAlign: isPortrait ? 'center' : 'left',
            gap: tokens.spacing.element,
            maxWidth: isPortrait ? '100%' : Math.min(canvasW * 0.52, canvasH * REF_ASPECT * 0.52 + 0.5),
          }}
        >
          {text.brandName && (
            <div
              style={{
                opacity: fadeIn(frame, brandStart, 15),
                fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption * textScale,
                fontWeight: style?.brand?.fontWeight ?? 600,
                fontFamily: VIDEO_DESIGN.bodyFont,
                color: style?.brand?.color ?? VIDEO_DESIGN.colors.accent,
                letterSpacing: '0.22em',
                ...(style?.brand?.textDecoration ? {textDecoration: style.brand.textDecoration} : {}),
                ...(style?.brand?.fontStyle ? {fontStyle: style.brand.fontStyle} : {}),
                ...textStrokeCss(style?.brand),
              }}
            >
              {text.brandName}
            </div>
          )}

          <AnimatedText
            text={heading}
            preset={textAnim ?? 'charPop'}
            startFrame={headingStart}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.9 * textScale,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              letterSpacing: '0.01em',
              lineHeight: 1.2,
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />

          {/* CTA 文字行：逐行渐入，accent 圆点引导 */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: isPortrait ? 'center' : 'flex-start',
              gap: tokens.spacing.tight * 1.5,
              marginTop: tokens.spacing.element,
            }}
          >
            {features.map((line, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing.tight * 1.5,
                  opacity: fadeIn(frame, featureBase + i * 10, 15),
                  transform: `translateY(${(1 - fadeIn(frame, featureBase + i * 10, 15)) * 24}px)`,
                }}
              >
                <span
                  style={{
                    width: tokens.fontSize.body * 0.32,
                    height: tokens.fontSize.body * 0.32,
                    borderRadius: '50%',
                    background: VIDEO_DESIGN.colors.accent,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: style?.feature?.fontSize ?? tokens.fontSize.body * textScale,
                    fontWeight: style?.feature?.fontWeight ?? 400,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                    letterSpacing: '0.04em',
                    lineHeight: 1.4,
                    ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                    ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                    ...textStrokeCss(style?.feature),
                  }}
                >
                  {line}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 二维码：白色底卡弹性入场（无素材时不渲染，纯文字版） */}
        {qr && (
          <div
            style={{
              opacity: fadeIn(frame, qrStart, 12),
              transform: `scale(${popIn(frame, qrStart, FPS)})`,
              background: '#FFFFFF',
              padding: qrSize * 0.1,
              borderRadius: qrSize * 0.12,
              boxShadow: '0 24px 64px -16px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)',
              flexShrink: 0,
            }}
          >
            <ClipMedia
              src={qr.src}
              mediaType={qr.type}
              muted={qr.muted}
              volume={qr.volume}
              startFrom={Math.round((qr.trimStart || 0) * FPS)}
              endSec={clipEndSec(qr)}
              cutsSec={qr.cuts}
              style={{
                width: qrSize,
                height: qrSize,
                objectFit: 'contain',
                display: 'block',
              }}
            />
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export default OutroCTA;
