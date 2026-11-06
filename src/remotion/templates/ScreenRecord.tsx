/**
 * 模板: ScreenRecord - 屏幕录制（原样导出）
 *
 * 效果: 整段只渲染录屏素材本身——无文字、无动效、无字幕条、无淡入淡出、无背景装饰，
 * 让「素材录制」成为独立功能：录一段（可带摄像头构图烧录）→ 套本模板 → 渲染即得原始录像成片。
 * 与「全屏视频快切」的区别：那是快切蒙太奇的素材段（cover 裁剪 + 微推近 + 可选字幕条 + 淡入）；
 * 本模板为原始素材导出口径——contain 完整显示不裁剪、画面完全静止、零附加元素。
 *
 * 画面结构：
 * - 底色层：style.background 优先，缺省纯黑（画幅不一致时的信箱/邮筒黑边）
 * - 主素材：contain 完整显示（不裁剪画面内容），取景视口（viewport）仍可用——
 *   用户显式框选时才裁掉边缘无关区域，默认与 contain 居中一致
 * - 无素材空态：纯黑背景 + 一行提示（同各模板空态约定，不 return null）
 *
 * 素材音频尊重 video.muted / video.volume，不强制静音。
 * 末段固定淡黑对本模板豁免（MultiSegmentPromo / 渲染帧数同步判断，见
 * shared/template-registry 的 isRawOutputTemplate），保证成片结尾也是原始画面。
 * 裁剪（trim/挖段 cuts）照常生效：掐头去尾后按可用时长导出。
 * 美化光标：素材带鼠标轨迹时叠加发光光标（与 Video3D 同款 CursorOverlay；无轨迹零附加）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {CursorOverlay} from '../layers/CursorOverlay';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {clipEndSec} from '../../shared/clipCuts';

export const ScreenRecord: React.FC<TemplateProps> = ({videos, style}) => {
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const frame = useCurrentFrame();
  // 字号按画布宽度等比缩放（空态提示用）
  const tokens = getScaledTokens(canvasW, canvasH);

  const video = videos[0];
  // contain 完整显示：录屏内容（UI/文字/代码）一像素都不裁
  const placed = video
    ? applyViewport(canvasW, canvasH, fitVideo(canvasW, canvasH, video.width, video.height, 'contain'), 'contain', video.viewport)
    : null;

  return (
    <AbsoluteFill>
      {/* 底色层：信箱/邮筒黑边的兜底（缺省纯黑，可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill style={{backgroundColor: '#000000'}} />
      )}

      {video && placed ? (
        <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
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
          <CursorOverlay
            points={video.cursorPoints}
            clicks={video.cursorClicks}
            frame={frame}
            fps={FPS}
            startFrom={Math.round((video.trimStart || 0) * FPS)}
            cutsSec={video.cuts}
            endSec={clipEndSec(video)}
            vw={video.width}
            vh={video.height}
            placed={placed}
            frameW={canvasW}
          />
        </div>
      ) : (
        /* 无素材空态：纯黑底 + 一行提示 */
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              fontSize: tokens.fontSize.body,
              color: VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.05em',
            }}
          >
            「屏幕录制」需要 1 段素材：请在「素材」页录制或添加录像
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default ScreenRecord;
