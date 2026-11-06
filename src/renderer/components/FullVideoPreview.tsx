/**
 * FullVideoPreview - 整片预览（导出前）
 *
 * 用 @remotion/player <Player> 渲染 MultiSegmentPromo，播放所有片段的完整成片
 * （含转场、BGM、视频音频、免费版水印），让用户导出前看到真实效果。
 * 与渲染同源（同一个 MultiSegmentPromo 组件），所见即所得。
 */

import React, {Component, useEffect, useMemo, useState} from 'react';
import {Player} from '@remotion/player';
import {MultiSegmentPromo} from '../../remotion/main/MultiSegmentPromo';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {getOutroFadeFrames} from '../../shared/transition-style';
import {isRawOutputTemplate} from '../../shared/template-registry';
import {FPS} from '../../remotion/config/resolutions';
import {toLocalVideoUrl} from './RemotionPreviewPlayer';
import {useProjectStore} from '../store/projectStore';
import {getSfxSources} from '../sfx/sfxSources';
import type {MultiSegmentProps, SfxSources} from '../../shared/types';

const OUTRO_FADE = getOutroFadeFrames(FPS);

/**
 * 错误边界：Player 内部抛错时显示提示，而不是静默消失或崩溃整个导出页。
 * 用于定位「预览不显示」是渲染错误还是 CSS 不可见。
 */
class PreviewErrorBoundary extends Component<{children: React.ReactNode}, {error: Error | null}> {
  state: {error: Error | null} = {error: null};
  static getDerivedStateFromError(error: Error) {
    return {error};
  }
  componentDidCatch(error: Error) {
    console.error('[FullVideoPreview] Player 渲染出错:', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding: 16, fontSize: 13, color: '#B91C1C', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8}}>
          预览渲染出错：{this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  inputProps: MultiSegmentProps;
  aspectRatioId: string;
}

export const FullVideoPreview: React.FC<Props> = ({inputProps, aspectRatioId}) => {
  const preset = getAspectRatioPreset(aspectRatioId);
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const syncCurrentToSegment = useProjectStore((s) => s.syncCurrentToSegment);
  // 音效配置直接取 store（BgmPanel 调整后预览即时生效；inputProps 由父级同步构造不含此字段）
  const sfx = useProjectStore((s) => s.sfx);
  // 质感预设同理（品牌面板调整后预览即时生效）
  const texture = useProjectStore((s) => s.texture);
  // 节拍脉冲同理（声音面板调整后预览即时生效）
  const beatPulse = useProjectStore((s) => s.beatPulse);
  // 美化光标同理（品牌面板调整后预览即时生效）
  const cursor = useProjectStore((s) => s.cursor);
  const [sfxSources, setSfxSources] = useState<SfxSources | null>(null);
  // 轻量预览（转场按硬切、同刻只解码一段视频）：纯本机播放偏好，存 localStorage 不入工程；
  // 长故事板/高分辨率素材在预览转场处双视频同时解码会卡顿，开启后预览流畅（导出不受影响）
  const [liteCut, setLiteCut] = useState(() => localStorage.getItem('qs-preview-lite-cut') === '1');
  const toggleLiteCut = () => {
    setLiteCut((v) => {
      localStorage.setItem('qs-preview-lite-cut', v ? '0' : '1');
      return !v;
    });
  };

  // 进入预览前把工作副本刷入故事板，确保预览反映最新编辑
  useEffect(() => {
    syncCurrentToSegment();
  }, [syncCurrentToSegment]);

  // 音效源表（内置库 URL）：挂载时拉一次，转 local-video 协议防 CSP/混合内容拦截
  useEffect(() => {
    let cancelled = false;
    getSfxSources().then((src) => {
      if (cancelled) return;
      setSfxSources(
        Object.fromEntries(
          Object.entries(src).map(([k, arr]) => [k, arr.map(toLocalVideoUrl)]),
        ) as SfxSources,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 总帧数 = Σ 各段内容帧 + 末段淡黑（与渲染的 calculateFrameRange 一致；
  // 末段为「原样输出」模板（屏幕录制）时豁免淡黑）
  const totalContent = inputProps.segments.reduce((s, seg) => s + Math.round((seg.duration || 8) * FPS), 0);
  const lastRaw = isRawOutputTemplate(inputProps.segments[inputProps.segments.length - 1]?.templateId);
  const durationInFrames = Math.max(1, totalContent + (lastRaw ? 0 : OUTRO_FADE));

  // 预览用 local-video:// 协议加载媒体（http 在预览页可能被 CSP/混合内容拦截）
  const playerInputProps = useMemo(() => ({
    ...inputProps,
    segments: inputProps.segments.map((seg) => ({
      ...seg,
      videos: seg.videos.map((v) => ({...v, src: toLocalVideoUrl(v.src)})),
    })),
    bgm: inputProps.bgm ? {...inputProps.bgm, src: toLocalVideoUrl(inputProps.bgm.src)} : null,
    // 音效配置与源表（源表未就绪时先不传，就绪后重渲染注入，与导出同一份放置逻辑）
    sfx,
    ...(sfxSources ? {sfxSources} : {}),
    texture,
    beatPulse,
    cursor,
    // Logo 图片同样转 local-video 协议（预览页 http 可能被 CSP 拦截）
    logo: inputProps.logo ? {...inputProps.logo, src: toLocalVideoUrl(inputProps.logo.src)} : inputProps.logo,
    // 免费版预览叠加水印，与导出一致
    licensed: licenseStatus ? licenseStatus.entitlement === 'licensed' : true,
    // 轻量预览：转场窗口按硬切呈现、同刻只解码一段视频（仅预览，导出不受影响）
    previewLiteCut: liteCut,
  }), [inputProps, licenseStatus, sfx, sfxSources, texture, beatPulse, cursor, liteCut]);

  if (inputProps.segments.length === 0) return null;

  return (
    <div className="full-preview-section" style={{marginBottom: 12}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 13, fontWeight: 600, color: '#374151'}}>
        <span style={{display: 'inline-block', width: 3, height: 14, background: '#6366F1', borderRadius: 2}} />
        整片预览
        <span style={{fontSize: 11, fontWeight: 400, color: '#9CA3AF'}}>导出前可播放查看效果</span>
        <label
          title="预览卡顿（老机器/长片/高分辨率素材在转场处双视频同时解码）时开启：转场在预览中改为硬切、同一时刻只解码一段视频，预览更流畅。仅影响预览，导出成片的转场完全不变。"
          style={{display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: liteCut ? '#6366F1' : '#9CA3AF', cursor: 'pointer', userSelect: 'none'}}
        >
          <input type="checkbox" checked={liteCut} onChange={toggleLiteCut} style={{margin: 0}} />
          轻量预览
        </label>
      </div>
      <div style={{
        position: 'relative',
        width: '100%',
        aspectRatio: `${preset.width} / ${preset.height}`,
        maxHeight: 420,
        minHeight: 200,
        margin: '0 auto',
        background: '#000',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 4px 16px -4px rgba(0,0,0,0.2)',
      }}>
        <PreviewErrorBoundary>
          <Player
            component={MultiSegmentPromo as React.ComponentType<any>}
            inputProps={playerInputProps}
            durationInFrames={durationInFrames}
            fps={FPS}
            compositionWidth={preset.width}
            compositionHeight={preset.height}
            style={{width: '100%', height: '100%'}}
            controls
            loop
            autoPlay={false}
          />
        </PreviewErrorBoundary>
      </div>
    </div>
  );
};

export default FullVideoPreview;
