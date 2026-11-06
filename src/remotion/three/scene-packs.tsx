/**
 * scene-packs - 3D 场景包渲染端（v28 运动模板/场景解耦的「场景」实现）
 *
 * 架构：七款 3D 模板 = 纯运动（相机 rig + 展板站位 + 路径签名件），环境装饰全部
 * 收敛到本模块的场景包，由模板的 sceneStyle 参数选择。注册表在 shared/three-scenes.ts。
 *
 * 与模板的边界（谁留在模板、谁进场景包）：
 * - 留在模板（运动签名）：相机 rig、展板/站位、时间线、路径可视化（旅程发光管/
 *   隧道门框/螺旋栏管/环台灯环/星图星座连线/城市路面车道）。
 * - 进场景包（环境）：天空体量（星壳/银河/山体/楼群剪影）、地面（水面/草地/广场/
 *   街面）、远景地标（行星/宝塔/农舍/亭子）、氛围微粒。
 *
 * 约束（与 scene-dress 同族）：
 * - 帧驱动确定性：几何全部由 stationJitter 整数哈希派生，动效只吃 useCurrentFrame，
 *   逐帧渲染可复现；
 * - 零加载：不用外部模型/贴图，程序化低段数几何；
 * - hook 安全：包内挂载数量只依赖场景常量与模板传入的世界尺寸，与媒体增删无关。
 *
 * 兼容承诺：星空/都市/虚空三包的几何公式与 salts 从 Starfield3D / CityScape3D /
 * CameraJourney3D 原样抽取（世界尺寸由模板原值传入），sceneStyle 取默认档时
 * 观感与拆分前逐帧一致；水墨为亮色纸底（注册表 light 标记），模板悬浮标题会换墨色字。
 */
import React, {useEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useCurrentFrame} from 'remotion';
import {useFrame} from '@react-three/fiber';
import {stationJitter} from './rig-utils';
import {FloatingMotes, MonolithRing, TrafficStreaks, BlinkBeacon} from './scene-dress';
import {FPS} from '../config/resolutions';
import {THREE_SCENES, clampSceneIndex} from '../../shared/three-scenes';

/** 场景包统一入参（模板按自己的世界几何换算传入） */
export interface SceneEnvProps {
  /** 场景档位（THREE_SCENES 下标；越界钳制） */
  scene: number;
  /** 品牌色 */
  accent: string;
  /** 世界缩放（竖版 0.58 / 横版 1） */
  ws: number;
  /** 世界中心（展板质心；x z 为场面中心，y 为板均高） */
  center: THREE.Vector3;
  /** 世界轴向跨度（entrance→end 的距离，>0） */
  spanZ: number;
  /** 横向半径（站位散布半径；城市楼体贴 ±radiusX 立） */
  radiusX: number;
  /** 相机飞行高度（灯杆/灯笼挂高参考；缺省 = center.y） */
  axisY?: number;
  /** 是否允许场景自带地面（false = 模板有自备地板/路面/展台盘） */
  ground: boolean;
  /** 模板签名发光档映射（0 关/1 标准/2 醒目；星壳/窗灯等强度用；其余包可忽略） */
  glow?: number;
  /** 场景体量基准半径（旅程传路径投影半径；缺省按 spanZ/radiusX 推） */
  scale?: number;
  /** 场景件种子（标题哈希；同文案同布局） */
  seed?: number;
}

/** 径向柔光贴图（星云/雾团/光晕通用；同步生成无加载） */
const useRadialSprite = (): THREE.CanvasTexture => {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    return new THREE.CanvasTexture(c);
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
};

/** 柔光贴图面片（加色混合的雾团/光晕） */
const SoftSprite: React.FC<{position: [number, number, number]; size: number; color: string; opacity: number; tex: THREE.CanvasTexture; rot?: number}> = ({position, size, color, opacity, tex, rot = 0}) => (
  <mesh position={position} rotation={[0, 0, rot]}>
    <planeGeometry args={[size, size]} />
    <meshBasicMaterial map={tex} color={color} transparent opacity={opacity} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
  </mesh>
);

/** 整组帧驱动慢旋（星壳/银河用；禁 Clock） */
const SlowSpin: React.FC<{children: React.ReactNode; speed?: number; tilt?: number}> = ({children, speed = 0.012, tilt = 0}) => {
  const ref = useRef<THREE.Group>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (!ref.current) return;
    ref.current.rotation.y = (frame / FPS) * speed;
    if (tilt) ref.current.rotation.z = (frame / FPS) * speed * 0.4167;
  });
  return <group ref={ref}>{children}</group>;
};

/** 远景山体锥（尖峰）：低段数 + 顶点确定性径向扰动——山脊棱线不规则，不再是「一批三角形」；
 *  同参几何由调用方 useMemo + dispose 管理这里只建一次 */
const noisyPeakGeometry = (h: number, r: number, seed: number): THREE.BufferGeometry => {
  const g = new THREE.ConeGeometry(r, h, 14, 3, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > h / 2 - 1e-4) continue; // 塔尖不动
    const k = 0.72 + 0.56 * stationJitter(seed * 31 + i, 471);
    pos.setX(i, pos.getX(i) * k);
    pos.setZ(i, pos.getZ(i) * k);
    pos.setY(i, y * (0.95 + 0.1 * stationJitter(seed * 17 + i, 472)));
  }
  g.computeVertexNormals();
  return g;
};

/** 山体簇：主峰 + 两侧副峰（错落体量感），flatShading 出剪纸山面感 */
const PeakCluster: React.FC<{x: number; z: number; h: number; r: number; seed: number; color: string; opacity?: number; basic?: boolean}> = ({x, z, h, r, seed, color, opacity, basic = false}) => {
  const geoms = useMemo(() => {
    const j1 = stationJitter(seed, 481);
    const j2 = stationJitter(seed, 482);
    const h1 = h * (0.5 + j1 * 0.28);
    const h2 = h * (0.34 + j2 * 0.22);
    return [
      noisyPeakGeometry(h, r, seed),
      noisyPeakGeometry(h1, r * (0.46 + j1 * 0.14), seed + 11),
      noisyPeakGeometry(h2, r * (0.38 + j2 * 0.12), seed + 23),
    ];
  }, [h, r, seed]);
  useEffect(() => () => geoms.forEach((g) => g.dispose()), [geoms]);
  const offs: [number, number][] = [
    [0, 0],
    [(0.62 + stationJitter(seed, 483) * 0.5) * r, -0.3 * r],
    [-(0.55 + stationJitter(seed, 484) * 0.5) * r, 0.32 * r],
  ];
  return (
    <group position={[x, 0, z]}>
      {geoms.map((g, k) => (
        <mesh key={k} geometry={g} position={[offs[k][0], 0, offs[k][1]]}>
          {basic ? (
            <meshBasicMaterial color={color} transparent={opacity !== undefined} opacity={opacity} depthWrite={false} toneMapped={false} />
          ) : (
            <meshStandardMaterial color={color} roughness={0.9} metalness={0.05} flatShading transparent={opacity !== undefined} opacity={opacity} />
          )}
        </mesh>
      ))}
    </group>
  );
};

/**
 * 环形连绵山脊带（全景背景，任意机位看都是连续山势）：圆柱侧面顶环按角度扰动高度——
 * 双正弦 + 逐列确定性微扰出峰谷。水墨用它做层层淡墨远山，山水用它做青绿叠嶂远景。
 */
const ridgeRingGeometry = (radius: number, height: number, seed: number, cols = 96): THREE.BufferGeometry => {
  const g = new THREE.CylinderGeometry(radius, radius, 1, cols, 1, true);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const p1 = stationJitter(seed, 491) * Math.PI * 2;
  const p2 = stationJitter(seed + 3, 492) * Math.PI * 2;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) <= 0) {
      pos.setY(i, 0);
      continue;
    }
    const a = Math.atan2(pos.getZ(i), pos.getX(i));
    const c = Math.round(((a + Math.PI) / (Math.PI * 2)) * cols) % cols;
    const hCol = Math.max(
      0.1,
      0.34 + 0.26 * Math.sin(a * 3 + p1) + 0.18 * Math.sin(a * 7 + p2) + 0.14 * (stationJitter(seed * 13 + c, 493) - 0.5),
    );
    pos.setY(i, hCol * height);
  }
  g.computeVertexNormals();
  return g;
};

/** 环形山脊（水墨淡墨剪影用 basic；青绿用 standard） */
const RidgeRing: React.FC<{radius: number; height: number; seed: number; color: string; opacity?: number; basic?: boolean}> = ({radius, height, seed, color, opacity, basic = false}) => {
  const geom = useMemo(() => ridgeRingGeometry(radius, height, seed), [radius, height, seed]);
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <mesh geometry={geom} position={[0, 0, 0]}>
      {basic ? (
        <meshBasicMaterial color={color} transparent={opacity !== undefined} opacity={opacity} side={THREE.BackSide} depthWrite={false} toneMapped={false} />
      ) : (
        <meshStandardMaterial color={color} roughness={0.92} metalness={0.04} flatShading side={THREE.BackSide} transparent={opacity !== undefined} opacity={opacity} />
      )}
    </mesh>
  );
};

// ====== 星空包（Starfield3D 原样抽取：星壳/星云/行星系/冰晶） ======
const StarEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'ground' | 'axisY' | 'spanZ' | 'radiusX' | 'seed' | 'scale'>> = ({accent, ws, center, glow = 1}) => {
  const starOn = glow > 0;
  const starBoost = glow === 2 ? 1.35 : 1;
  const nebTex = useRadialSprite();

  const starGeom = useMemo(() => {
    const count = 520 + (glow === 2 ? 240 : 0);
    const arr = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const phi = stationJitter(k, 201) * Math.PI * 2;
      const cosT = stationJitter(k, 202) * 2 - 1;
      const r = 26 + stationJitter(k, 203) * 30;
      const sinT = Math.sqrt(1 - cosT * cosT);
      arr[k * 3] = r * sinT * Math.cos(phi);
      arr[k * 3 + 1] = r * sinT * Math.sin(phi) * 0.8;
      arr[k * 3 + 2] = r * cosT + center.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, [glow, center.z]);
  useEffect(() => () => starGeom.dispose(), [starGeom]);

  const nebulae = useMemo(
    () => [
      {pos: new THREE.Vector3(center.x - 16 * ws, center.y + 7 * ws, center.z - 26 * ws), size: 34, rot: 0.4},
      {pos: new THREE.Vector3(center.x + 19 * ws, center.y - 5 * ws, center.z - 34 * ws), size: 42, rot: -0.7},
      {pos: new THREE.Vector3(center.x + 3 * ws, center.y + 12 * ws, center.z - 48 * ws), size: 30, rot: 1.2},
    ],
    [center, ws],
  );
  const planet = useMemo(
    () => ({
      pos: new THREE.Vector3(center.x - 17 * ws, center.y + 7.5 * ws, center.z - 30 * ws),
      r: 3.4 * ws,
      moon: new THREE.Vector3(5.4 * ws, -1.2 * ws, 2.1 * ws),
    }),
    [center, ws],
  );
  const crystals = useMemo(
    () =>
      Array.from({length: 6}, (_, k) => ({
        pos: new THREE.Vector3(
          center.x + (stationJitter(k + 40, 331) - 0.5) * 26 * ws,
          center.y + (stationJitter(k + 46, 332) - 0.4) * 9 * ws,
          center.z - (4 + stationJitter(k + 52, 333) * 24) * ws,
        ),
        s: (0.16 + stationJitter(k + 58, 334) * 0.3) * ws,
        rot: stationJitter(k + 64, 335) * Math.PI,
      })),
    [center, ws],
  );

  return (
    <>
      {starOn && (
        <SlowSpin>
          <points geometry={starGeom}>
            <pointsMaterial size={0.13 * ws * starBoost} sizeAttenuation color="#C9DDFF" transparent opacity={0.85} toneMapped={false} depthWrite={false} />
          </points>
          {nebulae.map((nb, k) => (
            <mesh key={`nb${k}`} position={nb.pos} rotation={[0, 0, nb.rot]}>
              <planeGeometry args={[nb.size * ws, nb.size * ws]} />
              <meshBasicMaterial map={nebTex} color={accent} transparent opacity={0.16 * starBoost} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>
          ))}
        </SlowSpin>
      )}
      <group position={planet.pos} rotation={[1.15, 0.3, 0.35]}>
        <mesh>
          <sphereGeometry args={[planet.r, 32, 24]} />
          <meshStandardMaterial color="#17233B" roughness={0.65} metalness={0.35} emissive={accent} emissiveIntensity={0.05} />
        </mesh>
        <mesh rotation={[Math.PI / 2.25, 0, 0]}>
          <torusGeometry args={[planet.r * 1.55, 0.035 * ws, 8, 72]} />
          <meshBasicMaterial color={accent} transparent opacity={0.32} toneMapped={false} depthWrite={false} />
        </mesh>
        <mesh position={planet.moon}>
          <sphereGeometry args={[planet.r * 0.16, 14, 12]} />
          <meshStandardMaterial color="#2A3A55" roughness={0.7} metalness={0.3} />
        </mesh>
      </group>
      {starOn && (
        <SlowSpin speed={0.009}>
          {crystals.map((c, k) => (
            <mesh key={`cr${k}`} position={c.pos} rotation={[c.rot, c.rot * 1.7, 0]}>
              <icosahedronGeometry args={[c.s, 0]} />
              <meshStandardMaterial color="#22304A" roughness={0.35} metalness={0.55} emissive={accent} emissiveIntensity={0.12} />
            </mesh>
          ))}
        </SlowSpin>
      )}
    </>
  );
};

// ====== 银河包（新场景：螺旋星系盘 + 核心辉光 + 尘埃带 + 远景稀星星壳） ======
const GalaxyEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'ground' | 'axisY' | 'spanZ' | 'radiusX' | 'seed' | 'scale'>> = ({accent, ws, center, glow = 1}) => {
  const nebTex = useRadialSprite();
  const dim = glow === 0 ? 0.55 : glow === 2 ? 1.22 : 1;
  const galaxyCenter = useMemo(() => new THREE.Vector3(center.x + 6 * ws, center.y + 13 * ws, center.z - 46 * ws), [center, ws]);

  /** 对数螺旋星系盘：双臂 + 核心球鼓 + 暗尘（几何一次生成，整盘慢旋） */
  const {armGeom, dustGeom, coreGeom} = useMemo(() => {
    const arms = 2;
    const perArm = 300;
    const armArr = new Float32Array(arms * perArm * 3);
    let w = 0;
    const push = (v: number, x: number, y: number, z: number) => {
      armArr[v] = x;
      armArr[v + 1] = y;
      armArr[v + 2] = z;
    };
    for (let a = 0; a < arms; a++) {
      for (let k = 0; k < perArm; k++) {
        const th = (k / perArm) * 3.1 * Math.PI + (a * Math.PI) / arms;
        const r = Math.min(38, 2.0 * Math.exp(0.3 * th));
        const scatter = (0.5 + r * 0.075) * (stationJitter(a * 1000 + k, 341) - 0.5) * 2;
        const x = Math.cos(th) * r + scatter;
        const z = Math.sin(th) * r + scatter * (stationJitter(a * 1000 + k, 342) - 0.5);
        const y = (stationJitter(a * 1000 + k, 343) - 0.5) * (1.6 + r * 0.05);
        push(w, x, y, z);
        w += 3;
      }
    }
    const arm = new THREE.BufferGeometry();
    arm.setAttribute('position', new THREE.BufferAttribute(armArr, 3));
    const dustArr = new Float32Array(340 * 3);
    for (let k = 0; k < 340; k++) {
      const th = (k / 340) * 2.6 * Math.PI;
      const r = Math.min(30, 1.7 * Math.exp(0.35 * th));
      dustArr[k * 3] = Math.cos(th) * r + (stationJitter(k, 345) - 0.5) * 1.4;
      dustArr[k * 3 + 1] = (stationJitter(k, 346) - 0.5) * 1.1;
      dustArr[k * 3 + 2] = Math.sin(th) * r + (stationJitter(k, 347) - 0.5) * 1.4;
    }
    const dust = new THREE.BufferGeometry();
    dust.setAttribute('position', new THREE.BufferAttribute(dustArr, 3));
    const coreArr = new Float32Array(240 * 3);
    for (let k = 0; k < 240; k++) {
      const r = Math.pow(stationJitter(k, 348), 1.6) * 5.5;
      const phi = stationJitter(k, 349) * Math.PI * 2;
      const y = (stationJitter(k, 350) - 0.5) * 2.2;
      coreArr[k * 3] = Math.cos(phi) * r;
      coreArr[k * 3 + 1] = y;
      coreArr[k * 3 + 2] = Math.sin(phi) * r;
    }
    const core = new THREE.BufferGeometry();
    core.setAttribute('position', new THREE.BufferAttribute(coreArr, 3));
    return {armGeom: arm, dustGeom: dust, coreGeom: core};
  }, []);
  useEffect(
    () => () => {
      armGeom.dispose();
      dustGeom.dispose();
      coreGeom.dispose();
    },
    [armGeom, dustGeom, coreGeom],
  );

  /** 远景稀星星壳（银河天的底噪） */
  const skyGeom = useMemo(() => {
    const count = 260;
    const arr = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      const phi = stationJitter(k, 351) * Math.PI * 2;
      const cosT = stationJitter(k, 352) * 2 - 1;
      const r = 30 + stationJitter(k, 353) * 28;
      const sinT = Math.sqrt(1 - cosT * cosT);
      arr[k * 3] = r * sinT * Math.cos(phi);
      arr[k * 3 + 1] = r * sinT * Math.sin(phi) * 0.8;
      arr[k * 3 + 2] = r * cosT + center.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, [center.z]);
  useEffect(() => () => skyGeom.dispose(), [skyGeom]);

  return (
    <>
      <points geometry={skyGeom}>
        <pointsMaterial size={0.11 * ws} sizeAttenuation color="#B9C8F2" transparent opacity={0.6 * dim} toneMapped={false} depthWrite={false} />
      </points>
      <group position={galaxyCenter} rotation={[1.12, 0.2, 0.32]}>
        <SlowSpin speed={0.02}>
          <points geometry={armGeom}>
            <pointsMaterial size={0.22 * ws} sizeAttenuation color="#E6ECFF" transparent opacity={0.75 * dim} toneMapped={false} depthWrite={false} />
          </points>
          <points geometry={coreGeom}>
            <pointsMaterial size={0.2 * ws} sizeAttenuation color="#FFF3DC" transparent opacity={0.9 * dim} toneMapped={false} depthWrite={false} />
          </points>
          <points geometry={dustGeom}>
            <pointsMaterial size={0.3 * ws} sizeAttenuation color="#5A4A8A" transparent opacity={0.4 * dim} toneMapped={false} depthWrite={false} />
          </points>
        </SlowSpin>
        <SoftSprite position={[0, 0, 0]} size={17 * ws} color={accent} opacity={0.3 * dim} tex={nebTex} />
        <SoftSprite position={[0, 0, 0]} size={8 * ws} color="#FFF6E3" opacity={0.55 * dim} tex={nebTex} />
        <SoftSprite position={[-6 * ws, 1.5 * ws, -3 * ws]} size={13 * ws} color="#8F6FE0" opacity={0.2 * dim} tex={nebTex} rot={0.6} />
      </group>
    </>
  );
};

// ====== 都市包（CityScape3D 原样抽取：楼体/窗灯/双层天际线/楼顶件/路灯/车轨/尘埃） ======
/** 楼体窗户灯网格（单 InstancedMesh 一次 draw call；确定性亮灭 + 冷暖混色） */
const WindowLights: React.FC<{
  items: {pos: [number, number, number]; yaw: number; warm: boolean}[];
  opacity: number;
  ws: number;
}> = ({items, opacity, ws}) => {
  const ref = React.useRef<THREE.InstancedMesh>(null);
  React.useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const warm = new THREE.Color('#FFD9A0');
    const cool = new THREE.Color('#BFD4FF');
    items.forEach((it, i) => {
      q.setFromEuler(new THREE.Euler(0, it.yaw, 0));
      m.compose(new THREE.Vector3(...it.pos), q, one);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, it.warm ? warm : cool);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items]);
  if (items.length === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, items.length]} frustumCulled={false}>
      <planeGeometry args={[0.16 * ws, 0.2 * ws]} />
      <meshBasicMaterial transparent opacity={opacity} toneMapped={false} />
    </instancedMesh>
  );
};

const CityEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'axisY' | 'scale' | 'seed'>> = ({accent, ws, center, spanZ, radiusX, ground, glow = 1}) => {
  const neonOn = glow > 0;
  const neonBoost = glow === 2 ? 1.35 : 1;
  const halfW = radiusX;
  // 世界轴向还原：center.z = (entrance+end)/2、spanZ = entrance-end（CityScape 原值即此关系）
  const midZ = center.z;
  const entranceZ = midZ + spanZ / 2;
  const endZ = midZ - spanZ / 2;
  const streetLen = spanZ + 26 * ws;

  const buildings = useMemo(() => {
    const rng = (k: number) => stationJitter(k, 91);
    const list: {cx: number; cz: number; w: number; h: number; d: number; s: 1 | -1}[] = [];
    const segW = 5.0 * ws;
    let z = entranceZ + 4.5 * ws;
    let k = 0;
    while (z > endZ - 3 * ws) {
      for (const s of [-1, 1] as const) {
        const d = (2.6 + rng(k * 2 + (s > 0 ? 1 : 0)) * 2.4) * ws;
        const h = (7.5 + rng(k * 3 + (s > 0 ? 7 : 2)) * 7.5) * ws;
        list.push({cx: s * (halfW + d / 2), cz: z - segW / 2, w: segW, h, d, s});
      }
      z -= segW + 0.55 * ws;
      k++;
    }
    return list;
  }, [halfW, entranceZ, endZ, ws]);

  const windowLights = useMemo(() => {
    const items: {pos: [number, number, number]; yaw: number; warm: boolean}[] = [];
    const pitch = 0.62 * ws;
    const rowH = 0.8 * ws;
    buildings.forEach((b, k) => {
      const cols = Math.max(3, Math.floor(b.w / pitch));
      const rows = Math.max(3, Math.floor((b.h - 1.4 * ws) / rowH));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const lit = stationJitter(k * 131 + r * 17 + c * 3 + (b.s > 0 ? 600 : 0), 401);
          if (lit > 0.55) continue;
          const y = 1.2 * ws + ((r + 0.5) * (b.h - 1.2 * ws)) / rows;
          const z = b.cz - b.w / 2 + (c + 0.5) * b.w / cols;
          items.push({pos: [b.s * (halfW - 0.025), y, z], yaw: (-b.s * Math.PI) / 2, warm: lit < 0.14});
        }
      }
    });
    return items;
  }, [buildings, halfW, ws]);

  const skyline = useMemo(() => {
    const rng = (k: number) => stationJitter(k, 47);
    return Array.from({length: 9}, (_, k) => {
      const w = (2.2 + rng(k * 3) * 2.6) * ws;
      const h = (6 + rng(k * 5 + 1) * 9) * ws;
      const x = (rng(k * 7 + 2) - 0.5) * 2 * (halfW + 14 * ws);
      return {x, w, h, z: endZ - (2.5 + rng(k * 11 + 3) * 9) * ws};
    });
  }, [halfW, endZ, ws]);
  const skylineFar = useMemo(() => {
    const rng = (k: number) => stationJitter(k, 53);
    return Array.from({length: 7}, (_, k) => {
      const w = (3 + rng(k * 3 + 5) * 3.2) * ws;
      const h = (11 + rng(k * 5 + 7) * 10) * ws;
      const x = (rng(k * 7 + 9) - 0.5) * 2 * (halfW + 30 * ws);
      return {x, w, h, z: endZ - (14 + rng(k * 11 + 1) * 15) * ws};
    });
  }, [halfW, endZ, ws]);
  const rooftopProps = useMemo(() => {
    const rng = (k: number) => stationJitter(k, 59);
    const antennas: {x: number; z: number; baseY: number; h: number}[] = [];
    const sheds: {x: number; y: number; z: number; w: number; h: number; d: number}[] = [];
    buildings.forEach((b, k) => {
      if (b.h > 10.5 * ws && rng(k * 3) > 0.35) {
        const antH = (0.8 + rng(k * 5 + 1) * 1.1) * ws;
        antennas.push({x: b.cx, z: b.cz, baseY: b.h, h: antH});
      }
      if (rng(k * 7 + 3) > 0.62) {
        sheds.push({x: b.cx + (rng(k * 9 + 2) - 0.5) * b.d * 0.3, y: b.h + 0.22 * ws, z: b.cz, w: 0.85 * ws, h: 0.44 * ws, d: 0.6 * ws});
      }
    });
    return {antennas, sheds};
  }, [buildings, ws]);
  const streetLamps = useMemo(() => {
    const step = 6.4 * ws;
    const items: {x: number; z: number; phase: number}[] = [];
    for (let z = entranceZ - 2.5 * ws; z > endZ + 2 * ws; z -= step) {
      items.push({x: -(halfW - 0.5 * ws), z, phase: stationJitter(items.length, 63) * Math.PI * 2});
      items.push({x: halfW - 0.5 * ws, z: z - step / 2, phase: stationJitter(items.length + 500, 63) * Math.PI * 2});
    }
    return items;
  }, [halfW, entranceZ, endZ, ws]);

  return (
    <>
      {/* 非城市模板借用都市景时补街道地面（CityScape 自备路面故 ground=false） */}
      {ground && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, midZ - 6 * ws]} receiveShadow>
            <planeGeometry args={[halfW * 2 + 4, streetLen]} />
            <meshStandardMaterial color="#07090F" roughness={0.42} metalness={0.5} />
          </mesh>
          {neonOn &&
            [-1, 1].map((s) => (
              <mesh key={`lane${s}`} position={[s * 1.15 * ws, 0.0, midZ - 6 * ws]}>
                <boxGeometry args={[0.07, 0.03, streetLen * 0.96]} />
                <meshBasicMaterial color={accent} transparent opacity={0.4 * neonBoost} toneMapped={false} />
              </mesh>
            ))}
        </>
      )}
      <TrafficStreaks
        count={7}
        lanes={[
          {x: -1.75 * ws, color: '#DCE8FF', speed: 5.2},
          {x: -0.55 * ws, color: '#DCE8FF', speed: 4.4},
          {x: 0.55 * ws, color: '#FF9E7A', speed: 4.8},
          {x: 1.75 * ws, color: '#FF9E7A', speed: 5.6},
        ]}
        zFrom={entranceZ + 3 * ws}
        zTo={endZ + 8 * ws}
        y={0.05 * ws}
        ws={ws}
      />
      {streetLamps.map((lp, k) => (
        <group key={`lp${k}`}>
          <mesh position={[lp.x, 0.95 * ws, lp.z]}>
            <cylinderGeometry args={[0.025 * ws, 0.035 * ws, 1.9 * ws, 6]} />
            <meshStandardMaterial color="#141B2B" roughness={0.7} metalness={0.4} />
          </mesh>
          {neonOn && <BlinkBeacon position={[lp.x, 1.95 * ws, lp.z]} color="#FFE2AE" size={0.07 * ws} phase={lp.phase} rate={1.4} />}
        </group>
      ))}
      {buildings.map((b, k) => (
        <mesh key={`b${k}`} position={[b.cx, b.h / 2, b.cz]} castShadow>
          <boxGeometry args={[b.d, b.h, b.w]} />
          <meshStandardMaterial color="#0B101C" roughness={0.85} metalness={0.15} />
        </mesh>
      ))}
      {neonOn && <WindowLights items={windowLights} opacity={Math.min(0.95, 0.62 * neonBoost)} ws={ws} />}
      {skyline.map((b, k) => (
        <mesh key={`sk${k}`} position={[b.x, b.h / 2, b.z]}>
          <boxGeometry args={[b.w, b.h, b.w * 0.8]} />
          <meshStandardMaterial color="#0A0E18" roughness={0.9} metalness={0.1} />
        </mesh>
      ))}
      {skylineFar.map((b, k) => (
        <mesh key={`sf${k}`} position={[b.x, b.h / 2, b.z]}>
          <boxGeometry args={[b.w, b.h, b.w * 0.8]} />
          <meshStandardMaterial color="#060A12" roughness={0.95} metalness={0.05} />
        </mesh>
      ))}
      {rooftopProps.antennas.map((a, k) => (
        <group key={`an${k}`}>
          <mesh position={[a.x, a.baseY + a.h / 2, a.z]}>
            <cylinderGeometry args={[0.018 * ws, 0.03 * ws, a.h, 5]} />
            <meshStandardMaterial color="#1A2334" roughness={0.6} metalness={0.5} />
          </mesh>
          <BlinkBeacon position={[a.x, a.baseY + a.h + 0.05 * ws, a.z]} color="#FF6B81" size={0.06 * ws} phase={stationJitter(k, 67) * Math.PI * 2} rate={2.2} />
        </group>
      ))}
      {rooftopProps.sheds.map((sh, k) => (
        <mesh key={`sh${k}`} position={[sh.x, sh.y, sh.z]}>
          <boxGeometry args={[sh.w, sh.h, sh.d]} />
          <meshStandardMaterial color="#101827" roughness={0.8} metalness={0.2} />
        </mesh>
      ))}
      <FloatingMotes count={80} center={new THREE.Vector3(0, 3.4 * ws, midZ)} spread={new THREE.Vector3(halfW * 1.9, 4.5 * ws, streetLen * 0.92)} ws={ws} color="#9FC2FF" opacity={0.22} size={0.05} speed={0.012} />
    </>
  );
};

// ====== 虚空包（CameraJourney3D 原样抽取：远景碑柱环 + 漂浮萤光） ======
const JourneyEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'ground' | 'axisY' | 'spanZ' | 'radiusX' | 'glow'>> = ({accent, ws, center, scale, seed}) => {
  const r = scale ?? 10;
  return (
    <>
      <MonolithRing count={9} center={center} radius={r + 9 * ws} ws={ws} color="#0D1322" edgeColor={accent} seed={seed ?? 71} />
      <FloatingMotes count={110} center={center} spread={new THREE.Vector3(r * 2.2, 7 * ws, r * 2.2)} ws={ws} color={accent} opacity={0.38} />
    </>
  );
};

// ====== 乡村包（新场景：暮色梯田丘陵 + 农舍炊烟 + 树丛草垛 + 萤火） ======
const CountrysideEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'glow' | 'seed' | 'scale' | 'accent'>> = ({ws, center, spanZ, radiusX, ground, axisY}) => {
  const nebTex = useRadialSprite();
  const midZ = center.z;
  const endZ = center.z - spanZ / 2;
  const eyeY = axisY ?? center.y;
  const groundW = Math.max(70, spanZ * 2.6);

  const hills = useMemo(() => {
    const items: {x: number; z: number; w: number; h: number; color: string}[] = [];
    for (let row = 0; row < 2; row++) {
      const far = row === 1;
      const n = far ? 7 : 5;
      for (let k = 0; k < n; k++) {
        const side = k % 2 === 0 ? -1 : 1;
        items.push({
          x: side * (radiusX + (far ? 16 : 7) + stationJitter(row * 97 + k, 361) * 8) * ws,
          z: midZ + spanZ / 2 - (k + stationJitter(row * 31 + k, 362) * 0.8) * (spanZ / n) + (far ? -14 * ws : 0),
          w: (9 + stationJitter(row * 53 + k, 363) * 8) * ws,
          h: (far ? 2.4 + stationJitter(row * 71 + k, 364) * 1.8 : 1.2 + stationJitter(row * 71 + k, 364) * 1.2) * ws,
          color: far ? '#131F0E' : '#1D2C16',
        });
      }
    }
    // 尽头横丘（收住远景）
    for (let k = 0; k < 4; k++) {
      items.push({x: (k - 1.5) * 14 * ws, z: endZ - (16 + stationJitter(k, 365) * 6) * ws, w: (13 + stationJitter(k, 366) * 7) * ws, h: (2.8 + stationJitter(k, 367) * 2.2) * ws, color: '#101A0B'});
    }
    return items;
  }, [radiusX, midZ, spanZ, endZ, ws]);

  const props = useMemo(() => {
    const houses: {x: number; z: number; ry: number}[] = [];
    const trees: {x: number; z: number; s: number}[] = [];
    const bales: {x: number; z: number}[] = [];
    const fields: {x: number; z: number; w: number; d: number; c: string}[] = [];
    const lens = spanZ + 10 * ws;
    for (let k = 0; k < 4; k++) {
      const side = k % 2 === 0 ? -1 : 1;
      houses.push({x: side * (radiusX + 3.2 + stationJitter(k, 371) * 2.4) * ws, z: midZ + lens / 2 - (k + 0.5) * (lens / 4), ry: stationJitter(k, 372) * Math.PI});
    }
    for (let k = 0; k < 14; k++) {
      const side = k % 2 === 0 ? -1 : 1;
      trees.push({x: side * (radiusX + 1.6 + stationJitter(k, 381) * 9) * ws, z: midZ + lens / 2 - stationJitter(k * 3 + 1, 382) * lens, s: (0.7 + stationJitter(k, 383) * 0.7) * ws});
    }
    for (let k = 0; k < 6; k++) {
      const side = stationJitter(k, 391) > 0.5 ? -1 : 1;
      bales.push({x: side * (radiusX + 2 + stationJitter(k, 392) * 3) * ws, z: midZ + lens / 2 - stationJitter(k * 7 + 2, 393) * lens});
    }
    for (let k = 0; k < 6; k++) {
      const side = k % 2 === 0 ? -1 : 1;
      fields.push({x: side * (radiusX + 4.5) * ws, z: midZ + lens / 2 - (k + 0.5) * (lens / 6), w: 4.5 * ws, d: lens / 7, c: ['#3A4A26', '#2F3D1F', '#465227'][k % 3]});
    }
    return {houses, trees, bales, fields};
  }, [radiusX, midZ, spanZ, ws]);

  return (
    <>
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, midZ]} receiveShadow>
          <planeGeometry args={[groundW, groundW]} />
          <meshStandardMaterial color="#24331B" roughness={0.95} metalness={0.02} />
        </mesh>
      )}
      {props.fields.map((f, k) => (
        <mesh key={`fd${k}`} rotation={[-Math.PI / 2, 0, 0]} position={[f.x, 0.01, f.z]}>
          <planeGeometry args={[f.w, f.d]} />
          <meshStandardMaterial color={f.c} roughness={0.95} metalness={0.02} />
        </mesh>
      ))}
      {hills.map((hl, k) => (
        <mesh key={`hl${k}`} position={[hl.x, 0, hl.z]} scale={[hl.w, hl.h, hl.w * 0.8]}>
          <sphereGeometry args={[0.5, 14, 10]} />
          <meshStandardMaterial color={hl.color} roughness={0.95} metalness={0.02} flatShading />
        </mesh>
      ))}
      {/* 农舍：盒体 + 四棱锥顶 + 暖窗 */}
      {props.houses.map((hs, k) => {
        const winA = stationJitter(k, 395) > 0.5 ? 0.31 : -0.31;
        return (
          <group key={`hs${k}`} position={[hs.x, 0, hs.z]} rotation={[0, hs.ry, 0]}>
            <mesh position={[0, 0.42 * ws, 0]}>
              <boxGeometry args={[1.35 * ws, 0.84 * ws, 1.0 * ws]} />
              <meshStandardMaterial color="#4A382A" roughness={0.9} metalness={0.05} />
            </mesh>
            <mesh position={[0, 1.05 * ws, 0]} rotation={[0, Math.PI / 4, 0]}>
              <coneGeometry args={[1.05 * ws, 0.6 * ws, 4]} />
              <meshStandardMaterial color="#5E3F2C" roughness={0.85} metalness={0.05} flatShading />
            </mesh>
            <mesh position={[winA * ws, 0.5 * ws, 0.51 * ws]}>
              <planeGeometry args={[0.2 * ws, 0.24 * ws]} />
              <meshBasicMaterial color="#FFD9A0" toneMapped={false} />
            </mesh>
          </group>
        );
      })}
      {props.trees.map((tr, k) => (
        <group key={`tr${k}`} position={[tr.x, 0, tr.z]}>
          <mesh position={[0, 0.45 * tr.s, 0]}>
            <cylinderGeometry args={[0.07 * tr.s, 0.1 * tr.s, 0.9 * tr.s, 6]} />
            <meshStandardMaterial color="#3A2B1C" roughness={0.95} />
          </mesh>
          <mesh position={[0, (0.9 + 0.4) * tr.s, 0]}>
            <icosahedronGeometry args={[0.62 * tr.s, 0]} />
            <meshStandardMaterial color="#22381A" roughness={0.95} flatShading />
          </mesh>
        </group>
      ))}
      {props.bales.map((bl, k) => (
        <mesh key={`bl${k}`} position={[bl.x, 0.3 * ws, bl.z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.3 * ws, 0.3 * ws, 0.55 * ws, 10]} />
          <meshStandardMaterial color="#6E5A34" roughness={0.95} flatShading />
        </mesh>
      ))}
      {/* 暮色低阳 + 霞光 */}
      <mesh position={[11 * ws, 4.6 * ws, endZ - 20 * ws]}>
        <circleGeometry args={[1.9 * ws, 32]} />
        <meshBasicMaterial color="#FFC98A" transparent opacity={0.9} toneMapped={false} />
      </mesh>
      <SoftSprite position={[11 * ws, 4.6 * ws, endZ - 20.5 * ws]} size={11 * ws} color="#E8896A" opacity={0.32} tex={nebTex} />
      <FloatingMotes count={60} center={new THREE.Vector3(0, Math.min(2.2 * ws, eyeY * 0.8), midZ)} spread={new THREE.Vector3(radiusX * 2.4, 3.2 * ws, spanZ * 1.1)} ws={ws} color="#FFD980" opacity={0.3} size={0.04} speed={0.01} />
    </>
  );
};

// ====== 古建包（新场景：宝塔飞檐 + 亭柱红灯笼 + 远山 + 满月） ======
const AncientEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'glow' | 'seed' | 'scale' | 'accent'>> = ({ws, center, spanZ, radiusX, ground, axisY}) => {
  const nebTex = useRadialSprite();
  const midZ = center.z;
  const endZ = center.z - spanZ / 2;
  const eyeY = axisY ?? center.y;
  const groundW = Math.max(70, spanZ * 2.6);

  /** 宝塔（五层檐，收顶）——远景地标 */
  const pagodas = useMemo(
    () => [
      {x: 0, z: endZ - 24 * ws, tiers: 5, s: 1.15},
      {x: -13 * ws, z: endZ - 30 * ws, tiers: 4, s: 0.85},
      {x: 14 * ws, z: endZ - 31 * ws, tiers: 3, s: 0.7},
    ],
    [endZ, ws],
  );
  /** 侧路亭子（平台 + 四柱 + 檐板 + 翘角） */
  const pavilions = useMemo(() => {
    const lens = spanZ + 8 * ws;
    return Array.from({length: 4}, (_, k) => ({
      x: (k % 2 === 0 ? -1 : 1) * (radiusX + 4.2) * ws,
      z: midZ + lens / 2 - (k + 0.5) * (lens / 4),
      ry: stationJitter(k, 401) * Math.PI,
    }));
  }, [radiusX, midZ, spanZ, ws]);
  /** 灯笼杆（走廊两侧；Frame 驱动轻摆） */
  const lanterns = useMemo(() => {
    const items: {x: number; z: number; phase: number}[] = [];
    const step = 6.2 * ws;
    for (let z = midZ + spanZ / 2 + 2 * ws; z > endZ - 2 * ws; z -= step) {
      items.push({x: -(radiusX + 0.8) * ws, z, phase: stationJitter(items.length, 411) * Math.PI * 2});
      items.push({x: (radiusX + 0.8) * ws, z: z - step / 2, phase: stationJitter(items.length + 400, 411) * Math.PI * 2});
    }
    return items;
  }, [radiusX, midZ, spanZ, endZ, ws]);
  const mountains = useMemo(
    () =>
      Array.from({length: 6}, (_, k) => ({
        x: (stationJitter(k, 421) - 0.5) * 2 * (radiusX + 26) * ws,
        z: endZ - (12 + stationJitter(k, 422) * 16) * ws,
        h: (5 + stationJitter(k, 423) * 7) * ws,
        r: (4 + stationJitter(k, 424) * 5) * ws,
      })),
    [radiusX, endZ, ws],
  );

  return (
    <>
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, midZ]} receiveShadow>
          <planeGeometry args={[groundW, groundW]} />
          <meshStandardMaterial color="#1B2130" roughness={0.6} metalness={0.25} />
        </mesh>
      )}
      {/* 满月 + 薄云 */}
      <mesh position={[-12 * ws, 12.5 * ws, endZ - 26 * ws]}>
        <circleGeometry args={[2.6 * ws, 40]} />
        <meshBasicMaterial color="#F2EAD3" transparent opacity={0.95} toneMapped={false} />
      </mesh>
      <SoftSprite position={[-12 * ws, 12.5 * ws, endZ - 26.5 * ws]} size={9 * ws} color="#C9C2E8" opacity={0.22} tex={nebTex} />
      {mountains.map((m, k) => (
        <PeakCluster key={`mt${k}`} x={m.x} z={m.z} h={m.h} r={m.r} seed={k * 7 + 3} color="#141A38" />
      ))}
      {pagodas.map((pg, pi) => (
        <group key={`pg${pi}`} position={[pg.x, 0, pg.z]}>
          {Array.from({length: pg.tiers}, (_, t) => {
            const w = (2.7 - t * 0.34) * pg.s * ws;
            const y = (t * 1.06 + 0.5) * pg.s * ws;
            return (
              <group key={`t${t}`}>
                <mesh position={[0, y, 0]}>
                  <boxGeometry args={[w * 0.66, 0.78 * pg.s * ws, w * 0.66]} />
                  <meshStandardMaterial color="#1B2440" roughness={0.85} metalness={0.1} />
                </mesh>
                <mesh position={[0, y + 0.52 * pg.s * ws, 0]}>
                  <boxGeometry args={[w, 0.14 * pg.s * ws, w]} />
                  <meshStandardMaterial color="#2A3452" roughness={0.8} metalness={0.15} />
                </mesh>
                {/* 檐角上翘（四角小方块斜置） */}
                {[
                  [1, 1],
                  [1, -1],
                  [-1, 1],
                  [-1, -1],
                ].map(([sx, sz], ci) => (
                  <mesh key={`c${ci}`} position={[(sx * w) / 2, y + 0.62 * pg.s * ws, (sz * w) / 2]} rotation={[sz * 0.42, 0, -sx * 0.42]}>
                    <boxGeometry args={[0.22 * pg.s * ws, 0.05 * pg.s * ws, 0.22 * pg.s * ws]} />
                    <meshStandardMaterial color="#2A3452" roughness={0.8} />
                  </mesh>
                ))}
              </group>
            );
          })}
          <mesh position={[0, (pg.tiers * 1.06 + 0.8) * pg.s * ws, 0]}>
            <cylinderGeometry args={[0.03 * ws, 0.05 * ws, 0.7 * pg.s * ws, 6]} />
            <meshStandardMaterial color="#3A4568" roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[0, (pg.tiers * 1.06 + 1.2) * pg.s * ws, 0]}>
            <sphereGeometry args={[0.09 * pg.s * ws, 10, 10]} />
            <meshBasicMaterial color="#FFD9A0" toneMapped={false} />
          </mesh>
        </group>
      ))}
      {pavilions.map((pv, k) => (
        <group key={`pv${k}`} position={[pv.x, 0, pv.z]} rotation={[0, pv.ry, 0]}>
          <mesh position={[0, 0.16 * ws, 0]}>
            <boxGeometry args={[2.0 * ws, 0.32 * ws, 1.6 * ws]} />
            <meshStandardMaterial color="#232C48" roughness={0.85} />
          </mesh>
          {[
            [0.8, 0.55],
            [0.8, -0.55],
            [-0.8, 0.55],
            [-0.8, -0.55],
          ].map(([cx, cz], ci) => (
            <mesh key={`col${ci}`} position={[cx * ws, 1.05 * ws, cz * ws]}>
              <cylinderGeometry args={[0.07 * ws, 0.08 * ws, 1.6 * ws, 8]} />
              <meshStandardMaterial color="#3A2B1E" roughness={0.9} />
            </mesh>
          ))}
          <mesh position={[0, 2.0 * ws, 0]}>
            <boxGeometry args={[2.5 * ws, 0.14 * ws, 2.1 * ws]} />
            <meshStandardMaterial color="#2A3452" roughness={0.8} />
          </mesh>
        </group>
      ))}
      {/* 红灯笼杆（Frame 驱动轻摆 + 光晕） */}
      {lanterns.map((lp, k) => (
        <LanternPole key={`lt${k}`} x={lp.x} z={lp.z} phase={lp.phase} ws={ws} nebTex={nebTex} />
      ))}
      <FloatingMotes count={50} center={new THREE.Vector3(0, Math.min(2.4 * ws, eyeY * 0.9), midZ)} spread={new THREE.Vector3(radiusX * 2.6, 4 * ws, spanZ * 1.1)} ws={ws} color="#9FB0E8" opacity={0.14} size={0.045} speed={0.008} />
    </>
  );
};

/** 灯笼杆（轻摆 + 红笼 + 暖光晕；独立组件收拢 useFrame） */
const LanternPole: React.FC<{x: number; z: number; phase: number; ws: number; nebTex: THREE.CanvasTexture}> = ({x, z, phase, ws, nebTex}) => {
  const ref = useRef<THREE.Group>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (ref.current) ref.current.rotation.z = Math.sin((frame / FPS) * 1.1 + phase) * 0.045;
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 1.15 * ws, 0]}>
        <cylinderGeometry args={[0.035 * ws, 0.05 * ws, 2.3 * ws, 6]} />
        <meshStandardMaterial color="#2A2118" roughness={0.9} />
      </mesh>
      <group ref={ref} position={[0, 2.32 * ws, 0]}>
        <mesh>
          <sphereGeometry args={[0.17 * ws, 12, 12]} />
          <meshStandardMaterial color="#FF5A4E" emissive="#FF5A4E" emissiveIntensity={1.1} roughness={0.4} />
        </mesh>
        <mesh position={[0, -0.2 * ws, 0]}>
          <boxGeometry args={[0.03 * ws, 0.14 * ws, 0.03 * ws]} />
          <meshStandardMaterial color="#C9A038" roughness={0.7} />
        </mesh>
        <SoftSprite position={[0, 0, 0]} size={1.15 * ws} color="#FF6A55" opacity={0.2} tex={nebTex} />
      </group>
    </group>
  );
};

// ====== 山水包（新场景：青绿叠嶂 + 水面涟漪 + 山脚雾团） ======
const LandscapeEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'glow' | 'seed' | 'scale'>> = ({accent, ws, center, spanZ, radiusX, ground}) => {
  const nebTex = useRadialSprite();
  const midZ = center.z;
  const endZ = center.z - spanZ / 2;
  const groundW = Math.max(80, spanZ * 2.8);

  /** 近/中两层山体簇（千里江山配色）；远黛交给双环形山脊带 */
  const clusters = useMemo(() => {
    const rows: {color: string; n: number; xSpread: number; zBase: number; zSpread: number; hLo: number; hHi: number}[] = [
      {color: '#1B5560', n: 5, xSpread: 18, zBase: 8, zSpread: 10, hLo: 4, hHi: 8},
      {color: '#226B5E', n: 4, xSpread: 12, zBase: 1, zSpread: 6, hLo: 2, hHi: 4.6},
    ];
    const peaks: {x: number; z: number; h: number; r: number; seed: number; color: string}[] = [];
    rows.forEach((row, ri) => {
      for (let k = 0; k < row.n; k++) {
        const side = k % 2 === 0 ? -1 : 1;
        const h = (row.hLo + stationJitter(ri * 101 + k, 431) * (row.hHi - row.hLo)) * ws;
        peaks.push({
          x: side * (radiusX + 2.5 + stationJitter(ri * 57 + k, 432) * row.xSpread) * ws,
          z: endZ + row.zBase * ws - stationJitter(ri * 77 + k, 433) * row.zSpread * ws - (k / row.n) * spanZ * 0.22,
          h,
          r: h * (0.7 + stationJitter(ri * 31 + k, 434) * 0.5),
          seed: ri * 41 + k * 7 + 5,
          color: row.color,
        });
      }
    });
    return peaks;
  }, [radiusX, endZ, spanZ, ws]);
  /** 远景双环山脊：包住全场，任意机位都是连续叠嶂（半径罩住轴向跨度） */
  const ringR1 = Math.max(radiusX + 15 * ws, spanZ * 0.62 + 6 * ws);
  const ringR2 = ringR1 + 11 * ws;

  const ripples = useMemo(
    () =>
      Array.from({length: 5}, (_, k) => ({
        x: (stationJitter(k, 441) - 0.5) * 2 * (radiusX + 2) * ws,
        z: midZ + spanZ / 2 - stationJitter(k * 5 + 3, 442) * (spanZ + 8 * ws),
        r: (1.6 + stationJitter(k, 443) * 3.2) * ws,
        op: 0.1 + stationJitter(k, 444) * 0.1,
      })),
    [radiusX, midZ, spanZ, ws],
  );

  return (
    <>
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, midZ]} receiveShadow>
          <planeGeometry args={[groundW, groundW]} />
          <meshStandardMaterial color="#0E3944" roughness={0.16} metalness={0.72} />
        </mesh>
      )}
      {clusters.map((p, k) => (
        <PeakCluster key={`pk${k}`} x={p.x} z={p.z} h={p.h} r={p.r} seed={p.seed} color={p.color} />
      ))}
      <RidgeRing radius={ringR1} height={6.2 * ws} seed={17} color="#17495A" />
      <RidgeRing radius={ringR2} height={9.5 * ws} seed={53} color="#0F3140" />
      {ripples.map((rp, k) => (
        <mesh key={`rp${k}`} rotation={[-Math.PI / 2, 0, 0]} position={[rp.x, 0.02, rp.z]}>
          <torusGeometry args={[rp.r, 0.02 * ws, 6, 48]} />
          <meshBasicMaterial color={accent} transparent opacity={rp.op} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
      {/* 山脚雾团 + 远日 */}
      <SoftSprite position={[-radiusX - 8 * ws, 1.1 * ws, endZ - 6 * ws]} size={16 * ws} color="#BFE3DC" opacity={0.12} tex={nebTex} />
      <SoftSprite position={[radiusX + 9 * ws, 0.9 * ws, endZ - 12 * ws]} size={14 * ws} color="#BFE3DC" opacity={0.1} tex={nebTex} rot={0.8} />
      <SoftSprite position={[0, 1.4 * ws, endZ - 20 * ws]} size={22 * ws} color="#9CC8C0" opacity={0.08} tex={nebTex} rot={0.4} />
      <mesh position={[-14 * ws, 11 * ws, endZ - 30 * ws]}>
        <circleGeometry args={[1.6 * ws, 32]} />
        <meshBasicMaterial color="#F7E9C0" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </>
  );
};

// ====== 水墨包（新场景：亮色纸底 + 墨色叠嶂 + 孤舟 + 印章；light 场景） ======
const InkwashEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'glow' | 'seed' | 'scale' | 'accent'>> = ({ws, center, spanZ, radiusX, ground}) => {
  const midZ = center.z;
  const endZ = center.z - spanZ / 2;
  const groundW = Math.max(80, spanZ * 2.8);

  /** 近景墨峰簇（浓墨 0.38）；远山交给两道淡墨环形山脊（层层退晕） */
  const nearPeaks = useMemo(() => {
    const peaks: {x: number; z: number; h: number; r: number; seed: number}[] = [];
    for (let k = 0; k < 4; k++) {
      const side = k % 2 === 0 ? -1 : 1;
      const h = (2 + stationJitter(k, 451) * 2.6) * ws;
      peaks.push({
        x: side * (radiusX + 2.5 + stationJitter(k, 452) * 8) * ws,
        z: endZ + 4 * ws - stationJitter(k, 453) * 7 * ws - (k / 4) * spanZ * 0.18,
        h,
        r: h * (0.65 + stationJitter(k, 454) * 0.5),
        seed: k * 7 + 9,
      });
    }
    return peaks;
  }, [radiusX, endZ, spanZ, ws]);
  const inkRingR1 = Math.max(radiusX + 13 * ws, spanZ * 0.6 + 5 * ws);
  const inkRingR2 = inkRingR1 + 10 * ws;

  /** 点苔（山脚墨点） */
  const inkDots = useMemo(() => {
    const count = 44;
    const arr = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      arr[k * 3] = (stationJitter(k, 461) - 0.5) * 2 * (radiusX + 20) * ws;
      arr[k * 3 + 1] = 0.06 * ws + stationJitter(k, 462) * 0.5 * ws;
      arr[k * 3 + 2] = endZ + 4 * ws - stationJitter(k, 463) * (spanZ + 12 * ws);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, [radiusX, endZ, spanZ, ws]);
  useEffect(() => () => inkDots.dispose(), [inkDots]);

  return (
    <>
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, midZ]}>
          <planeGeometry args={[groundW, groundW]} />
          <meshStandardMaterial color="#E7E1D0" roughness={0.4} metalness={0.15} />
        </mesh>
      )}
      {nearPeaks.map((p, k) => (
        <InkHillCluster key={`ik${k}`} x={p.x} z={p.z} h={p.h} r={p.r} seed={p.seed} color="#2B313D" opacity={0.38} />
      ))}
      <RidgeRing radius={inkRingR1} height={5.6 * ws} seed={29} color="#3A4150" opacity={0.22} basic />
      <RidgeRing radius={inkRingR2} height={8.4 * ws} seed={61} color="#434B5A" opacity={0.13} basic />
      <points geometry={inkDots}>
        <pointsMaterial color="#3A4150" size={0.07 * ws} sizeAttenuation transparent opacity={0.3} toneMapped={false} depthWrite={false} />
      </points>
      {/* 孤舟（Frame 驱动微晃）+ 舟人 */}
      <InkBoat x={3.6 * ws} z={midZ + spanZ * 0.18} ws={ws} />
      {/* 朱砂印章（远景点睛） */}
      <mesh position={[(radiusX + 7) * ws, 5.2 * ws, endZ - 14 * ws]} rotation={[0.1, 0.4, 0.06]}>
        <boxGeometry args={[0.34 * ws, 0.34 * ws, 0.07 * ws]} />
        <meshBasicMaterial color="#C0392B" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </>
  );
};

/** 水墨孤舟（独立组件收拢 useFrame；禁 Clock） */
const InkBoat: React.FC<{x: number; z: number; ws: number}> = ({x, z, ws}) => {
  const ref = useRef<THREE.Group>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (!ref.current) return;
    const t = frame / FPS;
    ref.current.position.y = Math.sin(t * 0.9) * 0.02 * ws;
    ref.current.rotation.z = Math.sin(t * 0.7 + 1.2) * 0.02;
  });
  return (
    <group ref={ref} position={[x, 0.08 * ws, z]} rotation={[0, 0.5, 0]}>
      <mesh>
        <boxGeometry args={[1.25 * ws, 0.07 * ws, 0.3 * ws]} />
        <meshBasicMaterial color="#3B404C" transparent opacity={0.75} toneMapped={false} />
      </mesh>
      <mesh position={[-0.3 * ws, 0.14 * ws, 0]}>
        <boxGeometry args={[0.05 * ws, 0.24 * ws, 0.03 * ws]} />
        <meshBasicMaterial color="#3B404C" transparent opacity={0.75} toneMapped={false} />
      </mesh>
      <mesh position={[0.42 * ws, 0.12 * ws, 0]}>
        <sphereGeometry args={[0.05 * ws, 8, 8]} />
        <meshBasicMaterial color="#23272F" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </group>
  );
};

/** 水墨圆弧山头几何：幂曲线轮廓（圆顶缓坡，水墨远山味）+ 角向确定性扰动 */
const hillGeometry = (h: number, r: number, seed: number): THREE.BufferGeometry => {
  const pts: THREE.Vector2[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = r * Math.pow(t, 1.7) * (0.9 + 0.2 * stationJitter(seed * 7 + i, 495));
    pts.push(new THREE.Vector2(Math.max(0.001, x), h * (1 - t)));
  }
  return new THREE.LatheGeometry(pts, 22);
};

/** 水墨山头簇（主头 + 侧头，basic 剪影 + 透明度层染） */
const InkHillCluster: React.FC<{x: number; z: number; h: number; r: number; seed: number; color: string; opacity: number}> = ({x, z, h, r, seed, color, opacity}) => {
  const geoms = useMemo(() => {
    const j1 = stationJitter(seed, 497);
    return [
      hillGeometry(h, r, seed),
      hillGeometry(h * (0.5 + j1 * 0.24), r * (0.52 + j1 * 0.14), seed + 5),
    ];
  }, [h, r, seed]);
  useEffect(() => () => geoms.forEach((g) => g.dispose()), [geoms]);
  return (
    <group position={[x, 0, z]}>
      <mesh geometry={geoms[0]}>
        <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geoms[1]} position={[r * (0.62 + stationJitter(seed, 498) * 0.4), 0, -0.25 * r]}>
        <meshBasicMaterial color={color} transparent opacity={opacity * 0.85} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
};

// ====== 棱镜包（新场景：三色光幕柱 + 漂浮棱镜晶体 + 萤光；高能量发布会舞台，
//        DOM 底 = 注册表里的竖向三色条带，3D 件只做空间纵深） ======
const PRISM_HUES = ['#2DD4BF', '#E879F9', '#A78BFA'];
const PrismEnv: React.FC<Omit<SceneEnvProps, 'scene' | 'axisY' | 'seed'>> = ({accent, ws, center, spanZ, radiusX, ground, glow = 1, scale}) => {
  const nebTex = useRadialSprite();
  const dim = glow === 0 ? 0.45 : glow === 2 ? 1.3 : 1;
  const ringR = Math.max(scale ?? 0, radiusX + 9 * ws);

  /** 光幕柱：三色轮换环场一圈，竖向圆管加色混合（任意机位都是彩柱，无 billboard 依赖） */
  const beams = useMemo(
    () =>
      Array.from({length: 12}, (_, k) => {
        const a = (k / 12) * Math.PI * 2 + stationJitter(k, 501) * 0.26;
        return {
          x: center.x + Math.cos(a) * (ringR + stationJitter(k, 502) * 4 * ws),
          z: center.z + Math.sin(a) * (ringR + stationJitter(k, 503) * 4 * ws),
          h: (10 + stationJitter(k, 504) * 8) * ws,
          w: (0.28 + stationJitter(k, 505) * 0.3) * ws,
          color: PRISM_HUES[k % 3],
        };
      }),
    [center, ringR, ws],
  );
  /** 漂浮棱镜晶体（八面体，暗体+彩色自发光，SlowSpin 整组慢旋；体量对标城市楼窗级可见度） */
  const shards = useMemo(
    () =>
      Array.from({length: 8}, (_, k) => ({
        pos: new THREE.Vector3(
          center.x + (stationJitter(k + 70, 511) - 0.5) * 2 * (radiusX + 5) * ws,
          center.y + (stationJitter(k + 76, 512) - 0.3) * 7 * ws,
          center.z + (stationJitter(k + 82, 513) - 0.5) * Math.max(spanZ * 0.9, 14) * ws,
        ),
        s: (0.5 + stationJitter(k + 88, 514) * 0.8) * ws,
        rot: stationJitter(k + 94, 515) * Math.PI,
        color: PRISM_HUES[k % 3],
      })),
    [center, radiusX, spanZ, ws],
  );

  return (
    <>
      {ground && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, center.z]} receiveShadow>
          <planeGeometry args={[Math.max(70, spanZ * 2.6), Math.max(70, spanZ * 2.6)]} />
          <meshStandardMaterial color="#140E26" roughness={0.24} metalness={0.66} />
        </mesh>
      )}
      {beams.map((b, k) => (
        <mesh key={`bm${k}`} position={[b.x, b.h / 2, b.z]}>
          <cylinderGeometry args={[b.w, b.w, b.h, 6, 1, true]} />
          <meshBasicMaterial color={b.color} transparent opacity={0.34 * dim} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <SlowSpin speed={0.01}>
        {shards.map((sd, k) => (
          <mesh key={`sd${k}`} position={sd.pos} rotation={[sd.rot, sd.rot * 1.6, 0]}>
            <octahedronGeometry args={[sd.s, 0]} />
            <meshStandardMaterial color="#191233" roughness={0.3} metalness={0.5} emissive={sd.color} emissiveIntensity={0.85 * dim} flatShading />
          </mesh>
        ))}
      </SlowSpin>
      {beams
        .filter((_, k) => k % 2 === 0)
        .map((b, k) => (
          <SoftSprite key={`bg${k}`} position={[b.x, b.h * 0.72, b.z]} size={5 * ws} color={b.color} opacity={0.22 * dim} tex={nebTex} />
        ))}
      <FloatingMotes count={90} center={new THREE.Vector3(0, center.y * 0.9, center.z)} spread={new THREE.Vector3((radiusX + 8) * ws, 6 * ws, Math.max(spanZ * 0.8, 12) * ws)} ws={ws} color={accent} opacity={0.3} size={0.05} speed={0.011} />
    </>
  );
};

// ====== 纯净包：不加环境件（封闭/自备地板模板的原生观感） ======
const PlainEnv = (): null => null;

const THREE_SCENE_ID = (i: number): string => THREE_SCENES[i]?.id ?? 'plain';

/** 场景调度：按注册表下标分发到场景包（包组件各自 hook，互不影响） */
export const SceneEnv: React.FC<SceneEnvProps> = ({scene, ...rest}) => {
  const id = THREE_SCENE_ID(clampSceneIndex(scene));
  switch (id) {
    case 'star':
      return <StarEnv accent={rest.accent} ws={rest.ws} center={rest.center} glow={rest.glow} />;
    case 'galaxy':
      return <GalaxyEnv accent={rest.accent} ws={rest.ws} center={rest.center} glow={rest.glow} />;
    case 'city':
      return <CityEnv accent={rest.accent} ws={rest.ws} center={rest.center} spanZ={rest.spanZ} radiusX={rest.radiusX} ground={rest.ground} glow={rest.glow} />;
    case 'journey':
      return <JourneyEnv accent={rest.accent} ws={rest.ws} center={rest.center} scale={rest.scale} seed={rest.seed} />;
    case 'countryside':
      return <CountrysideEnv ws={rest.ws} center={rest.center} spanZ={rest.spanZ} radiusX={rest.radiusX} ground={rest.ground} axisY={rest.axisY} />;
    case 'ancient':
      return <AncientEnv ws={rest.ws} center={rest.center} spanZ={rest.spanZ} radiusX={rest.radiusX} ground={rest.ground} axisY={rest.axisY} />;
    case 'landscape':
      return <LandscapeEnv accent={rest.accent} ws={rest.ws} center={rest.center} spanZ={rest.spanZ} radiusX={rest.radiusX} ground={rest.ground} />;
    case 'inkwash':
      return <InkwashEnv ws={rest.ws} center={rest.center} spanZ={rest.spanZ} radiusX={rest.radiusX} ground={rest.ground} />;
    case 'prism':
      return <PrismEnv accent={rest.accent} ws={rest.ws} center={rest.center} spanZ={rest.spanZ} radiusX={rest.radiusX} ground={rest.ground} glow={rest.glow} scale={rest.scale} />;
    default:
      return <PlainEnv />;
  }
};

/** 场景 DOM 背景渐变（null = 模板保持原默认背景） */
export const sceneBackdrop = (scene: number): string | null => THREE_SCENES[clampSceneIndex(scene)]?.css ?? null;
