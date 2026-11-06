/**
 * 模板: TextSlide - PPT 式纯文字幻灯片
 *
 * 画面结构：
 * - 浅色渐变背景 + 角落大号半透明几何装饰（圆环 / 圆角色块，低透明度不抢戏）
 * - 左侧品牌色竖强调条 + 大标题（slideUp 入场），副标题 fadeIn
 * - features 要点列表逐条入场（间隔约 10 帧，前带品牌色短横标记，最多 5 条）
 * - 品牌名底部左下角小字标签
 * - 完全不含视频/图片槽位：videos / layout 参数一律忽略
 *
 * 个性化参数（paramSpecs: TEXT_SLIDE_PARAMS）：titleScale 标题字号 / lineGap 行与条目间距 / bulletDelay 要点逐条间隔。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {entryEase} from '../animations/motion';
import {dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {textStrokeCss} from '../utils/textStroke';
import {TEXT_SLIDE_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const TextSlide: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  // 入场节奏跟随片段时长伸缩（5s 为基准；超短片段下限 0.5 倍速，避免动效挤成一团）
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.5);

  // 个性化参数（故事板「参数」页滑块；未调整走 TEXT_SLIDE_PARAMS 默认值）
  const p = makeParamReader(TEXT_SLIDE_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 强调条展开缓动档位：0=模板原曲线（C 批统一时间语言）
  const titleScale = p('titleScale');   // 大标题字号倍率
  const lineGap = p('lineGap');         // 行/条目间距倍率
  const bulletDelay = p('bulletDelay'); // 要点逐条出现间隔倍率

  // ====== 文字内容与节奏 ======
  const features = (text.features ?? []).slice(0, 5);
  const barStart = 4 * pace;
  const titleStart = 8 * pace;
  const subtitleStart = 20 * pace;
  const featureBase = 30 * pace;
  const featureStagger = 10 * pace * bulletDelay;

  // 强调条：从顶部向下展开
  const barProg = interpolate(frame, [barStart, barStart + 14 * pace], [0, 1], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // 几何装饰：随开场淡入到目标低透明度
  const decorProg = fadeIn(frame, 0, 22 * pace);
  // 圆环极缓慢漂移（克制）
  const ringDrift = Math.sin(frame * 0.02) * 8;
  // 驻留微运动：入场完成后内容列保持缓慢漂移（纯文字不加缩放，P2 质感）
  const contentDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, 0);

  // ====== 版式尺寸 ======
  const padX = canvasW * 0.09;
  const accentBarW = Math.max(6, Math.round(canvasW * 0.005));
  const titleSize = style?.title?.fontSize ?? tokens.fontSize.title * titleScale;
  const featureSize = style?.feature?.fontSize ?? tokens.fontSize.body;
  const markerW = Math.max(10, Math.round(tokens.spacing.element));
  const markerH = Math.max(3, Math.round(canvasW * 0.002));

  return (
    <AbsoluteFill>
      {/* 基础背景：浅色渐变（可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}

      {/* 角落几何装饰：右上圆环 + 右下圆角色块（低透明度，不抢戏） */}
      <div
        style={{
          position: 'absolute',
          top: -canvasW * 0.13 + ringDrift,
          right: -canvasW * 0.11,
          width: canvasW * 0.4,
          height: canvasW * 0.4,
          borderRadius: '50%',
          border: `${Math.max(24, Math.round(canvasW * 0.03))}px solid ${ACCENT()}`,
          opacity: 0.07 * decorProg,
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: -canvasW * 0.08,
          right: canvasW * 0.05,
          width: canvasW * 0.24,
          height: canvasW * 0.24,
          borderRadius: canvasW * 0.03,
          transform: 'rotate(18deg)',
          background: ACCENT(),
          opacity: 0.05 * decorProg,
          pointerEvents: 'none',
        }}
      />
      <BackgroundEffectLayer />

      {/* 内容列：左对齐、垂直居中，留白充足 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: canvasH * 0.14,
          bottom: canvasH * 0.14,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          transform: `translate(${contentDrift.x}px, ${contentDrift.y}px)`,
        }}
      >
        {/* 强调条 + 大标题 */}
        {text.title && (
          <div style={{display: 'flex', alignItems: 'stretch', gap: tokens.spacing.element}}>
            <div
              style={{
                width: accentBarW,
                borderRadius: accentBarW / 2,
                background: ACCENT(),
                transform: `scaleY(${barProg})`,
                transformOrigin: 'top',
                flexShrink: 0,
              }}
            />
            <div style={{minWidth: 0}}>
              <AnimatedText
                text={text.title}
                preset={textAnim ?? 'charPop'}
                startFrame={Math.round(titleStart)}
                duration={Math.round(16 * pace)}
                style={{
                  fontSize: titleSize,
                  fontWeight: style?.title?.fontWeight ?? 700,
                  color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
                  letterSpacing: '-0.02em',
                  lineHeight: 1.15,
                  ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
                  ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
                  ...textStrokeCss(style?.title),
                }}
              />
              {text.subtitle && (
                <div style={{marginTop: tokens.spacing.element * lineGap}}>
                  <AnimatedText
                    text={text.subtitle}
                    preset={textAnim ?? 'fadeIn'}
                    startFrame={Math.round(subtitleStart)}
                    duration={Math.round(14 * pace)}
                    style={{
                      fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle,
                      fontWeight: style?.subtitle?.fontWeight ?? 400,
                      color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      letterSpacing: '0.02em',
                      lineHeight: 1.3,
                      ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                      ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
                      ...textStrokeCss(style?.subtitle),
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* 无标题时副标题独立呈现 */}
        {!text.title && text.subtitle && (
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={Math.round(titleStart)}
            duration={Math.round(14 * pace)}
            style={{
              fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle,
              fontWeight: style?.subtitle?.fontWeight ?? 400,
              color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              lineHeight: 1.3,
              ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
              ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
              ...textStrokeCss(style?.subtitle),
            }}
          />
        )}

        {/* 要点列表：逐条入场，前带品牌色短横标记（为空时不渲染） */}
        {features.length > 0 && (
          <div
            style={{
              marginTop: tokens.spacing.section * 0.7 * lineGap,
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spacing.element * lineGap,
            }}
          >
            {features.map((feature, i) => {
              const start = featureBase + i * featureStagger;
              return (
                <div key={i} style={{display: 'flex', alignItems: 'flex-start', gap: tokens.spacing.element * 0.8}}>
                  <div
                    style={{
                      width: markerW,
                      height: markerH,
                      borderRadius: markerH / 2,
                      background: ACCENT(),
                      marginTop: featureSize * 0.55,
                      flexShrink: 0,
                      opacity: fadeIn(frame, start, 10 * pace),
                    }}
                  />
                  <AnimatedText
                    text={feature}
                    preset={textAnim ?? 'charPop'}
                    startFrame={Math.round(start)}
                    duration={Math.round(12 * pace)}
                    style={{
                      fontSize: featureSize,
                      fontWeight: style?.feature?.fontWeight ?? 400,
                      color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBody,
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      letterSpacing: '0.02em',
                      lineHeight: 1.35,
                      ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                      ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                      ...textStrokeCss(style?.feature),
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 品牌名：左下角小字标签（强调色小圆点 + 宽字距小字） */}
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
              ...(style?.brand?.textDecoration ? {textDecoration: style.brand.textDecoration} : {}),
              ...(style?.brand?.fontStyle ? {fontStyle: style.brand.fontStyle} : {}),
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

export default TextSlide;
