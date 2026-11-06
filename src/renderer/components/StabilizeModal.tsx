/**
 * StabilizeModal - 跟踪稳定弹窗（故事板素材卡「稳定」入口）
 *
 * 交互（方案 A，见 RESEARCH-STABILIZATION.md）：
 * - 画面区：视频暂停在 trimStart+0.1 当背景，上方交互层单击放/拖动跟踪点（最多 2 个，
 *   单点 = 平移稳定；双点 = 平移+旋转+缩放，点坐标按显示比例换算成视频像素）；
 * - 强度滑块 smoothSec（0.2~2s，默认 0.8）：已稳定素材改强度不重分析——读 sidecar
 *   原始采样后渲染端 solveStabilization 重算（毫秒级，防抖 300ms）；
 * - 「自动选点并分析」= AI 同款（points 传空数组，服务侧首帧 autoPickPoint）；
 * - 分析完成写入 store（持久化 stabilization + 内存态校正表），结果显示 zoom/裁边/丢失率。
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {X, Crosshair, Loader2, Wand2, AlertTriangle, Trash2} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import type {VideoClip} from '../../shared/types';
import {STAB_DEFAULTS, solveStabilization} from '../../shared/stabilization';
import type {StabPoint, StabTrackFile} from '../../shared/stabilization';
import {clipSrcToPath} from '../utils/clipPath';
import './StabilizeModal.css';

interface StabilizeModalProps {
  clipIndex: number;
  /** 打开弹窗时的活动段下标（VideoUploader 捕获）：异步分析完成后的写回锚定该段，
      防止「分析中关弹窗切片段 → 结果写进别的片段」 */
  segmentIndex: number;
  clip: VideoClip;
  onClose: () => void;
}

/** 分析结果展示态（zoom 之外都是统计信息；丢失率 >0.15 黄灯） */
interface StabResultView {
  zoom: number;
  maxCorrectionPx: number;
  lostRatio: number;
  capped: boolean;
}

/** 与 VideoTrimmer 相同：把 http/file 源统一转为 local-video:// 协议 URL */
const toLocalVideoUrl = (src: string): string => {
  const rawPath = src.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
  return `local-video://${rawPath}`;
};

/** Electron invoke 抛错会带前缀，剥掉只留中文正文 */
const stripIpcPrefix = (err: unknown): string =>
  String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const StabilizeModal: React.FC<StabilizeModalProps> = ({clipIndex, segmentIndex, clip, onClose}) => {
  const setVideoStabilization = useProjectStore((s) => s.setVideoStabilization);
  const [points, setPoints] = useState<StabPoint[]>(() =>
    (clip.stabilization?.points ?? []).map((p) => ({...p})),
  );
  const [smoothSec, setSmoothSec] = useState(clip.stabilization?.smoothSec ?? STAB_DEFAULTS.smoothSec);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<StabResultView | null>(null);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragPointRef = useRef<number | null>(null);
  /** 已读出的 sidecar 原始采样（改强度重算用；分析完成时直接缓存，免再读盘） */
  const trackRef = useRef<StabTrackFile | null>(null);
  /** 初次挂载不触发强度重算（回显值本身就是持久化值） */
  const skipFirstSmoothRef = useRef(true);
  const analyzingRef = useRef(false);

  const stabilized = !!clip.stabilization;

  // 视频就绪后停在 trimStart+0.1 当交互背景（跟踪点就落在这帧画面上）
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

  /** 弹窗锚定的素材当前是否还在（段/下标/素材 id 三重核对；分析异步写回前必查） */
  const clipStillThere = useCallback((): boolean => {
    const seg = useProjectStore.getState().segments[segmentIndex];
    return seg?.videos[clipIndex]?.id === clip.id;
  }, [segmentIndex, clipIndex, clip.id]);

  /** 读 sidecar 原始采样（带会话内缓存） */
  const resolveTrack = useCallback(async (): Promise<StabTrackFile | null> => {
    if (trackRef.current) return trackRef.current;
    const tp = useProjectStore.getState().segments[segmentIndex]?.videos[clipIndex]?.stabilization?.trackPath;
    if (!tp) return null;
    const t = await window.api.stabilizeRead(tp).catch(() => null);
    if (t) trackRef.current = t;
    return t;
  }, [segmentIndex, clipIndex]);

  // 强度变化（已稳定且非分析中）：不重分析，直接按新 smoothSec 重算校正表（防抖 300ms）
  useEffect(() => {
    if (skipFirstSmoothRef.current) {
      skipFirstSmoothRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        const stab = useProjectStore.getState().segments[segmentIndex]?.videos[clipIndex]?.stabilization;
        if (!stab || analyzingRef.current || !clipStillThere()) return;
        const track = await resolveTrack();
        if (!track) return;
        const solved = solveStabilization(track.samples, track.sampleFps, {
          smoothSec,
          maxZoom: STAB_DEFAULTS.maxZoom,
          videoWidth: track.videoWidth,
          videoHeight: track.videoHeight,
        });
        if (!clipStillThere()) return;
        setVideoStabilization(clipIndex, {
          stabilization: {...stab, smoothSec},
          stabCorrections: solved.corrections,
          stabZoom: solved.zoom,
          stabSampleFps: track.sampleFps,
        }, segmentIndex);
        setResult((r) => (r ? {...r, zoom: solved.zoom, capped: solved.capped} : r));
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [smoothSec, segmentIndex, clipIndex, resolveTrack, setVideoStabilization, clipStillThere]);

  // ====== 跟踪点交互（单击放点 / 拖动移点 / 点 × 删点）======

  const eventToVideoPx = (e: React.PointerEvent): StabPoint => {
    const rect = overlayRef.current!.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const fy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return {x: Math.round(fx * clip.width), y: Math.round(fy * clip.height)};
  };

  const handleOverlayPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || analyzing) return;
    if ((e.target as HTMLElement).closest('[data-stab-point]')) return; // 命中已有点走拖动
    if (points.length >= 2) return;
    setPoints((prev) => [...prev, eventToVideoPx(e)]);
  };

  const handlePointPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0 || analyzing) return;
    if ((e.target as HTMLElement).closest('[data-stab-remove]')) return; // × 按钮走删除
    e.stopPropagation();
    e.preventDefault();
    overlayRef.current?.setPointerCapture(e.pointerId);
    dragPointRef.current = index;
  };

  const handleOverlayPointerMove = (e: React.PointerEvent) => {
    const idx = dragPointRef.current;
    if (idx === null) return;
    const p = eventToVideoPx(e);
    setPoints((prev) => prev.map((pt, i) => (i === idx ? p : pt)));
  };

  const handleOverlayPointerUp = () => {
    dragPointRef.current = null;
  };

  const removePoint = (index: number) => {
    setPoints((prev) => prev.filter((_, i) => i !== index));
  };

  // ====== 分析 ======

  const runAnalyze = async (auto: boolean) => {
    if (analyzing || (!auto && points.length === 0)) return;
    setAnalyzing(true);
    analyzingRef.current = true;
    setError('');
    try {
      const res = await window.api.stabilizeAnalyze({
        videoPath: clipSrcToPath(clip.src),
        points: auto ? [] : points,
        opts: {
          smoothSec,
          trimStart: clip.trimStart ?? 0,
          trimEnd: clip.trimEnd ?? clip.duration,
        },
      });
      // 分析期间用户可能已关弹窗/切片段/删素材：写回前核对锚定素材仍在原处
      if (!clipStillThere()) return;
      trackRef.current = res.track;
      setVideoStabilization(clipIndex, {
        stabilization: {
          trackPath: res.trackPath,
          points: res.track.points,
          smoothSec,
          enabled: true,
          lostRatio: res.stats.lostRatio,
        },
        stabCorrections: res.corrections,
        stabZoom: res.zoom,
        stabSampleFps: res.track.sampleFps,
      }, segmentIndex);
      // 自动模式回显实际用点；手动模式服务原样返回用户点
      setPoints(res.track.points.map((p) => ({...p})));
      setResult({
        zoom: res.zoom,
        maxCorrectionPx: res.stats.maxCorrectionPx,
        lostRatio: res.stats.lostRatio,
        capped: res.capped,
      });
    } catch (err) {
      setError(stripIpcPrefix(err));
    } finally {
      setAnalyzing(false);
      analyzingRef.current = false;
    }
  };

  const handleRemove = () => {
    setVideoStabilization(clipIndex, {stabilization: undefined}, segmentIndex);
    trackRef.current = null;
    setResult(null);
  };

  const zoomPct = result ? Math.max(0, Math.round((result.zoom - 1) * 1000) / 10) : 0;
  const lostPct = result ? Math.round(result.lostRatio * 1000) / 10 : 0;

  return (
    <div className="stab-overlay" onClick={onClose}>
      <div className="stab-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="stab-header">
          <h3>视频稳定</h3>
          <button className="btn-close" onClick={onClose}><X size={18} /></button>
        </div>

        <p className="stab-file-name">
          {clip.name} · {clip.width}×{clip.height}
          {stabilized && <span className="stab-state-badge">已稳定</span>}
        </p>

        {/* 画面区：视频背景 + 跟踪点交互层（容器比例 = 视频画幅，坐标换算才不失真；
            宽受高上限 340px 反推限制，竖屏素材不会撑出超长预览） */}
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
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerUp}
          >
            {points.map((p, i) => (
              <div
                key={i}
                data-stab-point="1"
                className="stab-point"
                style={{left: `${(p.x / clip.width) * 100}%`, top: `${(p.y / clip.height) * 100}%`}}
                onPointerDown={(e) => handlePointPointerDown(e, i)}
                title={`跟踪点 ${i + 1}（${p.x}, ${p.y}）：拖动调整位置`}
              >
                <Crosshair size={15} />
                <span className="stab-point-index">{i + 1}</span>
                <button
                  data-stab-remove="1"
                  className="stab-point-remove"
                  onClick={() => removePoint(i)}
                  title="删除该跟踪点"
                >
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <p className="stab-hint">
          {points.length >= 2
            ? '双点 = 平移+旋转+缩放稳定（两点连线的角度与距离变化也会被校正）'
            : points.length === 1
              ? '单击画面可再放一个点：双点 = 平移+旋转+缩放稳定；点请放在静止背景上（别放运动物体/纯文字区）'
              : '单击画面放跟踪点（最多 2 个），放在静止背景、纹理丰富的位置；也可以直接「自动选点并分析」'}
        </p>

        {/* 强度滑块 */}
        <div className="stab-control-row">
          <span className="stab-control-label">稳定强度</span>
          <input
            type="range"
            min={0.2}
            max={2}
            step={0.1}
            value={smoothSec}
            onChange={(e) => setSmoothSec(Number(e.target.value))}
            disabled={analyzing}
            style={{flex: 1}}
          />
          <span className="stab-control-value">{smoothSec.toFixed(1)}s</span>
        </div>
        <p className="stab-hint small">
          窗口越大画面越稳但保留的运镜越少；已稳定素材改强度即时重算，不用重新分析
        </p>

        {/* 分析操作 */}
        <div className="stab-actions-row">
          <button
            className="btn-secondary"
            style={{display: 'inline-flex', alignItems: 'center', gap: 6}}
            onClick={() => void runAnalyze(true)}
            disabled={analyzing}
          >
            <Wand2 size={14} /> 自动选点并分析
          </button>
          <button
            className="btn-primary"
            style={{display: 'inline-flex', alignItems: 'center', gap: 6}}
            onClick={() => void runAnalyze(false)}
            disabled={analyzing || points.length === 0}
            title={points.length === 0 ? '先在画面上放至少 1 个跟踪点' : undefined}
          >
            {analyzing ? <Loader2 size={14} className="stab-spin" /> : <Crosshair size={14} />}
            {analyzing ? '分析中…' : '分析'}
          </button>
        </div>

        {error && (
          <div className="stab-warning"><AlertTriangle size={14} /> {error}</div>
        )}

        {/* 分析结果 */}
        {result && (
          <div className="stab-result">
            <div className="stab-result-row">
              <span>画面将放大 <strong>{zoomPct}%</strong>（裁掉露出边缘）</span>
              <span>最大校正 <strong>{result.maxCorrectionPx}px</strong></span>
            </div>
            <div className={`stab-result-row ${result.lostRatio > 0.15 ? 'warn' : ''}`}>
              {result.lostRatio > 0.15 ? (
                <span><AlertTriangle size={12} /> 丢失率 {lostPct}% 偏高——部分时段跟踪不稳，建议换跟踪点重新分析（放静止背景、纹理强处）</span>
              ) : (
                <span>丢失率 {lostPct}%（跟踪正常）</span>
              )}
            </div>
            {result.capped && (
              <div className="stab-result-row warn">
                <span><AlertTriangle size={12} /> 抖动过大，已按缩放上限截断——个别帧边缘可能露出</span>
              </div>
            )}
          </div>
        )}

        {/* 底部操作 */}
        <div className="stab-footer">
          {stabilized && (
            <button
              className="btn-secondary stab-remove-btn"
              style={{display: 'inline-flex', alignItems: 'center', gap: 6}}
              onClick={handleRemove}
              disabled={analyzing}
            >
              <Trash2 size={14} /> 移除稳定
            </button>
          )}
          <button className="btn-primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
};

export default StabilizeModal;
