/**
 * 模板 15: DeviceShowcase - 设备悬浮展示
 *
 * 把录屏/截图装进笔记本或手机壳里悬浮展示（ScreenStudio/Rotato 级质感）：
 * - 设备壳：纯 CSS 渐变/圆角/阴影绘制（无素材文件，分辨率无关），笔记本含边框、
 *   摄像头点、梯形底座；手机含边框、灵动岛、侧键
 * - 呼吸浮动：缓慢 translateY 起伏 + 轻微 rotateZ 摇摆，投影随浮动反向收放（悬浮感）
 * - 柔和投影：设备下方独立椭圆渐变阴影（比 boxShadow 更像"悬在空中"）
 * - 设备类型自动判断：竖屏素材 → 手机壳，横屏素材 → 笔记本壳（参数页可强制）
 *
 * 个性化参数（DEVICE_SHOWCASE_PARAMS）：device 设备类型 / deviceScale 设备大小 /
 * floatAmp 悬浮幅度 / tiltX 3D 倾斜角。
 * 素材适配与 Video3D 同一套几何（fitVideo + applyViewport：cover/contain + 取景视口）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {easeOutCubic} from '../utils/ink';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {DEVICE_SHOWCASE_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const DeviceShowcase: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.round((segmentDuration || 8) * FPS);

  const p = makeParamReader(DEVICE_SHOWCASE_PARAMS, params);
  const deviceMode = Math.round(p('device')); // 0=自动 1=笔记本 2=手机
  const deviceScale = p('deviceScale');
  const floatAmp = p('floatAmp');
  const tiltX = p('tiltX');

  const video = videos[0];
  // 自动判断：竖屏素材（或竖版画幅无素材）→ 手机；否则笔记本
  const isPhone =
    deviceMode === 2 ||
    (deviceMode === 0 && (video ? video.height > video.width : orientation === 'portrait'));

  // ====== 设备几何（宽受画布宽、高双重约束，竖版画幅也不溢出）======
  const shellW = isPhone
    ? Math.min(canvasW * 0.34, (canvasH * 0.58) / 2.05) * deviceScale
    : Math.min(canvasW * 0.62, (canvasH * 0.6) / 0.72) * deviceScale;
  const screenAspect = isPhone ? 9 / 19.5 : 16 / 10;
  const bezel = shellW * (isPhone ? 0.035 : 0.028);
  const screenW = shellW - bezel * 2;
  const screenH = screenW / screenAspect;
  const shellH = screenH + bezel * 2;
  const baseH = isPhone ? 0 : shellW * 0.034; // 笔记本底座高
  const deviceH = shellH + baseH;

  // ====== 运动：入场沉降 + 呼吸浮动 ======
  const entrance = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easeOutCubic,
  });
  const tSec = frame / FPS;
  const floatY = Math.sin(tSec * ((2 * Math.PI) / 3.4)) * canvasH * 0.009 * floatAmp;
  const swayZ = Math.sin(tSec * ((2 * Math.PI) / 4.7) + 1.2) * 0.5 * floatAmp;
  const enterY = (1 - entrance) * canvasH * 0.03;
  const enterScale = 0.92 + 0.08 * entrance;

  const deviceX = (canvasW - shellW) / 2;
  const deviceY = canvasH * (isPhone ? 0.24 : 0.22) + (canvasH * 0.62 - deviceH) / 2 + floatY + enterY;

  // 投影随浮动反向收放（浮起时影子缩小变淡 → 悬浮感）
  const floatNorm = floatAmp > 0 ? floatY / (canvasH * 0.009 * floatAmp) : 0; // -1..1
  const shadowScale = 1 - floatNorm * 0.05;
  const shadowOpacity = 0.38 - floatNorm * 0.06;

  // ====== 屏幕内素材几何（与 Video3D 同一套 fit/viewport 逻辑）======
  const fitMode = video?.fit ?? 'cover'; // 设备屏幕默认铺满（杂志感）
  const placed = video
    ? applyViewport(
        screenW,
        screenH,
        fitVideo(screenW, screenH, video.width, video.height, fitMode),
        fitMode,
        video.viewport,
      )
    : null;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 标题区（顶部，深色背景默认白字） */}
      {text.title && (
        <div style={{position: 'absolute', top: canvasH * 0.07, left: 0, right: 0, textAlign: 'center', zIndex: 2}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={6}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.72,
              fontWeight: style?.title?.fontWeight ?? 600,
              color: style?.title?.color ?? '#FFFFFF',
              letterSpacing: '0.02em',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
          {text.subtitle && (
            <div style={{marginTop: 12}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={14}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: style?.subtitle?.color ?? 'rgba(255,255,255,0.72)',
                  letterSpacing: '0.06em',
                  ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                  ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* 地面投影（独立椭圆渐变，随呼吸反向收放） */}
      <div
        style={{
          position: 'absolute',
          left: deviceX + shellW * 0.12,
          top: deviceY + deviceH + canvasH * 0.015,
          width: shellW * 0.76 * shadowScale,
          height: shellW * 0.05,
          marginLeft: (shellW * 0.76 * (1 - shadowScale)) / 2,
          background: `radial-gradient(ellipse 50% 50% at 50% 50%, rgba(0,0,0,${shadowOpacity}) 0%, transparent 70%)`,
          opacity: entrance,
          pointerEvents: 'none',
        }}
      />

      {/* 设备（3D 倾斜 + 呼吸浮动 + 入场沉降） */}
      <div
        style={{
          position: 'absolute',
          left: deviceX,
          top: deviceY,
          width: shellW,
          height: deviceH,
          perspective: '1400px',
          opacity: entrance,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            transform: `rotateX(${tiltX}deg) rotateZ(${swayZ}deg) scale(${enterScale})`,
            transformStyle: 'preserve-3d',
          }}
        >
          {/* 屏幕壳体 */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: shellW,
              height: shellH,
              borderRadius: shellW * (isPhone ? 0.14 : 0.022),
              background: 'linear-gradient(160deg, #2C2C33 0%, #121216 100%)',
              boxShadow: `0 ${shellW * 0.02}px ${shellW * 0.06}px rgba(0,0,0,0.45), inset 0 1px 1px rgba(255,255,255,0.18)`,
            }}
          >
            {/* 屏幕（素材区） */}
            <div
              style={{
                position: 'absolute',
                left: bezel,
                top: bezel,
                width: screenW,
                height: screenH,
                borderRadius: shellW * (isPhone ? 0.11 : 0.008),
                overflow: 'hidden',
                background: '#000',
              }}
            >
              {video && placed && (
                <ClipMedia
                  src={video.src}
                  mediaType={video.type}
                  startFrom={Math.round((video.trimStart || 0) * FPS)}
                  endSec={clipEndSec(video)}
                  cutsSec={video.cuts}
                  muted={video.muted}
                  volume={video.volume}
                  style={{
                    width: placed.width,
                    height: placed.height,
                    transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
                    objectFit: fitMode,
                  }}
                />
              )}
              {/* 屏幕反光（斜向柔光带，玻璃感） */}
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background:
                    'linear-gradient(115deg, rgba(255,255,255,0.10) 0%, transparent 28%, transparent 72%, rgba(255,255,255,0.05) 100%)',
                  pointerEvents: 'none',
                }}
              />
              {/* 手机灵动岛 */}
              {isPhone && (
                <div
                  style={{
                    position: 'absolute',
                    top: screenH * 0.014,
                    left: (screenW - screenW * 0.26) / 2,
                    width: screenW * 0.26,
                    height: screenH * 0.024,
                    borderRadius: screenH * 0.012,
                    background: '#000',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.06)',
                  }}
                />
              )}
            </div>
            {/* 笔记本摄像头点 */}
            {!isPhone && (
              <div
                style={{
                  position: 'absolute',
                  top: bezel * 0.28,
                  left: (shellW - bezel * 0.34) / 2,
                  width: bezel * 0.34,
                  height: bezel * 0.34,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 40% 35%, #3A3F4A 0%, #0A0A0D 70%)',
                }}
              />
            )}
            {/* 手机侧键 */}
            {isPhone && (
              <>
                <div style={{position: 'absolute', left: -shellW * 0.008, top: shellH * 0.2, width: shellW * 0.008, height: shellH * 0.055, borderRadius: 2, background: '#3A3A41'}} />
                <div style={{position: 'absolute', left: -shellW * 0.008, top: shellH * 0.28, width: shellW * 0.008, height: shellH * 0.085, borderRadius: 2, background: '#3A3A41'}} />
                <div style={{position: 'absolute', right: -shellW * 0.008, top: shellH * 0.24, width: shellW * 0.008, height: shellH * 0.1, borderRadius: 2, background: '#3A3A41'}} />
              </>
            )}
          </div>

          {/* 笔记本底座（梯形前扩 + 开盖凹槽） */}
          {!isPhone && (
            <div
              style={{
                position: 'absolute',
                left: -shellW * 0.08,
                top: shellH,
                width: shellW * 1.16,
                height: baseH,
                clipPath: 'polygon(0% 0%, 100% 0%, 96.8% 100%, 3.2% 100%)',
                background: 'linear-gradient(to bottom, #C9CCD4 0%, #9A9EA9 55%, #6E7280 100%)',
                boxShadow: `0 ${baseH * 0.6}px ${baseH * 1.2}px rgba(0,0,0,0.35)`,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: '44%',
                  top: 0,
                  width: '12%',
                  height: '38%',
                  borderRadius: '0 0 6px 6px',
                  background: 'rgba(0,0,0,0.22)',
                }}
              />
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default DeviceShowcase;
