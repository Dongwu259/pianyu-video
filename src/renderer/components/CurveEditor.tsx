/**
 * CurveEditor - 多点缓动曲线编辑器（AE 速度图风格，可复用）。
 *
 * 受控组件：{curve, onChange}。SVG 画布内绘制曲线 + 控制点：
 * - 拖动中间点改 (x,y)；首末点 (0,0)/(1,1) 固定不可拖。
 * - 空白处点击=在该 x 增加点；双击中间点=删除。
 * - 顶部预设下拉：linear/easeIn/easeOut/easeInOut/bounce/anticipate。
 * 用于两处：Timeline 关键帧段缓动 + StoryboardEditor 转场缓动。
 */

import React, {useMemo, useRef, useState} from 'react';
import type {EasingCurve} from '../../shared/easing-curve';
import {evalEasingCurve, normalizeCurve, addPoint, removePoint, PRESET_CURVES, presetCurve} from '../../shared/easing-curve';
import './CurveEditor.css';

// viewBox 尺寸与内边距
const VB_W = 260;
const VB_H = 180;
const PAD_L = 20;
const PAD_R = 12;
const PAD_T = 20;
const PAD_B = 20;
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;

const toScreenX = (x: number) => PAD_L + x * PLOT_W;
const toScreenY = (y: number) => PAD_T + (1 - y) * PLOT_H;

interface Props {
  curve: EasingCurve;
  onChange: (curve: EasingCurve) => void;
  /** 紧凑模式：隐藏预设下拉与说明（嵌入空间紧张时） */
  compact?: boolean;
}

export const CurveEditor: React.FC<Props> = ({curve, onChange, compact}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 当前匹配的预设 id（用于下拉显示），无匹配则为 'custom'
  const matchedPreset = useMemo(() => {
    const ids = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'bounce', 'anticipate'];
    for (const id of ids) {
      const p = presetCurve(id);
      if (JSON.stringify(p.points) === JSON.stringify(curve.points)) return id;
    }
    return 'custom';
  }, [curve]);

  // 采样曲线路径
  const pathD = useMemo(() => {
    const N = 80;
    let d = '';
    for (let i = 0; i <= N; i++) {
      const x = i / N;
      const y = evalEasingCurve(curve, x);
      const sx = toScreenX(x);
      const sy = toScreenY(y);
      d += (i === 0 ? 'M' : 'L') + sx.toFixed(2) + ' ' + sy.toFixed(2) + ' ';
    }
    return d;
  }, [curve]);

  // 客户端坐标 -> 曲线坐标（考虑 viewBox 缩放）
  const clientToCurve = (clientX: number, clientY: number): {x: number; y: number} => {
    const svg = svgRef.current;
    if (!svg) return {x: 0, y: 0};
    const rect = svg.getBoundingClientRect();
    const vbX = ((clientX - rect.left) / rect.width) * VB_W;
    const vbY = ((clientY - rect.top) / rect.height) * VB_H;
    return {
      x: (vbX - PAD_L) / PLOT_W,
      y: 1 - (vbY - PAD_T) / PLOT_H,
    };
  };

  // 拖动控制点
  const onPointDown = (e: React.PointerEvent, idx: number) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const pts = curve.points;
    const onMove = (ev: PointerEvent) => {
      const {x, y} = clientToCurve(ev.clientX, ev.clientY);
      let nx = Math.max(0, Math.min(1, x));
      let ny = Math.max(-0.6, Math.min(1.6, y));
      // 首末点固定
      if (idx === 0) {nx = 0; ny = 0;}
      else if (idx === pts.length - 1) {nx = 1; ny = 1;}
      else {
        // 钳到相邻点之间，保持严格递增
        nx = Math.max(nx, pts[idx - 1].x + 0.005);
        nx = Math.min(nx, pts[idx + 1].x - 0.005);
      }
      const newPts = pts.map((p, i) => (i === idx ? {x: nx, y: ny} : p));
      onChange(normalizeCurve(newPts));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 空白处点击 = 增加点
  const onBgDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as Element).classList.contains('ce-bg')) return;
    const {x} = clientToCurve(e.clientX, e.clientY);
    if (x <= 0.01 || x >= 0.99) return;
    onChange(addPoint(curve, x));
  };

  const handlePreset = (id: string) => {
    if (id === 'custom') return;
    onChange(presetCurve(id));
  };

  return (
    <div className="curve-editor">
      {!compact && (
        <div className="ce-header">
          <select className="ce-preset" value={matchedPreset} onChange={(e) => handlePreset(e.target.value)}>
            {PRESET_CURVES.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
            <option value="custom">自定义</option>
          </select>
          <span className="ce-hint">空白处点击加点 · 双击中间点删除</span>
        </div>
      )}
      <svg
        ref={svgRef}
        className="ce-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        onPointerDown={onBgDown}
      >
        {/* 网格 */}
        <rect className="ce-bg" x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} />
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <line key={`vx${g}`} className="ce-grid" x1={toScreenX(g)} y1={PAD_T} x2={toScreenX(g)} y2={PAD_T + PLOT_H} />
        ))}
        {[0, 0.5, 1].map((g) => (
          <line key={`vy${g}`} className="ce-grid" x1={PAD_L} y1={toScreenY(g)} x2={PAD_L + PLOT_W} y2={toScreenY(g)} />
        ))}
        {/* 曲线 */}
        <path className="ce-curve" d={pathD} />
        {/* 控制点连线（折线辅助） */}
        <polyline
          className="ce-poly"
          points={curve.points.map((p) => `${toScreenX(p.x).toFixed(2)},${toScreenY(p.y).toFixed(2)}`).join(' ')}
        />
        {/* 控制点 */}
        {curve.points.map((p, i) => {
          const isEnd = i === 0 || i === curve.points.length - 1;
          return (
            <circle
              key={i}
              className={`ce-pt ${isEnd ? 'ce-pt-end' : ''} ${hoverIdx === i ? 'hover' : ''}`}
              cx={toScreenX(p.x)}
              cy={toScreenY(p.y)}
              r={isEnd ? 4 : 5}
              onPointerDown={(e) => onPointDown(e, i)}
              onPointerEnter={() => setHoverIdx(i)}
              onPointerLeave={() => setHoverIdx(null)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!isEnd) onChange(removePoint(curve, i));
              }}
            />
          );
        })}
      </svg>
    </div>
  );
};

export default CurveEditor;
