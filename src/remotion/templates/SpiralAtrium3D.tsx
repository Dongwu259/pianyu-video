/**
 * 模板 46: SpiralAtrium3D - 3D 旋转中庭（three.js WebGL，垂直螺旋一镜到底）
 *
 * 与 CameraJourney3D 同族的媒体场景模板：展板沿螺旋线绕中央光柱盘旋而上
 * （每站约 120°，三站一圈），相机从底层外侧仰视开场，沿螺旋外侧盘旋上升逐板驻留，
 * 收尾升到顶上俯瞰整条螺旋——全家族唯一的垂直维度模板。
 *   开场 12%：底层外侧仰视中央光柱（螺旋结构向上收拢的强透视），大标题悬在栏管上方；
 *   每站 i ：travel（沿螺旋外侧弧线爬升：方位角步进 + 半径外抛 + 高度爬升）
 *             → dwell（板正前方缓推，注视板心，视频展板仅驻留窗口播放）；
 *   收尾 8% ：升到螺旋顶上空俯瞰整条螺旋 + 地面光环，副标题躺在地面圆心朝上浮现。
 *
 * 视觉签名（中庭三件套）：
 * - 螺旋栏管：贯穿全部站位的发光螺旋管（TubeGeometry 沿站位 CatmullRom），「楼梯」的意象；
 * - 中央光柱：定轴圆柱 + 品牌色辉光外管 + 柱顶光环，螺旋围绕的视觉锚；
 * - 地面：圆盘 + 品牌色光环 + 圆心微光，俯瞰收尾的构图基座。
 *
 * - 展板：PanelBoard 共用组件，面朝环外（lookAt 径向外一点，同环游展台口径）；
 *   驻留机位在板法线上正对板心（法向 = 径向，零嵌结构）。
 * - 相机：自研 SpiralRig（ThreeStage rig="none"），全部 useCurrentFrame 插值，
 *   禁 Clock/delta；travel = 方位角插值 + 半径外抛弧 + 高度爬升（边界严格连续）。
 *   仰视/俯视角都钳在安全范围（远离开与 up 向量平行的 lookAt 奇异）。
 * - 缓动/速度：camEase 三档缓动族 + camSpeed 三档 + 站级确定性微差（与 3D 家族同族）。
 * - 布局确定性：无随机种子（规则螺旋 + stationJitter 微差），逐帧渲染可复现。
 *
 * 文案编码（同 CameraJourney3D）：title = 开场仰视大标题；subtitle = 收尾俯瞰时
 * 躺在地面圆心朝上浮现；features 第 i 行 = 第 i 块展板标题（无素材的行 = 纯文字展板）。
 *
 * 个性化参数（SPIRAL_ATRIUM_3D_PARAMS）：dwellRatio 驻留节奏 / panelSize 展板大小 /
 * ambience 氛围 / helixGlow 螺旋发光。
 *
 * v1 限制（同 CameraJourney3D）：挖段 cuts 与取景 viewport 不作用于 3D 纹理；
 * .glb 模型素材不支持（跳过并警告）。
 */

/* eslint-disable react-hooks/rules-of-hooks -- 展板/媒体列表在单次渲染内恒定，hook 顺序稳定 */
import React, {useEffect, useMemo} from 'react';
import * as THREE from 'three';
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {useFrame, useThree} from '@react-three/fiber';
import {ClipMedia} from '../layers/ClipMedia';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ThreeStage} from '../three/ThreeStage';
import {ThreeText} from '../three/ThreeText';
import {useVideoScreenTexture} from '../three/VideoScreenTexture';
import {useImagePanelTexture} from '../three/ImagePanelTexture';
import {PanelBoard} from '../three/PanelBoard';
import {sm, easeCam, stationJitter, CAM_SPEED, travelScaleOf, THEME_ACCENTS} from '../three/rig-utils';
import {buildPanelTimeline, panelPhaseAt, focusWeights, type PanelTimeline} from '../../shared/panel-timeline';
import {SLOT_OPEN_END as OPEN_END, SLOT_OUTRO_START as OUTRO_START, SLOT_DWELL_FRAC as DWELL_FRAC} from '../../shared/template-slot-windows';
import {assembleMediaPanels, MAX_MEDIA_PANELS, MediaPanel} from '../three/media-panels';
import {FloatingMotes} from '../three/scene-dress';
import {SceneEnv, sceneBackdrop} from '../three/scene-packs';
import {sceneIsLight} from '../../shared/three-scenes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {SPIRAL_ATRIUM_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.2; // * 展板宽（16:9）
const PANEL_RATIO = 9 / 16;
const RING_R = 4.0; // * 螺旋半径（展板环）
const STEP_ANGLE = 2.1; // 相邻站方位角步进（rad，约 120°：三站一圈）
const Y0 = 2.6; // * 首站高度
const RISE = 2.1; // * 每站爬升
const RAIL_R = 3.45; // * 螺旋栏管半径（环内侧，不与展板相交）
const COLUMN_R = 0.55; // * 中央光柱半径
const DWELL_FAR = 3.35; // * 驻留起始相机距离（缓推到 DWELL_NEAR；视觉复核：稍后拉露出螺旋结构）
const DWELL_NEAR = 2.9; // *
const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准）
const FALLBACK_FEATURES = ['盘旋而上 逐层细品', '一路升到顶 俯瞰全景'];

/** 站位几何：螺旋挂位 + 朝向（面朝环外，法向 = 径向） */
interface SpiralStation {
  angle: number; // 方位角（rad）
  panelPos: THREE.Vector3;
  normal: THREE.Vector3; // 展板法向（径向外），驻留机位 = panelPos + normal·d
  quaternion: THREE.Quaternion;
}

/** 螺旋相机：底层仰视 → 沿螺旋外侧盘旋爬升逐站驻留 → 顶部俯瞰 */
const SpiralRig: React.FC<{
  stations: SpiralStation[];
  totalFrames: number;
  dwellFrac: number;
  dwellFar: number;
  dwellNear: number;
  ringR: number;
  /** 世界缩放（竖版收尾机位常量同缩） */
  ws: number;
  /** 缓动性格（0 干脆 / 1 柔和 / 2 丝滑）与速度档（行程/推送缩放） */
  /** 逐板时间线（focusPanel/focusBoost 权重后的 travel/dwell 边界） */
  tl: PanelTimeline;
  easeP: number;
  spd: number;
}> = ({stations, totalFrames, dwellFrac, dwellFar, dwellNear, ringR, ws, easeP, spd, tl}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  useFrame(() => {
    const n = stations.length;
    const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));

    /** 站 i 驻留机位（progress 0→1：有效远距缓推到 dwellNear） */
    const dwellPose = (i: number, e: number): {r: number; a: number; y: number} => {
      const st = stations[i];
      const d = dwellNear + (dwellFarOf(i) - dwellNear) * (1 - e);
      return {r: ringR + d, a: st.angle, y: st.panelPos.y - 0.18 * ws};
    };

    if (q < OPEN_END) {
      // 开场：底层外侧仰视中央光柱，收到 travel0 起点位（严格连续）
      const e = easeCam(q / OPEN_END, easeP);
      const startA = stations[0].angle - STEP_ANGLE * 0.92;
      const a = THREE.MathUtils.lerp(startA + 0.5, startA, e);
      const r = THREE.MathUtils.lerp(ringR * 2.7, ringR + dwellFarOf(0), e);
      const y = THREE.MathUtils.lerp(0.9 * ws, 1.1 * ws, e);
      pos.set(Math.sin(a) * r, y, Math.cos(a) * r);
      // 仰视目标：柱身中上部（仰角约 20-30°，远离开与 up 平行的奇异）
      target.set(0, THREE.MathUtils.lerp((Y0 + 1.6) * ws, (Y0 + 1.1) * ws, e), 0);
    } else if (q >= OUTRO_START) {
      // 收尾：从末站驻留升到螺旋顶上空，俯瞰整条螺旋 + 地面光环
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const last = dwellPose(n - 1, 1);
      const topYst = stations[n - 1].panelPos.y;
      const midY = stations[0].panelPos.y + (topYst - stations[0].panelPos.y) * 0.5;
      const a = last.a + e * 0.55; // 顺势再转半段
      const r = THREE.MathUtils.lerp(last.r, ringR * 0.72, e);
      const y = THREE.MathUtils.lerp(last.y, topYst + 6.2 * ws, e);
      pos.set(Math.sin(a) * r, y, Math.cos(a) * r);
      // 俯瞰目标：螺旋中段（俯角约 50°，安全范围）
      target.set(0, THREE.MathUtils.lerp(stations[n - 1].panelPos.y, midY, e), 0);
    } else {
      const ph = panelPhaseAt(tl, frame);
      const i = ph.i;
      const st = stations[i];
      if (!ph.dwell) {
        // travel：沿螺旋外侧弧线爬升——方位角步进 + 半径从上站末张到下站始，
        // 中段外抛加弧按速度档 × 站级微差（破「每站一模一样」的节拍器感）
        const e = easeCam(ph.p, easeP);
        const prev = i === 0 ? {r: ringR + dwellFarOf(0), a: st.angle - STEP_ANGLE * 0.92, y: 1.1 * ws} : dwellPose(i - 1, 1);
        const next = dwellPose(i, 0);
        const a = prev.a + (next.a - prev.a) * e;
        const r = prev.r + (next.r - prev.r) * sm(e) + Math.sin(e * Math.PI) * 1.1 * spd * (0.85 + 0.3 * stationJitter(i, 7)) * ws;
        const y = prev.y + (next.y - prev.y) * e + Math.sin(e * Math.PI) * 0.25 * ws;
        pos.set(Math.sin(a) * r, y, Math.cos(a) * r);
        // 注视：上一展板 → 螺旋前方（下一站方位）→ 下一展板
        const ahead = new THREE.Vector3(Math.sin(next.a) * ringR * 0.9, (prev.y + next.y) / 2, Math.cos(next.a) * ringR * 0.9);
        tmp.copy(i === 0 ? ahead : stations[i - 1].panelPos);
        target.copy(tmp).lerp(st.panelPos, e);
      } else {
        // dwell：板正前方缓推共旋注视板心
        const e = easeCam(ph.p, easeP);
        const dp = dwellPose(i, e);
        pos.set(Math.sin(dp.a) * dp.r, dp.y, Math.cos(dp.a) * dp.r);
        target.copy(st.panelPos);
      }
    }
    camera.position.copy(pos);
    camera.lookAt(target);
  });
  return null;
};

export const SpiralAtrium3D: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, brandColor}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 16) * FPS);

  const p = makeParamReader(SPIRAL_ATRIUM_3D_PARAMS, params);
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const helixGlow = Math.min(2, Math.max(0, Math.round(p('helixGlow'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];

  // 竖版：世界整体缩小 + 驻留拉远（窄横向视场保住展板全身）
  const worldScale = isPortrait ? 0.58 : 1;
  const distScale = isPortrait ? 2.9 : 1;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const ringR = RING_R * worldScale;
  const shadowOn = Math.round(p('shadowLevel')) === 1;
  const shadowCenter: [number, number] = [0, 0];
  const shadowBounds = ringR * 2.2 + 5;
  const railR = RAIL_R * worldScale;
  const colR = COLUMN_R * worldScale;
  const rise = RISE * worldScale;
  const dwellFar = DWELL_FAR * ps * distScale;
  const dwellNear = DWELL_NEAR * ps * distScale;
  const glowOn = helixGlow > 0;
  const glowBoost = helixGlow === 2 ? 1.35 : 1;

  // ====== 展板装配（同 CameraJourney3D 口径） ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 螺旋站位：方位角步进 120°，逐站爬升 ======
  const n = panels.length;
  const stations: SpiralStation[] = useMemo(
    () =>
      panels.map((_, i) => {
        const angle = i * STEP_ANGLE;
        const y = (Y0 + i * RISE + Math.sin(i * 1.37) * 0.05) * worldScale;
        const panelPos = new THREE.Vector3(Math.sin(angle) * ringR, y, Math.cos(angle) * ringR);
        const dummy = new THREE.Object3D();
        dummy.position.copy(panelPos);
        dummy.lookAt(new THREE.Vector3(Math.sin(angle) * ringR * 2, y - 0.1, Math.cos(angle) * ringR * 2)); // 面朝环外微俯
        const normal = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
        return {angle, panelPos, normal, quaternion: dummy.quaternion.clone()};
      }),
    [panels, ringR, worldScale],
  );
  const topY = stations.length ? stations[stations.length - 1].panelPos.y : Y0 * worldScale;
  const colH = topY + 2.6 * worldScale;

  // ====== 螺旋栏管（贯穿站位的发光管 + 站位节点球） ======
  const railGeom = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let k = -0.6; k <= n - 1 + 0.45; k += 0.45) {
      pts.push(new THREE.Vector3(Math.sin(k * STEP_ANGLE) * railR, (Y0 + k * RISE - 0.42) * worldScale, Math.cos(k * STEP_ANGLE) * railR));
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.05 * worldScale, 8, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, railR, worldScale]);
  useEffect(() => () => railGeom.dispose(), [railGeom]);

  // ====== 时间线（帧；每板驻留权重 = focusPanel/focusBoost，AI 编排可直接下发 customParams） ======
  const tl = buildPanelTimeline(n, totalFrames, dwellFrac, focusWeights(n, p('focusPanel'), p('focusBoost')), OPEN_END, OUTRO_START, travelScaleOf(p('camSpeed')));
  const dwellStartFrames = tl.dwellStart.map((f) => Math.round(f));
/** 驻留呼吸光（行进 0；驻留中正弦呼吸 0~1，喂 PanelBoard.glowPulse） */
const dwellGlow = (i: number): number => {
  const s = dwellStartFrames[i] ?? 0;
  const d = Math.round(tl.dwellDur[i] ?? 1);
  return frame >= s && frame < s + d ? 0.5 + 0.5 * Math.sin(((frame / FPS) * Math.PI * 2) / 2.8 + i * 1.7) : 0;
};
const captionScale = Math.min(1.4, Math.max(0.8, p('captionSize')));


  // ====== 媒体纹理（hook 数量固定 = 面板上限，增删素材不改变 hook 数） ======
  const videoTextures = Array.from({length: MAX_PANELS}, (_, i) => {
    const v = panels[i]?.video?.type === 'video' ? panels[i].video : undefined;
    const endSec = v ? clipEndSec(v) : undefined;
    return useVideoScreenTexture({
      src: v?.src,
      trimBeforeFrame: v ? Math.round((v.trimStart || 0) * FPS) : 0,
      trimAfterFrame: endSec !== undefined ? Math.round(endSec * FPS) : undefined,
      videoWidth: v?.width ?? 16,
      videoHeight: v?.height ?? 9,
      planeWidth: pw,
      planeHeight: ph,
      frameOffset: dwellStartFrames[i] ?? 0,
      previewWindow: {from: dwellStartFrames[i] ?? 0, durationInFrames: Math.round(tl.dwellDur[i] ?? 1)},
    });
  });
  const imageTextures = Array.from({length: MAX_PANELS}, (_, i) =>
    useImagePanelTexture(panels[i]?.video?.type === 'image' ? panels[i].video.src : undefined, pw, ph),
  );

  const tSec = frame / FPS;
  const themeIdx = Math.min(5, Math.max(0, Math.round(p('themeColor'))));
  const accent = themeIdx > 0 ? THEME_ACCENTS[themeIdx] : brandColor || '#3B82F6';
  const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));
  // 开场相机起始方位（标题面向它）
  const openA = -STEP_ANGLE * 0.92 + 0.5;
  // v28 场景解耦：中庭是开放竖井，场景件在井外四周展开（sceneStyle 可换）
  const sceneIdx = Math.round(p('sceneStyle'));
  const inkText = sceneIsLight(sceneIdx);
  const sceneCss = sceneBackdrop(sceneIdx);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : sceneCss ? (
        <Background color={sceneCss} tint={accent} />
      ) : (
        <Background variant="gradient-dark" tint={accent} />
      )}
      <BackgroundEffectLayer />

      {/* 3D 舞台；rig="none"：相机由 SpiralRig 接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={Math.max(1, (topY + 6 * worldScale) / 9)}
        ambienceCenterXZ={[0, 0]}
        ambienceCones={false}
        totalFrames={totalFrames}
        fov={44}
        shadows={false}
        realShadows={shadowOn}
        shadowCenter={shadowCenter}
        shadowBounds={shadowBounds}
      >
        {videoTextures.map((vst, i) => (
          <vst.Bridge key={`br${i}`} />
        ))}
        {imageTextures.map((it, i) => (
          <it.Bridge key={`ib${i}`} />
        ))}
        <SpiralRig stations={stations} totalFrames={totalFrames} dwellFrac={dwellFrac} dwellFar={dwellFar} dwellNear={dwellNear} ringR={ringR} ws={worldScale} easeP={easeP} spd={spd} tl={tl} />

        {/* v28 环境场景包（古建/星空/山水/…可换；默认纯净 = 原生观感） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={new THREE.Vector3(0, (Y0 + RISE * 2) * worldScale, 0)}
          spanZ={RING_R * 2}
          radiusX={RING_R}
          ground={false}
          glow={helixGlow}
        />

        {/* 中央光柱：柱体 + 品牌色辉光外管 + 柱顶光环 */}
        <mesh position={[0, colH / 2, 0]}>
          <cylinderGeometry args={[colR, colR, colH, 24]} />
          <meshStandardMaterial color="#0C1220" roughness={0.4} metalness={0.55} />
        </mesh>
        {glowOn && (
          <mesh position={[0, colH / 2, 0]}>
            <cylinderGeometry args={[colR * 1.12, colR * 1.12, colH, 24, 1, true]} />
            <meshBasicMaterial color={accent} transparent opacity={0.22 * glowBoost} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        )}
        {glowOn && (
          <mesh position={[0, colH + 0.35 * worldScale, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[ringR * 0.52, 0.045 * worldScale, 10, 64]} />
            <meshBasicMaterial color={accent} transparent opacity={0.7 * glowBoost} toneMapped={false} />
          </mesh>
        )}

        {/* 螺旋栏管 + 站位节点球（「楼梯」意象） */}
        {glowOn && (
          <mesh geometry={railGeom}>
            <meshBasicMaterial color={accent} transparent opacity={0.8} toneMapped={false} />
          </mesh>
        )}
        {glowOn &&
          stations.map((st, i) => (
            <mesh key={`nd${i}`} position={[Math.sin(st.angle) * railR, st.panelPos.y - 0.42 * worldScale, Math.cos(st.angle) * railR]}>
              <sphereGeometry args={[0.09 * worldScale, 14, 14]} />
              <meshStandardMaterial color="#FFFFFF" emissive={accent} emissiveIntensity={0.8} roughness={0.3} metalness={0.2} />
            </mesh>
          ))}

        {/* 地面：圆盘 + 品牌色光环 + 圆心微光 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <circleGeometry args={[ringR + 3.4 * worldScale, 56]} />
          <meshStandardMaterial color="#0A0E18" roughness={0.5} metalness={0.4} />
        </mesh>
        {glowOn && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
            <ringGeometry args={[ringR - 0.07, ringR + 0.07, 64]} />
            <meshBasicMaterial color={accent} transparent opacity={0.5 * glowBoost} toneMapped={false} />
          </mesh>
        )}

        {/* v27 光柱竖向光缝 ×3 + 中庭悬浮微尘（柱身细节与空气感） */}
        {glowOn &&
          [0, 1, 2].map((k) => {
            const a = (k * Math.PI * 2) / 3 + 0.5;
            return (
              <mesh key={`seam${k}`} position={[Math.sin(a) * (colR + 0.02 * worldScale), colH * 0.5, Math.cos(a) * (colR + 0.02 * worldScale)]} rotation={[0, -a, 0]}>
                <boxGeometry args={[0.03 * worldScale, colH * 0.96, 0.06 * worldScale]} />
                <meshBasicMaterial color={accent} transparent opacity={0.35} toneMapped={false} depthWrite={false} />
              </mesh>
            );
          })}
        <FloatingMotes count={90} center={new THREE.Vector3(0, colH * 0.45, 0)} spread={new THREE.Vector3(ringR * 3.2, colH * 0.85, ringR * 3.2)} ws={worldScale} color={accent} opacity={0.26} size={0.05} speed={0.015} />

        {/* 展板组（面朝环外 + 微浮动） */}
        {stations.map((st, i) => {
          const panel = panels[i];
          const floatY = Math.sin(tSec * 0.8 + i * 1.29) * 0.03 * worldScale;
          const v = panel.video?.type === 'video' ? panel.video : undefined;
          // 美化光标的媒体时间：驻留窗口内才显示（素材绝对秒 = trimStart + 窗口内已播秒）
          const curSec = v && v.cursorPoints && v.cursorPoints.length > 0
            ? (v.trimStart ?? 0) + Math.max(0, Math.min(frame - (dwellStartFrames[i] ?? 0), Math.round(tl.dwellDur[i] ?? 1))) / FPS
            : -1;
          return (
            <group key={`pn${i}`} position={[st.panelPos.x, st.panelPos.y + floatY, st.panelPos.z]} quaternion={st.quaternion}>
              <PanelBoard
                pw={pw}
                ph={ph}
                accent={accent}
                videoTexture={panel.video?.type === 'video' ? videoTextures[i].texture : null}
                imageTexture={panel.video?.type === 'image' ? imageTextures[i].texture : null}
                caption={panel.caption}
                textScale={ps}
                captionScale={captionScale}
                glowPulse={1 + 0.45 * dwellGlow(i)}
                cursorPoints={v?.cursorPoints}
                cursorClicks={v?.cursorClicks}
                cursorSec={curSec}
                cursorVW={v?.width}
                cursorVH={v?.height}
              />
            </group>
          );
        })}

        {/* 开场仰视大标题（面向开场机位；旅行启动后收起） */}
        {text.title && (
          <group position={[Math.sin(openA) * ringR * 0.62, (Y0 + 2.35) * worldScale, Math.cos(openA) * ringR * 0.62]} rotation={[0, openA, 0]} scale={titleScale}>
            <ThreeText text={text.title} size={0.6 * worldScale} depth={0.12 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={7 * worldScale} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 收尾俯瞰副标题（躺在地面圆心朝上，正对顶部相机） */}
        {text.subtitle && (
          <group position={[0, 0.03 * worldScale, 0]} rotation={[-Math.PI / 2, 0, Math.PI]} scale={subtitleScale}>
            <ThreeText text={text.subtitle} size={0.55 * worldScale} depth={0.09 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={6.4 * worldScale} startFrame={Math.round(OUTRO_START * totalFrames) + 4} stagger={2} />
          </group>
        )}
      </ThreeStage>

      {/* 屏幕纹理的 DOM 侧解码源（预览用；渲染期为 null） */}
      {videoTextures.map((vst, i) => (
        <React.Fragment key={`dom${i}`}>{vst.dom}</React.Fragment>
      ))}

      {/* 隐藏 ClipMedia：视频展板仅 dwell 窗口出声 */}
      {panels.map((panel, i) => {
        const v = panel.video;
        if (!v || v.type !== 'video' || v.muted) return null;
        return (
          <Sequence key={`au${i}`} from={dwellStartFrames[i]} durationInFrames={Math.round(tl.dwellDur[i] ?? 1)}>
            <div style={{position: 'absolute', width: 2, height: 2, left: -10, top: -10, opacity: 0, pointerEvents: 'none', overflow: 'hidden'}}>
              <ClipMedia
                src={v.src}
                mediaType={v.type}
                startFrom={Math.round((v.trimStart || 0) * FPS)}
                endSec={clipEndSec(v)}
                cutsSec={v.cuts}
                volume={v.volume}
                style={{width: 2, height: 2}}
              />
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export default SpiralAtrium3D;
