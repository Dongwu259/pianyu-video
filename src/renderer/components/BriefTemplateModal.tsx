/**
 * BriefTemplateModal - 场景提示词模板（三期后半 · 官方提示词模板商店）
 *
 * 用户选场景 → 填 3-6 个空 → buildBrief 扩写成含镜头结构/节奏/文案风格的完整 brief，
 * 「填入输入框」后由用户确认发送，驱动 AI 一键成片。模板定义在 shared/brief-templates.ts。
 */

import React, {useMemo, useState} from 'react';
import {X, Sparkles, ClipboardPaste} from 'lucide-react';
import {BRIEF_TEMPLATES, type BriefTemplate} from '../../shared/brief-templates';
import './BriefTemplateModal.css';

interface BriefTemplateModalProps {
  onInsert: (brief: string) => void;
  onClose: () => void;
}

export const BriefTemplateModal: React.FC<BriefTemplateModalProps> = ({onInsert, onClose}) => {
  const [selectedId, setSelectedId] = useState(BRIEF_TEMPLATES[0].id);
  const [values, setValues] = useState<Record<string, string>>({});
  const tpl: BriefTemplate = useMemo(
    () => BRIEF_TEMPLATES.find((t) => t.id === selectedId) ?? BRIEF_TEMPLATES[0],
    [selectedId],
  );

  const setValue = (key: string, v: string) => setValues((prev) => ({...prev, [key]: v}));

  // 必填判定：无 fallback 的空位必须填写（产品名/卖点等核心信息）
  const missing = tpl.blanks.filter((b) => b.fallback === undefined && !(values[b.key] ?? '').trim());
  const brief = useMemo(() => tpl.buildBrief(values), [tpl, values]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content brief-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <div className="brief-header">
          <Sparkles size={16} />
          <div>
            <h3>场景提示词模板</h3>
            <p>选场景、填几个空，自动生成完整创作 brief 填入输入框</p>
          </div>
        </div>

        <div className="brief-body">
          <div className="brief-templates">
            {BRIEF_TEMPLATES.map((t) => (
              <button
                key={t.id}
                className={`brief-template-item ${t.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(t.id)}
              >
                <span className="brief-template-name">{t.name}</span>
                <span className="brief-template-desc">{t.desc}</span>
              </button>
            ))}
          </div>

          <div className="brief-form">
            {tpl.blanks.map((b) => (
              <label key={b.key} className="brief-field">
                <span className="brief-field-label">
                  {b.label}
                  {b.fallback === undefined && <em>*</em>}
                </span>
                <input
                  type="text"
                  value={values[b.key] ?? ''}
                  placeholder={b.placeholder}
                  onChange={(e) => setValue(b.key, e.target.value)}
                />
              </label>
            ))}

            <details className="brief-preview">
              <summary>预览生成的 brief</summary>
              <pre>{brief}</pre>
            </details>
          </div>
        </div>

        <div className="brief-footer">
          <span className="brief-footer-hint">
            {missing.length > 0 ? `还需填写：${missing.map((b) => b.label).join('、')}` : '填入后可继续修改，确认无误再发送'}
          </span>
          <button
            className="ai-btn-primary"
            disabled={missing.length > 0}
            onClick={() => { onInsert(brief); onClose(); }}
          >
            <ClipboardPaste size={14} /> 填入输入框
          </button>
        </div>
      </div>
    </div>
  );
};

export default BriefTemplateModal;
