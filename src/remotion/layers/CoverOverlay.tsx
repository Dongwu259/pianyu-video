/**
 * 封面覆盖层：在所选帧画面上叠加自由文字图层（字体/描边/3D 挤出/旋转/底色条/主体遮挡）。
 *
 * 无 Remotion 依赖——既被 CoverComp（导出渲染合成）使用，也被封面设计
 * 面板的实时预览直接使用，保证所见即所得。所有尺寸按 1920 基准宽等比缩放。
 *
 * 主体遮挡：behind=true 的图层渲染进一个套用主体 mask 的整幅容器（mask 坐标与
 * 画布对齐；主体区域透明 → 文字被「挡」在主体后面，形成前后遮挡关系）。
 */

import React from 'react';
import type {CoverConfig, CoverTextLayer} from '../../shared/types';
import {fontById} from '../../shared/cover-presets';

interface CoverOverlayProps {
  canvasW: number;
  canvasH: number;
  cover: CoverConfig;
  /** 主体遮挡 mask（PNG data URL；主体区域透明、其余不透明）。无 mask 时 behind 层按普通层渲染 */
  subjectMask?: string;
}

const SCRIM_BY_STYLE: Record<CoverConfig['scrimStyle'], (a: number) => React.CSSProperties> = {
  bottom: (a) => ({
    background: `linear-gradient(180deg, rgba(0,0,0,0) 42%, rgba(0,0,0,${a}) 100%)`,
  }),
  full: (a) => ({
    background: `linear-gradient(180deg, rgba(0,0,0,${a * 0.52}) 0%, rgba(0,0,0,${a * 0.68}) 100%)`,
  }),
  left: (a) => ({
    background: `linear-gradient(90deg, rgba(0,0,0,${a}) 0%, rgba(0,0,0,${a * 0.55}) 34%, rgba(0,0,0,0) 72%)`,
  }),
  top: (a) => ({
    background: `linear-gradient(180deg, rgba(0,0,0,${a}) 0%, rgba(0,0,0,0) 50%)`,
  }),
  none: () => ({}),
};

/** 文字阴影：3D 挤出按角度堆叠像素步进；末尾恒带一层柔和投影保证任意底上的可读性 */
const textShadowFor = (layer: CoverTextLayer, u: number): string => {
  const shadows: string[] = [];
  const depth = Math.round(layer.depth * u);
  if (depth > 0) {
    const rad = (layer.angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    // 挤出越深步进越粗（远处的侧面允许出现断层，模拟立体块面）
    const step = depth > 24 ? 2 : 1;
    for (let i = 1; i <= depth; i += step) {
      shadows.push(`${(dx * i).toFixed(1)}px ${(dy * i).toFixed(1)}px 0 ${layer.sideColor}`);
    }
  }
  shadows.push(`0 ${Math.round(3 * u)}px ${Math.round(16 * u)}px rgba(0,0,0,0.45)`);
  return shadows.join(', ');
};

const translateFor = (align: CoverTextLayer['align']): string =>
  align === 'left' ? '0, -50%' : align === 'right' ? '-100%, -50%' : '-50%, -50%';

const renderLayer = (layer: CoverTextLayer, key: string, canvasW: number): React.ReactNode => {
  const u = canvasW / 1920;
  const font = fontById(layer.font);
  const size = Math.round(layer.size * u);
  const text = layer.text.trim();
  if (!text && !layer.chipColor) return null;

  const outerStyle: React.CSSProperties = {
    position: 'absolute',
    left: `${layer.x * 100}%`,
    top: `${layer.y * 100}%`,
    transform: `translate(${translateFor(layer.align)}) rotate(${layer.rotation}deg)`,
    // 显式宽度：绝对定位元素默认 shrink-to-fit，可用宽度会被「锚点到画布边缘」截断
    // （居中锚点只剩半幅），长标题会被误折行；固定 0.92W 后由 textAlign 控制对齐
    width: canvasW * 0.92,
    textAlign: layer.align,
    pointerEvents: 'none',
  };
  const textStyle: React.CSSProperties = {
    display: layer.chipColor ? 'inline-block' : 'block',
    fontFamily: font.family,
    fontWeight: font.weight,
    fontSize: size,
    lineHeight: 1.25,
    color: layer.color,
    whiteSpace: 'pre-wrap',
    textShadow: textShadowFor(layer, u),
    ...(layer.strokeWidth > 0 && layer.strokeColor
      ? {WebkitTextStroke: `${(layer.strokeWidth * u).toFixed(2)}px ${layer.strokeColor}`}
      : {}),
    ...(layer.chipColor
      ? {
          background: layer.chipColor,
          padding: `${Math.round(size * 0.22)}px ${Math.round(size * 0.52)}px`,
          borderRadius: 999,
          boxShadow: `0 ${Math.round(4 * u)}px ${Math.round(14 * u)}px rgba(0,0,0,0.35)`,
        }
      : {}),
  };
  return (
    <div key={key} style={outerStyle}>
      <span style={textStyle}>{text || ' '}</span>
    </div>
  );
};

export const CoverOverlay: React.FC<CoverOverlayProps> = ({canvasW, cover, subjectMask}) => {
  const {scrim, scrimStyle, layers} = cover;
  const maskReady = Boolean(subjectMask);
  const behindLayers = layers.filter((l) => l.behind && maskReady);
  const frontLayers = layers.filter((l) => !l.behind || !maskReady);

  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none'}}>
      {/* 遮罩层（压暗所选帧，保证文字可读） */}
      <div style={{position: 'absolute', inset: 0, ...SCRIM_BY_STYLE[scrimStyle](scrim)}} />
      {/* 被主体遮挡的图层：整幅容器套主体 mask（主体区域透明 = 文字被挡在后面） */}
      {behindLayers.length > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            maskImage: `url(${subjectMask})`,
            WebkitMaskImage: `url(${subjectMask})`,
            maskSize: '100% 100%',
            WebkitMaskSize: '100% 100%',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
          }}
        >
          {behindLayers.map((l, i) => renderLayer(l, `behind-${l.id}-${i}`, canvasW))}
        </div>
      )}
      {/* 前景图层 */}
      {frontLayers.map((l, i) => renderLayer(l, `front-${l.id}-${i}`, canvasW))}
    </div>
  );
};
