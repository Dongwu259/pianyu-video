/**
 * TextureLayer - 全局质感层
 *
 * 叠加在全片最上层（字幕之上、水印之下）的静态效果组，让画面从「干净的平面」
 * 变成「视频」：暗角（vignette）+ 胶片颗粒（film grain）+ 上下压暗 + 可选扫柔光。
 * 三档预设（干净/胶片/电影）参数在 shared/texture-presets.ts；工程级开关。
 *
 * 实现要点：
 * - 颗粒：程序化生成 128×128 噪点平铺贴图（canvas，固定种子保证各渲染进程一致），
 *   每帧按伪随机哈希跳动 background-position，overlay 混合 —— 无需任何素材文件。
 * - 扫柔光（light leak）：两个大块径向渐变缓慢漂移，screen 混合，仅「电影」档。
 * - 全部 pointerEvents: none，不影响交互；预览（Player）与导出（render）同源。
 */

import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import type {TexturePreset} from '../../shared/types';
import {TEXTURE_PARAMS, isTextureEmpty} from '../../shared/texture-presets';

/** 确定性伪随机（mulberry32）：噪点贴图在所有渲染进程里生成结果一致 */
const seededRand = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 每帧颗粒跳动的位置哈希（0..1，帧间无关 = 颗粒闪烁感） */
const frameHash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const TILE = 128;

/** 生成噪点平铺贴图（data URL）；单色灰噪 + 随机 alpha，供 overlay 混合 */
const makeGrainTile = (): string => {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(TILE, TILE);
  const rand = seededRand(20260808);
  for (let i = 0; i < img.data.length; i += 4) {
    const g = Math.floor(rand() * 255);
    img.data[i] = g;
    img.data[i + 1] = g;
    img.data[i + 2] = g;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
};

export const TextureLayer: React.FC<{preset: TexturePreset}> = ({preset}) => {
  const params = TEXTURE_PARAMS[preset] ?? TEXTURE_PARAMS.clean;
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const grainTile = useMemo(() => (params.grain > 0 ? makeGrainTile() : ''), [params.grain]);

  if (isTextureEmpty(params)) return null;

  // 颗粒平铺偏移：每帧跳到伪随机位置（闪烁感），取整避免亚像素模糊
  const ox = Math.floor(frameHash(frame) * TILE);
  const oy = Math.floor(frameHash(frame + 0.5) * TILE);

  // 扫柔光位置：两个不同相位的缓动漂移（0..1 全片周期）
  const t = durationInFrames > 1 ? frame / durationInFrames : 0;
  const leak1x = 18 + 26 * Math.sin(t * Math.PI * 2);
  const leak1y = 24 + 14 * Math.cos(t * Math.PI * 2 * 0.7);
  const leak2x = 82 - 22 * Math.sin(t * Math.PI * 2 * 0.6 + 1.3);
  const leak2y = 70 + 16 * Math.sin(t * Math.PI * 2 * 0.9 + 2.1);

  return (
    <AbsoluteFill style={{pointerEvents: 'none', zIndex: 500}}>
      {/* 上下压暗（胶片暗部压边） */}
      {params.tone > 0 && (
        <AbsoluteFill
          style={{
            background: `linear-gradient(to bottom, rgba(0,0,0,${params.tone}) 0%, transparent 16%, transparent 84%, rgba(0,0,0,${params.tone}) 100%)`,
          }}
        />
      )}
      {/* 暗角 */}
      {params.vignette > 0 && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse 108% 108% at 50% 50%, transparent 52%, rgba(0,0,0,${params.vignette * 0.55}) 78%, rgba(0,0,0,${params.vignette}) 100%)`,
          }}
        />
      )}
      {/* 扫柔光（仅 cinema 档）：暖橙 + 冷紫两块缓慢漂移的柔光 */}
      {params.lightLeak && (
        <>
          <AbsoluteFill
            style={{
              background: `radial-gradient(ellipse 46% 46% at ${leak1x}% ${leak1y}%, rgba(255,128,48,0.30) 0%, transparent 70%)`,
              mixBlendMode: 'screen',
            }}
          />
          <AbsoluteFill
            style={{
              background: `radial-gradient(ellipse 40% 40% at ${leak2x}% ${leak2y}%, rgba(120,90,255,0.24) 0%, transparent 70%)`,
              mixBlendMode: 'screen',
            }}
          />
        </>
      )}
      {/* 胶片颗粒（噪点平铺，逐帧跳动，overlay 混合） */}
      {params.grain > 0 && grainTile && (
        <AbsoluteFill
          style={{
            backgroundImage: `url(${grainTile})`,
            backgroundRepeat: 'repeat',
            backgroundPosition: `${ox}px ${oy}px`,
            opacity: params.grain,
            mixBlendMode: 'overlay',
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default TextureLayer;
