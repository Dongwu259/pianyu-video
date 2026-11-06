/**
 * 模板 36: DeviceShowcase3D - 真 3D 设备悬浮展示（three.js WebGL）
 *
 * DeviceShowcase 的 WebGL 升级版：真实光照/环境反射/地面接触影/相机运镜，
 * 录屏以帧精确视频纹理贴上设备屏幕（@remotion/media onVideoFrame → CanvasTexture，
 * 渲染期自动回退 ffmpeg 抽帧，无黑帧——与 OffthreadVideo 同一哲学）。
 *
 * - 设备壳：参数化几何体（deviceGeometry.tsx，无外部模型文件，分辨率无关）
 * - 运镜：CameraRig 四档（固定/环绕/推轨/摇臂），帧驱动确定性插值
 * - 氛围：ThreeAmbience 粒子/光锥/雾（0-3 档）
 * - 音频：隐藏 ClipMedia 承担（纹理路径不出声），与现有音轨管线一致
 *
 * 个性化参数（DEVICE_SHOWCASE_3D_PARAMS）：device 设备类型 / deviceScale 设备大小 /
 * cameraRig 运镜 / rigSpeed 运镜幅度 / ambience 氛围 / floatAmp 悬浮幅度。
 *
 * v1 限制：屏幕纹理只支持 trimStart/trimEnd 窗口（挖段 cuts 与取景 viewport
 * 不作用于纹理，有挖段需求的片段请用 CSS 版 DeviceShowcase）。
 */

import * as THREE from 'three';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ThreeStage} from '../three/ThreeStage';
import {useVideoScreenTexture} from '../three/VideoScreenTexture';
import {PhoneShell, LaptopShell, DEVICE_SCREEN} from '../three/deviceGeometry';
import type {CameraRigPreset} from '../three/CameraRig';
import {easeOutCubic} from '../utils/ink';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {FloatingMotes, GroundRipple, OrbitingDot} from '../three/scene-dress';
import {DEVICE_SHOWCASE_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

const RIG_PRESETS: CameraRigPreset[] = ['static', 'orbit', 'dolly', 'crane'];

export const DeviceShowcase3D: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  params,
  textAnim,
  brandColor,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.round((segmentDuration || 8) * FPS);

  const p = makeParamReader(DEVICE_SHOWCASE_3D_PARAMS, params);
  const deviceMode = Math.round(p('device')); // 0=自动 1=笔记本 2=手机
  const deviceScale = p('deviceScale');
  const rig = RIG_PRESETS[Math.round(p('cameraRig'))] ?? 'orbit';
  const rigSpeed = p('rigSpeed');
  const ambience = Math.round(p('ambience'));
  const floatAmp = p('floatAmp');
  const ambientFx = Math.min(2, Math.max(0, Math.round(p('ambientFx')))); // 动效包：0 关 / 1 标准 / 2 丰富
  const accent = brandColor || '#3B82F6';

  const video = videos[0];
  const isPhone =
    deviceMode === 2 ||
    (deviceMode === 0 && (video ? video.height > video.width : orientation === 'portrait'));
  const screen = isPhone ? DEVICE_SCREEN.phone : DEVICE_SCREEN.laptop;

  // ====== 运动：入场沉降 + 呼吸浮动（帧驱动，确定性）======
  const entrance = interpolate(frame, [0, 16], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: easeOutCubic,
  });
  const tSec = frame / FPS;
  const floatY = Math.sin(tSec * ((2 * Math.PI) / 3.4)) * 0.07 * floatAmp;
  const swayY = Math.sin(tSec * ((2 * Math.PI) / 5.1) + 0.8) * 0.05 * floatAmp;
  const enterY = (1 - entrance) * 0.55;
  const enterScale = 0.88 + 0.12 * entrance;

  const trimBeforeFrame = video ? Math.round((video.trimStart || 0) * FPS) : 0;
  const endSec = video ? clipEndSec(video) : undefined;
  const trimAfterFrame = endSec !== undefined ? Math.round(endSec * FPS) : undefined;

  // 屏幕视频纹理：DOM 侧挂解码源、three 侧贴纹理（架构见 VideoScreenTexture 头注）
  const vst = useVideoScreenTexture({
    src: video?.src,
    trimBeforeFrame,
    trimAfterFrame,
    videoWidth: video?.width ?? 16,
    videoHeight: video?.height ?? 9,
    planeWidth: screen.w,
    planeHeight: screen.h,
  });
  const screenMesh = video ? (
    <mesh>
      <planeGeometry args={[screen.w, screen.h]} />
      <meshBasicMaterial map={vst.texture} toneMapped={false} />
    </mesh>
  ) : null;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 3D 舞台（透明 canvas，DOM 背景透出） */}
      <ThreeStage
        rig={rig}
        rigSpeed={rigSpeed}
        ambience={ambience}
        totalFrames={totalFrames}
        radius={isPhone ? 6.4 : 7.8}
        targetY={isPhone ? 0 : 0.75}
        shadowY={isPhone ? -1.95 : -0.12}
      >
        <vst.Bridge />
        <group
          scale={deviceScale * enterScale}
          position={[0, (isPhone ? 0 : 0.55) + floatY - enterY, 0]}
          rotation={[0, swayY, 0]}
        >
          {isPhone ? (
            <PhoneShell>{screenMesh}</PhoneShell>
          ) : (
            <LaptopShell>{screenMesh}</LaptopShell>
          )}
        </group>
        {/* 动效包（v9「画面丰富」）：地面涟漪环（扩散渐隐）+ 漂浮微尘 + 丰富档加双轨道光点 */}
        {ambientFx >= 1 && (
          <GroundRipple y={(isPhone ? -1.95 : -0.12) + 0.015} color={accent} ws={1} maxR={isPhone ? 2.7 : 3.4} rate={2.6} count={ambientFx >= 2 ? 4 : 3} opacity={ambientFx >= 2 ? 0.55 : 0.4} />
        )}
        {ambientFx >= 1 && (
          <FloatingMotes count={ambientFx >= 2 ? 72 : 38} center={new THREE.Vector3(0, isPhone ? 0 : 0.6, 0)} spread={new THREE.Vector3(7, 4.2, 5)} ws={1} color={accent} opacity={0.3} size={0.05} speed={0.03} />
        )}
        {ambientFx >= 2 && (
          <>
            <OrbitingDot radius={isPhone ? 2.7 : 3.4} y={(isPhone ? 0 : 0.55) + 0.4} omega={0.5} phase={0.6} ws={1} color={accent} size={0.07} />
            <OrbitingDot radius={isPhone ? 2.7 : 3.4} y={(isPhone ? 0 : 0.55) - 0.3} omega={0.5} phase={0.6 + Math.PI} ws={1} color={accent} size={0.055} opacity={0.6} />
          </>
        )}
      </ThreeStage>

      {/* 标题区（DOM 叠加层，与 CSS 版同一套文字管线） */}
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

      {/* 屏幕纹理的 DOM 侧解码源（headless 不可见，见 VideoScreenTexture 头注） */}
      {vst.dom}

      {/* 隐藏 ClipMedia：只承担音频（3D 屏幕纹理是独立解码路径，不出声）。
          视觉完全由纹理呈现；无画面需求的静音素材也跳过以省一次解码。 */}
      {video && !video.muted && (
        <div style={{position: 'absolute', width: 2, height: 2, left: -10, top: -10, opacity: 0, pointerEvents: 'none', overflow: 'hidden'}}>
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            startFrom={trimBeforeFrame}
            endSec={endSec}
            cutsSec={video.cuts}
            volume={video.volume}
            style={{width: 2, height: 2}}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};
