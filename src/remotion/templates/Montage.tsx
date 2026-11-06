/**
 * 模板: Montage - 蒙太奇卡点（1.6 M3）
 *
 * 段内节拍快切：多素材（或单素材轮播区间）按固定节奏轮切，语言取自第二轮参照研究的
 * 「高切蒙太奇派」（gucci/vision/gopro，平均镜头 1.9-2.4s）：
 * - 每切切入带变焦冲击（zoom punch：推近 7% 回弹落定），切与切之间方向交替；
 * - 每 N 切一次方向性甩切（横移 + 模糊包络 0.18s，ScreenDemo whoosh 同款手感）；
 * - 镜内缓动（每切内 1 → +3% 缓推）消静止帧；
 * - 可选切点闪白（0.06s，卡点片的拍点标记）。
 * 切分计划在 shared/montage-plan.ts（纯函数可单测）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {MONTAGE_PARAMS} from '../../shared/template-registry';
import {planMontageCuts, type MontageCut} from '../../shared/montage-plan';
import {clipEndSec} from '../../shared/clipCuts';

const WHIP_SEC = 0.18;
const PUNCH_SEC = 0.4;

const easeOutQuart = (q: number) => 1 - Math.pow(1 - q, 4);

export const Montage: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const t = frame / FPS;

  const p = makeParamReader(MONTAGE_PARAMS, params);
  const cutSec = p('cutSec');
  const punch = p('punch');
  const whipEvery = Math.round(p('whipEvery'));
  const motionOn = p('motion') >= 0.5;
  const flashOn = p('flashOn') >= 0.5;
  const showCaption = p('showCaption') >= 0.5;

  const clips = videos.filter((v) => v && (v.type === 'video' || v.type === 'image'));

  const cuts: MontageCut[] = React.useMemo(
    () =>
      planMontageCuts({
        durations: clips.map((v) =>
          v.type === 'video'
            ? Math.max(0.2, (clipEndSec(v) ?? (v.duration || 1)) - (v.trimStart || 0))
            : 3600,
        ),
        totalSec: segmentDuration || 8,
        cutSec,
        whipEvery,
      }),
    [clips, segmentDuration, cutSec, whipEvery],
  );

  // 当前切与切内进度
  let cutIdx = 0;
  let tOffset = t;
  for (let i = 0; i < cuts.length; i++) {
    if (tOffset < cuts[i].durationSec || i === cuts.length - 1) {cutIdx = i; break;}
    tOffset -= cuts[i].durationSec;
  }
  const cut = cuts[cutIdx];
  const video = cut ? clips[cut.videoIndex] : clips[0];

  const opacity = interpolate(frame, [0, 8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  // 切入变焦冲击：前 PUNCH_SEC 内 1+punch*7% → 1 回弹落定；方向交替
  const qPunch = Math.min(1, tOffset / PUNCH_SEC);
  const punchScale = 1 + punch * 0.07 * (1 - easeOutQuart(qPunch)) * (cutIdx % 2 === 0 ? 1 : -1);
  // 镜内缓动：整切 1 → +3%
  const motionScale = motionOn ? 1 + 0.03 * (tOffset / Math.max(0.01, cut?.durationSec ?? 1)) : 1;

  // 甩切：本切入口若上一切带 whip 标记 → 横移 + 模糊包络
  const prevWhip = cutIdx > 0 && cuts[cutIdx - 1].whip;
  const qWhip = prevWhip ? Math.min(1, tOffset / WHIP_SEC) : 1;
  const whipX = prevWhip ? (1 - easeOutQuart(qWhip)) * canvasW * 0.12 * (cutIdx % 2 === 0 ? -1 : 1) : 0;
  const whipBlur = prevWhip ? Math.sin(qWhip * Math.PI) * 10 * (canvasW / 1920) : 0;

  // 切点闪白
  const flash = flashOn && tOffset < 0.07 ? (1 - tOffset / 0.07) * 0.5 : 0;

  const mediaStart = (video ? video.trimStart || 0 : 0) + (cut?.mediaStart ?? 0);

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {video && (
        <AbsoluteFill style={{overflow: 'hidden'}}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              transform: `scale(${punchScale * motionScale}) translateX(${whipX}px)`,
              ...(whipBlur > 0.2 ? {filter: `blur(${whipBlur.toFixed(1)}px)`} : {}),
            }}
          >
            <ClipMedia
              src={video.src}
              mediaType={video.type}
              muted={video.type === 'video' ? true : undefined}
              startFrom={Math.round(mediaStart * FPS)}
              endSec={video.type === 'video' ? clipEndSec(video) : undefined}
              cutsSec={video.cuts}
              style={{width: '100%', height: '100%', objectFit: 'cover'}}
            />
          </div>
          {flash > 0.01 && <AbsoluteFill style={{background: '#fff', opacity: flash, pointerEvents: 'none'}} />}
        </AbsoluteFill>
      )}

      {!video && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: tokens.fontSize.body,
            color: VIDEO_DESIGN.colors.textMuted,
            fontFamily: VIDEO_DESIGN.bodyFont,
          }}
        >
          「蒙太奇卡点」需要至少 1 段素材
        </div>
      )}

      {/* 文字层：底部标题/副标题 */}
      {showCaption && text.title && (
        <div style={{position: 'absolute', bottom: canvasH * 0.08, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={15}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.75,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
              letterSpacing: '-0.01em',
              textShadow: '0 2px 16px rgba(0, 0, 0, 0.65), 0 1px 3px rgba(0, 0, 0, 0.8)',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: 10}}>
              <AnimatedText
                text={text.subtitle}
                preset="fadeIn"
                startFrame={28}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                  textShadow: '0 1px 10px rgba(0, 0, 0, 0.6), 0 1px 3px rgba(0, 0, 0, 0.8)',
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default Montage;
