/**
 * 模板: CursorFollow - 鼠标跟随运镜
 *
 * 跟随整屏录制时记录的鼠标轨迹（VideoClip.cursorPoints）对画面做平移缩放运镜，
 * 并在跟随点合成一枚箭头光标（录制画面本身不含光标）。
 * 素材无轨迹数据时降级为 KenBurns 式缓慢居中推拉（不报错、不空白）。
 *
 * 模式：
 * - 正面模式（tiltX = tiltZ = 0）：视频满画布跟随。
 * - 3D 模式（tiltX 或 tiltZ ≠ 0）：perspective 容器内视频平面 rotateX/rotateZ 斜视，
 *   圆角 + 深色阴影画框；平面按 tiltCoverFactor（数值解）预先放大，
 *   保证投影后仍覆盖整个画布（四角不露背景）。
 *
 * 相机数学（轨迹采样/平滑/覆盖钳位/倾斜补偿）在 utils/followCamera.ts，为纯函数可单测。
 * 时间对齐：段内帧 f 的源视频时间 = trimStart + f/FPS 秒 → 查轨迹 t = f×1000/FPS + trimStart×1000。
 *
 * 个性化参数（paramSpecs: CURSOR_FOLLOW_PARAMS）：zoom 跟随放大 / smooth 平滑窗口 /
 * clickZoomOn·clickZoom·clickHold 点击自动放大 / clickRipple 点击波纹 /
 * tiltX 3D 倾斜角 / tiltZ 旋转角 / cursorScale 光标大小 / showCursor 显示光标。
 * 点击运镜：素材带 cursorClicks（录屏点击事件）时，点击处自动推近放大（包络数学见
 * utils/followCamera.ts clickZoomEnvelope 已由 shared/click-zoom-smooth 的四策略包络
 * 取代——同区域连点稳定/活动延长/相接交接/弹簧缓动），光标始终画在真实轨迹位置。
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
import {CURSOR_FOLLOW_PARAMS} from '../../shared/template-registry';
import {timelineToMediaSec} from '../../shared/clipCuts';
import {smoothCursorTrack} from '../../shared/cursor-smooth';
import {clickHighlightState} from '../../shared/click-highlight';
import {planClickZoomEnvelopes, sampleClickZoom, anchorZoomFocus, focusMaskState, recenterFocus, springProgress, hoverClusters, hoverCardState, SPRING_TONES, type ClickZoomEnvelope} from '../../shared/click-zoom-smooth';
import {cursorLeanDeg, cursorPressState, suggestCursorTiltSign} from '../utils/cursorOverlay';
import {
  stageBackgroundCss, stageCardGlowShadow,
  STAGE_CARD_RADIUS, STAGE_CARD_SHADOW, stageCardBorder,
} from '../../shared/stage-bg';
import {followCameraPath, cameraFrame, blendCameraFrame, tiltCoverFactor, spanToZoom, leadFocusY} from '../utils/followCamera';
import {clipEndSec} from '../../shared/clipCuts';

/** 3D 模式的透视距离与画框样式 */
const FRAME_RADIUS = 16;
const FRAME_SHADOW = '0 40px 90px -20px rgba(0, 0, 0, 0.6)';

export const CursorFollow: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
  planCaptionWindows,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH, fps} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 8) * FPS));

  // 个性化参数（故事板「参数」页滑块；未调整走 CURSOR_FOLLOW_PARAMS 默认值）
  const p = makeParamReader(CURSOR_FOLLOW_PARAMS, params);
  const zoom = p('zoom');                 // 跟随放大倍率（直接值，1 = 不放大）
  const smooth = p('smooth');             // 平滑窗口（秒，滑动平均 ±smooth/2）
  const clickZoomOn = p('clickZoomOn') >= 0.5; // 点击自动放大开关
  const clickZoom = p('clickZoom');       // 点击放大倍率（与 zoom 相乘）
  const clickHold = p('clickHold');       // 点击放大停留时长（秒）
  // 指定坐标放大锚点（0-1 归一化，双双为 0 = 关：锚点=鼠标点击处）。激活时点击包络的
  // 放大中心钉在该坐标（视频像素 = 归一化 × videoW/H，与组焦点同 safeInset 钳位口径）；
  // 多次点击恒定同锚（相邻包络交接期焦点插值恒等零漂移）。轮换锚点（focusAnchors 数组）
  // 留接口不做。
  const focusAnchorX = p('focusAnchorX');
  const focusAnchorY = p('focusAnchorY');
  const clickEffect = Math.round(p('clickRipple')); // 点击效果档位：0 关 / 1 涟漪 / 2 光晕 / 3 双环 / 4 微闪（旧 0/1 兼容）
  const springTone = SPRING_TONES[Math.round(p('springTone'))] ?? SPRING_TONES[0]; // 点击运镜弹簧手感
  const cursorLeanTier = p('cursorLean'); // 光标拖尾倾斜档位：0 关 / 1 弱 / 2 中 / 3 强
  const tiltX = p('tiltX');               // 3D 倾斜角（度，0 = 正面直视）
  const tiltY = p('tiltY');               // 3D 侧倾角（度，绕竖直轴；正 = 右侧转向屏幕深处）
  const tiltZ = p('tiltZ');               // 旋转角（度）
  const tiltAutoOn = p('tiltAuto') >= 0.5; // 倾斜自动定向（eye-trace 纪律：符号随轨迹水平主方向）
  const perspPx = p('tiltPersp');         // 透视强度（px，越小透视越夸张；满幅模式覆盖补偿同参）
  const cursorScale = p('cursorScale');   // 光标大小倍率
  const showCursor = p('showCursor') >= 0.5; // 0/1 开关
  const highlightOn = p('clickHighlight') >= 0.5; // 点击目标高亮描边
  const smoothOn = p('smoothCursor') >= 0.5;      // 光标轨迹后处理（重定时）
  const stageBgMode = p('stageBg');
  const stagePaletteIdx = p('stagePalette');
  const stageCardMode = p('stageCard');
  const cardFill = p('cardFill');         // 窗口卡宽度占比（竖版拉大画中画用；默认 0.84=历史口径）
  const viewSpan = p('viewSpan');         // 可视跨度：>0 时放大改由「可见视频宽度占比」定义（跟随裁切窗）
  const stageAmbientOn = p('stageAmbient') >= 0.5; // 舞台环境虚化：背景=录屏自身 blur（留边与内容永远同色）
  const focusDim = {
    focusDimOn: p('focusDimOn'),
    focusDimBlur: p('focusDimBlur'),
    focusDimSize: p('focusDimSize'),
    focusDimDark: p('focusDimDark'),
    focusDimTarget: p('focusDimTarget'),
    focusDimShape: p('focusDimShape'),
    focusDimAngle: p('focusDimAngle'),
  };
  const hoverCardOn = p('hoverCard') >= 0.5; // 悬停浮卡：指针驻留处弹区域放大卡（一.2）
  const hoverCardZoom = p('hoverCardZoom');
  const recenterOn = p('focusRecenter') >= 0.5; // 可读性收框（D4）：满格时落点漂向中心安全盒
  const focusLeadTier = p('focusLead');          // 垂直引导（B3）：0 关 / 1 弱 / 2 强
  const focusPopOn = p('focusPop') >= 0.5;       // 聚焦浮出（B1）：清晰区上浮为独立卡层

  const video = videos[0];
  const videoW = video?.width || canvasW;
  const videoH = video?.height || canvasH;
  const points = video?.cursorPoints;
  const clicks = video?.cursorClicks;
  const hasTrack = !!video && !!points && points.length >= 2;

  // 光标轨迹后处理：缓动 + 点击驻留（相机与合成光标都走平滑后的轨迹；1.6 操作视频内核）
  const renderPoints = React.useMemo(() => {
    if (!points) return points;
    return smoothCursorTrack(points, clicks, {videoWidth: videoW, videoHeight: videoH, enabled: smoothOn}) ?? points;
  }, [points, clicks, videoW, videoH, smoothOn]);

  // eye-trace 倾斜纪律（tiltAuto 开启时）：倾斜符号与光标轨迹水平主方向同侧——
  // 向右主导 → rotateZ 正角（顺时针，内容右缘下沉沿目光流动向）；无主导（|ratio|≤0.25）保持用户原值
  const tiltSign = tiltAutoOn ? suggestCursorTiltSign(points) : 0;
  const tiltZEff = tiltSign !== 0 ? tiltSign * Math.abs(tiltZ) : tiltZ;
  const is3D = tiltX !== 0 || tiltY !== 0 || tiltZEff !== 0;
  // 倾斜入场（v8 反馈）：tiltIntro 开时前 introSec 秒从 0° 弹簧缓动到目标角——
  // 否则片段从头斜到尾，连续多段观感单一。弹簧自带轻微回弹（欠阻尼归一化端点）；
  // 覆盖补偿按终态角取 pad，入场期角度小 → 平面只大不小（保守正确）。
  // 每段方向差异由装配侧给不同参数（正负交替/随机分配），模板保持确定性。
  const tiltIntroOn = p('tiltIntro') >= 0.5;
  const tiltIntroK = tiltIntroOn
    ? springProgress(Math.min(1, frame / Math.max(1, Math.round(p('tiltIntroSec') * FPS))))
    : 1;
  const tiltXNow = tiltX * tiltIntroK;
  const tiltYNow = tiltY * tiltIntroK;
  const tiltZNow = tiltZEff * tiltIntroK;
  // 窗口卡模式：平面是舞台上的圆角卡（不满幅，无需倾斜覆盖补偿）——卡模式倾斜即
  // DogSC 的「舞台上的 3D 屏卡」形态（露的是舞台背景，本就设计如此）
  const cardMode = stageCardMode >= 1;
  // 3D 覆盖补偿：平面放大到 tiltPad×画布尺寸，rotateX/rotateY/rotateZ + perspective
  // 投影后仍包含整个画布（四角不露背景；数值解见 utils/followCamera.ts tiltCoverFactor）。
  // 正面模式 tiltPad = 1，平面即画布。
  const tiltPad = !cardMode && is3D ? tiltCoverFactor(tiltX, tiltZ, perspPx, canvasW, canvasH, tiltY) : 1;
  let planeW = canvasW * tiltPad;
  let planeH = canvasH * tiltPad;
  if (cardMode) {
    // cardFill：卡宽占画布比（v9 竖版反馈「画中画太小」——竖屏拉到 0.96）；仍受高度 0.8 封顶
    planeW = canvasW * cardFill;
    planeH = planeW / (videoW / videoH);
    const maxH = canvasH * 0.8;
    if (planeH > maxH) {
      planeH = maxH;
      planeW = planeH * (videoW / videoH);
    }
  }
  // 可视跨度（viewSpan>0，v9 竖版反馈「放大到一部分、方框跟随鼠标」）：放大改由
  // 「可见视频宽度占比」定义——卡片内容不再 contain 整个录屏，而是以平滑光标为中心的
  // span×videoW 裁切窗（跟随相机钳位保证窗口不越出视频边界）。数学见 utils/followCamera spanToZoom
  const zoomEff = viewSpan > 0.01
    ? spanToZoom(viewSpan, planeW, planeH, videoW, videoH) || zoom
    : zoom;

  // 入场淡入（结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责）
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 每帧注视点：先按帧采样轨迹（经后处理）再做滑动平均（纯函数；无轨迹时不计算，走下方推拉降级）
  const path = React.useMemo(
    () =>
      hasTrack
        ? followCameraPath(renderPoints!, totalFrames, FPS, {
            smoothSec: smooth,
            offsetMs: (video!.trimStart || 0) * 1000,
            // 挖段（cuts）时帧→媒体时间为分段映射，mediaMsAt 逐帧查表（offsetMs 只能表达线性平移）
            ...(video!.cuts && video!.cuts.length > 0
              ? {
                  mediaMsAt: (f: number) =>
                    timelineToMediaSec(f / FPS, video!.trimStart || 0, video!.cuts) * 1000,
                }
              : {}),
          })
        : null,
    [hasTrack, points, renderPoints, totalFrames, smooth, video],
  );

  // 点击自动运镜（丝滑版）：规划一次包络（同区域连点共享稳定焦点/指针活动延长保持/
  // 相接交接零回落/弹簧缓动——移植自 DogSC AutoZoomPlanner 的四策略，见 shared/click-zoom-smooth.ts），
  // 逐帧只做二分采样。clickHold 语义 = 基础停留（指针持续活动时自动延长）。
  const zoomEnvelopes: ClickZoomEnvelope[] = React.useMemo(() => {
    if (!hasTrack || !clickZoomOn || !clicks || clicks.length === 0) return [];
    return planClickZoomEnvelopes(clicks, renderPoints, videoW, videoH, {
      zoomScale: clickZoom,
      holdSec: Math.max(0.2, clickHold),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTrack, clickZoomOn, clicks, renderPoints, videoW, videoH, clickZoom, clickHold]);
  const globalMs =
    video?.cuts && video.cuts.length > 0
      ? timelineToMediaSec(frame / FPS, video.trimStart || 0, video.cuts) * 1000
      : (video?.trimStart || 0) * 1000 + (frame * 1000) / FPS;
  const clickState =
    zoomEnvelopes.length > 0 ? sampleClickZoom(zoomEnvelopes, globalMs, clicks, springTone) : null;

  // 悬停浮卡（一.2）：驻留聚类事件（规划一次）；点击包络激活时浮卡让位（点击运镜接管）
  const hoverEvents = React.useMemo(() => {
    if (!hasTrack || !hoverCardOn || !renderPoints) return [];
    return hoverClusters(renderPoints, clicks, {videoW, videoH});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTrack, hoverCardOn, renderPoints, clicks, videoW, videoH]);
  const hoverCard =
    hoverEvents.length > 0 && !(clickState && clickState.amount > 0.15)
      ? hoverCardState(hoverEvents, renderPoints, globalMs, {videoW, videoH})
      : null;

  // 当前帧相机（scale/translate 施加在视频元素上，中心锚定平面中心；覆盖目标 = 平面）
  let cam: {scale: number; translateX: number; translateY: number};
  // rawFocus = 轨迹原始注视点（合成光标落点用——光标始终画在真实鼠标位置，不随点击运镜偏移）
  let rawFocus: {cx: number; cy: number} | null = null;
  if (path && path.length > 0) {
    const f = Math.min(Math.max(frame, 0), path.length - 1);
    rawFocus = path[f];
    // 垂直引导（B3）：跟随相机的注视点纵向偏置（点击目标不吃——收框语义不被干扰）。
    // 跟随 scale 与 cameraFrame 内部同式（coverBase × zoomEff），偏置随注视点滑动平均
    // 天然平滑；贴边时 cameraFrame 覆盖钳位让偏置自然失效
    const followScale = Math.max(planeW / videoW, planeH / videoH) * zoomEff;
    const followY = leadFocusY(rawFocus.cy, videoH, followScale, planeH, focusLeadTier);
    if (clickState && clickState.focus && clickState.amount > 0) {
      // 点击运镜（B 项锚点防漂移）：两端相机帧直接同参混合——起点=当前跟随相机（含垂直引导），
      // 终点=满格点击相机（组焦点 + zoom×clickZoom）。兴趣点的屏幕位置随 amount 直线收敛，
      // 消除旧「focus 与 zoom 各自插值再乘积」在 k=zoom×clickZoom>2 时的起步外甩。
      // 进场权重=amount；出场回落自动走同一直线返回；交接期 amount=1、组焦点已含
      // A 项平滑移交（translate 随焦点线性 → 仍是直线）。
      const camRaw = cameraFrame(rawFocus.cx, followY, videoW, videoH, zoomEff, planeW, planeH);
      // 指定坐标放大锚点：只覆盖「放大中心」（下述 targetF 的落点）；聚焦蒙版锚点
      // （focusDimTarget 0=点击组中心/1=指针跟随两档语义，见下方 focusMaskState 调用）与
      // 波纹/点击高亮（画在真实点击处）均不吃该值——操作痕迹与注意力引导不跟锚点跑。
      // 若要联动（蒙版也钉锚点）：把 focusMaskState 的入参 clickState.focus 换成本分支的
      // zoomF 即可；取舍=清晰区离开指针/点击处，打字/拖拽场景易让观众注意力与操作脱节，
      // 故默认不联动。
      const zoomF =
        anchorZoomFocus(clickState, focusAnchorX, focusAnchorY, videoW, videoH) ?? clickState.focus;
      // 可读性收框（D4）：目标焦点随 amount 同进度漂向 30% 内缩安全盒（DogSC framing 同思路，
      // scale 与 camera travel 共用一个 progress → 连续；关=全程钉住点击点=现状）
      const targetF = recenterOn
        ? recenterFocus(zoomF, clickState.amount, videoW, videoH)
        : zoomF;
      const camTarget = cameraFrame(
        targetF.x, targetF.y, videoW, videoH, zoomEff * clickZoom, planeW, planeH,
      );
      cam = blendCameraFrame(camRaw, camTarget, clickState.amount, videoW, videoH, planeW, planeH);
    } else {
      cam = cameraFrame(rawFocus.cx, followY, videoW, videoH, zoomEff, planeW, planeH);
    }
  } else {
    // 无轨迹降级：KenBurns 式缓慢居中推拉（注视点固定视频中心 → 不平移）
    const z = interpolate(frame, [0, totalFrames], [1, zoomEff], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    cam = cameraFrame(videoW / 2, videoH / 2, videoW, videoH, z, planeW, planeH);
  }

  // 点击效果四式（DogSC CursorClickEffectStyle）：进度 q ∈ [0,1) + 档位 kind，渲染层按 kind 出形态；
  // 坐标屏幕换算与光标同式但锚定真实点击位置（相机层外，随相机映射）。
  // btn = 右键（button 2）时四式换暖色调（与左键白/冷色区分）。
  const FX_LIFE_MS: Record<number, number> = {1: 550, 2: 320, 3: 380, 4: 220};
  let ripple: {x: number; y: number; kind: number; q: number; right: boolean} | null = null;
  if (clickEffect >= 1 && clickState?.click) {
    const lifeMs = FX_LIFE_MS[clickEffect] ?? 550;
    const dtMs = globalMs - clickState.click.t;
    if (dtMs >= 0 && dtMs < lifeMs) {
      ripple = {
        x: planeW / 2 + cam.scale * (clickState.click.x - videoW / 2) + cam.translateX,
        y: planeH / 2 + cam.scale * (clickState.click.y - videoH / 2) + cam.translateY,
        kind: clickEffect,
        q: dtMs / lifeMs,
        right: clickState.click.button === 2,
      };
    }
  }

  // 光标/事件锚点（= 轨迹原始注视点的平面内位置；相机钳位时会自然偏离平面中心）。
  // showCursor 关时事件视觉（滚轮箭头/打字气泡）仍锚定此处。
  const anchorPos = rawFocus
    ? {
        x: planeW / 2 + cam.scale * (rawFocus.cx - videoW / 2) + cam.translateX,
        y: planeH / 2 + cam.scale * (rawFocus.cy - videoH / 2) + cam.translateY,
      }
    : null;
  const cursorPos = showCursor ? anchorPos : null;
  // 光标在相机 transform 之外，不随 zoom 缩放 → 屏幕上恒定尺寸
  const cursorSize = 30 * (canvasW / 1920) * cursorScale;
  // 光标拖尾倾斜（B1）：基于原始轨迹的因果速度（媒体域计算，与画框缩放无关）
  const cursorLean =
    showCursor && points
      ? cursorLeanDeg({points, mediaMs: globalMs, vh: videoH, leanTier: cursorLeanTier})
      : 0;
  // 按住态（声明式 drag/down-up）：光标收缩 + 尖端环（真实录屏轨迹恒 false）
  const pressed = cursorPressState(points, globalMs);

  // 声明式动作事件：滚轮箭头（active 期内两枚错相位人字纹随方向漂移淡出）与
  // 打字气泡（文本随进度逐字出现 + 光标块闪烁，头尾 150ms 淡入淡出）
  const events = video?.cursorEvents;
  const activeScrolls = events && anchorPos
    ? events
        .filter((e) => e.kind === 'scroll' && globalMs >= e.t && globalMs < e.t + e.durMs)
        .map((e) => ({e, q: (globalMs - e.t) / Math.max(1, e.durMs)}))
    : [];
  let activeType: {e: NonNullable<typeof events>[number]; q: number; opacity: number} | null = null;
  if (events && anchorPos) {
    const FADE_MS = 150;
    for (const e of events) {
      if (e.kind !== 'type') continue;
      if (globalMs < e.t - FADE_MS || globalMs > e.t + e.durMs + FADE_MS) continue;
      const dt = globalMs - e.t;
      const fadeIn = Math.min(1, Math.max(0, (dt + FADE_MS) / FADE_MS));
      const fadeOut = Math.min(1, Math.max(0, (e.t + e.durMs + FADE_MS - globalMs) / FADE_MS));
      activeType = {e, q: Math.min(1, Math.max(0, dt / Math.max(1, e.durMs))), opacity: Math.min(fadeIn, fadeOut)};
      break;
    }
  }

  // 点击目标高亮描边（1.6）：包络在共享层，位置经相机映射、尺寸随相机缩放
  const highlight =
    highlightOn && video
      ? clickHighlightState(clicks, globalMs, videoW, videoH)
      : null;

  return (
    <AbsoluteFill style={{opacity}}>
      {stageAmbientOn && cardMode && video ? (
        // 舞台环境虚化（v9 竖版反馈「背景色不一致」）：背景=录屏自身 cover+blur+压暗——
        // 留边永远与内容同源同色，不同段/不同 UI 之间不再出现舞台取色割裂。
        // scale(1.12) 盖住 blur 在自身边缘的透明衰减；亮度 0.55 保证卡面主体对比
        <AbsoluteFill style={{overflow: 'hidden'}}>
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            muted
            startFrom={Math.round((video.trimStart || 0) * FPS)}
            endSec={clipEndSec(video)}
            cutsSec={video.cuts}
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              filter: 'blur(46px) brightness(0.55) saturate(1.15)', transform: 'scale(1.12)',
            }}
          />
        </AbsoluteFill>
      ) : style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : stageBackgroundCss(stageBgMode, stagePaletteIdx) ? (
        <AbsoluteFill style={{background: stageBackgroundCss(stageBgMode, stagePaletteIdx)!}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {video && (
        <AbsoluteFill style={is3D ? {perspective: perspPx} : undefined}>
          {/* 视频平面：中心锚定画布中心；3D 模式下按 tiltPad 放大后倾斜（投影仍覆盖画布），
              圆角 + 阴影画框；正面模式 = 满画布；窗口卡模式恒为圆角卡 */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: planeW,
              height: planeH,
              overflow: 'hidden',
              background: '#000',
              transform: `translate(-50%, -50%)${is3D ? ` rotateX(${tiltXNow}deg) rotateY(${tiltYNow}deg) rotateZ(${tiltZNow}deg)` : ''}`,
              borderRadius: cardMode ? STAGE_CARD_RADIUS : is3D ? FRAME_RADIUS : 0,
              boxShadow: cardMode
                ? stageCardMode >= 2
                  ? `${STAGE_CARD_SHADOW}, ${stageCardGlowShadow(stagePaletteIdx)}`
                  : STAGE_CARD_SHADOW
                : is3D
                  ? FRAME_SHADOW
                  : 'none',
              ...(cardMode ? {border: stageCardBorder(stagePaletteIdx)} : {}),
            }}
          >
            {/* 相机层：视频中心锚定平面中心，translate + scale 跟随注视点 */}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: videoW,
                height: videoH,
                transform: `translate(-50%, -50%) translate(${cam.translateX}px, ${cam.translateY}px) scale(${cam.scale})`,
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
            {/* 聚焦蒙版（D 项）：点击包络激活时四周虚化+压暗、锚点周围保持清晰——
                backdrop-filter 作用于相机层已变换的画面（单视频零双解码），mask 挖空
                （横向椭圆：文字行/输入框是横向内容）；透明度 = 包络弹簧进度。
                focusDimTarget=1 时锚点跟随当前轨迹注视点（打字/悬停场景内容不在点击点处） */}
            {(() => {
              const mask = focusMaskState(
                focusDim,
                clickState ?? {amount: 0, focus: null, boost: 1, click: null},
                cam,
                videoW,
                videoH,
                planeW,
                planeH,
                rawFocus ? {x: rawFocus.cx, y: rawFocus.cy} : null,
              );
              if (!mask) return null;
              // 聚焦浮出（B1，随变临摹复盘「侧边栏浮出·其余模糊隐去」）：交付形态从
              // 「挖洞」换为「上浮」——底层整幅虚化压暗（与挖洞版同款 bleed 副本结构，
              // 无 mask 即全幅），清晰区裁成独立圆角卡层（投影+弹簧上浮）叠回原位：
              // 卡内是与底层相机同参的副本（平面屏幕左上角对齐），卡窗即原位像素，
              // 观感=该区域从画面里被拿起来。条带形状 → 全宽条带卡。
              // 代价：三路解码（底层/模糊副本/浮卡副本，hoverCard 激活时已是三路先例）
              if (focusPopOn) {
                const bleed = Math.ceil(mask.blur) + 2;
                const rx = mask.r * mask.aspect;
                const isBand = mask.shape === 'band';
                const pad = 1.12;
                const popW = Math.min(isBand ? planeW - 2 * Math.max(8, planeW * 0.012) : rx * 2 * pad, planeW - 16);
                const popH = Math.min(mask.r * 2 * (isBand ? 1.18 : pad), planeH - 16);
                const margin = Math.max(8, planeH * 0.012);
                const cardLeft = Math.min(Math.max(mask.cx - popW / 2, margin), Math.max(margin, planeW - popW - margin));
                const cardTop = Math.min(Math.max(mask.cy - popH / 2, margin), Math.max(margin, planeH - popH - margin));
                // 平面屏幕左上角（卡内副本对齐基准：副本与底层相机同参 → 卡窗=原位像素）
                const planeLeft = planeW / 2 + cam.translateX - (videoW * cam.scale) / 2;
                const planeTop = planeH / 2 + cam.translateY - (videoH * cam.scale) / 2;
                // 入场=包络弹簧进度：缩放/上浮同源，springProgress 再压一次弹簧出轻微过冲
                const popQ = springProgress(Math.min(1, Math.max(0, mask.opacity)));
                const u = canvasW / 1920;
                const lift = -14 * popQ * u;
                return (
                  <>
                    <div
                      style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        width: videoW + bleed * 2,
                        height: videoH + bleed * 2,
                        transform: `translate(-50%, -50%) translate(${cam.translateX}px, ${cam.translateY}px) scale(${cam.scale})`,
                        filter: `blur(${mask.blur}px) brightness(${(1 - mask.dark).toFixed(3)}) saturate(0.9)`,
                        opacity: mask.opacity,
                        pointerEvents: 'none',
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
                    <div
                      className="cf-focus-pop"
                      style={{
                        position: 'absolute',
                        left: cardLeft,
                        top: cardTop,
                        width: popW,
                        height: popH,
                        overflow: 'hidden',
                        borderRadius: Math.min(16, popH * 0.12),
                        border: '1px solid rgba(255, 255, 255, 0.18)',
                        boxShadow: '0 26px 60px -14px rgba(0, 0, 0, 0.55)',
                        transform: `translateY(${lift}px) scale(${(0.92 + 0.08 * popQ).toFixed(4)})`,
                        opacity: mask.opacity,
                        pointerEvents: 'none',
                        zIndex: 2,
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          left: planeLeft - cardLeft,
                          top: planeTop - cardTop,
                          width: videoW,
                          height: videoH,
                          transform: `scale(${cam.scale})`,
                          transformOrigin: '0 0',
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
                  </>
                );
              }
              // 条带模式（D5，DogSC linear 形状）：全宽角度清晰带（代码行/表格/时间轴横条场景）。
              // 实现：1.5× 平面的 oversize 层绕带中心旋转（盖住旋转露角），gradient 中线=带中心
              if (mask.shape === 'band') {
                const W = planeW * 1.5;
                const H = planeH * 1.5;
                const bandMask = `linear-gradient(to bottom, black calc(50% - ${mask.r * 1.28}px), transparent calc(50% - ${mask.r * 0.72}px), transparent calc(50% + ${mask.r * 0.72}px), black calc(50% + ${mask.r * 1.28}px))`;
                return (
                  <div
                    className="cf-focus-mask"
                    style={{
                      position: 'absolute',
                      left: mask.cx - W / 2,
                      top: mask.cy - H / 2,
                      width: W,
                      height: H,
                      transform: `rotate(${mask.angleDeg}deg)`,
                      transformOrigin: 'center',
                      backdropFilter: `blur(${mask.blur}px) brightness(${(1 - mask.dark).toFixed(3)})`,
                      WebkitBackdropFilter: `blur(${mask.blur}px) brightness(${(1 - mask.dark).toFixed(3)})`,
                      maskImage: bandMask,
                      WebkitMaskImage: bandMask,
                      opacity: mask.opacity,
                      pointerEvents: 'none',
                    }}
                  />
                );
              }
              const rx = mask.r * mask.aspect;
              // 模糊副本层（v9 实证修复，对照实验 smoke_test/focus-mask-css-test.html）：
              // chromium 里 backdrop-filter 不吃同元素 maskImage（V1 激活即整帧糊——本模板
              // 上线以来真实渲染从未有过清晰区），mask 挂 masked 父层又让 backdrop 采样整个
              // 失效（V2 全锐利）；普通 filter 副本 + mask 挖洞可行（V4 pass）。副本外扩
              // bleed：filter blur 在自身边缘采样出透明衰减，不外扩会在平面四边露 sharp 亮边。
              // 洞心/半径从平面坐标逆映射到副本局部坐标（= 视频像素 ÷ cam.scale）。
              // 条带分支（上方）仍是 backdrop 旧机制=同样不挖洞，待同款改造
              const bleed = Math.ceil(mask.blur) + 2;
              const ix = videoW / 2 + (mask.cx - planeW / 2 - cam.translateX) / cam.scale;
              const iy = videoH / 2 + (mask.cy - planeH / 2 - cam.translateY) / cam.scale;
              const radial = `radial-gradient(ellipse ${rx / cam.scale}px ${mask.r / cam.scale}px at ${ix + bleed}px ${iy + bleed}px, transparent ${(mask.r * 0.72) / cam.scale}px, black ${(mask.r * 1.28) / cam.scale}px)`;
              return (
                <div
                  className="cf-focus-mask"
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: videoW + bleed * 2,
                    height: videoH + bleed * 2,
                    transform: `translate(-50%, -50%) translate(${cam.translateX}px, ${cam.translateY}px) scale(${cam.scale})`,
                    filter: `blur(${mask.blur}px) brightness(${(1 - mask.dark).toFixed(3)})`,
                    maskImage: radial,
                    WebkitMaskImage: radial,
                    opacity: mask.opacity,
                    pointerEvents: 'none',
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
              );
            })()}
            {/* 点击波纹：点击位置扩散圆环（相机层之外，恒定屏幕尺寸） */}
            {/* 点击效果四式（B2，DogSC CursorClickEffectStyle）：相机层之外随相机映射。
                1 涟漪=扩散圆环（原状）/ 2 光晕=柔光球淡出 / 3 双环=内环弹簧扩张+外环滞后跟随
                / 4 微闪=亮核收缩急闪。尺寸按画布宽归一（与光标同基准） */}
            {ripple && (() => {
              const u = canvasW / 1920;
              // 右键换暖橙色调（与左键白/冷蓝区分，四式同规则）
              const cMain = ripple.right ? '255,186,84' : '255,255,255';
              const cSoft = ripple.right ? '255,140,60' : '160,200,255';
              if (ripple.kind === 2) {
                // 光晕：柔光球快速淡出（320ms）
                const r = 38 * u;
                return (
                  <div
                    style={{
                      position: 'absolute',
                      left: ripple.x - r,
                      top: ripple.y - r,
                      width: r * 2,
                      height: r * 2,
                      borderRadius: '50%',
                      background: `radial-gradient(circle, rgba(${cMain},${0.5 * (1 - ripple.q)}) 0%, rgba(${cSoft},${0.3 * (1 - ripple.q)}) 45%, transparent 72%)`,
                      pointerEvents: 'none',
                    }}
                  />
                );
              }
              if (ripple.kind === 3) {
                // 弹性双环：内环弹簧扩张（带过冲），外环滞后 12% 进度跟随
                const sq = springProgress(ripple.q);
                const r1 = (12 + 30 * sq) * u;
                const q2 = ripple.q - 0.12;
                const ring2 = q2 >= 0 ? (12 + 30 * springProgress(q2)) * u : 0;
                return (
                  <>
                    <div
                      style={{
                        position: 'absolute',
                        left: ripple.x - r1,
                        top: ripple.y - r1,
                        width: r1 * 2,
                        height: r1 * 2,
                        borderRadius: '50%',
                        border: `${Math.max(2, 3 * u)}px solid rgba(${cMain},${0.85 * (1 - ripple.q)})`,
                        pointerEvents: 'none',
                      }}
                    />
                    {ring2 > 0 && (
                      <div
                        style={{
                          position: 'absolute',
                          left: ripple.x - ring2,
                          top: ripple.y - ring2,
                          width: ring2 * 2,
                          height: ring2 * 2,
                          borderRadius: '50%',
                          border: `${Math.max(2, 2.5 * u)}px solid rgba(${cMain},${0.4 * (1 - q2)})`,
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                  </>
                );
              }
              if (ripple.kind === 4) {
                // 微闪：亮核收缩急闪（220ms）+ 短促辉光
                const r = (26 - 15 * ripple.q) * u;
                return (
                  <div
                    style={{
                      position: 'absolute',
                      left: ripple.x - r,
                      top: ripple.y - r,
                      width: r * 2,
                      height: r * 2,
                      borderRadius: '50%',
                      background: `rgba(${cMain},${0.9 * (1 - ripple.q)})`,
                      boxShadow: `0 0 ${Math.round(20 * u * (1 - ripple.q))}px rgba(${cSoft},${0.9 * (1 - ripple.q)})`,
                      pointerEvents: 'none',
                    }}
                  />
                );
              }
              // 1 涟漪（默认，原状公式）
              const radius = (10 + 46 * ripple.q) * u;
              const alpha = 0.8 * (1 - ripple.q);
              return (
                <div
                  style={{
                    position: 'absolute',
                    left: ripple.x - radius,
                    top: ripple.y - radius,
                    width: radius * 2,
                    height: radius * 2,
                    borderRadius: '50%',
                    border: `${Math.max(2, 3 * (canvasW / 1920))}px solid rgba(${cMain}, ${alpha})`,
                    boxShadow: `0 0 ${Math.round(12 * (canvasW / 1920))}px rgba(${cMain}, ${alpha * 0.6})`,
                    pointerEvents: 'none',
                  }}
                />
              );
            })()}
            {/* 点击目标高亮描边：点击点为中心的圆角矩形（相机层之外，随相机映射） */}
            {highlight && (
              <div
                style={{
                  position: 'absolute',
                  left:
                    planeW / 2 + cam.scale * (highlight.cx - videoW / 2) + cam.translateX -
                    (highlight.w * cam.scale) / 2,
                  top:
                    planeH / 2 + cam.scale * (highlight.cy - videoH / 2) + cam.translateY -
                    (highlight.h * cam.scale) / 2,
                  width: highlight.w * cam.scale,
                  height: highlight.h * cam.scale,
                  borderRadius: Math.min(highlight.h * cam.scale * 0.3, 16),
                  border: `${Math.max(2, canvasW * 0.0016)}px solid rgba(255, 255, 255, 0.92)`,
                  boxShadow: '0 0 18px rgba(124, 156, 255, 0.55), inset 0 0 12px rgba(255, 255, 255, 0.12)',
                  background: 'rgba(8, 12, 28, 0.18)',
                  opacity: highlight.opacity,
                  pointerEvents: 'none',
                }}
              />
            )}
            {/* 悬停浮卡（一.2）：指针驻留 ≥550ms 处就地生长的区域放大卡（卡内独立相机
                对准驻留点更高倍）；指针移开 250ms 收场；点击运镜激活时让位隐藏。
                卡内不放光标（ScreenDemo 实锤：放大镜几何让光标「飞走又飞回」） */}
            {hoverCard && (() => {
              const CARD_W = Math.min(planeW * 0.42, videoW * 0.5);
              const CARD_H = CARD_W * (videoH / videoW) * 0.72;
              const anchorX = planeW / 2 + cam.scale * (hoverCard.cx - videoW / 2) + cam.translateX;
              const anchorY = planeH / 2 + cam.scale * (hoverCard.cy - videoH / 2) + cam.translateY;
              const margin = Math.max(10, planeH * 0.015);
              const cardLeft = Math.min(Math.max(anchorX - CARD_W / 2, margin), Math.max(margin, planeW - CARD_W - margin));
              const cardTop = Math.min(Math.max(anchorY - CARD_H / 2, margin), Math.max(margin, planeH - CARD_H - margin));
              // 卡内独立相机：卡窗内以驻留点为中心的 hoverCardZoom 倍放大视图
              const cardCam = cameraFrame(hoverCard.cx, hoverCard.cy, videoW, videoH, hoverCardZoom, CARD_W, CARD_H);
              return (
                <div
                  className="cf-hover-card"
                  style={{
                    position: 'absolute',
                    left: cardLeft,
                    top: cardTop,
                    width: CARD_W,
                    height: CARD_H,
                    overflow: 'hidden',
                    borderRadius: 12,
                    border: '1px solid rgba(255, 255, 255, 0.16)',
                    boxShadow: '0 18px 44px -12px rgba(0, 0, 0, 0.55)',
                    transform: `scale(${hoverCard.scale})`,
                    transformOrigin: `${anchorX - cardLeft}px ${anchorY - cardTop}px`,
                    opacity: hoverCard.opacity,
                    pointerEvents: 'none',
                    zIndex: 3,
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
            {/* 合成光标：相机层之外（恒定屏幕尺寸），3D 模式下随平面一起倾斜；
                拖尾倾斜绕尖端 (1,1)/24 旋转（B1）；按住态（drag/down-up）收缩 15% + 尖端环 */}
            {cursorPos && (
              <svg
                width={cursorSize}
                height={cursorSize}
                viewBox="0 0 24 24"
                style={{
                  position: 'absolute',
                  left: cursorPos.x,
                  top: cursorPos.y,
                  overflow: 'visible',
                  filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))',
                  transform: `rotate(${cursorLean}deg) scale(${pressed ? 0.85 : 1})`,
                  transformOrigin: '4.17% 4.17%',
                  pointerEvents: 'none',
                }}
              >
                <path
                  d="M1 1 L1 16.5 L5.6 12.9 L8.6 19.6 L11.2 18.3 L8.2 11.7 L14 11.7 Z"
                  fill="#FFFFFF"
                  stroke="#111827"
                  strokeWidth={1.2}
                  strokeLinejoin="round"
                />
                {pressed && (
                  <circle cx={9} cy={9} r={8.4} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={1.4} />
                )}
              </svg>
            )}
            {/* 滚轮人字纹（scroll 事件）：光标右侧两枚错相位人字纹，随滚动方向漂移淡出 */}
            {anchorPos && activeScrolls.map(({e, q}, k) => {
              const u = canvasW / 1920;
              const dir = (e.ticks ?? 1) > 0 ? 1 : -1; // 正 = 向下滚 → 人字纹向下漂
              return (
                <React.Fragment key={`cf-scroll-${e.t}-${k}`}>
                  {[0, 0.28].map((ph, j) => {
                    const q2 = q - ph;
                    if (q2 <= 0 || q2 >= 1) return null;
                    return (
                      <svg
                        key={j}
                        width={15 * u}
                        height={15 * u}
                        viewBox="0 0 16 16"
                        style={{
                          position: 'absolute',
                          left: anchorPos.x + cursorSize * 0.62,
                          top: anchorPos.y + (dir > 0 ? -6 * u : 20 * u) + dir * q2 * 20 * u - j * 11 * u * dir,
                          opacity: 0.85 * (1 - q2),
                          pointerEvents: 'none',
                        }}
                      >
                        <path
                          d={dir > 0 ? 'M3.2 6.2 L8 11.6 L12.8 6.2' : 'M3.2 9.8 L8 4.4 L12.8 9.8'}
                          fill="none"
                          stroke="rgba(255,255,255,0.92)"
                          strokeWidth={2.6}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    );
                  })}
                </React.Fragment>
              );
            })}
            {/* 打字气泡（type 事件）：光标右上角深底等宽气泡，文本逐字出现 + 光标块闪烁 */}
            {anchorPos && activeType && (() => {
              const u = canvasW / 1920;
              const text = activeType.e.text ?? '';
              const shown = text.slice(0, Math.ceil(activeType.q * text.length));
              const done = activeType.q >= 1;
              const fs = 17 * u;
              const estW = Math.max(54 * u, fs * 0.72 * text.length + 24 * u);
              const left = Math.min(Math.max(anchorPos.x + 32 * u, 8), Math.max(8, planeW - estW - 8));
              const top = Math.max(anchorPos.y - 20 * u - fs - 16 * u, 8);
              const caretOn = !done ? frame % 12 < 6 : frame % 26 < 13;
              return (
                <div
                  className="cf-type-bubble"
                  style={{
                    position: 'absolute',
                    left,
                    top,
                    opacity: activeType.opacity,
                    background: 'rgba(10, 14, 24, 0.88)',
                    border: '1px solid rgba(255, 255, 255, 0.18)',
                    borderRadius: 8 * u,
                    padding: `${7 * u}px ${10 * u}px`,
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: fs,
                    lineHeight: 1.35,
                    color: '#f4f7ff',
                    whiteSpace: 'nowrap',
                    letterSpacing: '0.02em',
                    pointerEvents: 'none',
                    zIndex: 4,
                  }}
                >
                  {shown}
                  <span style={{opacity: done ? 0.35 : 0.9, color: done ? '#8fa3c8' : '#7cb0ff'}}>{caretOn ? '▍' : '\u00a0'}</span>
                </div>
              );
            })()}
          </div>
        </AbsoluteFill>
      )}

      {/* 文字层：底部标题/副标题。半透明暗衬底——文字直接压在满屏录屏上，
          亮色 UI 面板上细白字+弱投影=虚影（与 ScreenDemo 同修，v9 hero 终审实锤）。
          M2 冻结接管：窗由物化层治理（序 = 投影序 [title?, subtitle?]），无覆盖层 = 模板默认
          全程窗（零漂移）；入场动画随窗起点平移，窗尾 6 帧淡出（与 CaptionLayer 行为一致） */}
      {(() => {
        // 窗包络：1 = 全亮；0 = 窗外；边缘 6 帧线性过渡
        const env = (w: {startSec: number; endSec: number} | undefined): number => {
          if (!w) return 1;
          const s = Math.round(w.startSec * fps);
          const e = Math.round(w.endSec * fps);
          if (frame < s || frame >= e) return 0;
          return Math.min(1, (frame - s) / 6, (e - frame) / 6);
        };
        const titleWin = planCaptionWindows?.[0];
        const subWin = planCaptionWindows?.[1];
        const titleEnv = env(titleWin);
        if (text.title && titleEnv <= 0) return null;
        const shift = (w: {startSec: number} | undefined, base: number): number =>
          w ? Math.round(w.startSec * fps) + base : base;
        return text.title ? (
          <div style={{position: 'absolute', bottom: canvasH * 0.08, left: 0, right: 0, textAlign: 'center', opacity: titleEnv}}>
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
                startFrame={shift(titleWin, 15)}
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
                <div style={{marginTop: 8, opacity: env(subWin)}}>
                  <AnimatedText
                    text={text.subtitle}
                    preset={textAnim ?? 'fadeIn'}
                    startFrame={shift(subWin, 28)}
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
        ) : null;
      })()}
    </AbsoluteFill>
  );
};

export default CursorFollow;
