/**
 * SampleSwapBanner - 示例工程提示条（故事板顶部）
 *
 * 打开内置示例工程后出现：「这是示例工程 → 一键把各片段换成你自己的素材」。
 * 替换成功或用户点「知道了」后消失（本会话内不再打扰）。
 */
import React, {useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {pickAndReplaceSampleMedia} from '../utils/sampleSwap';
import {ImageUp, X} from 'lucide-react';
import './SampleSwapBanner.css';

export const SampleSwapBanner: React.FC = () => {
  const isSample = useProjectStore((s) => s.isSampleProject);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!isSample || dismissed) return null;

  return (
    <div className="sample-swap-banner">
      <span className="ssb-text">
        这是<b>内置示例工程</b>——模板、文案、配乐都配好了，把素材换成你自己的就是第一条片子。
      </span>
      <div className="ssb-actions">
        <button
          className="btn-primary ssb-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void pickAndReplaceSampleMedia().finally(() => setBusy(false));
          }}
        >
          <ImageUp size={14} /> {busy ? '处理中…' : '一键换成你的素材'}
        </button>
        <button className="ssb-dismiss" title="不再提示" onClick={() => setDismissed(true)}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
