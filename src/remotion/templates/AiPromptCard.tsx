/**
 * 模板: AiPromptCard - AI 提示卡（1.7 钩子族）
 *
 * 「输入一句话 → 回车 → AI 结果浮出」的开场钩子（NOTES-ROUND3：framer「一句话输入」/
 * descript/Tella Desk 提示卡+建议 chips 三例确认的行业手法，与片语「AI 代做」价值同构）：
 * 中央提示输入框逐字打出标题文案（打字机 + 闪烁光标），回车瞬间输入框脉冲辉光、
 * 建议 chips（要点行）逐个弹出、可选素材结果卡从框下生长而出。
 * 全部动画帧驱动（interpolate/spring），无 Clock，逐帧渲染可复现；图标为内联 SVG（不依赖字体字形）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {AI_PROMPT_CARD_PARAMS} from '../../shared/template-registry';
import {SPRINGS} from '../animations/motion';
import {clipEndSec} from '../../shared/clipCuts';
import {DRAG_START_FRAME, dragInFlyQ, dragInChipPop, dragInTypingStartFrame, quadBezier} from '../../shared/prompt-drag';

/** 四角星火花（AI 符号，内联 SVG 不依赖字体） */
const SparkIcon: React.FC<{size: number; color: string}> = ({size, color}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M12 2 C13 8 16 11 22 12 C16 13 13 16 12 22 C11 16 8 13 2 12 C8 11 11 8 12 2 Z" fill={color} />
  </svg>
);

/** 上箭头（回车/发送，内联 SVG） */
const ArrowUpIcon: React.FC<{size: number; color: string}> = ({size, color}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path d="M12 4 L19 12 L14.5 12 L14.5 20 L9.5 20 L9.5 12 L5 12 Z" fill={color} />
  </svg>
);

export const AiPromptCard: React.FC<TemplateProps> = ({
  videos,
  text,
  brandColor,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 6) * FPS));

  const p = makeParamReader(AI_PROMPT_CARD_PARAMS, params);
  const enterAt = p('enterAt');
  const typeSpeed = p('typeSpeed');
  const glow = p('glow');
  const caretOn = p('caret') >= 0.5;
  const resultCardOn = p('resultCard') >= 0.5;
  const dragInOn = p('dragIn') >= 0.5; // 素材拖入（B2）：占用素材槽做 ghost 飞入，结果卡让位
  const thinkingOn = p('thinking') >= 0.5; // 输入前思考三点（P7）：框内三点呼吸 0.7s 再开始打字
  const bgStyle = Math.round(p('bgStyle'));

  const accent = brandColor ?? '#6D8CFF';
  const portrait = canvasH > canvasW;

  // 底色：深紫夜 / 品牌渐变 / 纯黑 / 浅奶油（P3 浅色主题族）
  const onLight = bgStyle === 3;
  const bg =
    bgStyle === 0
      ? 'radial-gradient(130% 110% at 50% 18%, #1B1140 0%, #120B2A 52%, #0A0718 100%)'
      : bgStyle === 1
        ? `linear-gradient(140deg, ${accent}2E 0%, #0E0A22 46%, #0A0718 100%)`
        : onLight
          ? 'linear-gradient(165deg, #FDFBF2 0%, #F8F0CE 55%, #F1E2A0 100%)'
          : '#050507';
  // 墨水色面板（浅底=深玻璃+深字；深底=白玻璃+白字，历史行为）
  const ink = onLight
    ? {title: '#17181C', body: '#3D4351', faint: 'rgba(23,24,28,0.55)', panel: 'rgba(23,24,28,0.05)', panelBorder: 'rgba(23,24,28,0.16)', ghost: 'rgba(255,255,255,0.55)'}
    : {title: VIDEO_DESIGN.colors.textTitleDark, body: VIDEO_DESIGN.colors.textBodyDark, faint: 'rgba(255,255,255,0.55)', panel: 'rgba(255,255,255,0.07)', panelBorder: 'rgba(255,255,255,0.16)', ghost: 'rgba(255,255,255,0.08)'};

  // ---- 时间线（帧驱动）----
  const barIn = interpolate(frame, [0, 10], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const enterFrame = Math.max(24, Math.round(totalFrames * enterAt));
  const prompt = text.title ?? '';
  // 拖入时间线（B2）：ghost 飞行/落定/接近高亮；打字顺延到落定之后（关时=原 8 帧）
  const flyQ = dragInOn ? dragInFlyQ(frame, FPS) : 0;
  const attachPop = dragInOn ? dragInChipPop(frame, FPS) : 0;
  const approachQ = dragInOn ? Math.min(1, Math.max(0, (flyQ - 0.7) / 0.3)) : 0;
  const typeStart = dragInTypingStartFrame(FPS, dragInOn);
  const THINKING_FRAMES = Math.round(0.7 * FPS);
  const thinkingNow = thinkingOn && frame >= 10 && frame < typeStart + THINKING_FRAMES;
  const effTypeStart = typeStart + (thinkingOn ? THINKING_FRAMES : 0);
  const typedCount = Math.max(0, Math.min(prompt.length, Math.floor(((frame - effTypeStart) / FPS) * typeSpeed)));
  const typed = prompt.slice(0, typedCount);
  const typing = frame < enterFrame;
  const caretVisible = caretOn && typing && typedCount < prompt.length && frame % Math.round(FPS * 0.8) < Math.round(FPS * 0.44);

  // 回车脉冲：辉光圈扩散 + 框体轻缩放
  const pulseT = frame - enterFrame;
  const barScale = pulseT >= 0 ? 1 + interpolate(pulseT, [0, 5, 14], [0, 0.035, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 1;
  const ringGrow = pulseT >= 0 ? interpolate(pulseT, [0, 22], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : 0;

  // 建议 chips（要点行，最多 3）：回车后逐个弹出（spring 过冲）
  const chips = (text.features ?? []).slice(0, 3);
  const chipPop = (i: number): number =>
    spring({frame: frame - (enterFrame + 8 - i * 7), fps: FPS, config: SPRINGS.chipPop, durationInFrames: 22});

  // 结果卡：回车后从框下生长（dragIn 开时素材槽被 ghost 占用，结果卡让位）
  const video = videos[0];
  const cardT = pulseT >= 4 ? spring({frame: pulseT - 4, fps: FPS, config: SPRINGS.resultGrow, durationInFrames: 26}) : 0;
  const showCard = resultCardOn && !!video && !dragInOn;

  // 呼吸辉光（背景氛围，sin 慢呼吸）
  const breath = 0.5 + 0.5 * Math.sin((frame / FPS) * Math.PI * 2 / 4.2);

  // 字号：长句自动降档，保证单行装得下
  const promptSize = prompt.length > 22 ? tokens.fontSize.body * 1.02 : prompt.length > 13 ? tokens.fontSize.body * 1.3 : tokens.fontSize.body * 1.6;
  const barW = portrait ? canvasW * 0.86 : canvasW * 0.62;
  const barH = promptSize * 2.5;
  const barY = showCard ? canvasH * (portrait ? 0.2 : 0.24) : canvasH * (portrait ? 0.4 : 0.4);

  return (
    <AbsoluteFill style={{background: style?.background ?? bg}}>
      {/* 呼吸辉光 + 回车扩散圈 */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(58% 42% at 50% ${((barY + barH / 2) / canvasH) * 100}%, ${accent}${glow > 1 ? '3D' : '26'} 0%, transparent 72%)`,
          opacity: 0.55 + 0.45 * breath * glow,
        }}
      />
      {pulseT >= 0 && glow > 0 && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(50% 36% at 50% ${((barY + barH / 2) / canvasH) * 100}%, ${accent}42 0%, transparent 70%)`,
            opacity: (1 - ringGrow) * glow,
            transform: `scale(${1 + ringGrow * 0.5})`,
          }}
        />
      )}

      {/* 提示输入框 */}
      <div
        style={{
          position: 'absolute',
          left: canvasW / 2 - (barW * barScale) / 2,
          top: barY + (barH * (1 - barScale)) / 2,
          width: barW * barScale,
          height: barH * barScale,
          opacity: barIn,
          display: 'flex',
          alignItems: 'center',
          gap: promptSize * 0.55,
          padding: `0 ${promptSize * 0.85}`,
          borderRadius: barH / 2,
          background: ink.panel,
          border: `1.5px solid ${accent}${approachQ > 0.4 ? 'E6' : typing ? '73' : 'B3'}`,
          boxShadow: typing
            ? `0 0 ${28 * glow}px ${accent}${onLight ? '3D' : '2E'}, inset 0 0 18px ${onLight ? 'rgba(23,24,28,0.04)' : 'rgba(255,255,255,0.04)'}`
            : approachQ > 0
              ? `0 0 ${(36 + 44 * approachQ) * glow}px ${accent}${approachQ > 0.4 ? '8C' : '4D'}, 0 12px 44px rgba(0,0,0,0.45)`
              : `0 0 ${52 * glow}px ${accent}59, 0 12px 44px rgba(0,0,0,0.45)`,
          fontFamily: VIDEO_DESIGN.bodyFont,
        }}
      >
        <SparkIcon size={promptSize * 1.15} color={accent} />
        <div style={{flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden'}}>
          {thinkingNow && (
            <span style={{display: 'inline-flex', alignItems: 'center', gap: promptSize * 0.24}}>
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  style={{
                    width: promptSize * 0.2,
                    height: promptSize * 0.2,
                    borderRadius: '50%',
                    background: accent,
                    opacity: 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(frame * 0.5 - d * 1.1)),
                  }}
                />
              ))}
            </span>
          )}
          {!thinkingNow && (
          <span
            style={{
              fontSize: promptSize,
              fontWeight: 600,
              color: ink.title,
              whiteSpace: 'nowrap',
              letterSpacing: '0.01em',
              textShadow: '0 2px 12px rgba(0,0,0,0.5)',
            }}
          >
            {typed}
          </span>
          )}
          {caretVisible && (
            <span
              style={{
                display: 'inline-block',
                width: promptSize * 0.09,
                height: promptSize * 1.15,
                marginLeft: promptSize * 0.14,
                borderRadius: 2,
                background: accent,
              }}
            />
          )}
        </div>
        {/* 回车键 */}
        <div
          style={{
            width: barH * 0.62,
            height: barH * 0.62,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: typing ? 'rgba(255,255,255,0.08)' : accent,
            boxShadow: typing ? 'none' : `0 0 ${26 * glow}px ${accent}8C`,
            flexShrink: 0,
          }}
        >
          <ArrowUpIcon size={barH * 0.3} color={typing ? 'rgba(255,255,255,0.45)' : '#FFFFFF'} />
        </div>
      </div>

      {/* 素材拖入（B2）：ghost 卡沿贝塞尔飞向输入框右端（接近段框体高亮），落点缩进为
          附件 chip + 扩散波环，打字在落定后开始——「拖素材进对话」的具象钩子 */}
      {dragInOn && (() => {
        const chipH = barH * 0.62;
        const chipW = Math.min(canvasW * 0.2, chipH * 3.6);
        const rightInset = promptSize * 0.85 + barH * 0.62 + promptSize * 0.55;
        const dropCx = canvasW / 2 - barW / 2 + barW - rightInset - chipW / 2;
        const dropCy = barY + barH / 2;
        const gw = canvasW * 0.17;
        const gh = video ? Math.min(gw * ((video.height || 9) / (video.width || 16)), canvasH * 0.24) : gw * 0.6;
        const label = text.subtitle || '素材卡';
        const ghostVisible = flyQ > 0.001 && flyQ < 0.999;
        const ghostPos = quadBezier(
          {x: canvasW * 0.88, y: canvasH * 0.84},
          {x: canvasW * 0.80, y: canvasH * 0.40},
          {x: dropCx, y: dropCy},
          flyQ,
        );
        const ghostScale = 1 - (1 - chipW / gw) * flyQ;
        return (
          <>
            {/* 落定波环（chip 弹窗前半程） */}
            {attachPop > 0.001 && attachPop < 0.9 && (
              <div
                style={{
                  position: 'absolute',
                  left: dropCx - chipH,
                  top: dropCy - chipH,
                  width: chipH * 2,
                  height: chipH * 2,
                  borderRadius: '50%',
                  border: `2px solid ${accent}`,
                  opacity: Math.max(0, 0.7 * (1 - attachPop)),
                  transform: `scale(${(0.5 + 0.9 * attachPop).toFixed(3)})`,
                  pointerEvents: 'none',
                }}
              />
            )}
            {/* 附件 chip（落定后常驻，弹簧入场） */}
            {attachPop > 0.001 && (
              <div
                style={{
                  position: 'absolute',
                  left: dropCx - chipW / 2,
                  top: dropCy - chipH / 2,
                  width: chipW,
                  height: chipH,
                  borderRadius: 999,
                  background: onLight ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.10)',
                  border: `1px solid ${accent}66`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: chipH * 0.2,
                  padding: `0 ${chipH * 0.32}`,
                  opacity: Math.min(1, attachPop * 1.3),
                  transform: `scale(${(0.55 + 0.45 * attachPop).toFixed(3)})`,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  pointerEvents: 'none',
                }}
              >
                {video ? (
                  <div style={{width: chipH * 0.6, height: chipH * 0.6, borderRadius: chipH * 0.14, overflow: 'hidden', flexShrink: 0}}>
                    <ClipMedia
                      src={video.src}
                      mediaType={video.type}
                      muted
                      startFrom={Math.round((video.trimStart || 0) * FPS)}
                      endSec={clipEndSec(video)}
                      cutsSec={video.cuts}
                      style={{width: '100%', height: '100%', objectFit: 'cover'}}
                    />
                  </div>
                ) : (
                  <SparkIcon size={chipH * 0.52} color={accent} />
                )}
                <span
                  style={{
                    fontSize: tokens.fontSize.body * 0.8,
                    fontWeight: 500,
                    color: ink.title,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {label}
                </span>
              </div>
            )}
            {/* 飞行 ghost（落下即消失，chip 接棒） */}
            {ghostVisible && (
              <div
                style={{
                  position: 'absolute',
                  left: ghostPos.x - gw / 2,
                  top: ghostPos.y - gh / 2,
                  width: gw,
                  height: gh,
                  borderRadius: 14,
                  overflow: 'hidden',
                  border: `1px solid ${onLight ? 'rgba(23,24,28,0.22)' : 'rgba(255,255,255,0.22)'}`,
                  boxShadow: '0 18px 44px -10px rgba(0,0,0,0.6)',
                  transform: `rotate(${(-9 * (1 - flyQ)).toFixed(2)}deg) scale(${ghostScale.toFixed(3)})`,
                  opacity: Math.min(1, (frame - DRAG_START_FRAME) / 4),
                  zIndex: 3,
                  pointerEvents: 'none',
                }}
              >
                {video ? (
                  <ClipMedia
                    src={video.src}
                    mediaType={video.type}
                    muted
                    startFrom={Math.round((video.trimStart || 0) * FPS)}
                    endSec={clipEndSec(video)}
                    cutsSec={video.cuts}
                    style={{width: '100%', height: '100%', objectFit: 'cover'}}
                  />
                ) : (
                  <div style={{width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: promptSize * 0.3, background: ink.ghost}}>
                    <SparkIcon size={promptSize} color={accent} />
                    <span style={{fontSize: tokens.fontSize.body * 0.85, fontWeight: 500, color: ink.title, fontFamily: VIDEO_DESIGN.bodyFont}}>{label}</span>
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}

      {/* 建议 chips：回车后逐个弹出 */}
      {chips.map((c, i) => {
        const pop = chipPop(i);
        if (pop <= 0.001) return null;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: barY + barH + canvasH * 0.035 + (i % 2) * canvasH * 0.008,
              left: canvasW / 2 + (i - (chips.length - 1) / 2) * (portrait ? canvasW * 0.3 : canvasW * 0.21) - canvasW * 0.105,
              width: canvasW * 0.21,
              opacity: Math.min(1, pop),
              transform: `scale(${0.6 + 0.4 * pop}) translateY(${(1 - pop) * 14}px)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: promptSize * 0.3,
              padding: `${promptSize * 0.42} ${promptSize * 0.6}`,
              borderRadius: 999,
              background: ink.panel,
              border: `1px solid ${ink.panelBorder}`,
              fontFamily: VIDEO_DESIGN.bodyFont,
            }}
          >
            <span style={{width: promptSize * 0.28, height: promptSize * 0.28, borderRadius: '50%', background: accent, flexShrink: 0}} />
            <span
              style={{
                fontSize: tokens.fontSize.body * 0.86,
                fontWeight: 500,
                color: onLight ? '#3D4351' : 'rgba(255,255,255,0.88)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: canvasW * 0.16,
              }}
            >
              {c}
            </span>
          </div>
        );
      })}

      {/* 结果卡：素材从框下生长（AI 生成物的具象） */}
      {showCard && cardT > 0.001 && (
        <div
          style={{
            position: 'absolute',
            left: canvasW / 2 - (portrait ? canvasW * 0.4 : canvasW * 0.29) * cardT,
            top: barY + barH + canvasH * (chips.length > 0 ? 0.12 : 0.05) + (1 - cardT) * 40,
            width: (portrait ? canvasW * 0.8 : canvasW * 0.58) * cardT,
            height: (portrait ? canvasH * 0.3 : canvasH * 0.42) * cardT,
            opacity: Math.min(1, cardT * 1.4),
            overflow: 'hidden',
            borderRadius: 18,
            background: '#000',
            boxShadow: `0 0 0 1.5px ${accent}66, 0 0 ${46 * glow}px ${accent}33, 0 34px 90px -20px rgba(0,0,0,0.8)`,
          }}
        >
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            muted={video.type === 'video' ? true : undefined}
            startFrom={Math.round((video.trimStart || 0) * FPS)}
            endSec={video.type === 'video' ? clipEndSec(video) : undefined}
            cutsSec={video.cuts}
            style={{width: '100%', height: '100%', objectFit: 'cover'}}
          />
        </div>
      )}

      {/* 副标题：回车后浮现的说明行（dragIn 开时 subtitle 被征用为附件 chip 标签，底部行不再渲染） */}
      {text.subtitle && !dragInOn && (
        <div style={{position: 'absolute', bottom: canvasH * 0.085, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={enterFrame + 6}
            style={{
              fontSize: tokens.fontSize.body,
              fontWeight: 500,
              color: ink.body,
              textShadow: '0 1px 10px rgba(0, 0, 0, 0.6), 0 1px 3px rgba(0, 0, 0, 0.8)',
              ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
              ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
              ...textStrokeCss(style?.subtitle),
            }}
          />
        </div>
      )}

      {/* 品牌：右下角 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            right: canvasW * 0.045,
            bottom: canvasH * 0.05,
            fontSize: tokens.fontSize.body * 0.9,
            fontWeight: 700,
            color: ink.faint,
            fontFamily: VIDEO_DESIGN.bodyFont,
            letterSpacing: '0.08em',
          }}
        >
          {text.brandName}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default AiPromptCard;
