/**
 * 模板: TimelineRoadmap - 流程时间线（叙事补充场景）
 *
 * 效果: 轴线延伸 + 节点逐个爆开 + 标签浮现（CapCut「Process Template」热搜品类）。
 * 横版 = 水平轴线（节点上下交错排布）；竖版 = 垂直轴线（节点右侧成行）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 页面标题（如「产品演进」）；subtitle 副标题可选
 * - features: 节点行「节点标签 节点描述」，首个空格前是标签（如「v1.0」「2024Q1」），其后是描述（≤5 节点）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: TIMELINE_ROADMAP_PARAMS）：nodeScale 节点大小 /
 * stagger 节点节奏 / axisSpeed 轴线速度。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {entryEase, SPRINGS} from '../animations/motion';
import {dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {parseTimelineNode} from '../../shared/promo-text-parse';
import {TIMELINE_ROADMAP_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const TimelineRoadmap: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(TIMELINE_ROADMAP_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const nodeScale = p('nodeScale'); // 节点大小倍率
  const stagger = p('stagger');     // 节点错峰倍率
  const axisSpeed = p('axisSpeed'); // 轴线生长速度倍率

  const nodes = (text.features ?? []).slice(0, 5).map(parseTimelineNode);
  const n = nodes.length;

  // ====== 节奏：轴线先长，节点跟随轴的进度逐个落位 ======
  const axisStart = 8 * pace;
  const axisDur = Math.max(12, (16 + n * 6) / axisSpeed) * pace;
  const axisProg = interpolate(frame, [axisStart, axisStart + axisDur], [0, 1], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // 节点 i 在轴长到其位置时出现（长轴与节点天然同步，stagger 再整体调节疏密）
  const nodeAt = (i: number) => axisStart + axisDur * (n <= 1 ? 0.5 : i / (n - 1)) * (2 - stagger) + 2;

  // ====== 版式 ======
  const padX = canvasW * (isPortrait ? 0.08 : 0.1);
  const dotR = Math.max(9, canvasW * (isPortrait ? 0.014 : 0.009) * nodeScale);
  const chipFs = tokens.fontSize.caption * 1.05 * nodeScale;
  const labelFs = tokens.fontSize.body * 0.86 * nodeScale;

  // 横版：水平轴线 y 56%，节点标签上下交错；竖版：垂直轴线 x 26%，标签右侧成行
  const axisL = isPortrait ? canvasW * 0.26 : padX;
  const axisT = isPortrait ? canvasH * 0.32 : canvasH * 0.56;
  const axisLen = isPortrait ? canvasH * 0.5 : canvasW - padX * 2;
  const slotW = (axisLen / Math.max(n, 1)) * 1.05;
  const posOf = (i: number) => {
    const f = n <= 1 ? 0.5 : i / (n - 1);
    return isPortrait ? {x: axisL, y: axisT + axisLen * f} : {x: axisL + axisLen * f, y: axisT};
  };

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 标题 + 副标题：顶部居中（竖版抬到安全区内） */}
      <div
        style={{
          position: 'absolute',
          left: padX,
          right: padX,
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
            startFrame={Math.round(4 * pace)}
            duration={Math.round(16 * pace)}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.66,
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
            startFrame={Math.round(12 * pace)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: tokens.fontSize.subtitle * 0.72,
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

      {/* 轴线（生长动画） */}
      <div
        style={{
          position: 'absolute',
          left: axisL,
          top: axisT,
          width: isPortrait ? 2 : axisLen,
          height: isPortrait ? axisLen : 2,
          background: `linear-gradient(90deg, ${ACCENT()}55, ${ACCENT()})`,
          transformOrigin: isPortrait ? 'top' : 'left',
          transform: isPortrait ? `scaleY(${axisProg})` : `scaleX(${axisProg})`,
          borderRadius: 2,
        }}
      />

      {/* 节点：圆点爆开 + 标签浮现 */}
      {nodes.map((node, i) => {
        const at = nodeAt(i);
        const pop = spring({frame: frame - Math.round(at), fps: FPS, config: SPRINGS.pop});
        const {x, y} = posOf(i);
        const appear = fadeIn(frame, at + 2, 10 * pace);
        const up = i % 2 === 0; // 横版上下交错
        // 驻留微运动：节点入场完成后圆点+标签整体缓慢漂移（纯文字/标签不加呼吸，P2 质感）
        const drift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, i * 1.37);

        const dot = (
          <div
            style={{
              position: 'absolute',
              left: x - dotR,
              top: y - dotR,
              width: dotR * 2,
              height: dotR * 2,
              borderRadius: '50%',
              background: ACCENT(),
              boxShadow: `0 0 0 ${Math.max(3, dotR * 0.4)}px ${ACCENT()}22`,
              opacity: pop,
              transform: `scale(${0.3 + pop * 0.7}) translate(${drift.x}px, ${drift.y}px)`,
            }}
          />
        );

        const chipBlock = (
          <div style={{minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: isPortrait ? 'flex-start' : 'center'}}>
            {node.tag && (
              <div
                style={{
                  background: VIDEO_DESIGN.colors.accentLight,
                  color: ACCENT(),
                  borderRadius: chipFs * 0.6,
                  padding: `${chipFs * 0.14}px ${chipFs * 0.5}px`,
                  fontSize: chipFs,
                  fontWeight: 700,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  lineHeight: 1.3,
                  opacity: appear,
                }}
              >
                {node.tag}
              </div>
            )}
            {node.label && (
              <AnimatedText
                text={node.label}
                preset={textAnim ?? 'fadeUp'}
                startFrame={Math.round(at + 6 * pace)}
                duration={Math.round(12 * pace)}
                style={{
                  fontSize: labelFs,
                  fontWeight: 400,
                  color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBody,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  lineHeight: 1.35,
                  marginTop: tokens.spacing.element * 0.5,
                  textAlign: isPortrait ? 'left' : 'center',
                  maxWidth: isPortrait ? canvasW * 0.6 : canvasW / Math.max(n, 2) * 0.72,
                  ...textStrokeCss(style?.feature),
                }}
              />
            )}
          </div>
        );

        return (
          <React.Fragment key={i}>
            {dot}
            {/* 标签容器：竖版在轴右侧成行；横版上下交错、中心对齐节点（边缘钳制不溢出画布） */}
            <div
              style={{
                position: 'absolute',
                transform: `translate(${drift.x}px, ${drift.y}px)`,
                ...(isPortrait
                  ? {
                      left: x + dotR * 2.6,
                      top: y - dotR,
                      width: canvasW - x - dotR * 2.6 - padX,
                      height: dotR * 2,
                      display: 'flex',
                      alignItems: 'center',
                    }
                  : {
                      left: Math.min(Math.max(x, slotW / 2 + padX), canvasW - padX - slotW / 2) - slotW / 2,
                      top: up ? undefined : y + dotR * 2.2,
                      bottom: up ? canvasH - y + dotR * 2.2 : undefined,
                      width: slotW,
                      display: 'flex',
                      justifyContent: 'center',
                      opacity: appear,
                    }),
              }}
            >
              {chipBlock}
            </div>
          </React.Fragment>
        );
      })}

      {/* 品牌名：左下角小字（竖版抬到安全区） */}
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

export default TimelineRoadmap;
