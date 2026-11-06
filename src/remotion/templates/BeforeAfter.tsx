/**
 * 模板: BeforeAfter - 前后对比（进阶装置）
 *
 * 效果: 时间维度的 A/B 对比（SplitCompare 是空间并排，本模板是先后揭示）：
 * 前半段播「旧状态」素材（灰暗滤镜 + 「之前」角标），中点横向擦除揭示
 * 「新状态」素材（正常亮度 + 「之后」角标）；底部指标行「16小时 → 5分钟」
 * 在揭示瞬间翻牌（旧值划掉、新值滑入）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - videos[0] = 旧状态素材，videos[1] = 新状态素材（cover 全屏，各播半段）
 * - title: 对比结论（如「周报耗时对比」，中点后浮现）
 * - features: 指标行「旧值 → 新值」（→ / -> 均可；≤3 条，无箭头的行按原文展示）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: BEFORE_AFTER_PARAMS）：splitAt 揭示点(0.3-0.7) /
 * grayAmount 旧状态灰度(0-1) / metricScale 指标字号 / wipeSec 擦除时长（翻牌节奏随比例联动）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {EASINGS, entryEase} from '../animations/motion';
import {fitVideo} from '../utils/fitVideo';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {safeBottom} from '../utils/safeArea';
import {parseBeforeAfterMetric} from '../../shared/promo-text-parse';
import {BEFORE_AFTER_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const BeforeAfter: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);

  const p = makeParamReader(BEFORE_AFTER_PARAMS, params);
  const entry = entryEase(p('motionEase'), EASINGS.inOut); // 擦除缓动档位：0=模板原对称曲线（C 批统一时间语言）
  const splitAt = p('splitAt');       // 揭示点（片段时长比例）
  const grayAmount = p('grayAmount'); // 旧状态灰度强度（0 = 原样）
  const metricScale = p('metricScale');
  const wipeSec = p('wipeSec');       // 擦除时长（翻牌节奏随比例联动）

  const before = videos[0];
  const after = videos[1];
  const metrics = (text.features ?? []).slice(0, 3);

  // ====== 擦除时间线：splitAt 处横向擦除（新态从左盖过旧态），时长 wipeSec 可调 ======
  const wipeStart = Math.round(totalDurationFrames * splitAt);
  const wipeDur = Math.max(6, Math.round(wipeSec * FPS)); // 默认 0.5s → 15 帧
  const wipe = interpolate(frame, [wipeStart, wipeStart + wipeDur], [0, 100], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fitBefore = before ? fitVideo(canvasW, canvasH, before.width, before.height, 'cover') : null;
  const fitAfter = after ? fitVideo(canvasW, canvasH, after.width, after.height, 'cover') : null;

  // 驻留微运动：入场完成后两层素材保持缓慢呼吸、指标药丸轻微漂移（P2 质感）。
  // 全屏 cover 用「单向放大」式呼吸（scale ∈ [1, 1.012]）：收缩半周会露出画布底色
  const breatheBefore = dwellBreathe(frame, FPS, 0.006, 4.5, 0) + 0.006;
  const breatheAfter = dwellBreathe(frame, FPS, 0.006, 4.5, 1.37) + 0.006;

  const renderMedia = (video: NonNullable<typeof before>, fit: NonNullable<typeof fitBefore>) => (
    <div style={{position: 'absolute', left: -fit.offsetX, top: -fit.offsetY, width: fit.width, height: fit.height}}>
      <ClipMedia
        src={video.src}
        mediaType={video.type}
        muted={video.muted}
        volume={video.volume}
        startFrom={Math.round((video.trimStart || 0) * FPS)}
        endSec={clipEndSec(video)}
        cutsSec={video.cuts}
        style={{width: '100%', height: '100%', objectFit: 'fill'}}
      />
    </div>
  );

  const tagFs = tokens.fontSize.body * 0.95;
  const tagStyle = (): React.CSSProperties => ({
    position: 'absolute',
    top: canvasH * 0.07,
    background: 'rgba(17, 24, 39, 0.72)',
    color: '#FFFFFF',
    fontSize: tagFs,
    fontWeight: 600,
    fontFamily: VIDEO_DESIGN.bodyFont,
    borderRadius: tagFs * 0.42,
    padding: `${tagFs * 0.18}px ${tagFs * 0.55}px`,
    lineHeight: 1.3,
    letterSpacing: '0.06em',
  });

  return (
    <AbsoluteFill style={{background: '#0F172A'}}>
      {/* 旧状态层（全程在底）：灰暗滤镜表达「之前」 */}
      {before && fitBefore && (
        <AbsoluteFill
          style={{
            filter: `grayscale(${grayAmount}) brightness(${1 - grayAmount * 0.25})`,
            transform: `scale(${breatheBefore})`,
          }}
        >
          {renderMedia(before, fitBefore)}
        </AbsoluteFill>
      )}

      {/* 新状态层：横向擦除从左揭示（clipPath inset 右侧收拢） */}
      {after && fitAfter && (
        <AbsoluteFill style={{clipPath: `inset(0 ${100 - wipe}% 0 0)`, transform: `scale(${breatheAfter})`}}>
          {renderMedia(after, fitAfter)}
        </AbsoluteFill>
      )}
      <BackgroundEffectLayer />

      {/* 角标：之前（擦除时淡出） / 之后（随擦除淡入） */}
      <div style={{...tagStyle(), left: canvasW * 0.05, opacity: 1 - Math.max(0, wipe - 40) / 60}}>
        之前
      </div>
      <div style={{...tagStyle(), left: canvasW * 0.05, opacity: Math.min(1, Math.max(0, wipe - 40) / 60)}}>
        之后
      </div>

      {/* 对比结论：中点后浮现居中顶部 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.1,
            right: canvasW * 0.1,
            top: canvasH * 0.16,
            display: 'flex',
            justifyContent: 'center',
            opacity: fadeIn(frame, wipeStart + 6, 12),
          }}
        >
          <span
            style={{
              fontSize: tokens.fontSize.title * 0.6,
              fontWeight: 700,
              color: style?.title?.color ?? '#FFFFFF',
              fontFamily: VIDEO_DESIGN.titleFont,
              lineHeight: 1.25,
              textShadow: '0 2px 12px rgba(0,0,0,0.55)',
              textAlign: 'center',
              ...textStrokeCss(style?.title),
            }}
          >
            {text.title}
          </span>
        </div>
      )}

      {/* 指标行：揭示瞬间翻牌（旧值划掉 → 新值滑入） */}
      {metrics.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.08,
            right: canvasW * 0.08,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.09),
            display: 'flex',
            justifyContent: 'center',
            gap: canvasW * 0.03,
            flexWrap: 'wrap',
          }}
        >
          {metrics.map((line, i) => {
            const m = parseBeforeAfterMetric(line);
            const mFs = tokens.fontSize.body * metricScale;
            // 翻牌节奏随擦除时长等比缩放（默认 wipeDur=15 时与原 4+i*3 / 8 帧一致）
            const flipPace = wipeDur / 15;
            const flipDelay = Math.round((4 + i * 3) * flipPace);
            const flipDur = Math.max(2, Math.round(8 * flipPace));
            const flip = Math.min(1, Math.max(0, (frame - wipeStart - flipDelay) / flipDur));
            // 指标药丸为文字/数据类：只加 drift（不 breathe，防文字缩放显糊）
            const mDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, i * 1.37);
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: mFs * 0.4,
                  background: 'rgba(10, 15, 30, 0.72)',
                  borderRadius: mFs * 0.5,
                  padding: `${mFs * 0.2}px ${mFs * 0.55}px`,
                  opacity: fadeIn(frame, 10 + i * 4, 8),
                  transform: `translate(${mDrift.x}px, ${mDrift.y}px)`,
                }}
              >
                {m ? (
                  <>
                    <span
                      style={{
                        fontSize: mFs,
                        fontWeight: 500,
                        color: 'rgba(255,255,255,0.55)',
                        fontFamily: VIDEO_DESIGN.bodyFont,
                        textDecoration: flip > 0.5 ? 'line-through' : 'none',
                        lineHeight: 1.3,
                      }}
                    >
                      {m.before}
                    </span>
                    <span style={{fontSize: mFs * 0.8, color: 'rgba(255,255,255,0.4)', lineHeight: 1}}>→</span>
                    <span
                      style={{
                        fontSize: mFs * 1.08,
                        fontWeight: 800,
                        color: ACCENT(),
                        fontFamily: VIDEO_DESIGN.titleFont,
                        lineHeight: 1.3,
                        opacity: flip,
                        transform: `translateX(${(1 - flip) * mFs * 0.5}px)`,
                        display: 'inline-block',
                      }}
                    >
                      {m.after}
                    </span>
                  </>
                ) : (
                  <span
                    style={{
                      fontSize: mFs,
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.85)',
                      fontFamily: VIDEO_DESIGN.bodyFont,
                      lineHeight: 1.3,
                    }}
                  >
                    {line}
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
            right: canvasW * 0.04,
            top: canvasH * 0.075,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: fadeIn(frame, 8, 12),
          }}
        >
          <span
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
              fontWeight: style?.brand?.fontWeight ?? 500,
              color: 'rgba(255,255,255,0.8)',
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.14em',
              textShadow: '0 1px 4px rgba(0,0,0,0.5)',
            }}
          >
            {text.brandName}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default BeforeAfter;
