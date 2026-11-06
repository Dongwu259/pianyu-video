/**
 * StyleEditor - 每片段视觉样式编辑器
 * 功能: 背景色、各文字的字号/颜色/粗细/下划线/斜体
 */

import React from 'react';
import {useProjectStore} from '../store/projectStore';
import type {PromoStyle, TextStyle} from '../../shared/types';
import {Palette, Heading, Type, ListChecks, Tag} from 'lucide-react';
import './StyleEditor.css';

const COLOR_PRESETS = [
  {label: '默认', value: ''},
  {label: '白', value: '#FFFFFF'},
  {label: '浅灰', value: '#F8F9FA'},
  {label: '深蓝', value: '#1A1A2E'},
  {label: '纯黑', value: '#000000'},
  {label: '品牌蓝', value: '#2563EB'},
  {label: '墨绿', value: '#065F46'},
  {label: '酒红', value: '#991B1B'},
  {label: '渐变蓝', value: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'},
  {label: '渐变橙', value: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'},
  {label: '渐变青', value: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'},
  {label: '深紫', value: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)'},
];

const TEXT_COLORS = [
  {label: '默认', value: ''},
  {label: '深灰', value: '#111827'},
  {label: '中灰', value: '#6B7280'},
  {label: '白', value: '#FFFFFF'},
  {label: '品牌蓝', value: '#2563EB'},
  {label: '橙', value: '#EA580C'},
  {label: '绿', value: '#059669'},
  {label: '紫', value: '#7C3AED'},
  {label: '红', value: '#DC2626'},
];

const FONT_SIZES = [
  {label: '默认', value: 0},
  {label: '小（36px）', value: 36},
  {label: '中（48px）', value: 48},
  {label: '大（64px）', value: 64},
  {label: '特大（80px）', value: 80},
];

const FONT_WEIGHTS = [
  {label: '默认', value: 0},
  {label: '细（300）', value: 300},
  {label: '常规（400）', value: 400},
  {label: '半粗（600）', value: 600},
  {label: '粗（700）', value: 700},
  {label: '特粗（800）', value: 800},
];

const STROKE_WIDTHS = [
  {label: '无', value: 0},
  {label: '细（1px）', value: 1},
  {label: '中（2px）', value: 2},
  {label: '粗（3px）', value: 3},
  {label: '特粗（4px）', value: 4},
];

const TextStyleField: React.FC<{
  value: TextStyle;
  onChange: (t: Partial<TextStyle>) => void;
}> = ({value, onChange}) => {
  return (
    <div className="text-style-fields">
      <div className="style-row">
        <label>字号</label>
        <select
          value={value.fontSize || 0}
          onChange={(e) => onChange({fontSize: Number(e.target.value) || undefined})}
        >
          {FONT_SIZES.map((opt) => (
            <option key={opt.label} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="style-row">
        <label>字重</label>
        <select
          value={value.fontWeight || 0}
          onChange={(e) => onChange({fontWeight: Number(e.target.value) || undefined})}
        >
          {FONT_WEIGHTS.map((opt) => (
            <option key={opt.label} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="style-row">
        <label>颜色</label>
        <div className="color-picker-inline">
          <input
            type="color"
            value={value.color || '#111827'}
            onChange={(e) => onChange({color: e.target.value})}
          />
          <div className="color-presets-mini">
            {TEXT_COLORS.map((p) => (
              <button
                key={p.label}
                className={`color-dot ${(value.color || '') === p.value ? 'active' : ''}`}
                style={{background: p.value || '#111827'}}
                title={p.label}
                onClick={() => onChange({color: p.value || undefined})}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="style-row">
        <label>描边</label>
        <select
          value={value.strokeWidth || 0}
          onChange={(e) => onChange({strokeWidth: Number(e.target.value) || undefined})}
        >
          {STROKE_WIDTHS.map((opt) => (
            <option key={opt.label} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div className="color-picker-inline">
          <input
            type="color"
            value={value.strokeColor || '#000000'}
            onChange={(e) => onChange({strokeColor: e.target.value})}
          />
          <div className="color-presets-mini">
            {TEXT_COLORS.map((p) => (
              <button
                key={p.label}
                className={`color-dot ${(value.strokeColor || '') === p.value ? 'active' : ''}`}
                style={{background: p.value || '#000000'}}
                title={p.label}
                onClick={() => onChange({strokeColor: p.value || undefined})}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="style-row style-row-check">
        <label>
          <input
            type="checkbox"
            checked={value.textDecoration === 'underline'}
            onChange={(e) => onChange({textDecoration: e.target.checked ? 'underline' : undefined})}
          />
          下划线
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.fontStyle === 'italic'}
            onChange={(e) => onChange({fontStyle: e.target.checked ? 'italic' : undefined})}
          />
          斜体
        </label>
      </div>
    </div>
  );
};

export const StyleEditor: React.FC = () => {
  const {style, updateCurrentStyle} = useProjectStore();

  const handleTextStyle = (
    key: 'title' | 'subtitle' | 'feature' | 'brand',
    partial: Partial<TextStyle>
  ) => {
    const current = style[key] || {};
    const merged = {...current, ...partial};
    updateCurrentStyle({[key]: {...merged}});
  };

  return (
    <div className="style-editor">
      <div className="style-section">
        <h4><Palette size={14} /> 背景</h4>
        <div className="color-presets-grid">
          {COLOR_PRESETS.map((p) => (
            <button
              key={p.label}
              className={`color-preset-btn ${(style.background || '') === p.value ? 'active' : ''}`}
              style={{background: p.value || '#F8F9FA'}}
              onClick={() => updateCurrentStyle({background: p.value || undefined})}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="style-section">
        <h4><Heading size={14} /> 标题</h4>
        <TextStyleField
          value={style.title || {}}
          onChange={(t) => handleTextStyle('title', t)}
        />
      </div>

      <div className="style-section">
        <h4><Type size={14} /> 副标题</h4>
        <TextStyleField
          value={style.subtitle || {}}
          onChange={(t) => handleTextStyle('subtitle', t)}
        />
      </div>

      <div className="style-section">
        <h4><ListChecks size={14} /> 功能要点</h4>
        <TextStyleField
          value={style.feature || {}}
          onChange={(t) => handleTextStyle('feature', t)}
        />
      </div>

      <div className="style-section">
        <h4><Tag size={14} /> 品牌名</h4>
        <TextStyleField
          value={style.brand || {}}
          onChange={(t) => handleTextStyle('brand', t)}
        />
      </div>
    </div>
  );
};

export default StyleEditor;
