/**
 * Remotion Root - 注册所有 Composition
 *
 * 模板组件映射的单一来源: MultiSegmentPromo.tsx 中的 TEMPLATE_MAP，直接导入使用。
 *
 * 合成注册策略：按「比例预设」注册 MultiSegment-<presetId>，每个预设一个合成，
 * 尺寸即预设分辨率。渲染时 RenderPanel 传 MultiSegment-<aspectRatioId>。
 * 旧的单模板合成（${meta.id}-landscape 等）已废弃（预览直接渲染组件、不取合成 id），
 * 故移除以减小 bundle 求值开销。
 */

import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {MultiSegmentPromo} from './main/MultiSegmentPromo';
import {CoverComp} from './main/CoverComp';
import {EffectLab} from './layers/EffectLab';
import type {MultiSegmentProps, Orientation} from '../shared/types';
import {ASPECT_RATIO_PRESETS} from '../shared/aspect-ratios';
import {FPS} from './config/resolutions';
import {loadBrandFontForBundle} from './config/brandFont';
import {DEFAULT_COVER} from '../shared/cover-presets';

// 加载内置品牌字体（MiSans），保证渲染与预览文字一致；失败自动回退系统字体
loadBrandFontForBundle();

// 默认布局
const defaultLayout = {
  videoWidthRatio: 0.6,
  videoHeightRatio: 0.5,
  videoOffsetX: 0,
  videoOffsetY: 0,
  rotateX: 5,
  rotateY: 0,
  rotateZ: 0,
  perspective: 1200,
  scale: 1,
  borderRadius: 12,
};

// 默认的多段 props
const makeDefaultMultiProps = (orientation: Orientation): MultiSegmentProps => ({
  segments: [
    {
      id: 'seg-1',
      templateId: 'RevealSlide',
      videos: [{id: 'placeholder', src: '', name: '', width: 1920, height: 1080, duration: 5, type: 'video'}],
      text: {title: 'AI 智能选片', subtitle: '1秒筛选2000张'},
      style: {},
      layout: defaultLayout,
      duration: 8,
      transition: 'crossfade',
    },
  ],
  orientation,
});

// 多段合成的 durationInFrames 上限。
// 注意：这里不能用默认 props 的片段总和（=255 帧），否则用户故事板总时长
// 超过 ~8.4 秒时，renderer.ts 计算的 frameRange 会越界，报错
// "frame range 0-N is not inbetween 0-254"。
// 实际渲染范围由 renderer.ts 的 calculateFrameRange 通过 frameRange 参数精确限制，
// 不会渲染多余黑帧。设为 1 小时上限足够安全。
const MAX_MULTI_DURATION_FRAMES = FPS * 60 * 60;

// 动态生成所有 Composition
export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 每个比例预设注册一个多段合成 Composition（用于最终渲染） */}
      {ASPECT_RATIO_PRESETS.map((preset) => (
        <Composition
          key={preset.id}
          id={`MultiSegment-${preset.id}`}
          component={MultiSegmentPromo as any}
          defaultProps={makeDefaultMultiProps(preset.orientation) as any}
          fps={FPS}
          width={preset.width}
          height={preset.height}
          durationInFrames={MAX_MULTI_DURATION_FRAMES}
        />
      ))}
      {/* 封面合成：全片画面（指定帧）+ 封面覆盖层，导出走 renderStill 单帧 */}
      {ASPECT_RATIO_PRESETS.map((preset) => (
        <Composition
          key={`cover-${preset.id}`}
          id={`Cover-${preset.id}`}
          component={CoverComp as any}
          defaultProps={{project: makeDefaultMultiProps(preset.orientation), cover: DEFAULT_COVER} as any}
          fps={FPS}
          width={preset.width}
          height={preset.height}
          durationInFrames={MAX_MULTI_DURATION_FRAMES}
        />
      ))}
      {/* 特效调试合成（仅开发用）：npx remotion still ... EffectLab --props '{"kind":"background","effect":"inkWash"}' */}
      <Composition
        id="EffectLab"
        component={EffectLab as any}
        defaultProps={{kind: 'background', effect: 'inkWash'} as any}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={300}
      />
    </>
  );
};

export default RemotionRoot;

// 注册根组件 - Remotion bundler 要求入口文件调用 registerRoot()
registerRoot(RemotionRoot);
