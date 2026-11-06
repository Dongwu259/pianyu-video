/**
 * GroundModal - 3D 地面追踪弹窗（故事板素材卡「3D」入口）
 *
 * 全自动优先（产品定位：不用 AE 的用户）：
 * - 「一键地面追踪」：自动在下半画面选锚点 → 块匹配跟踪 → RANSAC 共面筛选，
 *   结果回显锚点位置与质量（保留数/残差/丢失率，黄灯提示换素材段落）；
 * - 元素管理：跟踪完成后可加 3D 文字（躺平/立起/立体）与形状（立牌/立方体/
 *   圆柱/锥体），画面上实时 3D 预览（与渲染同构），元素手柄钉在实际投影位置、
 *   拖拽经 H⁻¹ 反解回地面坐标（指哪挪哪）；右侧调大小/朝向（缺省自动面向
 *   镜头）/颜色/入场；写入段级 groundElements。
 */

import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {X, Loader2, Wand2, AlertTriangle, Trash2, Box} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import type {GroundElement, VideoClip} from '../../shared/types';
import {clipSrcToPath} from '../utils/clipPath';
import {applyH, groundMatrix3dAt, homographyFromP, invertH, projectPoint} from '../../shared/groundTrack';
import {GroundSceneStatic} from '../../remotion/layers/GroundScene';
import './StabilizeModal.css';

interface GroundModalProps {
  clipIndex: number;
  /** 打开弹窗时的活动段下标（VideoUploader 捕获）：异步分析完成后的写回锚定该段，
      防止「分析中关弹窗切片段 → 结果写进别的片段」；元素读写也锁定该段 */
  segmentIndex: number;
  clip: VideoClip;
  onClose: () => void;
}

/** 与 VideoTrimmer/StabilizeModal 相同：把 http/file 源统一转为 local-video:// 协议 URL */
const toLocalVideoUrl = (src: string): string => {
  const rawPath = src.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
  return `local-video://${rawPath}`;
};

const stripIpcPrefix = (err: unknown): string =>
  String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const FORM_LABELS: Record<string, string> = {
  flat: '躺平文字', billboard: '立起文字', extruded: '立体文字',
  plate: '立牌', box: '立方体', cylinder: '圆柱', cone: '锥体',
};

/**
 * 新元素默认摆位：位置偏画面下半上方（离相机远一点——近处站立元素透视上
 * 会被放大出画）、大小取保守值（默认可见但不出画）；朝向缺省不设 yawDeg
 * = 自动面向镜头（俯拍/绕行机位固定 0° 会背对镜头）。
 */
const FORM_DEFAULTS: Record<GroundElement['form'], {v: number; size: number}> = {
  flat: {v: 0.6, size: 0.13},
  billboard: {v: 0.55, size: 0.11},
  extruded: {v: 0.58, size: 0.13},
  plate: {v: 0.55, size: 0.1},
  box: {v: 0.55, size: 0.1},
  cylinder: {v: 0.55, size: 0.1},
  cone: {v: 0.55, size: 0.1},
};

let elementSeq = 0;
const newElementId = (): string => `ge-${Date.now().toString(36)}-${elementSeq++}`;

export const GroundModal: React.FC<GroundModalProps> = ({clipIndex, segmentIndex, clip, onClose}) => {
  const setGroundTrack = useProjectStore((s) => s.setGroundTrack);
  const setSegmentGroundElements = useProjectStore((s) => s.setSegmentGroundElements);
  const segments = useProjectStore((s) => s.segments);
  // 段锁定在打开弹窗时的 segmentIndex（不订阅 live activeSegmentIndex——否则分析/撤销
  // 等异步变化会让元素读写漂到别的片段）
  const segment = segments[segmentIndex];

  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [box, setBox] = useState<{w: number; h: number} | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragElRef = useRef<string | null>(null);

  // 画面盒尺寸（视频画幅等比，3D 静态预览的缩放基准）
  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : {w, h}));
  });

  // 已追踪态：锚点轨迹在 clip.groundData（内存态）；质量在 groundTrack
  const groundData = clip.groundData;
  const groundTrack = clip.groundTrack;
  const elements = segment?.groundElements ?? [];
  const selected = elements.find((e) => e.id === selectedId) ?? null;

  // 静态 3D 预览：停在参考帧附近的画面上按投影矩阵渲染元素（与渲染路径同一套
  // 纯函数 + 同一套元素组件；预览时刻 = 视频暂停时刻）
  const pausedSec = Math.min((clip.trimStart ?? 0) + 0.1, Math.max(0, (clip.duration || 1) - 0.05));
  const previewSolved = groundData && elements.length > 0
    ? groundMatrix3dAt(groundData, clip.width, clip.height, pausedSec)
    : null;

  // 视频就绪后停在 trimStart+0.1 当背景（= 地面追踪参考帧附近）
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = () => {
      v.currentTime = Math.min((clip.trimStart ?? 0) + 0.1, Math.max(0, (v.duration || 1) - 0.05));
      v.pause();
    };
    v.addEventListener('loadeddata', onLoaded);
    return () => v.removeEventListener('loadeddata', onLoaded);
  }, [clip.trimStart]);

  // ====== 一键追踪 ======
  const runAnalyze = async () => {
    if (analyzing) return;
    // 预检：主进程没重启（preload 未注入新 IPC）时给出可操作的提示，而不是点了没反应
    if (typeof window.api.groundAnalyze !== 'function') {
      setError('3D 地面追踪是新功能，当前运行的应用还没加载它——请完全退出片语并重新打开（npm run dev 需重启）后再试');
      return;
    }
    setAnalyzing(true);
    setError('');
    try {
      const res = await window.api.groundAnalyze({
        videoPath: clipSrcToPath(clip.src),
        opts: {trimStart: clip.trimStart ?? 0, trimEnd: clip.trimEnd ?? clip.duration},
      });
      // 分析期间用户可能已关弹窗/切片段/删素材：写回前核对锚定素材仍在原处
      const segNow = useProjectStore.getState().segments[segmentIndex];
      if (segNow?.videos[clipIndex]?.id !== clip.id) return;
      setGroundTrack(clipIndex, {
        groundTrack: {
          trackPath: res.trackPath,
          enabled: true,
          keptAnchors: res.stats.keptAnchors,
          lostRatio: res.stats.lostRatio,
          meanResidualPx: res.stats.meanResidualPx,
        },
        groundData: {anchors: res.track.anchors, samples: res.track.samples},
      }, segmentIndex);
    } catch (err) {
      setError(stripIpcPrefix(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const handleRemoveTrack = () => {
    setGroundTrack(clipIndex, {groundTrack: undefined}, segmentIndex);
  };

  // ====== 元素管理 ======
  const commitElements = (next: GroundElement[]) => {
    setSegmentGroundElements(segmentIndex, next);
  };

  const addElement = (form: GroundElement['form']) => {
    const d = FORM_DEFAULTS[form];
    const el: GroundElement = {
      id: newElementId(),
      kind: form === 'flat' || form === 'billboard' || form === 'extruded' ? 'text' : 'shape',
      text: form === 'flat' || form === 'billboard' || form === 'extruded' ? '在此输入' : undefined,
      form,
      u: 0.5,
      v: d.v,
      size: d.size,
      entrance: 'rise',
    };
    commitElements([...elements, el]);
    setSelectedId(el.id);
  };

  const patchElement = (id: string, patch: Partial<GroundElement>) => {
    commitElements(elements.map((e) => (e.id === id ? {...e, ...patch} : e)));
  };

  const removeElement = (id: string) => {
    commitElements(elements.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  // 拖拽反解：预览投影 P 的 z=0 单应之逆（指针「文字实际显示处」→ 地面参考帧
  // 坐标）。相机已运动/俯拍时 u/v 百分比与画面位置不重合，直接用百分比拖拽会
  // 「标记动文字不动」；走 H⁻¹ 才是拖哪跟哪。
  const dragInvH = previewSolved ? invertH(homographyFromP(previewSolved.P)) : null;

  /** 元素基点在当前预览画面上的归一化位置（无投影时退回 u/v 参考帧位置） */
  const projectedBase = (el: GroundElement): {u: number; v: number} => {
    if (previewSolved) {
      const p = projectPoint(previewSolved.P, el.u * clip.width, el.v * clip.height, 0);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
          p.x >= -clip.width && p.x <= 2 * clip.width &&
          p.y >= -clip.height && p.y <= 2 * clip.height) {
        return {u: p.x / clip.width, v: p.y / clip.height};
      }
    }
    return {u: el.u, v: el.v};
  };

  const round3 = (n: number): number => Math.round(n * 1000) / 1000;
  const clamp01 = (n: number): number => Math.max(0.02, Math.min(0.98, n));

  // 元素拖拽：指针位置 → 地面 u/v（有投影先反解，无投影直接百分比）
  const eventToNorm = (e: React.PointerEvent): {u: number; v: number} => {
    const rect = overlayRef.current!.getBoundingClientRect();
    const fx = clamp01((e.clientX - rect.left) / rect.width);
    const fy = clamp01((e.clientY - rect.top) / rect.height);
    if (dragInvH) {
      const g = applyH(dragInvH, {x: fx * clip.width, y: fy * clip.height});
      if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) {
        return {u: round3(clamp01(g.x / clip.width)), v: round3(clamp01(g.y / clip.height))};
      }
    }
    return {u: round3(fx), v: round3(fy)};
  };

  const handleOverlayPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || analyzing) return;
    if ((e.target as HTMLElement).closest('[data-ground-el]')) return;
    setSelectedId(null);
  };

  const handleElementPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || analyzing) return;
    e.stopPropagation();
    e.preventDefault();
    overlayRef.current?.setPointerCapture(e.pointerId);
    dragElRef.current = id;
    setSelectedId(id);
  };

  const handleOverlayPointerMove = (e: React.PointerEvent) => {
    const id = dragElRef.current;
    if (!id) return;
    patchElement(id, eventToNorm(e));
  };

  const handleOverlayPointerUp = () => {
    dragElRef.current = null;
  };

  const warn =
    !!groundTrack &&
    ((groundTrack.lostRatio ?? 0) > 0.15 ||
      (groundTrack.meanResidualPx ?? 0) > 4 ||
      (groundTrack.keptAnchors ?? 0) < 5);

  return (
    <div className="stab-overlay" onClick={onClose}>
      <div className="stab-modal" onClick={(e) => e.stopPropagation()}>
        <div className="stab-header">
          <h3>3D 地面追踪</h3>
          <button className="btn-close" onClick={onClose}><X size={18} /></button>
        </div>

        <p className="stab-file-name">
          {clip.name} · {clip.width}×{clip.height}
          {groundTrack && <span className="stab-state-badge">已追踪{groundTrack.enabled ? '' : '（已停用）'}</span>}
        </p>

        {/* 画面区：视频背景（参考帧）+ 锚点回显 + 元素标记 + 引导提示（在视频上居中） */}
        <div
          className="stab-preview"
          style={{
            aspectRatio: `${clip.width}/${clip.height}`,
            maxWidth: `min(100%, ${Math.round((340 * clip.width) / clip.height)}px)`,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          <video
            ref={videoRef}
            src={toLocalVideoUrl(clip.src)}
            className="stab-video"
            muted
            playsInline
            preload="auto"
          />
          <div
            ref={overlayRef}
            className="stab-points-layer"
            style={{cursor: 'default'}}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerUp}
          >
            {/* 追踪锚点（只读回显，十字标记） */}
            {(groundData?.anchors ?? []).map((a, i) => (
              <div
                key={`anchor-${i}`}
                className="stab-point"
                style={{
                  left: `${(a.x / clip.width) * 100}%`, top: `${(a.y / clip.height) * 100}%`,
                  pointerEvents: 'none', width: 18, height: 18, opacity: 0.85,
                }}
                title={`地面锚点 ${i + 1}`}
              >
                <Box size={13} />
              </div>
            ))}
            {/* 实时 3D 预览（与渲染同构；画幅等比容器缩到预览盒） */}
            {previewSolved && box && box.w > 0 && (
              <div style={{position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none'}}>
                <div style={{
                  position: 'absolute', left: 0, top: 0,
                  transformOrigin: '0 0',
                  transform: `scale(${box.w / clip.width})`,
                }}>
                  <GroundSceneStatic
                    elements={elements}
                    videoW={clip.width}
                    videoH={clip.height}
                    solved={previewSolved}
                  />
                </div>
              </div>
            )}
            {/* 3D 元素手柄：钉在元素「实际显示位置」（投影基点），拖动即移动 3D 元素
                （未追踪时不显示——元素暂不渲染，防误导） */}
            {groundData && elements.map((el) => {
              const pb = projectedBase(el);
              return (
                <div
                  key={el.id}
                  data-ground-el="1"
                  className="stab-point"
                  style={{
                    left: `${pb.u * 100}%`, top: `${pb.v * 100}%`,
                    width: 'auto', height: 'auto', padding: '4px 10px', borderRadius: 999,
                    whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, gap: 4,
                    background: el.id === selectedId ? 'rgba(37,99,235,0.95)' : 'rgba(37,99,235,0.82)',
                  }}
                  onPointerDown={(e) => handleElementPointerDown(e, el.id)}
                  title={`${FORM_LABELS[el.form]}${el.text ? `「${el.text}」` : ''}（拖动移动 3D 元素）`}
                >
                  {el.kind === 'text' ? (el.text?.slice(0, 4) || '文字') : FORM_LABELS[el.form]}
                </div>
              );
            })}
            {/* 引导文案：直接点下方按钮（全自动无需点击画面），避免用户对着画面点没反应。
                定位在视频预览容器内（.stab-preview 是 relative）——放弹窗层级会因
                .stab-modal 无定位上下文而相对整个遮罩居中，盖到按钮区 */}
            {!groundData && !analyzing && (
              <div
                style={{
                  position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
                  padding: '10px 18px', borderRadius: 8, background: 'rgba(0,0,0,0.62)',
                  color: '#fff', fontSize: 13, pointerEvents: 'none', whiteSpace: 'nowrap',
                }}
              >
                全自动追踪，无需点击画面——点下方「一键地面追踪」开始
              </div>
            )}
          </div>
        </div>

        {!groundData && (
          <>
            <p className="stab-hint">
              一键在画面地面区域自动选点跟踪（共面自校验，无需手动放点）；
              适合镜头平移/推近/走动的地面画面
            </p>
            <div className="stab-actions-row">
              <button
                className="btn-primary"
                style={{display: 'inline-flex', alignItems: 'center', gap: 6}}
                onClick={() => void runAnalyze()}
                disabled={analyzing}
              >
                {analyzing ? <Loader2 size={14} className="stab-spin" /> : <Wand2 size={14} />}
                {analyzing ? '分析中…' : '一键地面追踪'}
              </button>
            </div>
            {error && (
              <div className="stab-warning"><AlertTriangle size={14} /> {error}</div>
            )}
            <p className="stab-hint small">
              {elements.length > 0
                ? `该段已有 ${elements.length} 个 3D 元素——重新完成追踪后它们才会渲染（数据已保留）`
                : '追踪完成后即可放置 3D 文字/形状（钉在地面随镜头透视），效果在整片预览查看'}
            </p>
          </>
        )}
        {groundData && (
          <>
            {/* 质量面板 */}
            <div className="stab-result">
              <div className={`stab-result-row ${warn ? 'warn' : ''}`}>
                {warn ? (
                  <span>
                    <AlertTriangle size={12} /> 地面追踪质量一般（锚点 {groundTrack!.keptAnchors ?? '?'} / 残差 {groundTrack!.meanResidualPx ?? '?'}px / 丢失率 {Math.round((groundTrack!.lostRatio ?? 0) * 1000) / 10}%）——
                    建议换纹理更丰富的画面段落重新分析
                  </span>
                ) : (
                  <span>
                    地面锚点 {groundTrack!.keptAnchors ?? groundData.anchors.length} 个 · 残差 {groundTrack!.meanResidualPx ?? '—'}px · 丢失率 {Math.round((groundTrack!.lostRatio ?? 0) * 1000) / 10}%（正常）
                  </span>
                )}
              </div>
            </div>

            {/* 元素添加 */}
            <div className="stab-actions-row" style={{flexWrap: 'wrap'}}>
              <span className="stab-control-label" style={{alignSelf: 'center'}}>添加：</span>
              {(['flat', 'billboard', 'extruded', 'plate', 'box', 'cylinder', 'cone'] as const).map((form) => (
                <button key={form} className="btn-secondary" style={{padding: '4px 10px', fontSize: 12}} onClick={() => addElement(form)}>
                  {FORM_LABELS[form]}
                </button>
              ))}
            </div>

            {/* 选中元素编辑 */}
            {selected ? (
              <div className="stab-result" style={{display: 'grid', gap: 6}}>
                {selected.kind === 'text' && (
                  <div className="stab-control-row">
                    <span className="stab-control-label">文字</span>
                    <input
                      type="text"
                      value={selected.text ?? ''}
                      maxLength={20}
                      onChange={(e) => patchElement(selected.id, {text: e.target.value})}
                      style={{flex: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid #555', background: '#222', color: '#eee'}}
                    />
                  </div>
                )}
                <div className="stab-control-row">
                  <span className="stab-control-label">大小</span>
                  <input type="range" min={0.03} max={0.8} step={0.01} value={selected.size}
                    onChange={(e) => patchElement(selected.id, {size: Number(e.target.value)})}
                    style={{flex: 1}} />
                  <span className="stab-control-value">{Math.round(selected.size * 100)}%</span>
                </div>
                <div className="stab-control-row">
                  <span className="stab-control-label">朝向</span>
                  <label
                    style={{display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#ccc', cursor: 'pointer'}}
                    title="开启后文字/面板自动转到正对镜头的方向（俯拍、绕行机位也保持可读）"
                  >
                    <input
                      type="checkbox"
                      checked={selected.yawDeg === undefined}
                      onChange={(e) => patchElement(selected.id, e.target.checked ? {yawDeg: undefined} : {yawDeg: 0})}
                    />
                    自动朝向
                  </label>
                  <input type="range" min={-180} max={180} step={5} value={selected.yawDeg ?? 0}
                    onChange={(e) => patchElement(selected.id, {yawDeg: Number(e.target.value)})}
                    disabled={selected.yawDeg === undefined}
                    style={{flex: 1}} />
                  <span className="stab-control-value">{selected.yawDeg === undefined ? '自动' : `${selected.yawDeg}°`}</span>
                </div>
                {/* 三轴姿态：朝向=水平面向（yaw），倾斜=绕地面水平轴抬头/低头（pitch），
                    旋转=自身平面内打转（roll）；三者正交可合成任意方向 */}
                <div className="stab-control-row">
                  <span className="stab-control-label">倾斜</span>
                  <input type="range" min={-90} max={90} step={5} value={selected.pitchDeg ?? 0}
                    onChange={(e) => patchElement(selected.id, {pitchDeg: Number(e.target.value)})}
                    style={{flex: 1}}
                    title="绕地面水平轴抬头/低头：躺平文字 ±90° = 竖立面向朝向方向；立起面板 = 前倾后仰" />
                  <span className="stab-control-value">{selected.pitchDeg ?? 0}°</span>
                </div>
                <div className="stab-control-row">
                  <span className="stab-control-label">旋转</span>
                  <input type="range" min={-180} max={180} step={5} value={selected.rollDeg ?? 0}
                    onChange={(e) => patchElement(selected.id, {rollDeg: Number(e.target.value)})}
                    style={{flex: 1}}
                    title="文字/面板内容在自身平面内打转" />
                  <span className="stab-control-value">{selected.rollDeg ?? 0}°</span>
                </div>
                <div className="stab-control-row">
                  <span className="stab-control-label">悬浮</span>
                  <input type="range" min={0} max={0.3} step={0.01} value={selected.lift ?? 0}
                    onChange={(e) => patchElement(selected.id, {lift: Number(e.target.value)})}
                    style={{flex: 1}}
                    title="离地抬升（倾斜竖立的文字可抬离地面避免陷入）" />
                  <span className="stab-control-value">{Math.round((selected.lift ?? 0) * 100)}%</span>
                </div>
                {(selected.form === 'extruded' || selected.kind === 'shape') && selected.form !== 'plate' && (
                  <div className="stab-control-row">
                    <span className="stab-control-label">厚度</span>
                    <input type="range" min={0.2} max={3} step={0.1} value={selected.depth ?? 1}
                      onChange={(e) => patchElement(selected.id, {depth: Number(e.target.value)})}
                      style={{flex: 1}}
                      title={selected.form === 'extruded' ? '立体文字的挤出厚度' : '几何体的高度倍率'} />
                    <span className="stab-control-value">×{(selected.depth ?? 1).toFixed(1)}</span>
                  </div>
                )}
                <div className="stab-control-row">
                  <span className="stab-control-label">颜色</span>
                  <input type="color" value={selected.color ?? '#3399ff'}
                    onChange={(e) => patchElement(selected.id, {color: e.target.value})}
                    style={{width: 36, height: 24}} />
                  <span className="stab-control-label" style={{marginLeft: 10}}>入场</span>
                  <select
                    value={selected.entrance ?? 'rise'}
                    onChange={(e) => patchElement(selected.id, {entrance: e.target.value as GroundElement['entrance']})}
                    style={{padding: '4px 6px', borderRadius: 6, border: '1px solid #555', background: '#222', color: '#eee'}}
                  >
                    <option value="rise">升起</option>
                    <option value="fade">淡入</option>
                    <option value="none">无</option>
                  </select>
                  <button
                    className="btn-secondary stab-remove-btn"
                    style={{display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto', padding: '4px 10px'}}
                    onClick={() => removeElement(selected.id)}
                  >
                    <Trash2 size={13} /> 删除
                  </button>
                </div>
              </div>
            ) : (
              <p className="stab-hint small">拖动元素标签移动位置（标签就贴在 3D 元素上）；点击标签编辑属性；朝向默认自动面向镜头；整片预览查看透视跟随效果</p>
            )}

            {error && <div className="stab-warning"><AlertTriangle size={14} /> {error}</div>}

            <div className="stab-footer">
              <button
                className="btn-secondary stab-remove-btn"
                style={{display: 'inline-flex', alignItems: 'center', gap: 6}}
                onClick={handleRemoveTrack}
                disabled={analyzing}
              >
                <Trash2 size={14} /> 移除追踪
              </button>
              <button
                className="btn-secondary"
                style={{display: 'inline-flex', alignItems: 'center', gap: 6}}
                onClick={() => void runAnalyze()}
                disabled={analyzing}
                title="换素材段落/重试质量时重新分析"
              >
                {analyzing ? <Loader2 size={14} className="stab-spin" /> : <Wand2 size={14} />}
                重新分析
              </button>
              <button className="btn-primary" onClick={onClose}>完成</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default GroundModal;
