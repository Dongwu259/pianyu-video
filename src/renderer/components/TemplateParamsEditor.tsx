/**
 * TemplateParamsEditor — 模板个性化参数编辑器
 *
 * 按当前模板的 paramSpecs（shared/template-registry.ts）动态渲染滑块，
 * 写入当前片段工作副本 customParams（Segment.customParams）。
 * 值语义：未调整过的参数不落盘，读取时回退规格默认值（模板内 makeParamReader 同样回退）。
 */

import React from 'react';
import {useProjectStore} from '../store/projectStore';
import {TEMPLATES, isCustomTemplateId, isMarketTemplateId, customTemplateToMeta, marketPackToMeta} from '../../shared/template-registry';
import {cleanParamLabel} from '../../shared/param-options';
import type {TemplateMeta, TemplateParamSpec} from '../../shared/types';
import {SlidersHorizontal, LayoutTemplate} from 'lucide-react';
import './LayoutEditor.css';

/** 数值显示：按 step 精度收敛，去除浮点尾巴（如 0.1500000002 -> 0.15） */
const fmt = (v: number, step: number): string => {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(decimals);
};

export const TemplateParamsEditor: React.FC = () => {
  const {templateId, customParams, updateCurrentCustomParam, syncCurrentToSegment, customTemplates, marketTemplates} = useProjectStore();

  // 模板 meta 查找：内置 → 自定义 → 市场（数据驱动模板有 paramSpecs 时也渲染滑块）
  let meta: TemplateMeta | undefined = TEMPLATES.find((t) => t.id === templateId);
  const isCustom = templateId ? isCustomTemplateId(templateId) : false;
  const isMarket = templateId ? isMarketTemplateId(templateId) : false;
  if (!meta && templateId) {
    if (isCustom) {
      const def = customTemplates.find((t) => t.id === templateId);
      if (def) meta = customTemplateToMeta(def);
    } else if (isMarket) {
      const pack = marketTemplates.find((t) => t.id === templateId);
      if (pack) meta = marketPackToMeta(pack);
    }
  }
  const specs = meta?.paramSpecs ?? [];

  // 数据驱动模板且没有参数：提示去模板编辑器调整（市场模板只读，给另一句提示）
  if ((isCustom || isMarket) && specs.length === 0) {
    return (
      <div className="layout-editor">
        <div className="layout-section" style={{textAlign: 'center', padding: '32px 16px'}}>
          <LayoutTemplate size={28} style={{marginBottom: 12, opacity: 0.5}} />
          <p style={{fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7, margin: 0}}>
            {isCustom ? (
              <>当前为<strong>自定义模板</strong>，其元素大小/位置/动画在「模板编辑器」中调整。</>
            ) : (
              <>当前为<strong>云端模板</strong>，该模板没有暴露可调参数。</>
            )}
          </p>
        </div>
      </div>
    );
  }

  if (!meta || specs.length === 0) {
    return (
      <div className="layout-editor">
        <div className="layout-section" style={{textAlign: 'center', padding: '32px 16px'}}>
          <SlidersHorizontal size={28} style={{marginBottom: 12, opacity: 0.5}} />
          <p style={{fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7, margin: 0}}>
            该模板没有可调参数。
          </p>
          {meta?.usageTip && (
            <p style={{fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.7, margin: '12px 0 0', textAlign: 'left'}}>
              💡 {meta.usageTip}
            </p>
          )}
        </div>
      </div>
    );
  }

  const valueOf = (spec: TemplateParamSpec): number => customParams[spec.key] ?? spec.default;
  const hasCustom = specs.some((s) => customParams[s.key] !== undefined);

  return (
    <div className="layout-editor">
      <div className="layout-section">
        <h4>
          <SlidersHorizontal size={14} /> {meta.name} · 模板参数
        </h4>
        <p style={{fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px', lineHeight: 1.6}}>
          调整本片段中「{meta.name}」模板的元素大小与动画幅度，未调整的项保持模板默认。
        </p>
        {meta.usageTip && (
          <p style={{fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px', lineHeight: 1.7, background: 'var(--color-bg-soft)', padding: '8px 10px', borderRadius: 6}}>
            💡 {meta.usageTip}
          </p>
        )}
        {specs.map((spec) => {
          const value = valueOf(spec);
          const unit = spec.unit ?? '×';
          const isDefault = customParams[spec.key] === undefined;
          const setValue = (v: number): void => {
            // 选回默认值时清除该键，保持工程数据干净
            updateCurrentCustomParam(spec.key, v === spec.default ? undefined : v);
            syncCurrentToSegment();
          };
          // 离散档位参数（主题色/字体/驻留节奏/运镜…）：渲染选项组而非数字滑块
          if (spec.options) {
            return (
              <div className="layout-slider-row param-option-row" key={spec.key}>
                <div className="slider-header">
                  <span className="slider-label">{cleanParamLabel(spec.label)}</span>
                  {!isDefault && (
                    <button
                      className="btn-reset"
                      onClick={() => {
                        updateCurrentCustomParam(spec.key, undefined);
                        syncCurrentToSegment();
                      }}
                      title="恢复默认"
                    >
                      ↺
                    </button>
                  )}
                </div>
                <div className="param-option-group" role="radiogroup" aria-label={cleanParamLabel(spec.label)}>
                  {spec.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="radio"
                      aria-checked={value === o.value}
                      className={`param-option-chip ${value === o.value ? 'on' : ''}`}
                      title={`${o.label}${o.value === spec.default ? '（默认）' : ''}`}
                      onClick={() => setValue(o.value)}
                    >
                      {o.color && <span className="param-option-dot" style={{background: o.color}} />}
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div className="layout-slider-row" key={spec.key}>
              <div className="slider-header">
                <span className="slider-label">{spec.label}</span>
                <span className="slider-value">
                  {fmt(value, spec.step)}{unit}
                  {!isDefault && (
                    <button
                      className="btn-reset"
                      onClick={() => {
                        updateCurrentCustomParam(spec.key, undefined);
                        syncCurrentToSegment();
                      }}
                      title="恢复默认"
                    >
                      ↺
                    </button>
                  )}
                </span>
              </div>
              <input
                type="range"
                className="layout-slider"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={value}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  // 滑回默认值时清除该键，保持工程数据干净
                  updateCurrentCustomParam(spec.key, v === spec.default ? undefined : v);
                }}
                onMouseUp={() => syncCurrentToSegment()}
                onTouchEnd={() => syncCurrentToSegment()}
              />
            </div>
          );
        })}
        {hasCustom && (
          <button
            className="btn-clear-aspect"
            onClick={() => {
              specs.forEach((s) => updateCurrentCustomParam(s.key, undefined));
              syncCurrentToSegment();
            }}
          >
            全部恢复默认
          </button>
        )}
      </div>
    </div>
  );
};

export default TemplateParamsEditor;
