/**
 * CursorOverlay - 美化光标覆盖层（轨迹平滑 + 光晕 + 按压脉冲）。
 *
 * 挂在 Video3D 画框内（overflow:hidden 自然裁切）；素材无 cursorPoints 时
 * cursorOverlayState 返回 null，组件不渲染。
 * 项目级开关（CursorContext）在组件内部消费，调用方无需传 enabled。
 * 视觉：macOS 风白箭头（深色描边 + 投影）+ 后方柔光晕；点击瞬间收缩回弹。
 */
import {useContext} from 'react';
import type {CursorClick, CursorPoint} from '../../shared/capture';
import type {ClipCut} from '../../shared/clipCuts';
import {cursorOverlayState} from '../utils/cursorOverlay';
import type {RipplePlaced} from '../utils/clickRipples';
import {CursorContext} from './videoEffects';

interface CursorOverlayProps {
  points?: CursorPoint[];
  clicks?: CursorClick[];
  frame: number;
  fps: number;
  startFrom?: number;
  /** 挖段列表（媒体绝对秒）：媒体时间按挖段映射（洞内帧 = 洞出口） */
  cutsSec?: ClipCut[];
  /** 窗口尾（媒体绝对秒）：ClipMedia 封口时同步钳制 */
  endSec?: number;
  vw: number;
  vh: number;
  placed: RipplePlaced;
  /** 画框宽度 px（光标尺寸归一基准） */
  frameW: number;
  /** 拖尾倾斜档位：0 关 / 1 弱 / 2 中 / 3 强（cursorLeanDeg：近期速度方向轻微摆尾） */
  leanTier?: number;
}

export const CursorOverlay: React.FC<CursorOverlayProps> = (props) => {
  const enabled = useContext(CursorContext);
  const st = enabled
    ? cursorOverlayState({
        points: props.points,
        clicks: props.clicks,
        frame: props.frame,
        fps: props.fps,
        startFrom: props.startFrom ?? 0,
        cutsSec: props.cutsSec,
        endSec: props.endSec,
        vw: props.vw,
        vh: props.vh,
        placed: props.placed,
        leanTier: props.leanTier,
      })
    : null;
  if (!st) return null;
  // 箭头基准尺寸：画框宽 2.4%（1080p 全屏画框约 46px，半屏画中画约 23px）
  const size = Math.max(14, props.frameW * 0.024);
  const glowSize = size * 2.6;
  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: st.x,
          top: st.y,
          // 按压收缩 + 拖尾倾斜（B1）都以箭头尖端为原点
          transform: `scale(${1 - 0.18 * st.press}) rotate(${st.leanDeg}deg)`,
          transformOrigin: '3px 2px', // 以箭头尖端为原点收缩/旋转
        }}
      >
        {/* 光晕：屏幕混合的柔光圆，点击时增强 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: glowSize,
            height: glowSize,
            transform: 'translate(-38%, -30%)',
            borderRadius: '50%',
            background: `radial-gradient(circle, rgba(255,255,255,${0.45 + 0.35 * st.press}) 0%, rgba(255,255,255,0.10) 45%, rgba(255,255,255,0) 70%)`,
            mixBlendMode: 'screen',
          }}
        />
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          style={{position: 'relative', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.45))'}}
        >
          <path
            d="M4 2 L20 11 L13.2 12.8 L9.4 20.5 Z"
            fill="#ffffff"
            stroke="#111827"
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
};

export default CursorOverlay;
