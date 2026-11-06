/**
 * LowerThirdBar - 下三分之一字幕条（信息锚点条）
 *
 * 视觉：文字块外侧包裹半透明背景色块（默认黑色 55% 不透明、圆角），
 * 左缘一条强调色竖条；标题粗体、副标题常规。align='center' 时居中并去掉竖条。
 *
 * 入场（总时长约 0.5-0.7s @30fps，链式延迟）：
 * 背景色块从 0 宽度展开（scaleX，transformOrigin 随 align 变化）
 * → 标题淡入上移 → 副标题跟随。
 * 结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责（同 KenBurns 约定）。
 *
 * 本组件只渲染条本身，位置由调用方容器决定（absolute 摆到下 1/3 区域即可）。
 * 字号/间距经 getScaledTokens 按画布宽度等比缩放（竖屏自动缩小）。
 *
 * 用法示例：
 * <div style={{position: 'absolute', left: 96, bottom: 120}}>
 *   <LowerThirdBar title={text.title} subtitle={text.subtitle} textAnim={textAnim} />
 * </div>
 */

import {useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {AnimatedText} from './AnimatedText';
import {EASINGS, STAGGER} from '../animations/motion';
import {getScaledTokens, VIDEO_DESIGN} from '../config/designTokens';
import {textStrokeCss} from '../utils/textStroke';
import type {TextAnimPreset, TextStyle} from '../../shared/types';

export interface LowerThirdBarProps {
  title: string;
  subtitle?: string;
  /** 强调竖条颜色（默认 VIDEO_DESIGN.colors.accent 品牌强调色） */
  accentColor?: string;
  /** 背景色块颜色（默认纯黑，配合 bgOpacity 呈半透明） */
  bgColor?: string;
  /** 背景色块不透明度 0..1（默认 0.55） */
  bgOpacity?: number;
  /** 对齐方式：left（默认，带竖条）/ center（居中，去掉竖条） */
  align?: 'left' | 'center';
  /** 文字入场动效（与模板 textAnim 透传；缺省 fadeUp） */
  textAnim?: TextAnimPreset;
  /** 标题样式覆盖（故事板「样式」页） */
  titleStyle?: TextStyle;
  /** 副标题样式覆盖（故事板「样式」页） */
  subtitleStyle?: TextStyle;
}

export const LowerThirdBar: React.FC<LowerThirdBarProps> = ({
  title,
  subtitle,
  accentColor = VIDEO_DESIGN.colors.accent,
  bgColor = '#000000',
  bgOpacity = 0.55,
  align = 'left',
  textAnim,
  titleStyle,
  subtitleStyle,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);

  // ====== 入场节奏（链式延迟：条展开 → 标题 → 副标题，总计约 21 帧 ≈ 0.7s）======
  // 背景色块从 0 宽度展开
  const barProg = interpolate(frame, [0, 10], [0, 1], {
    easing: EASINGS.standard,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const titleStart = STAGGER.loose; // 标题淡入上移（AnimatedText 内部动画）
  const subtitleStart = titleStart + 6; // 副标题跟随（与标题入场重叠半程）

  // ====== 版式尺寸 ======
  const radius = VIDEO_DESIGN.borderRadius; // 12px 圆角
  const accentBarW = Math.max(4, Math.round(canvasW * 0.0026)); // 强调竖条宽（1920 下约 5px）
  const padY = Math.round(tokens.spacing.element); // 上下 padding
  const padX = Math.round(tokens.spacing.paragraph); // 左右 padding
  const centered = align === 'center';

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'stretch',
        maxWidth: '100%',
        borderRadius: radius,
        overflow: 'hidden', // 裁掉强调竖条与背景色块的圆角外溢
      }}
    >
      {/* 背景色块：从 0 宽度展开（transformOrigin 随对齐方式变化） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: bgColor,
          opacity: bgOpacity,
          borderRadius: radius,
          transform: `scaleX(${barProg})`,
          transformOrigin: centered ? 'center' : 'left',
        }}
      />

      {/* 左缘强调竖条（center 模式去掉）：随条展开从顶部亮出 */}
      {!centered && (
        <div
          style={{
            position: 'relative',
            width: accentBarW,
            background: accentColor,
            transform: `scaleY(${barProg})`,
            transformOrigin: 'top',
            flexShrink: 0,
          }}
        />
      )}

      {/* 文字块：标题粗体 + 副标题常规 */}
      <div
        style={{
          position: 'relative',
          padding: `${padY}px ${padX}px`,
          textAlign: centered ? 'center' : 'left',
          minWidth: 0,
        }}
      >
        <AnimatedText
          text={title}
          preset={textAnim ?? 'fadeUp'}
          startFrame={titleStart}
          duration={10}
          style={{
            fontSize: titleStyle?.fontSize ?? tokens.fontSize.subtitle,
            fontWeight: titleStyle?.fontWeight ?? 700,
            color: titleStyle?.color ?? VIDEO_DESIGN.colors.textTitleDark,
            letterSpacing: '0.02em',
            lineHeight: 1.2,
            ...(titleStyle?.textDecoration ? {textDecoration: titleStyle.textDecoration} : {}),
            ...(titleStyle?.fontStyle ? {fontStyle: titleStyle.fontStyle} : {}),
            ...textStrokeCss(titleStyle),
          }}
        />
        {subtitle && (
          <div style={{marginTop: Math.round(tokens.spacing.tight)}}>
            <AnimatedText
              text={subtitle}
              preset={textAnim ?? 'fadeIn'}
              startFrame={subtitleStart}
              duration={10}
              style={{
                fontSize: subtitleStyle?.fontSize ?? tokens.fontSize.body,
                fontWeight: subtitleStyle?.fontWeight ?? 400,
                color: subtitleStyle?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                fontFamily: VIDEO_DESIGN.bodyFont,
                letterSpacing: '0.02em',
                lineHeight: 1.3,
                ...(subtitleStyle?.textDecoration ? {textDecoration: subtitleStyle.textDecoration} : {}),
                ...(subtitleStyle?.fontStyle ? {fontStyle: subtitleStyle.fontStyle} : {}),
                ...textStrokeCss(subtitleStyle),
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default LowerThirdBar;
