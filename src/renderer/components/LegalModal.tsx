/**
 * LegalModal — 法律/致谢文本查看弹窗
 * 用于展示使用协议、隐私政策、第三方开源致谢（内容见 legal-content.ts）
 */

import React from 'react';
import {X} from 'lucide-react';
import './LegalModal.css';

interface LegalModalProps {
  title: string;
  content: string;
  onClose: () => void;
}

export const LegalModal: React.FC<LegalModalProps> = ({title, content, onClose}) => {
  return (
    <div className="modal-overlay" onClick={(e) => {e.stopPropagation(); onClose();}}>
      <div className="modal-content legal-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <h2 className="legal-title">{title}</h2>
        <div className="legal-body">{content}</div>
      </div>
    </div>
  );
};

export default LegalModal;
