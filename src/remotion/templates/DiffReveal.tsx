/**
 * 模板: DiffReveal - AI 改写 diff 段（2026-10-13 真缺口批，「模型自由改」卖点终极形态）
 *
 * 效果: 深色 diff 面板——上下文行暗、删除行红色调 + 划线动画淡出、新增行品牌色/绿色调
 * 高亮呼吸。「AI 改了什么」的改动清单可视化；BeforeAfter 是双素材 A/B，这里是文本 diff。
 *
 * diff 源（v1 = 手写行，零 schema 依赖）：features 每行一条，前缀 '-'=删除、'+'=新增、
 * 无前缀=上下文（parseDiffRows）。装配侧可从时间线 plan 摘要（get_segment_plan v1.3+）的
 * 改动手工转写行（字幕行改写/节拍增删/素材窗移动都能表达）——plan 直采自动生成行是
 * 后续扩展方向，本版不锁接口。
 *
 * 文案编码：title = 标题行（如「AI 改了什么」）；subtitle = 改动摘要（如「3 处改动 · 卡点对齐」）；
 * brandName 左下角。个性化参数（DIFF_REVEAL_PARAMS）：codeScale 行字号 / stagger 逐行节奏 /
 * glow 差异呼吸（新增行高亮呼吸，0 关）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {SPRINGS, entryEase} from '../animations/motion';
import {dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {wideAspectCap} from '../utils/aspectLayout';
import {parseDiffRows} from '../../shared/promo-text-parse';
import {DIFF_REVEAL_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const DiffReveal: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(DIFF_REVEAL_PARAMS, params);
  const entry = entryEase(p('motionEase'));
  const codeScale = p('codeScale');
  const stagger = p('stagger');
  const glow = p('glow');

  const rows = parseDiffRows(text.features);
  const delCount = rows.filter((r) => r.kind === 'del').length;
  const addCount = rows.filter((r) => r.kind === 'add').length;

  // ====== 节奏：卡入场 → 标题 → 行逐条（ctx 快、差异行成对重拍）→ 摘要 ======
  const cardStart = 3 * pace;
  const headStart = 7 * pace;
  const rowBase = 15 * pace;
  const rowStagger = 9 * pace * stagger;
  const summaryStart = rowBase + rows.length * rowStagger + 6 * pace;
  // 差异呼吸：新增行高亮透明度缓动（glow 关则恒定）
  const breathe = glow > 0.5 ? 0.5 + 0.5 * Math.sin(frame * 0.06) : 0.5;

  // ====== 版式：卡宽 16:9 等效封顶（超宽不拉稀，aspect 批纪律） ======
  const cap = wideAspectCap(canvasW, canvasH);
  const cardW = canvasW * (isPortrait ? 0.88 : 0.74) * (isPortrait ? 1 : cap);
  const rowFs = (isPortrait ? tokens.fontSize.body * 1.02 : tokens.fontSize.body * 1.05) * codeScale;
  const rowH = rowFs * 2.35;
  const headFs = tokens.fontSize.title * 0.5;
  const cardH =
    rowFs * 2.4 /* 头部 */ + rows.length * rowH + rowFs * 1.2 /* 摘要行 */ + rowFs * 1.6 /* 内边距余量 */;

  const cardRise = interpolate(frame, [cardStart, cardStart + 16 * pace], [0, 1], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const drift = dwellDrift(frame, FPS, 3 * (canvasW / 1920), 2 * (canvasW / 1920), 10, 0.53);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBottom: canvasH * 0.04,
        }}
      >
        <div
          style={{
            width: cardW,
            minHeight: cardH,
            background: 'rgba(13, 17, 32, 0.94)',
            borderRadius: Math.max(14, canvasW * 0.012),
            border: '1px solid rgba(148, 163, 184, 0.18)',
            boxShadow: `0 ${canvasH * 0.04}px ${canvasH * 0.09}px rgba(2, 6, 23, 0.55)`,
            overflow: 'hidden',
            opacity: cardRise,
            transform: `translateY(${(1 - cardRise) * 42 * pace}px) translate(${drift.x}px, ${drift.y}px)`,
          }}
        >
          {/* 面板头：窗口点 + 标题 + 摘要（终端卡同款语言） */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing.element * 0.8,
              padding: `${rowFs * 0.95}px ${rowFs * 1.35}px`,
              borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
            }}
          >
            <div style={{display: 'flex', gap: rowFs * 0.3}}>
              {['#F87171', '#FBBF24', '#34D399'].map((c) => (
                <div key={c} style={{width: rowFs * 0.42, height: rowFs * 0.42, borderRadius: '50%', background: c, opacity: 0.85}} />
              ))}
            </div>
            {text.title && (
              <AnimatedText
                text={text.title}
                preset={textAnim ?? 'fadeIn'}
                startFrame={Math.round(headStart)}
                duration={Math.round(12 * pace)}
                style={{
                  fontSize: headFs,
                  fontWeight: 700,
                  color: style?.title?.color ?? '#F1F5F9',
                  fontFamily: VIDEO_DESIGN.titleFont,
                  lineHeight: 1.2,
                  ...textStrokeCss(style?.title),
                }}
              />
            )}
          </div>

          {/* diff 行列表 */}
          <div style={{padding: `${rowFs * 0.7}px ${rowFs * 1.35}px`}}>
            {rows.map((row, i) => {
              const start = rowBase + i * rowStagger;
              const prog = spring({frame: frame - start, fps: FPS, config: SPRINGS.cardSettle});
              const isDel = row.kind === 'del';
              const isAdd = row.kind === 'add';
              // 删除线在行入场后划出（延迟 6 帧起，10 帧划完）
              const strike = isDel
                ? interpolate(frame, [start + 6 * pace, start + 16 * pace], [0, 1], {
                    extrapolateLeft: 'clamp',
                    extrapolateRight: 'clamp',
                  })
                : 0;
              const rowBg = isDel
                ? `rgba(248, 113, 113, ${0.07 + 0.05 * (1 - strike)})`
                : isAdd
                  ? `rgba(52, 211, 153, ${glow > 0.5 ? 0.08 + 0.06 * breathe : 0.1})`
                  : 'transparent';
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: rowFs * 0.55,
                    height: rowH,
                    padding: `0 ${rowFs * 0.55}px`,
                    margin: `0 ${-rowFs * 0.55}px ${rowFs * 0.18}px`,
                    borderRadius: rowFs * 0.35,
                    background: rowBg,
                    borderLeft: isAdd ? `${Math.max(2, rowFs * 0.1)}px solid ${ACCENT()}` : 'none',
                    opacity: Math.min(1, prog * 1.5),
                    transform: `translateX(${(1 - Math.min(1, prog * 1.5)) * -20 * pace}px)`,
                  }}
                >
                  {/* 行号槽（终端语言）+ 类型符 */}
                  <span
                    style={{
                      width: rowFs * 1.4,
                      flex: 'none',
                      textAlign: 'right',
                      fontSize: rowFs * 0.72,
                      fontFamily: VIDEO_DESIGN.monoFont,
                      color: 'rgba(148, 163, 184, 0.5)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      width: rowFs * 0.85,
                      flex: 'none',
                      fontSize: rowFs * 0.82,
                      fontFamily: VIDEO_DESIGN.monoFont,
                      color: isDel ? 'rgba(248, 113, 113, 0.85)' : isAdd ? '#34D399' : 'rgba(148, 163, 184, 0.45)',
                      fontWeight: 700,
                    }}
                  >
                    {isDel ? '−' : isAdd ? '+' : ' '}
                  </span>
                  <span
                    style={{
                      position: 'relative',
                      fontSize: rowFs,
                      fontFamily: `${VIDEO_DESIGN.monoFont}, ${VIDEO_DESIGN.bodyFont}`,
                      color: isDel
                        ? `rgba(148, 163, 184, ${0.95 - 0.45 * strike})`
                        : isAdd
                          ? `rgba(226, 232, 240, ${glow > 0.5 ? 0.92 + 0.08 * breathe : 1})`
                          : 'rgba(148, 163, 184, 0.8)',
                      lineHeight: 1.4,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {row.text}
                    {/* 删除线覆盖层（scaleX 从左划出） */}
                    {isDel && (
                      <span
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: '52%',
                          width: '100%',
                          height: Math.max(1.5, rowFs * 0.055),
                          background: 'rgba(248, 113, 113, 0.75)',
                          transform: `scaleX(${strike})`,
                          transformOrigin: 'left center',
                        }}
                      />
                    )}
                  </span>
                </div>
              );
            })}

            {/* 摘要行：−N +M（git stat 语言） */}
            {text.subtitle && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: rowFs * 0.6,
                  marginTop: rowFs * 0.55,
                  paddingTop: rowFs * 0.55,
                  borderTop: '1px dashed rgba(148, 163, 184, 0.16)',
                  opacity: interpolate(frame, [summaryStart, summaryStart + 12 * pace], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
                }}
              >
                <span style={{fontSize: rowFs * 0.8, fontFamily: VIDEO_DESIGN.monoFont, color: 'rgba(248, 113, 113, 0.8)'}}>
                  −{delCount}
                </span>
                <span style={{fontSize: rowFs * 0.8, fontFamily: VIDEO_DESIGN.monoFont, color: '#34D399'}}>
                  +{addCount}
                </span>
                <span style={{fontSize: rowFs * 0.8, color: 'rgba(148, 163, 184, 0.85)', fontFamily: VIDEO_DESIGN.bodyFont}}>
                  {text.subtitle}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 品牌名 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * (isPortrait ? 0.09 : 0.12),
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.05),
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

export default DiffReveal;
