/**
 * 故事板编辑器 - 核心编辑页面
 *
 * 布局:
 * - 顶部：段时间线（片段缩略图 + 添加/删除/排序按钮）
 * - 中间左侧：当前片段编辑器（视频上传 + 文字编辑）
 * - 中间右侧：片段预览（当前选中片段的 3D 动画效果）
 * - 底部：完整故事板预览
 */

import React, {useState, useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import {useProjectStore} from '../store/projectStore';
import {mergeTemplateMetas, findDataDrivenDef, isDataDrivenTemplateId, isGeneratedTemplateId, findGeneratedDef} from '../../shared/template-registry';
import {VIDEO_TYPES, VIDEO_TYPE_LABEL} from '../../shared/video-type';
import {VideoUploader} from './VideoUploader';
import {TextEditor} from './TextEditor';
import {StyleEditor} from './StyleEditor';
import {LayoutEditor} from './LayoutEditor';
import {TemplateParamsEditor} from './TemplateParamsEditor';
import {RemotionPreviewPlayer} from './RemotionPreviewPlayer';
import type {PreviewPlayerHandle} from './RemotionPreviewPlayer';
import {TransitionFocusPicker} from './TransitionFocusPicker';
import {TransitionPreviewPlayer} from './TransitionPreviewPlayer';
import {clampTransitionSec, DEFAULT_TRANSITION_PRESET, DEFAULT_TRANSITION_SEC, getTransitionDefaultSec} from '../../shared/transition-style';
import {CurveEditorModal} from './CurveEditorModal';
import {presetCurve} from '../../shared/easing-curve';
import {BgmPanel} from './BgmPanel';
import {NarrationPanel} from './NarrationPanel';
import {CaptionPanel} from './CaptionPanel';
import {BrandPanel} from './BrandPanel';
import {SampleSwapBanner} from './SampleSwapBanner';
import {MediaPoolPanel} from './MediaPoolPanel';
import {SfxLane} from './SfxLane';
import {TimelinePanel} from './TimelinePanel';
import {SFX_KIND_META} from '../../shared/sfx-plan';
import {Splitter} from './Splitter';
import {useUIStore} from '../store/uiStore';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {Film, Trash2, Video, Type, Palette, LayoutTemplate, Clapperboard, Copy, ArrowLeft, ArrowRight, Sparkles, Image as ImageIcon, Play, X, SlidersHorizontal, Mic, Captions, Info, RotateCw, ChevronDown, Maximize2} from 'lucide-react';
import {resolveTemplateThumbnail} from '../utils/template-thumbnails';
import {TemplatePickerModal} from './TemplatePickerModal';
import type {TemplateProps, VideoEffect, BackgroundEffect, SegmentExitStyle, SfxKind} from '../../shared/types';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, EXIT_STYLE_OPTIONS} from '../../shared/types';
import './StoryboardEditor.css';

/** 编辑页标签元数据（精简模式只显示 video/text/params 三个，见 visibleTabs） */
const EDITOR_TAB_META = {
  video: {label: '素材', icon: <Video size={14} />},
  text: {label: '文字', icon: <Type size={14} />},
  params: {label: '参数', icon: <SlidersHorizontal size={14} />},
  style: {label: '样式', icon: <Palette size={14} />},
  layout: {label: '布局', icon: <LayoutTemplate size={14} />},
  effects: {label: '特效', icon: <Sparkles size={14} />},
  narration: {label: '旁白', icon: <Mic size={14} />},
  captions: {label: '字幕', icon: <Captions size={14} />},
} as const;

export const StoryboardEditor: React.FC = () => {
  const {
    segments,
    activeSegmentIndex,
    addSegment,
    removeSegment,
    duplicateSegment,
    reorderSegments,
    syncCurrentToSegment,
    loadSegmentToCurrent,
    templateId,
    videos,
    text,
    style,
    layout,
    customParams,
    orientation,
    aspectRatioId,
    videoType,
    setVideoType,
    customTemplates,
    marketTemplates,
    generatedTemplates,
    setCurrentTemplate,
    setCurrentDuration,
    setCurrentStartOffset,
    setCurrentTransition,
    setCurrentTransitionParams,
    setCurrentExitStyle,
    setCurrentVideoEffect,
    setCurrentBackgroundEffect,
    setStep,
    getTotalDuration,
    appSettings,
    setAppSettings,
    bgm,
    sfx,
    setCurrentTransitionSfx,
  } = useProjectStore();

  const [view, setView] = useState<'video' | 'text' | 'style' | 'layout' | 'params' | 'effects' | 'narration' | 'captions'>('video');

  // 精简/专家双模式（默认精简）：精简只留核心三 Tab，并隐藏起点/片尾退场/转场细调等高级控件
  const proMode = appSettings.editorProMode;
  const visibleTabs = (['video', 'text', 'params', 'style', 'layout', 'effects', 'narration', 'captions'] as const)
    .filter((id) => proMode || id === 'video' || id === 'text' || id === 'params');
  // 当前视图被精简模式隐藏（如从专家切回精简时停在「布局」）：落回素材页
  useEffect(() => {
    if (!proMode && !(visibleTabs as readonly string[]).includes(view)) setView('video');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proMode]);
  const toggleProMode = () => setAppSettings({editorProMode: !proMode});

  // 时间轴视图（P2.5 阶段二，专家模式专属）：卡片故事板 ↔ 剪辑软件式多轨时间轴。
  // 纯 UI 偏好不入工程，localStorage 记忆。
  const [timelineView, setTimelineView] = useState<'cards' | 'nle'>(() =>
    localStorage.getItem('qs-timeline-view') === 'nle' ? 'nle' : 'cards',
  );

  // 可调工作区：面板尺寸 + 显隐（视图菜单可切换）+ 监视器/右栏预览模式（v4）
  const {leftWidth, topHeight, panels, adjustLeftWidth, adjustTopHeight, setTopHeight, rightPreview, dockMonitor, undockMonitor} = useUIStore();
  const hasBottom = panels.editor || panels.preview;

  const switchTimelineView = (v: 'cards' | 'nle') => {
    setTimelineView(v);
    localStorage.setItem('qs-timeline-view', v);
    // 切到时间轴时顶部区域太矮则自动撑高到能容纳五条轨道+工具行（用户仍可拖回）
    if (v === 'nle' && topHeight < 340) setTopHeight(340);
  };
  const nleView = proMode && timelineView === 'nle';

  // 离开时间轴视图 / 隐藏时间轴面板时自动取消停靠（整片监视器的宿主是时间轴面板）
  useEffect(() => {
    if (rightPreview === 'full' && (!nleView || !panels.timeline)) undockMonitor();
  }, [rightPreview, nleView, panels.timeline, undockMonitor]);

  const currentSegment = segments[activeSegmentIndex];

  // 合并内置 + 自定义 + 市场 + AI 生成模板
  const allTemplates = mergeTemplateMetas(customTemplates, marketTemplates, generatedTemplates);
  // 当前模板 meta（内置/自定义/市场/AI 生成统一查找，供说明弹窗与预览门槛使用）
  const currentTemplate = currentSegment
    ? allTemplates.find((t) => t.id === currentSegment.templateId)
    : null;
  // 当前片段若为数据驱动模板（自定义/市场），查其定义供预览
  const currentCustomDef = currentSegment && isDataDrivenTemplateId(currentSegment.templateId)
    ? findDataDrivenDef(currentSegment.templateId, customTemplates, marketTemplates)
    : undefined;
  // 当前片段若为 AI 生成模板（gen- 前缀），查其定义供预览
  const currentGenDef = currentSegment && isGeneratedTemplateId(currentSegment.templateId)
    ? findGeneratedDef(currentSegment.templateId, generatedTemplates)
    : undefined;
  // 统一模板选择器弹窗（模板按钮点击打开，替代原生平铺下拉）
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  // 当前片段引用未安装/已删除的模板（数据驱动/AI 生成定义缺失）→ 模板按钮显示警告态
  const currentTemplateMissing = Boolean(currentSegment && (
    (isDataDrivenTemplateId(currentSegment.templateId) && !currentCustomDef)
    || (isGeneratedTemplateId(currentSegment.templateId) && !currentGenDef)
  ));

  // 片段操作
  const handleSelectSegment = (index: number) => {
    syncCurrentToSegment(); // 保存当前编辑内容
    loadSegmentToCurrent(index); // 加载新片段
    // 保持当前 Tab 不跳转：连续改多段文案时不把用户踢出「文字」页
    setTransitionPreviewOpen(false);
  };

  const handleAddSegment = () => {
    syncCurrentToSegment();
    addSegment();
    setView('video');
  };

  const handleDeleteSegment = (index: number) => {
    if (segments.length <= 1) return;
    // 有内容（素材/文案）的片段删除前确认；空白片段直接删（撤销兜底）
    const seg = segments[index];
    const hasContent = seg && (seg.videos.length > 0 || Boolean(seg.text.title || seg.text.subtitle || (seg.text.features || []).length));
    if (hasContent && !window.confirm(`确定删除第 ${index + 1} 个片段吗？（可用 Ctrl+Z 撤销）`)) return;
    removeSegment(index);
    setView('video');
  };

  // 左移/右移排序：活动片段按 id 跟随（reorderSegments 内部处理），工作副本无需重载
  const handleMoveSegment = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= segments.length) return;
    syncCurrentToSegment(); // 先把工作副本刷入 segments，排序不丢未同步编辑
    reorderSegments(index, target);
  };

  // 卡片拖拽重排：from=被拖卡片，insert=当前插入位（0..n，画在卡片左/右缘）
  const [cardDrag, setCardDrag] = useState<{from: number; insert: number} | null>(null);
  const handleCardDrop = () => {
    if (!cardDrag) return;
    const {from, insert} = cardDrag;
    setCardDrag(null);
    if (insert === from || insert === from + 1) return; // 原位
    const to = insert > from ? insert - 1 : insert;
    syncCurrentToSegment();
    reorderSegments(from, to);
  };

  const handleDuplicate = (index: number) => {
    duplicateSegment(index);
  };

  // 移动到上一步（渲染）
  const handleNext = () => {
    syncCurrentToSegment();
    setStep(3);
  };

  const handleBack = () => {
    setStep(1);
  };

  // 构建预览 inputProps（包含 layout + segmentDuration + videoEffect + 模板个性化参数 + 文字动效）
  const currentInputProps: TemplateProps = {
    videos,
    text,
    orientation,
    segmentDuration: currentSegment?.duration || 8,
    style,
    layout,
    params: customParams,
    videoEffect: currentSegment?.videoEffect,
    backgroundEffect: currentSegment?.backgroundEffect,
    textAnim: currentSegment?.textAnim,
    exitStyle: currentSegment?.exitStyle,
  };

  // 预览播放模式：once | loop
  const [previewMode, setPreviewMode] = useState<'once' | 'loop'>('once');
  // 预览播放器句柄（重播按钮在预览头部、切循环时立即重播）
  const previewPlayerRef = useRef<PreviewPlayerHandle>(null);
  // 模板说明弹窗（ⓘ 点击开关；portal 到 body——.se-top 有 overflow:hidden，普通绝对定位会被裁剪）
  const [templateInfoOpen, setTemplateInfoOpen] = useState(false);
  const [templateInfoPos, setTemplateInfoPos] = useState<{top: number; left: number}>({top: 0, left: 0});
  const templateInfoRef = useRef<HTMLSpanElement>(null);
  const templateInfoPopRef = useRef<HTMLDivElement>(null);

  const toggleTemplateInfo = () => {
    if (!templateInfoOpen) {
      const rect = templateInfoRef.current?.getBoundingClientRect();
      if (rect) {
        setTemplateInfoPos({
          top: rect.bottom + 6,
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
        });
      }
    }
    setTemplateInfoOpen((o) => !o);
  };

  useEffect(() => {
    if (!templateInfoOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (templateInfoRef.current?.contains(t) || templateInfoPopRef.current?.contains(t)) return;
      setTemplateInfoOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [templateInfoOpen]);
  useEffect(() => { setTemplateInfoOpen(false); }, [templateId]);
  // 转场预览：true 时右侧预览区播放「当前段 → 下一段」的转场窗口（整片模式）
  const [transitionPreviewOpen, setTransitionPreviewOpen] = useState(false);
  const [showTransitionCurve, setShowTransitionCurve] = useState(false);
  const nextSegment = activeSegmentIndex < segments.length - 1 ? segments[activeSegmentIndex + 1] : undefined;

  // 格式化总时长
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
  };

  return (
    <div className="storyboard-editor">
      {/* 示例工程提示条：「一键换成你的素材」（非示例工程不渲染） */}
      <SampleSwapBanner />
      {/* 顶部紧凑栏：声音（BGM+音效）/ 风格（Logo/字幕/质感）板块（自动高度，不参与垂直调高） */}
      {panels.bgm && <BgmPanel />}
      {panels.brand && <BrandPanel />}

      {/* 片段时间轴区（高度可调，视图菜单可开关） */}
      <div className="se-top" style={{height: topHeight, display: panels.timeline ? undefined : 'none'}}>
        <div className="timeline">
        <div className="timeline-header">
          <span>故事板 ({segments.length} 片段 · {formatDuration(getTotalDuration())})</span>
          <div className="timeline-header-controls">
            {/* 视频体裁：切换 AI 助手的剧本分册与模板推荐口径（只是推荐口径，不影响已搭好的内容） */}
            <select
              className="select-compact"
              value={videoType}
              onChange={(e) => setVideoType(e.target.value as typeof videoType)}
              title="视频体裁：决定 AI 助手的工作流剧本与模板推荐口径，不影响已有内容"
            >
              {VIDEO_TYPES.map((t) => (
                <option key={t} value={t}>体裁：{VIDEO_TYPE_LABEL[t]}</option>
              ))}
            </select>
            {/* 精简/专家切换：默认精简只留核心标签页与控件（专家显示全部） */}
            <div className="mode-switch" title="精简：只显示素材/文字/参数标签页与核心控件；专家：显示全部（样式/布局/特效/旁白/字幕 + 起点、转场细调、缓动曲线）">
              <button
                type="button"
                className={`mode-option ${!proMode ? 'on' : ''}`}
                onClick={() => setAppSettings({editorProMode: false})}
              >
                精简
              </button>
              <button
                type="button"
                className={`mode-option ${proMode ? 'on' : ''}`}
                onClick={() => setAppSettings({editorProMode: true})}
              >
                专家
              </button>
            </div>
            {/* 卡片故事板 ↔ 剪辑软件式时间轴（专家模式高级功能，P2.5 阶段二） */}
            {proMode && (
              <div className="mode-switch" title="顶部区域的两种形态：卡片=按片段浏览编辑；时间轴=剪辑软件式多轨（拖右缘调时长/拖拽重排/转场挂片段边界/音乐淡入淡出/节拍吸附/播放头拆分）">
                <button
                  type="button"
                  className={`mode-option ${!nleView ? 'on' : ''}`}
                  onClick={() => switchTimelineView('cards')}
                >
                  卡片
                </button>
                <button
                  type="button"
                  className={`mode-option ${nleView ? 'on' : ''}`}
                  onClick={() => switchTimelineView('nle')}
                >
                  时间轴
                </button>
              </div>
            )}
            {/* 当前片段模板：缩略图 + 名称按钮，点击打开统一模板选择器（搜索/槽位/来源筛选）；
                引用未安装/已删除模板时显示警告态（保留原占位 option 语义） */}
            <button
              type="button"
              className={`template-picker-btn ${currentTemplateMissing ? 'missing' : ''}`}
              onClick={() => setTemplatePickerOpen(true)}
              title={currentTemplateMissing ? '模板未安装/已删除，点击更换模板' : '当前片段模板（点击更换）'}
            >
              {currentTemplateMissing ? (
                <span className="template-picker-btn-name">
                  ⚠ 未安装：{currentSegment!.templateId.replace(/^mkt-/, '').replace(/^custom-/, '').replace(/^gen-/, '')}
                </span>
              ) : (
                <>
                  <span className="template-picker-btn-thumb">
                    {currentTemplate && currentTemplate.thumbnail !== 'custom' && resolveTemplateThumbnail(currentTemplate.thumbnail) ? (
                      <img src={resolveTemplateThumbnail(currentTemplate.thumbnail)} alt="" />
                    ) : currentTemplate?.thumbnail === 'custom' ? (
                      <Palette size={12} />
                    ) : (
                      <Film size={12} />
                    )}
                  </span>
                  <span className="template-picker-btn-name">{currentTemplate?.name ?? templateId ?? '选择模板'}</span>
                </>
              )}
              <ChevronDown size={12} className="template-picker-btn-caret" />
            </button>
            {/* 模板说明：点击弹窗显示简介 + 使用提示（usageTip，特殊模板的前提条件写在这里） */}
            {currentTemplate && (
              <span className="template-info" ref={templateInfoRef}>
                <button
                  type="button"
                  className="template-info-btn"
                  onClick={toggleTemplateInfo}
                  title="模板说明"
                >
                  <Info size={14} />
                </button>
                {templateInfoOpen && createPortal(
                  <div
                    className="template-info-pop"
                    ref={templateInfoPopRef}
                    style={{top: templateInfoPos.top, left: templateInfoPos.left}}
                  >
                    <div className="template-info-pop-title">{currentTemplate.name}</div>
                    <p className="template-info-pop-desc">{currentTemplate.description}</p>
                    {currentTemplate.usageTip && (
                      <p className="template-info-pop-tip">💡 {currentTemplate.usageTip}</p>
                    )}
                  </div>,
                  document.body,
                )}
              </span>
            )}
            <input
              type="number"
              className="input-compact"
              min={0.5}
              max={60}
              step={0.1}
              value={currentSegment?.duration || 8}
              onChange={(e) => {
                // 钳到 0.5~60 秒（空/非法输入回退 8），支持一位小数——
                // 节拍对齐会产生小数时长（如 4.8s），parseInt 会把它悄悄抹成 4s；
                // 0.5 起步支持快切蒙太奇
                const val = parseFloat(e.target.value);
                setCurrentDuration(Number.isFinite(val) ? Math.max(0.5, Math.min(60, Math.round(val * 10) / 10)) : 8);
                syncCurrentToSegment();
              }}
              title="持续时长（秒，支持一位小数）"
            />
            {proMode && (
              <label className="start-offset-ctrl" title="模板播放起点：从模板动画的第几秒开始播放（跳过入场动画）">
                起点
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, (currentSegment?.duration || 8) - 0.5)}
                  step={0.1}
                  value={Math.min(currentSegment?.startOffsetSec ?? 0, Math.max(0, (currentSegment?.duration || 8) - 0.5))}
                  onChange={(e) => setCurrentStartOffset(Number(e.target.value))}
                />
                <span>{(currentSegment?.startOffsetSec ?? 0).toFixed(1)}s</span>
              </label>
            )}
            <select
              className="select-compact"
              value={currentSegment?.transition || 'crossfade'}
              onChange={(e) => {
                setCurrentTransition(e.target.value as any);
                syncCurrentToSegment();
              }}
              title="过渡效果（到下一片段）"
            >
              {['基础', '遮罩', '运动', '特效', '运镜', '遮挡'].map((group) => (
                <optgroup key={group} label={group}>
                  {TRANSITION_OPTIONS
                    .filter((o) => o.group === group)
                    .map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </optgroup>
              ))}
            </select>
            {proMode && (
              <select
                className="select-compact"
                value={currentSegment?.exitStyle ?? 'sync'}
                onChange={(e) => {
                  const v = e.target.value as SegmentExitStyle;
                  setCurrentExitStyle(v === 'sync' ? undefined : v);
                  syncCurrentToSegment();
                }}
                title="片尾退场预设：同步退场 = 所有元素随转场一次性消失；整体淡出 = 段尾 0.4s 整帧渐隐；留白收尾 = 素材提前退场，文字多留 2-3 秒"
              >
                {EXIT_STYLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>片尾·{o.label}</option>
                ))}
              </select>
            )}
            <button className="btn-add-segment" onClick={handleAddSegment}>+ 添加片段</button>
          </div>
        </div>
        {/* 转场设置行（专家模式）：非硬切且存在下一片段时显示（时长 / 运镜焦点 / 预览） */}
        {proMode && currentSegment && nextSegment && currentSegment.transition !== 'none' && (
          <div className="transition-settings">
            <label className="transition-settings-duration" title="转场时长（0.2-2 秒）。行业规格：快切 8-12 帧（0.3s）、标准 15 帧（0.5s）；有 BGM 时可用「卡点对齐」把时长吸附到半拍">
              转场时长
              <input
                type="number"
                className="input-compact"
                min={0.2}
                max={2}
                step={0.1}
                value={currentSegment.transitionParams?.durationSec ?? getTransitionDefaultSec(currentSegment.transition) ?? DEFAULT_TRANSITION_SEC}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isFinite(v)) return;
                  setCurrentTransitionParams({durationSec: clampTransitionSec(v)});
                }}
              />
              秒
            </label>
            {/* 节奏档位：一键套用行业规格时长（快切 8-12 帧 / 标准 15 帧 / 舒缓 24 帧） */}
            <div className="transition-tempo-chips">
              {[
                {label: '快切', v: 0.3, hint: '8-12 帧快剪节奏'},
                {label: '标准', v: 0.5, hint: '15 帧通用节奏'},
                {label: '舒缓', v: 0.8, hint: '24 帧慢过渡'},
              ].map((c) => {
                const cur = currentSegment.transitionParams?.durationSec ?? getTransitionDefaultSec(currentSegment.transition);
                return (
                  <button
                    key={c.label}
                    className={`tempo-chip ${Math.abs(cur - c.v) < 0.001 ? 'on' : ''}`}
                    title={c.hint}
                    onClick={() => setCurrentTransitionParams({durationSec: c.v})}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            {(currentSegment.transition === 'zoomIn' || currentSegment.transition === 'zoomOut' || currentSegment.transition === 'shapeBloom') && (
              <TransitionFocusPicker
                nextSegment={nextSegment}
                aspectRatioId={aspectRatioId}
                params={currentSegment.transitionParams}
                onChange={(patch) => setCurrentTransitionParams(patch)}
                showZoom={currentSegment.transition !== 'shapeBloom'}
              />
            )}
            {/* 出场转场音效：自动按转场类型匹配；可指定类别或关掉（时间线下方音效轨 ◆ 可点击跳转） */}
            <select
              className="select-compact"
              value={currentSegment.transitionSfx ?? 'auto'}
              onChange={(e) => {
                const v = e.target.value;
                setCurrentTransitionSfx(v === 'auto' ? undefined : (v as SfxKind | 'off'));
              }}
              title="这个转场的音效：自动 = 按转场类型匹配（滑动→短嗖、缩放→低坠…）；关 = 静音。时间线下方的音效轨可点 ◆ 跳到对应片段"
            >
              <option value="auto">音效·自动</option>
              <option value="off">音效·关</option>
              {(Object.keys(SFX_KIND_META) as SfxKind[])
                .filter((k) => k !== 'riser')
                .map((k) => (
                  <option key={k} value={k}>音效·{SFX_KIND_META[k].label}</option>
                ))}
            </select>
            <button
              className="btn-ghost-compact"
              onClick={() => setTransitionPreviewOpen(true)}
              title="在右侧预览区播放本段到下一段的转场"
            >
              <Play size={12} /> 预览转场
            </button>
            <button
              className={`btn-ghost-compact ${showTransitionCurve ? 'active' : ''}`}
              onClick={() => setShowTransitionCurve((v) => !v)}
              title="编辑此转场的缓动曲线（AE 风格速度曲线）"
            >
              <Sparkles size={12} /> 缓动曲线
            </button>
          </div>
        )}
        {/* 转场缓动曲线编辑大窗（专家模式；非硬切可用；开关由缓动曲线按钮控制） */}
        {proMode && currentSegment && nextSegment && currentSegment.transition !== 'none' && (
          <CurveEditorModal
            open={showTransitionCurve}
            title="转场缓动曲线"
            curve={currentSegment.transitionParams?.curve ?? presetCurve(DEFAULT_TRANSITION_PRESET[currentSegment.transition] ?? 'easeOut')}
            onChange={(c) => setCurrentTransitionParams({curve: c})}
            onClose={() => setShowTransitionCurve(false)}
          />
        )}
        {/* 专家模式·时间轴视图：剪辑软件式多轨（P2.5 阶段二），替换卡片轨 + 音效轨 */}
        {nleView ? (
          <TimelinePanel />
        ) : (
        <>
        <div
          className="timeline-tracks"
          onDragOver={(e) => {
            if (cardDrag !== null) e.preventDefault(); // 允许在卡片间隙/尾部空白落下
          }}
          onDrop={handleCardDrop}
        >
          {segments.map((seg, i) => {
            const tmpl = allTemplates.find((t) => t.id === seg.templateId);
            // 数据驱动模板（自定义被删/市场未安装）与已删除的 AI 生成模板显式标注，不再静默显示裸 id
            const missing =
              (isDataDrivenTemplateId(seg.templateId) && !findDataDrivenDef(seg.templateId, customTemplates, marketTemplates)) ||
              (isGeneratedTemplateId(seg.templateId) && !findGeneratedDef(seg.templateId, generatedTemplates));
            // 卡片拖拽重排（HTML5 DnD）：跨多段移动不再逐格点左右按钮；与时间轴整块拖拽同语义
            const dragging = cardDrag?.from === i;
            const insertBefore = cardDrag?.insert === i;
            const insertAfter = cardDrag?.insert === i + 1;
            return (
              <div
                key={seg.id}
                className={`timeline-item ${i === activeSegmentIndex ? 'active' : ''} ${dragging ? 'dragging' : ''} ${insertBefore ? 'insert-before' : ''} ${insertAfter && !dragging ? 'insert-after' : ''}`}
                draggable
                onDragStart={(e) => {
                  setCardDrag({from: i, insert: i});
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(i)); // Firefox 需要非空 data 才启动拖拽
                }}
                onDragEnd={() => setCardDrag(null)}
                onDragOver={(e) => {
                  if (cardDrag === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const insert = e.clientX - rect.left < rect.width / 2 ? i : i + 1;
                  if (insert !== cardDrag.insert) setCardDrag({from: cardDrag.from, insert});
                }}
                onClick={() => handleSelectSegment(i)}
              >
                <div className="timeline-thumb">
                  {seg.videos[0]?.thumbnail ? (
                    <img className="thumb-img" src={seg.videos[0].thumbnail} alt="" />
                  ) : (
                    <span className="thumb-icon"><Film size={16} /></span>
                  )}
                  <span className="thumb-num">{i + 1}</span>
                </div>
                <div className="timeline-info">
                  <span className={`timeline-name ${missing ? 'missing-template' : ''}`} title={missing ? '该模板未安装：自定义模板可能已删除，云端模板请到「模板市场」安装' : undefined}>
                    {missing ? `⚠ 未安装：${seg.templateId.replace(/^mkt-/, '').replace(/^custom-/, '')}` : (tmpl?.name || seg.templateId)}
                  </span>
                  <span className="timeline-duration">{seg.duration.toFixed(1)}秒</span>
                </div>
                <div className="timeline-actions">
                  <button
                    className="btn-icon"
                    style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                    onClick={(e) => {e.stopPropagation(); handleMoveSegment(i, -1);}}
                    title="左移"
                    disabled={i === 0}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <button
                    className="btn-icon"
                    style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                    onClick={(e) => {e.stopPropagation(); handleMoveSegment(i, 1);}}
                    title="右移"
                    disabled={i === segments.length - 1}
                  >
                    <ArrowRight size={14} />
                  </button>
                  <button
                    className="btn-icon"
                    style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                    onClick={(e) => {e.stopPropagation(); handleDuplicate(i);}}
                    title="复制"
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="btn-icon btn-danger"
                    style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                    onClick={(e) => {e.stopPropagation(); handleDeleteSegment(i);}}
                    title="删除"
                    disabled={segments.length <= 1}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {/* 音效轨：转场音效 ◆ / 节拍重音 ● / 轻点 · / 片头上升音 ▮（与渲染同源摆放） */}
        <SfxLane
          segments={segments}
          bgm={bgm}
          sfx={sfx}
          onSelectSegment={handleSelectSegment}
        />
        </>
        )}
      </div>

      </div>
      {panels.timeline && hasBottom && (
        <Splitter orientation="horizontal" onDelta={(_, dy) => adjustTopHeight(dy)} />
      )}

      {/* 主编辑区 */}
      <div className="editor-content">
        {/* 左侧：片段编辑器 */}
        <div className="editor-left" style={{width: panels.preview ? leftWidth : '100%', display: panels.editor ? undefined : 'none'}}>
          <div className="editor-tabs">
            {visibleTabs.map((id) => {
              const meta = EDITOR_TAB_META[id];
              return (
                <button
                  key={id}
                  className={`tab ${view === id ? 'active' : ''}`}
                  style={{display: 'inline-flex', alignItems: 'center', gap: '6px'}}
                  onClick={() => setView(id)}
                >
                  {meta.icon} {meta.label}
                </button>
              );
            })}
          </div>
          <div className="editor-tab-content">
            {view === 'video' && (
              <>
                {/* 项目素材库（全局素材池）：导入一次多段复用 + 自动配段 */}
                <MediaPoolPanel />
                <VideoUploader />
              </>
            )}
            {view === 'text' && <TextEditor />}
            {view === 'style' && <StyleEditor />}
            {view === 'layout' && <LayoutEditor />}
            {view === 'params' && <TemplateParamsEditor />}
            {view === 'narration' && <NarrationPanel />}
            {view === 'captions' && <CaptionPanel />}
            {view === 'effects' && (
              <div className="effects-editor">
                <div className="effects-section">
                  <h4 style={{display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 14, fontWeight: 600, margin: '0 0 4px'}}>
                    <Sparkles size={14} /> 视频画布特效
                  </h4>
                  <p style={{fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px', lineHeight: 1.6}}>
                    作用于本片段所有视频框（不影响背景与文字）。
                  </p>
                  <select
                    className="select-compact"
                    style={{width: '100%'}}
                    value={currentSegment?.videoEffect || 'none'}
                    onChange={(e) => {
                      setCurrentVideoEffect(e.target.value as VideoEffect);
                      syncCurrentToSegment();
                    }}
                    title="视频画布特效"
                  >
                    {['无', '故障', '流动', '氛围', '运动', '交互'].map((group) => (
                      <optgroup key={group} label={group}>
                        {VIDEO_EFFECT_OPTIONS
                          .filter((o) => o.group === group)
                          .map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {(() => {
                    const sel = VIDEO_EFFECT_OPTIONS.find((o) => o.value === (currentSegment?.videoEffect || 'none'));
                    return sel && sel.value !== 'none' ? (
                      <p style={{fontSize: 12, color: 'var(--color-text-secondary)', margin: '10px 0 0', lineHeight: 1.6}}>
                        {sel.desc}
                      </p>
                    ) : null;
                  })()}
                </div>

                <div className="effects-section" style={{marginTop: 20}}>
                  <h4 style={{display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: 14, fontWeight: 600, margin: '0 0 4px'}}>
                    <ImageIcon size={14} /> 背景特效
                  </h4>
                  <p style={{fontSize: 12, color: 'var(--color-text-secondary)', margin: '0 0 12px', lineHeight: 1.6}}>
                    作用于片段背景层（与视频画布特效独立调整，不影响视频框）。
                  </p>
                  <select
                    className="select-compact"
                    style={{width: '100%'}}
                    value={currentSegment?.backgroundEffect || 'none'}
                    onChange={(e) => {
                      setCurrentBackgroundEffect(e.target.value as BackgroundEffect);
                      syncCurrentToSegment();
                    }}
                    title="背景特效"
                  >
                    {['无', '国风', '商业'].map((group) => (
                      <optgroup key={group} label={group}>
                        {BACKGROUND_EFFECT_OPTIONS
                          .filter((o) => o.group === group)
                          .map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {(() => {
                    const sel = BACKGROUND_EFFECT_OPTIONS.find((o) => o.value === (currentSegment?.backgroundEffect || 'none'));
                    return sel && sel.value !== 'none' ? (
                      <p style={{fontSize: 12, color: 'var(--color-text-secondary)', margin: '10px 0 0', lineHeight: 1.6}}>
                        {sel.desc}
                      </p>
                    ) : null;
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>

        {panels.editor && panels.preview && (
          <Splitter orientation="vertical" onDelta={(dx) => adjustLeftWidth(dx)} />
        )}

        {/* 右侧：预览（v4：片段 ↔ 全片下拉切换；全片 = 时间轴整片监视器停靠成大窗） */}
        <div className="editor-right" style={{display: panels.preview ? undefined : 'none'}}>
          <div className="preview-header">
            <span className="preview-label">{transitionPreviewOpen ? '转场预览' : rightPreview === 'full' ? '全片预览' : '片段预览'}</span>
            <div className="preview-controls">
              {transitionPreviewOpen ? (
                <button
                  className="btn-ghost-compact"
                  onClick={() => setTransitionPreviewOpen(false)}
                  title="退出转场预览，回到片段预览"
                >
                  <X size={12} /> 退出
                </button>
              ) : (
                <>
                  <select
                    className="preview-mode-select"
                    value={rightPreview}
                    onChange={(e) => {
                      if (e.target.value === 'full') dockMonitor();
                      else undockMonitor();
                    }}
                    title="右侧预览内容：片段 = 当前片段模板预览；全片 = 整片监视器停靠成大窗（与时间轴播放头联动，切回片段预览小窗自动恢复）"
                  >
                    <option value="segment">片段预览</option>
                    <option value="full">全片预览</option>
                  </select>
                  {rightPreview === 'full' ? (
                    <button
                      className="btn-ghost-compact"
                      onClick={() => undockMonitor()}
                      title="取消停靠，回到时间轴浮动小窗"
                    >
                      <Maximize2 size={12} /> 小窗
                    </button>
                  ) : (
                    <>
                      <select
                        className="preview-mode-select"
                        value={previewMode}
                        onChange={(e) => {
                          const mode = e.target.value as 'once' | 'loop';
                          setPreviewMode(mode);
                          // 选「循环播放」立即从头重播，不用再点重播按钮
                          if (mode === 'loop') previewPlayerRef.current?.replay();
                        }}
                        title="播放模式"
                      >
                        <option value="once">播放一遍</option>
                        <option value="loop">循环播放</option>
                      </select>
                      <button
                        className="btn-ghost-compact"
                        onClick={() => previewPlayerRef.current?.replay()}
                        title="重新播放"
                      >
                        <RotateCw size={12} />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
            <span className="preview-orientation">
              {getAspectRatioPreset(aspectRatioId).label}
            </span>
          </div>
          <div
            className={`preview-canvas ${orientation}`}
            style={{aspectRatio: `${getAspectRatioPreset(aspectRatioId).width} / ${getAspectRatioPreset(aspectRatioId).height}`}}
          >
            {rightPreview === 'full' ? (
              <>
                {/* 全片预览停靠槽：时间轴整片监视器 portal 进来（画幅 letterbox 由播放器按画幅预设处理）。
                    转场预览打开时以覆盖层盖住但保持停靠槽挂载（退出转场预览即恢复全片画面） */}
                <div className="dock-monitor-slot" data-dock-monitor-slot />
                {transitionPreviewOpen && currentSegment && nextSegment && (
                  <div className="preview-cover">
                    <TransitionPreviewPlayer
                      key={`${currentSegment.id}->${nextSegment.id}`}
                      segments={segments}
                      segmentIndex={activeSegmentIndex}
                      orientation={orientation}
                      aspectRatioId={aspectRatioId}
                      customTemplates={[...customTemplates, ...marketTemplates.map((t) => t.def)]}
                      generatedTemplates={generatedTemplates}
                    />
                  </div>
                )}
              </>
            ) : transitionPreviewOpen && currentSegment && nextSegment ? (
              <TransitionPreviewPlayer
                key={`${currentSegment.id}->${nextSegment.id}`}
                segments={segments}
                segmentIndex={activeSegmentIndex}
                orientation={orientation}
                aspectRatioId={aspectRatioId}
                customTemplates={[...customTemplates, ...marketTemplates.map((t) => t.def)]}
                generatedTemplates={generatedTemplates}
              />
            ) : currentSegment && (videos.length > 0 || currentCustomDef || currentGenDef || currentTemplate?.maxVideos === 0) ? (
              <RemotionPreviewPlayer
                key={`${currentSegment.id}-${currentGenDef?.updatedAt ?? 0}`}
                ref={previewPlayerRef}
                inputProps={currentInputProps}
                orientation={orientation}
                aspectRatioId={aspectRatioId}
                templateId={currentSegment.templateId}
                duration={currentSegment.duration}
                startOffsetSec={currentSegment.startOffsetSec ?? 0}
                loop={previewMode === 'loop'}
                customTemplateDef={currentCustomDef}
                generatedTemplateDef={currentGenDef}
              />
            ) : (
              <div className="preview-empty">
                <div className="empty-icon"><Clapperboard size={40} /></div>
                <p>上传素材后显示预览</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部操作 */}
      <div className="editor-footer">
        <button className="btn-secondary" onClick={handleBack}>
          <ArrowLeft size={14} /> 上一步
        </button>
        <button className="btn-primary" onClick={handleNext}>
          下一步：渲染导出 →
        </button>
      </div>

      {/* 统一模板选择器（onSelect 保持原下拉语义：换模板并同步回当前片段） */}
      <TemplatePickerModal
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        onSelect={(id) => {
          setCurrentTemplate(id);
          syncCurrentToSegment();
        }}
        templates={allTemplates}
        currentId={templateId ?? undefined}
        videoType={videoType}
        title="更换当前片段模板"
      />
    </div>
  );
};

export default StoryboardEditor;
