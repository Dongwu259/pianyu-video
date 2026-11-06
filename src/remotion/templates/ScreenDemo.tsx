/**
 * 模板: ScreenDemo - 导播演示（录屏即成品 · 多镜头剪辑语言）
 *
 * CursorFollow 的多镜头进化：单镜连续跟随 → 按导播镜头计划（shot plan）切换景别。
 * 镜头计划由 M1 导播分析器（shared/director-plan.ts）在渲染期从素材光标轨迹确定性算出：
 * 点击落小景、停顿出大景、活动段中/小景交替；相邻镜头景别必不同、倾斜-摆正循环。
 * 这就是「破严格故事板拼接」的题眼——镜头切换发生在段内（媒体时间轴），配 whoosh 模糊过渡。
 *
 * 画面结构（全部画在视频平面内，随倾斜一起动）：
 * - 视频平面：tiltCoverFactor 补偿的轻微 rotateZ（倾斜-摆正循环，±2°×开关）；
 * - 相机层：当前镜头相机（景别 zoom × 镜内缓推 5%），whoosh 时与前镜头相机 easeOutBack
 *   混合（过冲回弹）+ 方向性平移踢一脚 + 高斯模糊包络（≈5 帧）；
 * - 美化光标：CursorOverlay（轨迹平滑 + 光晕 + 按压脉冲），随相机映射、恒定屏幕尺寸；
 * - 点击渐晕：点击镜头内以焦点为中心的径向暗化（v1 圆形）；
 * - 点击浮卡：点击落点后 0.15s，点击点为心裁一块圆角浮卡（内嵌第二路同素材相机视图）
 *   回弹入场悬浮 2.3s——FocuSee「组件特写」手法的区域近似；
 * - 文字层：底部标题/副标题（与 CursorFollow 同款包装）。
 *
 * 素材无轨迹：导播计划退化为单个宽景 → 全片只做镜内缓推（同 ScreenRecord 加缓推，不报错）。
 * 个性参数（SCREEN_DEMO_PARAMS）：中景/小景推近倍率、倾斜循环、镜内缓推、点击渐晕、
 * 点击浮卡（含大小）、光标显隐与大小。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {CursorOverlay} from '../layers/CursorOverlay';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {SCREEN_DEMO_PARAMS} from '../../shared/template-registry';
import {timelineToMediaSec, clipEndSec} from '../../shared/clipCuts';
import {planDirectorShots} from '../../shared/director-plan';
import {
  resolveShotIndex, shotZoom, shotFocusPx, shotDrift, biasFocus,
  transitionState, vignetteAlpha, floatCardState, blendCam, WHOOSH_SEC, DRIFT_MAX,
} from '../../shared/screen-demo-shot';
import {smoothCursorTrack} from '../../shared/cursor-smooth';
import {clickHighlightState} from '../../shared/click-highlight';
import {
  stageBackgroundCss, stageCardGlowShadow, STAGE_PALETTES,
  STAGE_CARD_RADIUS, STAGE_CARD_SHADOW, stageCardBorder, autoAccentPaletteIdx,
} from '../../shared/stage-bg';
import {cameraFrame, tiltCoverFactor, sampleTrack} from '../utils/followCamera';
import {coverCropFrac} from '../utils/aspectLayout';
import type {CameraFrame} from '../utils/followCamera';

const PERSPECTIVE = 1200;
/** 浮卡画框：圆角/描边/投影（屏幕空间元素，不随平面倾斜——悬浮在演示画面之上） */
const CARD_RADIUS = 14;
const CARD_ASPECT = 16 / 10;
/** 卡内画面相对主相机的放大倍率（特写感的关键） */
const CARD_BOOST = 1.25;
const CARD_SHADOW = '0 18px 48px -16px rgba(0, 0, 0, 0.55)';

export const ScreenDemo: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 8) * FPS));

  const p = makeParamReader(SCREEN_DEMO_PARAMS, params);
  const zoomMed = p('zoomMed');
  const zoomClose = p('zoomClose');
  const tiltOn = p('tiltAmp') >= 0.5;
  const driftOn = p('drift') >= 0.5;
  const vignetteOn = p('vignette') >= 0.5;
  const cardOn = p('floatCard') >= 0.5;
  const cardSize = p('cardSize');
  const showCursor = p('showCursor') >= 0.5;
  const cursorScale = p('cursorScale');
  const highlightOn = p('clickHighlight') >= 0.5;
  const smoothOn = p('smoothCursor') >= 0.5;
  const stageBgMode = p('stageBg');
  // 色板 8 = 自动取色：按素材主色调映射最近舞台色板（无统计回退石墨）
  const stagePaletteRaw = p('stagePalette');
  const stagePaletteIdx = stagePaletteRaw >= 8 ? autoAccentPaletteIdx(videos[0]?.colorStats) : stagePaletteRaw;
  const stageCardMode = p('stageCard');
  const stagePad = p('stagePad');

  const video = videos[0];
  const videoW = video?.width || canvasW;
  const videoH = video?.height || canvasH;
  const points = video?.cursorPoints;
  const clicks = video?.cursorClicks;
  const hasTrack = !!video && !!points && points.length >= 2;

  const opacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 镜头计划：渲染期从光标轨迹确定性算出（媒体秒时基）；每帧查表
  const plan = React.useMemo(
    () =>
      video
        ? planDirectorShots({
            points: points ?? [],
            clicks: clicks ?? [],
            videoWidth: videoW,
            videoHeight: videoH,
            durationSec: video.duration || 0,
            contentWindows: video.contentWindows,
          })
        : [],
    [video, points, clicks, videoW, videoH],
  );

  // 段内帧 → 媒体秒（挖段时分段映射，与 CursorFollow/CursorOverlay 同口径）
  const mediaSec =
    video?.cuts && video.cuts.length > 0
      ? timelineToMediaSec(frame / FPS, video.trimStart || 0, video.cuts)
      : (video?.trimStart || 0) + frame / FPS;

  const idx = resolveShotIndex(plan, mediaSec);
  const shot = plan[idx] ?? null;
  // 光标轨迹后处理（重定时：缓动+点击驻留；只影响渲染合成光标，导播计划仍用原始轨迹）
  const renderPoints = React.useMemo(() => {
    if (!points) return points;
    return (
      smoothCursorTrack(points, clicks, {videoWidth: videoW, videoHeight: videoH, enabled: smoothOn}) ?? points
    );
  }, [points, clicks, videoW, videoH, smoothOn]);
  const cursorPx = hasTrack ? sampleTrack(renderPoints ?? points!, mediaSec * 1000) : null;

  // 倾斜-摆正循环：过渡期间从前镜头倾角平滑转到当前镜头倾角
  const tiltCur = shot && tiltOn ? shot.tilt : 0;
  const tr = shot ? transitionState(plan, idx, mediaSec, WHOOSH_SEC) : {q: 1, qlin: 1, sway: 0};
  const tiltPrev = idx > 0 && tiltOn ? plan[idx - 1].tilt : 0;
  const tilt = tr.q >= 1 ? tiltCur : tiltPrev + (tiltCur - tiltPrev) * tr.q;
  // 覆盖补偿：rotateZ 后平面放大到仍盖住画布（数值解，逐帧便宜）
  // 窗口卡模式：平面是舞台上的圆角卡（不满幅、无需覆盖补偿），按视频宽高比装进 84%×80% 的框。
  // 画幅感知（aspect 审计 P0-3）：画布与素材画幅偏差大时满幅 cover 的裁切方向翻转且
  // 幅度失控（21:9 裁上下 24%、方形裁左右 43%，导播取景窗来不及跟）——cover 裁切率
  // 超阈值即强制窗口卡（竖屏先例），舞台卡内 contain 全画幅可读；16:9 实测裁切 0.5% 不触发
  const cardMode = stageCardMode >= 1 || coverCropFrac(canvasW, canvasH, videoW, videoH) > 0.12;
  const pad = cardMode ? 1 : tiltCoverFactor(0, tilt, PERSPECTIVE, canvasW, canvasH);
  let planeW = canvasW * pad;
  let planeH = canvasH * pad;
  if (cardMode) {
    planeH = Math.min(canvasH * 0.8, (canvasW * stagePad) / (videoW / videoH));
    planeW = planeH * (videoW / videoH);
  }

  // 镜头相机：景别 zoom × 镜内缓推；非点击镜头焦点向光标轻偏
  const zooms = {zoomMed, zoomClose};
  const focusCur = shot
    ? biasFocus(shotFocusPx(shot, videoW, videoH), cursorPx, videoW, videoH, 0.3, shot.reason === 'click')
    : {cx: videoW / 2, cy: videoH / 2};
  const zoomCur = shot ? shotZoom(shot, zooms) * (driftOn ? shotDrift(shot, mediaSec) : 1) : 1;
  const camCur = cameraFrame(focusCur.cx, focusCur.cy, videoW, videoH, zoomCur, planeW, planeH);

  // whoosh：与前镜头相机（满漂移状态）混合，过冲回弹 + 方向踢 + 模糊包络
  let cam: CameraFrame = camCur;
  if (tr.q < 1 && idx > 0) {
    const prev = plan[idx - 1];
    const zoomPrev = shotZoom(prev, zooms) * (driftOn ? 1 + DRIFT_MAX : 1);
    const focusPrev = shotFocusPx(prev, videoW, videoH);
    const camPrev = cameraFrame(focusPrev.cx, focusPrev.cy, videoW, videoH, zoomPrev, planeW, planeH);
    cam = blendCam(camPrev, camCur, tr.q);
    cam = {
      ...cam,
      translateX: cam.translateX + tr.sway * Math.sin(tr.qlin * Math.PI) * canvasW * 0.012,
    };
  }
  const blurPx = tr.qlin < 1 ? Math.sin(tr.qlin * Math.PI) * 9 * (canvasW / 1920) : 0;

  // 点击渐晕（平面内，中心即画布中心 = 焦点所在）
  const vig = shot && vignetteOn ? vignetteAlpha(shot, mediaSec) : 0;

  // 点击浮卡（屏幕空间，盖在平面之上；内容 = 点击点为心的第二路相机视图）。
  // 卡内 zoom 相对主相机再放大 CARD_BOOST：直接用景别倍率会吃「cover 基数随画框变小」的亏
  // （cardW/videoW ≪ canvasW/videoW，同倍率下卡片视野反而更广），必须按基数补偿折算。
  const card = shot && cardOn && video ? floatCardState(clicks ?? [], shot, mediaSec) : null;
  const cardW = Math.min(canvasW * 0.3, canvasH * CARD_ASPECT * 0.5) * cardSize;
  const cardH = cardW / CARD_ASPECT;
  const cardCx = card ? (card.cx * videoW) : 0;
  const cardCy = card ? (card.cy * videoH) : 0;
  const cardCoverBase = Math.max(cardW / videoW, cardH / videoH);
  const cardCam =
    card && video
      ? cameraFrame(cardCx, cardCy, videoW, videoH, (cam.scale * CARD_BOOST) / cardCoverBase, cardW, cardH)
      : null;

  // 光标映射：相机几何折叠成 placed（video 像素 → 平面内 px），CursorOverlay 同口径
  const placed = {
    width: videoW * cam.scale,
    height: videoH * cam.scale,
    translateX: planeW / 2 - (videoW * cam.scale) / 2 + cam.translateX,
    translateY: planeH / 2 - (videoH * cam.scale) / 2 + cam.translateY,
  };
  // 卡内光标已移除（放大镜几何把光标位移再放大数倍，扫向卡缘被裁切＝「飞走又飞回」的错觉）

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : stageBackgroundCss(stageBgMode, stagePaletteIdx) ? (
        <AbsoluteFill style={{background: stageBackgroundCss(stageBgMode, stagePaletteIdx)!}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {video && (
        <AbsoluteFill style={{perspective: PERSPECTIVE}}>
          {/* 视频平面：轻微倾斜（循环），圆角画框只在倾斜 ≠ 0 时启用（正时满幅无框）；
              窗口卡模式恒为圆角卡 + 投影（辉光卡加品牌色外发光） */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: planeW,
              height: planeH,
              overflow: 'hidden',
              background: '#000',
              transform: `translate(-50%, -50%) rotateZ(${tilt}deg)`,
              borderRadius: cardMode ? STAGE_CARD_RADIUS : Math.abs(tilt) > 0.01 ? 14 : 0,
              boxShadow: cardMode
                ? stageCardMode >= 2
                  ? `${STAGE_CARD_SHADOW}, ${stageCardGlowShadow(stagePaletteIdx)}`
                  : STAGE_CARD_SHADOW
                : Math.abs(tilt) > 0.01
                  ? '0 30px 80px -18px rgba(0, 0, 0, 0.55)'
                  : 'none',
              ...(cardMode ? {border: stageCardBorder(stagePaletteIdx)} : {}),
            }}
          >
            {/* 相机层：模糊包络只在 whoosh 帧挂载（filter 开销大） */}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: videoW,
                height: videoH,
                transform: `translate(-50%, -50%) translate(${cam.translateX}px, ${cam.translateY}px) scale(${cam.scale})`,
                ...(blurPx > 0.2 ? {filter: `blur(${blurPx.toFixed(1)}px)`} : {}),
              }}
            >
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
            {/* 点击渐晕：中心即焦点（相机已把点击点放到中心） */}
            {vig > 0.01 && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 26%, rgba(0,0,0,0.72) 78%)',
                  opacity: vig,
                  pointerEvents: 'none',
                }}
              />
            )}
            {/* 点击目标高亮描边：以点击点为中心的圆角矩形渐显（媒体坐标经 placed 映射） */}
            {(() => {
              if (!highlightOn || !video) return null;
              const hl = clickHighlightState(clicks, mediaSec * 1000, videoW, videoH);
              if (!hl) return null;
              const sx = placed.width / videoW;
              const sy = placed.height / videoH;
              const hw = hl.w * sx;
              const hh = hl.h * sy;
              const hx = placed.translateX + hl.cx * sx - hw / 2;
              const hy = placed.translateY + hl.cy * sy - hh / 2;
              const palette = STAGE_PALETTES[Math.max(0, Math.min(STAGE_PALETTES.length - 1, Math.round(stagePaletteIdx)))];
              return (
                <div
                  style={{
                    position: 'absolute',
                    left: hx,
                    top: hy,
                    width: hw,
                    height: hh,
                    borderRadius: Math.min(hh * 0.3, 16),
                    border: `${Math.max(2, canvasW * 0.0016)}px solid rgba(255, 255, 255, 0.92)`,
                    boxShadow: `0 0 18px ${palette.glow}88, inset 0 0 12px rgba(255, 255, 255, 0.12)`,
                    background: 'rgba(8, 12, 28, 0.18)',
                    opacity: hl.opacity,
                    pointerEvents: 'none',
                  }}
                />
              );
            })()}
            {/* 美化光标（平面内坐标映射，恒定屏幕尺寸；轨迹经后处理重定时；
                拖尾倾斜档 cursorLean：近期速度方向轻微摆尾，B1） */}
            {showCursor && (
              <CursorOverlay
                points={renderPoints ?? points}
                clicks={clicks}
                frame={frame}
                fps={FPS}
                startFrom={Math.round((video.trimStart || 0) * FPS)}
                cutsSec={video.cuts}
                endSec={clipEndSec(video)}
                vw={videoW}
                vh={videoH}
                placed={placed}
                frameW={canvasW * cursorScale}
                leanTier={p('cursorLean')}
              />
            )}
          </div>

          {/* 点击浮卡（就地生长放大镜）：屏幕空间，中心锚定点击点的屏幕投影（贴边钳制），
              transformOrigin=点击点 → 从点击点原地生长，全程不透明；点击后 200ms 才出现
              （floatCardState 包络，让高亮环先说话）。卡内不放光标：放大镜几何会把光标
              位移再放大数倍，扫向卡缘被裁切＝「光标飞走又飞回」的错觉（用户审片实锤） */}
          {card && cardCam && (() => {
            const anchorX = placed.translateX + card.cx * videoW * cam.scale;
            const anchorY = placed.translateY + card.cy * videoH * cam.scale;
            const margin = Math.max(10, canvasH * 0.015);
            const cardLeft = Math.min(Math.max(anchorX - cardW / 2, margin), Math.max(margin, canvasW - cardW - margin));
            const cardTop = Math.min(Math.max(anchorY - cardH / 2, margin), Math.max(margin, canvasH - cardH - margin));
            return (
              <div
                style={{
                  position: 'absolute',
                  left: cardLeft,
                  top: cardTop,
                  width: cardW,
                  height: cardH,
                  overflow: 'hidden',
                  borderRadius: CARD_RADIUS,
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  boxShadow: CARD_SHADOW,
                  transform: `scale(${card.scale})`,
                  transformOrigin: `${anchorX - cardLeft}px ${anchorY - cardTop}px`,
                  opacity: card.opacity,
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: videoW,
                    height: videoH,
                    transform: `translate(-50%, -50%) translate(${cardCam.translateX}px, ${cardCam.translateY}px) scale(${cardCam.scale})`,
                  }}
                >
                  <ClipMedia
                    src={video.src}
                    mediaType={video.type}
                    muted
                    startFrom={Math.round((video.trimStart || 0) * FPS)}
                    endSec={clipEndSec(video)}
                    cutsSec={video.cuts}
                    style={{width: '100%', height: '100%', objectFit: 'fill'}}
                  />
                </div>
              </div>
            );
          })()}
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
          }}
        >
          <div
            style={{
              fontSize: tokens.fontSize.body,
              color: VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.05em',
            }}
          >
            「导播演示」需要 1 段录屏素材：本软件录制的素材带鼠标轨迹，可自动切镜头
          </div>
        </div>
      )}

      {/* 文字层：底部标题/副标题。半透明暗衬底——本模板文字直接压在录屏画面上，
          亮色 UI 面板上细白字+弱投影=虚影（v9 hero 终审实锤），衬底与系统字幕条同语言 */}
      {text.title && (
        <div style={{position: 'absolute', bottom: canvasH * 0.08, left: 0, right: 0, textAlign: 'center'}}>
          <div style={{
            display: 'inline-block',
            padding: '14px 30px 16px',
            borderRadius: 18,
            background: 'rgba(7, 11, 18, 0.55)',
            boxShadow: '0 10px 36px rgba(0, 0, 0, 0.35)',
          }}>
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
              <div style={{marginTop: 8}}>
                <AnimatedText
                  text={text.subtitle}
                  preset={textAnim ?? 'fadeIn'}
                  startFrame={28}
                  style={{
                    fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                    fontWeight: style?.subtitle?.fontWeight ?? 500,
                    color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textBodyDark,
                    textShadow: '0 1px 10px rgba(0, 0, 0, 0.6), 0 1px 3px rgba(0, 0, 0, 0.8)',
                    ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                    ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
                    ...textStrokeCss(style?.subtitle),
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default ScreenDemo;
