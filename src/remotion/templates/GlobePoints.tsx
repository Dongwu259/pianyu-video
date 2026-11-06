/**
 * 模板: GlobePoints - 环球点阵（进阶装置，WorldMap 的免素材版）
 *
 * 效果: 正交投影的点阵地球——斐波那契球面布点、缓慢自转（背向点淡出、
 * 临边点变小，天然立体），固定数个节点品牌色高亮 + 扩散脉冲环表达
 * 「全球用户/节点」；底部数据条复用 StatCounter 的行解析（数字滚动）。
 * 相比平面世界地图：无需地图数据、风格与深色科技底更统一。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 标题（如「全球在运行」）
 * - features: 数据行（同 StatCounter 格式「数值 后缀 标签」，≤3 条；
 *   非数值行按原文芯片展示）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: GLOBE_POINTS_PARAMS）：globeScale 球体大小 /
 * rotateSpeed 自转速度 / dotDensity 点密度。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {entryEase} from '../animations/motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {parseStatLine, formatStatValue} from '../../shared/promo-text-parse';
import {GLOBE_POINTS_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** 高亮节点的固定下标（在 0..N-1 上取分散的 6 个） */
const HOT_INDICES = [0.04, 0.19, 0.37, 0.55, 0.71, 0.88];

interface SpherePoint {
  x: number;
  y: number;
  z: number;
  hot: boolean;
}

/** 斐波那契球面布点（确定性：同 N 结果一致，渲染缓存友好） */
const buildSphere = (count: number): SpherePoint[] => {
  const hotSet = new Set(HOT_INDICES.map((f) => Math.floor(f * count)));
  const pts: SpherePoint[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * GOLDEN_ANGLE;
    pts.push({x: Math.cos(theta) * r, y, z: Math.sin(theta) * r, hot: hotSet.has(i)});
  }
  return pts;
};

export const GlobePoints: React.FC<TemplateProps> = ({text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(GLOBE_POINTS_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 数字滚入缓动档位：0=模板原曲线（C 批统一时间语言）
  const globeScale = p('globeScale');   // 球体大小倍率
  const rotateSpeed = p('rotateSpeed'); // 自转速度倍率
  const dotDensity = p('dotDensity');   // 点密度倍率（点数 = 320 × 倍率）

  const stats = (text.features ?? []).slice(0, 3).map((line) => parseStatLine(line));

  // ====== 球面：绕 Y 轴自转 + 轻微 X 倾角，正交投影 ======
  const N = Math.max(120, Math.round(320 * dotDensity));
  const sphere = React.useMemo(() => buildSphere(N), [N]);
  const R = Math.min(canvasW, canvasH) * (isPortrait ? 0.3 : 0.31) * globeScale;
  const cx = canvasW / 2;
  const cy = canvasH * (isPortrait ? 0.38 : 0.46);
  const rotY = frame * 0.006 * rotateSpeed;
  const tiltX = 0.38; // 弧度，把北极向观者倾斜，更像「地球仪」
  const sinT = Math.sin(tiltX);
  const cosT = Math.cos(tiltX);
  const sinR = Math.sin(rotY);
  const cosR = Math.cos(rotY);

  const projected = sphere.map((pt) => {
    // 绕 Y 轴
    const x1 = pt.x * cosR + pt.z * sinR;
    const z1 = -pt.x * sinR + pt.z * cosR;
    // 绕 X 轴（倾斜视角）
    const y2 = pt.y * cosT - z1 * sinT;
    const z2 = pt.y * sinT + z1 * cosT;
    return {
      sx: cx + x1 * R,
      sy: cy - y2 * R,
      depth: z2, // >0 朝向观者
      hot: pt.hot,
    };
  });

  const dotBase = Math.max(1.4, R * 0.013);
  const appear = fadeIn(frame, 2, 16 * pace);

  // 高亮节点脉冲（各节点相位错开）
  const pulseAt = (i: number) => 0.5 + 0.5 * Math.sin(frame * 0.08 + i * 1.7);

  // ====== 数据条：数字滚动（复用 StatCounter 解析/格式化） ======
  const statBase = 20 * pace;
  const statStagger = 12 * pace;
  const chipFs = tokens.fontSize.body * 0.95;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 标题 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.1,
            right: canvasW * 0.1,
            top: canvasH * (isPortrait ? 0.11 : 0.12),
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={Math.round(4 * pace)}
            duration={Math.round(16 * pace)}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.66,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              fontFamily: VIDEO_DESIGN.titleFont,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              textAlign: 'center',
              ...textStrokeCss(style?.title),
            }}
          />
        </div>
      )}

      {/* 点阵球（svg 统一绘制，一次遍历） */}
      <svg style={{position: 'absolute', left: 0, top: 0, pointerEvents: 'none'}} width={canvasW} height={canvasH}>
        {/* 球体轮廓微光 */}
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={`${ACCENT()}26`} strokeWidth={1.5} opacity={appear} />
        {projected.map((pt, i) => {
          if (pt.depth <= 0.02) return null; // 背向面不画
          const vis = 0.25 + pt.depth * 0.75; // 临边淡出
          const rr = dotBase * (0.55 + pt.depth * 0.6);
          const pulse = pt.hot ? pulseAt(i) : 0;
          return (
            <g key={i} opacity={appear * vis}>
              <circle cx={pt.sx} cy={pt.sy} r={rr} fill={pt.hot ? ACCENT() : '#8FA3C8'} />
              {pt.hot && (
                <circle
                  cx={pt.sx}
                  cy={pt.sy}
                  r={rr + dotBase * (1.5 + pulse * 2.2)}
                  fill="none"
                  stroke={ACCENT()}
                  strokeWidth={1.2}
                  opacity={0.55 * (1 - pulse)}
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* 数据条：底部居中（竖版抬到安全区上） */}
      {stats.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.08,
            right: canvasW * 0.08,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.1),
            display: 'flex',
            justifyContent: 'center',
            gap: canvasW * 0.035,
            flexWrap: 'wrap',
          }}
        >
          {stats.map((item, i) => {
            const start = statBase + i * statStagger;
            const countDur = 30 * pace;
            const current = item
              ? interpolate(frame, [start + 2, start + countDur], [0, item.value], {
                  easing: entry,
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                })
              : 0;
            const rise = fadeIn(frame, start, 10 * pace);
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  opacity: rise,
                  transform: `translateY(${(1 - rise) * 14}px)`,
                }}
              >
                {item ? (
                  <>
                    <div style={{display: 'flex', alignItems: 'baseline'}}>
                      <span
                        style={{
                          fontSize: chipFs * 1.35,
                          fontWeight: 800,
                          color: ACCENT(),
                          fontFamily: VIDEO_DESIGN.titleFont,
                          lineHeight: 1.15,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {formatStatValue(item, current)}
                      </span>
                      {item.suffix && (
                        <span style={{fontSize: chipFs * 0.7, fontWeight: 700, color: ACCENT(), fontFamily: VIDEO_DESIGN.titleFont, marginLeft: 2}}>
                          {item.suffix}
                        </span>
                      )}
                    </div>
                    {item.label && (
                      <span
                        style={{
                          fontSize: chipFs * 0.72,
                          fontWeight: 400,
                          color: 'rgba(203, 213, 225, 0.85)',
                          fontFamily: VIDEO_DESIGN.bodyFont,
                          lineHeight: 1.4,
                          marginTop: tokens.spacing.tight,
                        }}
                      >
                        {item.label}
                      </span>
                    )}
                  </>
                ) : (
                  <span
                    style={{
                      fontSize: chipFs,
                      fontWeight: 500,
                      color: 'rgba(203, 213, 225, 0.9)',
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      lineHeight: 1.4,
                    }}
                  >
                    {(text.features ?? [])[i] ?? ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 品牌名 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.06,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.045),
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
              color: style?.brand?.color ?? VIDEO_DESIGN.colors.textBodyDark,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.14em',
            }}
          >
            {text.brandName}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default GlobePoints;
