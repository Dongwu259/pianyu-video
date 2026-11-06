/**
 * ClipViewportEditor - 取景编辑器（类头像裁剪）
 *
 * 在模拟当前片段 PiP 画框比例的预览框内，对视频/图片做缩放 + 拖拽平移，
 * 决定画框最终显示源素材的哪一部分。
 *
 * 几何计算与渲染端（Video3D / CustomTemplateRender）共用
 * remotion/utils/viewport.ts 的纯函数，保证预览与导出一致。
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {X, RotateCcw} from 'lucide-react';
import type {ClipViewport, FitMode, VideoClip} from '../../shared/types';
import {fitVideo} from '../../remotion/utils/fitVideo';
import {
  applyViewport,
  clampViewport,
  isDefaultViewport,
  VIEWPORT_SCALE_LIMITS,
} from '../../remotion/utils/viewport';
import './ClipViewportEditor.css';

interface ClipViewportEditorProps {
  clip: VideoClip;
  /** PiP 画框宽高比（宽/高），由调用方按当前片段布局/模板推导 */
  frameAspect: number;
  /** 保存取景（undefined = 恢复默认） */
  onSave: (viewport: ClipViewport | undefined) => void;
  onCancel: () => void;
}

const DEFAULT_VIEWPORT: ClipViewport = {scale: 1, offsetX: 0, offsetY: 0};

/** 与 VideoTrimmer 相同：把 http/file 源统一转为 local-video:// 协议 URL */
const toLocalVideoUrl = (src: string): string => {
  const rawPath = src.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
  return `local-video://${rawPath}`;
};

export const ClipViewportEditor: React.FC<ClipViewportEditorProps> = ({
  clip,
  frameAspect,
  onSave,
  onCancel,
}) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState<{w: number; h: number} | null>(null);
  const [viewport, setViewport] = useState<ClipViewport>(clip.viewport ?? DEFAULT_VIEWPORT);
  const dragRef = useRef<{x: number; y: number; ox: number; oy: number} | null>(null);

  // 与 Video3D 相同的默认适配规则：图片 cover / 视频 contain
  const fitMode: FitMode = clip.fit ?? (clip.type === 'image' ? 'cover' : 'contain');
  const scaleLimits = VIEWPORT_SCALE_LIMITS[fitMode];

  // 测量预览画框的实际像素尺寸（几何计算需要 px）
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setFrameSize({w: rect.width, h: rect.height});
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frameAspect]);

  // 基础适配 + 取景合成（与渲染端同一套函数）
  const baseFit = useMemo(
    () => (frameSize ? fitVideo(frameSize.w, frameSize.h, clip.width, clip.height, fitMode) : null),
    [frameSize, clip.width, clip.height, fitMode]
  );
  const placed = useMemo(
    () => (frameSize && baseFit ? applyViewport(frameSize.w, frameSize.h, baseFit, fitMode, viewport) : null),
    [frameSize, baseFit, fitMode, viewport]
  );

  // 更新取景并按当前几何即时夹取（cover 不露边、contain 不出框）
  const updateViewport = useCallback(
    (next: ClipViewport) => {
      if (!frameSize || !baseFit) return;
      setViewport(clampViewport(frameSize.w, frameSize.h, baseFit.width, baseFit.height, fitMode, next));
    },
    [frameSize, baseFit, fitMode]
  );

  // 指针拖拽平移（拖拽距离按画框尺寸换算成 offset 比例，与分辨率无关）
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !frameSize) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {x: e.clientX, y: e.clientY, ox: viewport.offsetX, oy: viewport.offsetY};
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !frameSize) return;
    updateViewport({
      ...viewport,
      offsetX: drag.ox + (e.clientX - drag.x) / frameSize.w,
      offsetY: drag.oy + (e.clientY - drag.y) / frameSize.h,
    });
  };
  const handlePointerUp = () => {
    dragRef.current = null;
  };

  // 滚轮缩放（需非 passive 监听才能阻止页面滚动）
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setViewport((prev) => {
        const rect = el.getBoundingClientRect();
        const base = fitVideo(rect.width, rect.height, clip.width, clip.height, fitMode);
        const scale = Math.min(scaleLimits.max, Math.max(scaleLimits.min, prev.scale * factor));
        return clampViewport(rect.width, rect.height, base.width, base.height, fitMode, {...prev, scale});
      });
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, [clip.width, clip.height, fitMode, scaleLimits]);

  const resetViewport = () => updateViewport(DEFAULT_VIEWPORT);

  const handleSave = () => {
    if (!frameSize || !baseFit) return onSave(undefined);
    const v = clampViewport(frameSize.w, frameSize.h, baseFit.width, baseFit.height, fitMode, viewport);
    // 默认取景不落盘，保持片段数据干净
    onSave(isDefaultViewport(v) ? undefined : v);
  };

  const mediaUrl = toLocalVideoUrl(clip.src);
  const mediaStyle: React.CSSProperties | undefined = placed
    ? {
        width: placed.width,
        height: placed.height,
        transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
        objectFit: fitMode,
      }
    : undefined;

  return (
    <div className="viewport-overlay" onClick={onCancel}>
      <div className="viewport-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="viewport-header">
          <h3>取景</h3>
          <button className="btn-close" onClick={onCancel}><X size={18} /></button>
        </div>
        <p className="viewport-file-name">
          {clip.name} · {fitMode === 'cover' ? '填满画框' : '完整显示'}
        </p>

        {/* 画框预览：按当前片段的 PiP 画框比例 */}
        <div className="viewport-stage">
          <div
            ref={frameRef}
            className="viewport-frame"
            style={{aspectRatio: `${frameAspect}`, '--fa': frameAspect} as React.CSSProperties}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={resetViewport}
          >
            {placed &&
              (clip.type === 'image' ? (
                <img
                  src={mediaUrl}
                  className="viewport-media"
                  style={mediaStyle}
                  draggable={false}
                  alt="取景预览"
                />
              ) : (
                <video
                  src={mediaUrl}
                  className="viewport-media"
                  style={mediaStyle}
                  muted
                  playsInline
                  preload="auto"
                  onLoadedData={(e) => {
                    // 定格在裁剪起点附近的一帧作为代表画面
                    const vid = e.target as HTMLVideoElement;
                    vid.currentTime = Math.min((clip.trimStart || 0) + 0.1, Math.max(vid.duration - 0.1, 0));
                  }}
                />
              ))}
            {/* 九宫格参考线 + 画框边缘 */}
            <div className="viewport-grid" />
          </div>
        </div>

        {/* 缩放控制 */}
        <div className="viewport-controls">
          <span className="viewport-zoom-label">缩放</span>
          <input
            type="range"
            className="viewport-zoom-slider"
            min={scaleLimits.min}
            max={scaleLimits.max}
            step={0.01}
            value={viewport.scale}
            onChange={(e) => updateViewport({...viewport, scale: parseFloat(e.target.value)})}
          />
          <span className="viewport-zoom-value">{viewport.scale.toFixed(2)}×</span>
          <button
            className="viewport-reset-btn"
            style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}}
            onClick={resetViewport}
          >
            <RotateCcw size={13} /> 重置
          </button>
        </div>
        <p className="viewport-hint">拖拽移动画面 · 滚轮缩放 · 双击重置</p>

        {/* 操作按钮 */}
        <div className="viewport-actions">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn-primary" onClick={handleSave}>保存取景</button>
        </div>
      </div>
    </div>
  );
};

export default ClipViewportEditor;
