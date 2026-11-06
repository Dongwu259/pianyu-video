/**
 * 步骤 1: 比例预设选择 + 首个模板选择
 *
 * 模板区 = 「推荐」横排（按当前体裁过滤的前 10 个，单击即选）+「浏览全部模板」
 * 入口卡（打开统一模板选择器 TemplatePickerModal，可搜索/按槽位与来源筛选）。
 * 市场模板不再按行业分组平铺在这里，全部进选择器。
 */

import React, {useState, useRef, useEffect} from 'react';
import {useProjectStore} from '../store/projectStore';
import {mergeTemplateMetas, templateFitsVideoType, GENRE_RECOMMENDED_IDS} from '../../shared/template-registry';
import {ASPECT_RATIO_PRESETS} from '../../shared/aspect-ratios';
import {VIDEO_TYPES, VIDEO_TYPE_LABEL, VIDEO_TYPE_DESC} from '../../shared/video-type';
import type {TemplateMeta} from '../../shared/types';
import {resolveTemplateThumbnail} from '../utils/template-thumbnails';
import {TemplatePickerModal} from './TemplatePickerModal';
import {TemplateHoverPreview, useHoverPreview} from './TemplateHoverPreview';
import {Palette, Film, Sparkles, Search, MessageSquareText, MonitorPlay} from 'lucide-react';
import './OrientationSelector.css';

/** 推荐横排的模板数量（按体裁过滤后取前 N 个） */
const RECOMMENDED_COUNT = 10;

/** 在限定包围盒内按真实宽高比计算预览框尺寸 */
const fitBox = (w: number, h: number, maxW = 120, maxH = 70) => {
  const r = w / h;
  if (r >= maxW / maxH) return {width: maxW, height: Math.round(maxW / r)};
  return {width: Math.round(maxH * r), height: maxH};
};

export const OrientationSelector: React.FC<{onOpenAiPanel?: () => void; onOpenRecorder?: () => void}> = ({onOpenAiPanel, onOpenRecorder}) => {
  const {aspectRatioId, setAspectRatioId, selectFirstTemplate, templateId, setStep, customTemplates, marketTemplates, generatedTemplates, videoType, setVideoType} = useProjectStore();
  // 统一模板选择器（「浏览全部模板」入口）
  const [pickerOpen, setPickerOpen] = useState(false);
  const recRowRef = useRef<HTMLDivElement>(null);
  // 推荐横排 hover 动态预览（与选择器同款：500ms 延时、离卡即销毁）
  const {preview, onEnter: onPreviewEnter, onLeave: onPreviewLeave} = useHoverPreview();
  // 切体裁会整批换推荐卡：预览锚点失效，直接收掉
  useEffect(() => {
    onPreviewLeave();
  }, [videoType, onPreviewLeave]);

  // 推荐横排：垂直滚轮 → 横向滚动（滚轮下滑 = 往右翻模板；滚到两端放行页面滚动）
  useEffect(() => {
    const el = recRowRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
      const canLeft = el.scrollLeft > 0;
      const canRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
      if ((e.deltaY < 0 && canLeft) || (e.deltaY > 0 && canRight)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 全量模板（内置 + 自定义 + 云端 + AI 生成）：选择器数据源；推荐横排走体裁策展列表
  const allTemplates = mergeTemplateMetas(customTemplates, marketTemplates, generatedTemplates);
  // 体裁策展（切换体裁即换一批）：promo 主推 3D 场景族，vlog/口播/教程/混剪各推体裁向模板——
  // 找不到的 id 静默跳过；策展不足时按体裁适配兜底补齐（保持旧逻辑语义）
  const curated = GENRE_RECOMMENDED_IDS[videoType]
    .map((id) => allTemplates.find((t) => t.id === id))
    .filter((t): t is TemplateMeta => !!t);
  const recommended =
    curated.length >= 4
      ? curated.slice(0, RECOMMENDED_COUNT)
      : [
          ...curated,
          ...allTemplates.filter((t) => templateFitsVideoType(t, videoType) && !curated.includes(t)),
        ].slice(0, RECOMMENDED_COUNT);
  // 已选模板名称在「下一步」旁可见（推荐横排只有前 N 个，选中项可能不在其中）
  const selectedTemplate = templateId ? allTemplates.find((t) => t.id === templateId) : undefined;

  // 模板选择已在点击卡片时写入第 1 段（selectFirstTemplate），这里只需进入下一步
  const handleNext = () => {
    if (templateId) {
      setStep(2);
    }
  };

  const renderMiniCard = (tmpl: TemplateMeta) => (
    <button
      key={tmpl.id}
      className={`template-mini-card ${templateId === tmpl.id ? 'selected' : ''}`}
      onClick={() => selectFirstTemplate(tmpl.id)}
      onMouseEnter={(e) => onPreviewEnter(tmpl, e.currentTarget)}
      onMouseLeave={onPreviewLeave}
    >
      <span className="mini-thumb">
        {tmpl.thumbnail === 'custom' ? (
          <Palette size={20} />
        ) : resolveTemplateThumbnail(tmpl.thumbnail) ? (
          <img className="mini-thumb-img" src={resolveTemplateThumbnail(tmpl.thumbnail)} alt={tmpl.name} />
        ) : (
          <Film size={20} />
        )}
      </span>
      <span className="mini-name">{tmpl.name}</span>
    </button>
  );

  return (
    <div className="orientation-selector">
      <div className="orientation-header">
        <h2>开始新视频</h2>
        <p>先选这条片子做什么类型，再选画幅比例与首个模板</p>
      </div>

      {/* 快速开始：三条「最短路径」——看示例建立信心 / AI 直接代做 / 只录屏（录完拿走文件，不建工程） */}
      <div className="quick-start">
        <button className="quick-card" onClick={() => void useProjectStore.getState().openSampleProject()}>
          <span className="quick-icon"><Sparkles size={20} /></span>
          <span className="quick-copy">
            <span className="quick-title">先看示例成片</span>
            <span className="quick-sub">打开做好的示例工程，30 秒看懂片语怎么出片，看完可直接改成你的</span>
          </span>
        </button>
        <button className="quick-card quick-card-ai" onClick={onOpenAiPanel} disabled={!onOpenAiPanel}>
          <span className="quick-icon"><MessageSquareText size={20} /></span>
          <span className="quick-copy">
            <span className="quick-title">AI 一句话成片</span>
            <span className="quick-sub">说一句话讲清你的产品，AI 选模板、写文案、配乐、渲染一条龙（未配置也可先看演示）</span>
          </span>
        </button>
        <button className="quick-card quick-card-rec" onClick={onOpenRecorder} disabled={!onOpenRecorder}>
          <span className="quick-icon"><MonitorPlay size={20} /></span>
          <span className="quick-copy">
            <span className="quick-title">只录屏</span>
            <span className="quick-sub">录屏幕 / 窗口 / 摄像头（带鼠标轨迹，渲染时自动美化），存成视频文件直接拿走用</span>
          </span>
        </button>
      </div>

      {/* 视频体裁：决定 AI 助手的工作流剧本与模板推荐口径（只是推荐口径，不影响已有内容，随时可换） */}
      <div className="genre-section">
        <h3>视频体裁</h3>
        <div className="genre-options">
          {VIDEO_TYPES.map((t) => (
            <button
              key={t}
              className={`genre-btn ${videoType === t ? 'active' : ''}`}
              onClick={() => setVideoType(t)}
              title="决定 AI 助手的工作流剧本与模板推荐口径，不影响已搭好的内容，随时可换"
            >
              <span className="genre-label">{VIDEO_TYPE_LABEL[t]}</span>
              <span className="genre-desc">{VIDEO_TYPE_DESC[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 比例预设 */}
      <div className="orientation-options">
        {ASPECT_RATIO_PRESETS.map((p) => {
          const box = fitBox(p.width, p.height);
          return (
            <button
              key={p.id}
              className={`orient-btn ${aspectRatioId === p.id ? 'active' : ''}`}
              onClick={() => setAspectRatioId(p.id)}
            >
              <div className="orient-preview-wrap">
                <div
                  className="orient-preview"
                  style={{width: box.width, height: box.height}}
                >
                  <div className="orient-demo">{p.label}</div>
                </div>
              </div>
              <span className="orient-label">{p.name}</span>
              <span className="orient-desc">{p.desc}</span>
            </button>
          );
        })}
      </div>

      {/* 首个模板：推荐横排（已按体裁过滤）；首位是「浏览全部模板」入口（直通搜索/筛选），滚轮可横向翻 */}
      <div className="template-section">
        <h3>选择第一个片段的模板<span className="template-filter-note">（已按「{VIDEO_TYPE_LABEL[videoType]}」推荐，共 {allTemplates.length} 个模板）</span></h3>
        <div className="template-rec-row" ref={recRowRef} onScroll={onPreviewLeave}>
          <button className="template-browse-card" onClick={() => setPickerOpen(true)}>
            <Search size={18} />
            <span>浏览全部模板</span>
            <span className="template-browse-sub">搜索 / 按分类筛选</span>
          </button>
          {recommended.map(renderMiniCard)}
        </div>
      </div>

      {/* 下一步（「打开示例工程」已上移为首屏快速开始主行动，此处不再重复） */}
      <div className="orientation-footer">
        {selectedTemplate && (
          <span className="orientation-selected-note" title={selectedTemplate.name}>
            已选模板：<b>{selectedTemplate.name}</b>
          </span>
        )}
        <button
          className="btn-primary"
          disabled={!templateId}
          onClick={handleNext}
        >
          下一步：故事板编辑
        </button>
      </div>

      <TemplatePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={selectFirstTemplate}
        templates={allTemplates}
        currentId={templateId ?? undefined}
        videoType={videoType}
        title="选择第一个片段的模板"
      />
      {/* 推荐横排 hover 动态预览弹层（portal 到 body） */}
      <TemplateHoverPreview state={preview} />
    </div>
  );
};

export default OrientationSelector;
