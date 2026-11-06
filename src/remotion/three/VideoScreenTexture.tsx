/**
 * useVideoScreenTexture - 把视频素材作为 three.js 纹理（设备屏幕等）
 *
 * 双路径架构（两次踩坑后的定型方案）：
 *
 * 【渲染期】Remotion 渲染器自带的 OffthreadVideo 帧抽取（compositor ffmpeg）：
 * 与 ClipMedia 完全同一条 codec 链路（h264/vp9 都通），帧精确无黑帧。
 * 不选 @remotion/media 的 WebCodecs 路径：chrome-headless-shell 无专有解码器
 * （h264 解不动），其 WebCodecs 抽取会整帧挂起（delayRender 逐帧超时，真实踩过）。
 * 实现参考 @remotion/three 已废弃的 useOffthreadVideoTexture，额外支持
 * trimStart 偏移与 trimEnd 冻结，并逐帧 dispose 旧纹理防 VRAM 泄漏。
 *
 * 【预览期】@remotion/media 的 <Video headless onVideoFrame>（WebCodecs 实时解码，
 * Electron 有完整编解码器；需 videoServer 的 CORS 头，已加）：
 * **必须挂 DOM 树，不能进 R3F 子树**——其解码失败时的 OffthreadVideo 兜底会渲染
 * <Img>，R3F reconciler 不认识宿主标签，抛 "Img is not part of the THREE
 * namespace" 击穿合成（真实踩过的坑）。three 侧用 <Bridge/> 把 invalidate
 * 桥回 DOM 侧回调，纹理更新后触发重绘。
 *
 * cover 适配：源帧居中裁切到屏幕平面宽高比（设备屏幕铺满，无拉伸）。
 *
 * 用法：
 *   const vst = useVideoScreenTexture({src, trimBeforeFrame, trimAfterFrame, videoWidth, videoHeight, planeWidth, planeHeight});
 *   // three 场景内：<vst.Bridge /> + <mesh><planeGeometry/><meshBasicMaterial map={vst.texture}/></mesh>
 *   // DOM 层任意处：{vst.dom}（预览用；渲染期为空）
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import * as THREE from 'three';
import {useThree} from '@react-three/fiber';
import {Video} from '@remotion/media';
import {useCurrentFrame, useRemotionEnvironment, useVideoConfig, delayRender, continueRender, Sequence} from 'remotion';
import {NoReactInternals} from 'remotion/no-react';

/** 纹理画布最长边（限制显存上传量；屏幕展示足够清晰） */
const MAX_TEXTURE_DIM = 1600;

interface UseVideoScreenTextureOpts {
  /** 素材 http URL；undefined = 无素材（纹理保持黑场） */
  src?: string;
  /** 从素材第几帧开始（comp fps 帧号，= trimStartSec × FPS） */
  trimBeforeFrame?: number;
  /** 播到素材第几帧冻结（comp fps 帧号，= trimEndSec × FPS；缺省播到素材尾） */
  trimAfterFrame?: number;
  /** 播放起点帧（缺省 0）：媒体时间 = trimStart + (frame − frameOffset)/fps，
   *  帧号早于起点时冻结在 trimStart 首帧（CameraJourney3D 驻留窗口才开播用） */
  frameOffset?: number;
  /** 预览期解码源的挂载窗口（Sequence from/durationInFrames；缺省全程挂载）。
   *  与 frameOffset 配套：窗口内 Video 才挂载播放，窗口外纹理保持末帧 */
  previewWindow?: {from: number; durationInFrames: number};
  videoWidth: number;
  videoHeight: number;
  /** 屏幕平面尺寸（three 世界单位），cover 裁切比例依据 */
  planeWidth: number;
  planeHeight: number;
}

/** onVideoFrame/Image 回调来源兼容：VideoFrame（displayWidth）/ HTMLVideoElement（videoWidth）/ HTMLImageElement（naturalWidth）/ ImageBitmap（width） */
const frameDims = (vf: CanvasImageSource): {w: number; h: number} => {
  const anyVf = vf as {displayWidth?: number; displayHeight?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number};
  const w = anyVf.displayWidth ?? anyVf.videoWidth ?? anyVf.naturalWidth ?? anyVf.width ?? 0;
  const h = anyVf.displayHeight ?? anyVf.videoHeight ?? anyVf.naturalHeight ?? anyVf.height ?? 0;
  return {w: w || 16, h: h || 9};
};

export interface VideoScreenTextureApi {
  texture: THREE.CanvasTexture;
  /** 挂到模板 DOM 层（预览用解码源；渲染期为 null） */
  dom: React.ReactNode;
  /** 挂到 ThreeCanvas 子树内（桥接 advance/invalidate 到纹理回调） */
  Bridge: React.FC;
}

export const useVideoScreenTexture = (opts: UseVideoScreenTextureOpts): VideoScreenTextureApi => {
  const {src, trimBeforeFrame = 0, trimAfterFrame, frameOffset = 0, previewWindow, videoWidth, videoHeight, planeWidth, planeHeight} = opts;
  const {isRendering} = useRemotionEnvironment();
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame();

  const [stuff] = useState(() => {
    const scale = Math.min(1, MAX_TEXTURE_DIM / Math.max(videoWidth, videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(videoWidth * scale));
    canvas.height = Math.max(2, Math.round(videoHeight * scale));
    const context = canvas.getContext('2d')!;
    // 初始黑场：首帧到达前屏幕是关机黑（而非透明/花屏）
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return {canvas, context, texture};
  });

  // three 侧桥接回来的渲染控制（Bridge 组件挂载后填充）
  const advanceRef = useRef<((ts: number) => void) | null>(null);
  const invalidateRef = useRef<(() => void) | null>(null);
  const isRenderingRef = useRef(false);

  /** cover 裁切绘制（两路径共用） */
  const drawCover = useCallback(
    (vf: CanvasImageSource) => {
      const {w: vw, h: vh} = frameDims(vf);
      const targetAspect = planeWidth / planeHeight;
      const srcAspect = vw / vh;
      let sw = vw;
      let sh = vh;
      let sx = 0;
      let sy = 0;
      if (srcAspect > targetAspect) {
        sw = vh * targetAspect;
        sx = (vw - sw) / 2;
      } else {
        sh = vw / targetAspect;
        sy = (vh - sh) / 2;
      }
      stuff.context.drawImage(vf, sx, sy, sw, sh, 0, 0, stuff.canvas.width, stuff.canvas.height);
      stuff.texture.needsUpdate = true;
    },
    [stuff, planeWidth, planeHeight],
  );

  // ============ 渲染期：渲染器 OffthreadVideo 帧抽取（compositor ffmpeg，帧精确） ============
  // 媒体绝对秒 = trimStart + (段内相对帧 − frameOffset)/fps（早于起点冻结首帧），钳到 trimEnd
  //（窗口尾冻结，与 ClipMedia 封口同语义）
  const trimStartSec = trimBeforeFrame / fps;
  const trimEndSec = trimAfterFrame !== undefined ? trimAfterFrame / fps : undefined;
  const mediaTimeSec = trimStartSec + Math.max(0, frame - frameOffset) / fps;
  const clampedTimeSec = trimEndSec !== undefined ? Math.min(mediaTimeSec, trimEndSec) : mediaTimeSec;

  useEffect(() => {
    if (!isRendering || !src) return;
    const handle = delayRender(`VideoScreenTexture: 抽取屏幕帧 t=${clampedTimeSec.toFixed(3)}`, {
      timeoutInMilliseconds: 60000,
      retries: 2,
    });
    let alive = true;
    const frameSrc = NoReactInternals.getOffthreadVideoSource({
      currentTime: clampedTimeSec,
      src,
      transparent: false,
      toneMapped: false,
    });
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      drawCover(img);
      // 纹理更新后同步重渲（demand 模式帧截图可能已用旧纹理渲过一次）
      advanceRef.current?.(performance.now());
      continueRender(handle);
    };
    img.onerror = () => {
      // 抽帧失败不击穿渲染：保留上一帧画面（黑场/旧帧），超时句柄必须清掉
      continueRender(handle);
    };
    img.src = frameSrc;
    return () => {
      alive = false;
    };
  }, [isRendering, src, clampedTimeSec, drawCover]);

  // ============ 预览期：@remotion/media WebCodecs 实时解码（DOM 侧，禁入 R3F 树） ============
  const onVideoFrame = useCallback(
    (vf: CanvasImageSource) => {
      drawCover(vf);
      invalidateRef.current?.();
    },
    [drawCover],
  );

  const dom = useMemo(
    () => {
      if (isRendering || !src) return null;
      // 兜底 OffthreadVideo 会渲染真实 <Img>（可见）：连同容器一起藏掉。
      // onVideoFrame 由帧抽取驱动，与可见性无关。
      const inner = (
        <div style={{position: 'absolute', width: 2, height: 2, left: -20, top: -20, opacity: 0, pointerEvents: 'none', overflow: 'hidden'}}>
          <Video
            src={src}
            onVideoFrame={onVideoFrame}
            muted
            headless
            trimBefore={trimBeforeFrame}
            trimAfter={trimAfterFrame}
            delayRenderTimeoutInMilliseconds={60000}
            delayRenderRetries={2}
          />
        </div>
      );
      // 挂载窗口（如 CameraJourney3D 的驻留窗口）：窗口内才解码播放，窗口外纹理保持末帧
      return previewWindow ? (
        <Sequence from={previewWindow.from} durationInFrames={previewWindow.durationInFrames}>
          {inner}
        </Sequence>
      ) : (
        inner
      );
    },
    [isRendering, src, onVideoFrame, trimBeforeFrame, trimAfterFrame, previewWindow],
  );

  // Bridge 引用稳定（只建一次）：挂在 ThreeCanvas 子树内，把渲染控制桥回 DOM 侧
  const Bridge = useMemo(() => {
    const VideoTextureBridge: React.FC = () => {
      const {advance, invalidate} = useThree();
      const env = useRemotionEnvironment();
      React.useEffect(() => {
        advanceRef.current = advance;
        invalidateRef.current = invalidate;
        isRenderingRef.current = env.isRendering;
      }, [advance, invalidate, env.isRendering]);
      return null;
    };
    return VideoTextureBridge;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {texture: stuff.texture, dom, Bridge};
};
