/**
 * 模板: TrendLine3D - 3D 趋势曲线（three.js WebGL，纯文字数据模板）
 *
 * CatmullRom 样条 + TubeGeometry 管状曲线：曲线按「绘制进度」逐段生长（帧驱动
 * 截取控制点重建子样条，确定性、无 Clock/delta），途经节点球随进度弹亮，
 * 末端节点脉冲高亮 + 3D 终值标注。CameraRig 推轨 + ThreeAmbience 粒子光锥，
 * 增长率/走势/战报的「趋势镜头」。标题走 DOM 层 AnimatedText（同 GrowthBars3D）。
 *
 * 文案编码（复用 PromoText，零 schema 变更，同 GrowthBars3D）：
 * - title: 图表标题（如「季度增长趋势」）
 * - features: 数据行，每行一个数据点「标签 数值」或「数值 标签」（3-10 条）：
 *   「1月 32」「月活用户 120万」「120万 月活用户」
 *   有效行不足 3 条时整体回退 4 条示例数据
 *
 * 个性化参数（TREND_LINE_3D_PARAMS）：lineWidth 线条粗细 / rigSpeed 运镜幅度 /
 * ambience 氛围。运镜固定推轨（paramSpecs 只有数值滑块，不开放机位档位）。
 */

import React, {useEffect, useMemo} from 'react';
import * as THREE from 'three';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ThreeStage} from '../three/ThreeStage';
import {ThreeText} from '../three/ThreeText';
import {EASINGS, SPRINGS, entryEase} from '../animations/motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {parseDataSeries, type DataPoint} from '../../shared/promo-text-parse';
import {distributeOnBeats} from '../../shared/beat-grid';
import {FloatingMotes, GroundRipple, OrbitingDot} from '../three/scene-dress';
import {TREND_LINE_3D_PARAMS} from '../../shared/template-registry';

// ====== 场景常量（three 世界单位） ======
const BASE_Y = -1.5; // 基线高度
const SPAN = 6.0; // 曲线总宽
const MAX_LINE_H = 3.1; // 峰值纵高
const MIN_LINE_H = 0.12; // 零值点保底纵高（不贴地的视觉锚点）
const DRAW_STEPS = 240; // 绘制进度量化档位（geometry 按档重建缓存）

/** 解析不足 3 条时的示例数据（有起落的趋势线） */
const FALLBACK_SERIES: DataPoint[] = [
  {label: '1月', value: 32, display: '32'},
  {label: '2月', value: 58, display: '58'},
  {label: '3月', value: 47, display: '47'},
  {label: '4月', value: 89, display: '89'},
];

export const TrendLine3D: React.FC<TemplateProps> = ({
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
  const pace = Math.max(totalFrames / (7 * FPS), 0.5);

  const p = makeParamReader(TREND_LINE_3D_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 画线缓动档位：0=模板原曲线（C 批统一时间语言）
  const drawSpeed = Math.max(0.05, p('drawSpeed')); // 画线速度倍率（D1；节拍模式下沿节拍不倍缩）
  const lineWidth = p('lineWidth'); // 线条粗细倍率
  const rigSpeed = p('rigSpeed'); // 推轨运镜幅度
  const ambience = Math.round(p('ambience')); // 氛围档位 0-3

  // ====== 数据解析（3-10 条；有效行不足整体回退示例） ======
  const series = parseDataSeries(text.features, {min: 3, max: 10, fallback: FALLBACK_SERIES});
  const maxV = Math.max(...series.map((d) => d.value), 1e-6);

  // ====== 节奏：绘制进度（前 55% 片段时长画完，尾部留脉冲与终值驻留；drawSpeed 倍缩） ======
  const drawStart = 14 * pace;
  const drawFrames = Math.max(30, (totalFrames * 0.55) / drawSpeed);
  const progress = interpolate(frame, [drawStart, drawStart + drawFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: entry,
  });
  const drawn = progress >= 0.999;
  // beatGrid 存在时节点逐拍弹亮：节点 i 在第 i 拍到位（节点多于拍退化为半拍/均匀分配），
  // 末拍长满定格（终值标注随末拍浮出）；缺省按绘制进度线性分布（零 BGM 路径）。
  const beatDist = beatGrid ? distributeOnBeats(series.length, beatGrid.beatsSec, segmentDuration || 7, FPS) : null;
  const nodeFrameAt = (i: number): number =>
    beatDist ? beatDist.frames[i] : drawStart + (i / Math.max(1, series.length - 1)) * drawFrames;
  const drawEndFrame = beatDist ? beatDist.frames[series.length - 1] : drawStart + drawFrames;

  // 数据点世界坐标：x 沿基线均布，y 按数值归一
  const pts = useMemo(
    () =>
      series.map(
        (d, i) =>
          new THREE.Vector3(
            -SPAN / 2 + (SPAN / (series.length - 1)) * i,
            BASE_Y + MIN_LINE_H + (Math.max(0, d.value) / maxV) * (MAX_LINE_H - MIN_LINE_H),
            0,
          ),
      ),
    [series, maxV],
  );

  // 绘制进度 → 可见控制点（末段按比例插值出中间点）→ 子样条重建管体。
  // 进度量化到 DRAW_STEPS 档：useMemo 按档缓存，帧内不重复建 geometry。
  const tubeR = 0.055 * lineWidth;
  const progressKey = Math.round(progress * DRAW_STEPS);
  const tubeGeom = useMemo(() => {
    if (pts.length < 2 || progressKey <= 0) return null;
    const t = Math.min(1, progressKey / DRAW_STEPS) * (pts.length - 1);
    const whole = Math.floor(t);
    const visible = pts.slice(0, whole + 1);
    if (whole < pts.length - 1) visible.push(pts[whole].clone().lerp(pts[whole + 1], t - whole));
    if (visible.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(visible, false, 'centripetal');
    return new THREE.TubeGeometry(curve, Math.max(4, visible.length * 14), tubeR, 10, false);
  }, [pts, progressKey, tubeR]);
  // 帧驱动重建的旧 geometry 必须手动释放（防显存泄漏）
  useEffect(() => () => tubeGeom?.dispose(), [tubeGeom]);

  // 末端脉冲（绘制完成后）：节点缩放与光晕呼吸，帧驱动确定性
  const tSec = frame / FPS;
  const wave = Math.sin(tSec * ((2 * Math.PI) / 0.85));
  const pulse = drawn ? 1 + 0.14 * wave : 1;
  const halo = drawn ? 0.55 + 0.45 * wave : 0;

  const accent = brandColor || '#3B82F6';
  const ambientFx = Math.min(2, Math.max(0, Math.round(p('ambientFx')))); // 动效包：0 关 / 1 标准 / 2 丰富
  const slot = SPAN / (series.length - 1);
  // 竖版横向视野窄（fov 按垂直方向算），整组缩放防裁切
  const sceneScale = isPortrait ? 0.42 : 1;
  const endPt = pts[pts.length - 1];
  // 首末节点的地面标签/终值标注中心点钳回安全区：x=±SPAN/2 时文字半宽会顶出画面右缘
  const LABEL_INSET = 0.55;
  const VALUE_INSET = 0.25; // 终值多为短数字，钳太狠会与曲线末端脱节
  const labelX = (x: number) => Math.max(-SPAN / 2 + LABEL_INSET, Math.min(SPAN / 2 - LABEL_INSET, x));
  const valueX = (x: number) => Math.max(-SPAN / 2 + VALUE_INSET, Math.min(SPAN / 2 - VALUE_INSET, x));

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 3D 舞台（透明 canvas，DOM 背景透出）；运镜固定推轨 */}
      <ThreeStage
        rig="dolly"
        rigSpeed={rigSpeed}
        ambience={ambience}
        ambienceColor={accent}
        totalFrames={totalFrames}
        radius={8.6}
        targetY={0}
        shadowY={BASE_Y - 0.18}
      >
        <group scale={sceneScale}>
          {/* 基线薄板：压住 ContactShadows 的地面感 */}
          <mesh position={[0, BASE_Y - 0.06, 0]}>
            <boxGeometry args={[SPAN * 1.08, 0.1, 0.7]} />
            <meshStandardMaterial color="#161D2B" roughness={0.6} metalness={0.35} />
          </mesh>

          {/* 管状曲线（按绘制进度重建的子样条） */}
          {tubeGeom && (
            <mesh geometry={tubeGeom}>
              <meshStandardMaterial
                color={accent}
                emissive={accent}
                emissiveIntensity={0.35}
                roughness={0.32}
                metalness={0.35}
              />
            </mesh>
          )}

          {/* 数据节点球：绘制到该点时弹亮；末端节点脉冲高亮 + 光晕呼吸 */}
          {pts.map((pt, i) => {
            const nodeStart = nodeFrameAt(i);
            const s =
              frame >= nodeStart
                ? Math.max(0.001, spring({frame: frame - nodeStart, fps: FPS, config: SPRINGS.pop}))
                : 0.001;
            const isEnd = i === pts.length - 1;
            return (
              <group key={i} position={pt}>
                <mesh scale={s * (isEnd ? pulse : 1)}>
                  <sphereGeometry args={[isEnd ? 0.11 : 0.075, 20, 20]} />
                  <meshStandardMaterial
                    color={isEnd ? '#FFFFFF' : accent}
                    emissive={accent}
                    emissiveIntensity={isEnd ? 0.8 : 0.3}
                    roughness={0.3}
                    metalness={0.2}
                  />
                </mesh>
                {isEnd && halo > 0 && (
                  <mesh scale={1.6 + 0.5 * halo}>
                    <sphereGeometry args={[0.14, 20, 20]} />
                    <meshBasicMaterial color={accent} transparent opacity={0.22 * halo} depthWrite={false} />
                  </mesh>
                )}
              </group>
            );
          })}

          {/* 节点标签：基线前缘地面（缺标签按序号兜底） */}
          {pts.map((pt, i) => (
            <ThreeText
              key={`lbl${i}`}
              text={series[i].label || `${i + 1}`}
              size={0.2}
              depth={0.035}
              color="#A9BBD8"
              maxWidth={slot * 1.05}
              startFrame={Math.round(nodeFrameAt(i))}
              stagger={1}
              position={[labelX(pt.x), BASE_Y - 0.36, 0.55]}
            />
          ))}

          {/* 末端终值标注（绘制完成后浮出） */}
          <ThreeText
            text={series[series.length - 1].display}
            size={0.34}
            depth={0.06}
            color="#FFFFFF"
            maxWidth={2.4}
            startFrame={Math.round(drawEndFrame + 4)}
            stagger={1}
            position={[valueX(endPt.x), endPt.y + 0.42, 0]}
          />
        </group>

        {/* 动效包（v9「画面丰富」）：基线地面涟漪 + 漂浮微尘 + 丰富档轨道光点 */}
        {ambientFx >= 1 && <GroundRipple y={BASE_Y + 0.015} color={accent} ws={1} maxR={3.4} rate={2.8} count={ambientFx >= 2 ? 4 : 3} opacity={ambientFx >= 2 ? 0.5 : 0.38} />}
        {ambientFx >= 1 && <FloatingMotes count={ambientFx >= 2 ? 70 : 38} center={new THREE.Vector3(0, 0.4, 0)} spread={new THREE.Vector3(8, 4.4, 5)} ws={1} color={accent} opacity={0.3} size={0.05} speed={0.028} />}
        {ambientFx >= 2 && <OrbitingDot radius={3.6} y={0.2} omega={0.45} phase={0.9} ws={1} color={accent} size={0.065} />}
      </ThreeStage>

      {/* 标题区（DOM 叠加层，与 GrowthBars3D 同一套文字管线） */}
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

export default TrendLine3D;
