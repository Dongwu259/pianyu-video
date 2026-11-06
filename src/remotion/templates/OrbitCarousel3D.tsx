/**
 * 模板 43: OrbitCarousel3D - 3D 环游展台（three.js WebGL，旋转展环 + 追踪环绕相机）
 *
 * 与 CameraJourney3D 同族的媒体场景模板：媒体展板围成一个圆环（面朝环外），
 * 中央一根品牌色光柱定轴，展环整体缓旋；相机在环外反向追踪环绕——
 *   开场 12%：高空俯瞰整个展环（灯环 + 光柱 + 展板全景），大标题悬浮环心上方；
 *   每站 i ：travel（机位沿环外弧线扫向下一板，注视上一板 → 环心上方 → 下一板）
 *             → dwell（贴在板 i 正前方随环共旋缓推——背景粒子反向掠过，强视差）；
 *   收尾 8% ：拉升高空回看整环，副标题在环心上方浮现。
 *
 * 视觉签名：中央光柱（核心发光 + 加色光环晕）+ 地面发光灯环（展环投影）+
 * 展板共旋带来的持续运动感（相机驻留时世界在动，画面永不僵）。
 *
 * - 相机几何全是方位角的函数：展环转角 θ(t)=ω·t 帧驱动确定性；机位方位角 =
 *   目标板当前方位角（dwell 共旋）或相邻板方位角的插值（travel 弧扫），
 *   所有相位边界（开场末 = travel0 首 = dwell0 始）数学上严格连续。
 * - 展板：PanelBoard 共用组件，面朝环外微仰 10°（高空开场俯瞰也能看到板面）。
 * - 无随机种子：环上均匀分布，逐帧渲染可复现。
 *
 * 文案编码（同 CameraJourney3D）：title = 开场环心上方大标题；subtitle = 收尾浮现；
 * features 第 i 行 = 第 i 块展板标题（无素材的行 = 纯文字展板）。
 *
 * 个性化参数（ORBIT_CAROUSEL_3D_PARAMS）：spinSpeed 展环旋转 / dwellRatio 驻留节奏 /
 * panelSize 展板大小 / ambience 氛围 / coreGlow 光柱亮度。
 *
 * v1 限制（同 CameraJourney3D）：挖段与取景不作用于 3D 纹理；.glb 模型素材跳过。
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
import {FloatingMotes, OrbitingDot} from '../three/scene-dress';
import {SceneEnv, sceneBackdrop} from '../three/scene-packs';
import {sceneIsLight} from '../../shared/three-scenes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {ORBIT_CAROUSEL_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.1; // * 展板宽（16:9）
const PANEL_RATIO = 9 / 16;
const PANEL_Y = 2.1; // * 展板中心高
const RING_R = 4.15; // * 展环半径
const PANEL_TILT = 0.17; // 展板仰角（高空俯瞰也能看到板面，弧度）
const CORE_H = 5.6; // * 光柱高
const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const SPIN_OMEGA = [0, 0.085, 0.19]; // spinSpeed：0 停 / 1 缓旋 / 2 旋转（rad/s）
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准）
const FALLBACK_FEATURES = ['环绕一圈 逐板特写', '旋转展台 串起亮点'];

/** 环游相机（顶层组件：逐帧调 poseOf 接管机位） */
const CarouselRig: React.FC<{poseOf: (f: number) => {pos: THREE.Vector3; target: THREE.Vector3}}> = ({poseOf}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  useFrame(() => {
    const {pos, target} = poseOf(frame);
    camera.position.copy(pos);
    camera.lookAt(target);
  });
  return null;
};

export const OrbitCarousel3D: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, brandColor}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 16) * FPS);
  const tSec = frame / FPS;

  const p = makeParamReader(ORBIT_CAROUSEL_3D_PARAMS, params);
  const spin = Math.min(2, Math.max(0, Math.round(p('spinSpeed'))));
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const coreGlow = Math.min(2, Math.max(0, Math.round(p('coreGlow'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];

  // 竖版：世界整体缩小 + 驻留拉远（窄横向视场保住展板全身）
  const worldScale = isPortrait ? 0.58 : 1;
  const distScale = isPortrait ? 3.0 : 1;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const R = RING_R * worldScale;
  const shadowOn = Math.round(p('shadowLevel')) === 1;
  const shadowCenter: [number, number] = [0, 0];
  const shadowBounds = R * 2.4 + 4;
  const coreH = CORE_H * worldScale;
  // dwellFar/Near 是机位轨道半径 = 环半径 + 板前距离（distScale 只乘板前距离，竖版不炸轨道）
  const dwellFar = R + 2.75 * ps * distScale;
  const dwellNear = R + 2.42 * ps * distScale;
  const panelY = PANEL_Y * worldScale;
  const camY = panelY - 0.12;
  const omega = SPIN_OMEGA[spin];

  // ====== 展板装配（同 CameraJourney3D 口径） ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 环上站位（局部角均布；世界角 = 局部角 + θ(t)） ======
  const n = panels.length;
  const baseAngles = useMemo(() => Array.from({length: n}, (_, i) => (i * Math.PI * 2) / n), [n]);
  const panelQuats = useMemo(
    () =>
      baseAngles.map((a) => {
        const dummy = new THREE.Object3D();
        dummy.position.set(Math.sin(a) * R, panelY, Math.cos(a) * R);
        dummy.lookAt(Math.sin(a) * R * 2, panelY, Math.cos(a) * R * 2); // 面朝环外
        dummy.rotateX(PANEL_TILT); // 微仰（高空俯瞰可见板面）
        return dummy.quaternion.clone();
      }),
    [baseAngles, R, panelY],
  );

  /** 板 i 的世界位置（含环转角与浮动；相机追踪与渲染共用同一公式） */
  const panelWorld = (i: number, t: number): THREE.Vector3 => {
    const a = baseAngles[i] + omega * t;
    const bob = Math.sin(t * 0.9 + i * 1.31) * 0.05 * worldScale;
    return new THREE.Vector3(Math.sin(a) * R, panelY + bob, Math.cos(a) * R);
  };

  /** 环转角（渲染树 group 旋转用；与 panelWorld 同源） */
  const ringAngle = omega * tSec;

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


  /** 机位解算（纯帧函数；rig 与标题朝向共用，相位边界严格连续） */
  const poseOf = (f: number): {pos: THREE.Vector3; target: THREE.Vector3} => {
    const t = f / FPS;
    const q = Math.min(1, Math.max(0, f / Math.max(1, totalFrames)));
    const gap = (Math.PI * 2) / n; // 相邻板角距（沿机位扫过的方向取正）
    const angleOf = (i: number) => baseAngles[i] + omega * t;
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    if (q < OPEN_END) {
      // 开场：沿板 0 正前轴线高空压下——第一块板从第一帧起就是画面主体
      const e = easeCam(q / OPEN_END, easeP);
      // 正对板 0 轴线（旧版停「板 0 前一格」，n=3 时恰是板 n-1 正前方：转场进来先看到最后一块板的素材再横穿 120°，顺序错乱+途中全侧棱）
      const az = angleOf(0);
      const r = THREE.MathUtils.lerp(R * 2.2, dwellFarOf(0), e);
      pos.set(Math.sin(az) * r, THREE.MathUtils.lerp(7.4 * worldScale, camY, e), Math.cos(az) * r);
      target.lerpVectors(new THREE.Vector3(0, 1.4 * worldScale, 0), panelWorld(0, t), e);
    } else if (q >= OUTRO_START) {
      // 收尾：沿环外弧再扫一段 + 拉升高空回看整环
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const az = angleOf(n - 1) + e * 0.95 * spd;
      const r = THREE.MathUtils.lerp(dwellNear, R * 2.25, e);
      pos.set(Math.sin(az) * r, THREE.MathUtils.lerp(camY, 7.3 * worldScale, e), Math.cos(az) * r);
      target.copy(panelWorld(n - 1, t)).lerp(new THREE.Vector3(0, 1.35 * worldScale, 0), sm(e));
    } else {
      const ph = panelPhaseAt(tl, f);
      const i = ph.i;
      if (!ph.dwell) {
        if (i === 0) {
          // travel0：开场已沿板 0 正前轴线压下，无方位扫描——原地保持（与开场末/驻留始严格连续）
          const r = dwellFarOf(0);
          pos.set(Math.sin(angleOf(0)) * r, camY, Math.cos(angleOf(0)) * r);
          target.copy(panelWorld(0, t));
        } else {
        // travel：机位方位角从板 i-1 扫到板 i（弧线外抛 + 微下沉），注视贝塞尔过渡；
        // 半径从 dwellNear（上站末）连续张到有效远距（下站始），中段外抛加弧按速度档 × 站级微差。
        // 方位角先行（eA 快于 e）：线性扫角会让转场中段两块板都呈侧棱（「从第一张直接移到
        // 第二张、左边看不见」）——提前转到目标板方位，转场后 60% 目标板正面可读
        const e = easeCam(ph.p, easeP);
        const eA = 1 - Math.pow(1 - e, 1.55);
        const az = angleOf(i) - (1 - eA) * gap;
        // 起始半径：travel0 = 开场终点（有效远距），其余 = 上站驻留末（dwellNear）
        const r0 = i === 0 ? dwellFarOf(0) : dwellNear;
        const r =
          r0 +
          (dwellFarOf(i) - r0) * sm(e) +
          Math.sin(e * Math.PI) * 1.25 * spd * (0.85 + 0.3 * stationJitter(i, 7)) * worldScale;
        pos.set(Math.sin(az) * r, camY - Math.sin(e * Math.PI) * 0.2 * worldScale, Math.cos(az) * r);
        const mid = new THREE.Vector3(0, panelY + 0.5 * worldScale, 0);
        const eT = 1 - Math.pow(1 - e, 1.3); // 注视同步先行：目标板尽早成为画面主体
        quadBezier(panelWorld(i - 1, t), mid, panelWorld(i, t), eT, target);
        }
      } else {
        // dwell：贴在板 i 正前方共旋缓推，注视板心（背景粒子反向掠过）
        const e = easeCam(ph.p, easeP);
        const az = angleOf(i);
        const r = dwellNear + (dwellFarOf(i) - dwellNear) * (1 - e);
        pos.set(Math.sin(az) * r, camY, Math.cos(az) * r);
        target.copy(panelWorld(i, t));
      }
    }
    return {pos, target};
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

  const themeIdx = Math.min(5, Math.max(0, Math.round(p('themeColor'))));
  const accent = themeIdx > 0 ? THEME_ACCENTS[themeIdx] : brandColor || '#3B82F6';
  const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
  const {pos: camPos} = poseOf(frame);

  // 标题/副标题：环心上方悬浮，始终面向相机（billboard 朝向 = 机位方位角）
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));
  const billYaw = Math.atan2(camPos.x, camPos.z);
  // v28 场景解耦：环台是开放展台，场景件在展台四周/上方展开（sceneStyle 可换）
  const sceneIdx = Math.round(p('sceneStyle'));
  const inkText = sceneIsLight(sceneIdx);
  const sceneCss = sceneBackdrop(sceneIdx);
  const coreOn = coreGlow > 0;
  const coreBoost = coreGlow === 2 ? 1.4 : 1;

  // 灯环几何（dispose 兜底）
  const floorRingGeom = useMemo(() => new THREE.TorusGeometry(R, 0.035 * worldScale, 8, 96), [R, worldScale]);
  const outerRingGeom = useMemo(() => new THREE.TorusGeometry(R + 1.25 * worldScale, 0.018 * worldScale, 6, 96), [R, worldScale]);
  const coreGeom = useMemo(() => new THREE.CylinderGeometry(0.24 * worldScale, 0.3 * worldScale, coreH, 20), [worldScale, coreH]);
  const haloGeom = useMemo(() => new THREE.CylinderGeometry(0.62 * worldScale, 0.72 * worldScale, coreH, 20, 1, true), [worldScale, coreH]);
  useEffect(
    () => () => {
      floorRingGeom.dispose();
      outerRingGeom.dispose();
      coreGeom.dispose();
      haloGeom.dispose();
    },
    [floorRingGeom, outerRingGeom, coreGeom, haloGeom],
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

      {/* 3D 舞台；rig="none"：相机由 CarouselRig 接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={Math.max(1, R / 3.4)}
        ambienceCones={false}
        totalFrames={totalFrames}
        fov={42}
        shadows
        shadowY={0.015}
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
        <CarouselRig poseOf={poseOf} />

        {/* v28 环境场景包（星空/银河/山水/…可换；默认纯净 = 原生观感） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={new THREE.Vector3(0, panelY, 0)}
          spanZ={RING_R * 2}
          radiusX={RING_R}
          ground={false}
          glow={coreGlow}
        />

        {/* 地面圆盘 + 地面发光灯环（展环投影）+ 外圈暗环 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <circleGeometry args={[R + 2.6 * worldScale, 64]} />
          <meshStandardMaterial color="#0B101B" roughness={0.4} metalness={0.55} />
        </mesh>
        <mesh geometry={floorRingGeom} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03 * worldScale, 0]}>
          <meshBasicMaterial color={accent} transparent opacity={0.75} toneMapped={false} />
        </mesh>
        <mesh geometry={outerRingGeom} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025 * worldScale, 0]}>
          <meshBasicMaterial color={accent} transparent opacity={0.28} toneMapped={false} />
        </mesh>

        {/* v27 高空外轨道：倾斜光环 + 两颗对相轨道光点（环台「星系」感）+ 悬浮微粒 */}
        <mesh rotation={[Math.PI / 2 - 0.26, 0, 0.18]} position={[0, panelY + 1.7 * worldScale, 0]}>
          <torusGeometry args={[R * 1.46, 0.018 * worldScale, 8, 80]} />
          <meshBasicMaterial color={accent} transparent opacity={0.24} toneMapped={false} depthWrite={false} />
        </mesh>
        <OrbitingDot radius={R * 1.46} y={panelY + 1.7 * worldScale} omega={0.42} phase={0} ws={worldScale} color={accent} size={0.07} />
        <OrbitingDot radius={R * 1.46} y={panelY + 1.7 * worldScale} omega={0.42} phase={Math.PI} ws={worldScale} color="#C9DDFF" size={0.055} opacity={0.7} />
        <FloatingMotes count={70} center={new THREE.Vector3(0, panelY + 0.6 * worldScale, 0)} spread={new THREE.Vector3(R * 3, 3.4 * worldScale, R * 3)} ws={worldScale} color={accent} opacity={0.24} size={0.05} speed={0.016} />

        {/* 中央光柱（核心 + 加色光环晕） */}
        {coreOn && (
          <group>
            <mesh geometry={coreGeom} position={[0, coreH / 2 + 0.35 * worldScale, 0]}>
              <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.9 * coreBoost} roughness={0.35} metalness={0.3} />
            </mesh>
            <mesh geometry={haloGeom} position={[0, coreH / 2 + 0.35 * worldScale, 0]}>
              <meshBasicMaterial color={accent} transparent opacity={0.14 * coreBoost} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
            </mesh>
            <mesh position={[0, coreH + 0.5 * worldScale, 0]}>
              <sphereGeometry args={[0.16 * worldScale, 20, 20]} />
              <meshStandardMaterial color="#FFFFFF" emissive={accent} emissiveIntensity={1.4} roughness={0.25} />
            </mesh>
          </group>
        )}

        {/* 展环（整体缓旋；板面朝环外微仰） */}
        <group rotation={[0, ringAngle, 0]}>
          {panels.map((panel, i) => {
            const a = baseAngles[i];
            const bob = Math.sin(tSec * 0.9 + i * 1.31) * 0.05 * worldScale;
            const v = panel.video?.type === 'video' ? panel.video : undefined;
            // 美化光标的媒体时间：驻留窗口内才显示（素材绝对秒 = trimStart + 窗口内已播秒）
            const curSec = v && v.cursorPoints && v.cursorPoints.length > 0
              ? (v.trimStart ?? 0) + Math.max(0, Math.min(frame - (dwellStartFrames[i] ?? 0), Math.round(tl.dwellDur[i] ?? 1))) / FPS
              : -1;
            return (
              <group key={`pn${i}`} position={[Math.sin(a) * R, panelY + bob, Math.cos(a) * R]} quaternion={panelQuats[i]}>
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
        </group>

        {/* 环心上方大标题（开场；billboard 面向相机，旅行启动后收起） */}
        {text.title && (
          <group position={[0, coreH + 1.5 * worldScale, 0]} rotation={[0, billYaw, 0]} scale={titleScale}>
            <ThreeText text={text.title} size={0.6 * worldScale} depth={0.12 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={9 * worldScale} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 收尾副标题（环心上方，billboard） */}
        {text.subtitle && (
          <group position={[0, coreH + 1.5 * worldScale, 0]} rotation={[0, billYaw, 0]} scale={subtitleScale}>
            <ThreeText text={text.subtitle} size={0.48 * worldScale} depth={0.1 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={9 * worldScale} startFrame={Math.round(OUTRO_START * totalFrames) + 4} stagger={2} />
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

export default OrbitCarousel3D;
