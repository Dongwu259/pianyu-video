/**
 * Timeline - AE 风格时间轴
 *
 * 选中元素的每个可动画属性占一行：左侧 gutter（秒表开关 + 属性名 + 当前值），
 * 右侧轨道上有菱形关键帧标记。支持点击定位、拖拽移动、双击删除、缩放、播放头。
 * 与 Inspector 的数值输入互补：数值改动在已关键帧属性上会自动在该时间打关键帧。
 */

import React, {useState, useRef, useCallback} from 'react';
import type {CustomElement, AnimatedProp} from '../../shared/custom-template';
import {evalProp, setKeyframe, removeKeyframe} from '../../shared/custom-template';
import type {EasingCurve} from '../../shared/easing-curve';
import {easingToCurve} from '../../shared/easing-curve';
import {CurveEditor} from './CurveEditor';
import {Timer, LineChart} from 'lucide-react';
import './Timeline.css';

type AnimKey = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'scale';

const PROP_ROWS: {key: AnimKey; label: string; fallback: number}[] = [
  {key: 'x', label: '位置 X', fallback: 0.5},
  {key: 'y', label: '位置 Y', fallback: 0.5},
  {key: 'width', label: '宽度', fallback: 0.6},
  {key: 'height', label: '高度', fallback: 0.5},
  {key: 'rotation', label: '旋转', fallback: 0},
  {key: 'opacity', label: '透明度', fallback: 1},
  {key: 'scale', label: '缩放', fallback: 1},
];

export interface SelectedKeyframe {
  prop: AnimKey;
  t: number;
}

export interface TimelineProps {
  element: CustomElement | null;
  frame: number;
  totalFrames: number;
  setFrame: (f: number) => void;
  setPlaying: (p: boolean) => void;
  updateElement: (updater: (el: CustomElement) => CustomElement) => void;
  /** 当前选中的关键帧（受控），用于外部位移与缓动编辑 */
  selectedKf?: SelectedKeyframe | null;
  setSelectedKf?: (k: SelectedKeyframe | null) => void;
}

const isKf = (p: AnimatedProp): boolean => !!p.keyframes && p.keyframes.length > 0;

export const Timeline: React.FC<TimelineProps> = ({
  element,
  frame,
  totalFrames,
  setFrame,
  setPlaying,
  updateElement,
  selectedKf,
  setSelectedKf,
}) => {
  const [zoom, setZoom] = useState(1);
  const [showCurve, setShowCurve] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const t = totalFrames > 0 ? frame / totalFrames : 0;

  // 由鼠标 X 计算时间比例并定位播放头
  const seekFromClientX = useCallback((clientX: number) => {
    const content = contentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    setFrame(Math.round(Math.max(0, Math.min(1, ratio)) * totalFrames));
    setPlaying(false);
  }, [totalFrames, setFrame, setPlaying]);

  // 拖拽 scrub：按下即定位，移动中持续 seek，松开结束（用于标尺与播放头手柄）
  const startScrub = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    seekFromClientX(e.clientX);
    const onMove = (ev: PointerEvent) => seekFromClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [seekFromClientX]);

  // 秒表：开启/关闭某属性的关键帧化
  const toggleProp = (key: AnimKey, fallback: number) => {
    if (!element) return;
    const prop = element[key];
    if (isKf(prop)) {
      if (!confirm(`清除「${PROP_ROWS.find((r) => r.key === key)?.label}」的全部关键帧？`)) return;
      updateElement((el) => ({...el, [key]: {static: evalProp(el[key], frame, totalFrames, fallback)}}));
      if (selectedKf?.prop === key) setSelectedKf?.(null);
    } else {
      updateElement((el) => ({...el, [key]: setKeyframe(el[key], t, evalProp(el[key], frame, totalFrames, fallback))}));
    }
  };

  // 移动关键帧（拖拽）：保留 value/easing，仅改 t
  const moveKeyframe = (key: AnimKey, oldT: number, newT: number) => {
    updateElement((el) => {
      const prop = el[key];
      const kfs = prop.keyframes || [];
      const kf = kfs.find((k) => Math.abs(k.t - oldT) < 0.001);
      if (!kf) return el;
      const filtered = kfs.filter((k) => Math.abs(k.t - oldT) >= 0.001);
      filtered.push({t: newT, value: kf.value, easing: kf.easing, curve: kf.curve});
      filtered.sort((a, b) => a.t - b.t);
      return {...el, [key]: {...prop, keyframes: filtered}};
    });
  };

  const removeKf = (key: AnimKey, kt: number) => {
    updateElement((el) => ({...el, [key]: removeKeyframe(el[key], kt)}));
    if (selectedKf?.prop === key && Math.abs(selectedKf.t - kt) < 0.001) setSelectedKf?.(null);
  };

  // 改变关键帧缓动曲线（设置 curve 字段，覆盖命名 easing）
  const setKfCurve = (key: AnimKey, kt: number, curve: EasingCurve) => {
    updateElement((el) => {
      const prop = el[key];
      const kfs = (prop.keyframes || []).map((k) => (Math.abs(k.t - kt) < 0.001 ? {...k, curve} : k));
      return {...el, [key]: {...prop, keyframes: kfs}};
    });
  };

  // 菱形拖拽
  const onDiamondDown = (e: React.MouseEvent, key: AnimKey, kt: number) => {
    e.stopPropagation();
    setSelectedKf?.({prop: key, t: kt});
    setFrame(Math.round(kt * totalFrames));
    setPlaying(false);
    const startX = e.clientX;
    const startT = kt;
    const content = contentRef.current;
    const trackWidth = content ? content.getBoundingClientRect().width : 1;
    let lastT = startT;
    const onMove = (ev: MouseEvent) => {
      const newT = Math.max(0, Math.min(1, startT + (ev.clientX - startX) / trackWidth));
      if (Math.abs(newT - lastT) >= 0.0005) {
        moveKeyframe(key, lastT, newT);
        lastT = newT;
        setSelectedKf?.({prop: key, t: newT});
        setFrame(Math.round(newT * totalFrames));
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // 标尺刻度
  const tickCount = Math.min(10, Math.max(2, totalFrames));
  const ticks = Array.from({length: tickCount + 1}, (_, i) => i / tickCount);

  if (!element) {
    return (
      <div className="tl-wrap">
        <div className="tl-empty">选中一个元素以编辑其关键帧</div>
      </div>
    );
  }

  const selKfObj = selectedKf
    ? element[selectedKf.prop]?.keyframes?.find((k) => Math.abs(k.t - selectedKf.t) < 0.001)
    : undefined;

  return (
    <div className="tl-wrap">
      <div className="tl-header">
        <span className="tl-title"><Timer size={14} /> 时间轴</span>
        <span className="tl-frame">{frame} / {totalFrames} · {(t * 100).toFixed(0)}%</span>
        {selKfObj && (
          <button
            className={`tl-curve-toggle ${showCurve ? 'active' : ''}`}
            onClick={() => setShowCurve((v) => !v)}
            title="编辑进入此关键帧的缓动曲线（AE 风格速度曲线）"
          >
            <LineChart size={13} /> 缓动曲线
          </button>
        )}
        <div className="tl-zoom">
          <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))} title="缩小">−</button>
          <span>{zoom.toFixed(1)}x</span>
          <button onClick={() => setZoom((z) => Math.min(8, +(z + 0.5).toFixed(1)))} title="放大">+</button>
        </div>
      </div>

      {showCurve && selKfObj && selectedKf && (
        <div className="tl-curve-panel">
          <span className="tl-curve-panel-label">进入此关键帧的缓动曲线</span>
          <CurveEditor
            curve={selKfObj.curve ?? easingToCurve(selKfObj.easing ?? 'linear')}
            onChange={(c) => setKfCurve(selectedKf.prop, selectedKf.t, c)}
          />
        </div>
      )}

      <div className="tl-body">
        {/* 固定 gutter 列 */}
        <div className="tl-gutters">
          <div className="tl-gutter tl-gutter-head" />
          {PROP_ROWS.map((row) => {
            const prop = element[row.key];
            const kfed = isKf(prop);
            const val = evalProp(prop, frame, totalFrames, row.fallback);
            return (
              <div key={row.key} className="tl-gutter">
                <button
                  className={`tl-stopwatch ${kfed ? 'active' : ''}`}
                  onClick={() => toggleProp(row.key, row.fallback)}
                  title={kfed ? '关闭关键帧（清除全部）' : '开启关键帧'}
                ><Timer size={13} /></button>
                <span className="tl-prop-label">{row.label}</span>
                <span className="tl-prop-val">{val.toFixed(2)}</span>
              </div>
            );
          })}
        </div>

        {/* 可横向滚动的轨道区 */}
        <div className="tl-scroll">
          <div className="tl-content" ref={contentRef} style={{width: `${zoom * 100}%`}}>
            {/* 标尺 */}
            <div className="tl-ruler" onPointerDown={startScrub}>
              {ticks.map((tk, i) => (
                <div key={i} className="tl-tick" style={{left: `${tk * 100}%`}}>
                  <span>{Math.round(tk * totalFrames)}</span>
                </div>
              ))}
            </div>
            {/* 属性行（仅轨道） */}
            {PROP_ROWS.map((row) => {
              const prop = element[row.key];
              const kfed = isKf(prop);
              return (
                <div key={row.key} className="tl-track-row">
                  <div className="tl-track" onMouseDown={(e) => seekFromClientX(e.clientX)}>
                    {kfed && prop.keyframes!.map((k) => {
                      const isSel = selectedKf?.prop === row.key && Math.abs(selectedKf.t - k.t) < 0.001;
                      return (
                        <div
                          key={k.t}
                          className={`tl-diamond ${isSel ? 'selected' : ''}`}
                          style={{left: `${k.t * 100}%`}}
                          onMouseDown={(e) => onDiamondDown(e, row.key, k.t)}
                          onDoubleClick={(e) => { e.stopPropagation(); removeKf(row.key, k.t); }}
                          title={`t=${(k.t * 100).toFixed(0)}% · ${k.value.toFixed(2)}`}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {/* 播放头：贯穿标尺与所有轨道；顶部手柄可拖拽 scrub */}
            <div className="tl-playhead" style={{left: `${t * 100}%`}}>
              <div className="tl-playhead-grip" onPointerDown={startScrub} title="拖动定位播放头" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Timeline;
