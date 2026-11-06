/**
 * FloatingCardLayer - 悬浮图片层（片段级）
 *
 * 把一张（通常是透明的）图片浮在模板场景之上：投影 + 缓浮 + 可选 3D 透视，
 * 典型用法是 capture_element 截取的 UI 元素（如输入框）悬浮在演示画面上，
 * 复刻 Kimi K3 宣传片式的「悬浮输入框」镜头语言。
 *
 * 渲染在片段内容容器内（跟随片段的进出场与转场），入场 0.35s 淡入+回弹放大；
 * 结尾不做退场（与模板同一约定：随转场一次性消失）。
 */

import {useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {SPRINGS} from '../animations/motion';
import type {FloatingOverlay} from '../../shared/types';

interface FloatingCardLayerProps {
  overlay: FloatingOverlay;
}

export const FloatingCardLayer: React.FC<FloatingCardLayerProps> = ({overlay}) => {
  const frame = useCurrentFrame();
  const {fps, width: canvasW, height: canvasH} = useVideoConfig();

  const floatAmp = overlay.floatAmp ?? 1;
  const tiltX = overlay.tiltX ?? 0;
  const tiltY = overlay.tiltY ?? 0;
  const radius = overlay.radius ?? 16;
  const shadow = overlay.shadow ?? 1;
  const opacity = overlay.opacity ?? 1;

  // 入场：0.35s 淡入 + 0.92→1 回弹放大
  const enter = spring({frame, fps, config: SPRINGS.float});
  const enterScale = interpolate(enter, [0, 1], [0.92, 1]);
  const enterOpacity = interpolate(frame, [0, Math.round(fps * 0.35)], [0, 1], {
    extrapolateRight: 'clamp',
  });

  // 缓浮循环：3.2s 一个周期的上下浮动 + 极轻微呼吸缩放（floatAmp=0 时静止）
  const t = frame / fps;
  const floatY = Math.sin((t / 3.2) * Math.PI * 2) * 8 * floatAmp;
  const breathe = 1 + Math.sin((t / 3.2) * Math.PI * 2 + Math.PI / 3) * 0.008 * floatAmp;

  // 尺寸：宽占画布 scale 比例，按源图纵横比出高
  const w = canvasW * overlay.scale;
  const h = overlay.height > 0 ? (w * overlay.height) / overlay.width : w * 0.5;
  const cx = canvasW * overlay.x;
  const cy = canvasH * overlay.y;

  return (
    <div
      style={{
        position: 'absolute',
        left: cx - w / 2,
        top: cy - h / 2 + floatY,
        width: w,
        height: h,
        transform: `perspective(1200px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(${enterScale * breathe})`,
        transformOrigin: 'center center',
        opacity: opacity * enterOpacity,
        borderRadius: radius,
        overflow: radius > 0 ? 'hidden' : 'visible',
        boxShadow: shadow > 0 ? `0 ${Math.round(30 * shadow)}px ${Math.round(70 * shadow)}px -12px rgba(0, 0, 0, ${0.45 * Math.min(1, shadow)})` : 'none',
        pointerEvents: 'none',
      }}
    >
      <img
        src={overlay.src}
        style={{width: '100%', height: '100%', objectFit: 'contain', display: 'block'}}
      />
    </div>
  );
};

export default FloatingCardLayer;
