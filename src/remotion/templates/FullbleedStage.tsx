/**
 * Fullbleed 共享舞台（FullbleedTitle / FullbleedFeature / FullbleedCTA 的公共底层）
 *
 * 「素材主导」模板族的统一约定（与画中画族相反）：
 * - 素材 cover 撑满全画幅，是画面绝对主角；零动效（不推近/不呼吸/不位移）
 * - 文字浮在素材表面：底部渐变 scrim（或整体暗化）保证可读性
 * - 文字入场克制：fade + 8px 上滑（12-18 帧），无弹跳/逐字等强动效
 * - 满幅取景走 video.viewport（裁掉素材边缘无关区域），fit 恒 cover
 *
 * 多镜扩展（P1-5B）：段内 ≥2 条素材时轮转硬切（切点优先 scan_media 镜头边界），
 * 单素材 + autoShots 开启时长素材按自身镜头边界段内切镜；其余情况保持
 * 单素材连续播放的旧语义（存量工程逐帧不变）。切分大脑 shared/segment-shot-plan.ts。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {clipEndSec} from '../../shared/clipCuts';
import {useSegmentShot} from '../utils/useSegmentShot';
import type {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';

/** 文字入场的统一克制动效：fade + 8px 上滑（delaySec 后启动，12-18 帧完成） */
export const useRestrainedEntrance = (delaySec = 0.15): {opacity: number; transform: string} => {
  const frame = useCurrentFrame();
  const start = Math.round(delaySec * FPS);
  const opacity = interpolate(frame, [start, start + 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(frame, [start, start + 16], [8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {opacity, transform: `translateY(${rise}px)`};
};

export interface FullbleedStageProps {
  videos: TemplateProps['videos'];
  /** 整体暗化强度 0-1（CTA 居中文字需要更强的 scrim；0 = 只留底部渐变） */
  dimScrim: number;
  /** 底部渐变高度占画布比例（0 = 无底部渐变） */
  bottomGradientRatio?: number;
  /** 无素材空态提示文案（照 VideoCut 空态约定：不 return null） */
  emptyHint: string;
  style?: TemplateProps['style'];
  /** 段时长（秒）：多镜切分的总预算 */
  segmentDuration?: number;
  /** 多镜切换的目标镜头时长（秒；≥2 条素材或 autoShots 时生效） */
  shotSec?: number;
  /** 单素材时是否按素材镜头清单自动切分（缺省 false = 连续播放整窗口，旧语义） */
  autoShots?: boolean;
  children?: React.ReactNode;
}

/** 素材满幅层 + scrim + 内容层；素材零动效（不推近/不呼吸），多素材时段内轮转硬切 */
export const FullbleedStage: React.FC<FullbleedStageProps> = ({
  videos,
  dimScrim,
  bottomGradientRatio = 0.42,
  emptyHint,
  style,
  segmentDuration,
  shotSec = 2.5,
  autoShots = false,
  children,
}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const {video, mediaStartSec} = useSegmentShot(videos, segmentDuration, shotSec, autoShots);

  const placed = video
    ? applyViewport(canvasW, canvasH, fitVideo(canvasW, canvasH, video.width, video.height, 'cover'), 'cover', video.viewport)
    : null;

  if (!video || !placed) {
    return (
      <AbsoluteFill style={{background: style?.background ?? '#000000'}}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.55)',
            fontSize: Math.round(canvasW * 0.018),
            letterSpacing: '0.05em',
          }}
        >
          {emptyHint}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{background: style?.background ?? '#000000'}}>
      {/* 主素材：cover 满幅，零动效（不推近/不呼吸——实拍画面是主角）；多镜时按切分计划轮转硬切 */}
      <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
        <ClipMedia
          src={video.src}
          mediaType={video.type}
          muted={video.muted}
          volume={video.volume}
          startFrom={Math.round(mediaStartSec * FPS)}
          endSec={clipEndSec(video)}
          cutsSec={video.cuts}
          style={{
            width: placed.width,
            height: placed.height,
            transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
            objectFit: 'cover',
          }}
        />
      </div>

      {/* 整体暗化（居中文字可读性；dimScrim=0 时无此层） */}
      {dimScrim > 0 && (
        <AbsoluteFill style={{background: `rgba(0,0,0,${dimScrim})`}} />
      )}

      {/* 底部渐变 scrim：文字浮层的可读性底（黑→透明向上） */}
      {bottomGradientRatio > 0 && (
        <AbsoluteFill
          style={{
            background: `linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.45) ${(bottomGradientRatio * 0.5 * 100).toFixed(0)}%, rgba(0,0,0,0) ${(bottomGradientRatio * 100).toFixed(0)}%)`,
          }}
        />
      )}

      {/* 内容层（文字浮层） */}
      {children}
    </AbsoluteFill>
  );
};
