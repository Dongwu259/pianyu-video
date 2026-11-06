/**
 * 模板: VlogPolaroid - vlog 拍立得照片堆（vlog 专属家族）
 *
 * 画面结构：
 * - 1-8 张照片装进白边拍立得相框（照片区 1:1 cover + 底部白边小注），散落排布
 * - 每张从右下方甩入落位（spring 回弹 + 落位小倾角，伪随机抖动保持散落感）
 * - features[i] = 第 i 张照片的手写小注（可留空）；title 可选作整页小标题（左上）
 * - 无素材空态：纸色背景 + 提示文字（同 VideoCut/TextSlide 空态约定，不 return null）
 *
 * 个性化参数（paramSpecs: VLOG_POLAROID_PARAMS）：
 * stagger 入场间隔（秒，对齐 BGM 鼓点即卡点）/ photoScale 照片大小 / scatter 散落倾角。
 */

import {AbsoluteFill, Img, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {SPRINGS} from '../animations/motion';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps, VideoClip} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {VLOG_POLAROID_PARAMS} from '../../shared/template-registry';
import {ClipMedia} from '../layers/ClipMedia';
import {fitVideo} from '../utils/fitVideo';
import {applyViewport} from '../utils/viewport';
import {clipEndSec} from '../../shared/clipCuts';

const INK = '#292524';
const PAPER_TOP = '#FBF7EF';
const PAPER_BOTTOM = '#EFE6D4';

/** 确定性伪随机（渲染逐帧可重放） */
const seeded = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x); // 0..1
};

/** 一张拍立得的落位（居中坐标系）：正方形照片 + 白框 + 底部小注区 */
interface PolaroidSlot {
  cx: number;
  cy: number;
  rot: number;
  size: number; // 照片区边长
}

/** N 张拍立得散落排布：网格 + 伪随机偏移/倾角（散落感），竖版画布自动收窄 */
const computeSlots = (n: number, canvasW: number, canvasH: number, photoScale: number, scatter: number): PolaroidSlot[] => {
  // 拍立得整体纵横比（照片 1:1 + 底部白边约 22%）
  const frameAspect = 1 / 1.22;
  const areaW = canvasW * 0.82;
  const areaH = canvasH * 0.72;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (canvasW / canvasH) * 1.1))));
  const rows = Math.ceil(n / cols);
  const gap = Math.min(canvasW, canvasH) * 0.03;
  const size = Math.min(
    (areaW - gap * (cols - 1)) / cols,
    ((areaH - gap * (rows - 1)) / rows) * frameAspect,
  ) * photoScale;
  const gridH = rows * (size / frameAspect) + (rows - 1) * gap;
  return Array.from({length: n}, (_, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    // 末行不满时居中
    const rowCount = r === rows - 1 ? n - r * cols : cols;
    const rowW = rowCount * size + (rowCount - 1) * gap;
    return {
      cx: -rowW / 2 + size / 2 + c * (size + gap) + (seeded(i, 1) - 0.5) * size * 0.12 * scatter,
      cy: -gridH / 2 + size / frameAspect / 2 + r * (size / frameAspect + gap) + (seeded(i, 2) - 0.5) * size * 0.1 * scatter,
      rot: (seeded(i, 3) - 0.5) * 2 * 7 * scatter,
      size,
    };
  });
};

interface PolaroidCardProps {
  video: VideoClip;
  slot: PolaroidSlot;
  startFrame: number;
  index: number;
  caption?: string;
  scatter: number;
}

const PolaroidCard: React.FC<PolaroidCardProps> = ({video, slot, startFrame, index, caption, scatter}) => {
  const frame = useCurrentFrame();
  const {width: canvasW} = useVideoConfig();
  // 甩入：从右下偏移 + 多带旋转 → spring 落位（damping 带一次过冲，像把照片拍在桌上）
  const prog = spring({
    frame: frame - startFrame,
    fps: FPS,
    config: SPRINGS.cardSettle,
    durationInFrames: Math.round(FPS * 1.1),
  });
  const entryRot = slot.rot + (seeded(index, 5) > 0.5 ? 1 : -1) * (10 + 6 * scatter);
  const x = slot.cx + slot.size * 1.6 * (1 - prog);
  const y = slot.cy + slot.size * 1.2 * (1 - prog);
  const rot = entryRot + (slot.rot - entryRot) * prog;
  const opacity = interpolate(frame - startFrame, [0, 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // 驻留微运动：入场完成后照片保持缓慢呼吸+漂移（phase 按照片错开，P2 质感）
  const u = canvasW / 1920;
  const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, index * 1.37);
  const drift = dwellDrift(frame, FPS, 4 * u, 3 * u, 9, index * 1.37);

  // 照片区 1:1 cover + 取景视口
  const fit = fitVideo(slot.size, slot.size, video.width, video.height, 'cover');
  const placed = applyViewport(slot.size, slot.size, fit, 'cover', video.viewport);
  const pad = Math.max(4, slot.size * 0.045);
  const frameW = slot.size + pad * 2;
  const frameH = slot.size + pad * 2 + slot.size * 0.22; // 底部小注白边
  const capSize = Math.max(10, slot.size * 0.085);

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: frameW,
        height: frameH,
        marginLeft: -frameW / 2,
        marginTop: -frameH / 2,
        transform: `translate(${x + drift.x}px, ${y + drift.y}px) rotate(${rot}deg) scale(${breathe})`,
        opacity,
        background: '#FFFFFF',
        borderRadius: Math.max(3, slot.size * 0.015),
        padding: pad,
        paddingBottom: 0,
        boxShadow: '0 14px 36px rgba(41, 37, 36, 0.28), 0 3px 10px rgba(41, 37, 36, 0.18)',
      }}
    >
      <div style={{width: slot.size, height: slot.size, overflow: 'hidden', background: '#EDE9E1'}}>
        {video.type === 'image' ? (
          <Img
            src={video.src}
            style={{
              width: placed.width,
              height: placed.height,
              transform: `translate(${placed.translateX}px, ${placed.translateY}px)`,
              objectFit: 'cover',
            }}
          />
        ) : (
          <ClipMedia
            src={video.src}
            mediaType="video"
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
        )}
      </div>
      {/* 底部小注区：手写感（斜体），无 caption 时留白（拍立得的呼吸感） */}
      <div
        style={{
          height: frameH - slot.size - pad * 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: `0 ${pad}px`,
        }}
      >
        {caption && (
          <span
            style={{
              fontSize: capSize,
              color: 'rgba(41, 37, 36, 0.75)',
              fontStyle: 'italic',
              fontFamily: VIDEO_DESIGN.bodyFont,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              letterSpacing: '0.02em',
            }}
          >
            {caption}
          </span>
        )}
      </div>
    </div>
  );
};

export const VlogPolaroid: React.FC<TemplateProps> = ({videos, text, segmentDuration, style, params, textAnim}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);
  const pace = Math.max(totalDurationFrames / (5 * FPS), 0.6);

  const p = makeParamReader(VLOG_POLAROID_PARAMS, params);
  const staggerSec = p('stagger');
  const photoScale = p('photoScale');
  const scatter = p('scatter');

  const clips = videos.slice(0, 8);
  const captions = (text.features ?? []).slice(0, 8);
  const slots = computeSlots(Math.max(clips.length, 1), canvasW, canvasH, photoScale, scatter);
  const firstHit = 4 * pace;

  // 无素材空态：照常渲染背景与提示（不 return null）
  if (clips.length === 0) {
    return (
      <AbsoluteFill style={{background: `linear-gradient(160deg, ${PAPER_TOP} 0%, ${PAPER_BOTTOM} 100%)`}}>
        <BackgroundEffectLayer />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.spacing.element,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: canvasW * 0.22,
              height: canvasW * 0.26,
              background: '#FFF',
              borderRadius: 8,
              boxShadow: '0 12px 30px rgba(41,37,36,0.25)',
              transform: 'rotate(-4deg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(41,37,36,0.35)',
              fontSize: tokens.fontSize.caption,
            }}
          >
            拍立得
          </div>
          <div style={{fontSize: tokens.fontSize.body, color: 'rgba(41,37,36,0.65)', fontFamily: VIDEO_DESIGN.bodyFont}}>
            上传照片/视频素材，堆进拍立得相框
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <AbsoluteFill style={{background: `linear-gradient(160deg, ${PAPER_TOP} 0%, ${PAPER_BOTTOM} 100%)`}} />
      )}
      <BackgroundEffectLayer />

      {/* 可选小标题：左上角（贴纸感，斜体小字），有标题才渲染 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.07,
            top: canvasH * 0.06,
            opacity: fadeIn(frame, 2, 12 * pace),
          }}
        >
          <AnimatedText
            text={text.title}
            preset={textAnim ?? 'fadeIn'}
            startFrame={Math.round(2 * pace)}
            duration={Math.round(12 * pace)}
            style={{
              fontSize: style?.title?.fontSize ?? tokens.fontSize.subtitle * 0.9,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? INK,
              fontStyle: 'italic',
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.02em',
              ...textStrokeCss(style?.title),
            }}
          />
        </div>
      )}

      {clips.map((video, i) => (
        <PolaroidCard
          key={`${video.src}-${i}`}
          video={video}
          slot={slots[i]}
          startFrame={Math.round(firstHit + i * staggerSec * FPS)}
          index={i}
          caption={captions[i]}
          scatter={scatter}
        />
      ))}
    </AbsoluteFill>
  );
};

export default VlogPolaroid;
