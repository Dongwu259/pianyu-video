/**
 * useSegmentShot - 段内多镜定位 hook（P1-5B，Fullbleed 族 / VideoCut 共用）。
 *
 * 多镜模式激活条件（二者其一）：
 * - 段内有 ≥2 条视频/图片素材（多条素材必须轮着出现，否则第 2 条起永远不可见）；
 * - 素材仅 1 条但模板参数 autoShots 开启（长素材按 scan_media 镜头边界自动切段内切镜）。
 * 未激活时严格回到旧语义：videos[0] 从 trimStart 连续播放整窗口（尾段冻结由 ClipMedia 封口负责），
 * 保证存量工程渲染逐帧不变。
 *
 * 多镜切分计划见 shared/segment-shot-plan.ts（纯函数可单测）：
 * 素材带 shotList 时按镜头边界取窗（场景切点），否则按 cutSec 固定节奏轮切，硬切零动效。
 */

import {useMemo} from 'react';
import {useCurrentFrame} from 'remotion';
import type {TemplateProps, VideoClip} from '../../shared/types';
import {clipEndSec} from '../../shared/clipCuts';
import {planSegmentShots, shotAt} from '../../shared/segment-shot-plan';
import {FPS} from '../config/resolutions';

export interface SegmentShotView {
  /** 当前帧应显示的素材（未激活/空序列时 = videos[0]，可能 undefined） */
  video: VideoClip | undefined;
  /** 该素材的起播点（媒体绝对秒；未激活时 = trimStart，旧语义） */
  mediaStartSec: number;
  /** 多镜模式是否激活（调用方可用于提示文案/参数行为分叉） */
  multi: boolean;
}

export const useSegmentShot = (
  videos: TemplateProps['videos'],
  segmentDuration: number | undefined,
  /** 固定节奏的目标镜头时长（秒） */
  shotSec: number,
  /** 单素材时是否按素材镜头清单自动切分 */
  autoShots: boolean,
): SegmentShotView => {
  const frame = useCurrentFrame();

  const clips = useMemo(
    () => videos.filter((v) => v && (v.type === 'video' || v.type === 'image')) as VideoClip[],
    [videos],
  );
  const multi = autoShots || clips.length >= 2;

  const shots = useMemo(() => {
    if (!multi) return [];
    return planSegmentShots({
      clips: clips.map((v) => ({
        durationSec:
          v.type === 'video'
            ? Math.max(0.2, (clipEndSec(v) ?? (v.duration || 1)) - (v.trimStart || 0))
            : 3600,
        shots: v.type === 'video' ? v.shotList : undefined,
        windowStartSec: v.trimStart || 0,
        windowEndSec: v.type === 'video' ? (clipEndSec(v) ?? undefined) : undefined,
      })),
      totalSec: Math.max(0.5, segmentDuration ?? 4),
      shotSec,
    });
  }, [clips, multi, segmentDuration, shotSec]);

  if (!multi || shots.length === 0) {
    const first = videos[0];
    return {video: first, mediaStartSec: first?.trimStart || 0, multi};
  }
  const shot = shotAt(shots, frame / FPS);
  const video = shot ? clips[shot.videoIndex] : clips[0];
  return {video, mediaStartSec: (video?.trimStart || 0) + (shot?.mediaStart ?? 0), multi: true};
};
