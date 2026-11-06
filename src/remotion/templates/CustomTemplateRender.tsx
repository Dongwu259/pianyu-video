/**
 * CustomTemplateRender - 自定义模板的 Remotion 渲染器
 *
 * 解释 CustomTemplateDef 数据，用 evalProp 求每个元素各属性在当前帧的值，
 * 然后渲染视频框（ClipMedia）或文本框。
 *
 * 与 CustomTemplateCanvas（CSS 预览）共用 evalProp，保证所见即所得。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import type {CustomTemplateDef, CustomElement, TextRole} from '../../shared/custom-template';
import {evalProp, applyEntranceAnim, applyParamBinding} from '../../shared/custom-template';
import {ClipMedia} from '../layers/ClipMedia';
import {useVideoEffect, getVideoEffectStyle, VideoEffectOverlay} from '../layers/videoEffects';
import {CursorOverlay} from '../layers/CursorOverlay';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {computeClickRipples} from '../utils/clickRipples';
import {textStrokeCss} from '../utils/textStroke';
import type {TemplateProps, PromoText, VideoEffect} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN} from '../config/designTokens';
import {clipEndSec} from '../../shared/clipCuts';

export interface CustomTemplateRenderProps extends TemplateProps {
  def: CustomTemplateDef;
}

/** 按角色取文本内容 */
const getTextContent = (text: PromoText, role: TextRole): string => {
  switch (role) {
    case 'title':
      return text.title || '';
    case 'subtitle':
      return text.subtitle || '';
    case 'feature':
      return text.features?.[0] || '';
    case 'brand':
      return text.brandName || '';
    default:
      return '';
  }
};

const renderVideoElement = (
  el: CustomElement,
  video: TemplateProps['videos'][number] | undefined,
  left: number,
  top: number,
  pxW: number,
  pxH: number,
  rotation: number,
  opacity: number,
  scale: number,
  frame: number,
  canvasW: number,
  canvasH: number,
  effect: VideoEffect,
) => {
  if (!video) return null;
  const perspective = el.perspective ?? 1200;
  const anim = applyEntranceAnim(el.entranceAnim, frame, '', opacity);
  const minDim = Math.min(canvasW, canvasH);
  const effStyle = getVideoEffectStyle(effect, frame);
  // 适配模式：元素配置 > 片段指定 > 默认（图片 cover / 视频 contain）
  const fit = el.videoFit ?? video.fit ?? (video.type === 'image' ? 'cover' : 'contain');
  // 取景视口：有设置时用显式尺寸 + 位移（与 Video3D 同一套几何），否则维持 objectFit 居中
  const baseFit = fitVideo(pxW, pxH, video.width, video.height, fit);
  const placed = video.viewport ? applyViewport(pxW, pxH, baseFit, fit, video.viewport) : null;
  // 点击水波：无 viewport 时 objectFit 居中等价于 baseFit 居中几何
  const placedEffective = placed ?? {
    width: baseFit.width,
    height: baseFit.height,
    translateX: (pxW - baseFit.width) / 2,
    translateY: (pxH - baseFit.height) / 2,
  };
  const mediaStartFrame = Math.round((video.trimStart || 0) * FPS);
  const mediaEndSec = clipEndSec(video);
  const ripples =
    effect === 'clickRipple'
      ? computeClickRipples({
          clicks: video.cursorClicks,
          frame,
          fps: FPS,
          startFrom: mediaStartFrame,
          cutsSec: video.cuts,
          endSec: mediaEndSec,
          vw: video.width,
          vh: video.height,
          placed: placedEffective,
          frameW: pxW,
        })
      : undefined;
  return (
    <div
      key={el.id}
      style={{
        position: 'absolute',
        left,
        top,
        width: pxW,
        height: pxH,
        perspective: `${perspective}px`,
        opacity: anim.opacity,
        filter: anim.blur > 0 ? `blur(${anim.blur * minDim}px)` : undefined,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `rotateX(${el.rotateX ?? 0}deg) rotateY(${el.rotateY ?? 0}deg) rotateZ(${rotation + anim.rotateDeg}deg) translate(${anim.tx * canvasW}px, ${anim.ty * canvasH}px) scale(${scale * anim.scaleMul}) ${effStyle.transform || ''}`,
          borderRadius: el.borderRadius ?? 0,
          overflow: 'hidden',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
          // contain 留白时衬一层深色底
          background: fit === 'contain' ? VIDEO_DESIGN.colors.pipBackdrop : undefined,
        }}
      >
        <div style={{position: 'absolute', inset: 0, filter: effStyle.filter}}>
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            muted={video.muted}
            volume={video.volume}
            startFrom={Math.round((video.trimStart || 0) * FPS)}
            endSec={clipEndSec(video)}
            cutsSec={video.cuts}
            style={
              placed
                ? {
                    width: placed.width,
                    height: placed.height,
                    transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
                    objectFit: fit,
                  }
                : {width: '100%', height: '100%', objectFit: fit}
            }
          />
        </div>
        <VideoEffectOverlay effect={effect} frame={frame} ripples={ripples} />
        {/* 美化光标：平滑轨迹 + 光晕（与 Video3D 同层；开关/无轨迹判断在组件内部） */}
        <CursorOverlay
          points={video.cursorPoints}
          clicks={video.cursorClicks}
          frame={frame}
          fps={FPS}
          startFrom={mediaStartFrame}
          endSec={mediaEndSec}
          vw={video.width}
          vh={video.height}
          placed={placedEffective}
          frameW={pxW}
        />
      </div>
    </div>
  );
};

const renderTextElement = (
  el: CustomElement,
  content: string,
  left: number,
  top: number,
  pxW: number,
  pxH: number,
  rotation: number,
  opacity: number,
  scale: number,
  frame: number,
  canvasW: number,
  canvasH: number,
) => {
  if (!content) return null;
  const ts = el.textStyle || {};
  const anim = applyEntranceAnim(el.entranceAnim, frame, content, opacity);
  const minDim = Math.min(canvasW, canvasH);
  return (
    <div
      key={el.id}
      style={{
        position: 'absolute',
        left,
        top,
        width: pxW,
        height: pxH,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        opacity: anim.opacity,
        filter: anim.blur > 0 ? `blur(${anim.blur * minDim}px)` : undefined,
        transform: `rotateZ(${rotation + anim.rotateDeg}deg) translate(${anim.tx * canvasW}px, ${anim.ty * canvasH}px) scale(${scale * anim.scaleMul})`,
      }}
    >
      <span
        style={{
          // fontSize 以 1920 基准画宽设计（编辑器/预设 40-52px），按实际画宽等比缩放，
          // 竖版 1080 宽下自动缩到 ~0.56 倍，不再相对画布过大
          fontSize: (ts.fontSize ?? 48) * (canvasW / 1920),
          fontWeight: ts.fontWeight ?? 700,
          color: ts.color ?? '#111827',
          fontStyle: ts.fontStyle,
          textDecoration: ts.textDecoration,
          fontFamily: VIDEO_DESIGN.bodyFont,
          lineHeight: 1.2,
          ...textStrokeCss(ts),
        }}
      >
        {anim.content}
      </span>
    </div>
  );
};

const renderShapeElement = (
  el: CustomElement,
  left: number,
  top: number,
  pxW: number,
  pxH: number,
  rotation: number,
  opacity: number,
  scale: number,
  frame: number,
  canvasW: number,
  canvasH: number,
) => {
  const anim = applyEntranceAnim(el.entranceAnim, frame, '', opacity);
  const minDim = Math.min(canvasW, canvasH);
  const kind = el.shape ?? 'rect';
  // line：横条，厚度取 borderWidth（默认 2px），不随 height 属性变化
  const height = kind === 'line' ? Math.max(1, el.borderWidth ?? 2) : pxH;
  return (
    <div
      key={el.id}
      style={{
        position: 'absolute',
        left,
        top: kind === 'line' ? top + pxH / 2 - height / 2 : top,
        width: pxW,
        height,
        opacity: anim.opacity,
        filter: el.blur ? `blur(${el.blur * minDim}px)` : undefined,
        transform: `rotateZ(${rotation + anim.rotateDeg}deg) translate(${anim.tx * canvasW}px, ${anim.ty * canvasH}px) scale(${scale * anim.scaleMul})`,
        background: el.fill ?? 'rgba(37, 99, 235, 0.25)',
        borderRadius: kind === 'ellipse' ? '50%' : (el.borderRadius ?? 0),
        border: kind !== 'line' && el.borderWidth ? `${el.borderWidth}px solid ${el.borderColor ?? '#FFFFFF'}` : undefined,
      }}
    />
  );
};

export const CustomTemplateRender: React.FC<CustomTemplateRenderProps> = ({
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  params,
  def,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const totalFrames = Math.round((segmentDuration || def.duration || 8) * FPS);
  const effect = useVideoEffect();

  let videoIdx = 0;

  return (
    <AbsoluteFill style={{background: style?.background || def.background}}>
      <BackgroundEffectLayer />
      {def.elements.map((el) => {
        const bind = applyParamBinding.bind(null, def, params, el.id);
        const x = bind('x', evalProp(el.x, frame, totalFrames, 0.5));
        const y = bind('y', evalProp(el.y, frame, totalFrames, 0.5));
        const w = bind('width', evalProp(el.width, frame, totalFrames, 0.6));
        const h = bind('height', evalProp(el.height, frame, totalFrames, 0.5));
        const rotation = bind('rotation', evalProp(el.rotation, frame, totalFrames, 0));
        const opacity = bind('opacity', evalProp(el.opacity, frame, totalFrames, 1));
        const scale = bind('scale', evalProp(el.scale, frame, totalFrames, 1));

        const pxW = w * canvasW;
        const pxH = h * canvasH;
        const left = x * canvasW - pxW / 2;
        const top = y * canvasH - pxH / 2;

        if (el.type === 'video') {
          const video = videos[videoIdx++] || videos[0];
          return renderVideoElement(el, video, left, top, pxW, pxH, rotation, opacity, scale, frame, canvasW, canvasH, effect);
        }

        if (el.type === 'shape') {
          return renderShapeElement(el, left, top, pxW, pxH, rotation, opacity, scale, frame, canvasW, canvasH);
        }

        const content = el.fixedText || getTextContent(text, el.textRole || 'title') || el.placeholder || '';
        return renderTextElement(el, content, left, top, pxW, pxH, rotation, opacity, scale, frame, canvasW, canvasH);
      })}
    </AbsoluteFill>
  );
};

export default CustomTemplateRender;
