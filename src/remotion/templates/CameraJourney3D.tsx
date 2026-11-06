/**
 * 模板 41: CameraJourney3D - 3D 旅程（three.js WebGL，一镜到底路径相机）
 *
 * 用户设想落地：把模拟摄像机搬进 3D 空间——一条发光的蜿蜒路径（TubeGeometry 管，
 * 视觉签名）串起 2-6 块媒体/文字展板，相机一镜到底：
 *   开场 12%：高位侧后方远景俯瞰整条线（「线条串起所有内容」的构图），大标题悬浮入场；
 *   每站 i ：travel（相机沿曲线 getPointAt 加速飞行，smoothstep 加减速，注视点从上一展板
 *             经切线前方平滑转向下一展板）→ dwell（展板正前方 2.75→2.4 缓慢推近，
 *             视频展板仅在驻留窗口内实时播放，离开即冻结）；
 *   收尾 8% ：从末板后拉升高，回收远景构图（与开场呼应），副标题 ThreeText 浮现。
 *
 * - 路径：内容哈希种子确定性控制点（XZ 蜿蜒、偏转符号带惯性、Y 轻微起伏，
 *   相邻间距 7-12 单位，9 控制点）→ CatmullRomCurve3；纯函数 journeyControlPoints 在
 *   scene-dress（单测锚定板间曲率）。同文案同路径（逐帧渲染可复现）。站位居首/尾各 12% 避让后沿线均布。
 * - 展板：RoundedBox 薄板（16:9）+ 品牌色描边发光底板；法向交替左右偏移 2.2，朝向线的
 *   来向（lookAt 曲线 u−0.015 处，约 17° 微侧）；微弱 sin 浮动（相位按 i 错开）。
 *   视频 = VideoScreenTexture（帧精确抽帧，双半结构见其头注）；图片 = CanvasTexture
 *   cover 裁切（videoServer CORS 已通）；纯文字展板 = ThreeText 大字；媒体展板的标题做成
 *   板面底部暗条 ThreeText（任何驻留距离都在画内）。
 * - 相机：自研路径相机（ThreeStage rig="none" 关掉 CameraRig 预设），全部 useCurrentFrame
 *   插值，禁 Clock/delta；曲线按参数直接插值采样（无每帧大数组）。位置在开场/驻留/飞行
 *   各段窗口边界处数学上严格连续（carry-in / approach 偏移衰减保证）。
 * - 音频：视频展板挂隐藏 ClipMedia（仅 dwell 窗口出声，与纹理时间轴一致）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 开场远景大标题（ThreeText，旅行启动后收起）
 * - subtitle: 收尾远景浮现（ThreeText）
 * - features: 每行 = 对应展板的标题（下标对齐；无媒体的行 = 纯文字展板；
 *   媒体多于文字则多余媒体无标题；总输入不足 2 时用示例文字兜底凑 2 块）
 *
 * 个性化参数（CAMERA_JOURNEY_3D_PARAMS）：pathWind 蜿蜒程度 / dwellRatio 驻留节奏 /
 * panelSize 展板大小 / ambience 氛围 / lineGlow 路径发光。
 *
 * v1 限制（同 DeviceShowcase3D）：挖段 cuts 与取景 viewport 不作用于 3D 纹理；
 * type 'model'（.glb）素材不支持，跳过并警告。
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
import {sm, quadBezier, hashSeed, easeCam, stationJitter, CAM_SPEED, travelScaleOf, THEME_ACCENTS} from '../three/rig-utils';
import {buildPanelTimeline, panelPhaseAt, focusWeights, type PanelTimeline} from '../../shared/panel-timeline';
import {SLOT_OPEN_END as OPEN_END, SLOT_OUTRO_START as OUTRO_START, SLOT_DWELL_FRAC as DWELL_FRAC} from '../../shared/template-slot-windows';
import {assembleMediaPanels, MAX_MEDIA_PANELS, MediaPanel} from '../three/media-panels';
import {arcTubeGeometry, LinkArcs, journeyControlPoints} from '../three/scene-dress';
import {SceneEnv, sceneBackdrop} from '../three/scene-packs';
import {sceneIsLight} from '../../shared/three-scenes';
import {TemplateProps, VideoClip} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {CAMERA_JOURNEY_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.2; // * 展板宽（16:9）
const PANEL_RATIO = 9 / 16;
const PANEL_OFF = 2.9; // * 展板离路径的法向距离（> DWELL_FAR：驻留机位始终在线管靠板一侧，
// 否则线管会隔在相机与展板之间糊成薄纱，实渲染踩过）
const DWELL_FAR = 2.8; // * 驻留起始相机距离（缓推到 DWELL_NEAR）
const DWELL_NEAR = 2.45; // *
const CAM_LIFT = 0.32; // * 相机悬浮高度（线管压到画面下缘成「路」，不横穿画面中线）
const STATION_HEAD = 0.12; // 站位避开路径首尾的占比
const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const FALLBACK_FEATURES = ['核心亮点 依次呈现', '一镜到底 串起所有内容'];
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准，见媒体纹理注释）

interface StationGeo {
  u: number; // 站位曲线参数（弧长参）
  point: THREE.Vector3; // 曲线上站点
  normal: THREE.Vector3; // 面板偏移方向（单位向量，XZ 平面，交替左右）
  panelPos: THREE.Vector3; // 展板中心（不含浮动）
  quaternion: THREE.Quaternion; // 展板朝向（面向线的来向）
}

/** 路径相机（R3F 子树内）：一镜到底，开场远景 → 逐站 travel/dwell → 收尾拉远 */
const JourneyRig: React.FC<{
  curve: THREE.CatmullRomCurve3;
  stations: StationGeo[];
  center: THREE.Vector3;
  openPose: THREE.Vector3;
  outroPose: THREE.Vector3;
  outroMid: THREE.Vector3;
  totalFrames: number;
  dwellFrac: number;
  dwellFar: number;
  dwellNear: number;
  panelOff: number;
  /** 相机悬浮高度（把线管压到画面下缘） */
  camLift: number;
  /** 缓动性格（0 干脆 / 1 柔和 / 2 丝滑）与速度档（推送/开场进深缩放） */
  /** 逐板时间线（focusPanel/focusBoost 权重后的 travel/dwell 边界） */
  tl: PanelTimeline;
  easeP: number;
  spd: number;
}> = ({curve, stations, center, openPose, outroPose, outroMid, totalFrames, dwellFrac, dwellFar, dwellNear, panelOff, camLift, easeP, spd, tl}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  useFrame(() => {
    const n = stations.length;
    const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const tmp3 = new THREE.Vector3();
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));

    if (q < OPEN_END) {
      // 开场：远景缓慢推近，终点 = openPose（与 travel0 起点严格连续）
      const e = easeCam(q / OPEN_END, easeP);
      pos.copy(openPose).addScaledVector(tmp.copy(openPose).sub(center), (1 - e) * 0.07 * spd);
      target.copy(center).add(tmp.set(0, 0.3, 0));
    } else if (q >= OUTRO_START) {
      // 收尾两阶段：先沿路径轴后拉升高（越过末板），再横移到镜像远景机位
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const last = stations[n - 1];
      const dwellEnd = tmp.copy(last.panelPos).addScaledVector(last.normal, -dwellNear).add(tmp3.set(0, camLift, 0));
      if (e < 0.45) {
        pos.copy(dwellEnd).lerp(outroMid, sm(e / 0.45));
      } else {
        pos.copy(outroMid).lerp(outroPose, sm((e - 0.45) / 0.55));
      }
      target.copy(last.panelPos).lerp(center, e);
    } else {
      const ph = panelPhaseAt(tl, frame);
      const i = ph.i;
      const st = stations[i];
      if (!ph.dwell) {
        // travel：严格沿曲线飞行（悬浮 +camLift）；入站/出站偏移在窗口两端平滑衰减
        const t = ph.p;
        const e = easeCam(t, easeP);
        const uPrev = i === 0 ? 0 : stations[i - 1].u;
        const u = uPrev + (st.u - uPrev) * e;
        curve.getPointAt(u, pos);
        pos.y += camLift;
        const decay = 1 - sm(t / 0.35);
        if (decay > 0) {
          if (i === 0) {
            pos.addScaledVector(tmp.copy(openPose).sub(curve.getPointAt(0, tmp2)).sub(tmp3.set(0, camLift, 0)), decay);
          } else {
            pos.addScaledVector(stations[i - 1].normal, -(dwellNear - panelOff) * decay);
          }
        }
        const approach = sm((t - 0.65) / 0.35);
        if (approach > 0) pos.addScaledVector(st.normal, -(dwellFarOf(i) - panelOff) * approach);
        // 注视：上一焦点 → 切线前方 → 下一展板（贝塞尔中点偏向切线前）
        curve.getPointAt(Math.min(1, u + 0.05), tmp2).add(tmp.set(0, 0.1, 0));
        quadBezier(i === 0 ? center : stations[i - 1].panelPos, tmp2, st.panelPos, e, target);
      } else {
        // dwell：展板正前方缓慢推近（悬浮 +camLift 微俯视），注视展板中心
        const e = easeCam(ph.p, easeP);
        const farI = dwellFarOf(i);
        const d = farI + (dwellNear - farI) * e;
        pos.copy(st.panelPos).addScaledVector(st.normal, -d);
        pos.y += camLift;
        target.copy(st.panelPos);
      }
    }
    camera.position.copy(pos);
    camera.lookAt(target);
  });
  return null;
};

export const CameraJourney3D: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
  brandColor,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 18) * FPS);

  const p = makeParamReader(CAMERA_JOURNEY_3D_PARAMS, params);
  const wind = Math.min(2, Math.max(0, Math.round(p('pathWind'))));
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const lineGlow = Math.min(2, Math.max(0, Math.round(p('lineGlow'))));
  const linkLines = Math.min(6, Math.max(0, Math.round(p('linkLines'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];

  // 竖版：世界（路径/站位）整体缩小 + 驻留距离拉远（窄横向视场保住展板全身）
  const worldScale = isPortrait ? 0.55 : 1;
  const distScale = isPortrait ? 3.2 : 1;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const dwellFar = DWELL_FAR * ps * distScale;
  const dwellNear = DWELL_NEAR * ps * distScale;
  const panelOff = PANEL_OFF * worldScale;
  const camLift = CAM_LIFT * worldScale;

  // ====== 展板装配：视频/图片顺位进板，features 行做标题，无媒体的行 = 纯文字板 ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 种子确定性蜿蜒路径（v27：控制点 6→9 + 偏转符号惯性，板间必弯；纯函数在 scene-dress） ======
  const curve = useMemo(() => {
    const seedBase = hashSeed(`${text.title ?? ''}|${(text.features ?? []).join('|')}`);
    return new THREE.CatmullRomCurve3(journeyControlPoints(seedBase, wind, worldScale), false, 'centripetal');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wind, text.title, text.features, worldScale]);

  // ====== 站位：沿线均布（避开首尾各 12%），法向交替偏移，朝向线的来向 ======
  const stations: StationGeo[] = useMemo(
    () =>
      panels.map((_, i) => {
        const u = STATION_HEAD + (1 - 2 * STATION_HEAD) * (i / (panels.length - 1));
        const point = curve.getPointAt(u);
        const tangent = curve.getTangentAt(u);
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize().multiplyScalar(i % 2 === 0 ? 1 : -1);
        const panelPos = point.clone().addScaledVector(normal, panelOff);
        const dummy = new THREE.Object3D();
        dummy.position.copy(panelPos);
        // 朝向线的来向：回看不宜太远（0.06 弧长占比 ≈ 50° 偏航会撞脸），0.015 ≈ 17° 微侧
        dummy.lookAt(curve.getPointAt(Math.max(0, u - 0.015)));
        return {u, point, normal, panelPos, quaternion: dummy.quaternion.clone()};
      }),
    [curve, panels, panelOff],
  );

  // ====== 开场/收尾远景机位：高位侧后方，按路径横向投影跨度取景（看得到整条线） ======
  const {openPose, outroPose, outroMid, center, ambienceWorldScale} = useMemo(() => {
    const bbox = new THREE.Box3().setFromPoints(curve.points);
    const c = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    // 路径纵深在侧视下投影为横向跨度（cos 仰角≈0.9）；按横向视野（fov40）反推距离
    const aspect = canvasW / canvasH;
    const projSpan = (size.x + size.z * 0.9) / 2 + panelOff + pw;
    const dist = (projSpan / (Math.tan(THREE.MathUtils.degToRad(20)) * aspect)) * 1.05;
    const chord = curve.points[curve.points.length - 1].clone().sub(curve.points[0]).setY(0).normalize();
    const sideDir = new THREE.Vector3(-chord.z, 0, chord.x); // 路径主轴左侧
    const open = c
      .clone()
      .addScaledVector(sideDir, dist * 0.86)
      .addScaledVector(chord, -dist * 0.26) // 偏路径起点后方
      .add(new THREE.Vector3(0, dist * 0.52, 0));
    const outro = c
      .clone()
      .addScaledVector(sideDir, -dist * 0.86) // 另一侧（与开场呼应）
      .addScaledVector(chord, dist * 0.26)
      .add(new THREE.Vector3(0, dist * 0.52, 0));
    // 收尾两阶段：先沿路径轴后拉升高（越过末板），再横移到镜像机位（防穿板）
    const last = stations[stations.length - 1];
    const dwellEnd = last.panelPos.clone().addScaledVector(last.normal, -dwellNear).add(new THREE.Vector3(0, camLift, 0));
    const mid = dwellEnd
      .clone()
      .addScaledVector(chord, dist * 0.3)
      .add(new THREE.Vector3(0, dist * 0.18, 0));
    // 氛围尺度：路径跨度远大于基础场景，粒子更散、雾更稀
    const ambScale = Math.max(1, Math.max(size.x, size.z) / 8);
    return {openPose: open, outroPose: outro, outroMid: mid, center: c, ambienceWorldScale: ambScale};
  }, [curve, panelOff, pw, canvasW, canvasH, stations, dwellNear, camLift]);

  // ====== 发光路径管（视觉签名）。不做光晕外管：相机贴线飞行时点-blank 距离
  // 会把外管看成横穿画面的光带（实渲染踩过）；醒目档加粗主管即可 ======
  const tubeGeom = useMemo(() => new THREE.TubeGeometry(curve, 220, 0.065 * worldScale * (lineGlow === 2 ? 1.5 : 1), 8, false), [curve, worldScale, lineGlow]);
  useEffect(() => () => tubeGeom.dispose(), [tubeGeom]);

  // 站位到展板的连接线（「串起」的点题细节）。v27：直棍圆柱 → 柔和弧管
  // （弓向展板外侧上方，站级微差——用户点名「完全笔直的线」就是这根）
  const connectors = useMemo(
    () =>
      stations.map((st, i) => {
        const dir = st.panelPos.clone().sub(st.point);
        const len = dir.length();
        const bow = st.normal
          .clone()
          .multiplyScalar(len * (i % 2 === 0 ? 0.32 : -0.32))
          .add(new THREE.Vector3(0, len * 0.22, 0));
        return {geom: arcTubeGeometry(st.point, st.panelPos, bow, 0.012 * worldScale, 24, 6)};
      }),
    [stations, worldScale],
  );
  useEffect(() => () => connectors.forEach((c) => c.geom.dispose()), [connectors]);

  // ====== v27 场景丰富度：板间连接弧线（数量参数）/ 远景碑柱环 / 漂浮萤光 / 路引光珠 ======
  const anchors = useMemo(() => stations.map((st) => st.panelPos.clone()), [stations]);
  const sceneRadius = useMemo(() => {
    const bbox = new THREE.Box3().setFromPoints(curve.points);
    const size = bbox.getSize(new THREE.Vector3());
    return Math.max(size.x, size.z) / 2 + panelOff + 6 * worldScale;
  }, [curve, panelOff, worldScale]);
  // 路引光珠：相邻站位弧长中点旁的悬浮小光球（交替两侧，路径「家具」）
  const waypoints = useMemo(
    () =>
      stations.slice(0, -1).map((st, i) => {
        const midU = (st.u + stations[i + 1].u) / 2;
        const point = curve.getPointAt(midU);
        const tangent = curve.getTangentAt(midU);
        const lateral = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize().multiplyScalar((i % 2 === 0 ? 1 : -1) * 1.35 * worldScale);
        const pos = point.clone().add(lateral).add(new THREE.Vector3(0, (0.5 + stationJitter(i, 81) * 0.7) * worldScale, 0));
        return {pos, phase: stationJitter(i, 82) * Math.PI * 2};
      }),
    [stations, curve, worldScale],
  );

  // ====== 时间线（帧；每板驻留权重 = focusPanel/focusBoost，AI 编排可直接下发 customParams） ======
  const n = panels.length;
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

  // 连接线在「自己」的驻留窗口淡出（驻留机位贴着它，淡出防穿帮），离开后/收尾时淡回
  const connectorOpacity = (i: number): number => {
    const ds = dwellStartFrames[i] ?? 0;
    const de = ds + Math.round(tl.dwellDur[i] ?? 1);
    const backWin = tl.travelDur * 0.4;
    if (frame >= ds && frame < de) return 0.45 - 0.35 * sm((frame - ds) / (0.3 * (de - ds)));
    if (frame >= de && frame < de + backWin) return 0.1 + 0.35 * sm((frame - de) / backWin);
    return 0.45;
  };

  // ====== 媒体纹理（hook 数量固定为面板上限 6：用户增删素材改变 panels 数量时，
  // map 里调 hook 的数量必须恒定，否则 React「Rendered more hooks」击穿预览——
  // 实测第 3 张图片加入即崩；未用的槽位传 src=undefined，零开销） ======
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

  // 标题在旅行启动后收起（scale → 0 并上浮）；副字幕组收尾前整体 scale 0 隐藏
  // （ThreeText 逐字入场在 enter=0 时字仍缩在后方可见，必须从组层级藏掉）
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  const titleYaw = Math.atan2(openPose.x - center.x, openPose.z - center.z);
  const outroYaw = Math.atan2(outroPose.x - center.x, outroPose.z - center.z);
  const subtitleStart = Math.round(OUTRO_START * totalFrames) + 4;
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));
  // v28 场景解耦：sceneStyle 选场景包（默认虚空 = 原生观感）；亮色场景换墨色字
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

      {/* 3D 舞台（透明 canvas，DOM 背景透出）；rig="none"：相机由 JourneyRig 全程接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={ambienceWorldScale}
        ambienceCenterXZ={[center.x, center.z]}
        ambienceCones={false}
        totalFrames={totalFrames}
        fov={40}
        shadows={false}
      >
        {videoTextures.map((vst, i) => (
          <vst.Bridge key={`br${i}`} />
        ))}
        {imageTextures.map((it, i) => (
          <it.Bridge key={`ib${i}`} />
        ))}
        <JourneyRig
          curve={curve}
          stations={stations}
          center={center}
          openPose={openPose}
          outroPose={outroPose}
          outroMid={outroMid}
          totalFrames={totalFrames}
          dwellFrac={dwellFrac}
          tl={tl}
          dwellFar={dwellFar}
          dwellNear={dwellNear}
          panelOff={panelOff}
          camLift={camLift}
          easeP={easeP}
          spd={spd}
        />

        {/* 发光路径管（视觉签名，低透明） */}
        {lineGlow > 0 && (
          <mesh geometry={tubeGeom}>
            <meshBasicMaterial color={accent} transparent opacity={lineGlow === 2 ? 0.95 : 0.72} />
          </mesh>
        )}

        {/* 站位连接弧线（「串起」的点题细节，v27 柔和曲线化）。不放假人节点球：驻留机位贴着曲线，
            球体会以点-blank 距离撞进画面成大光斑（实渲染踩过） */}
        {stations.map((st, i) => {
          const c = connectors[i];
          return (
            <mesh key={`st${i}`} geometry={c.geom}>
              <meshBasicMaterial color={accent} transparent opacity={connectorOpacity(i)} depthWrite={false} />
            </mesh>
          );
        })}
        {/* v27 板间连接弧线（linkLines 数量可调：相邻优先，再跨板） */}
        <LinkArcs anchors={anchors} count={linkLines} radius={0.014 * worldScale} color={accent} opacity={0.26} ws={worldScale} salt={71} />
        {/* 路引光珠：站位之间的悬浮小光球，补足路径「家具」感 */}
        {waypoints.map((wp, i) => (
          <mesh key={`wp${i}`} position={wp.pos}>
            <sphereGeometry args={[0.06 * worldScale, 10, 10]} />
            <meshBasicMaterial color={accent} transparent opacity={0.5 + 0.3 * Math.sin(tSec * 1.8 + wp.phase)} toneMapped={false} depthWrite={false} />
          </mesh>
        ))}
        {/* v28 环境场景包（虚空/银河/山水/水墨/…可换；默认虚空 = 原生碑柱+萤光观感） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={center}
          spanZ={sceneRadius * 2}
          radiusX={sceneRadius}
          ground
          scale={sceneRadius}
          seed={hashSeed(text.title ?? 'journey') % 1000}
        />
        {/* 路径首尾端点 */}
        {[0, 1].map((t) => (
          <mesh key={`ep${t}`} position={curve.getPointAt(t)}>
            <sphereGeometry args={[0.07 * worldScale, 16, 16]} />
            <meshStandardMaterial color="#FFFFFF" emissive={accent} emissiveIntensity={0.7} roughness={0.3} metalness={0.2} />
          </mesh>
        ))}

        {/* 展板组 */}
        {stations.map((st, i) => {
          const panel = panels[i];
          const floatY = Math.sin(tSec * 0.9 + i * 1.37) * 0.055 * worldScale;
          const v = panel.video;
          return (
            <group
              key={`pn${i}`}
              position={[st.panelPos.x, st.panelPos.y + floatY, st.panelPos.z]}
              quaternion={st.quaternion}
            >
              <PanelBoard
                pw={pw}
                ph={ph}
                accent={accent}
                videoTexture={v?.type === 'video' ? videoTextures[i].texture : null}
                imageTexture={v?.type === 'image' ? imageTextures[i].texture : null}
                caption={panel.caption}
                textScale={ps}
                captionScale={captionScale}
                glowPulse={1 + 0.45 * dwellGlow(i)}
              />
            </group>
          );
        })}

        {/* 开场远景大标题（旅行启动后收起） */}
        {text.title && (
          <group
            position={[center.x, center.y + (3.2 + titleGone * 1.5) * worldScale, center.z]}
            rotation={[0, titleYaw, 0]}
            scale={titleScale}
          >
            <ThreeText text={text.title} size={1.4 * worldScale} depth={0.24 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={10 * worldScale} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 收尾远景副标题（收尾窗口才现身 + 逐字入场） */}
        {text.subtitle && (
          <group position={[center.x, center.y + 2.6 * worldScale, center.z]} rotation={[0, outroYaw, 0]} scale={subtitleScale}>
            <ThreeText text={text.subtitle} size={0.7 * worldScale} depth={0.15 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={11 * worldScale} startFrame={subtitleStart} stagger={2} />
          </group>
        )}
      </ThreeStage>

      {/* 屏幕纹理的 DOM 侧解码源（预览用；渲染期为 null，见 VideoScreenTexture 头注） */}
      {videoTextures.map((vst, i) => (
        <React.Fragment key={`dom${i}`}>{vst.dom}</React.Fragment>
      ))}

      {/* 隐藏 ClipMedia：视频展板仅 dwell 窗口出声（纹理路径不出声，同 DeviceShowcase3D） */}
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

export default CameraJourney3D;
