/**
 * Video3D - 3D 画中画容器
 *
 * 所有模板的基石组件：将视频片段以 CSS 3D Transform 嵌入画面
 * 支持 perspective/rotateX/Y/Z/translateZ/scale 等参数
 *
 * 用法示例：
 * <Video3D src={video.src} w={1152} h={648} vw={1920} vh={1080}
 *   perspective={1200} rotateX={5} rotateY={-15} x={0} y={200} scale={1} />
 */

import {AbsoluteFill, useCurrentFrame, interpolate, useVideoConfig} from 'remotion';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {computeClickRipples} from '../utils/clickRipples';
import {fadeIn, fadeOut} from '../animations/keyframes';
import {ClipMedia} from './ClipMedia';
import {useVideoEffect, getVideoEffectStyle, VideoEffectOverlay} from './videoEffects';
import {CursorOverlay} from './CursorOverlay';
import {VIDEO_DESIGN} from '../config/designTokens';
import type {ClipViewport, FitMode} from '../../shared/types';
import type {CursorClick, CursorPoint} from '../../shared/capture';
import type {ClipCut} from '../../shared/clipCuts';

interface Video3DProps {
  src: string;
  w: number;               // 画框宽度
  h: number;               // 画框高度
  vw: number;              // 原始视频宽度
  vh: number;              // 原始视频高度
  perspective?: number;    // 透视距离
  rotateX?: number;        // X 轴倾斜角（度）
  rotateY?: number;        // Y 轴倾斜角（度）
  rotateZ?: number;        // Z 轴旋转角（度）
  translateZ?: number;     // Z 轴位移（px）
  x?: number;              // 水平位置
  y?: number;              // 垂直位置
  scale?: number;          // 缩放倍率
  shadow?: boolean;        // 是否投射阴影
  borderRadius?: number;   // 圆角
  fadeInFrame?: number;    // 从此帧开始淡入
  fadeOutFrame?: number;   // 从此帧开始淡出
  fadeDuration?: number;   // 淡入淡出时长（帧）
  startFrom?: number;      // 从视频的第几帧开始播放（用于剪辑）
  cutsSec?: ClipCut[];     // 挖段（媒体绝对秒）：抠掉中间区间，前后画面拼接
  endSec?: number;         // 窗口尾（媒体绝对秒，= trimEnd）：超出冻结末帧（ClipMedia 消费）
  mediaType?: 'video' | 'image' | 'model';  // 媒体类型（图片用 <Img>，model 在 ClipMedia 出占位卡）
  muted?: boolean;         // 视频静音（图片忽略）
  volume?: number;         // 视频音量 0..1（图片忽略）
  fit?: FitMode;           // 适配模式（默认：图片 cover / 视频 contain）
  viewport?: ClipViewport; // 取景视口（画框内缩放/平移媒体）
  clicks?: CursorClick[];  // 录屏点击事件（clickRipple 特效与美化光标按压脉冲消费）
  cursorPoints?: CursorPoint[]; // 录屏鼠标轨迹（美化光标消费；CursorContext 关闭时忽略）
}

export const Video3D: React.FC<Video3DProps> = ({
  src: rawSrc,
  w,
  h,
  vw,
  vh,
  perspective = 1200,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  translateZ = 0,
  x = 0,
  y = 0,
  scale = 1,
  shadow = true,
  borderRadius = 12,
  fadeInFrame,
  fadeOutFrame,
  fadeDuration = 12,
  startFrom = 0,
  cutsSec,
  endSec,
  mediaType = 'video',
  muted,
  volume,
  fit,
  viewport,
  clicks,
  cursorPoints,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  // 转换视频源为 Remotion <Video> 可识别的格式
  // - http:// / https:// → 保持不变（Remotion 渲染时通过 HTTP 加载）
  // - file:// → 保持不变
  // - data: / blob: → 保持不变（内联/对象 URL，勿拼 file:// 前缀）
  // - 本地路径 (D:\foo\bar.mp4) → 转为 file:// URL（兼容 Player 预览）
  let src = rawSrc;
  if (
    !src.startsWith('http://') &&
    !src.startsWith('https://') &&
    !src.startsWith('file://') &&
    !src.startsWith('local-video://') &&
    !src.startsWith('data:') &&
    !src.startsWith('blob:')
  ) {
    src = `file://${src.replace(/\\/g, '/')}`;
  }

  // 适配模式：片段显式指定优先；图片默认 cover（填满画框），视频默认 contain（完整显示）
  const fitMode: FitMode = fit ?? (mediaType === 'image' ? 'cover' : 'contain');
  const baseFit = fitVideo(w, h, vw, vh, fitMode);
  // 叠加取景视口（缩放 + 平移）；无视口时与原 fit 居中行为完全一致
  const placed = applyViewport(w, h, baseFit, fitMode, viewport);
  // contain 出现 letterbox 留白时，在画框内衬一层深色底
  const hasLetterbox = fitMode === 'contain' && (placed.width < w - 0.5 || placed.height < h - 0.5);

  // 计算淡入淡出透明度
  let opacity = 1;
  if (fadeInFrame !== undefined) {
    opacity = Math.min(opacity, fadeIn(frame, fadeInFrame, fadeDuration));
  }
  if (fadeOutFrame !== undefined) {
    opacity = Math.min(opacity, fadeOut(frame, fadeOutFrame, fadeDuration));
  }

  // 视频画布特效（由片段经 Context 注入）
  const effect = useVideoEffect();
  const effStyle = getVideoEffectStyle(effect, frame);
  // 点击水波：点击事件按媒体最终几何（placed）与当前媒体时间换算到画框坐标
  const ripples =
    effect === 'clickRipple'
      ? computeClickRipples({clicks, frame, fps, startFrom, cutsSec, endSec, vw, vh, placed, frameW: w})
      : undefined;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        perspective: `${perspective}px`,
        transformStyle: 'preserve-3d',
        opacity,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `
            rotateX(${rotateX}deg)
            rotateY(${rotateY}deg)
            rotateZ(${rotateZ}deg)
            translateZ(${translateZ}px)
            scale(${scale})
            ${effStyle.transform || ''}
          `,
          transformStyle: 'preserve-3d',
          borderRadius: `${borderRadius}px`,
          overflow: 'hidden',
          boxShadow: shadow ? VIDEO_DESIGN.shadow : 'none',
        }}
      >
        {/* contain 留白衬底 */}
        {hasLetterbox && (
          <div style={{position: 'absolute', inset: 0, background: VIDEO_DESIGN.colors.pipBackdrop}} />
        )}
        <div style={{position: 'absolute', inset: 0, filter: effStyle.filter}}>
          <ClipMedia
            src={src}
            mediaType={mediaType}
            startFrom={startFrom}
            cutsSec={cutsSec}
            endSec={endSec}
            muted={muted}
            volume={volume}
            style={{
              width: placed.width,
              height: placed.height,
              // 媒体左上角相对画框的位移（含取景平移，已按模式夹取）
              transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
              objectFit: fitMode,
            }}
          />
        </div>
        <VideoEffectOverlay effect={effect} frame={frame} ripples={ripples} />
        {/* 美化光标：平滑轨迹 + 光晕（开关与无轨迹的判断均在组件内部） */}
        <CursorOverlay
          points={cursorPoints}
          clicks={clicks}
          frame={frame}
          fps={fps}
          startFrom={startFrom}
          cutsSec={cutsSec}
          endSec={endSec}
          vw={vw}
          vh={vh}
          placed={placed}
          frameW={w}
        />
        {/* 画框内描边高光 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            boxShadow: VIDEO_DESIGN.frameHighlight,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
};
