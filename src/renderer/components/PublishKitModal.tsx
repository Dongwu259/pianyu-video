/**
 * PublishKitModal — 封面与发布信息（发布准备弹窗）
 *
 * 两个页签：
 * - 封面设计：选全片任意一帧 + 自由文字图层（字体/字号/颜色/描边/3D 挤出/旋转/底色条，
 *   直接在预览上拖动定位、滚轮缩放；behind 图层经主体遮挡检测渲染到画面主体后面）
 *   → Remotion Player 实时预览（与导出同一个 CoverComp 合成，所见即所得）
 *   → 一键导出 JPG/PNG 到输出目录
 * - 发布信息：标题/简介/标签随工程保存，按平台（抖音/B站/小红书/视频号/YouTube）
 *   组装可粘贴文案一键复制，并做各平台字数校验提示
 */

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {Check, Copy, FolderOpen, Image as ImageIcon, Loader2, Megaphone, Plus, ScanSearch, Trash2, X} from 'lucide-react';
import {CoverComp} from '../../remotion/main/CoverComp';
import {useProjectStore} from '../store/projectStore';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {getOutroFadeFrames} from '../../shared/transition-style';
import {isRawOutputTemplate} from '../../shared/template-registry';
import {FPS} from '../../remotion/config/resolutions';
import {toLocalVideoUrl} from './RemotionPreviewPlayer';
import {getSfxSources} from '../sfx/sfxSources';
import {
  COVER_PRESET_OPTIONS, COVER_FONTS, SCRIM_STYLE_OPTIONS,
  sanitizeCoverConfig, sanitizeCoverLayer, effectiveCoverTexts, withEffectiveTexts, applyCoverPreset, darkenHex,
} from '../../shared/cover-presets';
import {computeSubjectMaskFromImage} from '../utils/subjectMask';
import {PLATFORM_SPECS, PUBLISH_PLATFORMS, buildPlatformCopy, checkPlatformLimits, sanitizeTags, type PublishPlatform} from '../../shared/publish';
import type {MultiSegmentProps, SfxSources, CoverConfig, CoverTextLayer} from '../../shared/types';
import './PublishKitModal.css';

const OUTRO_FADE = getOutroFadeFrames(FPS);

interface PublishKitModalProps {
  onClose: () => void;
}

/** 图层文字块的近似尺寸（拖拽命中与选中框；CJK 按 1em、Latin 按 0.56em 估宽） */
const approxLayerBox = (layer: CoverTextLayer, previewW: number) => {
  const size = layer.size * (previewW / 1920);
  let units = 0;
  for (const ch of layer.text || ' ') units += /[\u3400-\u9fff\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch) ? 1 : 0.56;
  const w = Math.max(size * 0.8, units * size * 1.02 + (layer.chipColor ? size * 1.04 : 0));
  const h = size * 1.3 + (layer.chipColor ? size * 0.44 : 0);
  return {w, h, size};
};

export const PublishKitModal: React.FC<PublishKitModalProps> = ({onClose}) => {
  const {
    segments, orientation, aspectRatioId, bgm, logo, captionStyle, finePrint, colorGrade,
    sfx, texture, beatPulse, cursor, customTemplates, marketTemplates, generatedTemplates,
    publish, setPublishMetadata, setCoverConfig, syncCurrentToSegment,
    licenseStatus, appSettings, renderSettings, projectName, getTotalDuration,
  } = useProjectStore();

  const [tab, setTab] = useState<'cover' | 'metadata'>('cover');
  const preset = getAspectRatioPreset(aspectRatioId);
  const total = getTotalDuration();
  const cover = publish.cover;
  const metadata = publish.metadata;

  // ====== 封面 Player 预览（与 FullVideoPreview 同口径组装，CoverComp 暂停在选帧时刻） ======
  const playerRef = useRef<PlayerRef>(null);
  const [sfxSources, setSfxSources] = useState<SfxSources | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSfxSources().then((src) => {
      if (cancelled) return;
      setSfxSources(Object.fromEntries(
        Object.entries(src).map(([k, arr]) => [k, arr.map(toLocalVideoUrl)]),
      ) as SfxSources);
    });
    return () => { cancelled = true; };
  }, []);

  // 打开弹窗先把工作副本刷入故事板，预览/导出反映最新编辑
  useEffect(() => { syncCurrentToSegment(); }, [syncCurrentToSegment]);

  // ====== 图层选择 / 拖拽 / 滚轮缩放 ======
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = cover.layers.find((l) => l.id === selectedId) ?? null;
  const interactRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{id: string; offsetX: number; offsetY: number} | null>(null);

  const updateLayer = (id: string, patch: Partial<CoverTextLayer>) => {
    setCoverConfig({layers: cover.layers.map((l) => (l.id === id ? sanitizeCoverLayer({...l, ...patch}, 0) : l))});
  };
  const addLayer = () => {
    const id = `text-${Date.now() % 100000}`;
    setCoverConfig({layers: [...cover.layers, sanitizeCoverLayer({
      id, text: '新文字', font: 'heavy', x: 0.5, y: 0.4, align: 'center', size: 120,
      color: '#FFFFFF', strokeColor: '', strokeWidth: 0, rotation: 0,
      depth: 0, angle: 45, sideColor: '#1E293B', behind: false, chipColor: '',
    }, 0)].slice(0, 6)});
    setSelectedId(id);
  };
  const removeLayer = (id: string) => {
    setCoverConfig({layers: cover.layers.filter((l) => l.id !== id)});
    if (selectedId === id) setSelectedId(null);
  };

  const onInteractPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = interactRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    // 命中判定：先看已选中层的框，再按锚点距离取最近层
    let hit: string | null = null;
    if (selected) {
      const box = approxLayerBox(selected, rect.width);
      const cx = selected.align === 'left' ? selected.x + box.w / 2 / rect.width
        : selected.align === 'right' ? selected.x - box.w / 2 / rect.width : selected.x;
      if (Math.abs(px - cx) < (box.w / 2 + 14) / rect.width && Math.abs(py - selected.y) < (box.h / 2 + 14) / rect.height) {
        hit = selected.id;
      }
    }
    if (!hit) {
      let best = Infinity;
      for (const l of cover.layers) {
        const d = (px - l.x) ** 2 + (py - l.y) ** 2;
        if (d < best) { best = d; hit = l.id; }
      }
      if (best > 0.04) hit = cover.layers.length > 0 ? hit : null; // 离所有锚点太远仍允许选中最近层（框比锚点大）
    }
    if (!hit) return;
    setSelectedId(hit);
    const layer = cover.layers.find((l) => l.id === hit)!;
    dragRef.current = {id: hit, offsetX: px - layer.x, offsetY: py - layer.y};
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onInteractPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = interactRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    updateLayer(drag.id, {x: px - drag.offsetX, y: py - drag.offsetY});
  };
  const onInteractPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    interactRef.current?.releasePointerCapture(e.pointerId);
  };
  const onInteractWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!selected) return;
    e.preventDefault();
    updateLayer(selected.id, {size: selected.size * (1 - e.deltaY * 0.0012)});
  };

  // ====== 主体遮挡检测 ======
  const [maskState, setMaskState] = useState<{dataUrl: string; coverage: number; timeSec: number} | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [maskError, setMaskError] = useState('');
  const hasBehind = cover.layers.some((l) => l.behind);

  const detectSubject = async (timeOverride?: number): Promise<string> => {
    setDetecting(true);
    setMaskError('');
    try {
      syncCurrentToSegment();
      const s = useProjectStore.getState();
      const t = timeOverride ?? Math.min(cover.timeSec, Math.max(0, total - 1 / 30));
      const src = await getSfxSources();
      const frame = await window.api.renderStoryboardStill({
        inputProps: {segments: s.segments, orientation: s.orientation, customTemplates: [...s.customTemplates, ...s.marketTemplates.map((tp) => tp.def)], generatedTemplates: s.generatedTemplates, bgm: s.bgm, sfx: s.sfx, sfxSources: src, texture: s.texture, beatPulse: s.beatPulse, cursor: s.cursor, logo: s.logo, captionStyle: s.captionStyle, finePrint: s.finePrint, colorGrade: s.colorGrade, brandColor: s.brandColor, fontMood: s.fontMood} as MultiSegmentProps,
        aspectRatioId,
        timeSec: t,
      });
      const mask = await computeSubjectMaskFromImage(frame.dataUrl);
      setMaskState({dataUrl: mask.maskDataUrl, coverage: mask.coverage, timeSec: t});
      return mask.maskDataUrl;
    } catch (err) {
      setMaskError(String(err).replace(/^Error:\s*/, ''));
      return '';
    } finally {
      setDetecting(false);
    }
  };
  const maskStale = !maskState || Math.abs(maskState.timeSec - cover.timeSec) > 0.05;
  const effectiveMask = maskStale ? undefined : maskState?.dataUrl;

  // behind 图层存在但 mask 过期 → 自动重检测（切时刻后保持遮挡正确）
  useEffect(() => {
    if (tab !== 'cover' || !hasBehind || maskStale || detecting) return;
    const timer = setTimeout(() => { void detectSubject(); }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cover.timeSec, hasBehind, tab]);

  // ====== 预览 props ======
  const effTexts = useMemo(
    () => effectiveCoverTexts(cover, metadata, segments[0]?.text),
    [cover, metadata, segments],
  );
  const previewCover: CoverConfig = useMemo(
    () => withEffectiveTexts(cover, effTexts),
    [cover, effTexts],
  );
  // 末段为「原样输出」模板（屏幕录制）时豁免收尾淡黑（与渲染/预览口径一致）
  const lastRaw = isRawOutputTemplate(segments[segments.length - 1]?.templateId);
  const durationInFrames = Math.max(1, Math.round(total * FPS) + (lastRaw ? 0 : OUTRO_FADE));
  const previewInputProps = useMemo(() => ({
    project: {
      segments, orientation,
      customTemplates: [...customTemplates, ...marketTemplates.map((t) => t.def)],
      generatedTemplates,
      bgm: bgm ? {...bgm, src: toLocalVideoUrl(bgm.src)} : null,
      logo: logo ? {...logo, src: toLocalVideoUrl(logo.src)} : logo,
      captionStyle, finePrint, colorGrade,
      sfx,
      ...(sfxSources ? {sfxSources} : {}),
      texture, beatPulse, cursor,
      licensed: licenseStatus ? licenseStatus.entitlement === 'licensed' : true,
    } as MultiSegmentProps,
    cover: previewCover,
    ...(effectiveMask ? {subjectMask: effectiveMask} : {}),
  }), [segments, orientation, customTemplates, marketTemplates, generatedTemplates, bgm, logo, captionStyle,
      finePrint, colorGrade, sfx, sfxSources, texture, beatPulse, cursor, licenseStatus, previewCover, effectiveMask]);

  // 选帧时刻变化 → Player 跳帧
  const frame = Math.max(0, Math.min(durationInFrames - 1, Math.round(cover.timeSec * FPS)));
  useEffect(() => {
    playerRef.current?.seekTo(frame);
  }, [frame, tab]);

  // ====== 封面导出 ======
  const [outputDir, setOutputDir] = useState(appSettings.defaultOutputDir || '');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportResult, setExportResult] = useState<{path: string; dataUrl: string} | null>(null);

  const handleExportCover = async () => {
    setExporting(true);
    setExportError('');
    setExportResult(null);
    try {
      syncCurrentToSegment();
      const s = useProjectStore.getState();
      let dir = outputDir || s.appSettings.defaultOutputDir;
      if (!dir) {
        dir = await window.api.selectOutputDir();
        if (dir) setOutputDir(dir);
      }
      if (!dir) {
        setExportError('未选择输出目录，封面未导出');
        return;
      }
      const src = await getSfxSources();
      const inputProps = {
        segments: s.segments, orientation: s.orientation,
        customTemplates: [...s.customTemplates, ...s.marketTemplates.map((t) => t.def)],
        generatedTemplates: s.generatedTemplates,
        bgm: s.bgm, logo: s.logo, captionStyle: s.captionStyle, finePrint: s.finePrint,
        colorGrade: s.colorGrade, sfx: s.sfx, sfxSources: src, texture: s.texture,
        beatPulse: s.beatPulse, cursor: s.cursor,
        brandColor: s.brandColor, fontMood: s.fontMood,
      } as MultiSegmentProps;
      const texts = effectiveCoverTexts(s.publish.cover, s.publish.metadata, s.segments[0]?.text);
      const exportCover = sanitizeCoverConfig(withEffectiveTexts(s.publish.cover, texts), s.orientation);
      const t = Math.min(exportCover.timeSec, Math.max(0, s.getTotalDuration() - 1 / FPS));
      // behind 图层：mask 过期则现算（导出结果以最新帧为准）
      let maskDataUrl = effectiveMask ?? '';
      if (exportCover.layers.some((l) => l.behind) && (!maskDataUrl || maskStale)) {
        maskDataUrl = await detectSubject(t);
      }
      const res = await window.api.renderCoverStill({
        inputProps, aspectRatioId: s.aspectRatioId,
        timeSec: t,
        cover: exportCover, outputDir: dir,
        baseName: s.renderSettings.filename.trim() || s.projectName,
        ...(maskDataUrl ? {maskDataUrl} : {}),
      });
      setExportResult({path: res.outputPath, dataUrl: res.dataUrl});
    } catch (err) {
      setExportError(String(err).replace(/^Error:\s*/, ''));
    } finally {
      setExporting(false);
    }
  };

  // ====== 发布信息 ======
  const [tagDraft, setTagDraft] = useState(metadata.tags.join(' '));
  useEffect(() => {
    if (sanitizeTags(tagDraft).join(' ') !== metadata.tags.join(' ')) {
      setTagDraft(metadata.tags.join(' '));
    }
  }, [metadata.tags]); // eslint-disable-line react-hooks/exhaustive-deps

  const [copiedPlatform, setCopiedPlatform] = useState<PublishPlatform | null>(null);
  const warnings = useMemo(() => checkPlatformLimits(metadata), [metadata]);
  const warningsOf = (p: PublishPlatform) => warnings.filter((w) => w.platform === p);

  const copyPlatform = async (p: PublishPlatform) => {
    const text = buildPlatformCopy(p, metadata);
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPlatform(p);
      setTimeout(() => setCopiedPlatform(null), 1500);
    } catch {
      // 剪贴板不可用时静默（Electron 环境基本可用）
    }
  };

  const titleCount = metadata.title.trim().length;
  const layerFont = (l: CoverTextLayer) => COVER_FONTS.find((f) => f.value === l.font)?.label ?? l.font;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content publishkit-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>
        <div className="pk-header">
          <h2>封面与发布信息</h2>
          <p>成片之外的发布物料：选一帧自由设计封面，准备好各平台的标题与标签</p>
        </div>

        <div className="pk-tabs">
          <button className={`pk-tab ${tab === 'cover' ? 'active' : ''}`} onClick={() => setTab('cover')}>
            <ImageIcon size={14} /> 封面设计
          </button>
          <button className={`pk-tab ${tab === 'metadata' ? 'active' : ''}`} onClick={() => setTab('metadata')}>
            <Megaphone size={14} /> 发布信息
          </button>
        </div>

        {tab === 'cover' && (
          <div className="pk-body pk-cover">
            <div className="pk-preview-col">
              <div className="pk-preview-wrap">
                <div
                  className="pk-preview"
                  style={{aspectRatio: `${preset.width} / ${preset.height}`}}
                >
                  <Player
                    ref={playerRef}
                    component={CoverComp as React.ComponentType<any>}
                    inputProps={previewInputProps}
                    durationInFrames={durationInFrames}
                    fps={FPS}
                    compositionWidth={preset.width}
                    compositionHeight={preset.height}
                    style={{width: '100%', height: '100%'}}
                    controls={false}
                    clickToPlay={false}
                    doubleClickToFullscreen={false}
                    spaceKeyToPlayOrPause={false}
                    autoPlay={false}
                    loop={false}
                  />
                  {/* 拖拽/缩放交互层：虚线选中框 + 指针拖动 + 滚轮缩放 */}
                  <div
                    ref={interactRef}
                    className="pk-interact"
                    onPointerDown={onInteractPointerDown}
                    onPointerMove={onInteractPointerMove}
                    onPointerUp={onInteractPointerUp}
                    onWheel={onInteractWheel}
                  >
                    {cover.layers.map((l) => {
                      const box = approxLayerBox(l, 1000);
                      const wPct = (box.w / 1000) * 100;
                      const hPct = (box.h / (1000 * preset.height / preset.width)) * 100;
                      const cx = l.align === 'left' ? l.x * 100 + wPct / 2
                        : l.align === 'right' ? l.x * 100 - wPct / 2 : l.x * 100;
                      return (
                        <div
                          key={l.id}
                          className={`pk-layer-box ${selectedId === l.id ? 'selected' : ''}`}
                          style={{left: `${cx}%`, top: `${l.y * 100}%`, width: `${wPct}%`, height: `${hPct}%`, transform: `translate(-50%, -50%) rotate(${l.rotation}deg)`}}
                        />
                      );
                    })}
                  </div>
                </div>
                {selected && (
                  <p className="pk-interact-hint">拖动移动 · 滚轮缩放（{layerFont(selected)} {Math.round(selected.size)}px）</p>
                )}
              </div>

              <div className="pk-time-row">
                <span className="pk-time-label">选帧 {cover.timeSec.toFixed(1)}s / {total.toFixed(1)}s</span>
                <div className="pk-quick-picks">
                  {([['开场', 0], ['1/4', 0.25], ['中点', 0.5], ['3/4', 0.75]] as const).map(([label, ratio]) => (
                    <button key={label} onClick={() => setCoverConfig({timeSec: Math.round(total * ratio * 10) / 10})}>{label}</button>
                  ))}
                </div>
              </div>
              <input
                type="range" min={0} max={Math.max(0.1, total - 0.1)} step={0.1}
                value={Math.min(cover.timeSec, Math.max(0.1, total - 0.1))}
                onChange={(e) => setCoverConfig({timeSec: Number(e.target.value)})}
              />

              <div className="pk-field pk-field-inline pk-scrim-row">
                <label>压暗</label>
                <select
                  className="pk-mini-select"
                  value={cover.scrimStyle}
                  onChange={(e) => setCoverConfig({scrimStyle: e.target.value as CoverConfig['scrimStyle']})}
                >
                  {SCRIM_STYLE_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <input
                  type="range" min={0} max={0.9} step={0.05}
                  value={cover.scrim}
                  disabled={cover.scrimStyle === 'none'}
                  onChange={(e) => setCoverConfig({scrim: Number(e.target.value)})}
                />
              </div>
            </div>

            <div className="pk-controls-col">
              <div className="pk-field">
                <label>版式（重排文字位置，保留文案）</label>
                <div className="pk-preset-row">
                  {COVER_PRESET_OPTIONS.map((p) => (
                    <button
                      key={p.value}
                      className="pk-preset-btn"
                      title={p.desc}
                      onClick={() => setCoverConfig(applyCoverPreset(cover, p.value, orientation))}
                    >{p.label}</button>
                  ))}
                </div>
              </div>

              <div className="pk-field">
                <label>
                  文字图层
                  <button className="pk-add-layer" onClick={addLayer} disabled={cover.layers.length >= 6}>
                    <Plus size={12} /> 加一层
                  </button>
                </label>
                <div className="pk-layer-chips">
                  {cover.layers.map((l) => (
                    <span key={l.id} className={`pk-layer-chip ${selectedId === l.id ? 'active' : ''}`}>
                      <button onClick={() => setSelectedId(l.id)}>
                        {l.role === 'title' ? '标题' : l.role === 'subtitle' ? '副标题' : l.role === 'tag' ? '标签' : '自由'}·{(l.text || '空').slice(0, 8)}
                        {l.behind && <em className="pk-behind-mark" title="渲染在主体后面">⟲</em>}
                      </button>
                      {!l.role && (
                        <button className="pk-layer-del" onClick={() => removeLayer(l.id)} title="删除图层"><Trash2 size={11} /></button>
                      )}
                    </span>
                  ))}
                  {cover.layers.length === 0 && <span className="pk-layer-empty">无图层（点「加一层」或选版式）</span>}
                </div>
              </div>

              {selected ? (
                <div className="pk-layer-panel">
                  <div className="pk-field">
                    <label>文字（缺省显示发布标题/首段标题）</label>
                    <input
                      type="text" value={selected.text}
                      placeholder={selected.role === 'title' ? effTexts.title || '封面主标题'
                        : selected.role === 'subtitle' ? effTexts.subtitle || '封面副标题' : ''}
                      onChange={(e) => updateLayer(selected.id, {text: e.target.value})}
                    />
                  </div>
                  <div className="pk-field pk-grid-2">
                    <div>
                      <label>字体</label>
                      <select value={selected.font} onChange={(e) => updateLayer(selected.id, {font: e.target.value as CoverTextLayer['font']})}>
                        {COVER_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label>对齐锚点</label>
                      <select value={selected.align} onChange={(e) => updateLayer(selected.id, {align: e.target.value as CoverTextLayer['align']})}>
                        <option value="left">左对齐</option>
                        <option value="center">居中</option>
                        <option value="right">右对齐</option>
                      </select>
                    </div>
                  </div>
                  <div className="pk-field pk-field-inline">
                    <label>字号</label>
                    <input type="range" min={40} max={400} step={2} value={selected.size}
                      onChange={(e) => updateLayer(selected.id, {size: Number(e.target.value)})} />
                    <span className="pk-scrim-value">{Math.round(selected.size)}</span>
                  </div>
                  <div className="pk-field pk-grid-2">
                    <div>
                      <label>文字颜色</label>
                      <div className="pk-color-row">
                        <input type="color" value={selected.color} onChange={(e) => updateLayer(selected.id, {color: e.target.value})} />
                        <span className="pk-hex">{selected.color}</span>
                      </div>
                    </div>
                    <div>
                      <label>文字边缘（描边）</label>
                      <div className="pk-color-row">
                        <input type="color" value={selected.strokeColor || '#000000'}
                          onChange={(e) => updateLayer(selected.id, {strokeColor: e.target.value, strokeWidth: selected.strokeWidth || 6})} />
                        {selected.strokeWidth > 0 && (
                          <button className="pk-stroke-off" onClick={() => updateLayer(selected.id, {strokeWidth: 0, strokeColor: ''})}>关</button>
                        )}
                      </div>
                    </div>
                  </div>
                  {selected.strokeWidth > 0 && (
                    <div className="pk-field pk-field-inline">
                      <label>描边粗细</label>
                      <input type="range" min={1} max={24} step={1} value={selected.strokeWidth}
                        onChange={(e) => updateLayer(selected.id, {strokeWidth: Number(e.target.value)})} />
                      <span className="pk-scrim-value">{selected.strokeWidth}</span>
                    </div>
                  )}
                  <div className="pk-field pk-field-inline">
                    <label>旋转</label>
                    <input type="range" min={-45} max={45} step={1} value={selected.rotation}
                      onChange={(e) => updateLayer(selected.id, {rotation: Number(e.target.value)})} />
                    <span className="pk-scrim-value">{selected.rotation}°</span>
                  </div>
                  <div className="pk-field">
                    <label>3D 立体文字</label>
                    <div className="pk-field pk-field-inline" style={{marginBottom: 6}}>
                      <span className="pk-mini-label">深度</span>
                      <input type="range" min={0} max={48} step={1} value={selected.depth}
                        onChange={(e) => updateLayer(selected.id, {depth: Number(e.target.value)})} />
                      <span className="pk-scrim-value">{selected.depth}</span>
                    </div>
                    {selected.depth > 0 && (
                      <>
                        <div className="pk-field pk-field-inline" style={{marginBottom: 6}}>
                          <span className="pk-mini-label">方向</span>
                          <input type="range" min={0} max={360} step={5} value={selected.angle}
                            onChange={(e) => updateLayer(selected.id, {angle: Number(e.target.value)})} />
                          <span className="pk-scrim-value">{selected.angle}°</span>
                        </div>
                        <div className="pk-color-row">
                          <span className="pk-mini-label">侧面色</span>
                          <input type="color" value={selected.sideColor}
                            onChange={(e) => updateLayer(selected.id, {sideColor: e.target.value})} />
                          <button className="pk-stroke-off" onClick={() => updateLayer(selected.id, {sideColor: darkenHex(selected.color, 0.45)})}>按文字色加深</button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="pk-field">
                    <label>主体遮挡</label>
                    <label className="pk-check-row" title="开启后该图层渲染到画面主体后面（需主体检测）">
                      <input
                        type="checkbox" checked={selected.behind}
                        onChange={(e) => updateLayer(selected.id, {behind: e.target.checked})}
                      />
                      放到画面主体后面（前后遮挡，突出主体）
                    </label>
                    <div className="pk-mask-row">
                      <button className="pk-detect-btn" disabled={detecting} onClick={() => void detectSubject()}>
                        {detecting ? <><Loader2 size={12} className="pk-spin" /> 检测中…</> : <><ScanSearch size={12} /> 检测画面主体</>}
                      </button>
                      {maskState && !maskStale && (
                        <span className={`pk-mask-status ${maskState.coverage < 0.005 || maskState.coverage > 0.75 ? 'warn' : ''}`}>
                          覆盖 {(maskState.coverage * 100).toFixed(0)}%
                        </span>
                      )}
                      {maskState && maskStale && <span className="pk-mask-status warn">已换帧，导出时自动重检</span>}
                      {maskError && <span className="pk-mask-status warn" title={maskError}>检测失败</span>}
                    </div>
                  </div>
                  <div className="pk-field">
                    <label>底色条</label>
                    <div className="pk-color-row">
                      <input
                        type="color" value={selected.chipColor || '#2563EB'}
                        onChange={(e) => updateLayer(selected.id, {chipColor: e.target.value})}
                      />
                      {selected.chipColor && (
                        <button className="pk-stroke-off" onClick={() => updateLayer(selected.id, {chipColor: ''})}>去掉</button>
                      )}
                      {!selected.chipColor && (
                        <button className="pk-stroke-off" onClick={() => updateLayer(selected.id, {chipColor: '#2563EB'})}>加上</button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="pk-layer-empty">点击预览中的文字或上方图层选择后编辑属性</p>
              )}

              <button className="pk-export-btn" disabled={exporting || segments.length === 0} onClick={handleExportCover}>
                {exporting ? <><Loader2 size={14} className="pk-spin" /> 生成中…（约数秒）</> : <>导出封面（{preset.width}×{preset.height}）</>}
              </button>
              {exportError && <p className="pk-error">{exportError}</p>}
              {exportResult && (
                <div className="pk-export-result">
                  <img src={exportResult.dataUrl} alt="封面预览" />
                  <div className="pk-export-info">
                    <p className="pk-export-path" title={exportResult.path}>{exportResult.path}</p>
                    <div className="pk-export-actions">
                      <button onClick={() => window.api.openInExplorer(exportResult.path)}>
                        <FolderOpen size={13} /> 在文件夹中显示
                      </button>
                      <button onClick={() => navigator.clipboard.writeText(exportResult.path).catch(() => {})}>
                        <Copy size={13} /> 复制路径
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'metadata' && (
          <div className="pk-body pk-metadata">
            <div className="pk-meta-edit">
              <div className="pk-field">
                <label>标题 <span className={`pk-count ${titleCount > 100 ? 'over' : ''}`}>{titleCount}/100</span></label>
                <input
                  type="text" value={metadata.title}
                  placeholder={segments[0]?.text?.title ? `如：${segments[0].text.title}` : '视频标题（各平台通用，AI 助手也可自动填写）'}
                  onChange={(e) => setPublishMetadata({title: e.target.value})}
                />
              </div>
              <div className="pk-field">
                <label>简介 / 文案</label>
                <textarea
                  rows={4} value={metadata.description}
                  placeholder="视频介绍、卖点、行动号召（发布时按平台自动组装）"
                  onChange={(e) => setPublishMetadata({description: e.target.value})}
                />
              </div>
              <div className="pk-field">
                <label>话题标签（空格或逗号分隔，不带 #）</label>
                <input
                  type="text" value={tagDraft}
                  placeholder="如：产品宣传 AI 视频 教程"
                  onChange={(e) => {
                    setTagDraft(e.target.value);
                    setPublishMetadata({tags: sanitizeTags(e.target.value)});
                  }}
                />
                {metadata.tags.length > 0 && (
                  <div className="pk-tag-chips">
                    {metadata.tags.map((t) => <span key={t} className="pk-tag-chip">#{t}</span>)}
                  </div>
                )}
              </div>
              <p className="pk-meta-hint">
                元数据随工程文件保存。AI 助手可通过 set_publish_metadata 工具自动填写；发布时在下方按平台一键复制。
              </p>
            </div>

            <div className="pk-platforms">
              {PUBLISH_PLATFORMS.map((p) => {
                const spec = PLATFORM_SPECS[p];
                const ws = warningsOf(p);
                const empty = !metadata.title.trim() && !metadata.description.trim() && metadata.tags.length === 0;
                return (
                  <div key={p} className="pk-platform">
                    <div className="pk-platform-head">
                      <strong>{spec.label}</strong>
                      <span className="pk-platform-note">
                        {spec.titleLimit !== null ? `标题 ≤${spec.titleLimit} 字` : '标题无校验'}
                        {spec.tagCountLimit !== null ? ` · 标签 ≤${spec.tagCountLimit}` : ''}
                      </span>
                    </div>
                    <p className="pk-platform-desc">{spec.note}</p>
                    {ws.map((w, i) => <p key={i} className="pk-warn">⚠ {w.message}</p>)}
                    <button className="pk-copy-btn" disabled={empty} onClick={() => copyPlatform(p)}>
                      {copiedPlatform === p ? <><Check size={13} /> 已复制</> : <><Copy size={13} /> 复制文案</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PublishKitModal;
