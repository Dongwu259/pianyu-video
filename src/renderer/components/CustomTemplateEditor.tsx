/**
 * CustomTemplateEditor - 自定义模板生成器（全屏 AE 风格）
 *
 * 布局：顶部工具栏 | 左 元素栏 | 中 大画布预览 | 右 检查器 | 底 时间轴
 * 用户摆放视频框/文本框，用关键帧动画化属性，存成可复用模板，支持导出/导入。
 */

import React, {useState, useEffect, useRef, useCallback} from 'react';
import {useProjectStore} from '../store/projectStore';
import {CustomTemplateCanvas} from './CustomTemplateCanvas';
import {Timeline} from './Timeline';
import type {SelectedKeyframe} from './Timeline';
import {TEMPLATES} from '../../shared/template-registry';
import type {CustomTemplateDef, CustomElement, AnimatedProp, TextRole, EntranceAnim, ShapeKind, ParamBinding} from '../../shared/custom-template';
import {
  createBlankCustomTemplate,
  createVideoElement,
  createTextElement,
  createShapeElement,
  setKeyframe,
  removeKeyframe,
  evalProp,
  builtInTemplateToCustom,
  ENTRANCE_ANIM_OPTIONS,
  detectTextSlots,
  TEXT_SLOT_VALUES,
  TEXT_SLOT_OPTIONS,
} from '../../shared/custom-template';
import {ASPECT_RATIO_PRESETS, getAspectRatioPreset} from '../../shared/aspect-ratios';
import {Palette, Download, Save, Upload, Video, Type, X, Copy, ArrowLeft, SkipBack, SkipForward, Play, Pause, Square, Package, Plus} from 'lucide-react';
import type {Orientation, TemplateParamSpec} from '../../shared/types';
import './CustomTemplateEditor.css';

const FPS = 30;

interface Props {
  onClose: () => void;
  /** 打开后直接加载编辑该 id 的自定义模板（从模板管理跳入） */
  initialEditId?: string;
}

/** 属性是否已关键帧化 */
const isKeyframed = (p: AnimatedProp): boolean => !!p.keyframes && p.keyframes.length > 0;

/** 更新属性值：已关键帧则在当前时间打关键帧，否则改 static */
const updatePropValue = (p: AnimatedProp, t: number, value: number): AnimatedProp => {
  if (isKeyframed(p)) return setKeyframe(p, t, value);
  return {...p, static: value};
};

type AnimKey = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'scale';

export const CustomTemplateEditor: React.FC<Props> = ({onClose, initialEditId}) => {
  const {
    customTemplates,
    upsertCustomTemplate,
    removeCustomTemplate,
    loadCustomTemplates,
    setCurrentTemplate,
    syncCurrentToSegment,
    setStep,
  } = useProjectStore();

  const [def, setDef] = useState<CustomTemplateDef | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [builtInId, setBuiltInId] = useState('RevealSlide');
  const [selectedKf, setSelectedKf] = useState<SelectedKeyframe | null>(null);
  const [showMotionPath, setShowMotionPath] = useState(true);
  const [showSafeArea, setShowSafeArea] = useState(false);
  const playRef = useRef<number | null>(null);

  useEffect(() => { loadCustomTemplates(); }, [loadCustomTemplates]);

  // 从模板管理跳入：customTemplates 到位后直接加载该模板进入编辑态
  useEffect(() => {
    if (!initialEditId || def) return;
    const t = customTemplates.find((x) => x.id === initialEditId);
    if (t) {
      setDef(JSON.parse(JSON.stringify(t)));
      setSelectedId(t.elements[0]?.id || '');
    }
  }, [initialEditId, customTemplates, def]);

  const totalFrames = def ? Math.round(def.duration * FPS) : 0;

  // 播放循环
  useEffect(() => {
    if (!playing || !def) return;
    const tick = () => {
      setFrame((f) => {
        const next = f + 1;
        return next >= totalFrames ? 0 : next;
      });
      playRef.current = requestAnimationFrame(tick);
    };
    playRef.current = requestAnimationFrame(tick);
    return () => { if (playRef.current) cancelAnimationFrame(playRef.current); };
  }, [playing, def, totalFrames]);

  // 切换模板时重置
  useEffect(() => { setFrame(0); setPlaying(false); setSelectedKf(null); }, [def?.id]);

  const handleNew = () => {
    const orient: Orientation = (def?.orientation) || 'landscape';
    const t = createBlankCustomTemplate(orient);
    setDef(t);
    setSelectedId(t.elements[0]?.id || '');
  };

  const handleNewFromBuiltIn = () => {
    const orient: Orientation = (def?.orientation) || 'landscape';
    const t = builtInTemplateToCustom(builtInId, orient);
    setDef(t);
    setSelectedId(t.elements[0]?.id || '');
  };

  const handleEdit = (t: CustomTemplateDef) => {
    setDef(JSON.parse(JSON.stringify(t)));
    setSelectedId(t.elements[0]?.id || '');
  };

  const handleSave = async () => {
    if (!def) return;
    await upsertCustomTemplate(def);
    alert(`模板「${def.name}」已保存`);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('删除此自定义模板？')) return;
    await removeCustomTemplate(id);
    if (def?.id === id) setDef(null);
  };

  const handleExport = async () => {
    if (!def) return;
    const r = await window.api.exportCustomTemplate(def);
    if (!r.success) alert('导出失败：' + (r.error || ''));
  };

  // 导出市场模板包（.vttemplate）：收集 manifest 信息后走主进程校验+落盘
  const handleExportPack = async () => {
    if (!def) return;
    const description = prompt('模板描述（展示在模板市场）：', def.description || '') ?? '';
    const author = prompt('作者署名：', '片语') ?? '';
    const tagsRaw = prompt('标签（逗号分隔，可空）：', '') ?? '';
    const r = await window.api.exportCustomTemplatePack(def, {
      description: description.trim() || undefined,
      author: author.trim() || undefined,
      tags: tagsRaw.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
    });
    if (r.success) {
      alert(`模板包已导出：${r.path}\n包 id：${r.packId}\n可用 server/scripts/publish-template.mjs 发布到市场。`);
    } else if (r.error) {
      alert('导出模板包失败：' + r.error);
    }
  };

  const handleImport = async () => {
    const r = await window.api.importCustomTemplate();
    if (r && r.success && r.def) {
      await upsertCustomTemplate(r.def);
      handleEdit(r.def);
    } else if (r && !r.success) {
      alert('导入失败：' + (r.error || ''));
    }
  };

  const handleUseInStoryboard = () => {
    if (!def) return;
    setCurrentTemplate(def.id);
    syncCurrentToSegment();
    setStep(2);
    onClose();
  };

  const handleAspectChange = (id: string) => {
    const preset = getAspectRatioPreset(id);
    updateDef((d) => ({...d, aspectRatioId: preset.id, orientation: preset.orientation}));
  };

  // ====== 元素操作 ======
  const updateDef = (updater: (d: CustomTemplateDef) => CustomTemplateDef) => {
    setDef((d) => (d ? updater(d) : d));
  };

  const updateElement = useCallback((updater: (el: CustomElement) => CustomElement) => {
    setDef((d) => (d ? {...d, elements: d.elements.map((el) => (el.id === selectedId ? updater(el) : el))} : d));
  }, [selectedId]);

  const addVideo = () => {
    if (!def) return;
    const el = createVideoElement(`视频框 ${def.elements.filter((e) => e.type === 'video').length + 1}`);
    updateDef((d) => ({...d, elements: [...d.elements, el]}));
    setSelectedId(el.id);
  };

  const addText = (role: TextRole) => {
    if (!def) return;
    const el = createTextElement(role);
    updateDef((d) => ({...d, elements: [...d.elements, el]}));
    setSelectedId(el.id);
  };

  const addShape = (shape: ShapeKind) => {
    if (!def) return;
    const label = {rect: '矩形', ellipse: '圆形', line: '线条'}[shape];
    const el = createShapeElement(shape, `${label} ${def.elements.filter((e) => e.type === 'shape').length + 1}`);
    updateDef((d) => ({...d, elements: [...d.elements, el]}));
    setSelectedId(el.id);
  };

  // ====== 模板参数（滑块）管理 ======

  const addParamSpec = () => {
    if (!def) return;
    const n = (def.paramSpecs?.length ?? 0) + 1;
    const spec: TemplateParamSpec = {key: `param${n}`, label: `参数 ${n}`, min: 0, max: 2, step: 0.1, default: 1};
    updateDef((d) => ({...d, paramSpecs: [...(d.paramSpecs ?? []), spec]}));
  };

  const updateParamSpec = (idx: number, partial: Partial<TemplateParamSpec>) => {
    updateDef((d) => {
      const oldKey = d.paramSpecs?.[idx]?.key;
      const next = (d.paramSpecs ?? []).map((s, i) => (i === idx ? {...s, ...partial} : s));
      // key 改名时同步更新引用它的绑定，避免悬空
      const bindings = oldKey && partial.key && partial.key !== oldKey
        ? (d.paramBindings ?? []).map((b) => (b.paramKey === oldKey ? {...b, paramKey: partial.key!} : b))
        : d.paramBindings;
      return {...d, paramSpecs: next, paramBindings: bindings};
    });
  };

  const removeParamSpec = (idx: number) => {
    updateDef((d) => {
      const key = d.paramSpecs?.[idx]?.key;
      return {
        ...d,
        paramSpecs: (d.paramSpecs ?? []).filter((_, i) => i !== idx),
        // 同步清理引用该参数的绑定，避免留下悬空绑定
        paramBindings: (d.paramBindings ?? []).filter((b) => b.paramKey !== key),
      };
    });
  };

  const addParamBinding = () => {
    if (!def || !def.paramSpecs || def.paramSpecs.length === 0 || def.elements.length === 0) return;
    const binding: ParamBinding = {
      paramKey: def.paramSpecs[0].key,
      elementId: def.elements[0].id,
      prop: 'scale',
      mode: 'multiply',
    };
    updateDef((d) => ({...d, paramBindings: [...(d.paramBindings ?? []), binding]}));
  };

  const updateParamBinding = (idx: number, partial: Partial<ParamBinding>) => {
    updateDef((d) => ({
      ...d,
      paramBindings: (d.paramBindings ?? []).map((b, i) => (i === idx ? {...b, ...partial} : b)),
    }));
  };

  const removeParamBinding = (idx: number) => {
    updateDef((d) => ({...d, paramBindings: (d.paramBindings ?? []).filter((_, i) => i !== idx)}));
  };

  const deleteElement = (elId: string) => {
    updateDef((d) => ({...d, elements: d.elements.filter((el) => el.id !== elId)}));
    if (selectedId === elId) setSelectedId('');
  };

  // 拖拽移动：已关键帧则打关键帧，否则改 static
  const handleMove = useCallback((elId: string, x: number, y: number) => {
    const t = totalFrames > 0 ? frame / totalFrames : 0;
    setDef((d) => (d ? {
      ...d,
      elements: d.elements.map((el) => el.id === elId ? {
        ...el,
        x: isKeyframed(el.x) ? setKeyframe(el.x, t, x) : {...el.x, static: x},
        y: isKeyframed(el.y) ? setKeyframe(el.y, t, y) : {...el.y, static: y},
      } : el),
    } : d));
  }, [frame, totalFrames]);

  // 键盘快捷键：Space 播放 · 方向键 逐帧(Shift×10) · Del 删关键帧
  useEffect(() => {
    if (!def) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setFrame((f) => Math.max(0, f - (e.shiftKey ? 10 : 1)));
        setPlaying(false);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setFrame((f) => Math.min(totalFrames - 1, f + (e.shiftKey ? 10 : 1)));
        setPlaying(false);
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && selectedKf) {
        e.preventDefault();
        updateElement((el) => ({...el, [selectedKf.prop]: removeKeyframe(el[selectedKf.prop], selectedKf.t)} as CustomElement));
        setSelectedKf(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [def, totalFrames, selectedKf, updateElement]);

  // ====== 空状态 ======
  if (!def) {
    return (
      <div className="cte-fullscreen cte-empty-state" onClick={onClose}>
        <div className="cte-empty-card" onClick={(e) => e.stopPropagation()}>
          <button className="cte-close" onClick={onClose}><X size={18} /></button>
          <h2><Palette size={18} /> 自定义模板编辑器</h2>
          <p className="cte-empty-hint">新建一个模板开始，或从下方选择已有模板编辑</p>
          <div className="cte-toolbar">
            <button className="btn-primary" onClick={handleNew}>+ 新建空白模板</button>
            <div className="cte-builtin-picker">
              <select value={builtInId} onChange={(e) => setBuiltInId(e.target.value)}>
                {TEMPLATES.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
              </select>
              <button className="btn-secondary" onClick={handleNewFromBuiltIn}>从内置模板创建副本</button>
            </div>
            <button className="btn-secondary" onClick={handleImport}><Download size={14} /> 导入 JSON</button>
          </div>
          <div className="cte-list">
            {customTemplates.length === 0 && <p className="cte-list-empty">还没有自定义模板</p>}
            {customTemplates.map((t) => (
              <div key={t.id} className="cte-list-item">
                <span className="cte-list-name">{t.name}</span>
                <button className="btn-small" onClick={() => handleEdit(t)}>编辑</button>
                <button className="btn-small btn-danger" onClick={() => handleDelete(t.id)}>删</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const selectedEl = def.elements.find((el) => el.id === selectedId) || null;
  const t = totalFrames > 0 ? frame / totalFrames : 0;
  const arId = def.aspectRatioId || (def.orientation === 'portrait' ? '9-16' : '16-9');

  // 检查器属性行（数值输入；已关键帧则改值即在播放头打关键帧）
  const PropRow = ({label, propKey, prop, min, max, step}: {
    label: string;
    propKey: AnimKey;
    prop: AnimatedProp;
    min?: number; max?: number; step?: number;
  }) => {
    const current = evalProp(prop, frame, totalFrames, prop.static ?? 0);
    return (
      <div className="cte-prop-row">
        <span className="cte-prop-label">
          {isKeyframed(prop) && <span className="cte-kf-dot" title="已关键帧化">◆</span>}
          {label}
        </span>
        <input
          type="number"
          className="cte-prop-input"
          value={Number(current.toFixed(3))}
          min={min} max={max} step={step}
          onChange={(e) => updateElement((el) => ({...el, [propKey]: updatePropValue(el[propKey], t, Number(e.target.value))} as CustomElement))}
        />
      </div>
    );
  };

  return (
    <div className="cte-fullscreen">
      {/* 顶部工具栏 */}
      <div className="cte-topbar">
        <button className="cte-close" onClick={onClose} title="退出编辑器"><ArrowLeft size={18} /></button>
        <input
          className="cte-name-input"
          value={def.name}
          onChange={(e) => updateDef((d) => ({...d, name: e.target.value}))}
          placeholder="模板名称"
        />
        <label className="cte-field">
          背景色
          <input type="text" value={def.background}
            onChange={(e) => updateDef((d) => ({...d, background: e.target.value}))}
            className="cte-bg-input" />
        </label>
        <label className="cte-field">
          时长(秒)
          <input type="number" min={3} max={30} value={def.duration}
            onChange={(e) => updateDef((d) => ({...d, duration: Number(e.target.value) || 8}))}
            className="cte-num-input" />
        </label>
        <label className="cte-field">
          比例
          <select value={arId} onChange={(e) => handleAspectChange(e.target.value)}>
            {ASPECT_RATIO_PRESETS.map((p) => (<option key={p.id} value={p.id}>{p.label} {p.name}</option>))}
          </select>
        </label>
        <div className="cte-topbar-actions">
          <button className="btn-primary" onClick={handleSave}><Save size={14} /> 保存</button>
          <button className="btn-secondary" onClick={handleExport}><Upload size={14} /> 导出</button>
          <button className="btn-secondary" onClick={handleExportPack} title="导出为市场模板包（.vttemplate），可发布到云端模板市场"><Package size={14} /> 导出模板包</button>
          <button className="btn-secondary" onClick={handleUseInStoryboard}>用到故事板 →</button>
        </div>
      </div>

      {/* 主体：左 元素栏 | 中 画布 | 右 检查器 */}
      <div className="cte-main">
        <div className="cte-sidebar">
          <div className="cte-sidebar-title">元素</div>
          <div className="cte-add-btns">
            <button className="btn-small" onClick={addVideo}>+ 视频框</button>
            <button className="btn-small" onClick={() => addText('title')}>+ 标题</button>
            <button className="btn-small" onClick={() => addText('subtitle')}>+ 副标题</button>
            <button className="btn-small" onClick={() => addText('brand')}>+ 品牌</button>
            <button className="btn-small" onClick={() => addShape('rect')} title="装饰矩形（渐变/描边/模糊）">+ 矩形</button>
            <button className="btn-small" onClick={() => addShape('ellipse')} title="装饰圆形">+ 圆形</button>
            <button className="btn-small" onClick={() => addShape('line')} title="装饰线条（分割线）">+ 线条</button>
          </div>
          <div className="cte-element-list">
            {def.elements.map((el) => (
              <div key={el.id} className={`cte-element-item ${selectedId === el.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(el.id)}>
                <span>{el.type === 'video' ? <Video size={12} /> : el.type === 'shape' ? <Square size={12} /> : <Type size={12} />} {el.name}</span>
                <button className="btn-small btn-danger" onClick={(e) => { e.stopPropagation(); deleteElement(el.id); }}><X size={12} /></button>
              </div>
            ))}
          </div>

          <div className="cte-sidebar-title" style={{marginTop: 12}}>模板</div>
          <button className="btn-small cte-new-btn" onClick={handleNew}>+ 新建空白</button>
          <button className="btn-small" onClick={handleImport}><Download size={14} /> 导入</button>
          <div className="cte-builtin-mini">
            <select value={builtInId} onChange={(e) => setBuiltInId(e.target.value)} title="选内置模板创建副本">
              {TEMPLATES.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
            </select>
            <button className="btn-small" onClick={handleNewFromBuiltIn} title="基于内置模板创建可编辑副本"><Copy size={14} /> 从内置</button>
          </div>
          <div className="cte-list">
            {customTemplates.map((t) => (
              <div key={t.id} className={`cte-list-item ${def.id === t.id ? 'current' : ''}`}>
                <span className="cte-list-name" onClick={() => handleEdit(t)}>{t.name}</span>
                <button className="btn-small btn-danger" onClick={() => handleDelete(t.id)}>删</button>
              </div>
            ))}
          </div>
        </div>

        <div className="cte-canvas-area">
          <div className="cte-canvas-wrap">
            <CustomTemplateCanvas
              def={def}
              frame={frame}
              totalFrames={totalFrames}
              aspectRatioId={arId}
              editable
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={handleMove}
              showMotionPath={showMotionPath}
              showSafeArea={showSafeArea}
            />
          </div>
          <div className="cte-transport">
            <button className="cte-transport-btn" onClick={() => { setFrame(0); setPlaying(false); }} title="首帧"><SkipBack size={14} /></button>
            <button className="cte-play-btn" onClick={() => setPlaying((p) => !p)}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
            <button className="cte-transport-btn" onClick={() => { setFrame(Math.max(0, totalFrames - 1)); setPlaying(false); }} title="末帧"><SkipForward size={14} /></button>
            <span className="cte-frame-label">帧 {frame} / {totalFrames} · {(t * 100).toFixed(0)}%</span>
            <div className="cte-toggles">
              <button
                className={`cte-toggle ${showMotionPath ? 'active' : ''}`}
                onClick={() => setShowMotionPath((v) => !v)}
                title="显示运动路径"
              >路径</button>
              <button
                className={`cte-toggle ${showSafeArea ? 'active' : ''}`}
                onClick={() => setShowSafeArea((v) => !v)}
                title="显示安全区引导线"
              >安全区</button>
            </div>
            <span className="cte-shortcut-hint">Space 播放 · ←/→ 逐帧(Shift×10) · Del 删关键帧</span>
          </div>
        </div>

        <div className="cte-inspector">
          {selectedEl ? (
            <>
              <div className="cte-section-title">属性：{selectedEl.name}</div>
              <div className="cte-prop-grid">
                <PropRow label="X" propKey="x" prop={selectedEl.x} min={0} max={1} step={0.01} />
                <PropRow label="Y" propKey="y" prop={selectedEl.y} min={0} max={1} step={0.01} />
                <PropRow label="宽" propKey="width" prop={selectedEl.width} min={0.05} max={1} step={0.01} />
                <PropRow label="高" propKey="height" prop={selectedEl.height} min={0.05} max={1} step={0.01} />
                <PropRow label="旋转" propKey="rotation" prop={selectedEl.rotation} min={-360} max={360} step={1} />
                <PropRow label="透明度" propKey="opacity" prop={selectedEl.opacity} min={0} max={1} step={0.05} />
                <PropRow label="缩放" propKey="scale" prop={selectedEl.scale} min={0.1} max={3} step={0.05} />
              </div>

              <div className="cte-section-title" style={{marginTop: 12}}>静态属性</div>
              <div className="cte-prop-row">
                <span className="cte-prop-label">圆角</span>
                <input type="number" min={0} max={100} value={selectedEl.borderRadius ?? 0}
                  onChange={(e) => updateElement((el) => ({...el, borderRadius: Number(e.target.value)}))}
                  className="cte-prop-input" />
              </div>
              <div className="cte-prop-row">
                <span className="cte-prop-label">透视</span>
                <input type="number" min={0} value={selectedEl.perspective ?? 1200}
                  onChange={(e) => updateElement((el) => ({...el, perspective: Number(e.target.value)}))}
                  className="cte-prop-input" />
              </div>
              <div className="cte-prop-row">
                <span className="cte-prop-label">rotateX</span>
                <input type="number" value={selectedEl.rotateX ?? 0}
                  onChange={(e) => updateElement((el) => ({...el, rotateX: Number(e.target.value)}))}
                  className="cte-prop-input" />
                <span className="cte-prop-label">rotateY</span>
                <input type="number" value={selectedEl.rotateY ?? 0}
                  onChange={(e) => updateElement((el) => ({...el, rotateY: Number(e.target.value)}))}
                  className="cte-prop-input" />
              </div>

              <div className="cte-section-title" style={{marginTop: 12}}>入场动画</div>
              <div className="cte-prop-row">
                <span className="cte-prop-label">预设</span>
                <select
                  value={selectedEl.entranceAnim ?? 'none'}
                  onChange={(e) => updateElement((el) => ({...el, entranceAnim: e.target.value as EntranceAnim}))}
                >
                  {['基础', '滑入', '缩放', '特效'].map((group) => (
                    <optgroup key={group} label={group}>
                      {ENTRANCE_ANIM_OPTIONS
                        .filter((o) => o.group === group && !(o.textOnly && selectedEl.type === 'video'))
                        .map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {selectedEl.type === 'text' && (
                <>
                  <div className="cte-section-title" style={{marginTop: 12}}>文本</div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">角色</span>
                    <select value={selectedEl.textRole || 'title'}
                      onChange={(e) => updateElement((el) => ({...el, textRole: e.target.value as TextRole}))}>
                      <option value="title">标题</option>
                      <option value="subtitle">副标题</option>
                      <option value="feature">功能</option>
                      <option value="brand">品牌</option>
                    </select>
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">固定文本</span>
                    <input type="text" value={selectedEl.fixedText ?? ''} placeholder="留空=跟随角色内容"
                      title="设置后优先显示该文本（装饰符号用，如 “ ★ →）"
                      onChange={(e) => updateElement((el) => ({...el, fixedText: e.target.value || undefined}))}
                      className="cte-prop-input" style={{flex: 1}} />
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">字号</span>
                    <input type="number" min={8} max={200} value={selectedEl.textStyle?.fontSize ?? 48}
                      onChange={(e) => updateElement((el) => ({...el, textStyle: {...(el.textStyle || {}), fontSize: Number(e.target.value)}}))}
                      className="cte-prop-input" />
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">颜色</span>
                    <input type="color" value={selectedEl.textStyle?.color ?? '#111827'}
                      onChange={(e) => updateElement((el) => ({...el, textStyle: {...(el.textStyle || {}), color: e.target.value}}))}
                      className="cte-color-input" />
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">字重</span>
                    <select value={selectedEl.textStyle?.fontWeight ?? 700}
                      onChange={(e) => updateElement((el) => ({...el, textStyle: {...(el.textStyle || {}), fontWeight: Number(e.target.value)}}))}>
                      <option value={300}>300 细</option>
                      <option value={400}>400 常规</option>
                      <option value={600}>600 中</option>
                      <option value={700}>700 粗</option>
                      <option value={800}>800 特粗</option>
                    </select>
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">描边色</span>
                    <input type="color" value={selectedEl.textStyle?.strokeColor ?? '#000000'}
                      onChange={(e) => updateElement((el) => ({...el, textStyle: {...(el.textStyle || {}), strokeColor: e.target.value}}))}
                      className="cte-color-input" />
                    <span className="cte-prop-label">描边宽</span>
                    <input type="number" min={0} max={20} step={0.5} value={selectedEl.textStyle?.strokeWidth ?? 0}
                      onChange={(e) => updateElement((el) => ({...el, textStyle: {...(el.textStyle || {}), strokeWidth: Number(e.target.value) || undefined}}))}
                      className="cte-prop-input" />
                  </div>
                </>
              )}

              {selectedEl.type === 'video' && (
                <div className="cte-prop-row">
                  <span className="cte-prop-label">填充</span>
                  <select value={selectedEl.videoFit || 'cover'}
                    onChange={(e) => updateElement((el) => ({...el, videoFit: e.target.value as 'cover' | 'contain'}))}>
                    <option value="cover">cover 裁切填充</option>
                    <option value="contain">contain 完整显示</option>
                  </select>
                </div>
              )}

              {selectedEl.type === 'shape' && (
                <>
                  <div className="cte-section-title" style={{marginTop: 12}}>形状</div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">种类</span>
                    <select value={selectedEl.shape ?? 'rect'}
                      onChange={(e) => updateElement((el) => ({...el, shape: e.target.value as ShapeKind}))}>
                      <option value="rect">矩形</option>
                      <option value="ellipse">圆形</option>
                      <option value="line">线条（厚度=边线宽）</option>
                    </select>
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">填充</span>
                    <input type="text" value={selectedEl.fill ?? ''} placeholder="#2563EB 或 linear-gradient(...)"
                      onChange={(e) => updateElement((el) => ({...el, fill: e.target.value || undefined}))}
                      className="cte-bg-input" />
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">边线色</span>
                    <input type="color" value={selectedEl.borderColor ?? '#FFFFFF'}
                      onChange={(e) => updateElement((el) => ({...el, borderColor: e.target.value}))}
                      className="cte-color-input" />
                    <span className="cte-prop-label">边线宽</span>
                    <input type="number" min={0} max={50} value={selectedEl.borderWidth ?? 0}
                      onChange={(e) => updateElement((el) => ({...el, borderWidth: Number(e.target.value) || undefined}))}
                      className="cte-prop-input" />
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">模糊</span>
                    <input type="number" min={0} max={0.2} step={0.005} value={selectedEl.blur ?? 0}
                      onChange={(e) => updateElement((el) => ({...el, blur: Number(e.target.value) || undefined}))}
                      className="cte-prop-input" />
                    <span className="cte-prop-label" title="占画布最小边比例，0.02 ≈ 2%">（比例）</span>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="cte-params-panel">
              <div className="cte-section-title">模板参数（滑块）</div>
              <p className="cte-params-hint">
                参数让使用者在故事板「参数」页直接调节元素属性（如整体大小、偏移），不用进编辑器。
              </p>
              {(def.paramSpecs ?? []).map((s, i) => (
                <div className="cte-param-spec" key={i}>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">名称</span>
                    <input type="text" value={s.label}
                      onChange={(e) => updateParamSpec(i, {label: e.target.value})}
                      className="cte-prop-input" style={{flex: 1}} />
                    <span className="cte-prop-label">键</span>
                    <input type="text" value={s.key}
                      onChange={(e) => updateParamSpec(i, {key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '')})}
                      className="cte-prop-input" style={{width: 70}} />
                    <button className="btn-small btn-danger" onClick={() => removeParamSpec(i)}><X size={12} /></button>
                  </div>
                  <div className="cte-prop-row">
                    <span className="cte-prop-label">最小</span>
                    <input type="number" value={s.min} step={0.1}
                      onChange={(e) => updateParamSpec(i, {min: Number(e.target.value)})} className="cte-prop-input" />
                    <span className="cte-prop-label">最大</span>
                    <input type="number" value={s.max} step={0.1}
                      onChange={(e) => updateParamSpec(i, {max: Number(e.target.value)})} className="cte-prop-input" />
                    <span className="cte-prop-label">步进</span>
                    <input type="number" value={s.step} min={0.01} step={0.01}
                      onChange={(e) => updateParamSpec(i, {step: Number(e.target.value) || 0.1})} className="cte-prop-input" />
                    <span className="cte-prop-label">默认</span>
                    <input type="number" value={s.default} step={0.1}
                      onChange={(e) => updateParamSpec(i, {default: Number(e.target.value)})} className="cte-prop-input" />
                  </div>
                </div>
              ))}
              <button className="btn-small" onClick={addParamSpec}><Plus size={12} /> 添加参数</button>

              <div className="cte-section-title" style={{marginTop: 16}}>参数绑定</div>
              <p className="cte-params-hint">
                把滑块值映射到元素属性：「乘」适合大小/缩放（默认 1），「加」适合旋转/偏移（默认 0）。
              </p>
              {(def.paramBindings ?? []).map((b, i) => (
                <div className="cte-prop-row" key={i}>
                  <select value={b.paramKey} onChange={(e) => updateParamBinding(i, {paramKey: e.target.value})}>
                    {(def.paramSpecs ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                  <span className="cte-prop-label">→</span>
                  <select value={b.elementId} onChange={(e) => updateParamBinding(i, {elementId: e.target.value})}>
                    {def.elements.map((el) => <option key={el.id} value={el.id}>{el.name}</option>)}
                  </select>
                  <select value={b.prop} onChange={(e) => updateParamBinding(i, {prop: e.target.value as ParamBinding['prop']})}>
                    <option value="scale">缩放</option>
                    <option value="width">宽</option>
                    <option value="height">高</option>
                    <option value="x">X</option>
                    <option value="y">Y</option>
                    <option value="rotation">旋转</option>
                    <option value="opacity">透明度</option>
                  </select>
                  <select value={b.mode} onChange={(e) => updateParamBinding(i, {mode: e.target.value as ParamBinding['mode']})}>
                    <option value="multiply">乘</option>
                    <option value="add">加</option>
                  </select>
                  <button className="btn-small btn-danger" onClick={() => removeParamBinding(i)}><X size={12} /></button>
                </div>
              ))}
              <button
                className="btn-small"
                onClick={addParamBinding}
                disabled={!def.paramSpecs || def.paramSpecs.length === 0 || def.elements.length === 0}
                title={!def.paramSpecs || def.paramSpecs.length === 0 ? '先添加参数' : undefined}
              >
                <Plus size={12} /> 添加绑定
              </button>

              <div className="cte-section-title" style={{marginTop: 16}}>文字槽位</div>
              <p className="cte-params-hint">
                勾选模板实际展示的文字字段：AI 写文案按此对位，给了未勾选的字段会收到「不会显示」提醒。
                全部不勾 = 声明纯画面模板。「自动检测」按文本框角色（固定文本除外）一键填好。
              </p>
              <div className="cte-slot-row">
                {TEXT_SLOT_OPTIONS.map((o) => (
                  <label key={o.value} className="cte-slot-check">
                    <input
                      type="checkbox"
                      checked={def.textSlots?.includes(o.value) ?? false}
                      onChange={(e) => {
                        const cur = new Set(def.textSlots ?? []);
                        if (e.target.checked) cur.add(o.value); else cur.delete(o.value);
                        const next = TEXT_SLOT_VALUES.filter((s) => cur.has(s));
                        updateDef((d) => ({...d, textSlots: next}));
                      }}
                    />
                    {o.label}
                  </label>
                ))}
                <button
                  className="btn-small"
                  onClick={() => updateDef((d) => ({...d, textSlots: detectTextSlots(d)}))}
                  title="按文本框元素的角色（未设固定文本的）自动勾选"
                >
                  自动检测
                </button>
              </div>

              <div className="cte-section-title" style={{marginTop: 16}}>元素属性</div>
              <p className="cte-params-hint">选中左侧元素后，在此编辑位置/尺寸/关键帧/样式。</p>
            </div>
          )}
        </div>
      </div>

      {/* 底部：AE 风格时间轴 */}
      <div className="cte-timeline-area">
        <Timeline
          element={selectedEl}
          frame={frame}
          totalFrames={totalFrames}
          setFrame={setFrame}
          setPlaying={setPlaying}
          updateElement={updateElement}
          selectedKf={selectedKf}
          setSelectedKf={setSelectedKf}
        />
      </div>
    </div>
  );
};

export default CustomTemplateEditor;
