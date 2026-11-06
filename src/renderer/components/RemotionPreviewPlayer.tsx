/**
 * RemotionPreviewPlayer - 片段预览组件
 *
 * 用真实的 @remotion/player <Player> 渲染实际模板组件（内置模板用 TEMPLATE_MAP，
 * 自定义模板用 CustomTemplateRender），保证「所见即所得」：
 * 布局（videoWidthRatio/Offset/旋转/缩放/圆角）、样式、文字、入场动画均实时同步。
 * 不再用 CSS mockup（旧 PreviewRenderer 忽略 layout，导致布局调整不同步）。
 */

import React, {useCallback, useMemo, useRef} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {Sequence} from 'remotion';
import type {TemplateProps, VideoEffect, BackgroundEffect} from '../../shared/types';
import type {CustomTemplateDef} from '../../shared/custom-template';
import type {GeneratedTemplateDef} from '../../shared/generated-template';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {TEMPLATE_MAP} from '../../remotion/main/MultiSegmentPromo';
import {setBrandTheme} from '../../remotion/config/designTokens';
import {CustomTemplateRender} from '../../remotion/templates/CustomTemplateRender';
import {GeneratedTemplateRender} from '../../remotion/templates/GeneratedTemplateRender';
import {VideoEffectContext} from '../../remotion/layers/videoEffects';
import {BackgroundEffectContext} from '../../remotion/layers/backgroundEffects';
import {Watermark} from '../../remotion/layers/Watermark';
import {GroundTrackingContext, type GroundOverlayEntry} from '../../remotion/layers/groundTracking';
import {useProjectStore} from '../store/projectStore';
import './RemotionPreviewPlayer.css';

const PREVIEW_FPS = 30;

/**
 * 把 http 本地视频服务器 URL 转为 local-video:// 协议供预览使用。
 * 原因：预览页运行在安全上下文（localhost / file://），http: 媒体可能被 CSP/混合内容拦截；
 * local-video:// 是已注册的自定义协议且在 CSP 白名单内，不受此影响。渲染仍用 http（headless Chrome）。
 * （导出供 TransitionPreviewPlayer 复用）
 */
export const toLocalVideoUrl = (src: string): string => {
  if (!src) return src;
  // data:/blob: URL（如 hover 预览的占位图）不是本地文件，直通不改写
  if (/^(data:|blob:)/i.test(src)) return src;
  if (src.startsWith('local-video://')) return src;
  return `local-video://${src.replace(/^file:\/\/\//, '').replace(/\\/g, '/')}`;
};

/**
 * 包一层 Provider：把 inputProps.videoEffect / backgroundEffect 注入对应 Context，
 * 这样模板内的 Video3D / CustomTemplateRender / BackgroundEffectLayer 能取到当前片段的特效。
 * Player 调用 component 时把 inputProps 作为 props 传入，故从 props 取。
 * 免费版（props.licensed === false）时叠加与导出一致的水印。
 */
const withEffectContext = (Comp: React.ComponentType<any>): React.FC<any> => {
  const Wrapped: React.FC<any> = (props) => {
    // 3D 地面层：活动段的 groundElements 配对首个「已追踪且有内存态轨迹」的素材
    // （key 用 local-video:// 改写后的 src，与 ClipMedia 收到的 src 一致；与整片
    // 预览/导出的 MultiSegmentPromo 组装逻辑同构——单段预览也所见即所得）
    const groundElements = useProjectStore((s) => (s.segments[s.activeSegmentIndex]?.groundElements ?? []).filter(Boolean));
    const groundEntries = React.useMemo(() => {
      const m = new Map<string, GroundOverlayEntry>();
      if (groundElements.length === 0) return m;
      const v = (props.videos || []).find((vv: any) =>
        vv.groundTrack?.enabled && vv.groundData?.anchors?.length && vv.groundData?.samples?.length);
      if (v) {
        m.set(v.src, {
          track: {anchors: v.groundData.anchors, samples: v.groundData.samples},
          elements: groundElements,
          videoW: v.width,
          videoH: v.height,
        });
      }
      return m;
    }, [groundElements, props.videos]);
    return (
      <VideoEffectContext.Provider value={(props.videoEffect as VideoEffect) || 'none'}>
        <BackgroundEffectContext.Provider value={(props.backgroundEffect as BackgroundEffect) || 'none'}>
          <GroundTrackingContext.Provider value={groundEntries}>
            <Comp {...props} />
            {props.licensed === false && <Watermark />}
          </GroundTrackingContext.Provider>
        </BackgroundEffectContext.Provider>
      </VideoEffectContext.Provider>
    );
  };
  return Wrapped;
};

interface PreviewPlayerProps {
  inputProps: TemplateProps;
  orientation: 'landscape' | 'portrait';
  /** 画布比例预设 id，决定预览画布尺寸 */
  aspectRatioId?: string;
  templateId?: string;
  duration?: number;
  /** 模板播放起点（秒）：>0 时跳过模板入场动画 */
  startOffsetSec?: number;
  loop?: boolean;
  /** 内置控制条开关（hover 动态预览等紧凑场景关掉） */
  controls?: boolean;
  customTemplateDef?: CustomTemplateDef;
  /** AI 生成模板 def（gen- 前缀片段时传入，优先于内置/自定义分发） */
  generatedTemplateDef?: GeneratedTemplateDef;
}

/** 暴露给父组件的预览控制（重播按钮放在预览头部的播放模式下拉旁） */
export interface PreviewPlayerHandle {
  replay: () => void;
}

export const RemotionPreviewPlayer = React.forwardRef<PreviewPlayerHandle, PreviewPlayerProps>(({
  inputProps,
  aspectRatioId,
  templateId = 'RevealSlide',
  duration = 8,
  startOffsetSec = 0,
  loop = false,
  controls = true,
  customTemplateDef,
  generatedTemplateDef,
}, ref) => {
  const playerRef = useRef<PlayerRef>(null);
  // 授权状态：免费版预览叠加水印，与导出结果保持一致
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  // 品牌主题（项目级）：与整片渲染同口径注入，预览所见即所得
  const brandColor = useProjectStore((s) => s.brandColor);
  const fontMood = useProjectStore((s) => s.fontMood);
  setBrandTheme({accent: brandColor, fontMood});

  const handleReplay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    p.seekTo(0);
    p.play();
  }, []);

  React.useImperativeHandle(ref, () => ({replay: handleReplay}), [handleReplay]);

  const preset = getAspectRatioPreset(aspectRatioId);
  const durationInFrames = Math.max(1, Math.round(duration * PREVIEW_FPS));

  // AI 生成模板 -> GeneratedTemplateRender；自定义模板 -> CustomTemplateRender；内置 -> TEMPLATE_MAP[templateId]
  const isGen = !!generatedTemplateDef;
  const isCustom = !!customTemplateDef && !isGen;
  const component = useMemo(
    () =>
      withEffectContext(
        (isGen ? GeneratedTemplateRender : isCustom ? CustomTemplateRender : (TEMPLATE_MAP[templateId] || TEMPLATE_MAP.RevealSlide)) as React.ComponentType<any>
      ),
    [isGen, isCustom, templateId],
  );

  // 模板播放起点：负 from 的 Sequence 把内部时间轴后移（与整片渲染行为一致）。
  // 注意：负 from 会把 Sequence 可见窗口终点提前 offsetFrames 帧，durationInFrames
  // 必须加上 offsetFrames 补偿，否则末尾 offsetFrames 帧内容变 null（黑帧）。
  const offsetFrames = Math.min(
    Math.max(0, Math.round(startOffsetSec * PREVIEW_FPS)),
    Math.max(0, durationInFrames - 1),
  );
  const offsetComponent = useMemo(() => {
    if (offsetFrames <= 0) return component;
    const Inner = component;
    const WithOffset: React.FC<any> = (props) => (
      <Sequence from={-offsetFrames} durationInFrames={durationInFrames + offsetFrames}>
        <Inner {...props} />
      </Sequence>
    );
    return WithOffset;
  }, [component, offsetFrames, durationInFrames]);
  const playerInputProps = {
    ...(isGen ? {...inputProps, def: generatedTemplateDef} : isCustom ? {...inputProps, def: customTemplateDef} : inputProps),
    videos: (inputProps.videos || []).map((v) => ({...v, src: toLocalVideoUrl(v.src)})),
    // 授权状态未加载完成时按已授权处理（避免水印闪烁），加载后免费版立即显示水印
    licensed: licenseStatus ? licenseStatus.entitlement === 'licensed' : true,
  };

  return (
    <div className="preview-player-container">
      <Player
        ref={playerRef}
        component={offsetComponent}
        inputProps={playerInputProps}
        durationInFrames={durationInFrames}
        fps={PREVIEW_FPS}
        compositionWidth={preset.width}
        compositionHeight={preset.height}
        style={{width: '100%', height: '100%'}}
        loop={loop}
        // 内置控制条：暂停/进度/音量（与整片预览一致）。默认静音自动播放
        // （浏览器自动播放策略 + 避免编辑时反复出声），需要听原声时点音量键
        controls={controls}
        autoPlay
        clickToPlay={false}
        spaceKeyToPlayOrPause={false}
        initiallyMuted
      />
    </div>
  );
});

export default RemotionPreviewPlayer;
