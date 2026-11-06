/**
 * TextEditor - 纯文字编辑表单（在故事板编辑器的 Tab 中使用）
 */

import React from 'react';
import {useProjectStore} from '../store/projectStore';
import {X} from 'lucide-react';
import {TEXT_ANIM_OPTIONS, type TextAnimPreset} from '../../shared/types';
import './TextEditor.css';

export const TextEditor: React.FC = () => {
  const {text, updateCurrentText, segments, activeSegmentIndex, setCurrentTextAnim} = useProjectStore();
  const {features = []} = text;
  const currentTextAnim = segments[activeSegmentIndex]?.textAnim;

  const handleAddFeature = () => {
    updateCurrentText({features: [...features, '']});
  };

  const handleUpdateFeature = (index: number, value: string) => {
    const updated = [...features];
    updated[index] = value;
    updateCurrentText({features: updated});
  };

  const handleRemoveFeature = (index: number) => {
    updateCurrentText({features: features.filter((_, i) => i !== index)});
  };

  return (
    <div className="text-editor-inline">
      <div className="form-group">
        <label>文字入场动效</label>
        <select
          className="text-anim-select"
          value={currentTextAnim ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setCurrentTextAnim(v === '' ? undefined : (v as TextAnimPreset));
          }}
        >
          <option value="">模板默认</option>
          {['基础', '滑入', '缩放', '特效', '进阶'].map((group) => (
            <optgroup key={group} label={group}>
              {TEXT_ANIM_OPTIONS
                .filter((o) => o.group === group)
                .map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>主标题</label>
        <input
          type="text"
          value={text.title}
          onChange={(e) => updateCurrentText({title: e.target.value})}
          placeholder="例如：AI 智能选片"
          maxLength={30}
        />
      </div>

      <div className="form-group">
        <label>副标题</label>
        <input
          type="text"
          value={text.subtitle || ''}
          onChange={(e) => updateCurrentText({subtitle: e.target.value})}
          placeholder="例如：1秒筛选2000张，找到最佳画面"
          maxLength={60}
        />
      </div>

      <div className="form-group">
        <label>功能要点</label>
        <div className="feature-list">
          {features.map((feat, i) => (
            <div key={i} className="feature-row">
              <span className="feature-bullet">•</span>
              <input
                type="text"
                value={feat}
                onChange={(e) => handleUpdateFeature(i, e.target.value)}
                placeholder={`功能点 ${i + 1}`}
                maxLength={30}
              />
              <button
                className="btn-remove-sm"
                onClick={() => handleRemoveFeature(i)}
                title="删除"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <button className="btn-add-feature" onClick={handleAddFeature}>
          + 添加功能点
        </button>
      </div>

      <div className="form-group">
        <label>品牌/产品名（片尾展示）</label>
        <input
          type="text"
          value={text.brandName || ''}
          onChange={(e) => updateCurrentText({brandName: e.target.value})}
          placeholder="例如：PhotoAgent"
          maxLength={20}
        />
      </div>
    </div>
  );
};

export default TextEditor;
