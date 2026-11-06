/**
 * 模板: NeonTech - 暗色霓虹科技风
 *
 * 画面结构：
 * - 近黑蓝（#0a0e1a 系）渐变背景 + 细网格 + CRT 扫描线 + 缓慢下扫的扫描光带
 * - 视频画框居中悬浮：霓虹描边 + 四角括号，入场时描边"点亮"（霓虹点火式微闪烁）
 * - 多段视频在同一画框内依次交叉淡化切换，画框保持常亮
 * - 顶部标题/副标题带克制辉光入场，底部功能要点逐条入场
 * - 片尾功能要点淡出，品牌名带辉光渐入收尾
 *
 * 个性化参数（paramSpecs: NEON_TECH_PARAMS）：frameScale 画框尺寸 / glow 辉光强度（含文字辉光，0 = 无辉光）/ gridOpacity 网格与扫描线透明度（0 = 隐藏）。
 */

import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Video3D} from '../layers/Video3D';
import {AnimatedText} from '../layers/AnimatedText';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {calculateSlotTiming, trailingForExit} from '../utils/timing';
import {fadeIn} from '../animations/keyframes';
import {EASINGS, entryEase} from '../animations/motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {NEON_TECH_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

/** 霓虹强调色（rgb 分量，拼 rgba 用） */
const CYAN = '34, 211, 238'; // #22d3ee
const BLUE = '59, 130, 246'; // #3b82f6

export const NeonTech: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
  exitStyle,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const videoCount = Math.max(videos.length, 1);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const slots = calculateSlotTiming(videoCount, totalDurationFrames, 15, trailingForExit(exitStyle, 45));
  // 首段视频提前到片段开头入场：画框点亮的同时内容亮起，避免开场 0.5s 空框
  const slotStarts = slots.map((s, i) => (i === 0 ? Math.min(s.startFrame, 8) : s.startFrame));

  // 个性化参数（故事板「参数」页滑块；未调整走 NEON_TECH_PARAMS 默认值）
  const p = makeParamReader(NEON_TECH_PARAMS, params);
  const tempo = Math.max(0.25, p('tempo')); // 节奏倍率（D3：点火闪烁/扫描光带提频；呼吸不动作驻留质感）
  const entry = entryEase(p('motionEase')); // 画框入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const frameSizeRatio = p('frameScale'); // 画框尺寸倍率
  const glowRatio = p('glow');            // 辉光强度倍率（0 = 无辉光）
  const gridOpacity = p('gridOpacity');   // 网格/扫描线透明度倍率（0 = 隐藏）

  // ====== 画框几何 ======
  const frameW = canvasW * (layout?.videoWidthRatio ?? 0.6) * frameSizeRatio;
  const frameH = canvasH * (layout?.videoHeightRatio ?? 0.5) * frameSizeRatio;
  const frameX = (canvasW - frameW) / 2 + canvasW * (layout?.videoOffsetX ?? 0);
  const baseFrameY = canvasH * 0.26 + canvasH * (layout?.videoOffsetY ?? 0);
  const perspective = layout?.perspective ?? VIDEO_DESIGN.perspective;
  const rotateX = layout?.rotateX ?? 5;
  const baseRotateY = layout?.rotateY ?? 0;
  const rotateZ = layout?.rotateZ ?? 0;
  const userScale = layout?.scale ?? 1;
  const radius = layout?.borderRadius ?? 12;

  // ====== 当前活跃槽位（驱动画框入场/脉搏） ======
  let activeIdx = 0;
  slotStarts.forEach((start, i) => {
    if (frame >= start) activeIdx = i;
  });
  const activeLocal = Math.max(0, frame - slotStarts[activeIdx]);

  // 入场：轻微上浮 + 缩放回正（画框与视频共用同一组值，保持贴合）
  const entrance = interpolate(activeLocal, [0, 18], [0, 1], {
    easing: entry,
    extrapolateRight: 'clamp',
  });
  const entranceY = (1 - entrance) * 36;
  const entranceScale = 0.965 + entrance * 0.035;
  // 常驻微运动：缓慢漂浮 + 极轻摆动（克制）
  const floatY = Math.sin(frame * 0.03) * 4;
  const idleRotY = Math.sin(frame * 0.02) * 1.2;
  const frameY = baseFrameY + entranceY + floatY;
  const rotateY = baseRotateY + idleRotY;
  const frameScale = userScale * entranceScale;
  const frameTransform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${frameScale})`;

  // ====== 霓虹点亮（点火闪烁 → 呼吸 → 每次切换视频时轻脉冲）；tempo 倍缩点火/扫描节奏 ======
  const ignite = interpolate(
    frame,
    [2, 6, 9, 14, 18, 24].map((f) => Math.round(f / tempo)),
    [0, 0.85, 0.35, 1, 0.65, 1],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  const breathe = 0.9 + Math.sin(frame * 0.05) * 0.1;
  const slotPulse = Math.max(0, 1 - activeLocal / 14) * 0.3;
  const glow = Math.min(1, ignite * breathe + slotPulse) * glowRatio;

  // ====== 文字节奏 ======
  const features = text.features ?? [];
  const featureBase = slotStarts[0] + 20;
  const brandStart = totalDurationFrames - 45;
  const featuresVisibility = text.brandName ? 1 - fadeIn(frame, brandStart - 8, 14) : 1;
  const titleLineProg = interpolate(frame, [14, 30], [0, 1], {
    easing: EASINGS.standard,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ====== 背景扫描光带（每片段缓慢下扫一次，两端都在画外，循环无跳变；tempo 提频） ======
  const bandH = canvasH * 0.4;
  const sweepPeriod = Math.max(totalDurationFrames / tempo, 2);
  const sweepProg = (frame % sweepPeriod) / sweepPeriod;
  const sweepY = -bandH + sweepProg * (canvasH + bandH);

  // ====== 四角括号 ======
  const bracketLen = Math.round(Math.max(18, canvasW * 0.016));
  const bracketThick = Math.max(2, Math.round(canvasW / 960));
  const bracketGap = 10 + (1 - ignite) * 22;
  const bracketBorder = `${bracketThick}px solid rgba(${CYAN}, 0.95)`;
  const corners: Array<{key: string; style: React.CSSProperties}> = [
    {key: 'tl', style: {left: -bracketGap, top: -bracketGap, borderLeft: bracketBorder, borderTop: bracketBorder, borderTopLeftRadius: 6}},
    {key: 'tr', style: {right: -bracketGap, top: -bracketGap, borderRight: bracketBorder, borderTop: bracketBorder, borderTopRightRadius: 6}},
    {key: 'bl', style: {left: -bracketGap, bottom: -bracketGap, borderLeft: bracketBorder, borderBottom: bracketBorder, borderBottomLeftRadius: 6}},
    {key: 'br', style: {right: -bracketGap, bottom: -bracketGap, borderRight: bracketBorder, borderBottom: bracketBorder, borderBottomRightRadius: 6}},
  ];

  const markerSize = Math.max(8, Math.round(canvasW * 0.006));
  const brandLineW = Math.round(canvasW * 0.035);

  return (
    <AbsoluteFill>
      {/* 基础背景：近黑蓝渐变（可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill
          style={{background: 'linear-gradient(160deg, #0a0e1a 0%, #0d1526 55%, #070c16 100%)'}}
        />
      )}
      {/* 细网格（边缘径向渐隐，避免满屏线框感） */}
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(148, 163, 184, 0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.055) 1px, transparent 1px)',
          backgroundSize: '96px 96px',
          opacity: gridOpacity,
          WebkitMaskImage: 'radial-gradient(ellipse 75% 65% at 50% 45%, black 30%, transparent 78%)',
          maskImage: 'radial-gradient(ellipse 75% 65% at 50% 45%, black 30%, transparent 78%)',
        }}
      />
      {/* CRT 扫描线（极淡） */}
      <AbsoluteFill
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.018) 0px, rgba(255, 255, 255, 0.018) 1px, transparent 1px, transparent 5px)',
          opacity: gridOpacity,
        }}
      />
      {/* 顶部青色 / 底部蓝色环境辉光 */}
      <AbsoluteFill
        style={{background: `radial-gradient(ellipse 70% 45% at 50% 0%, rgba(${CYAN}, ${0.07 * glowRatio}), transparent 70%)`}}
      />
      <AbsoluteFill
        style={{background: `radial-gradient(ellipse 60% 40% at 50% 105%, rgba(${BLUE}, ${0.08 * glowRatio}), transparent 70%)`}}
      />
      {/* 缓慢下扫的扫描光带 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: sweepY,
          height: bandH,
          background: `linear-gradient(180deg, transparent, rgba(${CYAN}, 0.045) 50%, transparent)`,
          opacity: gridOpacity,
          pointerEvents: 'none',
        }}
      />
      <BackgroundEffectLayer />

      {/* 无素材占位：暗色面板 + 呼吸光环，保证空数组也能完整渲染 */}
      {videos.length === 0 && (
        <div
          style={{
            position: 'absolute',
            left: frameX,
            top: frameY,
            width: frameW,
            height: frameH,
            perspective: `${perspective}px`,
            transformStyle: 'preserve-3d',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              transform: frameTransform,
              borderRadius: radius,
              overflow: 'hidden',
              background: 'linear-gradient(135deg, #0d1526 0%, #101d38 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: Math.round(frameH * 0.16),
                height: Math.round(frameH * 0.16),
                borderRadius: '50%',
                border: `2px solid rgba(${CYAN}, 0.5)`,
                boxShadow: `0 0 18px rgba(${CYAN}, ${0.35 * glowRatio}), inset 0 0 18px rgba(${CYAN}, ${0.2 * glowRatio})`,
                opacity: 0.5 + Math.sin(frame * 0.08) * 0.3,
              }}
            />
          </div>
        </div>
      )}

      {/* 视频序列：同一画框位置依次交叉淡化，画框始终有内容 */}
      {videos.map((video, i) => {
        const startAbs = slotStarts[i];
        const isLast = i === videos.length - 1;
        // 非末段：在下一段入场起点开始 12 帧交叉淡出；末段一直演到片段结束（收尾交给上层转场/淡黑）
        const exitAbs = isLast ? null : slotStarts[i + 1];
        const rawSeqDuration =
          exitAbs !== null ? exitAbs - startAbs + 12 : totalDurationFrames - startAbs + 30;
        // 槽位溢出（段过短/素材过多）时直接跳过，避免 Sequence 拿到 ≤0 时长直接 throw 导致整段渲染崩溃
        if (frame < startAbs || rawSeqDuration <= 0) return null;
        const seqDuration = Math.max(1, rawSeqDuration);

        const localAbs = Math.max(0, frame - startAbs);
        const ent = interpolate(localAbs, [0, 18], [0, 1], {
          easing: EASINGS.standard,
          extrapolateRight: 'clamp',
        });

        return (
          <Sequence key={video.id} from={startAbs} durationInFrames={seqDuration}>
            <Video3D
              src={video.src}
              mediaType={video.type}
              muted={video.muted}
              volume={video.volume}
              w={frameW}
              h={frameH}
              vw={video.width}
              vh={video.height}
              perspective={perspective}
              rotateX={rotateX}
              rotateY={rotateY}
              rotateZ={rotateZ}
              x={frameX}
              y={baseFrameY + (1 - ent) * 36 + floatY}
              scale={userScale * (0.965 + ent * 0.035)}
              borderRadius={radius}
              shadow={false}
              fit={video.fit}
              viewport={video.viewport}
              clicks={video.cursorClicks}

              cursorPoints={video.cursorPoints}
              fadeInFrame={0}
              fadeOutFrame={exitAbs !== null ? exitAbs - startAbs : undefined}
              fadeDuration={12}
              startFrom={Math.round((video.trimStart || 0) * FPS)}
              endSec={clipEndSec(video)}
              cutsSec={video.cuts}
            />
          </Sequence>
        );
      })}

      {/* 霓虹画框：描边辉光 + 四角括号（复制 Video3D 的 3D 变换，与画面严格贴合） */}
      <div
        style={{
          position: 'absolute',
          left: frameX,
          top: frameY,
          width: frameW,
          height: frameH,
          perspective: `${perspective}px`,
          transformStyle: 'preserve-3d',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            transform: frameTransform,
            borderRadius: radius + 2,
            boxShadow: `inset 0 0 0 1px rgba(${CYAN}, ${0.5 * glow}), 0 0 26px rgba(${CYAN}, ${0.28 * glow}), 0 0 90px rgba(${BLUE}, ${0.16 * glow})`,
          }}
        >
          {corners.map((c) => (
            <div
              key={c.key}
              style={{
                position: 'absolute',
                width: bracketLen,
                height: bracketLen,
                opacity: glow,
                filter: `drop-shadow(0 0 5px rgba(${CYAN}, ${0.55 * glowRatio}))`,
                ...c.style,
              }}
            />
          ))}
        </div>
      </div>

      {/* 标题区：标题 + 霓虹分割线 + 副标题 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            top: canvasH * 0.07,
            left: 0,
            right: 0,
            textAlign: 'center',
          }}
        >
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={6}
            duration={18}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? '#F1F5F9',
              letterSpacing: '0.04em',
              textShadow: `0 0 18px rgba(${CYAN}, ${0.4 * glowRatio}), 0 0 52px rgba(${CYAN}, ${0.16 * glowRatio})`,
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          <div
            style={{
              margin: `${tokens.spacing.element}px auto 0`,
              width: tokens.fontSize.title * 2.2,
              height: 2,
              transform: `scaleX(${titleLineProg})`,
              transformOrigin: 'center',
              background: `linear-gradient(90deg, transparent, rgba(${CYAN}, 0.9), transparent)`,
              boxShadow: `0 0 10px rgba(${CYAN}, ${0.6 * glowRatio})`,
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: tokens.spacing.element}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={20}
                duration={16}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: style?.subtitle?.color ?? `rgba(125, 211, 252, 0.9)`,
                  letterSpacing: '0.06em',
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  textShadow: `0 0 12px rgba(${CYAN}, ${0.3 * glowRatio})`,
                  ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                  ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 功能要点：底部横向排列，逐条入场（片尾为品牌名让位） */}
      {features.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: canvasH * 0.085,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: tokens.spacing.paragraph * 1.5,
            flexWrap: 'wrap',
            padding: `0 ${canvasW * 0.05}px`,
            opacity: featuresVisibility,
          }}
        >
          {features.map((feature, i) => {
            const start = featureBase + i * 14;
            return (
              <div key={i} style={{display: 'flex', alignItems: 'center', gap: tokens.spacing.element * 0.75}}>
                <div
                  style={{
                    width: markerSize,
                    height: markerSize,
                    transform: 'rotate(45deg)',
                    border: `1.5px solid rgba(${CYAN}, 0.9)`,
                    boxShadow: `0 0 6px rgba(${CYAN}, ${0.55 * glowRatio})`,
                    opacity: fadeIn(frame, start, 12),
                  }}
                />
                <AnimatedText
                  text={feature}
                  preset={textAnim ?? 'charPop'}
                  startFrame={start}
                  duration={14}
                  style={{
                    fontSize: style?.feature?.fontSize ?? tokens.fontSize.body,
                    fontWeight: style?.feature?.fontWeight ?? 400,
                    color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                    fontFamily: VIDEO_DESIGN.bodyFont,
                    letterSpacing: '0.04em',
                    textShadow: `0 0 10px rgba(${CYAN}, ${0.25 * glowRatio})`,
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

      {/* 片尾品牌名：两侧霓虹短线夹衬，辉光渐入 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: canvasH * 0.085,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: tokens.spacing.paragraph,
          }}
        >
          <div
            style={{
              width: brandLineW,
              height: 1,
              background: `linear-gradient(90deg, transparent, rgba(${CYAN}, 0.7))`,
              opacity: fadeIn(frame, brandStart + 6, 14),
            }}
          />
          <AnimatedText
            text={text.brandName}
            preset={textAnim ?? 'fadeIn'}
            startFrame={brandStart}
            duration={18}
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.brand,
              fontWeight: style?.brand?.fontWeight ?? 600,
              color: style?.brand?.color ?? '#E0F2FE',
              letterSpacing: '0.3em',
              textShadow: `0 0 14px rgba(${CYAN}, ${0.5 * glowRatio}), 0 0 44px rgba(${CYAN}, ${0.2 * glowRatio})`,
              ...(style?.brand?.textDecoration ? {textDecoration: style.brand.textDecoration} : {}),
              ...(style?.brand?.fontStyle ? {fontStyle: style.brand.fontStyle} : {}),
              ...textStrokeCss(style?.brand),
            }}
          />
          <div
            style={{
              width: brandLineW,
              height: 1,
              background: `linear-gradient(90deg, rgba(${CYAN}, 0.7), transparent)`,
              opacity: fadeIn(frame, brandStart + 6, 14),
            }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};

export default NeonTech;
