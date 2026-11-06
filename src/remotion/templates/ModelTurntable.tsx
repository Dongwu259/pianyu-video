/**
 * 模板 37: ModelTurntable - 3D 模型旋转展示台（three.js WebGL）
 *
 * 实体产品宣传片的核心镜头：上传 .glb 产品模型 → 自动居中归一化 → 旋转台/相机动画
 * 展示，真实光照/环境反射/地面接触影。模型自带动画轨道时按帧精确播放（P1-5）。
 *
 * - 素材类型：仅 .glb（未压缩单文件；draco/.gltf 多文件需先转换）
 * - 运镜：CameraRig 四档（固定/环绕/推轨/摇臂）
 * - 氛围：ThreeAmbience 粒子/光锥/雾（0-3 档）
 * - 非模型素材（视频/图片）放入时出 DOM 提示卡（模型只能走 three.js 渲染路径）
 *
 * 个性化参数（MODEL_TURNTABLE_PARAMS）：modelSize 模型大小 / cameraRig 运镜 /
 * rigSpeed 运镜幅度 / spinSpeed 旋转速度 / ambience 氛围。
 */

import {AbsoluteFill, useVideoConfig} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {ThreeStage} from '../three/ThreeStage';
import {TurntableModel} from '../three/TurntableModel';
import type {CameraRigPreset} from '../three/CameraRig';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {MODEL_TURNTABLE_PARAMS} from '../../shared/template-registry';

const RIG_PRESETS: CameraRigPreset[] = ['static', 'orbit', 'dolly', 'crane'];

export const ModelTurntable: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.round((segmentDuration || 8) * FPS);

  const p = makeParamReader(MODEL_TURNTABLE_PARAMS, params);
  const modelSize = p('modelSize');
  const rig = RIG_PRESETS[Math.round(p('cameraRig'))] ?? 'orbit';
  const rigSpeed = p('rigSpeed');
  const spinSpeed = p('spinSpeed');
  const ambience = Math.round(p('ambience'));

  const model = videos.find((v) => v.type === 'model');

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {model ? (
        <ThreeStage
          rig={rig}
          rigSpeed={rigSpeed}
          ambience={ambience}
          totalFrames={totalFrames}
          radius={7}
          targetY={1.0}
          shadowY={-0.02}
        >
          {/* 模型底面已归一到 y=0，整体抬高到地影平面之上 */}
          <group position={[0, 0, 0]}>
            <TurntableModel src={model.src} size={3.4 * modelSize} spinSpeed={spinSpeed} periodSec={9} />
          </group>
        </ThreeStage>
      ) : (
        /* 非模型素材：引导卡（3D 模板只认 .glb） */
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '46%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            color: 'rgba(255,255,255,0.75)',
            zIndex: 2,
          }}
        >
          {/* 立方体占位图标（内联 SVG，Remotion 模板不引 lucide 避免打包差异） */}
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#7FA8FF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
            <path d="m3.3 7 8.7 5 8.7-5" />
            <path d="M12 22V12" />
          </svg>
          <div style={{fontSize: tokens.fontSize.body * 0.9, textAlign: 'center', lineHeight: 1.7}}>
            请上传 .glb 3D 模型素材
            <br />
            <span style={{fontSize: tokens.fontSize.body * 0.72, color: 'rgba(255,255,255,0.5)'}}>
              未压缩单文件 glb（draco/.gltf 需先转换）
            </span>
          </div>
        </div>
      )}

      {/* 标题区（DOM 叠加层） */}
      {text.title && (
        <div style={{position: 'absolute', top: canvasH * 0.07, left: 0, right: 0, textAlign: 'center', zIndex: 2}}>
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
          {text.subtitle && (
            <div style={{marginTop: 12}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={14}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.body,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: style?.subtitle?.color ?? 'rgba(255,255,255,0.72)',
                  letterSpacing: '0.06em',
                  ...(style?.subtitle?.textDecoration ? {textDecoration: style.subtitle.textDecoration} : {}),
                  ...(style?.subtitle?.fontStyle ? {fontStyle: style.subtitle.fontStyle} : {}),
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
