/**
 * ThreeAmbience - 3D 氛围层（粒子场 / 光锥 / 雾），内置于 3D 模板
 *
 * 确定性：粒子初始位置用固定种子的线性同余伪随机（与模板/帧号无关），
 * 漂浮运动全部 useCurrentFrame() 驱动 —— 逐帧渲染可复现。
 *
 * 档位：level 0 关 / 1 弱 / 2 中 / 3 强（模板参数档位滑块接入）。
 */
import React, {useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useFrame, useThree} from '@react-three/fiber';
import {useCurrentFrame} from 'remotion';

/** 固定种子伪随机（确定性，不依赖 Math.random） */
const seededRand = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const PARTICLE_COUNT = [0, 90, 180, 320];

const Particles: React.FC<{count: number; color: string; spread: number; centerXZ?: [number, number]}> = ({count, color, spread, centerXZ}) => {
  const frame = useCurrentFrame();
  const ref = useRef<THREE.Points>(null);

  const basePositions = useMemo(() => {
    const [cx, cz] = centerXZ ?? [0, -2];
    const rand = seededRand(20260906);
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = cx + (rand() - 0.5) * spread * 2;
      arr[i * 3 + 1] = (rand() - 0.5) * spread * 1.2;
      arr[i * 3 + 2] = cz + (rand() - 0.5) * spread;
    }
    return arr;
  }, [count, spread, centerXZ]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(basePositions.slice(), 3));
    return g;
  }, [basePositions]);

  useFrame(() => {
    const pts = ref.current;
    if (!pts) return;
    const pos = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const t = frame / 30;
    // 缓慢上浮 + 横向正弦漂移（帧驱动，确定性）
    for (let i = 0; i < count; i++) {
      const bx = basePositions[i * 3];
      const by = basePositions[i * 3 + 1];
      pos.setX(i, bx + Math.sin(t * 0.35 + i * 1.7) * 0.25);
      pos.setY(i, by + Math.sin(t * 0.22 + i * 0.9) * 0.35 + ((t * 0.12 + i * 0.013) % 1.6) - 0.8);
    }
    pos.needsUpdate = true;
  });

  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial size={0.055} color={color} transparent opacity={0.55} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

/** 体积光近似：加色混合的锥形光束（顶部斜射） */
const LightCone: React.FC<{color: string; intensity: number; x: number; tilt: number}> = ({color, intensity, x, tilt}) => (
  <mesh position={[x, 3.4, -1.5]} rotation={[0, 0, tilt]}>
    <coneGeometry args={[1.6, 7, 24, 1, true]} />
    <meshBasicMaterial color={color} transparent opacity={0.05 * intensity} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
  </mesh>
);

const FogSetup: React.FC<{density: number}> = ({density}) => {
  const {scene} = useThree();
  React.useEffect(() => {
    if (density <= 0) return;
    scene.fog = new THREE.FogExp2('#0B0F14', density);
    return () => {
      scene.fog = null;
    };
  }, [scene, density]);
  return null;
};

export interface ThreeAmbienceProps {
  /** 0 关 / 1 弱 / 2 中 / 3 强 */
  level: number;
  /** 粒子/光锥色调（缺省品牌蓝） */
  color?: string;
  /** 场景尺度倍率（默认 1）：大场景（如 CameraJourney3D 长路径）粒子更散、雾更稀 */
  worldScale?: number;
  /** 粒子场中心 XZ（默认原点）；长路径场景传路径中心让粒子覆盖全程 */
  centerXZ?: [number, number];
  /** 体积光锥开关（默认开）：路径相机穿过锥体时会看到横穿画面的光带，旅程类模板宜关 */
  cones?: boolean;
}

export const ThreeAmbience: React.FC<ThreeAmbienceProps> = ({level, color = '#7FA8FF', worldScale = 1, centerXZ, cones = true}) => {
  const lv = Math.max(0, Math.min(3, Math.round(level)));
  if (lv === 0) return null;
  const count = PARTICLE_COUNT[lv];
  const ws = Math.max(0.1, worldScale);
  return (
    <>
      <Particles count={count} color={color} spread={(7 + lv * 1.5) * ws} centerXZ={centerXZ} />
      {cones && <LightCone color={color} intensity={lv} x={-2.6} tilt={0.42} />}
      {cones && lv >= 2 && <LightCone color={color} intensity={lv * 0.7} x={2.8} tilt={-0.38} />}
      <FogSetup density={(0.015 * lv) / ws} />
    </>
  );
};
