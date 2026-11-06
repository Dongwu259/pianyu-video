/**
 * useImagePanelTexture - 图片素材作为 three.js 展板纹理（3D 场景模板共用）
 *
 * CanvasTexture + cover 裁切（与 VideoScreenTexture drawCover 同算法/同哲学）：
 * 加载经 delayRender 等齐（首帧不空板）；失败保留深色板面不击穿渲染。
 * 从 CameraJourney3D 抽出（GalleryHall3D/OrbitCarousel3D/TimeTunnel3D 同款展板复用）。
 *
 * v27 自愈（关键，与 VideoScreenTexture 同款双件套）：
 * - Bridge + advance()：demand 渲染模式下，异步 onload 完成时当帧可能已经渲过一次
 *   （截图拿到的是没贴纹理的旧帧→整段黑板，实测按标签整块出现）。drawCover 后
 *   必须像 VideoScreenTexture 一样 advance() 强制重渲一次。
 * - 每帧重绘 + 加载重试：Chromium 在 GPU 压力下会丢加速 2D 画布的后备存储；模块级
 *   缓存 HTMLImageElement，每帧从缓存重绘画布再上传，加载失败不固化、逐帧重试。
 * 已试败方案（留档）：DataTexture/HTMLImageElement 直连无 canvas 中转——three 对
 * img 纹理的 seek 期上传更不稳，黑板率反而翻倍，勿回退。
 */
import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import * as THREE from 'three';
import {useCurrentFrame, useDelayRender} from 'remotion';
import {useThree} from '@react-three/fiber';

/** 模块级图片缓存（页面存续期内跨帧/跨实例共享；onload 后才算命中） */
const imageCache = new Map<string, HTMLImageElement>();

export interface ImagePanelTextureApi {
  texture: THREE.CanvasTexture;
  /** 挂到 ThreeCanvas 子树内（把 fiber advance 桥出来，纹理更新后强制重渲） */
  Bridge: React.FC;
}

export const useImagePanelTexture = (src: string | undefined, planeW: number, planeH: number): ImagePanelTextureApi => {
  const {delayRender, continueRender} = useDelayRender();
  const [stuff] = useState(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#0B101B';
    context.fillRect(0, 0, 2, 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return {canvas, context, texture};
  });
  const loadedRef = useRef(false);
  const pendingRef = useRef(false);

  // three 侧桥接回来的渲染控制（Bridge 组件挂载后填充），同 VideoScreenTexture
  const advanceRef = useRef<((ts: number) => void) | null>(null);
  const Bridge = useMemo(() => {
    const ImageTextureBridge: React.FC = () => {
      const {advance} = useThree();
      React.useEffect(() => {
        advanceRef.current = advance;
      }, [advance]);
      return null;
    };
    return ImageTextureBridge;
  }, []);

  const drawCover = (img: HTMLImageElement): void => {
    const vw = img.naturalWidth || 16;
    const vh = img.naturalHeight || 9;
    // cover：居中裁切到板面宽高比
    const targetAspect = planeW / planeH;
    const srcAspect = vw / vh;
    let sw = vw;
    let sh = vh;
    let sx = 0;
    let sy = 0;
    if (srcAspect > targetAspect) {
      sw = vh * targetAspect;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / targetAspect;
      sy = (vh - sh) / 2;
    }
    const scale = Math.min(1, 1600 / Math.max(vw, vh));
    stuff.canvas.width = Math.max(2, Math.round(vw * scale));
    stuff.canvas.height = Math.max(2, Math.round(vh * scale));
    stuff.context.drawImage(img, sx, sy, sw, sh, 0, 0, stuff.canvas.width, stuff.canvas.height);
    stuff.texture.needsUpdate = true;
    // 纹理更新后同步重渲：截图可能已经用过「没贴纹理」的旧帧（黑板根因）
    advanceRef.current?.(performance.now());
  };

  // 每帧自检：已加载 → 从缓存 Image 重绘（Chromium 会丢加速画布后备存储，必须每帧重绘）
  // 未加载 → （重）试加载，失败不固化
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    if (!src) return;
    const cached = imageCache.get(src);
    if (cached) {
      loadedRef.current = true;
      drawCover(cached);
      return;
    }
    if (pendingRef.current) return;
    pendingRef.current = true;
    const handle = delayRender('3D 展板: 加载图片纹理');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      pendingRef.current = false;
      imageCache.set(src, img);
      loadedRef.current = true;
      drawCover(img);
      continueRender(handle);
    };
    img.onerror = () => {
      // 失败不固化：下一帧自检会再次尝试（重试直到成功，深色板面兜底）
      pendingRef.current = false;
      continueRender(handle);
    };
    img.src = src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, src, stuff, planeW, planeH]);

  return {texture: stuff.texture, Bridge};
};
