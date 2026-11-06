/**
 * GuidedTour - 新手引导教程（全屏黑遮罩 + 指引卡 + 箭头指向目标元素）
 *
 * - 首次启动自动播放（App 检测 localStorage 键），关于页「重播新手教程」可再看
 * - 步骤表见 tour-steps.ts（buildTourSteps）；步骤推进时自动切换应用页面
 * - 带做模式：步骤可带主行动按钮（打开示例工程/换素材/开 AI 面板），真的去执行；
 *   执行完成自动进下一步（返回 false = 停留），用户也可以只点「下一步」跳过动作
 * - 指引卡贴着目标元素（下方优先，放不下放上方），箭头指向目标；目标找不到时居中无箭头
 */
import React, {useEffect, useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {GENRE_RECOMMENDED_IDS} from '../../shared/template-registry';
import {buildTourSteps} from './tour-steps';
import './GuidedTour.css';

const CARD_W = 340;
const CARD_H_EST = 260; // 卡片高度估计（放置决策用；带做版卡片含主行动按钮实测 ~258，实际高度自适应）

export const GuidedTour: React.FC<{open: boolean; onClose: () => void; onOpenAiPanel?: () => void}> = ({
  open,
  onClose,
  onOpenAiPanel,
}) => {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<{top: number; left: number; width: number; height: number; bottom: number} | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const steps = buildTourSteps({openAiPanel: onOpenAiPanel ?? (() => {}), closeTour: onClose});
  const step = steps[Math.min(idx, steps.length - 1)];
  const appStep = useProjectStore((s) => s.step);

  // 打开时从第一步开始
  useEffect(() => {
    if (open) {
      setIdx(0);
      setRect(null);
    }
  }, [open]);

  // 步骤推进：先切页面（故事板需要已选模板），量位置等渲染后再做
  useEffect(() => {
    if (!open || !step) return;
    const s = useProjectStore.getState();
    if (step.appStep !== s.step) {
      if (step.appStep === 2 && !s.templateId) {
        s.selectFirstTemplate(GENRE_RECOMMENDED_IDS[s.videoType][0]);
      }
      s.syncCurrentToSegment();
      s.setStep(step.appStep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idx]);

  // 量目标位置：等页面切换渲染完（120ms）；窗口变化时重测
  useEffect(() => {
    if (!open || !step) return;
    const measure = () => {
      const el = step.target ? document.querySelector(step.target) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom});
      } else {
        setRect(null);
      }
    };
    const t = setTimeout(measure, 120);
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [open, idx, appStep, step]);

  if (!open || !step) return null;

  // 放置：目标下方优先（箭头朝上指向目标），放不下放上方；水平夹在视口内；箭头跟随目标中心
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top: number;
  let arrow: 'up' | 'down' | null = null;
  if (rect) {
    const preferBelow = rect.bottom + 16 + CARD_H_EST < vh;
    if (preferBelow) {
      top = rect.bottom + 16;
      arrow = 'up';
    } else {
      top = Math.max(76, rect.top - CARD_H_EST - 16);
      arrow = 'down';
    }
    top = Math.min(top, Math.max(76, vh - CARD_H_EST - 24));
  } else {
    top = vh / 2 - CARD_H_EST / 2;
  }
  const left = rect ? Math.min(Math.max(16, rect.left + rect.width / 2 - CARD_W / 2), vw - CARD_W - 16) : vw / 2 - CARD_W / 2;
  const arrowLeft = rect ? Math.min(CARD_W - 28, Math.max(28, rect.left + rect.width / 2 - left)) : CARD_W / 2;

  const next = () => {
    if (idx >= steps.length - 1) onClose();
    else setIdx(idx + 1);
  };

  /** 主行动按钮：执行动作，完成（返回值非 false）则自动进下一步 */
  const runAction = async () => {
    if (!step.action || actionBusy) return;
    setActionBusy(true);
    try {
      const r = await step.action.run();
      if (r !== false) next();
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="gt-overlay" onClick={next}>
      <div
        className="gt-card"
        style={{top, left, width: CARD_W}}
        onClick={(e) => e.stopPropagation()}
      >
        {arrow && <span className={`gt-arrow gt-arrow-${arrow}`} style={{left: arrowLeft}} />}
        <span className="gt-progress">{idx + 1} / {steps.length}</span>
        <h3 className="gt-title">{step.title}</h3>
        <p className="gt-body">{step.body}</p>
        {step.action && (
          <button className="gt-action" disabled={actionBusy} onClick={runAction}>
            {actionBusy ? '处理中…' : step.action.label}
          </button>
        )}
        <div className="gt-actions">
          <button className="gt-btn gt-skip" onClick={onClose}>跳过教程</button>
          <div className="gt-actions-right">
            {idx > 0 && (
              <button className="gt-btn" onClick={() => setIdx(idx - 1)}>上一步</button>
            )}
            <button className="gt-btn gt-next" onClick={next}>
              {idx >= steps.length - 1 ? '完成' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GuidedTour;
