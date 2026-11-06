/**
 * CameraRig - 参数化相机运镜（three.js 3D 模板通用）
 *
 * 预设：
 *  - static：固定机位（略带高度的正面视角）
 *  - orbit ：水平环绕（左右摆动一圈的片段内插值，默认 ±0.45rad × speed）
 *  - dolly ：推轨（由远及近 + 轻微下压，产品特写感）
 *  - crane ：摇臂（高位下降至平视 + 横向漂移，片头开场感）
 *
 * 铁律：全部经 useCurrentFrame() 插值驱动（useFrame 回调内读取闭包帧），
 * 禁止 Clock/delta —— 逐帧渲染确定性要求（headless 渲染每帧截图必须与帧号一一对应）。
 */
import React from 'react';
import * as THREE from 'three';
import {useFrame, useThree} from '@react-three/fiber';
import {useCurrentFrame} from 'remotion';

export type CameraRigPreset = 'static' | 'orbit' | 'dolly' | 'crane' | 'none';

interface CameraRigProps {
  preset: CameraRigPreset;
  /** 段总帧数（运镜进度分母，0/负值按 1 处理） */
  totalFrames: number;
  /** 运镜幅度/速度倍率（1 = 默认） */
  speed?: number;
  /** 基准焦距（相机到目标点距离，three 世界单位） */
  radius?: number;
  /** 基准高度偏移 */
  baseY?: number;
  /** 注视点（缺省画面中心略上） */
  target?: [number, number, number];
}

const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const CameraRig: React.FC<CameraRigProps> = ({
  preset,
  totalFrames,
  speed = 1,
  radius = 7.5,
  baseY = 0,
  target = [0, 0.1, 0],
}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  const q = easeInOutQuad(Math.min(1, Math.max(0, frame / Math.max(1, totalFrames))));

  useFrame(() => {
    // none：模板自驱相机（如 CameraJourney3D 路径相机），本 Rig 完全不接管
    if (preset === 'none') return;
    switch (preset) {
      case 'orbit': {
        const a = THREE.MathUtils.lerp(-0.45, 0.45, q) * speed;
        camera.position.set(Math.sin(a) * radius, baseY + 0.35, Math.cos(a) * radius);
        break;
      }
      case 'dolly': {
        const r = THREE.MathUtils.lerp(radius * (1 + 0.22 * speed), radius * (1 - 0.18 * speed), q);
        camera.position.set(0, baseY + THREE.MathUtils.lerp(0.55, 0.12, q), r);
        break;
      }
      case 'crane': {
        const y = THREE.MathUtils.lerp(baseY + 2.4 * speed, baseY + 0.2, q);
        const x = THREE.MathUtils.lerp(-1.2 * speed, 0.4 * speed, q);
        camera.position.set(x, y, radius * (1 - 0.1 * q));
        break;
      }
      default:
        camera.position.set(0, baseY + 0.35, radius);
    }
    camera.lookAt(target[0], target[1], target[2]);
  });
  return null;
};
