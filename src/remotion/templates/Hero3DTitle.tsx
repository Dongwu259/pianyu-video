/**
 * 模板 38: Hero3DTitle - 真 3D 文字片头（three.js WebGL，纯文字模板）
 *
 * opentype.js 运行时解析字形（中文霞鹜文楷/英文 Poppins Bold）→ three ExtrudeGeometry
 * 真挤出：真实倒角/侧面/金属高光，配 CameraRig 推轨与 ThreeAmbience 粒子光锥，
 * 片头大字/logo 演绎的发布会级质感。CSS 挤出（text-shadow 堆叠）做不到的透视与反射。
 *
 * 纯文字模板（minVideos 0）：只放 text.title 即出片；副标题走 DOM AnimatedText 层。
 *
 * 个性化参数（HERO_3D_TITLE_PARAMS）：textSize 字高 / depth 厚度 / cameraRig 运镜 /
 * rigSpeed 运镜幅度 / ambience 氛围。
 */

import * as THREE from 'three';
import {AbsoluteFill, useVideoConfig} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ThreeStage} from '../three/ThreeStage';
import {ThreeText} from '../three/ThreeText';
import type {CameraRigPreset} from '../three/CameraRig';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {THEME_ACCENTS} from '../three/rig-utils';
import {FloatingMotes, GroundRipple, OrbitingDot} from '../three/scene-dress';
import {HERO_3D_TITLE_PARAMS} from '../../shared/template-registry';

const RIG_PRESETS: CameraRigPreset[] = ['static', 'orbit', 'dolly', 'crane'];

export const Hero3DTitle: React.FC<TemplateProps> = ({
  text,
  segmentDuration,
  style,
  params,
  textAnim,
  brandColor,
}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.round((segmentDuration || 6) * FPS);

  const p = makeParamReader(HERO_3D_TITLE_PARAMS, params);
  const textEnter = Math.max(0.05, p('textEnter')); // 3D 标题入场节奏倍率（D2：起刻+逐字间隔同比例）
  const textSize = p('textSize');
  const depth = p('depth');
  const rig = RIG_PRESETS[Math.round(p('cameraRig'))] ?? 'dolly';
  const rigSpeed = p('rigSpeed');
  const ambience = Math.round(p('ambience'));
  const ambientFx = Math.min(2, Math.max(0, Math.round(p('ambientFx')))); // 动效包：0 关 / 1 标准 / 2 丰富

  const themeIdx = Math.min(5, Math.max(0, Math.round(p('themeColor'))));
  const accent = themeIdx > 0 ? THEME_ACCENTS[themeIdx] : brandColor || '#3B82F6';
  const titleFont = Math.min(4, Math.max(0, Math.round(p('titleFont'))));
  const title = text.title || '片语';

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" tint={accent} />
      )}
      <BackgroundEffectLayer />

      <ThreeStage
        rig={rig}
        rigSpeed={rigSpeed}
        ambience={ambience}
        ambienceColor={accent}
        totalFrames={totalFrames}
        radius={8.5}
        targetY={0.2}
        shadowY={-1.6}
      >
        <ThreeText
          text={title}
          size={1.15 * textSize}
          depth={0.34 * depth}
          color="#F5F8FF"
          sideColor={accent}
          maxWidth={10}
          startFrame={Math.max(0, Math.round(8 * textEnter))}
          stagger={Math.max(0, Math.round(3 * textEnter))}
          position={[0, 0.2, 0]}
          fontIndex={titleFont}
        />
        {/* 动效包（v9「画面丰富」）：字下地面涟漪 + 漂浮微尘 + 丰富档双轨道光点 */}
        {ambientFx >= 1 && <GroundRipple y={-1.58} color={accent} ws={1} maxR={3.8} rate={2.8} count={ambientFx >= 2 ? 4 : 3} opacity={ambientFx >= 2 ? 0.5 : 0.38} />}
        {ambientFx >= 1 && <FloatingMotes count={ambientFx >= 2 ? 80 : 44} center={new THREE.Vector3(0, 0.4, 0)} spread={new THREE.Vector3(9, 4.6, 5)} ws={1} color={accent} opacity={0.3} size={0.05} speed={0.025} />}
        {ambientFx >= 2 && (
          <>
            <OrbitingDot radius={3.9} y={0.3} omega={0.42} phase={1.1} ws={1} color={accent} size={0.07} />
            <OrbitingDot radius={3.9} y={-0.2} omega={0.42} phase={1.1 + Math.PI} ws={1} color={accent} size={0.055} opacity={0.6} />
          </>
        )}
      </ThreeStage>

      {/* 副标题（DOM 层，3D 大字下方） */}
      {text.subtitle && (
        <div style={{position: 'absolute', top: canvasH * 0.68, left: 0, right: 0, textAlign: 'center', zIndex: 2}}>
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={26}
            style={{
              fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body * 1.1,
              fontWeight: style?.subtitle?.fontWeight ?? 400,
              color: style?.subtitle?.color ?? 'rgba(255,255,255,0.78)',
              letterSpacing: '0.12em',
              ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
              ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
              ...textStrokeCss(style?.subtitle),
            }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};
