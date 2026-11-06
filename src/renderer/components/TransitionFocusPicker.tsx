/**
 * TransitionFocusPicker - 运镜转场焦点/倍率编辑器
 *
 * 用于 zoomIn（镜头推进）/ zoomOut（镜头拉远）转场，以及 shapeBloom（形状绽放，只用焦点）：
 * 在「下一片段」的模板缩略图上拖拽选择镜头焦点（运镜对准的目标区域 / 绽放圆心），并可调节倍率。
 * 未手动设置时焦点自动取下一片段视频画框中心（虚线框），点「自动」恢复。
 */

import React, {useCallback, useRef} from 'react';
import {Crosshair, RotateCcw} from 'lucide-react';
import type {Segment, TransitionParams} from '../../shared/types';
import {useProjectStore} from '../store/projectStore';
import {mergeTemplateMetas} from '../../shared/template-registry';
import {
  DEFAULT_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
  getAutoFocus,
  resolveFocus,
} from '../../shared/transition-style';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {resolveTemplateThumbnail} from '../utils/template-thumbnails';
import './TransitionFocusPicker.css';

interface TransitionFocusPickerProps {
  /** 下一片段（焦点画在它的画面上） */
  nextSegment: Segment;
  /** 画布比例预设 id（决定选择框的宽高比） */
  aspectRatioId?: string;
  /** 当前转场参数（focusX/focusY 缺省 = 自动） */
  params: TransitionParams | undefined;
  onChange: (patch: Partial<TransitionParams>) => void;
  /** 是否显示倍率行（仅 zoomIn/zoomOut 用倍率；shapeBloom 传 false），缺省 true */
  showZoom?: boolean;
}

export const TransitionFocusPicker: React.FC<TransitionFocusPickerProps> = ({
  nextSegment,
  aspectRatioId,
  params,
  onChange,
  showZoom = true,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const preset = getAspectRatioPreset(aspectRatioId);
  // 模板 meta：内置 + 自定义 + 市场 + AI 生成（缩略图/说明用）
  const {customTemplates, marketTemplates, generatedTemplates} = useProjectStore.getState();
  const template = mergeTemplateMetas(customTemplates, marketTemplates, generatedTemplates).find((t) => t.id === nextSegment.templateId);
  const thumb = template ? resolveTemplateThumbnail(template.thumbnail) : undefined;

  const layout = nextSegment.layout;
  const autoFocus = getAutoFocus(layout);
  const focus = resolveFocus(params, layout);
  const isAuto = params?.focusX === undefined || params?.focusY === undefined;
  const zoom = clampZoom(params?.zoom ?? DEFAULT_ZOOM);

  // 视频画框矩形（归一化 → 百分比），用于提示「自动焦点」的依据
  const frameRect = layout
    ? {
        left: (autoFocus.x - layout.videoWidthRatio / 2) * 100,
        top: (autoFocus.y - layout.videoHeightRatio / 2) * 100,
        width: layout.videoWidthRatio * 100,
        height: layout.videoHeightRatio * 100,
      }
    : null;

  const updateFromPointer = useCallback(
    (e: React.PointerEvent) => {
      const box = boxRef.current;
      if (!box) return;
      const rect = box.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      onChange({focusX: Math.round(x * 100) / 100, focusY: Math.round(y * 100) / 100});
    },
    [onChange],
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updateFromPointer(e);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (draggingRef.current) updateFromPointer(e);
  };
  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  return (
    <div className="focus-picker">
      <div
        ref={boxRef}
        className="focus-picker-canvas"
        style={{aspectRatio: `${preset.width} / ${preset.height}`}}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="点击/拖拽选择运镜焦点"
      >
        {thumb && <img className="focus-picker-thumb" src={thumb} alt="" draggable={false} />}
        {frameRect && (
          <div
            className="focus-picker-frame"
            style={{
              left: `${frameRect.left}%`,
              top: `${frameRect.top}%`,
              width: `${frameRect.width}%`,
              height: `${frameRect.height}%`,
            }}
          />
        )}
        <div
          className={`focus-picker-dot ${isAuto ? 'auto' : ''}`}
          style={{left: `${focus.x * 100}%`, top: `${focus.y * 100}%`}}
        >
          <Crosshair size={14} />
        </div>
      </div>
      <div className="focus-picker-side">
        <div className="focus-picker-row">
          <span className="focus-picker-label">焦点</span>
          <span className="focus-picker-value">
            {isAuto ? '自动（画框中心）' : `${Math.round(focus.x * 100)}%, ${Math.round(focus.y * 100)}%`}
          </span>
          {!isAuto && (
            <button
              className="focus-picker-reset"
              onClick={() => onChange({focusX: undefined, focusY: undefined})}
              title="恢复自动焦点（下一片段视频画框中心）"
            >
              <RotateCcw size={12} /> 自动
            </button>
          )}
        </div>
        {showZoom && (
          <div className="focus-picker-row">
            <span className="focus-picker-label">倍率</span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.1}
              value={zoom}
              onChange={(e) => onChange({zoom: Number(e.target.value)})}
            />
            <span className="focus-picker-value">{zoom.toFixed(1)}x</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default TransitionFocusPicker;
