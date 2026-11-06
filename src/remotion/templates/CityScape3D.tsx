/**
 * 模板 45: CityScape3D - 3D 城市天际线（three.js WebGL，夜景街道峡谷一镜到底）
 *
 * 与 CameraJourney3D 同族的媒体场景模板：媒体展板做成夜色楼体上的霓虹巨幕，
 * 相机沿街道峡谷低空飞行，逐楼驻留仰望——
 *   开场 12%：城市上空高位推入街口（楼群剪影 + 灯带纵深展开），大标题悬浮街口上空；
 *   每站 i ：travel（沿街贝塞尔飞行，注视点上一巨幕 → 街道前方 → 下一巨幕）
 *             → dwell（悬停在巨幕正前方缓推仰望，视频展板仅驻留窗口播放）；
 *   收尾 8% ：越过末楼升空，回望整条亮灯的街道峡谷，副标题浮现。
 *
 * 视觉签名（都市夜景三件套）：
 * - 巨幕：展板平贴楼体立面（法向严格 ±x，零嵌墙），板底霓虹光条 + 楼体剪影托底；
 * - 窗格灯：楼体立面稀疏的横向亮窗带（确定性伪随机楼层），城市呼吸感；
 * - 街道：深色路面 + 两条品牌色车道光带，纵深引导线；尽头远景楼群剪影收住视野。
 *
 * - 展板：PanelBoard 共用组件；挂位高度按站确定性错落（3.4-5.2），驻留机位微仰。
 * - 相机：自研 CityRig（ThreeStage rig="none"），全部 useCurrentFrame 插值，
 *   禁 Clock/delta；travel 走二次贝塞尔（上一驻留机位 → 街轴点 → 下一驻留机位）。
 * - 缓动/速度：camEase 三档缓动族 + camSpeed 三档 + 站级确定性微差（与四款 3D 模板同族）。
 * - 布局确定性：楼体/窗带/挂高全部由 stationJitter 整数哈希派生，逐帧渲染可复现。
 *
 * 文案编码（同 CameraJourney3D）：title = 开场街口大标题；subtitle = 回望浮现；
 * features 第 i 行 = 第 i 块巨幕标题（无素材的行 = 纯文字展板）。
 *
 * 个性化参数（CITY_SCAPE_3D_PARAMS）：dwellRatio 驻留节奏 / panelSize 展板大小 /
 * ambience 氛围 / neonGlow 霓虹亮度。
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
import {LinkArcs} from '../three/scene-dress';
import {SceneEnv, sceneBackdrop} from '../three/scene-packs';
import {sceneIsLight} from '../../shared/three-scenes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {CITY_SCAPE_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.3; // * 巨幕宽（16:9）
const PANEL_RATIO = 9 / 16;
const PANEL_Y_LO = 3.4; // * 巨幕挂高下界（仰望感）
const PANEL_Y_HI = 5.2; // * 巨幕挂高上界
const HALF_W = 7.5; // * 街道半宽（楼体立面 x；比艺廊宽——城市尺度）
const BLD_H_LO = 7.5; // * 楼体高下界
const BLD_H_HI = 15.0; // * 楼体高上界
const SPACING = 6.4; // * 相邻巨幕 z 间距
const HEAD_PAD = 7.0; // * 首幕距街口
const TAIL_PAD = 9.0; // * 末幕距远景楼群
const DWELL_FAR = 3.35; // * 驻留起始相机距离（缓推到 DWELL_NEAR；视觉复核：留出板外楼体边缘）
const DWELL_NEAR = 2.9; // *
const CAM_Y = 2.0; // * 街面飞行高度

const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准）
const FALLBACK_FEATURES = ['霓虹街景 逐楼细品', '一镜到底 穿过整条街'];

/** 站位几何：巨幕挂位 + 朝向（平贴楼体立面，法向严格 ±x——零嵌墙） */
interface CityStation {
  panelPos: THREE.Vector3;
  normal: THREE.Vector3; // 巨幕法向（朝街心），驻留机位 = panelPos + normal·d
  quaternion: THREE.Quaternion;
  side: 1 | -1; // 1 = 右侧楼体（+x），-1 = 左侧
}

/** 街谷相机：上空推入 → 逐站 travel/dwell → 升空回望 */
const CityRig: React.FC<{
  stations: CityStation[];
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
    // 街道灭点注视位（开场终点 = travel0 首控制点）
    const vanish = new THREE.Vector3(0, 3.2 * ws, endZ - 4);
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));

    /** 站 i 驻留机位（progress 0→1：有效远距缓推到 dwellNear；微仰巨幕） */
    const dwellPose = (i: number, e: number): THREE.Vector3 => {
      const st = stations[i];
      const d = dwellNear + (dwellFarOf(i) - dwellNear) * (1 - e);
      return pos.copy(st.panelPos).addScaledVector(st.normal, d).setY(st.panelPos.y - 0.35 * ws);
    };

    if (q < OPEN_END) {
      // 开场：城市上空推入街口（高位俯冲感），终点 = travel0 起点（严格连续）
      const e = easeCam(q / OPEN_END, easeP);
      pos.set(0, THREE.MathUtils.lerp(11 * ws, camY, e), entranceZ + (1 - e) * 13 * spd * ws);
      target.lerpVectors(tmp.set(0, 6.5 * ws, endZ - 6), vanish, e);
    } else if (q >= OUTRO_START) {
      // 收尾：越过末楼升空，回望整条亮灯的街谷
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const last = stations[n - 1];
      const dwellEnd = tmp.copy(dwellPose(n - 1, 1)).clone();
      const skyPose = new THREE.Vector3(0, 9.5 * ws, endZ - 1.5 * ws);
      pos.copy(dwellEnd).lerp(skyPose, e);
      target.copy(last.panelPos).lerp(tmp2.set(0, 2.4 * ws, entranceZ + 6), e * 0.7);
    } else {
      const ph = panelPhaseAt(tl, frame);
      const i = ph.i;
      const st = stations[i];
      if (!ph.dwell) {
        // travel：上一驻留机位 → 街轴点 → 下一驻留机位（贝塞尔低空穿行）；
        // 行程下沉量按速度档 × 站级微差缩放（破「每站一模一样」的节拍器感）
        const e = easeCam(ph.p, easeP);
        const prevPos = i === 0 ? tmp.set(0, camY, entranceZ) : tmp.copy(dwellPose(i - 1, 1)).clone();
        const nextPos = dwellPose(i, 0).clone();
        const mid = new THREE.Vector3(0, camY + 0.5 * ws, (prevPos.z + nextPos.z) / 2 - 0.5 * spd * (0.85 + 0.3 * stationJitter(i, 7)));
        quadBezier(prevPos, mid, nextPos, e, pos);
        // 注视：上一巨幕（travel0 = 灭点）→ 街道前方 → 下一巨幕
        const ahead = new THREE.Vector3(0, (prevPos.y + nextPos.y) / 2, nextPos.z - 5.5);
        quadBezier(i === 0 ? vanish : stations[i - 1].panelPos, ahead, st.panelPos, e, target);
      } else {
        // dwell：巨幕正前方缓推仰望，注视巨幕中心
        const e = easeCam(ph.p, easeP);
        pos.copy(dwellPose(i, e));
        target.copy(st.panelPos);
      }
    }
    camera.position.copy(pos);
    camera.lookAt(target);
  });
  return null;
};

export const CityScape3D: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, brandColor}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 16) * FPS);

  const p = makeParamReader(CITY_SCAPE_3D_PARAMS, params);
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const panelAlt = Math.min(1, Math.max(0, Math.round(p('panelSides'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const neonGlow = Math.min(2, Math.max(0, Math.round(p('neonGlow'))));
  const linkLines = Math.min(6, Math.max(0, Math.round(p('linkLines'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];

  // 竖版：世界整体缩小 + 驻留拉远（窄横向视场保住巨幕全身）
  const worldScale = isPortrait ? 0.58 : 1;
  const distScale = isPortrait ? 2.9 : 1;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const halfW = HALF_W * worldScale;
  const spacing = SPACING * worldScale;
  const dwellFar = DWELL_FAR * ps * distScale;
  const dwellNear = DWELL_NEAR * ps * distScale;
  const camY = CAM_Y * worldScale;
  const neonOn = neonGlow > 0;
  const neonBoost = neonGlow === 2 ? 1.35 : 1;

  // ====== 展板装配（同 CameraJourney3D 口径） ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 街谷几何：巨幕左右交替平贴楼体立面，挂高确定性错落 ======
  const n = panels.length;
  const entranceZ = 0;
  const headPad = HEAD_PAD * worldScale;
  const endZ = -(headPad + (n - 1) * spacing + TAIL_PAD * worldScale);
  const stations: CityStation[] = useMemo(
    () =>
      panels.map((_, i) => {
        const side: 1 | -1 = panelAlt === 1 ? (i % 2 === 0 ? -1 : 1) : -1; // panelSides：0 同侧挂墙（防左右横跳眩晕）/ 1 左右交替
        // 挂高确定性错落（3.4-5.2）：城市巨幕有高低参差，不是美术馆的齐平挂线
        const panelY = (PANEL_Y_LO + stationJitter(i, 29) * (PANEL_Y_HI - PANEL_Y_LO)) * worldScale;
        // 平贴楼体立面：法向严格 ±x（同艺廊教训——斜挂会嵌墙）
        const panelPos = new THREE.Vector3(side * (halfW - 0.06), panelY, -(headPad + i * spacing));
        const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (-side * Math.PI) / 2, 0));
        const normal = new THREE.Vector3(-side, 0, 0);
        return {panelPos, normal, quaternion, side};
      }),
    [panels, halfW, worldScale, headPad, spacing],
  );

  // ====== v28 场景解耦：楼体/窗灯/天际线/楼顶件/路灯/车轨收敛进场景包
  // （sceneStyle 默认档 = 原生都市，几何公式与 salts 原样搬移，观感不变）；
  // 模板保留：路面 + 车道光带（运动轴）、板底霓虹条、板间霓虹弧线（运动签名）。
  const sceneIdx = Math.round(p('sceneStyle'));
  const midZ = (entranceZ + endZ) / 2;
  const anchors = useMemo(() => stations.map((st) => st.panelPos.clone()), [stations]);

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
  const streetLen = entranceZ - endZ + 26 * worldScale;
  const shadowOn = Math.round(p('shadowLevel')) === 1;
  const shadowCenter: [number, number] = [0, midZ];
  const shadowBounds = streetLen / 2 + 5;

  const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
  // 亮色场景（水墨纸底）：悬浮标题换墨色字
  const inkText = sceneIsLight(sceneIdx);
  const sceneCss = sceneBackdrop(sceneIdx);
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));
  const titleZ = entranceZ - 2.6 * worldScale;
  const subtitleZ = endZ - 2.0 * worldScale;

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

      {/* 3D 舞台；rig="none"：相机由 CityRig 接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={Math.max(1, streetLen / 9)}
        ambienceCenterXZ={[0, midZ]}
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
        <CityRig stations={stations} entranceZ={entranceZ} endZ={endZ} totalFrames={totalFrames} dwellFrac={dwellFrac} dwellFar={dwellFar} dwellNear={dwellNear} camY={camY} ws={worldScale} easeP={easeP} spd={spd} tl={tl} />

        {/* 街道路面 + 品牌色车道光带 ×2（纵深引导线；运动轴，留模板） */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, midZ - 6 * worldScale]} receiveShadow>
          <planeGeometry args={[halfW * 2, streetLen]} />
          <meshStandardMaterial color="#07090F" roughness={0.42} metalness={0.5} />
        </mesh>
        {neonOn &&
          [-1, 1].map((s) => (
            <mesh key={`lane${s}`} position={[s * 1.15 * worldScale, 0.015, midZ - 6 * worldScale]}>
              <boxGeometry args={[0.07, 0.02, streetLen * 0.96]} />
              <meshBasicMaterial color={accent} transparent opacity={0.4 * neonBoost} toneMapped={false} />
            </mesh>
          ))}

        {/* v28 环境场景包（都市/乡村/古建/山水/…可换；默认都市 = 原生观感） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={new THREE.Vector3(0, camY, midZ)}
          spanZ={entranceZ - endZ}
          radiusX={halfW}
          ground={false}
          glow={neonGlow}
        />

        {/* 巨幕组：板底霓虹光条 + 板体（平贴立面） */}
        {stations.map((st, i) => {
          const panel = panels[i];
          const floatY = Math.sin(tSec * 0.7 + i * 1.21) * 0.02 * worldScale;
          const panelX = st.panelPos.x;
          return (
            <group key={`st${i}`}>
              {neonOn && (
                <mesh position={[panelX - st.side * 0.05, st.panelPos.y - ph / 2 - 0.22, st.panelPos.z]}>
                  <boxGeometry args={[0.05, 0.07, pw * 0.82]} />
                  <meshBasicMaterial color={accent} transparent opacity={0.85 * neonBoost} toneMapped={false} />
                </mesh>
              )}
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

        {/* v27 楼间霓虹弧线（跨街拉弧，linkLines 数量可调；运动签名留模板） */}
        {neonOn && <LinkArcs anchors={anchors} count={linkLines} radius={0.02 * worldScale} color={accent} opacity={0.3} ws={worldScale} salt={73} bowScale={0.3} />}

        {/* 开场街口大标题（旅行启动后收起；亮色场景换墨色字） */}
        {text.title && (
          <group position={[0, (PANEL_Y_HI + 1.15) * worldScale, titleZ]} scale={titleScale}>
            <ThreeText text={text.title} size={0.66 * worldScale} depth={0.13 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={halfW * 2 * 0.86} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 回望副标题（收尾窗口现身） */}
        {text.subtitle && (
          <group position={[0, (PANEL_Y_HI + 0.9) * worldScale, subtitleZ]} rotation={[0, Math.PI, 0]} scale={subtitleScale}>
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

export default CityScape3D;
