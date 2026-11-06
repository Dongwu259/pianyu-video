/**
 * 特效调试合成（EffectLab）- 仅开发调试用，不参与正式渲染。
 *
 * 用 remotion CLI 直接截单个特效的静帧，便于脱离完整模板快速迭代视觉效果：
 *   npx remotion still src/remotion/root.tsx EffectLab out.png \
 *     --frame 90 --props '{"kind":"background","effect":"inkWash"}'
 *
 * kind=background: 整幅渲染 BackgroundEffectLayer（背景特效）。
 * kind=video:      深色场景 + 模拟录屏内容的画框，画框内叠加 VideoEffectOverlay（画布特效）。
 * kind=three:      three.js WebGL 冒烟场景（旋转立方体），验证 headless GL 渲染管线：
 *   npx remotion render <bundle> EffectLab out.mp4 --frames 0-45 --props '{"kind":"three","effect":""}'
 */
import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {ThreeCanvas} from '@remotion/three';
import {BackgroundEffectContext, BackgroundEffectLayer} from './backgroundEffects';
import {VideoEffectOverlay} from './videoEffects';
import type {BackgroundEffect, VideoEffect} from '../../shared/types';

export interface EffectLabProps {
  kind: 'background' | 'video' | 'three';
  effect: string;
}

/** three.js 冒烟场景：纯帧驱动旋转立方体（禁 Clock/delta，逐帧渲染确定性铁律）。 */
const ThreeSmokeInner: React.FC = () => {
  const frame = useCurrentFrame();
  const rot = (frame / 30) * Math.PI * 0.5;
  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[4, 6, 8]} intensity={1.6} />
      <mesh rotation={[rot * 0.6, rot, 0]}>
        <boxGeometry args={[2.6, 2.6, 2.6]} />
        <meshStandardMaterial color="#2563EB" roughness={0.35} metalness={0.4} />
      </mesh>
    </>
  );
};

/** 模拟录屏内容：窗口栏 + 色块 + 文本行，让画布特效有参照物。 */
const MockScreen: React.FC = () => (
  <AbsoluteFill style={{background: 'linear-gradient(135deg, #1c2733 0%, #243447 60%, #2b3f57 100%)'}}>
    <div style={{height: 44, background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px'}}>
      {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
        <div key={c} style={{width: 14, height: 14, borderRadius: '50%', background: c}} />
      ))}
    </div>
    <div style={{display: 'flex', gap: 24, padding: 32}}>
      <div style={{flex: 1, display: 'flex', flexDirection: 'column', gap: 16}}>
        {[70, 92, 55, 80, 64].map((w, i) => (
          <div key={i} style={{width: `${w}%`, height: 18, borderRadius: 6, background: `rgba(${120 + i * 20},${180 - i * 10},255,0.35)`}} />
        ))}
      </div>
      <div style={{width: '32%', borderRadius: 12, background: 'linear-gradient(160deg, rgba(90,140,250,0.5), rgba(160,90,250,0.4))'}} />
    </div>
  </AbsoluteFill>
);

export const EffectLab: React.FC<EffectLabProps> = ({kind, effect}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();

  if (kind === 'three') {
    return (
      <AbsoluteFill style={{background: '#0B0F14'}}>
        <ThreeCanvas width={width} height={height} camera={{position: [0, 0, 6.5], fov: 45}}>
          <ThreeSmokeInner />
        </ThreeCanvas>
      </AbsoluteFill>
    );
  }

  if (kind === 'video') {
    // 点击水波演示数据：两处固定位置按 1.2s 周期交错扩散（30fps 每帧 ≈ 33.3ms）
    const demoRipples =
      effect === 'clickRipple'
        ? [
            {x: 420, y: 300, dtMs: (frame * 33.3) % 1200, scale: 1},
            {x: 860, y: 480, dtMs: (frame * 33.3 + 600) % 1200, scale: 1},
          ]
        : undefined;
    return (
      <AbsoluteFill style={{background: '#3a3f4a', justifyContent: 'center', alignItems: 'center'}}>
        <div style={{position: 'relative', width: 1280, height: 720, overflow: 'hidden', borderRadius: 12}}>
          <MockScreen />
          <VideoEffectOverlay effect={effect as VideoEffect} frame={frame} ripples={demoRipples} />
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{background: '#999'}}>
      <BackgroundEffectContext.Provider value={effect as BackgroundEffect}>
        <BackgroundEffectLayer />
      </BackgroundEffectContext.Provider>
    </AbsoluteFill>
  );
};
