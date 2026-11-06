/**
 * ThreeStage - 3D 模板的舞台封装（@remotion/three ThreeCanvas + 灯光 + 环境反射 + 地影）
 *
 * - 透明 canvas：DOM 层 Background/BackgroundEffectLayer 透出，3D 场景浮在其上
 * - 环境反射：three 内置 RoomEnvironment 程序化 PMREM（无网络依赖，headless 可靠）
 * - 灯光：key 主光 + fill 补光 + rim 轮廓光；可选 ContactShadows 地面接触影
 * - 运镜：挂 CameraRig（preset 由模板参数档位决定）
 * - 氛围：挂 ThreeAmbience（粒子/光锥/雾，档位 0-3）
 *
 * 用法（模板内）：
 *   <ThreeStage rig="dolly" rigSpeed={1} ambience={2} totalFrames={totalFrames}>
 *     <DeviceModel ... />
 *   </ThreeStage>
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {ContactShadows} from '@react-three/drei';
import {useVideoConfig} from 'remotion';
import {CameraRig, CameraRigPreset} from './CameraRig';
import {ThreeAmbience} from './ThreeAmbience';
import {WebglContextGuard} from './WebglContextGuard';

/** WebGL 上下文重建上限：超过即认为 GPU 已死透（8GB 低显存极端场景），
 *  停止重挂保留透明底降级运行（模板文字/背景层照常），防无限重挂循环 */
const MAX_GL_REBUILDS = 3;

/** 程序化环境反射（RoomEnvironment → PMREM → scene.environment），无网络依赖。 */
const EnvSetup: React.FC<{intensity?: number}> = ({intensity = 0.55}) => {
  const {gl, scene} = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = intensity;
    return () => {
      scene.environment = null;
      envTex.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
};

export interface ThreeStageProps {
  children: React.ReactNode;
  /** 运镜预设（缺省 static） */
  rig?: CameraRigPreset;
  /** 运镜幅度倍率 */
  rigSpeed?: number;
  /** 段总帧数（运镜进度分母） */
  totalFrames: number;
  /** 氛围档位 0 关 / 1 弱 / 2 中 / 3 强 */
  ambience?: number;
  /** 氛围色调（缺省品牌蓝） */
  ambienceColor?: string;
  /** 场景尺度倍率（大场景粒子更散、雾更稀，缺省 1；透传 ThreeAmbience） */
  ambienceWorldScale?: number;
  /** 粒子场中心 XZ（缺省原点；长路径场景传路径中心） */
  ambienceCenterXZ?: [number, number];
  /** 体积光锥开关（缺省开；路径相机会穿锥体的模板宜关） */
  ambienceCones?: boolean;
  /** 相机焦距与视场角 */
  radius?: number;
  fov?: number;
  /** 注视点高度（设备/模型中心略上） */
  targetY?: number;
  /** 地面接触影（缺省开；realShadows 开时自动关闭避免双重影子） */
  shadows?: boolean;
  /** 地影高度（放在物体底面） */
  shadowY?: number;
  /** 真实投影阴影（方向光 shadowMap；长走廊场景传 shadowCenter/shadowBounds 覆盖整条路径） */
  realShadows?: boolean;
  /** 投影覆盖中心 XZ（世界单位；缺省原点） */
  shadowCenter?: [number, number];
  /** 投影覆盖半径（世界单位；缺省 14） */
  shadowBounds?: number;
}

export const ThreeStage: React.FC<ThreeStageProps> = ({
  children,
  rig = 'static',
  rigSpeed = 1,
  totalFrames,
  ambience = 0,
  ambienceColor,
  ambienceWorldScale = 1,
  ambienceCenterXZ,
  ambienceCones = true,
  radius = 7.5,
  fov = 40,
  targetY = 0.1,
  shadows = true,
  shadowY = -1.9,
  realShadows = false,
  shadowCenter = [0, 0],
  shadowBounds = 14,
}) => {
  const {width, height} = useVideoConfig();
  // WebGL 上下文重建（丢失恢复/超时）：key 变更整树重挂 = 换新上下文从零重建
  //（PMREM 环境反射等一次性 GL 资源恢复事件不会重建，必须重挂）；计数上限防死循环
  const [glEpoch, setGlEpoch] = useState(0);
  const glRebuildsRef = useRef(0);
  const handleContextRebuild = useCallback((reason: 'restored' | 'lost-timeout') => {
    if (glRebuildsRef.current >= MAX_GL_REBUILDS) return;
    glRebuildsRef.current += 1;
    setGlEpoch((e) => e + 1);
    console.warn(`[ThreeStage] WebGL 上下文重建（${reason}，第 ${glRebuildsRef.current}/${MAX_GL_REBUILDS} 次）`);
  }, []);
  // 投影用方向光挂在覆盖中心上方，正交阴影相机罩住整条路径（长走廊场景 bounds 要够大）
  const aimShadowLight = (l: THREE.DirectionalLight | null): void => {
    if (!l) return;
    l.target.position.set(shadowCenter[0], 0, shadowCenter[1]);
    l.target.updateMatrixWorld();
  };
  return (
    <ThreeCanvas
      key={glEpoch}
      width={width}
      height={height}
      style={{position: 'absolute', inset: 0}}
      camera={{position: [0, 0.35, radius], fov}}
      dpr={1}
      gl={{alpha: true, antialias: true}}
      shadows={realShadows ? 'soft' : false}
    >
      {/* 上下文丢失防护（8GB 机器渲染静默死亡根因）：恢复/超时 → bump glEpoch 整树重挂重建 */}
      <WebglContextGuard onContextRebuild={handleContextRebuild} />
      <EnvSetup />
      <ambientLight intensity={0.35} />
      <directionalLight
        ref={realShadows ? aimShadowLight : undefined}
        position={realShadows ? [shadowCenter[0] + 7, 15, shadowCenter[1] + 9] : [5, 7, 6]}
        intensity={1.5}
        castShadow={realShadows}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-shadowBounds}
        shadow-camera-right={shadowBounds}
        shadow-camera-top={shadowBounds}
        shadow-camera-bottom={-shadowBounds}
        shadow-camera-near={0.5}
        shadow-camera-far={110}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-6, 3, -4]} intensity={0.5} color="#BFD4FF" />
      <pointLight position={[0, -2, 5]} intensity={0.35} color="#FFE8C8" />
      <CameraRig preset={rig} speed={rigSpeed} totalFrames={totalFrames} radius={radius} target={[0, targetY, 0]} />
      <ThreeAmbience level={ambience} color={ambienceColor} worldScale={ambienceWorldScale} centerXZ={ambienceCenterXZ} cones={ambienceCones} />
      {children}
      {shadows && !realShadows && <ContactShadows position={[0, shadowY, 0]} opacity={0.55} scale={14} blur={2.6} far={4.5} resolution={512} />}
    </ThreeCanvas>
  );
};
