/**
 * TemplatePickerModal - 统一模板选择器弹窗
 *
 * 首页（OrientationSelector「浏览全部模板」）与故事板（StoryboardEditor 更换模板）
 * 共用的全量模板选择器：搜索（防抖 150ms）+ 左侧叙事槽位分类轨 + 顶部来源筛选
 * chips + 卡片网格。检索走 shared/template-catalog 的 browseTemplateCatalog
 * （与 LLM 用的 searchTemplateCatalog 同打分/分词，但不截断、关键词只返回命中）。
 *
 * 来源徽标（内置/自定义/云端/AI 生成）由组件内部按 id 前缀 + 缩略图特征推导，
 * 调用方只需传入 mergeTemplateMetas 的合并结果。
 */

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {X, Search, Film, Palette} from 'lucide-react';
import type {TemplateMeta, TemplateSlot} from '../../shared/types';
import type {VideoType} from '../../shared/video-type';
import {browseTemplateCatalog, is3DTemplate} from '../../shared/template-catalog';
import {isCustomTemplateId, isGeneratedTemplateId, isMarketTemplateId, templateFitsVideoType} from '../../shared/template-registry';
import {TEMPLATE_SLOTS} from '../../shared/template-slots';
import {resolveTemplateThumbnail} from '../utils/template-thumbnails';
import {TemplateHoverPreview, useHoverPreview} from './TemplateHoverPreview';
import './TemplatePickerModal.css';

export interface TemplatePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** 单击卡片即选定：回调模板 id 后组件自行 onClose */
  onSelect: (id: string) => void;
  /** 全量候选（mergeTemplateMetas 结果：内置 + 自定义 + 云端 + AI 生成） */
  templates: TemplateMeta[];
  /** 当前选中的模板 id（卡片高亮描边 + 「当前」标记） */
  currentId?: string;
  /** 传入时在适配该体裁的卡片上加「体裁推荐」小标记（不过滤清单） */
  videoType?: VideoType;
  /** 弹窗标题（缺省「选择模板」） */
  title?: string;
}

/** 模板来源（徽标/筛选 chips） */
type TemplateSource = 'builtin' | 'custom' | 'market' | 'generated';

const SOURCE_LABEL: Record<TemplateSource, string> = {
  builtin: '内置',
  custom: '自定义',
  market: '云端',
  generated: 'AI 生成',
};
const SOURCE_ORDER: TemplateSource[] = ['builtin', 'custom', 'market', 'generated'];

/** 来源识别：优先 id 前缀；无前缀兜底按缩略图特征（自定义 = 'custom' 字面量，云端 = data-URI） */
const sourceOfTemplate = (t: TemplateMeta): TemplateSource => {
  if (isGeneratedTemplateId(t.id)) return 'generated';
  if (isMarketTemplateId(t.id)) return 'market';
  if (isCustomTemplateId(t.id)) return 'custom';
  if (t.thumbnail === 'custom') return 'custom';
  if (t.thumbnail.startsWith('data:')) return 'market';
  return 'builtin';
};

/** 分类轨槽位短名（完整名见 template-slots 的 TEMPLATE_SLOT_LABEL，这里空间窄用单/双字） */
const SLOT_SHORT_LABEL: Record<TemplateSlot, string> = {
  hook: '开场',
  showcase: '展示',
  media: '素材',
  story: '叙事',
  data: '数据',
  proof: '证明',
  cta: '结尾',
};

/** 卡片标题去掉来源 emoji 前缀（🎨/☁️/🤖 由来源徽标承担，避免重复） */
const displayName = (name: string): string => name.replace(/^(?:🎨|☁️|🤖)\s*/u, '');

export const TemplatePickerModal: React.FC<TemplatePickerModalProps> = ({
  open,
  onClose,
  onSelect,
  templates,
  currentId,
  videoType,
  title = '选择模板',
}) => {
  const [input, setInput] = useState('');
  /** 防抖后的检索词（150ms，输入停顿后再重排网格） */
  const [query, setQuery] = useState('');
  const [activeSlot, setActiveSlot] = useState<TemplateSlot | null>(null);
  const [activeSource, setActiveSource] = useState<TemplateSource | null>(null);
  /** 「3D」风格筛选（与来源筛选叠加的开关，不是来源） */
  const [only3D, setOnly3D] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // hover 动态预览（500ms 延时弹出，离卡即销毁）
  const {preview, onEnter: onPreviewEnter, onLeave: onPreviewLeave} = useHoverPreview();

  // 每次打开重置筛选并聚焦搜索框
  useEffect(() => {
    if (!open) return;
    setInput('');
    setQuery('');
    setActiveSlot(null);
    setActiveSource(null);
    setOnly3D(false);
    inputRef.current?.focus();
  }, [open]);

  // 搜索防抖 150ms
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 150);
    return () => clearTimeout(timer);
  }, [input]);

  // 筛选/关键词变化或弹窗关闭时收掉 hover 预览（卡片集合变了，锚点位置失效）
  useEffect(() => {
    onPreviewLeave();
  }, [query, activeSlot, activeSource, only3D, open, onPreviewLeave]);

  // 弹窗滚动锁：打开期间锁住 body 滚动，关闭恢复
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Esc：有搜索词先清空，无搜索词关闭弹窗
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (input) setInput('');
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, input, onClose]);

  // 来源筛选（chips）→ 槽位硬过滤 + 关键词检索（browseTemplateCatalog）
  const sourceFiltered = useMemo(
    () => (activeSource === null ? templates : templates.filter((t) => sourceOfTemplate(t) === activeSource)),
    [templates, activeSource],
  );
  // 「3D」风格开关叠在来源筛选之上（3D 场景族 + 3D 三件套 + 3D 数据可视化）
  const styleFiltered = useMemo(
    () => (only3D ? sourceFiltered.filter((t) => is3DTemplate(t.id)) : sourceFiltered),
    [sourceFiltered, only3D],
  );
  const count3D = useMemo(() => templates.filter((t) => is3DTemplate(t.id)).length, [templates]);
  // 各来源数量徽标（基于全量，不随槽位/关键词变化）
  const sourceCounts = useMemo(() => {
    const m = new Map<TemplateSource, number>();
    for (const t of templates) {
      const s = sourceOfTemplate(t);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [templates]);
  // 槽位数量徽标跟随来源筛选（未标注槽位的模板不计入任何槽位）
  const slotCounts = useMemo(() => {
    const m = new Map<TemplateSlot, number>();
    for (const t of styleFiltered) {
      for (const s of t.slots ?? []) m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [sourceFiltered]);
  const result = useMemo(
    () => browseTemplateCatalog(styleFiltered, {query: query || undefined, slot: activeSlot ?? undefined}),
    [styleFiltered, query, activeSlot],
  );

  if (!open) return null;

  const renderCard = (t: TemplateMeta) => {
    const src = sourceOfTemplate(t);
    const thumb = t.thumbnail === 'custom' ? undefined : resolveTemplateThumbnail(t.thumbnail);
    const isCurrent = currentId === t.id;
    const recommended = videoType ? templateFitsVideoType(t, videoType) : false;
    return (
      <button
        key={t.id}
        className={`tp-card ${isCurrent ? 'selected' : ''}`}
        onClick={() => { onSelect(t.id); onClose(); }}
        onMouseEnter={(e) => onPreviewEnter(t, e.currentTarget)}
        onMouseLeave={onPreviewLeave}
        title={t.description}
      >
        <span className="tp-thumb">
          {t.thumbnail === 'custom' ? (
            <Palette size={22} />
          ) : thumb ? (
            <img src={thumb} alt={t.name} />
          ) : (
            <Film size={22} />
          )}
          {recommended && <span className="tp-rec-badge">体裁推荐</span>}
          {isCurrent && <span className="tp-current-badge">当前</span>}
        </span>
        <span className="tp-card-body">
          <span className="tp-card-name">{displayName(t.name)}</span>
          <span className="tp-card-desc">{t.description}</span>
          <span className="tp-card-meta">
            <span className="tp-duration">默认 {t.defaultDuration}s</span>
            <span className={`tp-source-badge tp-src-${src}`}>{SOURCE_LABEL[src]}</span>
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content tp-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <div className="tp-header">
          <h2 className="tp-title">{title}</h2>
          <div className="tp-search">
            <Search size={15} />
            <input
              ref={inputRef}
              className="tp-search-input"
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="搜索模板名称 / 描述 / 标签（Esc 清空）"
            />
            {input && (
              <button className="tp-search-clear" onClick={() => setInput('')} title="清空搜索">
                <X size={13} />
              </button>
            )}
          </div>
        </div>
        <div className="tp-body">
          {/* 左侧分类轨：全部 + 7 个叙事槽位（数量徽标） */}
          <div className="tp-rail">
            <button
              className={`tp-rail-item ${activeSlot === null ? 'active' : ''}`}
              onClick={() => setActiveSlot(null)}
            >
              全部<span className="tp-rail-count">{sourceFiltered.length}</span>
            </button>
            {TEMPLATE_SLOTS.map((slot) => (
              <button
                key={slot}
                className={`tp-rail-item ${activeSlot === slot ? 'active' : ''}`}
                onClick={() => setActiveSlot(slot)}
              >
                {SLOT_SHORT_LABEL[slot]}<span className="tp-rail-count">{slotCounts.get(slot) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="tp-main">
            {/* 来源筛选 chips（空来源不显示） */}
            <div className="tp-chips">
              <button
                className={`tp-chip ${activeSource === null ? 'active' : ''}`}
                onClick={() => setActiveSource(null)}
              >
                全部<span className="tp-chip-count">{templates.length}</span>
              </button>
              {SOURCE_ORDER.filter((s) => (sourceCounts.get(s) ?? 0) > 0).map((s) => (
                <button
                  key={s}
                  className={`tp-chip ${activeSource === s ? 'active' : ''}`}
                  onClick={() => setActiveSource(s)}
                >
                  {SOURCE_LABEL[s]}<span className="tp-chip-count">{sourceCounts.get(s) ?? 0}</span>
                </button>
              ))}
              <button
                className={`tp-chip tp-chip-style ${only3D ? 'active' : ''}`}
                title="只看 3D 模板：场景族（城市/中庭/星域/艺廊/环台/隧道/旅程）+ 设备/模型/立体标题 + 3D 图表"
                onClick={() => setOnly3D((v) => !v)}
              >
                3D<span className="tp-chip-count">{count3D}</span>
              </button>
            </div>
            {/* 卡片网格（约 180px 卡，自适应列数；空态提示）；滚动时收掉 hover 预览（锚点失效） */}
            <div className="tp-grid" onScroll={onPreviewLeave}>
              {result.templates.map(renderCard)}
              {result.templates.length === 0 && (
                <p className="tp-empty">没有匹配的模板，试试换个关键词或清除筛选。</p>
              )}
            </div>
          </div>
        </div>
        <div className="tp-footer">共 {templates.length} 个 · 命中 {result.templates.length} 个</div>
      </div>
      {/* hover 动态预览弹层（portal 到 body） */}
      <TemplateHoverPreview state={preview} />
    </div>
  );
};

export default TemplatePickerModal;
