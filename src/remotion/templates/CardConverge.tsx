/**
 * 模板: CardConverge - 卡片汇聚卡点
 *
 * 效果: 多张卡片（2–8 段素材）按「首卡落位 + 入场间隔」的节奏，从四边/四角
 * 依次飞入画面，spring 回弹落位到中央排列（网格/扇形/堆叠），结尾整体向观众
 * 推近（heroZoom）把动能交给下一段转场。
 *
 * 与硬切卡点的区别：节奏靠「元素落位」表达而不是画面闪烁——把入场间隔调到
 * 与 BGM 鼓点间隔一致（配合「卡点对齐」吸附片段边界），每张卡恰好压一拍，
 * 是企业宣传片常见的卡片汇聚镜头（参考 Kimi K3 宣传片的多卡入场）。
 *
 * 画面结构：
 * - 底色层：style.background 优先，缺省深色渐变
 * - 卡片区：圆角 + 软阴影 + 细描边；内容 cover 铺满（支持取景视口裁切）
 * - 标题：有标题时顶部 charPop 渐入（可选，蒙太奇用法一般不留标题）
 * - 无素材空态：深色背景 + 提示文字（同 VideoCut 空态约定）
 *
 * 个性化参数（paramSpecs: CARD_CONVERGE_PARAMS）：
 * stagger 入场间隔（秒，与鼓点间隔对齐即卡点）/ firstHit 首卡落位时刻 /
 * layoutMode 排列（0网格/1扇形/2堆叠）/ dirMode 入场方向（0四边/1四角/2左右）/
 * cardScale 卡片大小 / heroZoom 结尾推近（0=静止）/ tilt 落位倾角幅度。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {MotionTrail} from '../components/MotionTrail';
import {SPRINGS, EASINGS, entryEase} from '../animations/motion';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {TemplateProps, VideoClip} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader, directionVector} from '../utils/params';
import {CARD_CONVERGE_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

/** 一张卡的目标落位（居中坐标系：cx/cy 相对画布中心的偏移） */
interface CardSlot {
  cx: number;
  cy: number;
  rot: number; // 落位倾角（度）
  w: number;
  h: number;
}

/** 确定性伪随机（按索引，渲染逐帧可重放） */
const seeded = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x); // 0..1
};

/** 计算 N 张卡的最终排列（居中坐标系） */
const computeSlots = (
  n: number,
  mode: number,
  canvasW: number,
  canvasH: number,
  cardScale: number,
  tilt: number,
): CardSlot[] => {
  // 卡片统一 16:9（素材绝大多数是横屏录屏/截图；竖版画布自动收窄）
  const cardAspect = 16 / 9;
  if (mode === 1) {
    // 扇形：沿弧线摊开，两侧下坠、倾角渐进
    const w = Math.min(canvasW * 0.34, canvasH * 0.42 * cardAspect) * cardScale;
    const h = w / cardAspect;
    const step = Math.min(w * 0.52, (canvasW * 0.72) / Math.max(n - 1, 1));
    return Array.from({length: n}, (_, i) => {
      const k = i - (n - 1) / 2; // 以中央为 0 的对称序号
      return {
        cx: k * step,
        cy: Math.abs(k) * step * 0.18,
        rot: k * Math.min(tilt, 12) * 0.9,
        w,
        h,
      };
    });
  }
  if (mode === 2) {
    // 堆叠：全部居中，小偏移 + 伪随机倾角，后到的压在上面（竖版画布给足宽度，否则卡片显小）
    const w = Math.min(canvasW * 0.66, canvasH * 0.62 * cardAspect) * cardScale;
    const h = w / cardAspect;
    return Array.from({length: n}, (_, i) => ({
      cx: (seeded(i, 1) - 0.5) * canvasW * 0.03,
      cy: (seeded(i, 2) - 0.5) * canvasH * 0.03,
      rot: (seeded(i, 3) - 0.5) * 2 * tilt,
      w,
      h,
    }));
  }
  // 网格（默认）：中央 84%×70% 区域内按画幅挑列数，卡片保持 16:9（排面撑满才有海报感）
  const areaW = canvasW * 0.84;
  const areaH = canvasH * 0.7;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (canvasW / canvasH) * 1.2))));
  const rows = Math.ceil(n / cols);
  const gap = Math.min(canvasW, canvasH) * 0.025;
  const w = Math.min((areaW - gap * (cols - 1)) / cols, ((areaH - gap * (rows - 1)) / rows) * cardAspect) * cardScale;
  const h = w / cardAspect;
  const gridH = rows * h + (rows - 1) * gap;
  return Array.from({length: n}, (_, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    // 末行不满时居中
    const rowCount = r === rows - 1 ? n - r * cols : cols;
    const rowW = rowCount * w + (rowCount - 1) * gap;
    return {
      cx: -rowW / 2 + w / 2 + c * (w + gap),
      cy: -gridH / 2 + h / 2 + r * (h + gap),
      rot: (seeded(i, 4) - 0.5) * 2 * Math.min(tilt, 4), // 网格只给微倾角，保持利落
      w,
      h,
    };
  });
};

/** 入场方向向量（屏外起点相对落点的偏移） */
const entryOffset = (i: number, dirMode: number, canvasW: number, canvasH: number): {dx: number; dy: number} => {
  const offX = canvasW * 1.1;
  const offY = canvasH * 1.1;
  if (dirMode === 1) {
    // 四角轮转：左上 → 右下 → 右上 → 左下
    const corners = [
      {dx: -offX, dy: -offY},
      {dx: offX, dy: offY},
      {dx: offX, dy: -offY},
      {dx: -offX, dy: offY},
    ];
    return corners[i % 4];
  }
  if (dirMode === 2) {
    // 左右对向交替
    return i % 2 === 0 ? {dx: -offX, dy: 0} : {dx: offX, dy: 0};
  }
  // 四边轮转：左 → 右 → 上 → 下
  const sides = [
    {dx: -offX, dy: 0},
    {dx: offX, dy: 0},
    {dx: 0, dy: -offY},
    {dx: 0, dy: offY},
  ];
  return sides[i % 4];
};

/** 单张卡片：自屏外飞入，spring 回弹落位 */
const ConvergeCard: React.FC<{
  video: VideoClip;
  slot: CardSlot;
  startFrame: number;
  dir: {dx: number; dy: number};
  index: number;
  tilt: number;
}> = ({video, slot, startFrame, dir, index, tilt}) => {
  const frame = useCurrentFrame();
  // 弹簧回弹：damping 14 带一次轻微过冲，落位有「砸到鼓点」的弹性手感
  const prog = spring({
    frame: frame - startFrame,
    fps: FPS,
    config: SPRINGS.cardSettle,
    durationInFrames: Math.round(FPS * 1.2),
  });
  // 入场初段淡入，避免屏外硬显
  const opacity = interpolate(frame - startFrame, [0, 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const entryRot = slot.rot + (seeded(index, 5) > 0.5 ? 1 : -1) * (tilt + 8); // 飞入时多带一点旋转
  // 卡片基准在画布中心（left/top 50% + 负 margin），translate 直接给「落点 + 屏外偏移×(1-进度)」
  const x = slot.cx + dir.dx * (1 - prog);
  const y = slot.cy + dir.dy * (1 - prog);
  const rot = entryRot + (slot.rot - entryRot) * prog;

  // 卡内素材 cover 铺满 + 取景视口（裁录屏边缘无关区域）
  const fit = fitVideo(slot.w, slot.h, video.width, video.height, 'cover');
  const placed = applyViewport(slot.w, slot.h, fit, 'cover', video.viewport);

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: slot.w,
        height: slot.h,
        marginLeft: -slot.w / 2,
        marginTop: -slot.h / 2,
        transform: `translate(${x}px, ${y}px) rotate(${rot}deg)`,
        opacity,
        borderRadius: Math.max(8, slot.w * 0.025),
        overflow: 'hidden',
        boxShadow: '0 18px 50px rgba(0,0,0,0.45), 0 4px 14px rgba(0,0,0,0.35)',
        border: '1px solid rgba(255,255,255,0.14)',
        background: '#0B0F1A',
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
          objectFit: 'cover',
        }}
      />
    </div>
  );
};

export const CardConverge: React.FC<TemplateProps> = ({
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
  const tokens = getScaledTokens(canvasW, canvasH);

  const totalFrames = Math.max(1, Math.round((segmentDuration || 5) * FPS));

  // 个性化参数（故事板「参数」页滑块；未调整走 CARD_CONVERGE_PARAMS 默认值）
  const p = makeParamReader(CARD_CONVERGE_PARAMS, params);
  const entry = entryEase(p('motionEase'), EASINGS.accel); // 结尾推近缓动档位：0=模板原匀加速（C 批统一时间语言）
  const stagger = Math.max(0.05, p('stagger'));     // 入场间隔（秒）：与 BGM 鼓点间隔对齐即卡点
  const firstHit = Math.max(0, p('firstHit'));      // 首卡落位时刻（秒）
  const layoutMode = Math.round(p('layoutMode'));   // 排列：0网格 / 1扇形 / 2堆叠
  const dirMode = Math.round(p('dirMode'));         // 入场方向：0四边 / 1四角 / 2左右
  const dirSingle = directionVector(p('direction'), 1); // 全卡同向飞入（null=按 dirMode 轮转）
  const cardScale = p('cardScale');                 // 卡片尺寸倍率
  const heroZoom = p('heroZoom');                   // 结尾推近强度（0 = 静止）
  const tilt = p('tilt');                           // 落位倾角幅度（度）

  const cards = videos.slice(0, 8);
  const slots = computeSlots(Math.max(cards.length, 1), layoutMode, canvasW, canvasH, cardScale, tilt);

  // 结尾推近：最后 25% 段长匀加速推近（accel 起步慢、末段快，动能交给下一段转场）
  const zoomStart = totalFrames * 0.75;
  const heroScale = interpolate(frame, [zoomStart, totalFrames], [1, 1 + 0.22 * heroZoom], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: entry,
  });

  // 快速淡入（出场转场/全片淡黑由 MultiSegmentPromo 统一负责，同 VideoCut 约定）
  const opacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {cards.length > 0 ? (
        <AbsoluteFill
          style={{
            transform: `scale(${heroScale})`,
            transformOrigin: 'center',
          }}
        >
          {cards.map((video, i) => {
            const cardStart = Math.round((firstHit + i * stagger) * FPS);
            // 运动模糊窗口：入场 spring（damping 14）在 0.5s 已过冲收敛、速度趋零，
            // 之后的拖尾与卡片几乎重合、视觉不可见纯耗渲染（渲帧计时验证过 0.8s 窗口
            // 会让 5s 卡点段渲染耗时 +55%，收到 0.5s 拖尾视觉无损）
            const sinceStart = frame - cardStart;
            return (
              <MotionTrail key={video.id} active={sinceStart >= 0 && sinceStart < FPS * 0.5}>
                <ConvergeCard
                  video={video}
                  slot={slots[i]}
                  startFrame={cardStart}
                  dir={
                    dirSingle
                      ? {dx: dirSingle.x * canvasW * 1.1, dy: dirSingle.y * canvasH * 1.1}
                      : entryOffset(i, dirMode, canvasW, canvasH)
                  }
                  index={i}
                  tilt={tilt}
                />
              </MotionTrail>
            );
          })}
        </AbsoluteFill>
      ) : (
        /* 无素材空态：提示文字 */
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
            「卡片汇聚卡点」需要 2–8 段素材：请在右侧「素材」页添加录屏/截图
          </div>
        </div>
      )}

      {/* 可选标题：顶部渐入（蒙太奇用法一般留空） */}
      {text.title && (
        <div style={{position: 'absolute', top: canvasH * 0.06, left: 0, right: 0, textAlign: 'center'}}>
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'charPop'}
            startFrame={3}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.title * 0.75,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitle,
              fontFamily: VIDEO_DESIGN.titleFont,
            }}
          />
        </div>
      )}
    </AbsoluteFill>
  );
};

export default CardConverge;
