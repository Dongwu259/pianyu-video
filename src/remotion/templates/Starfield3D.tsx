/**
 * 模板 47: Starfield3D - 3D 深空星域（three.js WebGL，开放星空一镜巡航）
 *
 * 与 CameraJourney3D 同族的媒体场景模板：无墙无地的开放深空，媒体展板像
 * 空间站一样漂浮散布，星座连线把它们串成「星图」，相机漂移巡航逐板驻留——
 *   开场 12%：从远处漂入，星图全景 + 大标题悬浮；
 *   每站 i ：travel（贝塞尔漂移：上一驻留位 → 星图外侧中点 → 下一驻留位）
 *             → dwell（板正前方缓推，视频展板仅驻留窗口播放）；
 *   收尾 8% ：后拉升高回看整张星图（星座连线全貌），副标题浮现中央。
 *
 * 视觉签名（深空三件套）：
 * - 星点：确定性球壳星场（THREE.Points，~520-760 颗），整体极慢旋转（帧驱动）；
 * - 星云：远景大尺度品牌色柔光斑（CanvasTexture 径向渐变 + 加色混合）；
 * - 星座连线：相邻展板之间的发光连线 + 站位节点球——「星图」的点题细节。
 *
 * - 展板：PanelBoard 共用组件；每板法向先定义（朝入口侧 ±30° 散布），板面
 *   lookAt 驻留机位方向——驻留时正对相机。无任何墙体，零嵌结构。
 * - 相机：自研 StarRig（ThreeStage rig="none"），全部 useCurrentFrame 插值，
 *   禁 Clock/delta；travel 中点向入口侧外抛（相机始终在板面朝向的一侧）。
 * - 缓动/速度：camEase 三档缓动族 + camSpeed 三档 + 站级确定性微差（与 3D 家族同族）。
 * - 布局确定性：站位/星点/星云全部由 stationJitter 整数哈希派生，逐帧渲染可复现。
 *
 * 文案编码（同 CameraJourney3D）：title = 开场星图大标题；subtitle = 收尾浮现；
 * features 第 i 行 = 第 i 块展板标题（无素材的行 = 纯文字展板）。
 *
 * 个性化参数（STARFIELD_3D_PARAMS）：dwellRatio 驻留节奏 / panelSize 展板大小 /
 * ambience 氛围（星尘）/ starGlow 星空亮度。
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
import {STARFIELD_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.2; // * 展板宽（16:9）
const PANEL_RATIO = 9 / 16;
const SPACING = 7.0; // * 相邻展板 z 间距（散布在此基础上抖动）
const HEAD_PAD = 7.5; // * 首板距入场位
const SCATTER_X = 2.6; // * 展板横向散布半径
const DWELL_FAR = 3.15; // * 驻留起始相机距离（缓推到 DWELL_NEAR；稍后拉露出星域环境）
const DWELL_NEAR = 2.75; // *
const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准）
const FALLBACK_FEATURES = ['星图串起 每一站', '深空巡航 一镜到底'];

/** 站位几何：散布挂位 + 朝向（法向先定义，板面 lookAt 驻留机位方向） */
interface StarStation {
  panelPos: THREE.Vector3;
  normal: THREE.Vector3; // 展板法向（朝入口侧 ±30° 散布），驻留机位 = panelPos + normal·d
  quaternion: THREE.Quaternion;
}

/** 星域相机：远漂入场 → 逐站 travel/dwell → 后拉回看星图 */
const StarRig: React.FC<{
  stations: StarStation[];
  center: THREE.Vector3;
  entranceZ: number;
  totalFrames: number;
  dwellFrac: number;
  dwellFar: number;
  dwellNear: number;
  /** 世界缩放（竖版收尾机位常量同缩） */
  ws: number;
  /** 缓动性格（0 干脆 / 1 柔和 / 2 丝滑）与速度档（行程/推送缩放） */
  /** 逐板时间线（focusPanel/focusBoost 权重后的 travel/dwell 边界） */
  tl: PanelTimeline;
  easeP: number;
  spd: number;
}> = ({stations, center, entranceZ, totalFrames, dwellFrac, dwellFar, dwellNear, ws, easeP, spd, tl}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  useFrame(() => {
    const n = stations.length;
    const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));

    /** 站 i 驻留机位（progress 0→1：有效远距缓推到 dwellNear） */
    const dwellPose = (i: number, e: number): THREE.Vector3 => {
      const st = stations[i];
      const d = dwellNear + (dwellFarOf(i) - dwellNear) * (1 - e);
      return new THREE.Vector3().copy(st.panelPos).addScaledVector(st.normal, d);
    };

    if (q < OPEN_END) {
      // 开场：从星图外上侧漂入 travel0 起点位（严格连续）
      const e = easeCam(q / OPEN_END, easeP);
      const start = new THREE.Vector3(center.x + 5 * ws, center.y + 3.6 * ws, entranceZ + 12 * spd * ws);
      pos.copy(start).lerp(dwellPose(0, 0).add(new THREE.Vector3(0, 0.4 * ws, 0)), e);
      target.copy(center).lerp(stations[0].panelPos, e);
    } else if (q >= OUTRO_START) {
      // 收尾：后拉升高回看整张星图（星座连线全貌）
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const last = stations[n - 1];
      const endPose = new THREE.Vector3(center.x, center.y + 4.6 * ws, entranceZ + 8.5 * spd * ws);
      pos.copy(dwellPose(n - 1, 1)).lerp(endPose, e);
      target.copy(last.panelPos).lerp(center, e);
    } else {
      const ph = panelPhaseAt(tl, frame);
      const i = ph.i;
      const st = stations[i];
      if (!ph.dwell) {
        // travel：贝塞尔漂移；中点向入口侧外抛（相机始终在板面朝向的一侧），
        // 外抛量按速度档 × 站级微差缩放（破「每站一模一样」的节拍器感）
        const e = easeCam(ph.p, easeP);
        const prevPos = i === 0 ? dwellPose(0, 0).add(new THREE.Vector3(0, 0.4 * ws, 0)) : dwellPose(i - 1, 1);
        const nextPos = dwellPose(i, 0);
        const mid = new THREE.Vector3(
          (prevPos.x + nextPos.x) / 2,
          (prevPos.y + nextPos.y) / 2 + 0.45 * ws,
          (prevPos.z + nextPos.z) / 2 + (1.0 + 0.5 * stationJitter(i, 7)) * spd * ws,
        );
        quadBezier(prevPos, mid, nextPos, e, pos);
        // 注视：上一展板 → 下一展板（漂移中视线自然过渡）
        quadBezier(i === 0 ? stations[0].panelPos : stations[i - 1].panelPos, st.panelPos, st.panelPos, e, target);
      } else {
        // dwell：板正前方缓推，注视板心
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

export const Starfield3D: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, brandColor}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 16) * FPS);

  const p = makeParamReader(STARFIELD_3D_PARAMS, params);
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const starGlow = Math.min(2, Math.max(0, Math.round(p('starGlow'))));
  const linkLines = Math.min(6, Math.max(0, Math.round(p('linkLines'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];

  // 竖版：世界整体缩小 + 驻留拉远（窄横向视场保住展板全身）
  const worldScale = isPortrait ? 0.58 : 1;
  const distScale = isPortrait ? 2.9 : 1;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const spacing = SPACING * worldScale;
  const scatterX = SCATTER_X * worldScale;
  const dwellFar = DWELL_FAR * ps * distScale;
  const dwellNear = DWELL_NEAR * ps * distScale;

  // ====== 展板装配（同 CameraJourney3D 口径） ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 星图站位：沿 -Z 散布（横向 ±2.6、高低错落、法向朝入口 ±30°） ======
  const n = panels.length;
  const entranceZ = 0;
  const headPad = HEAD_PAD * worldScale;
  const stations: StarStation[] = useMemo(
    () =>
      panels.map((_, i) => {
        const x = (stationJitter(i, 3) - 0.5) * 2 * scatterX;
        const y = (2.1 + stationJitter(i, 5) * 1.7 + Math.sin(i * 1.31) * 0.2) * worldScale;
        const z = -(headPad + i * spacing + (stationJitter(i, 9) - 0.5) * 1.6 * worldScale);
        const panelPos = new THREE.Vector3(x, y, z);
        // 法向朝入口侧 ±30° 散布（板面 lookAt 驻留机位 → 驻留正对）
        const yaw = (stationJitter(i, 17) - 0.5) * (Math.PI / 3);
        const normal = new THREE.Vector3(Math.sin(yaw), -0.06, Math.cos(yaw)).normalize();
        const dummy = new THREE.Object3D();
        dummy.position.copy(panelPos);
        dummy.lookAt(new THREE.Vector3().copy(panelPos).addScaledVector(normal, 1));
        return {panelPos, normal, quaternion: dummy.quaternion.clone()};
      }),
    [panels, scatterX, worldScale, headPad, spacing],
  );
  const center = useMemo(() => {
    const c = new THREE.Vector3();
    stations.forEach((st) => c.add(st.panelPos));
    return stations.length ? c.multiplyScalar(1 / stations.length) : c;
  }, [stations]);

  // v28 场景解耦：星壳/星云/行星系/冰晶收敛进场景包（sceneStyle 默认档 = 原生星空，观感不变）
  const sceneIdx = Math.round(p('sceneStyle'));
  // 星图连线锚点（板间星座连线留在模板：这是运动签名的一部分）
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
  // 亮色场景（水墨纸底）：悬浮标题换墨色字，白字在纸底会隐形
  const inkText = sceneIsLight(sceneIdx);
  const sceneCss = sceneBackdrop(sceneIdx);
  const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));

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

      {/* 3D 舞台（无地面：深空）；rig="none"：相机由 StarRig 接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={Math.max(1, (n * spacing) / 9)}
        ambienceCenterXZ={[center.x, center.z]}
        ambienceCones={false}
        totalFrames={totalFrames}
        fov={44}
        shadows={false}
      >
        {videoTextures.map((vst, i) => (
          <vst.Bridge key={`br${i}`} />
        ))}
        {imageTextures.map((it, i) => (
          <it.Bridge key={`ib${i}`} />
        ))}
        <StarRig stations={stations} center={center} entranceZ={entranceZ} totalFrames={totalFrames} dwellFrac={dwellFrac} dwellFar={dwellFar} dwellNear={dwellNear} ws={worldScale} easeP={easeP} spd={spd} tl={tl} />

        {/* v28 环境场景包（星空/银河/山水/水墨/…可换；默认星空 = 原生观感） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={center}
          spanZ={headPad + (n - 1) * spacing + 2 * worldScale}
          radiusX={scatterX}
          ground
          glow={starGlow}
        />

        {/* 星座连线（v27：直棍 → 柔和弧线；相邻常驻 + linkLines 跨板加密）+ 站位节点球（运动签名，留模板） */}
        <LinkArcs anchors={anchors} count={n - 1 + linkLines} radius={0.014 * worldScale} color={accent} opacity={0.45} ws={worldScale} salt={77} bowScale={0.09} />
        {stations.map((st, i) => (
          <mesh key={`nd${i}`} position={new THREE.Vector3().copy(st.panelPos).addScaledVector(st.normal, -0.3 * worldScale)}>
            <sphereGeometry args={[0.075 * worldScale, 14, 14]} />
            <meshStandardMaterial color="#FFFFFF" emissive={accent} emissiveIntensity={0.8} roughness={0.3} metalness={0.2} />
          </mesh>
        ))}

        {/* 展板组（漂浮微动 + 朝向驻留机位） */}
        {stations.map((st, i) => {
          const panel = panels[i];
          const floatY = Math.sin(tSec * 0.75 + i * 1.33) * 0.045 * worldScale;
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
              />
            </group>
          );
        })}

        {/* 开场星图大标题（面向入口来向；旅行启动后收起；亮色场景换墨色字） */}
        {text.title && (
          <group position={[center.x, center.y + 2.7 * worldScale, entranceZ - 3.4 * worldScale]} scale={titleScale}>
            <ThreeText text={text.title} size={0.66 * worldScale} depth={0.13 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={8 * worldScale} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 收尾副标题（星图中央浮现） */}
        {text.subtitle && (
          <group position={[center.x, center.y + 1.15 * worldScale, center.z]} scale={subtitleScale}>
            <ThreeText text={text.subtitle} size={0.55 * worldScale} depth={0.1 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={8 * worldScale} startFrame={Math.round(OUTRO_START * totalFrames) + 4} stagger={2} />
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

export default Starfield3D;
