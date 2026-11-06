/**
 * 模板 42: GalleryHall3D - 3D 艺廊（three.js WebGL，双侧长廊一镜到底）
 *
 * 与 CameraJourney3D 同族的媒体场景模板：把展板搬进一条美术馆长廊——
 * 相机从入口进入，沿走廊中轴向前行进，展板交替挂在左右墙面：
 *   开场 12%：入口平视走廊灭点（天花灯带 + 两侧展板纵深展开），大标题悬浮在廊内；
 *   每站 i ：travel（中轴飞行，注视点上一展板 → 走廊前方 → 下一展板贝塞尔过渡）
 *             → dwell（侧身停在展板正前方缓推，视频展板仅在驻留窗口播放）；
 *   收尾 8% ：越过末板升高到走廊尽头，转身回望整条长廊（所有展板正面朝来向），
 *             副标题在回望构图中央浮现。
 *
 * 视觉签名（艺廊感的三件套）：
 * - 射灯：每块展板前内侧一束光锥（AdditiveBlending 低透明）+ 地面光池；临近驻站
 *   光锥预热增亮引导视线，驻留读板时锥体淡出（板占满画幅，半透明锥体会把
 *   加色光带叠进媒体内容）、脚下光池保留——「灯亮着引你走过来，驻足时让位于内容」；
 * - 灯带：天花两条通长白色灯带 + 墙面品牌色腰线，走廊纵深透视的引导线；
 * - 地板：不透明金属质感深色地板（无反射 pass；镜像倒影方案已废弃）。
 *
 * - 展板：PanelBoard 共用组件（品牌描边发光 + 媒体/文字 + 底部标题条）；
 *   平贴墙面（法向严格 ±x）——曾试 ~30° 内偏挂法，3.2 宽板体约 42% 嵌入墙体，
 *   驻留帧只见半个板（亮区偏心假象），平贴后相机驻留在法线上正对板心。
 * - 相机：自研 HallRig（ThreeStage rig="none"），全部 useCurrentFrame 插值，
 *   禁 Clock/delta；travel 走二次贝塞尔（上一驻留机位 → 中轴点 → 下一驻留机位）。
 * - 布局确定性：无随机种子（走廊规则排布），逐帧渲染可复现。
 *
 * 文案编码（同 CameraJourney3D）：title = 开场廊内大标题；subtitle = 回望浮现；
 * features 第 i 行 = 第 i 块展板标题（无素材的行 = 纯文字展板）。
 *
 * 个性化参数（GALLERY_HALL_3D_PARAMS）：dwellRatio 驻留节奏 / panelSize 展板大小 /
 * ambience 氛围 / spotGlow 射灯亮度。
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
import {sm, quadBezier, easeCam, stationJitter, CAM_SPEED, travelScaleOf, THEME_ACCENTS} from '../three/rig-utils';
import {buildPanelTimeline, panelPhaseAt, focusWeights, type PanelTimeline} from '../../shared/panel-timeline';
import {SLOT_OPEN_END as OPEN_END, SLOT_OUTRO_START as OUTRO_START, SLOT_DWELL_FRAC as DWELL_FRAC} from '../../shared/template-slot-windows';
import {assembleMediaPanels, MAX_MEDIA_PANELS, MediaPanel} from '../three/media-panels';
import {FloatingMotes} from '../three/scene-dress';
import {SceneEnv, sceneBackdrop} from '../three/scene-packs';
import {sceneHallSurfaces, sceneIsLight} from '../../shared/three-scenes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {GALLERY_HALL_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.2; // * 展板宽（16:9）
const PANEL_RATIO = 9 / 16;
const PANEL_Y = 2.05; // 展板中心高（墙面挂位）
const HALF_W = 3.35; // * 走廊半宽（展板墙面 x）
const HALL_H = 5.3; // * 走廊净高
const SPACING = 5.4; // * 相邻展板 z 间距
const HEAD_PAD = 5.5; // * 首板距入口
const TAIL_PAD = 7.5; // * 末板距端墙（收尾回望空间）
const DWELL_FAR = 2.85; // * 驻留起始相机距离（缓推到 DWELL_NEAR）
const DWELL_NEAR = 2.5; // *
const CAM_Y = 1.85; // * 行进眼高
const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准）
const FALLBACK_FEATURES = ['步入展厅 逐幅细品', '一镜到底 走完整廊'];

/** 站位几何：展板挂位 + 朝向（面向走廊中心偏入口侧） */
interface HallStation {
  panelPos: THREE.Vector3;
  normal: THREE.Vector3; // 展板法向（朝走廊内），驻留机位 = panelPos + normal·d
  quaternion: THREE.Quaternion;
  side: 1 | -1; // 1 = 右墙（+x），-1 = 左墙
}

/** 长廊相机：入口推进 → 逐站 travel/dwell → 尽头回望 */
const HallRig: React.FC<{
  stations: HallStation[];
  entranceZ: number;
  endZ: number;
  totalFrames: number;
  dwellFrac: number;
  dwellFar: number;
  dwellNear: number;
  camY: number;
  /** 世界缩放（竖版收尾机位常量同缩） */
  ws: number;
  /** 缓动性格（0 干脆 / 1 柔和 / 2 丝滑）与速度档（行程/推送缩放） */
  /** 逐板时间线（focusPanel/focusBoost 权重后的 travel/dwell 边界） */
  tl: PanelTimeline;
  easeP: number;
  spd: number;
}> = ({stations, entranceZ, endZ, totalFrames, dwellFrac, dwellFar, dwellNear, camY, ws, easeP, spd, tl}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  useFrame(() => {
    const n = stations.length;
    const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    // 走廊灭点注视位（开场终点 = travel0 首控制点，边界严格连续）
    const vanish = new THREE.Vector3(0, stations[0].panelPos.y + 0.35, endZ);
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));

    /** 站 i 驻留机位（progress 0→1：有效远距缓推到 dwellNear） */
    const dwellPose = (i: number, e: number): THREE.Vector3 => {
      const st = stations[i];
      const d = dwellNear + (dwellFarOf(i) - dwellNear) * (1 - e);
      return pos.copy(st.panelPos).addScaledVector(st.normal, d).setY(st.panelPos.y - 0.12);
    };

    if (q < OPEN_END) {
      // 开场：入口外缓推进入（终点 = travel0 起点，严格连续）
      const e = easeCam(q / OPEN_END, easeP);
      pos.set(0, camY + (1 - e) * 0.5, entranceZ + (1 - e) * 3.2 * spd);
      target.copy(vanish); // 注视走廊灭点（= travel0 首控制点）
    } else if (q >= OUTRO_START) {
      // 收尾两阶段：先越过末板升到走廊尽头，再转身回望整条长廊
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const last = stations[n - 1];
      const dwellEnd = tmp.copy(last.panelPos).addScaledVector(last.normal, dwellNear).setY(last.panelPos.y - 0.12);
      const corner = tmp2.set(0, 4.15 * ws, endZ + 2.2 * ws);
      if (e < 0.45) {
        pos.copy(dwellEnd).lerp(corner, sm(e / 0.45));
        target.copy(last.panelPos);
      } else {
        pos.copy(corner).lerp(tmp.set(0, 4.55 * ws, endZ + 3.6 * ws), sm((e - 0.45) / 0.55));
        // 注视从末板扫回入口方向（回望整廊）
        target.copy(last.panelPos).lerp(tmp2.set(0, last.panelPos.y - 0.2, entranceZ + 14), sm((e - 0.45) / 0.55));
      }
    } else {
      const ph = panelPhaseAt(tl, frame);
      const i = ph.i;
      const st = stations[i];
      if (!ph.dwell) {
        // travel：上一驻留机位 → 中轴前视点 → 下一驻留机位（贝塞尔，自然穿行换边）；
        // 行程弧度按速度档 × 站级微差缩放（破「每站一模一样」的节拍器感）
        const t = ph.p;
        const e = easeCam(t, easeP);
        const prevPos =
          i === 0
            ? tmp.set(0, camY, entranceZ) // travel0 起点 = 开场终点
            : tmp.copy(stations[i - 1].panelPos).addScaledVector(stations[i - 1].normal, dwellNear).setY(stations[i - 1].panelPos.y - 0.12);
        const nextPos = tmp2.copy(st.panelPos).addScaledVector(st.normal, dwellFarOf(i)).setY(st.panelPos.y - 0.12);
        const mid = new THREE.Vector3(0, camY, (prevPos.z + nextPos.z) / 2 - 0.6 * spd * (0.85 + 0.3 * stationJitter(i, 7)));
        quadBezier(prevPos.clone(), mid, nextPos.clone(), e, pos);
        // 注视：上一焦点（travel0 = 灭点）→ 走廊前方 → 下一展板
        const ahead = new THREE.Vector3(0, st.panelPos.y, nextPos.z - 4.5);
        quadBezier(i === 0 ? vanish.clone() : stations[i - 1].panelPos.clone(), ahead, st.panelPos.clone(), e, target);
      } else {
        // dwell：展板正前方缓推，注视展板中心
        const e = easeCam(ph.p, easeP);
        dwellPose(i, e);
        target.copy(st.panelPos);
      }
    }
    camera.position.copy(pos);
    camera.lookAt(target);
  });
  return null;
};

export const GalleryHall3D: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, brandColor}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 16) * FPS);

  const p = makeParamReader(GALLERY_HALL_3D_PARAMS, params);
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const panelAlt = Math.min(1, Math.max(0, Math.round(p('panelSides'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const spotGlow = Math.min(2, Math.max(0, Math.round(p('spotGlow'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];

  // 竖版：世界整体缩小 + 驻留拉远（窄横向视场保住展板全身）
  const worldScale = isPortrait ? 0.58 : 1;
  const distScale = isPortrait ? 3.1 : 1;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const halfW = HALF_W * worldScale;
  const hallH = HALL_H * worldScale;
  const spacing = SPACING * worldScale;
  const dwellFar = DWELL_FAR * ps * distScale;
  const dwellNear = DWELL_NEAR * ps * distScale;
  const camY = CAM_Y * worldScale;

  // ====== 展板装配（同 CameraJourney3D 口径） ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 走廊几何：展板左右交替挂墙，朝向走廊中心偏入口 ======
  const n = panels.length;
  const entranceZ = 0;
  const headPad = HEAD_PAD * worldScale;
  const endZ = -(headPad + (n - 1) * spacing + TAIL_PAD * worldScale);
  const stations: HallStation[] = useMemo(
    () =>
      panels.map((_, i) => {
        const side: 1 | -1 = panelAlt === 1 ? (i % 2 === 0 ? -1 : 1) : -1; // panelSides：0 同侧挂墙（防左右横跳眩晕）/ 1 左右交替
        // 平贴墙面：法向严格 ±x。曾用 lookAt(中轴偏入口) 给板 ~32° 内偏角——
        // 3.2 宽板体沿 x 伸出 ±0.85，板心距墙仅 0.05，导致板体约 42% 嵌入墙体，
        // 驻留帧只见半个板（亮区偏心假象的根因）。平贴后相机驻留在法线上正对板心。
        const panelPos = new THREE.Vector3(side * (halfW - 0.06), PANEL_Y * worldScale + Math.sin(i * 1.31) * 0.04 * worldScale, -(headPad + i * spacing));
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (-side * Math.PI) / 2, 0));
        const normal = new THREE.Vector3(-side, 0, 0);
        return {panelPos, normal, quaternion, side};
      }),
    [panels, halfW, worldScale, headPad, spacing],
  );

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

  const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));

  // 站 i 当前是否处于驻留窗口（射灯增亮用）
  const inDwell = (i: number): number => {
    const ds = dwellStartFrames[i] ?? 0;
    const de = ds + Math.round(tl.dwellDur[i] ?? 1);
    const warm = (tl.travelDur + (tl.dwellDur[i] ?? 1)) * 0.18;
    if (frame < ds - warm || frame >= de) return 0;
    return frame >= ds ? 1 : sm((frame - (ds - warm)) / warm); // 临近即预热
  };

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
  // v28 场景解耦：艺廊是封闭壳体——场景轴表现为「室内装潢换装」（墙面/地板随场景换色）
  // + 壳外环境件（入口/换景时可见度有限，主要靠装潢色 + 背景渐变传达）
  const sceneIdx = Math.round(p('sceneStyle'));
  const surfaces = sceneHallSurfaces(sceneIdx);
  const inkText = sceneIsLight(sceneIdx);
  const sceneCss = sceneBackdrop(sceneIdx);
  const lightOn = spotGlow > 0;
  const lightBoost = spotGlow === 2 ? 1.35 : 1;
  const hallLen = entranceZ - endZ;
  const midZ = (entranceZ + endZ) / 2;
  const shadowOn = Math.round(p('shadowLevel')) === 1;
  const shadowCenter: [number, number] = [0, midZ];
  const shadowBounds = hallLen / 2 + 5;

  // 标题：开场廊内悬浮，旅行启动后收起；副标题：回望窗口在走廊中央浮现（面向出口端）
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));
  const titleZ = entranceZ - 1.6 * worldScale;
  const subtitleZ = endZ + 6.5 * worldScale; // 回望相机（更深处）与入口之间

  // 光锥/光池/镜像几何（dispose 兜底）
  const coneGeom = useMemo(() => new THREE.ConeGeometry(1, 1, 24, 1, true), []);
  const poolGeom = useMemo(() => new THREE.CircleGeometry(1, 40), []);
  useEffect(
    () => () => {
      coneGeom.dispose();
      poolGeom.dispose();
    },
    [coneGeom, poolGeom],
  );

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

      {/* 3D 舞台（透明 canvas，DOM 背景透出）；rig="none"：相机由 HallRig 接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={Math.max(1, hallLen / 9)}
        ambienceCenterXZ={[0, midZ]}
        ambienceCones={false}
        totalFrames={totalFrames}
        fov={42}
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
        <HallRig stations={stations} entranceZ={entranceZ} endZ={endZ} totalFrames={totalFrames} dwellFrac={dwellFrac} dwellFar={dwellFar} dwellNear={dwellNear} camY={camY} ws={worldScale} easeP={easeP} spd={spd} tl={tl} />

        {/* v28 环境场景包（壳外；画廊本体看装潢色） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={new THREE.Vector3(0, PANEL_Y * worldScale, midZ)}
          spanZ={hallLen}
          radiusX={halfW}
          ground={false}
          glow={spotGlow}
        />

        {/* 走廊壳：地板 / 天花 / 两侧墙 / 端墙（装潢色随场景换装） */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, midZ]} receiveShadow>
          <planeGeometry args={[halfW * 2, hallLen]} />
          <meshStandardMaterial color={surfaces.floor} roughness={0.32} metalness={0.62} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, hallH, midZ]}>
          <planeGeometry args={[halfW * 2, hallLen]} />
          <meshStandardMaterial color={surfaces.ceiling} roughness={0.85} metalness={0.1} />
        </mesh>
        {[-1, 1].map((s) => (
          <mesh key={`w${s}`} rotation={[0, s === -1 ? Math.PI / 2 : -Math.PI / 2, 0]} position={[(s * halfW) as number, hallH / 2, midZ]}>
            <planeGeometry args={[hallLen, hallH]} />
            <meshStandardMaterial color={surfaces.wall} roughness={0.9} metalness={0.08} />
          </mesh>
        ))}
        <mesh position={[0, hallH / 2, endZ]}>
          <planeGeometry args={[halfW * 2, hallH]} />
          <meshStandardMaterial color={surfaces.endWall} roughness={0.9} metalness={0.08} />
        </mesh>


        {/* 天花通长灯带 ×2 + 墙面品牌色腰线 ×2（纵深引导线） */}
        {lightOn &&
          [-1, 1].map((s) => (
            <mesh key={`strip${s}`} position={[s * halfW * 0.52, hallH - 0.06, midZ]}>
              <boxGeometry args={[0.14, 0.05, hallLen * 0.98]} />
              <meshBasicMaterial color="#DDE9FF" toneMapped={false} />
            </mesh>
          ))}
        {lightOn &&
          [-1, 1].map((s) => (
            <mesh key={`rail${s}`} position={[(s * (halfW - 0.012)) as number, hallH * 0.72, midZ]}>
              <boxGeometry args={[0.02, 0.03, hallLen * 0.99]} />
              <meshBasicMaterial color={accent} transparent opacity={0.55 * lightBoost} toneMapped={false} />
            </mesh>
          ))}

        {/* 展板组：射灯光锥 + 地面光池 + 板体 + 镜像倒影 */}
        {stations.map((st, i) => {
          const panel = panels[i];
          const floatY = Math.sin(tSec * 0.85 + i * 1.31) * 0.03 * worldScale;
          const boost = 1 + inDwell(i) * 0.8 * lightBoost;
          const coneK = 1 - 0.9 * inDwell(i); // 灯锥随驻留淡出：板占满画幅，任何半透明锥体都会在内容上叠加色光带
          const panelX = st.panelPos.x;
          const fixY = hallH - 0.35; // 顶灯吊点
          const coneH = fixY - 0.02;
          return (
            <group key={`st${i}`}>
              {/* 射灯光锥（AdditiveBlending，半透明；驻留站增亮）。
                  立在展板前内侧（走廊内 + 偏入口 1.35）——不能钉在板位 (x,z) 上：
                  锥面会穿过板平面，驻留增亮时在媒体内容上叠出加色光带 */}
              {lightOn && (
                <mesh
                  geometry={coneGeom}
                  position={[panelX - st.side * 0.75 * worldScale, coneH / 2, st.panelPos.z + 1.35 * worldScale]}
                  scale={[0.55 * worldScale, coneH, 0.55 * worldScale]}
                >
                  <meshBasicMaterial color="#BFD4FF" transparent opacity={0.085 * lightBoost * coneK} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
                </mesh>
              )}
              {/* 地面光池 */}
              {lightOn && (
                <mesh geometry={poolGeom} rotation={[-Math.PI / 2, 0, 0]} position={[panelX * 0.72, 0.012, st.panelPos.z]} scale={[1.25 * worldScale, 1.25 * worldScale, 1]}>
                  <meshBasicMaterial color={accent} transparent opacity={0.13 * lightBoost * boost} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
                </mesh>
              )}
              {/* 板体（浮动 + 朝向） */}
              <group position={[panelX, st.panelPos.y + floatY, st.panelPos.z]} quaternion={st.quaternion}>
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
                />
              </group>
            </group>
          );
        })}

        {/* v27 尽头光拱 + 漂浮尘埃（射灯里的微尘，展厅空气感） */}
        <mesh position={[0, 0, endZ - 0.06]}>
          <torusGeometry args={[1.45 * worldScale, 0.035 * worldScale, 8, 48, Math.PI]} />
          <meshBasicMaterial color={accent} transparent opacity={0.4} toneMapped={false} depthWrite={false} />
        </mesh>
        <FloatingMotes count={70} center={new THREE.Vector3(0, HALL_H * 0.52 * worldScale, endZ / 2)} spread={new THREE.Vector3(halfW * 1.5, HALL_H * 0.66 * worldScale, hallLen * 0.88)} ws={worldScale} color="#FFE9C4" opacity={0.22} size={0.045} speed={0.014} />

        {/* 开场廊内大标题（面向入口；旅行启动后收起；亮色场景换墨色字） */}
        {text.title && (
          <group position={[0, (PANEL_Y + 1.55) * worldScale, titleZ]} scale={titleScale}>
            <ThreeText text={text.title} size={0.62 * worldScale} depth={0.12 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={halfW * 2 * 0.86} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 回望副标题（面向出口端；收尾窗口现身） */}
        {text.subtitle && (
          <group position={[0, (PANEL_Y + 1.35) * worldScale, subtitleZ]} rotation={[0, Math.PI, 0]} scale={subtitleScale}>
            <ThreeText text={text.subtitle} size={0.5 * worldScale} depth={0.1 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={halfW * 2 * 0.8} startFrame={Math.round(OUTRO_START * totalFrames) + 4} stagger={2} />
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

export default GalleryHall3D;
