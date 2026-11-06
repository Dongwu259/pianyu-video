/**
 * ClipMedia - 统一的媒体渲染组件
 *
 * 根据 type 渲染 Remotion <Img>（图片）或 <OffthreadVideo>（视频）。
 * 所有模板通过此组件统一处理图片/视频，避免在每个模板里写条件分支。
 *
 * 为什么用 <OffthreadVideo> 而非 <Video>：<Video> 依赖浏览器实时解码，逐帧渲染时
 * 不是帧精确的——每个片段起播（seek 到 trimStart 并解码首帧）有 0.1~0.3s 窗口，
 * 期间视频元素的黑屏状态会被原样烘进成片（曾致全片 7 处转场边界各闪 2-5 帧近黑帧）。
 * <OffthreadVideo> 渲染期用 ffmpeg 逐帧精确抽取（Remotion 官方要求的渲染用法），
 * 预览（Player）时自动回退普通 video 元素，预览行为不变。
 *
 * 图片无 startFrom 概念（静态帧），该参数对图片忽略。
 *
 * 挖段（cutsSec）：视频素材抠掉中间区间、前后画面无缝拼接。实现为把可播区间
 * 拆成连续的 <Sequence> 切片，每片一个从对应媒体时间起播的 <OffthreadVideo>。
 * cutsSec 为空/未给时走单 <OffthreadVideo> 原路径（零回归）。
 *
 * 窗口尾（endSec = trimEnd，媒体绝对秒）：显著小于素材时长时给出——切片封口到
 * endSec，超出部分用 <Freeze> 冻结在窗口最后一帧（静音复制件，音频同止），
 * 段时长比窗口长时画面定格而非继续播放裁剪区间外的内容（shot 级出点由此生效）。
 * 未给时保持既有语义：播到文件尾自然冻结。稳定/地面追踪/光标的媒体时间采样
 * 同步钳制到 endSec（冻结帧上校正量/覆盖物不再漂移）。
 *
 * 自动曝光匹配：MultiSegmentPromo 开启 colorGrade.autoMatch 时，按本素材 src 查
 * Context 映射表套 brightness 校正（见 layers/colorMatch.ts）。模板无需传任何参数。
 *
 * 跟踪稳定：素材已开启稳定时，按本素材 src 查 StabilizationContext 取每帧校正量表
 * （见 layers/stabilization.ts），当前帧 → 媒体秒（timelineToMediaSec，与挖段切片
 * 同一映射）→ 查表 → correctionToCss，transform 前插到媒体元素自身 transform 链
 * 最外层（绕视频盒中心）。未命中（无数据/图片/未开启）走原路径零回归。
 *
 * 3D 地面追踪：素材在 GroundTrackingContext 有条目（已开启 + 内存态锚点轨迹 +
 * 段级 groundElements）时，在媒体元素兄弟位渲染 GroundMediaOverlay（同盒同
 * transform 链，含稳定校正——稳定与地面追踪可叠加）。挖段切片只渲一份 overlay
 * （其内部按 timelineToMediaSec 查表，天然兼容挖段时间轴）。未命中零回归。
 */

import React from 'react';
import {Freeze, Img, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {useColorMatchFilter} from './colorMatch';
import {useStabilization} from './stabilization';
import {useGroundOverlay} from './groundTracking';
import {GroundMediaOverlay} from './GroundScene';
import {buildPlaybackPlan, timelineToMediaSec} from '../../shared/clipCuts';
import type {ClipCut} from '../../shared/clipCuts';
import {correctionToCss, sampleCorrectionAt} from '../../shared/stabilization';

export interface ClipMediaProps {
  src: string;
  /** 媒体类型，默认 video */
  mediaType?: 'video' | 'image' | 'model';
  /** 视频从第几帧开始播放（图片忽略） */
  startFrom?: number;
  /** 挖段列表（媒体绝对秒；仅视频有意义）：区间内画面被抠掉，前后拼接 */
  cutsSec?: ClipCut[];
  /** 窗口尾（媒体绝对秒，= trimEnd）：显著小于素材时长时给出，超出冻结末帧（音频同止） */
  endSec?: number;
  /** 视频是否静音（图片忽略；默认 false） */
  muted?: boolean;
  /** 视频音量 0..1（图片忽略；默认 1） */
  volume?: number;
  /** 透传给 <Img>/<OffthreadVideo> 的样式 */
  style?: React.CSSProperties;
}

/** 稳定 transform 数值统一 4 位小数（渲染字符串可读，精度足够） */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export const ClipMedia: React.FC<ClipMediaProps> = ({
  src,
  mediaType = 'video',
  startFrom = 0,
  cutsSec,
  endSec,
  muted,
  volume,
  style,
}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame();
  const match = useColorMatchFilter(src);
  const stab = useStabilization(src);
  const ground = useGroundOverlay(src);

  // 窗口尾生效条件：显著大于起播点（否则视为未设，走不封口原路径）
  const endClamped =
    typeof endSec === 'number' && Number.isFinite(endSec) && endSec > startFrom / fps + 1 / fps
      ? endSec
      : undefined;

  // 跟踪稳定：片段时间轴帧 f → 媒体绝对秒（0 = trimStart 的无洞时间轴 → 媒体时间，
  // 与切片起播点同一张映射表）→ 查表取校正量 → CSS。窗口尾外钳制：
  // 冻结帧上的校正量保持末帧取值，不再随时间轴外推漂移。
  let stabTransform = '';
  if (stab && mediaType === 'video') {
    const mediaSec0 = timelineToMediaSec(frame / fps, startFrom / fps, cutsSec);
    const mediaSec = endClamped !== undefined ? Math.min(mediaSec0, endClamped) : mediaSec0;
    const c = sampleCorrectionAt(stab.corrections, mediaSec);
    const css = correctionToCss(c, stab.videoW, stab.videoH, stab.zoom);
    stabTransform =
      `translate(${round4(css.translateXPct)}%, ${round4(css.translateYPct)}%) ` +
      `rotate(${round4(css.rotateDeg)}deg) scale(${round4(css.scale)})`;
  }

  const merged: React.CSSProperties = {
    ...(style ?? {}),
    ...(match ? {filter: match} : {}),
    // 稳定 transform 前插为最外层：先完成模板自身的适配平移/缩放，再施加稳定校正
    // （translate% 相对媒体元素盒 = 适配后视频盒，与 requiredZoom 覆盖推导同口径）
    ...(stabTransform
      ? {
          transform: `${stabTransform}${style?.transform ? ` ${style.transform}` : ''}`,
          transformOrigin: style?.transformOrigin ?? '50% 50%',
        }
      : {}),
  };

  const groundOverlay = ground && ground.elements.length > 0 ? (
    <GroundMediaOverlay entry={ground} style={style} stabTransform={stabTransform} startFrom={startFrom} cutsSec={cutsSec} endSec={endClamped} />
  ) : null;

  if (mediaType === 'model') {
    // 3D 模型素材进了非 3D 模板的画框：占位提示（模型只能由 3D 模板经 three.js 渲染）
    return (
      <div
        style={{
          ...merged,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #141822 0%, #1E2433 100%)',
          color: '#8FA3C8',
          fontSize: 22,
          letterSpacing: '0.08em',
        }}
      >
        3D 模型 · 请用 3D 展示模板
      </div>
    );
  }

  if (mediaType === 'image') {
    return <Img src={src} style={merged} />;
  }

  const plan = buildPlaybackPlan(startFrom / fps, cutsSec, fps, endClamped);

  // 原直出路径（无挖段且不封口）：零回归
  if (plan.playFrames === null && !(cutsSec && cutsSec.length > 0)) {
    return (
      <>
        <OffthreadVideo src={src} startFrom={startFrom} muted={muted} volume={volume} style={merged} />
        {groundOverlay}
      </>
    );
  }

  const sliceVideos = (forceMuted: boolean) =>
    plan.slices.map((sl, i) => (
      <Sequence key={i} from={sl.timelineFrom} durationInFrames={sl.len}>
        <OffthreadVideo
          src={src}
          startFrom={sl.mediaFrom}
          muted={forceMuted ? true : muted}
          volume={forceMuted ? 0 : volume}
          style={merged}
        />
      </Sequence>
    ));

  // 不封口（仅挖段）：切片直渲，末片 Infinity 播到文件尾冻结（既有语义）
  if (plan.playFrames === null) {
    return (
      <>
        {sliceVideos(false)}
        {groundOverlay}
      </>
    );
  }

  // 封口：可播窗口内正常播放（含音频），窗口外用 Freeze 冻结末帧（静音复制件）
  const playFrames = plan.playFrames;
  return (
    <>
      <Sequence from={0} durationInFrames={playFrames}>
        <>{sliceVideos(false)}</>
      </Sequence>
      <Sequence from={playFrames}>
        <Freeze frame={playFrames - 1}>
          <>{sliceVideos(true)}</>
        </Freeze>
      </Sequence>
      {groundOverlay}
    </>
  );
};

export default ClipMedia;
