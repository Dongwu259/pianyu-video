/**
 * 模板 44: TimeTunnel3D - 3D 穿越隧道（three.js WebGL，发光门框一镜到底穿越）
 *
 * 与 CameraJourney3D 同族的媒体场景模板：一串发光圆门框沿纵深排成隧道，
 * 媒体展板交替挂在门框两侧（板面朝入口来向），相机沿中轴穿越——
 *   开场 12%：入口平视隧道灭点（门框层层嵌套的强透视），大标题悬浮洞口；
 *   每站 i ：travel（沿轴飞进门框 i——穿框瞬间门框从画周掠过，注视点
 *             上一展板 → 轴线前方 → 下一展板贝塞尔过渡）
 *             → dwell（贴在板 i 正前方缓推，视频展板仅驻留窗口播放）；
 *   收尾 8% ：穿出末框升高，转身回望整条隧道（所有门框 + 展板正面），
 *             副标题在回望构图中央浮现。
 *   匀速穿越（flyThrough=1）：全程无静止帧——第 0 帧即巡航初速直线前飞（正视前方
 *             不驻留不转头，无开场缓推无收尾），跑道前段给开场大标题、其余均分给
 *             要点行（副标题垫后作最后一站），末平面掠过即接收尾；文字走「头顶航道」
 *             （近轴、镜头上方约 1 个单位，可读窗口内全程完整在画，掠过从头顶扫出），
 *             tailHold 可留 0-3s 同速滑行（模型自主决定结尾留存）。
 *
 * 视觉签名：加色发光门框（穿框掠过的一瞬）+ 四条纵深角轨（隧道结构感）
 * + 隧道中轴一灭点透视（开场/回望两个方向的灭点构图）。
 *
 * - 展板：PanelBoard 共用组件，朝入口来向微内偏（lookAt 轴线偏入口的点）；
 *   相机 travel 贝塞尔（上一驻留机位 → 轴线中点 → 下一驻留机位），穿框时
 *   横向偏移收敛到孔径内（门框半径 > 机位横向偏移，无穿模）。
 * - 无随机种子：规则排布，逐帧渲染可复现。
 *
 * 文案编码（同 CameraJourney3D）：title = 开场洞口大标题；subtitle = 回望浮现；
 * features 第 i 行 = 第 i 块展板标题（无素材的行 = 纯文字展板）。
 *
 * 个性化参数（TIME_TUNNEL_3D_PARAMS）：dwellRatio 驻留节奏 / panelSize 展板大小 /
 * ambience 氛围 / ringGlow 门框发光 / ringAnim 门框动画（0静态/1流动/2脉冲/3穿梭；框 renderOrder -1 永不挡展板）。
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
import {FloatingMotes} from '../three/scene-dress';
import {SceneEnv, sceneBackdrop} from '../three/scene-packs';
import {sceneIsLight} from '../../shared/three-scenes';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {REF_ASPECT} from '../utils/aspectLayout';
import {TIME_TUNNEL_3D_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// ====== 场景常量（three 世界单位；标 * 的会乘 worldScale/panelScale） ======
const PANEL_W = 3.1; // * 展板宽（16:9）
const PANEL_RATIO = 9 / 16;
const PANEL_Y = 2.15; // * 展板中心高
const PANEL_OFF = 2.95; // * 展板离中轴横向距离（挂在门框侧）
const RING_R = 2.4; // * 门框半径（> 机位横向偏移，穿框无穿模）
const RING_Y = 2.05; // * 门框圆心高（= 机位轴向高度）
const RAIL_X = 3.6; // * 角轨横向距离
const SPACING = 6.6; // * 相邻门框 z 间距
const HEAD_PAD = 6.5; // * 首框距入口
const TAIL_PAD = 9.5; // * 末框后延伸（收尾回望空间）
const DWELL_FAR = 2.85; // * 驻留起始相机距离（缓推到 DWELL_NEAR）
const DWELL_NEAR = 2.5; // *
const CAM_Y = 2.05; // * 飞行轴向高度
const PANEL_SCALE = [0.85, 1, 1.18]; // panelSize：0 小 / 1 标准 / 2 大
const MAX_PANELS = MAX_MEDIA_PANELS; // 展板上限（hook 数量固定基准）
const FALLBACK_FEATURES = ['穿过每一道门', '一镜到底 到达出口'];
const FLY_SPEED = 4.6; // * 匀速穿越巡航速度（世界单位/秒 × spd）；全程恒速，无加减速
const FLY_TITLE_FRAC = 0.26; // 匀速穿越跑道中开场大标题占的前段比例（其余均分给要点行+副标题）
const FLY_TITLE_FADE = 0.65; // 标题距镜头 < 此比例×跑道前段即开始缩小让位（几何反推：先于上缘出画角启动，屏占比峰值后「退回隧道深处」交棒要点行）
const FLY_LANE_X = 0.8; // * 头顶航道文字近轴横向交替幅度（可读窗口内全程完整在画）
const FLY_LANE_Y = 1.02; // * 头顶航道文字高于镜头的高度（掠过时从头顶扫出，不穿镜头）

/** 站位几何：展板挂位 + 朝向（面向入口来向微内偏） */
interface TunnelStation {
  panelPos: THREE.Vector3;
  normal: THREE.Vector3; // 展板法向（朝入口 + 微向轴），驻留机位 = panelPos + normal·d
  quaternion: THREE.Quaternion;
  side: 1 | -1;
  z: number; // 门框 z
}

/** 隧道相机：洞口推进 → 逐站 travel/dwell → 穿出回望；fly=true 时跳过逐站驻留，沿轴匀速前飞（展板迎头掠过） */
const TunnelRig: React.FC<{
  stations: TunnelStation[];
  entranceZ: number;
  exitZ: number;
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
  /** 匀速穿越：不驻留不转头，第 0 帧即巡航初速直线前飞，末平面掠过即接收尾 */
  fly: boolean;
  /** fly：末平面（最后一块字/副标题）的 z 与抵达帧占比、tailHold 留存滑行终点 z */
  flyEndZ: number;
  flyTailZ: number;
  flyEndFrac: number;
}> = ({stations, entranceZ, exitZ, totalFrames, dwellFrac, dwellFar, dwellNear, camY, ws, easeP, spd, tl, fly, flyEndZ, flyTailZ, flyEndFrac}) => {
  const {camera} = useThree();
  const frame = useCurrentFrame();
  useFrame(() => {
    const n = stations.length;
    const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const vanish = new THREE.Vector3(0, camY, exitZ - 30); // 隧道灭点（开场注视 = travel0 首控制点）
    // 站 i 驻留有效远距（速度档 × 站级微差；dwell 终点恒为 dwellNear，取景不受影响）
    const dwellFarOf = (i: number): number =>
      dwellNear + (dwellFar - dwellNear) * spd * (0.85 + 0.3 * stationJitter(i, 13));

    /** 站 i 驻留机位（progress 0→1：有效远距缓推到 dwellNear） */
    const dwellPos = (i: number, e: number): THREE.Vector3 => {
      const st = stations[i];
      const d = dwellNear + (dwellFarOf(i) - dwellNear) * (1 - e);
      return tmp2.copy(st.panelPos).addScaledVector(st.normal, d).setY(st.panelPos.y - 0.1);
    };

    if (fly) {
      // 匀速穿越（无静止帧）：第 0 帧即巡航初速直线前飞，全程不加速不减速不驻留——
      // 末平面（最后一块字/副标题）恰在切段瞬间掠过；tailHold>0 时到点后保持同速前滑留存
      const vFrame = (flyEndZ - entranceZ) / Math.max(1, flyEndFrac * totalFrames);
      const z = Math.max(flyTailZ, entranceZ + vFrame * frame);
      pos.set(0, camY, z);
      target.set(0, camY, z - 8);
    } else if (q < OPEN_END) {
      // 开场：洞口外缓推（终点 = travel0 起点，严格连续）
      const e = easeCam(q / OPEN_END, easeP);
      pos.set(0, camY + (1 - e) * 0.35, entranceZ + (1 - e) * 3.4 * spd);
      target.copy(vanish);
    } else if (q >= OUTRO_START) {
      // 收尾：继续向前穿出隧道，缓升拉远——前方是隧道出口的亮洞构图
      const e = easeCam((q - OUTRO_START) / (1 - OUTRO_START), easeP);
      const dwellEnd = dwellPos(n - 1, 1).clone();
      const exitPose = new THREE.Vector3(0, camY + 1.1 * ws, exitZ + 3.2 * ws);
      pos.copy(dwellEnd).lerp(exitPose, e);
      target.copy(vanish).lerp(tmp2.set(0, camY + 0.4 * ws, exitZ), e * 0.4);
    } else {
      const ph = panelPhaseAt(tl, frame);
      const i = ph.i;
      const st = stations[i];
      if (!ph.dwell) {
        // travel：上一驻留机位 → 轴线中点 → 下一驻留机位（穿框时横向收敛在孔径内）；
        // 行程弧度按速度档 × 站级微差缩放（破「每站一模一样」的节拍器感）
        const e = easeCam(ph.p, easeP);
        const prevPos = i === 0 ? tmp.set(0, camY, entranceZ) : dwellPos(i - 1, 1).clone();
        const nextPos = dwellPos(i, 0).clone();
        const mid = new THREE.Vector3(0, camY, (prevPos.z + nextPos.z) / 2 - 0.8 * spd * (0.85 + 0.3 * stationJitter(i, 7)));
        quadBezier(prevPos, mid, nextPos, e, pos);
        // 注视：上一焦点（travel0 = 灭点）→ 轴线前方 → 下一展板
        const ahead = new THREE.Vector3(0, st.panelPos.y, nextPos.z - 5);
        quadBezier(i === 0 ? vanish : stations[i - 1].panelPos, ahead, st.panelPos, e, target);
      } else {
        // dwell：展板正前方缓推，注视展板中心
        const e = easeCam(ph.p, easeP);
        pos.copy(dwellPos(i, e));
        target.copy(st.panelPos);
      }
    }
    camera.position.copy(pos);
    camera.lookAt(target);
  });
  return null;
};

export const TimeTunnel3D: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, brandColor}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const totalFrames = Math.round((segmentDuration || 16) * FPS);

  const p = makeParamReader(TIME_TUNNEL_3D_PARAMS, params);
  const dwellFrac = DWELL_FRAC[Math.min(3, Math.max(0, Math.round(p('dwellRatio'))))];
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const panelAlt = Math.min(1, Math.max(0, Math.round(p('panelSides'))));
  const ps = PANEL_SCALE[Math.min(2, Math.max(0, Math.round(p('panelSize'))))];
  const ambience = Math.round(p('ambience'));
  const ringGlow = Math.min(2, Math.max(0, Math.round(p('ringGlow'))));
  const easeP = Math.min(2, Math.max(0, Math.round(p('camEase'))));
  const spd = CAM_SPEED[Math.min(2, Math.max(0, Math.round(p('camSpeed'))))];
  // 穿越模式：跳过逐板驻留，沿轴匀速前飞（展板迎头掠过）；展板样式：纯立体文字（去底板，只显示标题）
  const flyThrough = Math.min(1, Math.max(0, Math.round(p('flyThrough')))) === 1;
  const textPanel = Math.min(1, Math.max(0, Math.round(p('panelStyle')))) === 1;

  // 竖版：世界整体缩小 + 驻留拉远（窄横向视场保住展板全身）。
  // 画幅归一（aspect 审计 P0-1）：方形/4:3 等窄横画幅世界按画幅宽度等比缩小——
  // 展板横向屏占比与 16:9 完全一致（文字完整不出画，1:1 实锤修复）；
  // 21:9 等宽画幅世界不变，改由 fov 收窄锁 16:9 横向取景（邻板不入画，见 fovBase）
  const aspect = canvasW / canvasH;
  const worldScale = isPortrait ? 0.58 : aspect < REF_ASPECT - 1e-6 ? Math.max(0.42, aspect / REF_ASPECT) : 1;
  const distScale = isPortrait ? 3.0 : 1;
  // 垂直 fov 折算：比 16:9 更宽的画幅锁定 16:9 的横向视场（取景收窄处方）——
  // 横向构图与 16:9 逐像素口径一致（驻留/行进邻板穿帮根除），竖向更紧凑（电影感）；
  // 16:9 及更窄恒 44（现役行为零漂移）
  const fovBase = 44;
  const fovWide =
    aspect > REF_ASPECT + 1e-6
      ? (2 * Math.atan(Math.tan((fovBase * Math.PI) / 360) * (REF_ASPECT / aspect)) * 360) / Math.PI
      : fovBase;
  const pw = PANEL_W * ps;
  const ph = pw * PANEL_RATIO;
  const panelOff = PANEL_OFF * worldScale;
  const ringR = RING_R * worldScale;
  const ringY = RING_Y * worldScale;
  // 匀速穿越时站间距加大（文字在画面内的可读窗口更长）
  const spacing = SPACING * worldScale * (flyThrough ? 1.4 : 1);
  const dwellFar = DWELL_FAR * ps * distScale;
  const dwellNear = DWELL_NEAR * ps * distScale;
  const camY = CAM_Y * worldScale;

  // ====== 展板装配（同 CameraJourney3D 口径） ======
  const panels: MediaPanel[] = useMemo(
    () => assembleMediaPanels(videos, text.features, FALLBACK_FEATURES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videos, text.features],
  );

  // ====== 隧道几何：门框沿 -Z 等距，展板交替左右挂在框侧 ======
  const n = panels.length;
  const entranceZ = 0;
  const headPad = HEAD_PAD * worldScale;

  // ====== 匀速穿越布局：全程无静止帧（开场即巡航初速、结尾在运动中切走） ======
  // 跑道 = 巡航速度 × 时长；前段给开场大标题（物理逼近长大，临板缩小让位），
  // 其余均分给要点行——副标题垫后作最后一站，切段瞬间刚好掠过；tailHold>0 则到点后继续同速前滑
  const cruise = FLY_SPEED * spd;
  const flyDur = Math.max(1, segmentDuration || 16);
  const flyRun = cruise * flyDur;
  const flyTitleDist = flyRun * FLY_TITLE_FRAC;
  const flyPlanes = n + (text.subtitle ? 1 : 0);
  const flyGap = flyPlanes > 0 ? (flyRun - flyTitleDist) / flyPlanes : 0;
  const tailHold = Math.min(3, Math.max(0, p('tailHold')));
  const flyEndFrac = Math.min(1, Math.max(OPEN_END, 1 - tailHold / flyDur));
  const flySubZ = -(flyTitleDist + flyPlanes * flyGap);
  const flyEndZ = text.subtitle ? flySubZ : n > 0 ? -(flyTitleDist + n * flyGap) : -flyRun * 0.8;
  const flyTailZ = flyEndZ - cruise * tailHold; // 留存期保持同速前滑（不刹车）
  const flyExitZ = flySubZ - (TAIL_PAD + 6) * worldScale;

  const exitZ = -(headPad + (n - 1) * spacing + TAIL_PAD * worldScale);
  const effExitZ = flyThrough ? flyExitZ : exitZ;
  const stations: TunnelStation[] = useMemo(
    () =>
      panels.map((_, i) => {
        const side: 1 | -1 = panelAlt === 1 ? (i % 2 === 0 ? -1 : 1) : -1; // panelSides：0 同侧挂墙（防左右横跳眩晕）/ 1 左右交替
        const z = flyThrough ? -(flyTitleDist + (i + 1) * flyGap) : -(headPad + i * spacing);
        const panelPos = new THREE.Vector3(side * panelOff, PANEL_Y * worldScale + Math.sin(i * 1.27) * 0.05 * worldScale, z);
        const dummy = new THREE.Object3D();
        dummy.position.copy(panelPos);
        // 面向入口来向、微向中轴、微俯向机位高度（观众穿框而来时板面正对视线）
        dummy.lookAt(new THREE.Vector3(side * 0.75 * worldScale, panelPos.y - 0.32, z + 5.5));
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(dummy.quaternion).setY(0).normalize();
        return {panelPos, normal, quaternion: dummy.quaternion.clone(), side, z};
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panels, panelOff, worldScale, headPad, spacing, flyThrough, flyTitleDist, flyGap],
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
  const ringOn = ringGlow > 0;
  const ringOpacity = ringGlow === 2 ? 0.95 : 0.7;
  const ringTube = (ringGlow === 2 ? 0.075 : 0.055) * worldScale;
  // 门框动画（v9 反馈：蓝框会流动 + 多几种动画）：0 静态 / 1 流动（每环三段弧、
  // 邻环反向慢旋）/ 2 脉冲（亮度波沿隧道纵深传播）/ 3 穿梭（光点沿环周飞行）
  const ringAnim = Math.min(3, Math.max(0, Math.round(p('ringAnim'))));

  // 门框集合：站框 ×n + 引导框（入口 1 + 尾部 2，纵深连续性）
  const ringZs = useMemo(
    () => [entranceZ - 2.2 * worldScale, ...stations.map((st) => st.z), effExitZ + 4.5 * worldScale, effExitZ + 9 * worldScale],
    [stations, entranceZ, effExitZ, worldScale],
  );
  const ringGeom = useMemo(() => new THREE.TorusGeometry(ringR, ringTube, 10, 72), [ringR, ringTube]);
  useEffect(() => () => ringGeom.dispose(), [ringGeom]);
  // 流动模式的分段弧（每环 3 段 100° 弧、留 3×~23° 缺口，旋转时缺口走圈=「流动」）
  const ringArcGeom = useMemo(
    () => new THREE.TorusGeometry(ringR, ringTube, 10, 40, (Math.PI * 2) / 3 - 0.42),
    [ringR, ringTube],
  );
  useEffect(() => () => ringArcGeom.dispose(), [ringArcGeom]);

  // 角轨 ×4（隧道结构感；两条上下、两条左右，全长度）
  const tunnelLen = entranceZ - effExitZ + 14 * worldScale;
  const midZ = (entranceZ + effExitZ) / 2;
  const railGeom = useMemo(() => new THREE.BoxGeometry(0.045 * worldScale, 0.045 * worldScale, tunnelLen), [worldScale, tunnelLen]);
  useEffect(() => () => railGeom.dispose(), [railGeom]);

  const q = Math.min(1, Math.max(0, frame / Math.max(1, totalFrames)));
  // v28 场景解耦：门框是开放框架，场景件从框间透出（sceneStyle 可换）
  const sceneIdx = Math.round(p('sceneStyle'));
  const inkText = sceneIsLight(sceneIdx);
  const sceneCss = sceneBackdrop(sceneIdx);
  const titleGone = sm((frame - tl.travelStart[0]) / (tl.travelDur * 0.6));
  const titleScale = Math.max(0.001, 1 - titleGone);
  // fly 模式标题退场：长大交给物理逼近，临板缩小让位给要点行（不穿板、不顶出画）
  const dTitleFly = flyTitleDist - cruise * (frame / FPS);
  // 标题退场双因子（修「匀速穿越+纯立体文字」空中叠印，v7 横竖屏母带实证）：
  // ① 原距离收缩（屏占比峰值后退回隧道深处）；② 二次快速退场——镜头距第一块
  //    要点行/副标还有 1.6×flyGap 时开始，0.55×flyGap 内归零。仅 ① 时标题在
  //    dTitleFly≈4 单位仍有 ~15% 尺寸，而要点行航道 Y 与标题只差 0.13×ws——
  //    镜头飞越标题→要点行 0 的整段两行字投影互穿近 2 秒；② 保证交棒完成。
  const titleFlyScale = Math.max(
    0.001,
    sm(dTitleFly / (flyTitleDist * FLY_TITLE_FADE)) *
      sm((dTitleFly - flyGap * 0.55) / Math.max(0.001, flyGap * 1.05)),
  );
  const subtitleScale = Math.max(0.001, sm((q - OUTRO_START) / 0.03));
  const titleZ = entranceZ - 2.6 * worldScale;
  const subtitleZ = exitZ + 4.8 * worldScale; // 隧道出口深处（相机前行方向）

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

      {/* 3D 舞台；rig="none"：相机由 TunnelRig 接管 */}
      <ThreeStage
        rig="none"
        ambience={ambience}
        ambienceColor={accent}
        ambienceWorldScale={Math.max(1, tunnelLen / 9)}
        ambienceCenterXZ={[0, midZ]}
        ambienceCones={false}
        totalFrames={totalFrames}
        fov={fovWide}
        shadows={false}
      >
        {videoTextures.map((vst, i) => (
          <vst.Bridge key={`br${i}`} />
        ))}
        {imageTextures.map((it, i) => (
          <it.Bridge key={`ib${i}`} />
        ))}
        <TunnelRig stations={stations} entranceZ={entranceZ} exitZ={exitZ} totalFrames={totalFrames} dwellFrac={dwellFrac} dwellFar={dwellFar} dwellNear={dwellNear} camY={camY} ws={worldScale} easeP={easeP} spd={spd} tl={tl} fly={flyThrough} flyEndZ={flyEndZ} flyTailZ={flyTailZ} flyEndFrac={flyEndFrac} />

        {/* v28 环境场景包（星空/山水/都市/…可换；默认纯净 = 原生观感） */}
        <SceneEnv
          scene={sceneIdx}
          accent={accent}
          ws={worldScale}
          center={new THREE.Vector3(0, camY, midZ)}
          spanZ={entranceZ - effExitZ}
          radiusX={PANEL_OFF}
          ground
          glow={ringGlow}
        />

        {/* 发光门框（站框亮、引导框暗一档）。防遮挡（v9 反馈「框架挡板内容」）：
            renderOrder -1 + 关深度测试/写入——框永远先画、展板永远盖在框上，框再近也不挡字。
            ringAnim：0 静态 / 1 流动（每环三段弧、邻环反向慢旋、缺口走圈）/ 2 脉冲（亮度波沿纵深传播）/ 3 穿梭（光点沿环周飞行） */}
        {ringOn &&
          ringZs.map((z, k) => {
            const guide = k === 0 || k > stations.length;
            const baseOpacity = guide ? ringOpacity * 0.45 : ringOpacity;
            if (ringAnim === 1) {
              const rot = tSec * 0.55 * (k % 2 === 0 ? 1 : -1) + k * 0.9;
              return (
                <group key={`ring${k}`} position={[0, ringY, z]} rotation={[0, 0, rot]} renderOrder={-1}>
                  {[0, 1, 2].map((s) => (
                    <mesh key={s} geometry={ringArcGeom} rotation={[0, 0, (s * Math.PI * 2) / 3]}>
                      <meshBasicMaterial color={accent} transparent opacity={baseOpacity} toneMapped={false} depthTest={false} depthWrite={false} />
                    </mesh>
                  ))}
                </group>
              );
            }
            if (ringAnim === 2) {
              const wave = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(tSec * 2.1 - z * 0.24));
              return (
                <mesh key={`ring${k}`} geometry={ringGeom} position={[0, ringY, z]} renderOrder={-1}>
                  <meshBasicMaterial color={accent} transparent opacity={baseOpacity * wave} toneMapped={false} depthTest={false} depthWrite={false} />
                </mesh>
              );
            }
            if (ringAnim === 3) {
              return (
                <group key={`ring${k}`} position={[0, ringY, z]} renderOrder={-1}>
                  <mesh geometry={ringGeom}>
                    <meshBasicMaterial color={accent} transparent opacity={baseOpacity * 0.38} toneMapped={false} depthTest={false} depthWrite={false} />
                  </mesh>
                  {[0, 1, 2].map((s) => {
                    const th = tSec * (1.25 + (k % 3) * 0.22) * (k % 2 === 0 ? 1 : -1) + (s * Math.PI * 2) / 3 + k * 0.7;
                    return (
                      <mesh key={s} position={[Math.cos(th) * ringR, Math.sin(th) * ringR, 0]}>
                        <sphereGeometry args={[ringTube * 1.7, 10, 10]} />
                        <meshBasicMaterial color={accent} transparent opacity={0.95} toneMapped={false} depthTest={false} depthWrite={false} />
                      </mesh>
                    );
                  })}
                </group>
              );
            }
            return (
              <mesh key={`ring${k}`} geometry={ringGeom} position={[0, ringY, z]} renderOrder={-1}>
                <meshBasicMaterial color={accent} transparent opacity={baseOpacity} toneMapped={false} depthTest={false} depthWrite={false} />
              </mesh>
            );
          })}

        {/* 角轨 ×4：上下左右偏 45° 的四条纵深线（结构感）——同门框口径做背景层不挡展板 */}
        {ringOn &&
          [0, 1, 2, 3].map((k) => {
            const a = (k * Math.PI) / 2 + Math.PI / 4;
            return (
              <mesh key={`rail${k}`} geometry={railGeom} position={[Math.cos(a) * RAIL_X * worldScale, ringY + Math.sin(a) * RAIL_X * worldScale, midZ - 3 * worldScale]} renderOrder={-1}>
                <meshBasicMaterial color={accent} transparent opacity={0.22} toneMapped={false} depthTest={false} depthWrite={false} />
              </mesh>
            );
          })}

        {/* 展板组（浮动 + 朝向）；纯立体文字模式：无素材的展板去底板，标题用 3D 挤出字漂浮在挂位（视频展板仍为画中画） */}
        {stations.map((st, i) => {
          const panel = panels[i];
          const floatY = Math.sin(tSec * 0.85 + i * 1.27) * 0.045 * worldScale;
          const isMedia = panel.video?.type === 'video' || panel.video?.type === 'image';
          if (textPanel && !isMedia) {
            if (!panel.caption) return null;
            if (flyThrough) {
              // 匀速穿越・头顶航道：近轴微交替、镜头上方约 1 个单位——可读窗口内全程完整在画，
              // 掠过时从头顶扫出（不再侧挂出画切字）；逐字入场禁用（字符散在 z-260 深处的入场
              // 动画会让飞行中整行「缺字」，完整感交给镜头逼近本身）
              return (
                <group key={`pn${i}`} position={[(i % 2 === 0 ? -1 : 1) * FLY_LANE_X * worldScale, camY + (FLY_LANE_Y + (i % 2) * 0.26) * worldScale + floatY, st.panelPos.z]}>
                  <ThreeText
                    text={panel.caption}
                    size={0.52 * captionScale * ps * worldScale}
                    depth={0.1 * worldScale}
                    color={inkText ? '#2A2F3A' : '#F2F7FF'}
                    maxWidth={5 * worldScale}
                    startFrame={-12}
                    stagger={0}
                    fontIndex={titleFont}
                  />
                </group>
              );
            }
            return (
              <group key={`pn${i}`} position={[st.panelPos.x, st.panelPos.y + floatY, st.panelPos.z]} quaternion={st.quaternion}>
                <ThreeText
                  text={panel.caption}
                  size={0.52 * captionScale * ps * worldScale}
                  depth={0.1 * worldScale}
                  color={inkText ? '#2A2F3A' : '#F2F7FF'}
                  maxWidth={6.5 * worldScale}
                  startFrame={4}
                  stagger={2}
                  fontIndex={titleFont}
                />
              </group>
            );
          }
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

        {/* v27 出口辉光门（隧道尽头的「目的地」）+ 流动微尘 */}
        <mesh position={[0, ringY, effExitZ - 1.4 * worldScale]}>
          <circleGeometry args={[ringR * 0.82, 40]} />
          <meshBasicMaterial color={accent} transparent opacity={0.15} toneMapped={false} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        <FloatingMotes count={80} center={new THREE.Vector3(0, camY, effExitZ / 2)} spread={new THREE.Vector3(ringR * 1.5, 2.4 * worldScale, -effExitZ * 0.88)} ws={worldScale} color={accent} opacity={0.26} size={0.05} speed={0.03} />

        {/* 开场洞口大标题（面向入口；旅行启动后收起；亮色场景换墨色字） */}
        {text.title && flyThrough && (
          // 缩放组包住航道偏移：标题缩小时向轴线（灭点）收拢——「被隧道吞没让位」，
          // 数学上保证全程不出上缘（偏移不缩放则最后 0.53 单位必然顶出画面）
          <group position={[0, camY, -flyTitleDist]} scale={titleFlyScale}>
            <group position={[0, 1.15 * worldScale, 0]}>
              <ThreeText text={text.title} size={0.62 * worldScale} depth={0.12 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={8 * worldScale} startFrame={-12} stagger={0} fontIndex={titleFont} />
            </group>
          </group>
        )}
        {text.title && !flyThrough && (
          <group position={[0, ringY + 1.75 * worldScale, titleZ]} scale={titleScale}>
            <ThreeText text={text.title} size={0.62 * worldScale} depth={0.12 * worldScale} color={inkText ? '#2A2F3A' : '#F5F8FF'} maxWidth={8 * worldScale} startFrame={4} stagger={2} fontIndex={titleFont} />
          </group>
        )}

        {/* 出口副标题（面向入口来向；收尾窗口现身；fly 模式垫后作最后一站，掠过即接收尾） */}
        {text.subtitle && flyThrough && (
          <group position={[0, camY + 1.15 * worldScale, flySubZ]}>
            <ThreeText text={text.subtitle} size={0.55 * worldScale} depth={0.1 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={5 * worldScale} startFrame={-12} stagger={0} />
          </group>
        )}
        {text.subtitle && !flyThrough && (
          <group position={[0, ringY + 1.6 * worldScale, subtitleZ]} scale={subtitleScale}>
            <ThreeText text={text.subtitle} size={0.5 * worldScale} depth={0.1 * worldScale} color={inkText ? '#3A4150' : '#E8F0FF'} maxWidth={8 * worldScale} startFrame={Math.round(OUTRO_START * totalFrames) + 4} stagger={2} />
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

export default TimeTunnel3D;
