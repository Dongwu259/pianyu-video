/**
 * 模板: LowerThird - 字幕条解说
 *
 * 效果: 下三分之一字幕条为主体的解说段（Kimi K3 宣传片式信息锚点）。
 * 有素材时在画面上半部以 contain 展示（圆角 + 柔和投影）；
 * 无素材时纯背景 + 字幕条（合法用法，适合纯口播信息页）。
 *
 * 画面结构：
 * - 背景层：style.background 或深色渐变 + 背景特效（同 KenBurns 约定）
 * - 素材层（可选）：上半部 contain，占高约 56%，视频 trim/音量照常生效
 * - 字幕条：下 1/3 区域 LowerThirdBar，消费 text.title / text.subtitle
 *
 * 个性化参数（paramSpecs: LOWER_THIRD_PARAMS）：
 * barOpacity 色块不透明度（0-1，直接值）/ videoScale 素材大小（倍率）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {LowerThirdBar} from '../layers/LowerThirdBar';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {entryEase} from '../animations/motion';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {LOWER_THIRD_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const LowerThird: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();

  const video = videos[0];
  // 无素材是合法用法（纯背景 + 字幕条），不渲染素材层即可
  // （字号缩放体系在 LowerThirdBar 内部经 getScaledTokens 处理）

  // 个性化参数（故事板「参数」页滑块；未调整走 LOWER_THIRD_PARAMS 默认值）
  const p = makeParamReader(LOWER_THIRD_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const barOpacity = p('barOpacity');   // 字幕条色块不透明度（直接值 0-1）
  const videoScale = p('videoScale');   // 素材大小倍率

  // 素材区：上半部 contain，区域高约 56%（videoScale 倍率缩放），水平居中
  const regionW = canvasW * 0.86 * videoScale;
  const regionH = canvasH * 0.56 * videoScale;
  const fit = video ? fitVideo(regionW, regionH, video.width, video.height, 'contain') : null;
  // 素材框贴合适配后的实际尺寸（投影紧贴画面，不含 contain 留白）
  const frameW = fit?.width ?? 0;
  const frameH = fit?.height ?? 0;
  // 取景视口（可选）：框内媒体放大/平移，用于裁掉录屏边缘的无关区域；缺省 = 原 contain 行为
  const placed = video && fit
    ? applyViewport(frameW, frameH, fit, 'contain', video.viewport)
    : null;
  const centerX = (canvasW - frameW) / 2;
  const centerY = canvasH * 0.07 + (regionH - frameH) / 2;
  const borderRadius = 14; // 圆角（12-16 区间的中间值）

  // 素材入场：淡入 + 轻微上浮归位（克制，不抢字幕条戏）
  const mediaProg = interpolate(frame, [0, 12], [0, 1], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 淡入（结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责，
  // 否则会把出场转场退化为 dip-to-black 并与全片淡黑双重叠加）
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 驻留微运动：入场完成后素材保持缓慢呼吸+漂移，字幕条轻微漂移（P2 质感）
  const u = canvasW / 1920;
  const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const drift = dwellDrift(frame, FPS, 4 * u, 3 * u, 9, 0);
  const barDrift = dwellDrift(frame, FPS, 2.5 * u, 2 * u, 9, 1.37);

  return (
    <AbsoluteFill style={{opacity}}>
      {/* 背景层：style.background 优先，缺省深色渐变（字幕条信息页以深色为底） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 素材层（可选）：上半部 contain + 圆角 + 柔和投影 */}
      {video && fit && placed && (
        <div
          style={{
            position: 'absolute',
            left: centerX,
            top: centerY,
            width: frameW,
            height: frameH,
            borderRadius,
            overflow: 'hidden',
            boxShadow: VIDEO_DESIGN.shadowFloat,
            opacity: mediaProg,
            transform: `translateY(${(1 - mediaProg) * 24 + drift.y}px) translateX(${drift.x}px) scale(${breathe})`,
          }}
        >
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            muted={video.muted}
            volume={video.volume}
            startFrom={Math.round((video.trimStart || 0) * FPS)}
            endSec={clipEndSec(video)}
            cutsSec={video.cuts}
            style={{
              width: placed.width,
              height: placed.height,
              transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
              objectFit: 'contain',
            }}
          />
        </div>
      )}

      {/* 下三分之一字幕条：有标题时渲染（副标题可选，纯副标题不撑条）。
          竖版投放时抬到平台 UI 遮挡线之上（底 ~18%），横版维持原留白 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.06,
            right: canvasW * 0.06,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.1),
            display: 'flex',
            justifyContent: 'flex-start',
            transform: `translate(${barDrift.x}px, ${barDrift.y}px)`,
          }}
        >
          <LowerThirdBar
            title={text.title}
            subtitle={text.subtitle}
            bgOpacity={barOpacity}
            textAnim={textAnim}
            titleStyle={style?.title}
            subtitleStyle={style?.subtitle}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};

export default LowerThird;
