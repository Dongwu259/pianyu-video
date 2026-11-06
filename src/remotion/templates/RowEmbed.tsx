/**
 * 模板: RowEmbed - 逐行嵌入（UI 演示族 / 教程录屏体裁）
 *
 * 设计稿：docs/template-design-row-embed.md（来源 card `row-embed`，Apache-2.0 手法参考、重写实现）。
 * 结构不再是「卡片从旁边滑入」，而是**内容行从空中落下、rotateX 收平、严丝合缝嵌进面板槽位**：
 * - 背景层：videos[0] 全幅铺底 blur(24px)+brightness(0.45)（替代原卡的「桌面」氛围）；无素材走渐变
 * - 面板层：圆角窗口承载 title / subtitle / 行列表 / brandName 页脚
 * - 行层（≤4 行）：序号徽标 + 文案 + 可选右侧视频条带（同一条素材不同 objectPosition 裁窗，
 *   视觉上「内容从画面里长出来」，不需要长截图裁片管线）
 * - 每行：空槽虚线占位 → 空中下落（越落越快、带纵向运动模糊）→ 落地弹回 + 底边强调色缝
 * - 相机：面板全程缓缓推近 + 上摇（translateY 0 → −1.5%），落地后极轻微呼吸
 *
 * 文案约定：title = 面板主标题；subtitle = 一行副标题；features = 行列表（取前 4 条）；
 * brandName = 页脚弱化标识。
 *
 * 个性化参数（paramSpecs: ROW_EMBED_PARAMS）：下落速度 / 节拍递减 / 下落距离 / 入场仰角 /
 * 嵌入闪光 / 相机推近 / 行纹理条带 / 面板色调 / 行文字大小。
 *
 * ⚠️ 未注册状态（设计稿 §十二.1）：不进 MultiSegmentPromo 的 TEMPLATE_MAP、不进
 * template-registry 的 TEMPLATES——v9 bench 判决前注册会改变 get_templates 候选空间。
 * 参数表暂住在 shared/row-embed-layout（注册时迁到 template-registry，§九.5）。
 */

import {AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {AnimatedText} from '../layers/AnimatedText';
import {fadeIn} from '../animations/keyframes';
import {dwellBreathe} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeInsets} from '../utils/safeArea';
import {textStrokeCss} from '../utils/textStroke';
import {clipEndSec} from '../../shared/clipCuts';
import {ROW_EMBED_PARAMS} from '../../shared/template-registry';
import {planRowEmbed} from '../../shared/row-embed-layout';

/** 行飞行的缓动：末段仍有速度（砸进感），靠落地 press 回弹吸收 */
const FLY_EASE = Easing.bezier(0.5, 0, 0.8, 0.75);
/** 落地后的 scale 回弹帧数（0.995 → 1） */
const PRESS_FRAMES = 4;
/** 强调色缝：展开 5f、8f 淡出（§八.2.3） */
const SEAM_OPEN_FRAMES = 5;
const SEAM_FADE_FRAMES = 8;
/** 运动模糊最大 stdDeviation（纵向） */
const BLUR_MAX = 3.2;

/** 模板内置琥珀强调色（brandColor 缺省时） */
const DEFAULT_ACCENT = '#C2872F';

export const RowEmbed: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
  textAnim,
  brandColor,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);

  const p = makeParamReader(ROW_EMBED_PARAMS, params);
  const flySpeed = p('flySpeed');
  const staggerDecel = p('staggerDecel');
  const dropDistance = p('dropDistance');
  const tiltDeg = p('tiltDeg');
  const seamStrength = p('seamStrength');
  const camPush = p('camPush');
  const rowMedia = p('rowMedia');
  const panelTone = p('panelTone');
  const rowsTextScale = p('rowsTextScale');

  // 模型素材（.glb）进不了行条带/模糊背景，按「无素材」处理（ClipMedia 的模型分支持 3D 模板）
  const video = videos[0] && videos[0].type !== 'model' ? videos[0] : undefined;
  const accents = brandColor || DEFAULT_ACCENT;
  const features = (text.features ?? []).map((f) => (f ?? '').trim()).filter(Boolean);

  const total = Math.round((segmentDuration || 5) * FPS);
  const insets = safeInsets(canvasW, canvasH);
  const plan = planRowEmbed({
    canvasW,
    canvasH,
    totalFrames: total,
    featureCount: features.length,
    hasMedia: !!video,
    bodyFontPx: tokens.fontSize.body,
    params: {flySpeed, staggerDecel, camPush, rowMedia, rowsTextScale},
    hasTitle: !!text.title,
    hasSubtitle: !!text.subtitle,
    hasBrand: !!text.brandName,
    safeTop: insets.top,
    safeBottom: insets.bottom,
  });
  const rows = features.slice(0, plan.rows);

  // ====== 面板色调（0 浅色 / 1 深色） ======
  const dark = panelTone >= 0.5;
  const panelBg = dark ? 'rgba(18, 20, 28, 0.92)' : 'rgba(250, 250, 247, 0.94)';
  // 行底板比面板亮一档：落地后行是「嵌在页面里的白卡」，空槽补丁同色（落地不跳色）
  const rowSolid = dark ? '#1A1D27' : '#FFFFFF';
  const ink = dark ? '#F2F5FA' : '#111827';
  const inkMuted = dark ? 'rgba(242, 245, 250, 0.62)' : 'rgba(17, 24, 39, 0.55)';
  const hairline = dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(17, 24, 39, 0.08)';
  const slotDash = dark ? 'rgba(255, 255, 255, 0.34)' : 'rgba(17, 24, 39, 0.3)';
  // 空槽内部比面板略深一档：读成「等着内容落进来的坑」，与落地后的白行形成对比
  const slotFill = dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(17, 24, 39, 0.035)';

  // ====== 相机（§三）：全程缓缓推近 + 上摇；落地后极轻微呼吸 ======
  const camProg = interpolate(frame, [0, Math.max(1, total - 1)], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const breathe = dwellBreathe(frame, FPS, 0.004, 3, 0);
  const panelScale = (1 + plan.camScale * camProg) * breathe;
  const panelShiftY = -canvasH * 0.015 * camProg;
  const panelIn = fadeIn(frame, 0, 9);

  const startFrom = video ? Math.round((video.trimStart || 0) * FPS) : 0;
  const endSec = video ? clipEndSec(video) : undefined;

  // ====== 单行：空槽占位 → 飞行体 → 落地弹回 + 底色缝 ======
  const renderRow = (feature: string, i: number) => {
    const cue = plan.cues[i];
    const land = plan.landFrames[i];
    const pRaw = Math.min(1, Math.max(0, (frame - cue) / Math.max(1, plan.flyFrames)));
    const eased = FLY_EASE(pRaw);
    const air = 1 - eased; // 1 = 在高空，0 = 已落地
    const flying = frame >= cue;

    // 飞行姿态：−dropSpan·air + rotateX(tilt·air)，scale 1.06 → 0.995；落地 4f 弹回 1
    // dropSpan 按行位置钳到「行区上缘到本槽」的距离：首行从表头下沿露头（否则整段飞行
    // 都被行区裁掉，只剩落地前一瞬出现），同时保证不会有行从面板中段凭空冒出。
    const dropSpan = Math.min(dropDistance, (i + 1) * plan.rowH);
    const flyScale = 1.06 - 0.065 * eased;
    const scale = frame < land ? flyScale : interpolate(frame, [land, land + PRESS_FRAMES], [0.995, 1], {
      easing: Easing.out(Easing.quad),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

    // 运动模糊：纵向速度 → 0..3.2 stdDeviation（仅 air>0.15 挂 filter，避免全帧开销）
    const blurPx = air > 0.15 ? BLUR_MAX * air : 0;

    // 空槽补丁：落地前可见，落地后 2f 消失（无重影）
    const patchOpacity =
      frame < land
        ? 1
        : interpolate(frame, [land, land + 2], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });

    // 槽位接触影：随行接近收紧变实，落地后 3f 淡出
    const shadowOpacity =
      frame < cue
        ? 0
        : frame < land
          ? 0.55
          : interpolate(frame, [land, land + 3], [1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });

    // 强调色缝：底边 2px，从中心向两侧展开 5f、8f 淡出（裁在行圆角内）
    const seamAge = frame - land;
    const seamScale = interpolate(seamAge, [0, SEAM_OPEN_FRAMES], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const seamOpacity =
      seamStrength <= 0 || seamAge < 0
        ? 0
        : seamAge <= SEAM_OPEN_FRAMES
          ? 1
          : interpolate(seamAge, [SEAM_OPEN_FRAMES, SEAM_OPEN_FRAMES + SEAM_FADE_FRAMES], [1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });

    // 行纹理条带：同一条素材按行错开纵向取景（objectPosition）
    const bandPct = 12 + i * (76 / Math.max(1, plan.rows - 1));
    const bandH = Math.max(
      plan.rowTextPx * 0.8,
      Math.min(plan.rowH * 0.86, plan.rowH - plan.rowTextPx * 0.4),
    );

    return (
      <div key={i} style={{position: 'relative', height: plan.rowH, flexShrink: 0}}>
        {/* 空槽补丁：面板底色上压一层极淡的「坑」+ 虚线框（落地前占位；首轮实锤
            1px/0.22 的虚线在 1080p 被抗锯齿吃掉，读成一块白板——加粗到 ~2px、加深到 0.3） */}
        <div
          style={{
            position: 'absolute',
            top: plan.rowH * 0.06,
            bottom: plan.rowH * 0.06,
            left: 0,
            right: 0,
            borderRadius: Math.max(6, plan.rowTextPx * 0.28),
            background: slotFill,
            border: `${Math.max(1, Math.round(plan.rowTextPx * 0.07))}px dashed ${slotDash}`,
            opacity: patchOpacity,
          }}
        />

        {/* 槽位接触影：随 air 收紧（y 2+6·air / blur 6+18·air） */}
        <div
          style={{
            position: 'absolute',
            left: plan.contentW * 0.08,
            right: plan.contentW * 0.08,
            bottom: plan.rowH * 0.06,
            height: 2,
            borderRadius: 2,
            boxShadow: `0 ${2 + 6 * air}px ${6 + 18 * air}px rgba(0, 0, 0, ${0.22 * shadowOpacity})`,
            opacity: shadowOpacity,
          }}
        />

        {/* 飞行体 */}
        {flying && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              transform: `perspective(900px) translateY(${-dropSpan * air}px) rotateX(${tiltDeg * air}deg) scale(${scale})`,
              transformOrigin: '50% 80%',
              // 飞行体全程不透明：淡入会让白底半透明，盖住下方已落地的行造成「叠影」
              // （四画幅首轮实锤：cue 后 2 帧的 0.67 透明度把下层行洗成鬼影）
              filter: blurPx > 0.01 ? `url(#row-embed-blur-${i})` : undefined,
            }}
          >
            {/* 纵向运动模糊（SVG 各向异性 blur；仅飞行期定义） */}
            <svg width={0} height={0} style={{position: 'absolute'}} aria-hidden>
              <defs>
                <filter id={`row-embed-blur-${i}`} x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation={`0.4 ${blurPx.toFixed(2)}`} />
                </filter>
              </defs>
            </svg>

            {/* 行底板：与面板同色（落地即无缝嵌入），圆角裁住缝与辉光（卡片坑 Q4） */}
            <div
              style={{
                position: 'absolute',
                top: plan.rowH * 0.04,
                bottom: plan.rowH * 0.04,
                left: 0,
                right: 0,
                display: 'flex',
                alignItems: 'center',
                gap: plan.rowTextPx * 0.55,
                padding: `0 ${plan.rowTextPx * 0.6}px`,
                borderRadius: Math.max(6, plan.rowTextPx * 0.28),
                background: rowSolid,
                boxShadow: `inset 0 -1px 0 ${hairline}`,
                overflow: 'hidden',
              }}
            >
              {/* 序号徽标 */}
              <div
                style={{
                  flexShrink: 0,
                  width: plan.rowTextPx * 1.4,
                  height: plan.rowTextPx * 1.4,
                  borderRadius: '50%',
                  background: accents,
                  color: '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: plan.rowTextPx * 0.66,
                  fontWeight: 700,
                  fontFamily: VIDEO_DESIGN.monoFont,
                  letterSpacing: '0.02em',
                  opacity: 0.94,
                }}
              >
                {i + 1}
              </div>

              {/* 行文案 */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: style?.feature?.fontSize ?? plan.rowTextPx,
                  fontWeight: style?.feature?.fontWeight ?? 600,
                  color: style?.feature?.color ?? ink,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  lineHeight: 1.25,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  ...textStrokeCss(style?.feature),
                }}
              >
                {feature}
              </div>

              {/* 行纹理条带：同一素材的不同纵向取景（无素材/竖版/参数关时宽 0） */}
              {plan.mediaBandW > 0 && video && (
                <div
                  style={{
                    flexShrink: 0,
                    width: plan.mediaBandW,
                    height: bandH,
                    borderRadius: Math.max(4, plan.rowTextPx * 0.18),
                    overflow: 'hidden',
                    background: '#0B0D12',
                  }}
                >
                  <ClipMedia
                    src={video.src}
                    mediaType={video.type}
                    muted
                    startFrom={startFrom}
                    endSec={endSec}
                    cutsSec={video.cuts}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      objectPosition: `50% ${bandPct}%`,
                    }}
                  />
                </div>
              )}

              {/* 嵌入瞬间的强调色缝：底边 2px、两端羽化、只在底边只闪一次 */}
              {seamOpacity > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: 0,
                    width: plan.contentW * 0.5 * seamStrength,
                    height: 2,
                    marginLeft: (-plan.contentW * 0.5 * seamStrength) / 2,
                    borderRadius: 1,
                    background: accents,
                    boxShadow: `0 0 7px ${accents}`,
                    opacity: seamOpacity,
                    transform: `scaleX(${seamScale})`,
                    transformOrigin: '50% 50%',
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <AbsoluteFill>
      {/* ====== 背景层 ====== */}
      {video ? (
        <AbsoluteFill>
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            muted
            startFrom={startFrom}
            endSec={endSec}
            cutsSec={video.cuts}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(24px) brightness(0.45)',
              transform: 'scale(1.08)',
            }}
          />
          {/* 轻晕影：把视觉重心压回面板 */}
          <AbsoluteFill
            style={{
              background:
                'radial-gradient(120% 90% at 50% 42%, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.42) 100%)',
            }}
          />
        </AbsoluteFill>
      ) : (
        <>
          {style?.background ? (
            <AbsoluteFill style={{background: style.background}} />
          ) : (
            <Background variant="gradient-light" />
          )}
          <BackgroundEffectLayer />
        </>
      )}

      {/* ====== 面板层（相机：推近 + 上摇） ====== */}
      <div
        style={{
          position: 'absolute',
          left: plan.panelLeft,
          top: plan.panelTop,
          width: plan.panelW,
          height: plan.panelH,
          boxSizing: 'border-box',
          padding: `${plan.padY}px ${plan.padX}px`,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: Math.max(14, plan.panelW * 0.018),
          background: panelBg,
          backdropFilter: 'blur(18px)',
          boxShadow: dark
            ? '0 40px 90px -24px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.12)'
            : '0 40px 90px -24px rgba(0, 0, 0, 0.34), 0 0 0 1px rgba(17, 24, 39, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.85)',
          transform: `translateY(${panelShiftY}px) scale(${panelScale})`,
          transformOrigin: '50% 50%',
          opacity: panelIn,
        }}
      >
        {/* 面板头：标题 + 一行副标题 */}
        <div style={{height: plan.headerH, flexShrink: 0, overflow: 'hidden'}}>
          {text.title && (
            <AnimatedText
              text={text.title}
              preset={textAnim ?? 'fadeUp'}
              startFrame={2}
              duration={14}
              style={{
                fontSize: style?.title?.fontSize ?? plan.titlePx,
                fontWeight: style?.title?.fontWeight ?? 700,
                color: style?.title?.color ?? ink,
                fontFamily: VIDEO_DESIGN.titleFont,
                letterSpacing: '-0.01em',
                lineHeight: 1.18,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                ...textStrokeCss(style?.title),
              }}
            />
          )}
          {text.subtitle && (
            <div style={{marginTop: text.title ? plan.gapS * 0.6 : 0}}>
              <AnimatedText
                text={text.subtitle}
                preset={textAnim ?? 'fadeIn'}
                startFrame={8}
                duration={12}
                style={{
                  fontSize: style?.subtitle?.fontSize ?? plan.subtitlePx,
                  fontWeight: style?.subtitle?.fontWeight ?? 400,
                  color: style?.subtitle?.color ?? inkMuted,
                  fontFamily: VIDEO_DESIGN.bodyFont,
                  lineHeight: 1.35,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  ...textStrokeCss(style?.subtitle),
                }}
              />
            </div>
          )}
        </div>

        {/* 行区：每行一个槽位，槽高 = rowH（落地即贴合）；裁住飞行体——
            行从行区上缘落进来，不盖住面板标题（四画幅首轮实锤：无裁剪时首行飞越表头）。
            用 clip-path 只裁纵向：飞行姿态 scale 1.06 的横向放大不许切掉序号徽标
            （overflow:hidden 会四边全裁，实锤徽标被切半）。 */}
        {plan.rows > 0 && (
          <div
            style={{
              height: plan.rows * plan.rowH,
              flexShrink: 0,
              position: 'relative',
              clipPath: `inset(0px -${Math.round(plan.panelW * 0.08)}px)`,
            }}
          >
            {rows.map(renderRow)}
          </div>
        )}

        {/* 页脚：品牌名弱化 */}
        {text.brandName && (
          <div
            style={{
              height: plan.footerH,
              flexShrink: 0,
              paddingTop: plan.gapS * 2,
              display: 'flex',
              alignItems: 'center',
              gap: plan.gapS * 0.6,
              opacity: fadeIn(frame, 12, 14),
            }}
          >
            <div
              style={{
                width: Math.max(6, plan.brandPx * 0.45),
                height: Math.max(6, plan.brandPx * 0.45),
                borderRadius: '50%',
                background: accents,
              }}
            />
            <span
              style={{
                fontSize: style?.brand?.fontSize ?? plan.brandPx,
                fontWeight: style?.brand?.fontWeight ?? 500,
                color: style?.brand?.color ?? inkMuted,
                fontFamily: VIDEO_DESIGN.bodyFont,
                letterSpacing: '0.14em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                ...textStrokeCss(style?.brand),
              }}
            >
              {text.brandName}
            </span>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

export default RowEmbed;
