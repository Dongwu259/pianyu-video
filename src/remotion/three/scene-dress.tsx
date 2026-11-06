/**
 * scene-dress - 3D 场景模板共享装饰件（v27 观感升级：曲线连接线 / 背景元素 / 街景动态）
 *
 * 设计约束（与 rig-utils/panel-timeline 同族）：
 * - 帧驱动确定性：几何全部由 stationJitter 整数哈希派生，动效只吃 useCurrentFrame（禁 Clock/delta），
 *   逐帧渲染可复现；
 * - 零加载：不用外部模型/贴图，程序化低段数几何（box/tube/points），渲染器零等待；
 * - hook 安全：挂载数量只取决于模板自己的场景常量，与媒体增删无关（不碰 MAX_PANELS 规则）。
 *
 * 背景：用户复核「场景和模型太粗糙、板间连线完全是直线、背景缺元素、连接线要更多且数量可调」——
 * 本模块给七款 3D 场景模板提供统一的曲线连接线（数量参数化）与背景丰富度件。
 */
import React, {useEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {useCurrentFrame} from 'remotion';
import {useFrame} from '@react-three/fiber';
import {stationJitter} from './rig-utils';
import {FPS} from '../config/resolutions';

/** 二次贝塞尔弧管中点：a→b 的柔和曲线经 a、中点+bow、b 三点（弓出去多少一眼可调） */
export const arcMid = (a: THREE.Vector3, b: THREE.Vector3, bow: THREE.Vector3): THREE.Vector3 =>
  a.clone().add(b).multiplyScalar(0.5).add(bow);

/** 弧管几何：统一做法的「柔和曲线连接线」 */
export const arcTubeGeometry = (a: THREE.Vector3, b: THREE.Vector3, bow: THREE.Vector3, radius: number, tubularSegments = 36, radialSegments = 6): THREE.TubeGeometry =>
  new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a.clone(), arcMid(a, b, bow), b.clone()), tubularSegments, radius, radialSegments, false);

/**
 * 连接对挑选（确定性）：相邻板优先，其次跨 2、跨 3……直到取满 count。
 * count 钳到可用上限；n<2 返回空。「多几根且数量可调」的统一语义。
 */
export const pickLinkPairs = (n: number, count: number): Array<[number, number]> => {
  const pairs: Array<[number, number]> = [];
  if (n < 2) return pairs;
  for (let skip = 1; skip < n; skip++) {
    for (let i = 0; i + skip < n; i++) pairs.push([i, i + skip]);
  }
  return pairs.slice(0, Math.max(0, Math.min(pairs.length, Math.round(count))));
};

/**
 * 板间连接弧线（数量参数化）：anchors 之间按 pickLinkPairs 拉柔和弧管，
 * 弓高 = 弦长 × bowScale × 站级微差（默认向上弓）。透明低扰动，不 depthWrite。
 */
export const LinkArcs: React.FC<{
  anchors: THREE.Vector3[];
  count: number;
  radius: number;
  color: string;
  opacity: number;
  ws: number;
  /** 站级微差 salt（同场景多组弧线时错开） */
  salt?: number;
  /** 弓高比例（默认 0.22；星图连线用小值 0.08-0.12） */
  bowScale?: number;
}> = ({anchors, count, radius, color, opacity, salt = 71, bowScale = 0.22}) => {
  const geoms = useMemo(
    () =>
      pickLinkPairs(anchors.length, count).map(([i, j], k) => {
        const a = anchors[i];
        const b = anchors[j];
        const bow = new THREE.Vector3(0, a.distanceTo(b) * bowScale * (0.75 + 0.5 * stationJitter(k, salt)), 0);
        return arcTubeGeometry(a, b, bow, radius);
      }),
    [anchors, count, radius, salt, bowScale],
  );
  useEffect(() => () => geoms.forEach((g) => g.dispose()), [geoms]);
  return (
    <>
      {geoms.map((g, k) => (
        <mesh key={`la${k}`} geometry={g}>
          <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
};

/** 漂浮微粒（星尘/尘埃/萤光通用）：确定性点云 + 整组慢旋 + 上下缓浮 */
export const FloatingMotes: React.FC<{
  count?: number;
  center: THREE.Vector3;
  spread: THREE.Vector3;
  ws: number;
  color: string;
  opacity?: number;
  size?: number;
  speed?: number;
}> = ({count = 90, center, spread, ws, color, opacity = 0.4, size = 0.055, speed = 0.02}) => {
  const geom = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
      arr[k * 3] = (stationJitter(k, 301) - 0.5) * spread.x;
      arr[k * 3 + 1] = (stationJitter(k, 302) - 0.5) * spread.y;
      arr[k * 3 + 2] = (stationJitter(k, 303) - 0.5) * spread.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    return g;
  }, [count, spread]);
  useEffect(() => () => geom.dispose(), [geom]);
  const ref = useRef<THREE.Points>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (!ref.current) return;
    const t = frame / FPS;
    ref.current.rotation.y = t * speed;
    ref.current.position.y = center.y + Math.sin(t * 0.22) * 0.18 * ws;
  });
  return (
    <points ref={ref} geometry={geom} position={[center.x, center.y, center.z]}>
      <pointsMaterial color={color} size={size * ws} sizeAttenuation transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </points>
  );
};

/**
 * 远景碑柱环（旅程/开阔场景的背景体量）：暗色碑柱 + accent 棱线，绕场慢旋 + 整组缓浮。
 * 只做远景（radius 够大），不进相机航线。
 */
export const MonolithRing: React.FC<{
  count: number;
  center: THREE.Vector3;
  radius: number;
  ws: number;
  color: string;
  edgeColor: string;
  seed: number;
  height?: [number, number];
}> = ({count, center, radius, ws, color, edgeColor, seed, height = [2.2, 6.5]}) => {
  const items = useMemo(
    () =>
      Array.from({length: count}, (_, k) => {
        const angle = stationJitter(seed + k * 7, 311) * Math.PI * 2;
        const r = radius * (0.72 + stationJitter(seed + k * 11, 312) * 0.55);
        const h = (height[0] + stationJitter(seed + k * 13, 313) * (height[1] - height[0])) * ws;
        const w = (0.45 + stationJitter(seed + k * 17, 314) * 0.95) * ws;
        return {angle, r, h, w, y0: center.y + (stationJitter(seed + k * 19, 315) - 0.35) * 2.4 * ws};
      }),
    [count, center, radius, ws, seed, height],
  );
  const geoms = useMemo(() => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(box);
    return {box, edges};
  }, []);
  useEffect(
    () => () => {
      geoms.box.dispose();
      geoms.edges.dispose();
    },
    [geoms],
  );
  const ref = useRef<THREE.Group>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (!ref.current) return;
    const t = frame / FPS;
    ref.current.rotation.y = t * 0.01;
    ref.current.position.y = Math.sin(t * 0.25) * 0.15 * ws;
  });
  return (
    <group ref={ref} position={[center.x, 0, center.z]}>
      {items.map((it, k) => {
        const x = Math.sin(it.angle) * it.r;
        const z = Math.cos(it.angle) * it.r;
        return (
          <group key={`mo${k}`} position={[x, it.y0, z]} rotation={[0, it.angle, 0]}>
            <mesh geometry={geoms.box} scale={[it.w, it.h, it.w * (0.6 + stationJitter(seed + k * 23, 316) * 0.8)]}>
              <meshStandardMaterial color={color} roughness={0.85} metalness={0.2} transparent opacity={0.92} />
            </mesh>
            <lineSegments geometry={geoms.edges} scale={[it.w * 1.001, it.h * 1.001, it.w * 1.001]}>
              <lineBasicMaterial color={edgeColor} transparent opacity={0.3} toneMapped={false} />
            </lineSegments>
          </group>
        );
      })}
    </group>
  );
};

/**
 * 平移光轨（城市车流/隧道流光）：细长发光条沿 z 循环滑动。确定性：位置是
 * tSec × speed 对 span 取模的纯函数，无随机游走。
 */
export interface StreakLane {
  x: number;
  color: string;
  speed: number;
}
export const TrafficStreaks: React.FC<{
  count: number;
  lanes: StreakLane[];
  zFrom: number;
  zTo: number;
  y: number;
  ws: number;
  seed?: number;
}> = ({count, lanes, zFrom, zTo, y, ws, seed = 321}) => {
  const span = Math.abs(zFrom - zTo);
  const items = useMemo(
    () =>
      Array.from({length: count}, (_, k) => {
        const lane = lanes[k % lanes.length];
        return {
          x: lane.x,
          color: lane.color,
          speed: lane.speed * (0.8 + stationJitter(seed + k * 7, 322) * 0.5),
          phase: stationJitter(seed + k * 11, 323) * span,
          len: (1.5 + stationJitter(seed + k * 13, 324) * 1.6) * ws,
        };
      }),
    [count, lanes, span, ws, seed],
  );
  const refs = useRef<Array<THREE.Mesh | null>>([]);
  const frame = useCurrentFrame();
  useFrame(() => {
    const t = frame / FPS;
    items.forEach((it, k) => {
      const m = refs.current[k];
      if (!m) return;
      const z = zFrom - ((it.phase + t * it.speed) % span);
      m.position.set(it.x, y, z);
    });
  });
  return (
    <>
      {items.map((it, k) => (
        <mesh key={`ts${k}`} ref={(m) => { refs.current[k] = m; }}>
          <boxGeometry args={[0.09 * ws, 0.03 * ws, it.len]} />
          <meshBasicMaterial color={it.color} transparent opacity={0.75} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
};

/** 眩灯闪烁珠（楼顶航空灯/路灯珠）：opacity = 0.35~1 正弦呼吸，相位按 seed 错开 */
export const BlinkBeacon: React.FC<{position: [number, number, number]; color: string; size: number; phase: number; rate?: number}> = ({position, color, size, phase, rate = 2.1}) => {
  const ref = useRef<THREE.MeshBasicMaterial>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (ref.current) ref.current.opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((frame / FPS) * rate + phase));
  });
  return (
    <mesh position={position}>
      <sphereGeometry args={[size, 10, 10]} />
      <meshBasicMaterial ref={ref} color={color} transparent toneMapped={false} />
    </mesh>
  );
};

/** 轨道光点（环台卫星/能量珠）：绕原点圆周运动的发光小球，位置是 t 的纯函数 */
export const OrbitingDot: React.FC<{radius: number; y: number; omega: number; phase: number; ws: number; color: string; size?: number; opacity?: number}> = ({radius, y, omega, phase, ws, color, size = 0.08, opacity = 0.85}) => {
  const ref = useRef<THREE.Mesh>(null);
  const frame = useCurrentFrame();
  useFrame(() => {
    if (!ref.current) return;
    const t = frame / FPS;
    ref.current.position.set(Math.cos(t * omega + phase) * radius, y, Math.sin(t * omega + phase) * radius);
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[size * ws, 10, 10]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} depthWrite={false} />
    </mesh>
  );
};

// ====== 旅程路径（CameraJourney3D 抽出为纯函数，单测可锚定曲率） ======
const JOURNEY_WIND_AMP = [0.35, 0.7, 1.1]; // pathWind：0 平缓弧线 / 1 标准 / 2 大摆
const JOURNEY_CONTROL_POINTS = 9; // v27：6 → 9（板间必弯的基础密度）

/**
 * 旅程路径控制点（纯函数）。v27 关键改动：偏转符号带惯性（约 65% 延续 / 35% 反转）——
 * 旧版 6 控制点 + 符号严格交替，路径整体呈「之」字回正，相邻站位之间常出现近似直线段；
 * 新版 9 点 + 符号惯性让曲率方向持续变化，配合单测「相邻站位弦偏差 > 阈值」锚定板间必弯。
 */
export const journeyControlPoints = (contentSeed: number, wind: number, ws: number): THREE.Vector3[] => {
  const amp = JOURNEY_WIND_AMP[Math.min(2, Math.max(0, wind))];
  const pts: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
  let heading = 0;
  let side = stationJitter(contentSeed, 61) > 0.5 ? 1 : -1;
  for (let k = 0; k < JOURNEY_CONTROL_POINTS - 1; k++) {
    if (stationJitter(contentSeed + k * 17, 62) > 0.65) side = -side;
    heading += (0.45 + stationJitter(contentSeed + k * 31, 63) * 0.5) * amp * side;
    const len = (7 + stationJitter(contentSeed + k * 41, 64) * 5) * ws;
    const prev = pts[pts.length - 1];
    const next = prev.clone().add(new THREE.Vector3(Math.sin(heading) * len, 0, -Math.cos(heading) * len));
    next.y = THREE.MathUtils.clamp(prev.y + (stationJitter(contentSeed + k * 43, 65) - 0.5) * 1.1 * ws, -0.9, 0.9);
    pts.push(next);
  }
  return pts;
};

/**
 * 地面涟漪环（v9「画面丰富」动效包·产品展示签名件）：发光圆环从主体脚下周期性
 * 扩散、放大渐隐。确定性纯函数：逐环相位 = fract(t/rate + k/count)，
 * easeOutCubic 扩散、二次方渐隐；几何固定 maxR 一份、环成长用 scale 表达（零分配）。
 */
export const GroundRipple: React.FC<{
  y: number;
  color: string;
  ws: number;
  maxR?: number;
  rate?: number;
  count?: number;
  opacity?: number;
  innerR?: number;
}> = ({y, color, ws, maxR = 3.2, rate = 2.4, count = 3, opacity = 0.5, innerR = 0.88}) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const geom = useMemo(() => {
    const g = new THREE.RingGeometry(maxR * ws * innerR, maxR * ws, 48);
    return g;
  }, [maxR, ws, innerR]);
  useEffect(() => () => geom.dispose(), [geom]);
  const rings = Array.from({length: count}, (_, k) => {
    const phase = (t / rate + k / count) % 1;
    const eased = 1 - Math.pow(1 - phase, 3);
    return {k, s: 0.18 + 0.82 * eased, o: opacity * Math.pow(1 - phase, 2)};
  });
  return (
    <group position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      {rings.map((r) => (
        <mesh key={r.k} geometry={geom} scale={[r.s, r.s, r.s]}>
          <meshBasicMaterial color={color} transparent opacity={r.o} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
};
