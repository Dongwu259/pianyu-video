/**
 * CurveEditorModal - 缓动曲线编辑大窗（portal 弹窗）
 *
 * 故事板区的内嵌面板太窄，拖控制点难受；这里给曲线一块 ~720px 宽的大画布
 * （CurveEditor 的 SVG 本身 width:100%，容器多宽画布就多大）。Esc / 点遮罩关闭。
 */
import React, {useEffect} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import {CurveEditor} from './CurveEditor';
import type {EasingCurve} from '../../shared/easing-curve';
import './CurveEditorModal.css';

export const CurveEditorModal: React.FC<{
  open: boolean;
  title: string;
  curve: EasingCurve;
  onChange: (curve: EasingCurve) => void;
  onClose: () => void;
}> = ({open, title, curve, onChange, onClose}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="curvem-overlay" onClick={onClose}>
      <div className="curvem-card" onClick={(e) => e.stopPropagation()}>
        <div className="curvem-head">
          <span className="curvem-title">{title}</span>
          <button className="curvem-close" onClick={onClose} title="关闭（Esc）">
            <X size={16} />
          </button>
        </div>
        <div className="curvem-body">
          <CurveEditor curve={curve} onChange={onChange} />
        </div>
        <p className="curvem-hint">
          这是「进度曲线」：横轴 = 转场进度，纵轴 = 完成度，所以永远从左下走到右上——不同曲线的差别在中段的快慢与回弹（缓出=先快后慢、缓入=先慢后快、闪弹=末段回弹）。
          打开时显示的是该转场当前的默认节奏；拖动中间点改速度、空白处点击加点、双击中间点删除。
        </p>
      </div>
    </div>,
    document.body,
  );
};
