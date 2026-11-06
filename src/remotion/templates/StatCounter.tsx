/**
 * 模板: StatCounter - 数据页（说服力场景）
 *
 * 效果: 大号数字从 0 滚动到目标值的统计页（Envato Statistics 独立品类、
 * animated numbers 检索 870+ 的市场缺口）。数字滚动用 easeOutQuint（先快后缓，
 * 收尾的「减速感」是商业计数器的手感核心），后缀单位弹入，标签渐显。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 页面标题（如「用数字说话」）
 * - features: 数据行，每行「<数值><可选后缀> <标签>」：
 *   「99.9% 服务可用率」「3000万+ 累计用户」「1,200,000 次调用」「3x 效率提升」
 *   解析失败（非数值开头）的行按原文静态展示，不丢文案
 * - brandName: 左下角品牌小字
 *
 * 画面结构：
 * - 浅色渐变背景 + 角落低透明度几何装饰（同 TextSlide 家族语言）
 * - 横版：标题居上，数据卡横排（≤4 张，卡间细分隔线）；
 *   竖版：标题居上，数据卡纵排单列，数字随位数自动缩放防溢出
 *
 * 个性化参数（paramSpecs: STAT_COUNTER_PARAMS）：valueScale 数字大小 /
 * countSpeed 计数速度 / stagger 卡片错峰。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {EASINGS, SPRINGS, entryEase} from '../animations/motion';
import {dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {textStrokeCss} from '../utils/textStroke';
import {parseStatLine, formatStatValue, type StatItem} from '../../shared/promo-text-parse';
import {STAT_COUNTER_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const StatCounter: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 版式分支（画幅审计 P1-4）：方形/近方形/竖画幅走纵排单列（横排多卡在窄画幅挤压
  // 换行）；行间距、卡片宽度按内容比例——不再按画布高度分数锚定（21:9 拉稀/方形
  // 挤压/竖屏稀疏同根源，横竖同修）
  const stacked = canvasW < canvasH * 1.2;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  // 节奏随片段时长伸缩（5s 基准，下限 0.5 倍防超短片段动效挤成一团）
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.5);

  const p = makeParamReader(STAT_COUNTER_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 卡片入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const valueScale = p('valueScale'); // 数字字号倍率
  const countSpeed = p('countSpeed'); // 计数速度倍率（越大滚得越快）
  const stagger = p('stagger');       // 卡片错峰倍率

  // ====== 数据解析（≤4 张；解析失败的行按原文静态展示） ======
  const stats: Array<StatItem | null> = (text.features ?? []).slice(0, 4).map((line) => parseStatLine(line));

  // ====== 节奏 ======
  const titleStart = 6 * pace;
  const baseStart = 16 * pace;
  const cardStagger = 12 * pace * stagger;
  const countFrames = Math.max(10, 36 / countSpeed) * pace;

  // ====== 版式 ======
  const padX = canvasW * (stacked ? 0.1 : 0.12);
  const cardW = canvasW - padX * 2;
  // 数字基准：横排按 16:9 等效值封顶（21:9 上按宽度等比会到 141px，竖向版式装不下）
  const baseNumSize = (stacked ? canvasW * 0.15 : Math.min(canvasW * 0.056, canvasH * 0.1)) * valueScale;
  // 位数自适应：长数字（1,250,000）按可用宽度收缩，避免溢出卡片
  const numSizeFor = (item: StatItem | null): number => {
    if (!item) return tokens.fontSize.subtitle;
    const sample = formatStatValue(item, item.value);
    return Math.min(baseNumSize, cardW / (Math.max(sample.length, 1) * 0.62));
  };

  // ====== 单张数据卡 ======
  const renderCard = (item: StatItem | null, i: number) => {
    const start = baseStart + i * cardStagger;
    // 卡片入场：淡入 + 上浮归位（计数随后开始）
    const cardProg = interpolate(frame, [start, start + 14 * pace], [0, 1], {
      easing: entry,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const numSize = numSizeFor(item);
    // 驻留微运动：入场完成后卡片保持缓慢漂移（幅度随画幅缩放，phase 按卡片错开）
    const drift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, i * 1.37);

    // 数字滚动：easeOutQuint 收尾减速；suffix 在计数 ~82% 时弹入（先有数量感再锁定单位）
    const suffixStart = start + countFrames * 0.82;
    const suffixPop = spring({frame: frame - suffixStart, fps: FPS, config: SPRINGS.pop});
    const current = item
      ? interpolate(frame, [start + 2, start + countFrames], [0, item.value], {
          easing: EASINGS.standard,
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 0;
    const labelStart = suffixStart + 4 * pace;

    return (
      <div
        key={i}
        style={{
          flex: stacked ? undefined : 1,
          width: stacked ? cardW : undefined,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: cardProg,
          transform: `translateY(${(1 - cardProg) * 22 * pace + drift.y}px) translateX(${drift.x}px)`,
          minWidth: 0,
        }}
      >
        {item ? (
          <>
            <div style={{display: 'flex', alignItems: 'baseline', justifyContent: 'center'}}>
              <span
                style={{
                  fontSize: numSize,
                  fontWeight: 800,
                  color: style?.title?.color ?? ACCENT(),
                  fontFamily: VIDEO_DESIGN.titleFont,
                  letterSpacing: '-0.02em',
                  lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                  ...textStrokeCss(style?.title),
                }}
              >
                {formatStatValue(item, current)}
              </span>
              {item.suffix && (
                <span
                  style={{
                    fontSize: numSize * 0.42,
                    fontWeight: 700,
                    color: style?.title?.color ?? ACCENT(),
                    fontFamily: VIDEO_DESIGN.titleFont,
                    lineHeight: 1,
                    opacity: suffixPop,
                    transform: `scale(${0.5 + suffixPop * 0.5})`,
                    transformOrigin: 'left bottom',
                    marginLeft: numSize * 0.06,
                  }}
                >
                  {item.suffix}
                </span>
              )}
            </div>
            {item.label && (
              <AnimatedText
                text={item.label}
                preset={textAnim ?? 'fadeUp'}
                startFrame={Math.round(labelStart)}
                duration={Math.round(12 * pace)}
                style={{
                  fontSize: style?.feature?.fontSize ?? tokens.fontSize.body,
                  fontWeight: style?.feature?.fontWeight ?? 400,
                  color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBody,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  marginTop: tokens.spacing.element * 1.2,
                  lineHeight: 1.35,
                  textAlign: 'center',
                  ...textStrokeCss(style?.feature),
                }}
              />
            )}
          </>
        ) : (
          // 解析失败的行：按原文静态展示（不丢文案）
          <AnimatedText
            text={(text.features ?? [])[i] ?? ''}
            preset={textAnim ?? 'fadeUp'}
            startFrame={Math.round(start)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: tokens.fontSize.subtitle,
              fontWeight: 500,
              color: VIDEO_DESIGN.colors.textBody,
              fontFamily: VIDEO_DESIGN.bodyFont,
              lineHeight: 1.4,
              textAlign: 'center',
            }}
          />
        )}
      </div>
    );
  };

  return (
    <AbsoluteFill>
      {/* 背景层：浅色渐变（可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}

      {/* 角落几何装饰（同 TextSlide 家族语言，低透明度不抢数字戏） */}
      <div
        style={{
          position: 'absolute',
          top: -canvasW * 0.12,
          left: -canvasW * 0.1,
          width: canvasW * 0.34,
          height: canvasW * 0.34,
          borderRadius: '50%',
          border: `${Math.max(20, Math.round(canvasW * 0.026))}px solid ${ACCENT()}`,
          opacity: 0.06 * fadeIn(frame, 0, 22 * pace),
          pointerEvents: 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: -canvasW * 0.1,
          right: -canvasW * 0.08,
          width: canvasW * 0.26,
          height: canvasW * 0.26,
          borderRadius: canvasW * 0.03,
          transform: 'rotate(18deg)',
          background: ACCENT(),
          opacity: 0.05 * fadeIn(frame, 0, 22 * pace),
          pointerEvents: 'none',
        }}
      />
      <BackgroundEffectLayer />

      {/* 内容盒（画幅审计 P1-4）：标题+数据卡同盒垂直居中，盒内间距=内容比例
          （标题字号×0.55 / 数字大小×1.7），留边给背景——替换旧「标题 0.15H 锚定 +
          数据区 0.34→0.82H 锚定」的画布高度分数版式 */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
          top: canvasH * (stacked ? 0.08 : 0.12),
          bottom: canvasH * (stacked ? 0.14 : 0.16),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.fontSize.title * 0.55,
        }}
      >
        {text.title && (
          <div style={{display: 'flex', justifyContent: 'center', maxWidth: '100%'}}>
            <AnimatedText
              text={text.title}
              preset={textAnim ?? 'charPop'}
              startFrame={Math.round(titleStart)}
              duration={Math.round(16 * pace)}
              style={{
                fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.72,
                fontWeight: style?.title?.fontWeight ?? 700,
                color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
                fontFamily: VIDEO_DESIGN.titleFont,
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
                textAlign: 'center',
                ...textStrokeCss(style?.title),
              }}
            />
          </div>
        )}

        {/* 数据卡区：横排 + 细分隔线；纵排单列（方形/竖画幅） */}
        <div
          style={{
            display: 'flex',
            flexDirection: stacked ? 'column' : 'row',
            justifyContent: 'center',
            alignItems: stacked ? 'center' : 'stretch',
            gap: stacked ? canvasH * 0.045 : 0,
            width: '100%',
          }}
        >
          {stats.map((item, i) => (
            <React.Fragment key={i}>
              {renderCard(item, i)}
              {!stacked && i < stats.length - 1 && (
                <div
                  style={{
                    width: 1,
                    alignSelf: 'center',
                    height: Math.max(60, baseNumSize * 1.7),
                    background: 'rgba(17, 24, 39, 0.1)',
                    opacity: fadeIn(frame, baseStart + i * cardStagger + 8 * pace, 10 * pace),
                    flexShrink: 0,
                  }}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* 品牌名：左下角小字（同 TextSlide 约定） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: padX,
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

export default StatCounter;
