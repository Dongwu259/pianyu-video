/**
 * 视频画布特效 - 作用于视频框本身的视觉特效（非背景）。
 *
 * 由 VideoEffectContext 注入当前片段的特效类型，Video3D / CustomTemplateRender 消费：
 * - getVideoEffectStyle: 返回加在视频框上的 CSS filter / 额外 transform（故障色相跳变、抖动、模糊脉冲等）。
 * - VideoEffectOverlay: 覆盖在视频框上的覆盖层（扫描线/墨汁/颗粒/暗角/撕裂），由视频框 overflow:hidden 裁切。
 *
 * 每帧用确定性伪随机（基于 frame）驱动动画，预览(Player)与最终渲染一致（WYSIWYG）。
 */
import React, {createContext, useContext} from 'react';
import {useVideoConfig} from 'remotion';
import type {VideoEffect} from '../../shared/types';
import {easeOutCubic, inkDripPath, rand, smoothOpenPath} from '../utils/ink';
import type {RippleSpec} from '../utils/clickRipples';

/** 当前片段的视频特效，由 MultiSegmentPromo / 预览 wrapper 通过 Provider 注入。 */
export const VideoEffectContext = createContext<VideoEffect>('none');

/** 美化光标总开关（项目级），由 MultiSegmentPromo 通过 Provider 注入；Video3D 消费。 */
export const CursorContext = createContext<boolean>(true);

/** 便捷 Hook：取当前片段的视频特效。 */
export const useVideoEffect = (): VideoEffect => useContext(VideoEffectContext);

/**
 * 计算视频框的 filter / 额外 transform。
 * 调用方把 transform 追加到视频框已有 transform 之后，filter 设到视频框。
 */
export const getVideoEffectStyle = (
  effect: VideoEffect | undefined,
  frame: number,
): {filter?: string; transform?: string} => {
  if (!effect || effect === 'none') return {};
  switch (effect) {
    case 'glitch': {
      // 电磁干扰：约 28% 的帧进入强故障爆发，其余帧轻微强化
      const burst = rand(frame * 0.7) > 0.72;
      const filter = burst
        ? `hue-rotate(${rand(frame * 1.3) * 360}deg) contrast(${1.4 + rand(frame * 2.1) * 0.6}) saturate(${1.5 + rand(frame * 3.7)}) brightness(${1 + (rand(frame * 5) - 0.5) * 0.4})`
        : 'contrast(1.05) saturate(1.1)';
      const jx = (rand(frame * 3.3) - 0.5) * (burst ? 12 : 2);
      const jy = (rand(frame * 5.1) - 0.5) * (burst ? 6 : 1);
      return {filter, transform: `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px)`};
    }
    case 'shake': {
      const jx = (rand(frame * 1.7) - 0.5) * 10;
      const jy = (rand(frame * 2.3) - 0.5) * 10;
      const r = (rand(frame * 3.1) - 0.5) * 0.7;
      return {transform: `translate(${jx.toFixed(1)}px, ${jy.toFixed(1)}px) rotate(${r.toFixed(2)}deg)`};
    }
    case 'vintage':
      return {filter: 'sepia(0.45) contrast(1.12) brightness(0.96) saturate(0.82)'};
    case 'blurPulse': {
      const b = (Math.sin(frame * 0.12) * 0.5 + 0.5) * 6;
      return {filter: `blur(${b.toFixed(2)}px)`};
    }
    case 'scanlines':
    case 'inkDrip':
    default:
      return {};
  }
};

// SVG 噪声纹理（老电影颗粒），feTurbulence 生成 + 去饱和；用 background-position 每帧偏移产生动态颗粒。
const GRAIN_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

/**
 * 墨汁滴落覆盖层：顶部波浪墨缘 + 有机滴柱（横向摆动、尖端垂滴、先快后慢、收尾淡出）。
 * 每滴独立循环，每轮换新摆动种子。SVG 0..100 坐标拉伸填满视频框，由父级 overflow:hidden 裁切。
 */
const InkDripOverlay: React.FC<{frame: number}> = ({frame}) => {
  const {width, height} = useVideoConfig();
  const aspect = width / height; // 近似：视频框通常接近画布比例，仅用于尖端凸头圆度补偿
  const drips = Array.from({length: 6}, (_, i) => {
    const cycle = 200 + rand(i * 12.7) * 90;
    const phase = rand(i * 6.9) * cycle;
    const t = (frame + phase) % cycle;
    const curCycle = Math.floor((frame + phase) / cycle);
    const prog = Math.min(1, t / (cycle * 0.45));
    const fadeStart = cycle * 0.85;
    return {
      x: 5 + (i / 6) * 92 + rand(i * 9.1) * 6,
      w: 0.5 + rand(i * 5.3) * 0.7,
      len: easeOutCubic(prog) * (30 + rand(i * 3.7) * 45),
      op:
        (t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / (cycle - fadeStart)) : 1) * (0.5 + rand(i * 6.1) * 0.3),
      seed: i * 21.7 + curCycle * 77.3,
    };
  });
  // 顶部墨缘：波浪底边 + 每滴根部隆起
  const bandPts: {x: number; y: number}[] = [];
  for (let x = -4; x <= 104; x += 3) {
    let y = 2.4 + Math.sin(x * 0.29) * 0.5 + rand(x * 1.9) * 0.8;
    for (const d of drips) {
      y += (1.1 + d.w * 2.2) * Math.exp(-((x - d.x) * (x - d.x)) / 5.8);
    }
    bandPts.push({x, y: Math.min(y, 12)});
  }
  const bandPath = `${smoothOpenPath(bandPts)} L 104,-4 L -4,-4 Z`;
  return (
    <>
      {/* 两角洇开的墨渍 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '34%',
          height: '26%',
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse at 0% 0%, rgba(15,10,20,0.5), transparent 70%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          width: '34%',
          height: '26%',
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse at 100% 0%, rgba(15,10,20,0.5), transparent 70%)',
        }}
      />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', filter: 'blur(0.4px)', pointerEvents: 'none'}}
      >
        <defs>
          <linearGradient id="video-inkdrip-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(15,10,20,0.92)" />
            <stop offset="1" stopColor="rgba(15,10,20,0.55)" />
          </linearGradient>
        </defs>
        <path d={bandPath} fill="url(#video-inkdrip-band)" />
        {drips.map((d, i) =>
          d.len > 0.6 && d.op > 0.01 ? (
            <path key={i} d={inkDripPath(d.x, d.len, d.w, d.seed, aspect)} fill={`rgba(15,10,20,${d.op.toFixed(3)})`} />
          ) : null,
        )}
      </svg>
    </>
  );
};

/**
 * 点击水波覆盖层：每次点击扩散三层错开圆环 + 中心闪点。
 * ripples 由 Video3D / CustomTemplateRender 用 computeClickRipples 换算好（画框 px 坐标）。
 * 白芯圆环 + 淡青辉光，深浅画面上都可读；div 边框圆环（非 SVG），不受画框比例拉伸。
 */
const RIPPLE_RINGS = [
  {delay: 0, dur: 700},
  {delay: 110, dur: 700},
  {delay: 220, dur: 700},
] as const;

const ClickRipples: React.FC<{ripples: RippleSpec[]}> = ({ripples}) => (
  <>
    {ripples.map((r, i) => (
      <React.Fragment key={i}>
        {/* 中心闪点：点击瞬间的落点提示，快速衰减 */}
        {r.dtMs < 180 && (
          <div
            style={{
              position: 'absolute',
              left: r.x,
              top: r.y,
              width: 10 * r.scale,
              height: 10 * r.scale,
              borderRadius: '50%',
              background: `rgba(255,255,255,${(0.9 * (1 - r.dtMs / 180)).toFixed(3)})`,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
            }}
          />
        )}
        {RIPPLE_RINGS.map((ring, j) => {
          const q = (r.dtMs - ring.delay) / ring.dur;
          if (q < 0 || q > 1) return null;
          const radius = (6 + 58 * easeOutCubic(q)) * r.scale;
          const alpha = 0.8 * (1 - q);
          return (
            <div
              key={j}
              style={{
                position: 'absolute',
                left: r.x,
                top: r.y,
                width: radius * 2,
                height: radius * 2,
                borderRadius: '50%',
                border: `${Math.max(1.5, 2.5 * r.scale)}px solid rgba(255,255,255,${alpha.toFixed(3)})`,
                boxShadow: `0 0 ${12 * r.scale}px rgba(120,200,255,${(alpha * 0.55).toFixed(3)}), inset 0 0 ${8 * r.scale}px rgba(120,200,255,${(alpha * 0.3).toFixed(3)})`,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
              }}
            />
          );
        })}
      </React.Fragment>
    ))}
  </>
);

/**
 * 视频框覆盖层。绝对定位填满父级（视频框），由父级 overflow:hidden 裁切。
 * 放在视频媒体之上（兄弟节点，后渲染）。
 * ripples 仅供 clickRipple 特效消费（调用方用 computeClickRipples 换算）。
 */
export const VideoEffectOverlay: React.FC<{effect: VideoEffect | undefined; frame: number; ripples?: RippleSpec[]}> = ({effect, frame, ripples}) => {
  if (!effect || effect === 'none') return null;

  if (effect === 'clickRipple') {
    return ripples && ripples.length > 0 ? <ClickRipples ripples={ripples} /> : null;
  }

  if (effect === 'scanlines') {
    const flicker = 0.85 + rand(frame * 1.9) * 0.15;
    return (
      <>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 3px)',
            opacity: flicker,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'rgba(50,255,180,0.04)',
            mixBlendMode: 'screen',
          }}
        />
      </>
    );
  }

  if (effect === 'glitch') {
    // 扫描线 + 随机水平撕裂条（红/青偏移）
    const bars = Array.from({length: 4}, (_, i) => {
      const show = rand(frame * 0.9 + i * 4.1) > 0.6;
      if (!show) return null;
      const y = rand(frame * 1.7 + i * 7.3) * 100;
      const h = 2 + rand(frame * 2.1 + i * 3.3) * 8;
      const dx = (rand(frame * 4.4 + i * 2.7) - 0.5) * 30;
      const color = i % 2 === 0 ? 'rgba(255,40,80,0.5)' : 'rgba(40,255,220,0.5)';
      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: `${y}%`,
            height: `${h}px`,
            transform: `translateX(${dx.toFixed(1)}px)`,
            background: color,
            mixBlendMode: 'screen',
            pointerEvents: 'none',
          }}
        />
      );
    });
    return (
      <>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 4px)',
          }}
        />
        {bars}
      </>
    );
  }

  if (effect === 'inkDrip') {
    return <InkDripOverlay frame={frame} />;
  }

  if (effect === 'vintage') {
    const flicker = 0.92 + rand(frame * 2.3) * 0.08;
    const scratches = Array.from({length: 2}, (_, i) => {
      const show = rand(frame * 0.5 + i * 6.1) > 0.85;
      if (!show) return null;
      const x = rand(frame * 3.3 + i * 9.7) * 100;
      return (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${x}%`,
            width: '1px',
            background: 'rgba(255,255,255,0.5)',
            pointerEvents: 'none',
          }}
        />
      );
    });
    return (
      <>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: `url("${GRAIN_URL}")`,
            backgroundSize: '160px 160px',
            backgroundPosition: `${(frame * 3) % 160}px ${(frame * 5) % 160}px`,
            mixBlendMode: 'overlay',
            opacity: 0.4 * flicker,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
          }}
        />
        {scratches}
      </>
    );
  }

  // shake / blurPulse: 无覆盖层
  return null;
};
