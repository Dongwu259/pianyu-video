/**
 * TurntableModel - .glb 模型加载与展示（3D 旋转展示台核心）
 *
 * - useGLTF(src, false)：关 draco——drei 默认从 CDN 拉 decoder，headless 渲染不可靠；
 *   因此只支持未压缩 glb（draco/meshopt 压缩的模型请先用 gltf-transform 解压）
 * - 包围盒归一化：居中 x/z + 底面落到 y=0 + 缩放到目标尺寸（模型来源尺度千差万别）
 * - 动画（P1-5）：模型自带动画轨道时播放第一个 clip，mixer.setTime(帧/30) 绝对时间驱动
 *   ——确定性铁律，禁 clock delta；无动画时退化为旋转台自转
 * - Suspense 加载由 @remotion/three ThreeCanvas 的 SuspenseLoader 兜住（delayRender），
 *   加载未完成不会渲出空场景
 */
import React, {useEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useFrame} from '@react-three/fiber';
import {useGLTF, useAnimations} from '@react-three/drei';
import {useCurrentFrame} from 'remotion';

interface TurntableModelProps {
  src: string;
  /** 目标最大边长（three 世界单位，包围盒归一化） */
  size?: number;
  /** 无自带动画时的旋转台周期（秒/圈） */
  periodSec?: number;
  /** 旋转台速度倍率（0 = 不转；自带动画的模型忽略） */
  spinSpeed?: number;
}

export const TurntableModel: React.FC<TurntableModelProps> = ({src, size = 2.8, periodSec = 9, spinSpeed = 1}) => {
  const group = useRef<THREE.Group>(null);
  const gltf = useGLTF(src, false);
  const {actions, mixer, names} = useAnimations(gltf.animations, group);

  // 包围盒归一化（只算一次）：x/z 居中、底面落 y=0、最大边缩到 size
  const norm = useMemo(() => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    const dims = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(dims.x, dims.y, dims.z) || 1;
    const scale = size / maxDim;
    return {scale, x: -center.x * scale, y: -box.min.y * scale, z: -center.z * scale};
  }, [gltf.scene, size]);

  const hasAnim = names.length > 0;
  useEffect(() => {
    const first = names[0];
    if (first && actions[first]) actions[first]!.play();
  }, [actions, names]);

  const frame = useCurrentFrame();
  useFrame(() => {
    const t = frame / 30; // FPS=30 全链路硬编码（remotion/config/resolutions.ts）
    if (hasAnim) {
      const clip = gltf.animations[0];
      mixer.setTime(clip && clip.duration > 0 ? t % clip.duration : t);
    } else if (group.current && spinSpeed > 0) {
      group.current.rotation.y = (t * spinSpeed * (Math.PI * 2)) / periodSec;
    }
  });

  return (
    <group ref={group}>
      <primitive object={gltf.scene} scale={norm.scale} position={[norm.x, norm.y, norm.z]} />
    </group>
  );
};
