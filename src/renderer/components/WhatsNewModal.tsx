/**
 * WhatsNewModal — 「What's New 更新内容」弹窗
 *
 * 两处触发：版本升级后首次启动由 App 自动弹出；「关于」页的「更新日志」入口手动打开。
 * 亮点数据来自 whats-new-content.ts，按传入的 version 取对应版本的日志。
 */

import React from 'react';
import {Sparkles, X} from 'lucide-react';
import {BrandIcon} from './BrandIcon';
import {getWhatsNewForVersion} from '../whats-new-content';
import './WhatsNewModal.css';

interface WhatsNewModalProps {
  /** 当前运行版本号（经 window.api.getAppInfo() 获取） */
  version: string;
  onClose: () => void;
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({version, onClose}) => {
  const release = getWhatsNewForVersion(version);
  // 该版本没有更新日志数据时不渲染（调用方一般已先行判断，这里兜底）
  if (!release) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content whats-new-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>

        <div className="whats-new-hero">
          <div className="whats-new-logo"><BrandIcon size={60} /></div>
          <h2 className="whats-new-title">v{release.version} 更新内容</h2>
          <p className="whats-new-subtitle">感谢更新，看看这一版的新变化</p>
        </div>

        <ul className="whats-new-list">
          {release.highlights.map((h) => (
            <li key={h.title} className="whats-new-item">
              <Sparkles size={14} className="whats-new-item-icon" />
              <div className="whats-new-item-body">
                <p className="whats-new-item-title">{h.title}</p>
                <p className="whats-new-item-desc">{h.desc}</p>
              </div>
            </li>
          ))}
        </ul>

        <button type="button" className="whats-new-start-btn" onClick={onClose}>
          开始使用
        </button>
      </div>
    </div>
  );
};

export default WhatsNewModal;
