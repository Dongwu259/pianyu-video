/**
 * 模板: FeatureList - 功能清单（说服力场景）
 *
 * 效果: 市场缺口模板（Motion Array Crea-Saas Widgets / CapCut Bullet Point 热搜品类）。
 * 勾选圆环描边生长 + 对勾 draw-on + 要点逐条错峰入场的清单页；
 * 可选 1 段素材作侧卡（横版左侧 / 竖版顶部），无素材时清单居中。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - title: 清单标题（如「三大核心能力」）；subtitle 副标题可选
 * - features: 要点行（≤6 条，每条一行）
 * - brandName: 左下角品牌小字
 *
 * 画面结构：
 * - 横版有素材：左素材卡（contain + 投影）/ 右标题+清单；无素材：清单整体居中
 * - 竖版：素材在上（可选）/ 标题+清单在下
 *
 * 个性化参数（paramSpecs: FEATURE_LIST_PARAMS）：itemScale 条目字号 /
 * stagger 逐条节奏 / mediaScale 素材大小。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {EASINGS, SPRINGS, entryEase} from '../animations/motion';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {textStrokeCss} from '../utils/textStroke';
import {FEATURE_LIST_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const FeatureList: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(FEATURE_LIST_PARAMS, params);
  const entry = entryEase(p('motionEase')); // 素材入场缓动档位：0=模板原曲线（C 批统一时间语言）
  const itemScale = p('itemScale'); // 条目字号倍率
  const stagger = p('stagger');     // 逐条错峰倍率
  const mediaScale = p('mediaScale'); // 素材大小倍率
  const flyVec = directionVector(p('direction'), canvasW * 0.3); // 飞入方向（null=默认轻微上浮）

  const video = videos[0]; // 素材可选：无素材时清单居中（合法用法）
  const features = (text.features ?? []).slice(0, 6);

  // ====== 节奏（标题 → 副标题 → 逐条勾选） ======
  const titleStart = 5 * pace;
  const subtitleStart = 14 * pace;
  const itemBase = 24 * pace;
  const itemStagger = 11 * pace * stagger;

  // ====== 版式 ======
  const padX = canvasW * (isPortrait ? 0.08 : 0.1);
  const hasMedia = !!video;
  const titleSize = style?.title?.fontSize ?? tokens.fontSize.title * (hasMedia ? 0.62 : 0.72);
  const itemSize = tokens.fontSize.body * 1.1 * itemScale;

  // 素材卡区域：横版左侧 44% 宽 / 竖版顶部 34% 高（mediaScale 倍率）
  const regionW = (isPortrait ? canvasW * 0.84 : canvasW * 0.44) * mediaScale;
  const regionH = (isPortrait ? canvasH * 0.34 : canvasH * 0.52) * mediaScale;
  const fit = video ? fitVideo(regionW, regionH, video.width, video.height, 'contain') : null;
  const placed = video && fit ? applyViewport(fit.width, fit.height, fit, 'contain', video.viewport) : null;

  // 素材入场：淡入 + 轻微上浮（同 LowerThird 约定）
  const mediaProg = interpolate(frame, [0, 12], [0, 1], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 驻留微运动：素材卡入场完成后保持呼吸+缓慢漂移（P2 质感）
  const mediaBreathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const mediaDrift = dwellDrift(frame, FPS, 4 * (canvasW / 1920), 3 * (canvasW / 1920), 9, 0);

  // 清单列水平位置：有素材时在素材右侧/下方，无素材时整列居中
  const listLeft = hasMedia
    ? isPortrait
      ? padX
      : padX + regionW + canvasW * 0.05
    : canvasW * 0.19;
  const listRight = canvasW - padX;
  const listTop = hasMedia
    ? isPortrait
      ? canvasH * 0.52
      : canvasH * 0.2
    : canvasH * 0.22;
  const listMaxW = hasMedia ? listRight - listLeft : canvasW * 0.62;

  // ====== 单条要点：勾选圆环描边生长 + 对勾 draw-on + 文字上浮 ======
  const renderItem = (feature: string, i: number) => {
    const start = itemBase + i * itemStagger;
    // 圆环：spring 缩放落位；对勾：pathLength 归一化后按进度露出描边
    const ringPop = spring({frame: frame - start, fps: FPS, config: SPRINGS.cardPop});
    const checkProg = interpolate(frame, [start + 3 * pace, start + 10 * pace], [1, 0], {
      easing: EASINGS.standard,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const ringSize = Math.max(24, itemSize * 1.05);
    // 驻留微运动：条目入场完成后保持缓慢漂移（纯文字不加呼吸，P2 质感）
    const drift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, i * 1.37);

    return (
      <div key={i} style={{display: 'flex', alignItems: 'flex-start', gap: tokens.spacing.element * 1.1, minWidth: 0, transform: `translate(${drift.x}px, ${drift.y}px)`}}>
        <svg
          width={ringSize}
          height={ringSize}
          viewBox="0 0 24 24"
          style={{
            flexShrink: 0,
            marginTop: itemSize * 0.22,
            opacity: ringPop,
            transform: `scale(${0.4 + ringPop * 0.6})`,
            transformOrigin: 'center',
          }}
        >
          <circle cx="12" cy="12" r="10" fill="none" stroke={ACCENT()} strokeWidth="2" opacity="0.35" />
          <path
            d="M7.5 12.5 L10.5 15.5 L16.5 9"
            fill="none"
            stroke={ACCENT()}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={checkProg}
          />
        </svg>
        <div style={{minWidth: 0, flex: 1}}>
          <AnimatedText
            text={feature}
            preset={textAnim ?? 'fadeUp'}
            startFrame={Math.round(start + 2 * pace)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: style?.feature?.fontSize ?? itemSize,
              fontWeight: style?.feature?.fontWeight ?? 500,
              color: style?.feature?.color ?? VIDEO_DESIGN.colors.textBody,
              fontFamily: VIDEO_DESIGN.bodyFont,
              lineHeight: 1.45,
              letterSpacing: '0.01em',
              ...textStrokeCss(style?.feature),
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <AbsoluteFill>
      {/* 背景层：浅色渐变（可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-light" />
      )}
      <BackgroundEffectLayer />

      {/* 素材卡（可选）：横版左侧垂直居中 / 竖版顶部居中 */}
      {video && fit && placed && (
        <div
          style={{
            position: 'absolute',
            left: (isPortrait ? (canvasW - fit.width) / 2 : padX),
            top: isPortrait ? canvasH * 0.13 + (regionH - fit.height) / 2 : canvasH * 0.5 - fit.height / 2,
            width: fit.width,
            height: fit.height,
            borderRadius: 14,
            overflow: 'hidden',
            boxShadow: VIDEO_DESIGN.shadowFloat,
            opacity: mediaProg,
            transform: flyVec
              ? `translate(${(1 - mediaProg) * flyVec.x + mediaDrift.x}px, ${(1 - mediaProg) * flyVec.y + mediaDrift.y}px) scale(${mediaBreathe})`
              : `translateY(${(1 - mediaProg) * 24 + mediaDrift.y}px) translateX(${mediaDrift.x}px) scale(${mediaBreathe})`,
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

      {/* 清单列：标题 + 副标题 + 要点（无素材时是主视觉，跟随飞入方向） */}
      <div
        style={{
          position: 'absolute',
          left: listLeft,
          width: listMaxW,
          top: listTop,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          ...(flyVec && !video
            ? {transform: `translate(${(1 - mediaProg) * flyVec.x}px, ${(1 - mediaProg) * flyVec.y}px)`, opacity: mediaProg}
            : {}),
        }}
      >
        {text.title && (
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={Math.round(titleStart)}
            duration={Math.round(16 * pace)}
            style={{
              fontSize: titleSize,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              fontFamily: VIDEO_DESIGN.titleFont,
              letterSpacing: '-0.01em',
              lineHeight: 1.2,
              ...textStrokeCss(style?.title),
            }}
          />
        )}
        {text.subtitle && (
          <AnimatedText
            text={text.subtitle}
            preset={textAnim ?? 'fadeIn'}
            startFrame={Math.round(subtitleStart)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: style?.subtitle?.fontSize ?? tokens.fontSize.subtitle * 0.8,
              fontWeight: style?.subtitle?.fontWeight ?? 400,
              color: style?.subtitle?.color ?? VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              lineHeight: 1.35,
              marginTop: tokens.spacing.element,
              marginBottom: tokens.spacing.paragraph,
              ...textStrokeCss(style?.subtitle),
            }}
          />
        )}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing.paragraph * 0.85,
            marginTop: text.title ? tokens.spacing.paragraph * (text.subtitle ? 0.2 : 0.8) : 0,
            width: '100%',
          }}
        >
          {features.map(renderItem)}
        </div>
      </div>

      {/* 品牌名：左下角小字（同家族约定） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.06),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: fadeIn(frame, 12 * pace, 14 * pace),
          }}
        >
          <div
            style={{
              width: Math.max(8, Math.round(tokens.fontSize.caption * 0.45)),
              height: Math.max(8, Math.round(tokens.fontSize.caption * 0.45)),
              borderRadius: '50%',
              background: ACCENT(),
            }}
          />
          <span
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
              fontWeight: style?.brand?.fontWeight ?? 500,
              color: style?.brand?.color ?? VIDEO_DESIGN.colors.textMuted,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.14em',
              ...textStrokeCss(style?.brand),
            }}
          >
            {text.brandName}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default FeatureList;
