/**
 * LayoutEditor — 模板布局参数编辑器
 * 视频尺寸/位置/3D旋转/透视/缩放/圆角 + 画布比例/自定义分辨率
 */

import React, {useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import type {TemplateLayout} from '../../shared/types';
import {isDataDrivenTemplateId} from '../../shared/template-registry';
import {Maximize, Crosshair, RotateCw, SlidersHorizontal, Ruler, Image, LayoutTemplate} from 'lucide-react';
import './LayoutEditor.css';

const ASPECT_PRESETS = [
  {label: '16:9', x: 16, y: 9},
  {label: '9:16', x: 9, y: 16},
  {label: '1:1', x: 1, y: 1},
  {label: '4:3', x: 4, y: 3},
  {label: '21:9', x: 21, y: 9},
  {label: '4:5', x: 4, y: 5},
];

const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  onReset?: () => void;
  defaultValue?: number;
}> = ({label, value, min, max, step, unit, onChange, onReset, defaultValue}) => (
  <div className="layout-slider-row">
    <div className="slider-header">
      <span className="slider-label">{label}</span>
      <span className="slider-value">
        {value}{unit || ''}
        {onReset && defaultValue !== undefined && value !== defaultValue && (
          <button className="btn-reset" onClick={onReset} title="恢复默认">↺</button>
        )}
      </span>
    </div>
    <input
      type="range"
      className="layout-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  </div>
);

export const LayoutEditor: React.FC = () => {
  const {layout, updateCurrentLayout, orientation, templateId} = useProjectStore();
  const [showAspectInput, setShowAspectInput] = useState(false);
  const [aspectX, setAspectX] = useState(16);
  const [aspectY, setAspectY] = useState(9);

  const set = (partial: Partial<TemplateLayout>) => updateCurrentLayout(partial);

  // 自定义/市场模板的布局由其元素（位置/尺寸/关键帧）决定，在「模板编辑器」里调整；
  // 这里的视频尺寸/旋转等参数仅对内置模板生效，故提示以免误以为调整无效。
  if (templateId && isDataDrivenTemplateId(templateId)) {
    return (
      <div className="layout-editor">
        <div className="layout-section" style={{textAlign: 'center', padding: '32px 16px'}}>
          <LayoutTemplate size={28} style={{marginBottom: 12, opacity: 0.5}} />
          <p style={{fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7, margin: 0}}>
            当前为<strong>自定义模板</strong>，其布局由各元素的位置/尺寸/关键帧决定。<br />
            请在「模板编辑器」中调整元素；此处参数仅对内置模板生效。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="layout-editor">

      {/* 视频画框尺寸 */}
      <div className="layout-section">
        <h4><Maximize size={14} /> 视频尺寸（占画布比例）</h4>
        <SliderRow
          label="宽度" value={layout.videoWidthRatio}
          min={0.1} max={1} step={0.05} unit="%"
          onChange={(v) => set({videoWidthRatio: v})}
          onReset={() => set({videoWidthRatio: 0.6})} defaultValue={0.6}
        />
        <SliderRow
          label="高度" value={layout.videoHeightRatio}
          min={0.1} max={1} step={0.05} unit="%"
          onChange={(v) => set({videoHeightRatio: v})}
          onReset={() => set({videoHeightRatio: 0.5})} defaultValue={0.5}
        />
        <SliderRow
          label="整体缩放" value={layout.scale}
          min={0.5} max={2} step={0.1} unit="×"
          onChange={(v) => set({scale: v})}
          onReset={() => set({scale: 1})} defaultValue={1}
        />
      </div>

      {/* 位置偏移 */}
      <div className="layout-section">
        <h4><Crosshair size={14} /> 位置偏移</h4>
        <SliderRow
          label="水平" value={layout.videoOffsetX}
          min={-0.5} max={0.5} step={0.05} unit="%"
          onChange={(v) => set({videoOffsetX: v})}
          onReset={() => set({videoOffsetX: 0})} defaultValue={0}
        />
        <SliderRow
          label="垂直" value={layout.videoOffsetY}
          min={-0.5} max={0.5} step={0.05} unit="%"
          onChange={(v) => set({videoOffsetY: v})}
          onReset={() => set({videoOffsetY: 0})} defaultValue={0}
        />
      </div>

      {/* 3D 旋转 */}
      <div className="layout-section">
        <h4><RotateCw size={14} /> 3D 旋转（度）</h4>
        <SliderRow
          label="X 轴（俯仰）" value={layout.rotateX}
          min={-30} max={30} step={1} unit="°"
          onChange={(v) => set({rotateX: v})}
          onReset={() => set({rotateX: 5})} defaultValue={5}
        />
        <SliderRow
          label="Y 轴（偏航）" value={layout.rotateY}
          min={-30} max={30} step={1} unit="°"
          onChange={(v) => set({rotateY: v})}
          onReset={() => set({rotateY: 0})} defaultValue={0}
        />
        <SliderRow
          label="Z 轴（翻滚）" value={layout.rotateZ}
          min={-30} max={30} step={1} unit="°"
          onChange={(v) => set({rotateZ: v})}
          onReset={() => set({rotateZ: 0})} defaultValue={0}
        />
      </div>

      {/* 透视 + 缩放 + 圆角 */}
      <div className="layout-section">
        <h4><SlidersHorizontal size={14} /> 透视与圆角</h4>
        <SliderRow
          label="透视距离" value={layout.perspective}
          min={500} max={3000} step={100} unit="px"
          onChange={(v) => set({perspective: v})}
          onReset={() => set({perspective: 1200})} defaultValue={1200}
        />
        <SliderRow
          label="边框圆角" value={layout.borderRadius}
          min={0} max={48} step={2} unit="px"
          onChange={(v) => set({borderRadius: v})}
          onReset={() => set({borderRadius: 12})} defaultValue={12}
        />
      </div>

      {/* 自定义画布比例 */}
      <div className="layout-section">
        <h4><Ruler size={14} /> 画布比例</h4>
        <div className="aspect-presets">
          {ASPECT_PRESETS.map((p) => (
            <button
              key={p.label}
              className={`aspect-preset-btn ${
                layout.customAspect?.x === p.x && layout.customAspect?.y === p.y ? 'active' : ''
              }`}
              onClick={() => set({customAspect: {x: p.x, y: p.y}})}
            >
              {p.label}
            </button>
          ))}
          <button
            className={`aspect-preset-btn ${showAspectInput ? 'active' : ''}`}
            onClick={() => setShowAspectInput(!showAspectInput)}
          >
            自定义
          </button>
        </div>
        {showAspectInput && (
          <div className="custom-aspect-input">
            <input
              type="number" min={1} max={99} value={aspectX}
              onChange={(e) => {setAspectX(Number(e.target.value) || 1); set({customAspect: {x: Number(e.target.value) || 1, y: aspectY}})}}
            />
            <span>:</span>
            <input
              type="number" min={1} max={99} value={aspectY}
              onChange={(e) => {setAspectY(Number(e.target.value) || 1); set({customAspect: {x: aspectX, y: Number(e.target.value) || 1}})}}
            />
          </div>
        )}
        {layout.customAspect && (
          <button className="btn-clear-aspect" onClick={() => set({customAspect: undefined})}>
            清除自定义比例（使用 {orientation === 'landscape' ? '16:9' : '9:16'}）
          </button>
        )}
      </div>

      {/* 自定义分辨率 */}
      <div className="layout-section">
        <h4><Image size={14} /> 自定义分辨率（像素）</h4>
        <div className="custom-resolution">
          <div className="res-input-group">
            <label>宽</label>
            <input
              type="number"
              min={100} max={4096} step={2}
              value={layout.customResolution?.width || ''}
              placeholder={orientation === 'landscape' ? '1920' : '1080'}
              onChange={(e) => {
                const w = Number(e.target.value);
                const h = layout.customResolution?.height || (orientation === 'landscape' ? 1080 : 1920);
                setCustomResolutionInput(w, h, set);
              }}
            />
          </div>
          <span className="res-sep">×</span>
          <div className="res-input-group">
            <label>高</label>
            <input
              type="number"
              min={100} max={4096} step={2}
              value={layout.customResolution?.height || ''}
              placeholder={orientation === 'landscape' ? '1080' : '1920'}
              onChange={(e) => {
                const h = Number(e.target.value);
                const w = layout.customResolution?.width || (orientation === 'landscape' ? 1920 : 1080);
                setCustomResolutionInput(w, h, set);
              }}
            />
          </div>
        </div>
        {layout.customResolution && (
          <button className="btn-clear-aspect" onClick={() => set({customResolution: undefined})}>
            清除自定义分辨率
          </button>
        )}
      </div>
    </div>
  );
};

function setCustomResolutionInput(w: number, h: number, set: (p: Partial<{customResolution: {width: number; height: number} | undefined}>) => void) {
  if (w >= 100 && h >= 100) {
    set({customResolution: {width: w, height: h}});
  } else if (!w && !h) {
    set({customResolution: undefined});
  }
}

export default LayoutEditor;
