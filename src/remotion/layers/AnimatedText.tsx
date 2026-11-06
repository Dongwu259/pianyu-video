/**
 * AnimatedText - 文字动画组件
 *
 * 支持 TextAnimPreset 全套预设（与自定义模板 EntranceAnim 对齐 + 文字专属扩展）：
 * none/fadeIn/fadeUp/slideUp/slideDown/slideLeft/slideRight/scaleIn/popIn/bounce/
 * blurIn/rotateIn/typewriter/charPop/wordReveal/maskWipe/glowPulse
 *
 * 内置模板经 TemplateProps.textAnim 传入 preset；缺省由调用方给定模板默认值。
 * 时间移位经 <Sequence from={startFrame}> 完成：入场前整棵子树不挂载（等价旧的
 * opacity:0 隐藏，且无布局占位副作用），内层 useCurrentFrame() 即 localFrame。
 * 这一结构同时满足 Trail 类时间冻结组件「动效必须由组件内部 useCurrentFrame()
 * 驱动」的约束，将来接运动模糊无需再改结构。
 *
 * 动效口音统一走 src/remotion/animations/motion.ts token：
 * - spring 参数 → SPRINGS.*；逐字错峰 → STAGGER.tight
 * - 位移类入场（fadeUp/slide 系列/rotateIn/wordReveal）统一 premium 曲线（easeOutQuint）：
 *   初段更快、尾段更柔的商业 MG 口音；淡入/遮罩类保持线性不变
 *
 * 用法示例：
 * <AnimatedText text="AI 智能选片" preset={props.textAnim ?? 'fadeUp'} startFrame={15}
 *   style={{fontSize: 72, fontWeight: 700, color: '#111827'}} />
 */

import {Sequence, useCurrentFrame, interpolate, spring} from 'remotion';
import {VIDEO_DESIGN} from '../config/designTokens';
import {SPRINGS, STAGGER, easeOutQuint} from '../animations/motion';
import {entranceBlurAt, springBlurAt, blurFilter} from '../../shared/entrance-blur';
import type {TextAnimPreset} from '../../shared/types';

interface AnimatedTextProps {
  text: string;
  preset?: TextAnimPreset;
  startFrame?: number;
  duration?: number;
  style?: React.CSSProperties;
  className?: string;
}

/** 入场动画持续帧数（打字机/逐字类按内容长度，其余固定） */
const ENTRANCE_DURATION = 24;

export const AnimatedText: React.FC<AnimatedTextProps> = ({startFrame = 0, ...rest}) => (
  <Sequence from={Math.round(startFrame)} layout="none">
    <AnimatedTextInner {...rest} />
  </Sequence>
);

const AnimatedTextInner: React.FC<Omit<AnimatedTextProps, 'startFrame'>> = ({
  text,
  preset = 'fadeIn',
  duration = ENTRANCE_DURATION,
  style,
}) => {
  const localFrame = useCurrentFrame();

  // 入场进度 p（0..1，clamp），eq 为 premium 曲线（easeOutQuint）
  const p = Math.max(0, Math.min(1, localFrame / duration));
  const eq = easeOutQuint(p);
  // 位移类入场的运动模糊半径：按相邻帧真实位移算（入场快段糊、停稳归零），
  // 各向同性 CSS blur 在短入场时长下与方向性模糊观感无差
  const slideBlur = entranceBlurAt(p, 40, duration, easeOutQuint);

  const getAnimatedStyle = (): React.CSSProperties => {
    if (preset === 'none') return {};

    switch (preset) {
      case 'fadeIn':
        return {opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'})};

      case 'fadeUp':
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          transform: `translateY(${(1 - eq) * 40}px)`,
          filter: blurFilter(slideBlur),
        };

      case 'slideUp':
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          transform: `translateY(${(1 - eq) * 40}px)`,
          filter: blurFilter(slideBlur),
        };

      case 'slideDown':
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          transform: `translateY(${(1 - eq) * -40}px)`,
          filter: blurFilter(slideBlur),
        };

      case 'slideLeft': // 从右滑入
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          transform: `translateX(${(1 - eq) * 40}px)`,
          filter: blurFilter(slideBlur),
        };

      case 'slideRight': // 从左滑入
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          transform: `translateX(${(1 - eq) * -40}px)`,
          filter: blurFilter(slideBlur),
        };

      case 'scaleIn': {
        const scaleVal = spring({frame: localFrame, fps: 30, config: SPRINGS.scaleIn});
        return {opacity: Math.min(1, localFrame / 8), transform: `scale(${scaleVal})`};
      }

      case 'popIn': {
        const scaleVal = spring({frame: localFrame, fps: 30, config: SPRINGS.pop});
        return {opacity: Math.min(1, localFrame / 6), transform: `scale(${0.4 + 0.6 * scaleVal})`};
      }

      case 'bounce': {
        const b = spring({frame: localFrame, fps: 30, config: SPRINGS.bounce});
        const bPrev = spring({frame: Math.max(0, localFrame - 1), fps: 30, config: SPRINGS.bounce});
        return {
          opacity: Math.min(1, localFrame / 6),
          transform: `translateY(${(1 - b) * -30}px)`,
          filter: blurFilter(springBlurAt(b, bPrev, 30)),
        };
      }

      case 'blurIn':
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          filter: `blur(${(1 - p) * 12}px)`,
        };

      case 'rotateIn':
        return {
          opacity: interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'}),
          transform: `rotate(${(1 - eq) * -12}deg) scale(${0.92 + 0.08 * p})`,
        };

      case 'typewriter': {
        // 逐字渲染在下方 JSX 处理（需 revealed 数量）
        return {opacity: 1};
      }

      case 'maskWipe': {
        // 遮罩从左向右擦出：clip-path inset 的右边距从 100% -> 0%
        const right = (1 - p) * 100;
        return {opacity: 1, clipPath: `inset(0 ${right}% 0 0)`};
      }

      case 'glowPulse': {
        const opacityVal = interpolate(localFrame, [0, duration], [0, 1], {extrapolateRight: 'clamp'});
        // 入场后持续轻微呼吸（text-shadow 强度随正弦）
        const pulse = 0.5 + 0.5 * Math.sin(localFrame / 14);
        const glow = 6 + pulse * 10;
        return {
          opacity: opacityVal,
          textShadow: `0 0 ${glow}px currentColor`,
        };
      }

      case 'wordReveal':
        // 逐字在下方 JSX 处理
        return {opacity: 1};

      default:
        return {};
    }
  };

  const animatedStyle = getAnimatedStyle();

  // 打字机：逐字显示
  if (preset === 'typewriter') {
    const charsPerSecond = 18;
    const revealed = Math.min(text.length, Math.floor((localFrame * charsPerSecond) / 30));
    return (
      <div style={{fontFamily: VIDEO_DESIGN.titleFont, display: 'inline-block', ...style, opacity: 1}}>
        <span>
          {text.split('').map((char, i) => (
            <span key={i} style={{opacity: i < revealed ? 1 : 0}}>
              {char}
            </span>
          ))}
        </span>
      </div>
    );
  }

  // 逐字上浮：每字依次淡入并上浮
  if (preset === 'wordReveal') {
    const chars = text.split('');
    const perCharDelay = STAGGER.tight; // 每字延迟帧数
    const charDur = 10;
    return (
      <div style={{fontFamily: VIDEO_DESIGN.titleFont, display: 'inline-block', ...style, opacity: 1}}>
        <span>
          {chars.map((char, i) => {
            const cf = localFrame - i * perCharDelay;
            const cp = Math.max(0, Math.min(1, cf / charDur));
            const ce = easeOutQuint(cp);
            const visible = cf >= 0;
            return (
              <span
                key={i}
                style={{
                  opacity: visible ? cp : 0,
                  transform: `translateY(${visible ? (1 - ce) * 18 : 18}px)`,
                  display: 'inline-block',
                  filter: visible ? blurFilter(entranceBlurAt(cp, 18, charDur, easeOutQuint)) : undefined,
                }}
              >
                {char}
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  // 逐字弹入（动力学文字）：按空格分词，词内逐字 spring 弹入；词容器 nowrap 防止英文单词折断
  if (preset === 'charPop') {
    const words = text.split(' ');
    const perCharDelay = STAGGER.tight; // 每字延迟帧数
    let charIndex = 0;
    return (
      <div style={{fontFamily: VIDEO_DESIGN.titleFont, display: 'inline-block', ...style, opacity: 1}}>
        <span>
          {words.map((word, wi) => {
            const chars = word.split('').map((char, ci) => {
              const i = charIndex++;
              const cf = localFrame - i * perCharDelay;
              const visible = cf >= 0;
              const s = spring({
                frame: Math.max(0, cf),
                fps: 30,
                config: SPRINGS.charPop,
              });
              // 多算一帧弹簧值换运动模糊：逐字弹入的高速段不再「硬」
              const sPrev = spring({
                frame: Math.max(0, cf - 1),
                fps: 30,
                config: SPRINGS.charPop,
              });
              return (
                <span
                  key={ci}
                  style={{
                    display: 'inline-block',
                    opacity: visible ? Math.min(1, cf / 5) : 0,
                    transform: `translateY(${visible ? (1 - s) * 24 : 24}px) scale(${visible ? 0.3 + 0.7 * s : 0.3})`,
                    transformOrigin: '50% 100%',
                    filter: visible ? blurFilter(springBlurAt(s, sPrev, 24)) : undefined,
                  }}
                >
                  {char}
                </span>
              );
            });
            return (
              <span key={wi} style={{display: 'inline-block', whiteSpace: 'nowrap'}}>
                {chars}
                {wi < words.length - 1 ? ' ' : ''}
              </span>
            );
          })}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: VIDEO_DESIGN.titleFont,
        display: 'inline-block',
        ...style,
        ...animatedStyle,
      }}
    >
      {text}
    </div>
  );
};

export default AnimatedText;
