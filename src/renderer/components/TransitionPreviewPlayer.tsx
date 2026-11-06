/**
 * TransitionPreviewPlayer - 转场预览（整片模式）
 *
 * 用真实的 MultiSegmentPromo 渲染整片，从「当前片段 → 下一片段」转场窗口前 0.5s
 * 开始自动播放，过窗后自动暂停，所见即所得地检查运镜转场（焦点/倍率/时长）。
 * 点重播可反复查看；不渲染背景音乐（bgm=null），专注转场本身。
 */

import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {RotateCw} from 'lucide-react';
import type {Orientation, Segment} from '../../shared/types';
import type {CustomTemplateDef} from '../../shared/custom-template';
import type {GeneratedTemplateDef} from '../../shared/generated-template';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {computeTransitionWindows, getOutroFadeFrames} from '../../shared/transition-style';
import {isRawOutputTemplate} from '../../shared/template-registry';
import {MultiSegmentPromo} from '../../remotion/main/MultiSegmentPromo';
import {FPS} from '../../remotion/config/resolutions';
import {toLocalVideoUrl} from './RemotionPreviewPlayer';
import {useProjectStore} from '../store/projectStore';

// Player 的组件类型要求 Record<string, unknown> props，包一层适配（模块级常量保持稳定引用）
const PromoForPlayer: React.FC<any> = (props) => <MultiSegmentPromo {...props} />;

interface TransitionPreviewPlayerProps {
  segments: Segment[];
  /** 预览「第 segmentIndex 段 → 第 segmentIndex+1 段」的转场 */
  segmentIndex: number;
  orientation: Orientation;
  aspectRatioId?: string;
  customTemplates?: CustomTemplateDef[];
  generatedTemplates?: GeneratedTemplateDef[];
}

export const TransitionPreviewPlayer: React.FC<TransitionPreviewPlayerProps> = ({
  segments,
  segmentIndex,
  orientation,
  aspectRatioId,
  customTemplates = [],
  generatedTemplates = [],
}) => {
  const playerRef = useRef<PlayerRef>(null);
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const preset = getAspectRatioPreset(aspectRatioId);

  // 时间窗口：转场高潮帧 = 第 i 段内容结束帧（B3 骑跨：窗口从高潮帧前 headPad 帧开始）；
  // 播到第 i+1 段内容结束后再停
  const contentEndOf = (indexInclusive: number): number =>
    segments.slice(0, indexInclusive + 1).reduce((sum, s) => sum + Math.round((s.duration || 8) * FPS), 0);

  const durationInFrames =
    contentEndOf(segments.length - 1) +
    (isRawOutputTemplate(segments[segments.length - 1]?.templateId) ? 0 : getOutroFadeFrames(FPS));
  const transitionStart = contentEndOf(segmentIndex);
  // 窗口头可能在高潮帧前 headPad 帧（骑跨），预览起点取「提前 0.5s」与「窗口头再留 0.25s」的较大者
  const previewWindows = computeTransitionWindows(
    segments,
    segments.map((s) => Math.round((s.duration || 8) * FPS)),
    FPS,
  );
  const headPad = previewWindows[segmentIndex]?.headPad ?? 0;
  const initialFrame = Math.max(
    0,
    transitionStart - Math.max(Math.round(FPS * 0.5), headPad + Math.round(FPS * 0.25)),
  );
  const pauseFrame = Math.min(durationInFrames - 1, contentEndOf(segmentIndex + 1) + Math.round(FPS * 0.5));

  // 播过转场窗口后自动暂停
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: {detail: {frame: number}}) => {
      if (e.detail.frame >= pauseFrame) player.pause();
    };
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [pauseFrame]);

  const handleReplay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    p.seekTo(initialFrame);
    p.play();
  }, [initialFrame]);

  // 预览协议转换（http → local-video://），与单段预览一致
  const previewSegments = useMemo(
    () =>
      segments.map((s) => ({
        ...s,
        videos: s.videos.map((v) => ({...v, src: toLocalVideoUrl(v.src)})),
      })),
    [segments],
  );

  const inputProps = useMemo(
    () => ({
      segments: previewSegments,
      orientation,
      customTemplates,
      generatedTemplates,
      bgm: null,
      // 授权状态未加载完成时按已授权处理（避免水印闪烁）
      licensed: licenseStatus ? licenseStatus.entitlement === 'licensed' : true,
    }),
    [previewSegments, orientation, customTemplates, generatedTemplates, licenseStatus],
  );

  return (
    <div className="preview-player-container">
      <Player
        ref={playerRef}
        component={PromoForPlayer}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        fps={FPS}
        compositionWidth={preset.width}
        compositionHeight={preset.height}
        style={{width: '100%', height: '100%'}}
        controls={false}
        autoPlay
        clickToPlay={false}
        spaceKeyToPlayOrPause={false}
        initiallyMuted
        initialFrame={initialFrame}
      />
      <button
        className="preview-replay-btn"
        style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
        onClick={handleReplay}
        title="重播转场"
      >
        <RotateCw size={16} />
      </button>
    </div>
  );
};

export default TransitionPreviewPlayer;
