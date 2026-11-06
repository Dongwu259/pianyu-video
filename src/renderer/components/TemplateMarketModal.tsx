/**
 * TemplateMarketModal - 模板中心（市场 + 管理双页签）
 *
 * 「模板市场」：浏览服务器模板目录，一键安装/更新/卸载。目录数据由主进程
 * templateMarket 服务拉取（5 分钟缓存），安装的包写入 userData/market-templates。
 * 「模板管理」：集中管理三类模板——内置（只读不可删）、自定义（编辑/导出/删除）、
 * 云端已装（卸载）。
 */

import React, {useCallback, useEffect, useState} from 'react';
import {X, CloudDownload, RefreshCw, Check, Trash2, WifiOff, FolderInput, PencilLine, Upload, Lock} from 'lucide-react';
import type {MarketCatalogEntryWithStatus} from '../../shared/template-pack';
import {TEMPLATES} from '../../shared/template-registry';
import {useProjectStore} from '../store/projectStore';
import {resolveTemplateThumbnail} from '../utils/template-thumbnails';
import {aggregateMarketTags, filterEntriesByTag, filterEntriesByIndustry, groupEntriesByIndustry, INDUSTRY_DISPLAY_ORDER} from './market-tags';
import {getIndustry, type Industry} from '../../shared/industries';
import './TemplateMarketModal.css';

interface Props {
  onClose: () => void;
  /** 管理页签点「编辑」自定义模板：关闭本弹窗并打开模板编辑器 */
  onOpenEditor?: (defId?: string) => void;
}

export const TemplateMarketModal: React.FC<Props> = ({onClose, onOpenEditor}) => {
  const loadMarketTemplates = useProjectStore((s) => s.loadMarketTemplates);
  const marketTemplates = useProjectStore((s) => s.marketTemplates);
  const customTemplates = useProjectStore((s) => s.customTemplates);
  const removeCustomTemplate = useProjectStore((s) => s.removeCustomTemplate);
  const segments = useProjectStore((s) => s.segments);

  const [tab, setTab] = useState<'market' | 'manage'>('market');
  const [entries, setEntries] = useState<MarketCatalogEntryWithStatus[]>([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 正在安装/卸载的模板 id（按钮 loading 态） */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 行业筛选：选中的行业（null = 全部，列表按行业分组显示） */
  const [activeIndustry, setActiveIndustry] = useState<Industry | null>(null);
  /** 场景筛选：选中的标签（null = 全部），与行业筛选可叠加 */
  const [activeTag, setActiveTag] = useState<string | null>(null);
  /** 从当前目录聚合出的场景 chips（行业词已剔除，次数降序，取前 14 个） */
  const tagChips = aggregateMarketTags(entries, 14);
  /** 行业筛选行的数量徽标（按词表归类，无行业词的归入「通用」） */
  const industryCounts = new Map<Industry, number>();
  for (const e of entries) {
    const ind = getIndustry(e.tags);
    industryCounts.set(ind, (industryCounts.get(ind) ?? 0) + 1);
  }
  /** 行业 → 场景标签两级筛选后的卡片列表 */
  const visibleEntries = filterEntriesByTag(filterEntriesByIndustry(entries, activeIndustry), activeTag);
  /** 「全部」视图按行业分组（空组跳过）；选中具体行业时平铺，不显示组标题 */
  const industryGroups = activeIndustry === null ? groupEntriesByIndustry(visibleEntries) : [];

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.api.marketCatalog(force);
      setEntries(r.entries);
      setOffline(r.offline);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleInstall = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const r = await window.api.marketInstall(id);
      if (!r.ok) {
        setError(r.error || '安装失败');
        return;
      }
      await loadMarketTemplates();
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (id: string) => {
    const used = segments.filter((s) => s.templateId === id).length;
    const tip = used > 0
      ? `当前故事板有 ${used} 个片段正在使用该模板，卸载后这些片段将无法渲染（重新安装后恢复）。确定卸载？`
      : '卸载该模板？';
    if (!window.confirm(tip)) return;
    setBusyId(id);
    setError(null);
    try {
      await window.api.marketUninstall(id);
      await loadMarketTemplates();
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleImportFile = async () => {
    setError(null);
    const r = await window.api.marketImportFile();
    if (!r) return;
    if (!r.success) {
      setError(r.error || '安装失败');
      return;
    }
    await loadMarketTemplates();
    await refresh(true);
  };

  const handleDeleteCustom = async (id: string, name: string) => {
    const used = segments.filter((s) => s.templateId === id).length;
    const tip = used > 0
      ? `当前故事板有 ${used} 个片段正在使用「${name}」，删除后这些片段将无法渲染。确定删除？`
      : `删除自定义模板「${name}」？`;
    if (!window.confirm(tip)) return;
    await removeCustomTemplate(id);
  };

  const handleExportCustom = async (def: (typeof customTemplates)[number]) => {
    const r = await window.api.exportCustomTemplate(def);
    if (!r.success && r.error) setError('导出失败：' + r.error);
  };

  /** 市场模板卡片（「全部」分组视图与单行业平铺视图共用） */
  const renderMarketCard = (t: MarketCatalogEntryWithStatus) => {
    const installed = Boolean(t.installedVersion) || marketTemplates.some((m) => m.id === t.id);
    const busy = busyId === t.id;
    return (
      <div key={t.id} className="market-card">
        <div className="market-thumb">
          {t.thumbnail ? (
            <img src={t.thumbnail} alt={t.name} />
          ) : (
            <span className="market-thumb-fallback">{t.name.slice(0, 1)}</span>
          )}
          {t.hasUpdate && <span className="market-update-badge">有更新</span>}
        </div>
        <div className="market-card-body">
          <div className="market-card-title">
            {t.name}
            <span className="market-version">v{t.version}</span>
          </div>
          {t.description && <p className="market-card-desc">{t.description}</p>}
          <div className="market-card-meta">
            {t.author && <span>{t.author}</span>}
            <span>{t.downloads} 次安装</span>
          </div>
        </div>
        <div className="market-card-actions">
          {installed ? (
            <>
              <button
                className="btn-secondary btn-small"
                onClick={() => handleInstall(t.id)}
                disabled={busy}
                title={t.hasUpdate ? `更新到 v${t.version}` : '重新安装'}
              >
                {busy ? '…' : t.hasUpdate ? <><CloudDownload size={13} /> 更新</> : <><Check size={13} /> 已安装</>}
              </button>
              <button
                className="btn-secondary btn-small btn-danger-text"
                onClick={() => handleUninstall(t.id)}
                disabled={busy}
                title="卸载"
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <button className="btn-primary btn-small" onClick={() => handleInstall(t.id)} disabled={busy}>
              {busy ? '安装中…' : <><CloudDownload size={13} /> 安装</>}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content market-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <div className="market-header">
          <div className="market-tabs">
            <button
              className={`market-tab ${tab === 'market' ? 'active' : ''}`}
              onClick={() => setTab('market')}
            >
              <CloudDownload size={15} /> 模板市场
            </button>
            <button
              className={`market-tab ${tab === 'manage' ? 'active' : ''}`}
              onClick={() => setTab('manage')}
            >
              模板管理
            </button>
          </div>
          {tab === 'market' && (
            <div className="market-header-actions">
              <button className="btn-secondary btn-small" onClick={handleImportFile} title="从本地 .vttemplate 文件安装">
                <FolderInput size={14} /> 从文件安装
              </button>
              <button className="btn-secondary btn-small" onClick={() => refresh(true)} disabled={loading} title="刷新目录">
                <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
              </button>
            </div>
          )}
        </div>

        {tab === 'market' && offline && (
          <div className="market-offline-bar">
            <WifiOff size={14} /> 无法连接模板服务器，请检查网络后点「刷新」重试。
          </div>
        )}
        {error && <div className="market-error-bar">{error}</div>}

        {tab === 'market' ? (
          <>
            {entries.length > 0 && (
              <div className="market-industry-row">
                <button
                  className={`market-tag-chip ${activeIndustry === null ? 'active' : ''}`}
                  onClick={() => setActiveIndustry(null)}
                >
                  全部<span className="market-chip-count">{entries.length}</span>
                </button>
                {INDUSTRY_DISPLAY_ORDER.map((ind) => (
                  <button
                    key={ind}
                    className={`market-tag-chip ${activeIndustry === ind ? 'active' : ''}`}
                    onClick={() => setActiveIndustry(ind)}
                  >
                    {ind}<span className="market-chip-count">{industryCounts.get(ind) ?? 0}</span>
                  </button>
                ))}
              </div>
            )}
            {tagChips.length > 0 && (
              <div className="market-tag-chips">
                <button
                  className={`market-tag-chip ${activeTag === null ? 'active' : ''}`}
                  onClick={() => setActiveTag(null)}
                >
                  全部
                </button>
                {tagChips.map((tag) => (
                  <button
                    key={tag}
                    className={`market-tag-chip ${activeTag === tag ? 'active' : ''}`}
                    onClick={() => setActiveTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <div className="market-grid">
              {!loading && !offline && entries.length === 0 && (
                <p className="market-empty">市场上还没有模板，敬请期待。</p>
              )}
              {!loading && !offline && entries.length > 0 && visibleEntries.length === 0 && (
                <p className="market-empty">该分类暂无模板。</p>
              )}
              {activeIndustry === null
                ? industryGroups.map((g) => (
                    <React.Fragment key={g.industry}>
                      <div className="market-group-title">{g.industry}（{g.entries.length}）</div>
                      {g.entries.map(renderMarketCard)}
                    </React.Fragment>
                  ))
                : visibleEntries.map(renderMarketCard)}
            </div>
            {marketTemplates.length > 0 && (
              <p className="market-installed-hint">
                已安装 {marketTemplates.length} 个云端模板，已在故事板模板下拉的「云端模板」分组中可用。
              </p>
            )}
          </>
        ) : (
          <div className="manage-body">
            {/* 云端已装 */}
            <div className="manage-section">
              <div className="manage-section-title">云端模板（{marketTemplates.length}）</div>
              {marketTemplates.length === 0 && <p className="manage-empty">还没有安装云端模板，去「模板市场」页签安装。</p>}
              {marketTemplates.map((p) => (
                <div key={p.id} className="manage-row">
                  <span className="manage-thumb">
                    {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <span className="market-thumb-fallback">{p.name.slice(0, 1)}</span>}
                  </span>
                  <span className="manage-name">{p.name}<span className="market-version">v{p.version}</span></span>
                  <span className="manage-desc">{p.description || '云端模板'}</span>
                  <span className="manage-actions">
                    <button
                      className="btn-secondary btn-small btn-danger-text"
                      onClick={() => handleUninstall(p.id)}
                      disabled={busyId === p.id}
                    >
                      <Trash2 size={13} /> 卸载
                    </button>
                  </span>
                </div>
              ))}
            </div>

            {/* 自定义模板 */}
            <div className="manage-section">
              <div className="manage-section-title">自定义模板（{customTemplates.length}）</div>
              {customTemplates.length === 0 && <p className="manage-empty">还没有自定义模板，可在「模板编辑器」中创建。</p>}
              {customTemplates.map((def) => (
                <div key={def.id} className="manage-row">
                  <span className="manage-thumb"><span className="market-thumb-fallback">{def.name.slice(0, 1)}</span></span>
                  <span className="manage-name">{def.name}</span>
                  <span className="manage-desc">{def.elements.length} 个元素 · {def.duration}s</span>
                  <span className="manage-actions">
                    {onOpenEditor && (
                      <button className="btn-secondary btn-small" onClick={() => onOpenEditor(def.id)} title="在模板编辑器中打开">
                        <PencilLine size={13} /> 编辑
                      </button>
                    )}
                    <button className="btn-secondary btn-small" onClick={() => handleExportCustom(def)} title="导出为 JSON 文件">
                      <Upload size={13} />
                    </button>
                    <button className="btn-secondary btn-small btn-danger-text" onClick={() => handleDeleteCustom(def.id, def.name)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>

            {/* 内置模板（只读） */}
            <div className="manage-section">
              <div className="manage-section-title">内置模板（{TEMPLATES.length}）</div>
              {TEMPLATES.map((t) => (
                <div key={t.id} className="manage-row builtin">
                  <span className="manage-thumb">
                    {resolveTemplateThumbnail(t.thumbnail)
                      ? <img src={resolveTemplateThumbnail(t.thumbnail)} alt="" />
                      : <span className="market-thumb-fallback">{t.name.slice(0, 1)}</span>}
                  </span>
                  <span className="manage-name">{t.name}</span>
                  <span className="manage-desc">{t.description}</span>
                  <span className="manage-actions">
                    <span className="manage-builtin-badge"><Lock size={11} /> 内置不可删除</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TemplateMarketModal;
