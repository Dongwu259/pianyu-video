/**
 * VideoTrimmer - 视频剪辑组件（剪辑软件式时间线）
 *
 * 单条时间线上的指针交互（无原生滑块叠加，避免把手互抢指针）：
 * - 两端竖条手柄 = 裁剪边界（互钳，至少保留 1s）
 * - ✂ 挖段模式：保留区间内拖框抠掉中段（可多段）；块可拖动移位、两端调边界、可删除
 * - ▶ 浏览模式（默认）：点击/拖动时间线 = 打点与擦洗（播放头跟随，预览实时跳帧）
 * - 预览播放自动跳过挖段，所见即成片
 * - 时间线背景铺素材抽帧缩略图（胶片条），顶部时间标尺
 * - 实时显示有效时长（裁剪 − 挖段）
 */

import React, {useState, useRef, useEffect, useCallback} from 'react';
import {X, Play, Pause, SkipBack, SkipForward, AlertTriangle, Scissors, Trash2, MousePointer2} from 'lucide-react';
import {normalizeCuts, cutsTotalSec} from '../../shared/clipCuts';
import type {ClipCut} from '../../shared/clipCuts';
import {clipSrcToPath} from '../utils/clipPath';
import './VideoTrimmer.css';

interface VideoTrimmerProps {
  src: string;              // 视频源（本地视频服务 URL）
  fileName: string;         // 文件名
  duration: number;         // 原始时长（秒）
  maxDuration?: number;     // 最大允许时长（秒）
  /** 打开时已有的挖段列表（再次编辑时回显） */
  initialCuts?: ClipCut[];
  onConfirm: (trimStart: number, trimEnd: number, cuts: ClipCut[] | undefined) => void;
  onCancel: () => void;
}

/** 挖段交互的最小长度（秒）：拖出不足该长度的框选视为误触，不生成 */
const MIN_CUT_LEN = 0.3;
/** 挖段与裁剪边界 / 相邻挖段保持的最小间隙（秒），保证边界两侧各有可播画面 */
const CUT_GAP = 0.2;
/** 胶片条缩略图数量 */
const FILMSTRIP_COUNT = 12;

/** 挖段列表按起点排序 + 钳制到 (lo, hi) 内并保证互不重叠（live 交互期用；落库再走 normalizeCuts） */
const clampCutsLive = (cuts: ClipCut[], lo: number, hi: number): ClipCut[] => {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out: ClipCut[] = [];
  for (const c of sorted) {
    const lower = out.length > 0 ? out[out.length - 1].end + CUT_GAP : lo + CUT_GAP;
    const upper = hi - CUT_GAP;
    if (upper - lower < MIN_CUT_LEN) break;
    const s = Math.max(lower, Math.min(c.start, upper - MIN_CUT_LEN));
    const e = Math.min(Math.max(c.end, s + MIN_CUT_LEN), upper);
    out.push({start: s, end: e});
  }
  return out;
};

/** 时间标尺刻度步长：取「时长/6 附近」的整数好读值 */
const niceStep = (duration: number): number => {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  for (const c of candidates) {
    if (duration / c <= 7) return c;
  }
  return candidates[candidates.length - 1];
};

type DragState =
  | {kind: 'trim'; edge: 'start' | 'end'}
  | {kind: 'scrub'}
  | {kind: 'createCut'; anchorSec: number}
  | {kind: 'cutEdge'; index: number; edge: 'start' | 'end'}
  | {kind: 'cutMove'; index: number; grabOffset: number};

export const VideoTrimmer: React.FC<VideoTrimmerProps> = ({
  src,
  fileName,
  duration,
  maxDuration = 30,
  initialCuts,
  onConfirm,
  onCancel,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(Math.min(duration, maxDuration));
  const [cuts, setCuts] = useState<ClipCut[]>(() =>
    initialCuts && initialCuts.length > 0 ? [...initialCuts] : [],
  );
  const [mode, setMode] = useState<'browse' | 'cut'>('browse');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [blobUrl, setBlobUrl] = useState('');
  const [error, setError] = useState('');
  const dragRef = useRef<DragState | null>(null);
  /** 框选新建的实时预览区间（拖动中才显示） */
  const [creatingRange, setCreatingRange] = useState<{from: number; to: number} | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** 时间线像素宽（挖段块够宽时才显示剪刀图标） */
  const [trackW, setTrackW] = useState(0);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => setTrackW(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** 胶片条缩略图（dataUrl[]，异步逐批填充；失败保持空 → 背景渐变兜底） */
  const [thumbs, setThumbs] = useState<string[]>([]);

  // 使用 local-video:// 协议加载视频（无 CORS 限制、支持流式读取）
  useEffect(() => {
    const rawPath = src.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
    setBlobUrl(`local-video://${rawPath}`);
    setThumbs([]);
  }, [src]);

  // 胶片条：批量抽帧铺时间线背景（≤4 帧/次，分 3 批；失败静默降级为纯色背景）
  useEffect(() => {
    let cancelled = false;
    if (!(duration > 0.5)) return;
    const times = Array.from({length: FILMSTRIP_COUNT}, (_, i) =>
      Math.min(duration - 0.05, (duration * (i + 0.5)) / FILMSTRIP_COUNT),
    );
    const pull = async (batch: number): Promise<void> => {
      const slice = times.slice(batch * 4, batch * 4 + 4);
      if (slice.length === 0 || cancelled) return;
      try {
        const frames = await window.api.extractFrames({path: clipSrcToPath(src), timesSec: slice});
        if (cancelled) return;
        setThumbs((prev) => {
          const next = [...prev];
          frames.forEach((f, i) => {
            next[batch * 4 + i] = f.dataUrl;
          });
          return next;
        });
      } catch {
        /* 抽帧失败不阻塞剪辑（白名单/解码问题走纯色背景） */
      }
      await pull(batch + 1);
    };
    void pull(0);
    return () => {
      cancelled = true;
    };
  }, [src, duration]);

  // 同步当前播放时间（挖段内自动跳到段尾——与成片切片播放一致）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      const inCut = cuts.find((c) => video.currentTime >= c.start && video.currentTime < c.end);
      if (inCut && video.currentTime < trimEnd) {
        video.currentTime = inCut.end;
        return;
      }
      setCurrentTime(video.currentTime);
      // 播放到裁剪结束点时暂停
      if (video.currentTime >= trimEnd) {
        video.pause();
        setIsPlaying(false);
      }
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => video.removeEventListener('timeupdate', onTimeUpdate);
  }, [trimEnd, cuts]);

  // 播放/暂停
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      // 如果当前时间在裁剪范围外，跳到起始点
      if (currentTime < trimStart || currentTime >= trimEnd) {
        video.currentTime = trimStart;
        setCurrentTime(trimStart);
      }
      void video.play();
      setIsPlaying(true);
    }
  }, [isPlaying, currentTime, trimStart, trimEnd]);

  // 跳到起点 / 终点
  const jumpToStart = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = trimStart;
      setCurrentTime(trimStart);
    }
  };
  const jumpToEnd = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = trimEnd;
      setCurrentTime(trimEnd);
    }
  };

  // ====== 时间线指针交互（单一表面，按下目标决定拖动语义） ======

  const posToSec = (e: React.PointerEvent | PointerEvent): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const fx = Math.max(0, Math.min(1, ((e as PointerEvent).clientX - rect.left) / rect.width));
    return fx * duration;
  };

  const handleTrackPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const sec = posToSec(e);
    const target = e.target as HTMLElement;

    if (target.closest('[data-cut-edge]')) {
      const block = target.closest('[data-cut-index]') as HTMLElement | null;
      const index = Number(block?.dataset.cutIndex ?? -1);
      const edge = (target.closest('[data-cut-edge]') as HTMLElement).dataset.cutEdge as 'start' | 'end';
      if (index >= 0 && cuts[index]) {
        e.preventDefault();
        trackRef.current?.setPointerCapture(e.pointerId);
        dragRef.current = {kind: 'cutEdge', index, edge};
      }
      return;
    }
    if (target.closest('[data-cut-body]')) {
      const block = target.closest('[data-cut-index]') as HTMLElement | null;
      const index = Number(block?.dataset.cutIndex ?? -1);
      if (index >= 0 && cuts[index]) {
        e.preventDefault();
        trackRef.current?.setPointerCapture(e.pointerId);
        dragRef.current = {kind: 'cutMove', index, grabOffset: sec - cuts[index].start};
      }
      return;
    }
    if (target.closest('[data-trim-handle]')) {
      const edge = (target.closest('[data-trim-handle]') as HTMLElement).dataset.trimEdge as 'start' | 'end';
      e.preventDefault();
      trackRef.current?.setPointerCapture(e.pointerId);
      dragRef.current = {kind: 'trim', edge};
      return;
    }
    // 播放头（倒三角 + 竖线）：整体可拖打点，优先于底下的柱体内容
    if (target.closest('[data-playhead]')) {
      e.preventDefault();
      trackRef.current?.setPointerCapture(e.pointerId);
      dragRef.current = {kind: 'scrub'};
      seekTo(sec);
      return;
    }
    // 柱体内的空白：暗区忽略；保留区随模式走（挖段 = 框选创建，浏览 = 打点/擦洗）
    if (target.closest('.tl-bar')) {
      if (sec <= trimStart || sec >= trimEnd) return;
      e.preventDefault();
      trackRef.current?.setPointerCapture(e.pointerId);
      if (mode === 'cut') {
        dragRef.current = {kind: 'createCut', anchorSec: sec};
        setCreatingRange({from: sec, to: sec});
      } else {
        dragRef.current = {kind: 'scrub'};
        seekTo(sec);
      }
      return;
    }
    // 标尺槽：点击/拖动打点（钳到保留区间内）
    e.preventDefault();
    trackRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = {kind: 'scrub'};
    seekTo(sec);
  };

  const handleTrackPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const sec = posToSec(e);
    switch (drag.kind) {
      case 'trim':
        if (drag.edge === 'start') {
          setTrimStart(Math.max(0, Math.min(sec, trimEnd - 1)));
        } else {
          setTrimEnd(Math.min(duration, Math.max(sec, trimStart + 1)));
        }
        return;
      case 'scrub':
        seekTo(sec);
        return;
      case 'createCut':
        setCreatingRange({from: Math.min(drag.anchorSec, sec), to: Math.max(drag.anchorSec, sec)});
        return;
      case 'cutEdge':
        setCuts((prev) =>
          prev.map((c, i) => {
            if (i !== drag.index) return c;
            if (drag.edge === 'start') return {...c, start: Math.min(sec, c.end - MIN_CUT_LEN)};
            return {...c, end: Math.max(sec, c.start + MIN_CUT_LEN)};
          }),
        );
        return;
      case 'cutMove': {
        setCuts((prev) =>
          prev.map((c, i) => {
            if (i !== drag.index) return c;
            const len = c.end - c.start;
            const s = Math.max(trimStart, Math.min(sec - drag.grabOffset, trimEnd - len));
            return {start: s, end: s + len};
          }),
        );
        return;
      }
    }
  };

  const handleTrackPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.kind === 'createCut' && creatingRange) {
      if (creatingRange.to - creatingRange.from >= MIN_CUT_LEN) {
        setCuts((prev) =>
          clampCutsLive([...prev, {start: creatingRange.from, end: creatingRange.to}], trimStart, trimEnd),
        );
      }
    }
    if (drag && drag.kind !== 'createCut' && drag.kind !== 'scrub' && drag.kind !== 'trim') {
      setCuts((prev) => clampCutsLive(prev, trimStart, trimEnd));
    }
    setCreatingRange(null);
  };

  /** 打点/擦洗：视频立即 seek，播放头跟随（播放中拖动会先暂停，松手从新位置继续） */
  const seekTo = (sec: number) => {
    const t = Math.max(trimStart, Math.min(sec, trimEnd));
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      videoRef.current.currentTime = t;
    }
    setCurrentTime(t);
  };

  // 裁剪边界变化后挖段重新钳制（缩选区可能吞掉部分挖段）
  useEffect(() => {
    setCuts((prev) => (prev.length > 0 ? clampCutsLive(prev, trimStart, trimEnd) : prev));
  }, [trimStart, trimEnd]);

  const effectiveDuration = trimEnd - trimStart - cutsTotalSec(cuts);
  const needsTrim = duration > maxDuration;

  // 格式化时间显示
  const formatTime = (t: number): string => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const ms = Math.floor((t % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  const pct = (sec: number) => `${(sec / duration) * 100}%`;

  // 时间标尺刻度
  const step = niceStep(duration);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) ticks.push(Math.round(t * 10) / 10);

  return (
    <div className="trimmer-overlay" onClick={onCancel}>
      <div className="trimmer-modal" onClick={(e) => e.stopPropagation()}>
        {/* 头部 */}
        <div className="trimmer-header">
          <h3>剪辑视频</h3>
          <button className="btn-close" onClick={onCancel}><X size={18} /></button>
        </div>

        <p className="trimmer-file-name">{fileName}</p>

        {/* 视频预览区 */}
        <div className="trimmer-preview">
          <video
            ref={videoRef}
            src={blobUrl}
            className="trimmer-video"
            onClick={togglePlay}
            playsInline
            preload="metadata"
          />
          {!isPlaying && (
            <div className="trimmer-play-overlay" onClick={togglePlay}>
              <span className="trimmer-play-icon"><Play size={32} /></span>
            </div>
          )}
        </div>

        {/* 播放控制 + 当前时间 */}
        <div className="trimmer-controls">
          <button className="btn-control" style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}} onClick={jumpToStart}><SkipBack size={14} /> 起点</button>
          <button className="btn-control btn-play" style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}} onClick={togglePlay}>
            {isPlaying ? <><Pause size={14} /> 暂停</> : <><Play size={14} /> 播放</>}
          </button>
          <button className="btn-control" style={{display: 'inline-flex', alignItems: 'center', gap: '4px'}} onClick={jumpToEnd}>终点 <SkipForward size={14} /></button>
          <span className="trimmer-time-readout">{formatTime(currentTime)} / {formatTime(duration)}</span>
        </div>

        {/* 模式切换：浏览（打点/擦洗）/ 挖段（框选抠中段） */}
        <div className="timeline-toolbar">
          <button
            className={`mode-chip ${mode === 'browse' ? 'selected' : ''}`}
            onClick={() => setMode('browse')}
            title="点击/拖动时间线打点预览"
          >
            <MousePointer2 size={12} /> 浏览
          </button>
          <button
            className={`mode-chip mode-cut ${mode === 'cut' ? 'selected' : ''}`}
            onClick={() => setMode('cut')}
            title="在保留区间内拖动框选，抠掉中间一段"
          >
            <Scissors size={12} /> 挖段
          </button>
          <span className="timeline-toolbar-hint">
            {mode === 'cut'
              ? '拖动两端竖条调边界；在区间内框选抠掉中段（可多段）'
              : '拖动两端竖条调边界；点击/拖动时间线打点预览；抠中段请切到「挖段」'}
          </span>
        </div>

        {/* 时间线：标尺槽（播放头倒三角在此拖动）+ 矩形视频柱体 */}
        <div
          ref={trackRef}
          className={`tl-surface ${mode === 'cut' ? 'cut-mode' : ''}`}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          onPointerCancel={handleTrackPointerUp}
        >
          {/* 标尺槽：时间刻度，点击/拖动也可打点 */}
          <div className="tl-gutter">
            {ticks.map((t) => (
              <div key={t} className="tl-tick" style={{left: pct(t)}}>
                <span className="tl-tick-label">{formatTime(t)}</span>
              </div>
            ))}
          </div>

          {/* 视频柱体（矩形）：胶片条铺底 */}
          <div className="tl-bar">
            <div className="tl-filmstrip">
              {thumbs.length > 0
                ? thumbs.map((d, i) => (d ? <img key={i} src={d} alt="" draggable={false} /> : <div key={i} className="tl-filmcell" />))
                : null}
            </div>

            {/* 裁剪区间外的暗区 */}
            <div className="tl-dim" style={{left: 0, width: pct(trimStart)}} />
            <div className="tl-dim" style={{left: pct(trimEnd), right: 0}} />

            {/* 裁剪区间高亮描边 */}
            <div
              className="tl-region"
              style={{left: pct(trimStart), width: `${((trimEnd - trimStart) / duration) * 100}%`}}
            />

            {/* 挖段块 */}
            {creatingRange && creatingRange.to - creatingRange.from >= MIN_CUT_LEN && (
              <div
                className="tl-cut creating"
                style={{left: pct(creatingRange.from), width: `${((creatingRange.to - creatingRange.from) / duration) * 100}%`}}
              />
            )}
            {cuts.map((c, i) => {
              const blockPx = trackW > 0 ? ((c.end - c.start) / duration) * trackW : 999;
              return (
                <div
                  key={i}
                  className="tl-cut"
                  data-cut-index={i}
                  style={{left: pct(c.start), width: `${((c.end - c.start) / duration) * 100}%`}}
                  title={`挖段 ${formatTime(c.start)} – ${formatTime(c.end)}（${(c.end - c.start).toFixed(1)}s）：拖动调整位置，两端竖条调边界`}
                >
                  <div className="tl-cut-edge" data-cut-edge="start" />
                  <div className="tl-cut-body" data-cut-body="1">
                    {blockPx >= 52 && <Scissors size={10} />}
                  </div>
                  <div className="tl-cut-edge" data-cut-edge="end" />
                </div>
              );
            })}

            {/* 左右边界手柄（宽命中区 + 竖条帽），压在挖段块之上 */}
            <div
              className="tl-trim-handle"
              data-trim-handle="1"
              data-trim-edge="start"
              style={{left: pct(trimStart)}}
              title={`起点 ${formatTime(trimStart)}：拖动调整`}
            >
              <span className="tl-trim-cap" />
            </div>
            <div
              className="tl-trim-handle"
              data-trim-handle="1"
              data-trim-edge="end"
              style={{left: pct(trimEnd)}}
              title={`终点 ${formatTime(trimEnd)}：拖动调整`}
            >
              <span className="tl-trim-cap" />
            </div>
          </div>

          {/* 播放头：倒三角 + 竖线，整体可拖调整时间 */}
          <div className="tl-playhead" data-playhead="1" style={{left: pct(currentTime)}}>
            <span className="tl-playhead-tri" />
            <span className="tl-playhead-line" />
          </div>
        </div>

        {/* 挖段列表 / 提示 */}
        <div className="cut-track-hint">
          {cuts.length > 0 ? (
            cuts.map((c, i) => (
              <span key={i} className="cut-chip">
                {formatTime(c.start)}–{formatTime(c.end)}（{(c.end - c.start).toFixed(1)}s）
                <button className="cut-chip-remove" onClick={() => setCuts((prev) => prev.filter((_, j) => j !== i))} title="删除该挖段">
                  <Trash2 size={11} />
                </button>
              </span>
            ))
          ) : (
            '挖掉的区间成片时前后无缝拼接；两端竖条是裁剪边界'
          )}
        </div>

        {/* 时长信息 */}
        <div className="trimmer-info">
          <div className="trim-stat">
            <span className="stat-label">原始时长</span>
            <span className="stat-value">{formatTime(duration)}</span>
          </div>
          <div className="trim-stat">
            <span className="stat-label">有效时长</span>
            <span className={`stat-value ${effectiveDuration > maxDuration ? 'warning' : 'good'}`}>
              {formatTime(effectiveDuration)}
            </span>
          </div>
          <div className="trim-stat">
            <span className="stat-label">最大限制</span>
            <span className="stat-value">{formatTime(maxDuration)}</span>
          </div>
        </div>

        {needsTrim && effectiveDuration > maxDuration && (
          <div className="trimmer-warning">
            <AlertTriangle size={14} /> 视频有效时长超过 {maxDuration} 秒限制，请裁剪或挖段后再继续
          </div>
        )}
        {error && <div className="trimmer-warning"><AlertTriangle size={14} /> {error}</div>}

        {/* 操作按钮 */}
        <div className="trimmer-actions">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button
            className="btn-primary"
            disabled={effectiveDuration > maxDuration}
            onClick={() => onConfirm(trimStart, trimEnd, normalizeCuts(cuts, trimStart, trimEnd))}
          >
            确认剪辑
          </button>
        </div>
      </div>
    </div>
  );
};

export default VideoTrimmer;
