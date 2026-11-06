/**
 * 模板: 网格拼图
 *
 * 效果: 多段视频以 2x2 或 3x2 网格排列同时展示
 * 适用: 功能对比、照片集锦、多角度展示
 * 个性化参数（paramSpecs: GRID_MOSAIC_PARAMS）：gap 网格间距 / radius 卡片圆角 / stagger 入场节奏。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {AnimatedText} from '../layers/AnimatedText';
import {ClipMedia} from '../layers/ClipMedia';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import type {FitMode} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {GRID_MOSAIC_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const GridMosaic: React.FC<TemplateProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);
  const count = Math.max(videos.length, 1);

  // 网格布局: 4个以下用 2x2，更多用 3x2；竖版画幅恒 2 列（1080 宽塞 3 列每格只剩 ~340px，过碎）
  const isPortrait = canvasH > canvasW;
  const cols = isPortrait ? 2 : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);

  // 个性化参数（故事板「参数」页滑块；未调整走 GRID_MOSAIC_PARAMS 默认值）
  // u = 画宽相对 1920 基准的缩放：px 类参数（间距/边距）乘它，跨画幅视觉比例一致
  const u = canvasW / 1920;
  const p = makeParamReader(GRID_MOSAIC_PARAMS, params);
  const gap = p('gap') * u;    // 网格间距 px（按画宽等比缩放后的实际值）
  const radius = p('radius');   // 卡片圆角 px（直接值）
  const stagger = p('stagger'); // 各卡片入场 stagger 间隔倍率

  // 网格边距与标题区高度（固定 px 按 1920 基准画宽等比缩放，竖版不越界）
  const padding = 16 * u;
  const headerHeight = (text.title ? 80 : 20) * u;
  const gridHeight = canvasH - headerHeight - 40 * u;
  const cellW = (canvasW - padding * 2 - gap * (cols - 1)) / cols;
  const cellH = (gridHeight - gap * (rows - 1)) / rows;

  // layout 自定义参数
  // 圆角走注册表 radius 滑块（Segment.layout 恒有默认 borderRadius，?? 读法会让滑块失效）
  const cellRadius = radius;
  const layoutScale = layout?.scale ?? 1;
  // 网格是充满式布局：整体缩放只用 layoutScale；不乘 videoWidthRatio/HeightRatio
  // （Segment.layout 恒有默认 0.6/0.5，乘上会把整个网格非均匀缩到画面中心、视频形变）
  const gridScaleX = layoutScale;
  const gridScaleY = layoutScale;
  const offsetX = canvasW * (layout?.videoOffsetX ?? 0);
  const offsetY = canvasH * (layout?.videoOffsetY ?? 0);
  const perspective = layout?.perspective ?? 1200;
  const rotateX = layout?.rotateX ?? 0;
  const rotateY = layout?.rotateY ?? 0;
  const rotateZ = layout?.rotateZ ?? 0;
  const gridTransform = `translate(${offsetX}px, ${offsetY}px) perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${gridScaleX}, ${gridScaleY})`;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 标题 */}
      {text.title && (
        <div style={{position: 'absolute', top: 20 * u, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={5}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.7,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              ...(style?.title?.textDecoration ? {textDecoration: style.title.textDecoration} : {}),
              ...(style?.title?.fontStyle ? {fontStyle: style.title.fontStyle} : {}),
              ...textStrokeCss(style?.title),
            }}
          />
        </div>
      )}

      {/* 网格 */}
      <div style={{
        position: 'absolute',
        inset: 0,
        transform: gridTransform,
        transformOrigin: 'center center',
      }}>
      {videos.slice(0, cols * rows).map((video, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = padding + col * (cellW + gap);
        const y = headerHeight + row * (cellH + gap);

        // 每个格子淡入有延迟（间隔按 stagger 倍率缩放，单片时长 20 帧不变）
        const delay = Math.round(i * 8 * stagger);
        const cellFadeIn = interpolate(
          frame,
          [delay, delay + 20],
          [0, 1],
          {extrapolateRight: 'clamp', extrapolateLeft: 'clamp'}
        );

        // 适配模式：片段显式指定优先；图片默认 cover，视频默认 contain（与 Video3D 一致）
        const fitMode: FitMode = video.fit ?? (video.type === 'image' ? 'cover' : 'contain');
        const baseFit = fitVideo(cellW, cellH, video.width, video.height, fitMode);
        // 叠加取景视口（缩放 + 平移）；无视口时与原 fit 居中行为一致
        const placed = applyViewport(cellW, cellH, baseFit, fitMode, video.viewport);

        // 驻留微运动：入场完成后格子保持缓慢呼吸+漂移（P2 质感，phase 按格子错开）
        const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, i * 1.37);
        const drift = dwellDrift(frame, FPS, 4 * u, 3 * u, 9, i * 1.37);

        return (
          <div
            key={video.id}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: cellW,
              height: cellH,
              borderRadius: cellRadius,
              overflow: 'hidden',
              opacity: cellFadeIn,
              transform: `scale(${0.9 + cellFadeIn * 0.1}) translate(${drift.x}px, ${drift.y}px) scale(${breathe})`,
              boxShadow: '0 8px 24px -8px rgba(0,0,0,0.2)',
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
                objectFit: fitMode,
              }}
            />
          </div>
        );
      })}
      </div>

      {/* 功能要点文字 */}
      {text.features && text.features.length > 0 && (
        <div style={{position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center'}}>
          {text.features.slice(0, 2).map((feat, i) => (
            <AnimatedText
              key={i}
              text={`✦ ${feat}`}
              preset={textAnim ?? 'fadeIn'}
              startFrame={40 + i * 15}
              style={{
                fontSize: style?.feature?.fontSize ?? tokens.fontSize.caption,
                color: style?.feature?.color ?? VIDEO_DESIGN.colors.textMuted,
                fontFamily: VIDEO_DESIGN.bodyFont,
                marginBottom: 4,
                ...(style?.feature?.textDecoration ? {textDecoration: style.feature.textDecoration} : {}),
                ...(style?.feature?.fontStyle ? {fontStyle: style.feature.fontStyle} : {}),
                ...textStrokeCss(style?.feature),
              }}
            />
          ))}
        </div>
      )}
    </AbsoluteFill>
  );
};

export default GridMosaic;
