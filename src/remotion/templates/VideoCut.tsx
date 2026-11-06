/**
 * 模板: VideoCut - 全屏视频快切
 *
 * 效果: videos[0] 全幅铺满画布的「裸素材段」——无画框、无阴影、无圆角，
 * 用于录屏/实拍素材直接上时间线快切（制造企业宣传片式快节奏蒙太奇）。
 * 与现有「画中画+动画」模板的核心区别：不做任何装饰性包装，素材即画面。
 *
 * 画面结构：
 * - 底色层：style.background 优先，缺省纯黑（模糊垫片/留边模式下的兜底底色）
 * - 主素材：按 padStyle 铺排（cover 裁剪 / 模糊垫片 / contain 留边），段内匀速微推近
 * - 字幕条：lowerThird 开启且有标题时，下 1/3 区域叠 LowerThirdBar
 * - 无素材空态：深色背景 + 提示文字（不 return null，同 KenBurns/TextSlide 空态约定）
 *
 * 裁剪（trim）是快切的核心：startFrom 消费 video.trimStart，
 * 把长录屏按镜头裁成多个本模板片段即可「刷刷刷」硬切。
 * 素材音频尊重 video.muted / video.volume，不强制静音。
 *
 * 多镜扩展（P1-5B）：段内 ≥2 条素材时轮转硬切（切点优先 scan_media 镜头边界，
 * 多素材不连用同源）；单素材 + autoShots=1 时按素材自身镜头边界段内切镜。
 * 单素材且 autoShots=0（缺省）时与旧渲染逐帧一致。
 *
 * 个性化参数（paramSpecs: VIDEO_CUT_PARAMS）：
 * padStyle 铺排方式（0=cover 裁剪铺满 / 1=模糊垫片 / 2=contain 留边）
 * zoomPulse 微推近（段内 scale 1.0 → 1+0.05×zoomPulse，0=完全静止）
 * lowerThird 字幕条（0=关 / 1=开）
 * cutSec 多镜间隔秒（1.2-5；≥2 条素材或 autoShots=1 时生效）
 * autoShots 单素材镜头切分（0=连续播放 / 1=按 scan_media 镜头边界切段内切镜）
 * motionEase 缓动曲线档位（0默认匀速 1干脆 2柔和 3弹性，作用于微推近）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {LowerThirdBar} from '../layers/LowerThirdBar';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {useSegmentShot} from '../utils/useSegmentShot';
import {TemplateProps} from '../../shared/types';
import type {FitMode} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {easeTierCurve} from '../animations/motion';
import {VIDEO_CUT_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

export const VideoCut: React.FC<TemplateProps> = ({
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

  // 个性化参数（故事板「参数」页滑块；未调整走 VIDEO_CUT_PARAMS 默认值）
  const p = makeParamReader(VIDEO_CUT_PARAMS, params);
  const padStyle = Math.round(p('padStyle'));   // 铺排方式：0=cover / 1=模糊垫片 / 2=contain
  const zoomPulse = p('zoomPulse');             // 微推近强度（0 = 完全静止）
  const lowerThirdOn = p('lowerThird') >= 0.5;  // 字幕条开关

  // 多镜定位：≥2 条素材轮转硬切 / 单素材 autoShots 按镜头边界切；否则 videos[0] 旧语义
  const {video, mediaStartSec} = useSegmentShot(
    videos,
    segmentDuration,
    p('cutSec'),
    p('autoShots') >= 0.5,
  );
  // 无素材空态：不提前 return，照常渲染背景与提示文字（参考 TextSlide 空态处理）

  const totalFrames = Math.max(1, Math.round((segmentDuration || 3) * FPS));
  // 字号/间距按画布宽度等比缩放（竖屏自动缩小）
  const tokens = getScaledTokens(canvasW, canvasH);

  // 主素材适配：cover 模式裁剪铺满，其余 contain（模糊垫片/留边只差底层衬垫）
  const fitMode: FitMode = padStyle === 0 ? 'cover' : 'contain';
  // 叠加取景视口（缩放 + 平移）：全幅铺排尤其需要它裁掉录屏边缘的无关区域（如侧旁的终端窗口）；
  // 无视口时与原 fit 居中行为一致（applyViewport 内部退化）
  const placed = video
    ? applyViewport(canvasW, canvasH, fitVideo(canvasW, canvasH, video.width, video.height, fitMode), fitMode, video.viewport)
    : null;

  // 微推近：段内 scale 从 1.0 到 1+0.05×zoomPulse，让静止素材有呼吸感（motionEase 换手感）
  const zoomScale = interpolate(frame, [0, totalFrames], [1.0, 1 + 0.05 * zoomPulse], {
    easing: easeTierCurve(p('motionEase')),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 快速淡入（结尾淡出不在这里做：出场转场/全片淡黑由 MultiSegmentPromo 统一负责，
  // 否则会把出场转场退化为 dip-to-black 并与全片淡黑双重叠加。
  // 快切段的淡入比别的模板更短，保留「刷刷刷」的硬切手感）
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 模糊垫片的铺满适配（cover 后放大 1.2 倍再压模糊，避免边缘透出底色）
  const padFit = video ? fitVideo(canvasW, canvasH, video.width, video.height, 'cover') : null;

  return (
    <AbsoluteFill style={{opacity}}>
      {/* 底色层：style.background 优先；缺省纯黑（留边/垫片区域的兜底） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill style={{backgroundColor: '#000000'}} />
      )}

      {video && placed && padFit ? (
        <>
          {/* 模糊垫片：padStyle=1 时以自身放大模糊垫满全幅（静音，音频只走主素材） */}
          {padStyle === 1 && (
            <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
              <ClipMedia
                src={video.src}
                mediaType={video.type}
                muted
                startFrom={Math.round(mediaStartSec * FPS)}
                endSec={clipEndSec(video)}
                cutsSec={video.cuts}
                style={{
                  width: padFit.width * 1.2,
                  height: padFit.height * 1.2,
                  transform: `translate(${(canvasW - padFit.width * 1.2) / 2}px, ${(canvasH - padFit.height * 1.2) / 2}px)`,
                  objectFit: 'cover',
                  filter: 'blur(40px) brightness(0.55)',
                }}
              />
            </div>
          )}

          {/* 主素材：全幅铺排，无画框/无阴影/无圆角；scale 微推近以画面中心为原点 */}
          <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
            <ClipMedia
              src={video.src}
              mediaType={video.type}
              muted={video.muted}
              volume={video.volume}
              startFrom={Math.round(mediaStartSec * FPS)}
              endSec={clipEndSec(video)}
              cutsSec={video.cuts}
              style={{
                width: placed.width,
                height: placed.height,
                transform: `translate(${placed.translateX}px, ${placed.translateY}px) scale(${zoomScale})`,
                transformOrigin: 'center',
                objectFit: fitMode,
              }}
            />
          </div>
        </>
      ) : (
        /* 无素材空态：深色背景 + 提示文字 */
        <>
          {!style?.background && <Background variant="gradient-dark" />}
          <BackgroundEffectLayer />
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
              「全屏视频快切」需要 1 段素材：请在右侧「素材」页添加录屏/实拍片段
            </div>
          </div>
        </>
      )}

      {/* 下三分之一字幕条：开启且有标题时叠加（无素材空态同样可用作信息条） */}
      {lowerThirdOn && text.title && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.06,
            right: canvasW * 0.06,
            bottom: canvasH * 0.09,
            display: 'flex',
            justifyContent: 'flex-start',
          }}
        >
          <LowerThirdBar
            title={text.title}
            subtitle={text.subtitle}
            textAnim={textAnim}
            titleStyle={style?.title}
            subtitleStyle={style?.subtitle}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};

export default VideoCut;
