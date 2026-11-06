/**
 * 模板: GrowthBars3D - 3D 增长柱状图（three.js WebGL，纯文字数据模板）
 *
 * 深色舞台上的真 3D 柱状图：柱体错峰弹起（spring 一次轻过冲）、柱顶 3D 数值随
 * 生长浮出、分类标签落座基座前缘，CameraRig 环绕 + ThreeAmbience 粒子光锥，
 * 经营月报/增长战报的「报表镜头」。标题走 DOM 层 AnimatedText（与 DeviceShowcase3D
 * 同一套文字管线，大字排版比 3D 挤出更稳）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 图表标题（如「月活用户增长」）
 * - features: 数据行，每行一条「标签 数值」或「数值 标签」（3-8 条）：
 *   「一月 120」「月活用户 120万」「120万 月活用户」「99.9% 服务可用率」
 *   万/亿/千/百/K/M 后缀折算真实值参与柱高归一（展示仍按原文）；
 *   有效行不足 3 条时整体回退 3 条示例数据
 *
 * 个性化参数（GROWTH_BARS_3D_PARAMS）：barHeight 柱高倍率 / rigSpeed 运镜幅度 /
 * ambience 氛围 / stagger 错峰节奏。运镜固定环绕（paramSpecs 只有数值滑块，
 * 不开放机位档位）。
 */

import React from 'react';
import * as THREE from 'three';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ThreeStage} from '../three/ThreeStage';
import {ThreeText} from '../three/ThreeText';
import {SPRINGS} from '../animations/motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {parseDataSeries, type DataPoint} from '../../shared/promo-text-parse';
import {distributeOnBeats} from '../../shared/beat-grid';
import {FloatingMotes, GroundRipple, OrbitingDot} from '../three/scene-dress';
import {GROWTH_BARS_3D_PARAMS} from '../../shared/template-registry';

// ====== 场景常量（three 世界单位） ======
const BASE_Y = -1.6; // 柱底（地面）高度
const SPAN = 5.6; // 柱列总宽
const MAX_BAR_H = 2.9; // 最高柱高（barHeight=1 时；留柱顶数值的头部余量）
const MIN_BAR_H = 0.06; // 零值柱保底高度（不消失的视觉锚点）

/** 解析不足 3 条时的示例数据（增长语义，高低错落） */
const FALLBACK_SERIES: DataPoint[] = [
  {label: '一月', value: 120, display: '120'},
  {label: '二月', value: 186, display: '186'},
  {label: '三月', value: 245, display: '245'},
];

/** 两个 #rrggbb 按 t 线性插值（柱体同色系深浅渐变，确定性） */
const mixHex = (a: string, b: string, t: number): string => {
  const pa = /^#?([0-9a-f]{6})$/i.exec(a);
  const pb = /^#?([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  let out = 0;
  for (const sh of [16, 8, 0]) {
    const ca = (na >> sh) & 255;
    out |= Math.round(ca + (((nb >> sh) & 255) - ca) * t) << sh;
  }
  return `#${out.toString(16).padStart(6, '0')}`;
};

export const GrowthBars3D: React.FC<TemplateProps> = ({
  text,
  segmentDuration,
  style,
  params,
  textAnim,
  brandColor,
  beatGrid,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.round((segmentDuration || 7) * FPS);
  // 节奏随片段时长伸缩（7s 基准，下限 0.5 倍防超短片段动效挤成一团）
  const pace = Math.max(totalFrames / (7 * FPS), 0.5);

  const p = makeParamReader(GROWTH_BARS_3D_PARAMS, params);
  const barHeight = p('barHeight'); // 柱高倍率
  const rigSpeed = p('rigSpeed'); // 环绕运镜幅度
  const ambience = Math.round(p('ambience')); // 氛围档位 0-3
  const ambientFx = Math.min(2, Math.max(0, Math.round(p('ambientFx')))); // 动效包：0 关 / 1 标准 / 2 丰富
  const stagger = p('stagger'); // 错峰倍率

  // ====== 数据解析（3-8 条；有效行不足整体回退示例） ======
  const series = parseDataSeries(text.features, {min: 3, max: 8, fallback: FALLBACK_SERIES});
  const maxV = Math.max(...series.map((d) => d.value), 1e-6);

  // ====== 节奏 ======
  const baseStart = 14 * pace;
  const staggerFrames = 7 * pace * stagger;
  // beatGrid 存在时逐拍生长：柱 i 在第 i 拍弹起（柱多于拍退化为半拍/均匀分配，
  // 末拍长满定格）；stagger 作为间隔倍率叠加在踩拍路径上（D6 修复：此前被静默忽略；
  // stagger=1 时逐帧等价旧值），缺省错峰动画为零 BGM 路径。
  const beatDist = beatGrid ? distributeOnBeats(series.length, beatGrid.beatsSec, segmentDuration || 7, FPS) : null;
  // 踩拍路径的逐柱起跳帧：以首拍为锚、拍间隔 ×stagger（首拍不动=对齐 BGM 落点）
  const beatStart = (i: number) =>
    beatDist!.frames[0] + (beatDist!.frames[i] - beatDist!.frames[0]) * stagger;

  const accent = brandColor || '#3B82F6';
  const slot = SPAN / series.length;
  const barW = slot * 0.56;
  // 竖版横向视野窄（fov 按垂直方向算），整组缩放防裁切
  const sceneScale = isPortrait ? 0.52 : 1;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 3D 舞台（透明 canvas，DOM 背景透出）；运镜固定环绕 */}
      <ThreeStage
        rig="orbit"
        rigSpeed={rigSpeed}
        ambience={ambience}
        ambienceColor={accent}
        totalFrames={totalFrames}
        radius={8.2}
        targetY={0.05}
        shadowY={BASE_Y - 0.15}
      >
        <group scale={sceneScale}>
          {/* 基座薄板：承柱 + 压住 ContactShadows 的地面感 */}
          <mesh position={[0, BASE_Y - 0.07, 0]}>
            <boxGeometry args={[SPAN * 1.12, 0.14, barW + 1.1]} />
            <meshStandardMaterial color="#161D2B" roughness={0.6} metalness={0.35} />
          </mesh>
          {series.map((d, i) => {
            const x = -SPAN / 2 + slot * (i + 0.5);
            const start = beatDist ? beatStart(i) : baseStart + i * staggerFrames;
            // 柱体弹起：SPRINGS.cardSettle 一次轻过冲；零值柱也保底可见
            const grow = spring({frame: frame - start, fps: FPS, config: SPRINGS.cardSettle});
            const targetH =
              MIN_BAR_H + (Math.max(0, d.value) / maxV) * (MAX_BAR_H - MIN_BAR_H) * barHeight;
            const h = Math.max(0.02, targetH * grow);
            // 同色系由深到浅（确定性插值，不用随机）
            const color = mixHex(accent, '#FFFFFF', 0.06 + (0.24 * i) / Math.max(1, series.length - 1));
            return (
              <group key={i}>
                <mesh position={[x, BASE_Y + h / 2, 0]} scale={[barW, h, barW]}>
                  <boxGeometry args={[1, 1, 1]} />
                  <meshStandardMaterial color={color} roughness={0.38} metalness={0.3} />
                </mesh>
                {/* 柱顶数值：随柱生长缩放浮出，逐字弹入 */}
                <group position={[x, BASE_Y + h + 0.32, 0]} scale={Math.max(0.001, grow)}>
                  <ThreeText
                    text={d.display}
                    size={0.3}
                    depth={0.05}
                    color="#F5F8FF"
                    maxWidth={slot * 1.15}
                    startFrame={Math.round(start + 6)}
                    stagger={1}
                  />
                </group>
                {/* 分类标签：落座基座前缘地面，正面朝相机（缺标签按序号兜底） */}
                <ThreeText
                  text={d.label || `项${i + 1}`}
                  size={0.22}
                  depth={0.04}
                  color="#A9BBD8"
                  maxWidth={slot * 1.1}
                  startFrame={Math.round(start + 2)}
                  stagger={1}
                  position={[x, BASE_Y - 0.34, barW / 2 + 0.62]}
                />
              </group>
            );
          })}
        </group>
        {/* 动效包（v9「画面丰富」）：柱列脚下地面涟漪 + 漂浮微尘 + 丰富档轨道光点 */}
        {ambientFx >= 1 && <GroundRipple y={BASE_Y + 0.015} color={accent} ws={1} maxR={3.6} rate={2.8} count={ambientFx >= 2 ? 4 : 3} opacity={ambientFx >= 2 ? 0.5 : 0.38} />}
        {ambientFx >= 1 && <FloatingMotes count={ambientFx >= 2 ? 70 : 38} center={new THREE.Vector3(0, 0.4, 0)} spread={new THREE.Vector3(8, 4.4, 5)} ws={1} color={accent} opacity={0.3} size={0.05} speed={0.028} />}
        {ambientFx >= 2 && <OrbitingDot radius={3.7} y={0.1} omega={0.45} phase={0.9} ws={1} color={accent} size={0.065} />}
      </ThreeStage>

      {/* 标题区（DOM 叠加层，与 DeviceShowcase3D 同一套文字管线） */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            top: canvasH * 0.07,
            left: 0,
            right: 0,
            textAlign: 'center',
            zIndex: 2,
          }}
        >
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={6}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.72,
              fontWeight: style?.title?.fontWeight ?? 600,
              color: style?.title?.color ?? '#FFFFFF',
              letterSpacing: '0.02em',
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};

export default GrowthBars3D;
