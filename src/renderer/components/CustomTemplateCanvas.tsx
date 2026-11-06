/**
 * CustomTemplateCanvas - 自定义模板的 CSS 预览画布
 *
 * 按 frame 用 evalProp 求每个元素的属性值并渲染。所有尺寸用百分比，分辨率无关。
 *
 * 两种模式：
 * - 编辑器模式（editable）：元素可拖拽改 X/Y，显示选中态，视频框用占位
 * - 预览模式：显示实际视频/图片/文本，自动由父组件驱动 frame
 */

import React, {useRef, useCallback, useState, useEffect} from 'react';
import type {CustomTemplateDef, CustomElement, TextRole} from '../../shared/custom-template';
import {evalProp, defaultAspectIdFor, applyEntranceAnim, applyParamBinding} from '../../shared/custom-template';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {fitVideo} from '../../remotion/utils/fitVideo';
import {applyViewport} from '../../remotion/utils/viewport';
import {textStrokeCss} from '../../remotion/utils/textStroke';
import {Video, RotateCw} from 'lucide-react';
import type {VideoClip, PromoText, Orientation, FitMode} from '../../shared/types';
import './CustomTemplateCanvas.css';

export interface CustomTemplateCanvasProps {
  def: CustomTemplateDef;
  frame: number;
  totalFrames: number;
  orientation?: Orientation;
  /** 画布比例预设 id；缺省时用 def.aspectRatioId 或由 orientation 派生 */
  aspectRatioId?: string;
  videos?: VideoClip[];
  text?: PromoText;
  /** 模板参数当前值（Segment.customParams），驱动 paramBindings */
  params?: Record<string, number>;
  editable?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** 拖拽结束/移动时回调，x/y 为 0..1 比例（中心点） */
  onMove?: (id: string, x: number, y: number) => void;
  /** 编辑器：显示选中元素的运动路径（关键帧连线） */
  showMotionPath?: boolean;
  /** 编辑器：显示标题/动作安全区引导线 */
  showSafeArea?: boolean;
}

const getTextContent = (text: PromoText | undefined, role: TextRole, placeholder?: string, fixedText?: string): string => {
  // 固定文本优先：装饰性符号（引号/星标等）不随用户内容变化
  if (fixedText) return fixedText;
  if (!text) return placeholder || '';
  switch (role) {
    case 'title':
      return text.title || placeholder || '';
    case 'subtitle':
      return text.subtitle || placeholder || '';
    case 'feature':
      return text.features?.[0] || placeholder || '';
    case 'brand':
      return text.brandName || placeholder || '';
    default:
      return placeholder || '';
  }
};

export const CustomTemplateCanvas: React.FC<CustomTemplateCanvasProps> = ({
  def,
  frame,
  totalFrames,
  orientation,
  aspectRatioId,
  videos,
  text,
  params,
  editable = false,
  selectedId,
  onSelect,
  onMove,
  showMotionPath = false,
  showSafeArea = false,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{id: string; el: CustomElement} | null>(null);

  const orient = orientation || def.orientation;
  const arId = aspectRatioId || def.aspectRatioId || defaultAspectIdFor(orient);
  const preset = getAspectRatioPreset(arId);
  const isNarrow = preset.orientation === 'portrait';

  // 拖拽：mouse -> 比例
  const handleMouseDown = useCallback((e: React.MouseEvent, el: CustomElement) => {
    if (!editable || !onMove) return;
    e.stopPropagation();
    onSelect?.(el.id);
    dragRef.current = {id: el.id, el};
    const onMoveEvt = (ev: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas || !dragRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      dragRef.current.id = el.id;
      onMove(el.id, Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMoveEvt);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMoveEvt);
    window.addEventListener('mouseup', onUp);
  }, [editable, onMove, onSelect]);

  let videoIdx = 0;

  // 运动路径：选中元素 x/y 关键帧的连线（仅在编辑器且开启时）
  const motionPts: {x: number; y: number}[] = (() => {
    if (!editable || !showMotionPath || !selectedId) return [];
    const el = def.elements.find((e) => e.id === selectedId);
    if (!el) return [];
    const xKfs = el.x.keyframes || [];
    const yKfs = el.y.keyframes || [];
    if (xKfs.length === 0 && yKfs.length === 0) return [];
    const times = Array.from(new Set([...xKfs.map((k) => k.t), ...yKfs.map((k) => k.t)])).sort((a, b) => a - b);
    return times.map((tk) => ({
      x: evalProp(el.x, Math.round(tk * totalFrames), totalFrames, 0.5),
      y: evalProp(el.y, Math.round(tk * totalFrames), totalFrames, 0.5),
    }));
  })();

  return (
    <div
      ref={canvasRef}
      className={`custom-canvas ${isNarrow ? 'portrait' : 'landscape'} ${editable ? 'editable' : ''}`}
      style={{
        background: def.background,
        aspectRatio: `${preset.width} / ${preset.height}`,
        ...(isNarrow ? {maxWidth: '420px', margin: '0 auto'} : {}),
      }}
      onClick={() => editable && onSelect?.('')}
    >
      {def.elements.map((el) => {
        const bind = applyParamBinding.bind(null, def, params, el.id);
        const x = bind('x', evalProp(el.x, frame, totalFrames, 0.5));
        const y = bind('y', evalProp(el.y, frame, totalFrames, 0.5));
        const w = bind('width', evalProp(el.width, frame, totalFrames, 0.6));
        const h = bind('height', evalProp(el.height, frame, totalFrames, 0.5));
        const rotation = bind('rotation', evalProp(el.rotation, frame, totalFrames, 0));
        const opacity = bind('opacity', evalProp(el.opacity, frame, totalFrames, 1));
        const scale = bind('scale', evalProp(el.scale, frame, totalFrames, 1));
        const rotateX = el.rotateX ?? 0;
        const rotateY = el.rotateY ?? 0;
        const perspective = el.perspective ?? 1200;
        const isSelected = editable && selectedId === el.id;

        // 中心定位 -> 左上角百分比
        const leftPct = (x - w / 2) * 100;
        const topPct = (y - h / 2) * 100;

        const commonStyle: React.CSSProperties = {
          position: 'absolute',
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: `${w * 100}%`,
          height: `${h * 100}%`,
          opacity,
          // 3D 变换：perspective() 必须在 transform 链首位，作用于后续 rotate/scale
          transform: `perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotation}deg) scale(${scale})`,
          borderRadius: el.borderRadius ?? 0,
        };

        // 画布像素：用于把入场动画的画布比例位移/模糊转 px（预览与渲染保持同比例）
        const cw = canvasRef.current?.clientWidth || 0;
        const ch = canvasRef.current?.clientHeight || 0;
        const minDim = Math.min(cw, ch);

        if (el.type === 'video') {
          const video = videos?.[videoIdx++] || videos?.[0];
          const vAnim = applyEntranceAnim(el.entranceAnim, frame, '', opacity);
          // 与 CustomTemplateRender 一致的 fit 回退链：元素配置 > 片段指定 > 按类型默认（图片 cover / 视频 contain）
          const fit: FitMode = el.videoFit ?? video?.fit ?? (video?.type === 'image' ? 'cover' : 'contain');
          // 取景视口：与渲染端同一套几何（fitVideo + applyViewport）；无 viewport 时维持 objectFit 居中
          const elPxW = w * cw;
          const elPxH = h * ch;
          const placed =
            video?.viewport && elPxW > 0 && elPxH > 0
              ? applyViewport(elPxW, elPxH, fitVideo(elPxW, elPxH, video.width, video.height, fit), fit, video.viewport)
              : null;
          const mediaStyle: React.CSSProperties = placed
            ? {
                width: placed.width,
                height: placed.height,
                transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
                objectFit: fit,
              }
            : {width: '100%', height: '100%', objectFit: fit};
          // 裁剪起点（秒）：渲染端 ClipMedia startFrom 的预览等价
          const trimStartSec = video?.trimStart || 0;
          return (
            <div
              key={el.id}
              className={`canvas-el video-el ${isSelected ? 'selected' : ''}`}
              style={{
                ...commonStyle,
                opacity: vAnim.opacity,
                filter: vAnim.blur > 0 && minDim > 0 ? `blur(${vAnim.blur * minDim}px)` : undefined,
                transform: `perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotation + vAnim.rotateDeg}deg) translate(${vAnim.tx * cw}px, ${vAnim.ty * ch}px) scale(${scale * vAnim.scaleMul})`,
                overflow: 'hidden',
                boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
                cursor: editable ? 'move' : 'default',
              }}
              onMouseDown={(e) => handleMouseDown(e, el)}
              onClick={(e) => { e.stopPropagation(); onSelect?.(el.id); }}
            >
              {video ? (
                video.type === 'image' ? (
                  <img src={video.src} style={mediaStyle} alt="" />
                ) : (
                  <video
                    src={video.src}
                    style={mediaStyle}
                    muted
                    onLoadedMetadata={trimStartSec > 0 ? (e) => { e.currentTarget.currentTime = trimStartSec; } : undefined}
                  />
                )
              ) : (
                <div className="video-placeholder">
                  <Video size={28} />
                  <span className="placeholder-name">{el.name}</span>
                </div>
              )}
            </div>
          );
        }

        // 形状元素（装饰）
        if (el.type === 'shape') {
          const sAnim = applyEntranceAnim(el.entranceAnim, frame, '', opacity);
          const kind = el.shape ?? 'rect';
          const lineThickness = Math.max(1, el.borderWidth ?? 2);
          return (
            <div
              key={el.id}
              className={`canvas-el shape-el ${isSelected ? 'selected' : ''}`}
              style={{
                ...commonStyle,
                height: kind === 'line' ? lineThickness : `${h * 100}%`,
                top: kind === 'line' ? `calc(${topPct}% + ${(h / 2) * 100}% - ${lineThickness / 2}px)` : `${topPct}%`,
                opacity: sAnim.opacity,
                filter: el.blur && minDim > 0 ? `blur(${el.blur * minDim}px)` : undefined,
                transform: `rotateZ(${rotation + sAnim.rotateDeg}deg) translate(${sAnim.tx * cw}px, ${sAnim.ty * ch}px) scale(${scale * sAnim.scaleMul})`,
                background: el.fill ?? 'rgba(37, 99, 235, 0.25)',
                borderRadius: kind === 'ellipse' ? '50%' : (el.borderRadius ?? 0),
                border: kind !== 'line' && el.borderWidth ? `${el.borderWidth}px solid ${el.borderColor ?? '#FFFFFF'}` : undefined,
                cursor: editable ? 'move' : 'default',
              }}
              onMouseDown={(e) => handleMouseDown(e, el)}
              onClick={(e) => { e.stopPropagation(); onSelect?.(el.id); }}
            />
          );
        }

        // 文本元素
        const rawContent = getTextContent(text, el.textRole || 'title', el.placeholder, el.fixedText);
        const showContent = rawContent || (editable ? (el.placeholder || el.name) : '');
        const ts = el.textStyle || {};
        const anim = applyEntranceAnim(el.entranceAnim, frame, showContent, opacity);
        return (
          <div
            key={el.id}
            className={`canvas-el text-el ${isSelected ? 'selected' : ''}`}
            style={{
              ...commonStyle,
              opacity: anim.opacity,
              filter: anim.blur > 0 && minDim > 0 ? `blur(${anim.blur * minDim}px)` : undefined,
              // 与 CustomTemplateRender 文本元素一致：无 perspective/rotateX/rotateY（3D 旋转仅视频元素支持）
              transform: `rotateZ(${rotation + anim.rotateDeg}deg) translate(${anim.tx * cw}px, ${anim.ty * ch}px) scale(${scale * anim.scaleMul})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              cursor: editable ? 'move' : 'default',
              border: editable ? '1px dashed transparent' : undefined,
            }}
            onMouseDown={(e) => handleMouseDown(e, el)}
            onClick={(e) => { e.stopPropagation(); onSelect?.(el.id); }}
          >
            <span style={{
              fontSize: ts.fontSize ?? 28,
              fontWeight: ts.fontWeight ?? 700,
              color: ts.color ?? '#111827',
              fontStyle: ts.fontStyle,
              textDecoration: ts.textDecoration,
              ...textStrokeCss(ts),
            }}>
              {anim.content || (editable ? `${el.name}（空）` : '')}
            </span>
          </div>
        );
      })}

      {/* 运动路径：选中元素关键帧连线 */}
      {motionPts.length > 0 && (
        <>
          <svg className="ct-motion-line" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polyline
              points={motionPts.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="none" stroke="#89b4fa" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeDasharray="4 3"
            />
          </svg>
          {motionPts.map((p, i) => (
            <div key={i} className="ct-motion-dot" style={{left: `${p.x * 100}%`, top: `${p.y * 100}%`}} />
          ))}
        </>
      )}

      {/* 安全区引导线（动作安全 93% / 标题安全 90%） */}
      {editable && showSafeArea && (
        <>
          <div className="ct-safe action-safe" />
          <div className="ct-safe title-safe" />
        </>
      )}
    </div>
  );
};

export default CustomTemplateCanvas;

/**
 * CustomTemplatePreviewPlayer - 故事板片段预览用
 * 自动驱动 frame 播放 CustomTemplateCanvas，支持循环/重播。
 */
const PREVIEW_FPS = 30;

export const CustomTemplatePreviewPlayer: React.FC<{
  def: CustomTemplateDef;
  videos?: VideoClip[];
  text?: PromoText;
  duration: number;
  loop?: boolean;
  aspectRatioId?: string;
  /** 模板参数当前值（Segment.customParams），驱动 paramBindings */
  params?: Record<string, number>;
}> = ({def, videos, text, duration, loop = false, aspectRatioId, params}) => {
  const totalFrames = Math.round(duration * PREVIEW_FPS);
  const [frame, setFrame] = useState(0);
  const [replayKey, setReplayKey] = useState(0);

  useEffect(() => {
    setFrame(0);
    let raf = 0;
    let startTs = 0;
    const animate = (ts: number) => {
      if (!startTs) startTs = ts;
      const elapsedSec = (ts - startTs) / 1000;
      const f = Math.floor(elapsedSec * PREVIEW_FPS);
      if (f >= totalFrames) {
        if (loop) {
          startTs = ts;
          setFrame(0);
          raf = requestAnimationFrame(animate);
        }
        return;
      }
      setFrame(f);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [duration, loop, replayKey, totalFrames]);

  return (
    <div className="preview-player-container" key={replayKey}>
      <CustomTemplateCanvas
        def={def}
        frame={frame}
        totalFrames={totalFrames}
        aspectRatioId={aspectRatioId}
        videos={videos}
        text={text}
        params={params}
      />
      <button
        className="preview-replay-btn"
        onClick={() => setReplayKey((k) => k + 1)}
        title="重播"
      >
        <RotateCw size={16} />
      </button>
    </div>
  );
};
