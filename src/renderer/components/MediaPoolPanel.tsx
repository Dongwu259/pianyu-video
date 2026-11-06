/**
 * MediaPoolPanel - 项目素材库（全局素材池）
 *
 * 「导入一次、全工程复用」：素材导入库后可反复加入任何片段（点缩略图 = 加进当前片段），
 * 「自动配段」把库内素材按「缺素材的片段优先」轮流分配；AI 一键成片的素材分配同样
 * 会把库内素材计入可用素材。随工程文件持久化（.vtproj mediaPool 字段）。
 */
import React, {useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {useUIStore} from '../store/uiStore';
import {Library, ImagePlus, Wand2, Plus, X, Film} from 'lucide-react';
import './MediaPoolPanel.css';

const freshId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const MediaPoolPanel: React.FC = () => {
  const mediaPool = useProjectStore((s) => s.mediaPool);
  const addToMediaPool = useProjectStore((s) => s.addToMediaPool);
  const removeFromMediaPool = useProjectStore((s) => s.removeFromMediaPool);
  const distributeMediaPool = useProjectStore((s) => s.distributeMediaPool);
  const [busy, setBusy] = useState(false);

  const handleImport = async () => {
    setBusy(true);
    try {
      const selected = await window.api.selectVideos();
      if (selected && selected.length > 0) {
        addToMediaPool(selected);
        // P0-1 体裁自动路由：从未设定过体裁的新工程 + 实拍占多数 → vlog（一次性，可见提示不静默）
        const routed = useProjectStore.getState().maybeAutoRouteVideoType();
        useUIStore.getState().setStatusText(
          routed
            ? `已导入 ${selected.length} 条素材到素材库。检测到实拍素材为主，工程体裁已从「产品宣传片」自动切到「生活 vlog」——AI 工作流与模板推荐随体裁变化，可在故事板上方体裁下拉改回`
            : `已导入 ${selected.length} 条素材到素材库`,
        );
        const codecWarnings = selected.filter((v) => v.codecWarning).map((v) => v.codecWarning as string);
        if (codecWarnings.length > 0) window.alert(codecWarnings.join('\n'));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDistribute = () => {
    const {assigned, unmet} = distributeMediaPool();
    useUIStore.getState().setStatusText(
      unmet > 0
        ? `自动配段：已分配 ${assigned} 条素材；素材不够，还有 ${unmet} 个片段空着（可再导入或手动上传）`
        : `自动配段：已分配 ${assigned} 条素材`,
    );
  };

  return (
    <section className="media-pool">
      <div className="mp-head">
        <span className="mp-title">
          <Library size={14} /> 素材库
          {mediaPool.length > 0 && <span className="mp-count">{mediaPool.length}</span>}
        </span>
        <div className="mp-actions">
          <button className="mp-btn" onClick={() => void handleImport()} disabled={busy} title="视频/图片导入素材库（一次导入，多段复用）">
            <ImagePlus size={13} /> 导入
          </button>
          <button
            className="mp-btn mp-btn-primary"
            onClick={handleDistribute}
            disabled={busy || mediaPool.length === 0}
            title="把库内素材自动分到缺素材的片段（缺素材的片段优先，纯文字段跳过）"
          >
            <Wand2 size={13} /> 自动配段
          </button>
        </div>
      </div>
      {mediaPool.length === 0 ? (
        <p className="mp-empty">导入一次，多段复用：素材存进素材库后可反复加入任何片段，「自动配段」一键分到缺素材的片段，AI 一键成片也会自动使用。</p>
      ) : (
        <div className="mp-thumbs">
          {mediaPool.map((c) => (
            <div key={c.id} className="mp-thumb">
              {c.thumbnail ? (
                <img src={c.thumbnail} alt={c.name} />
              ) : (
                <span className="mp-thumb-fallback"><Film size={16} /></span>
              )}
              <span className="mp-thumb-name" title={c.name}>{c.name}</span>
              <button
                className="mp-thumb-btn mp-thumb-add"
                title="加入当前片段"
                onClick={() => useProjectStore.getState().addVideosToCurrent([{...c, id: freshId()}])}
              >
                <Plus size={12} />
              </button>
              <button className="mp-thumb-btn mp-thumb-remove" title="从素材库移除" onClick={() => removeFromMediaPool(c.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
