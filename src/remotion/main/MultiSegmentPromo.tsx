/**
 * MultiSegmentPromo - 多段故事板合成器
 *
 * 将所有片段按时间顺序排列，每个片段使用各自的模板渲染。
 * 支持片段间转场：交叉淡化/滑动/擦除/圆形展开/推拉/缩放/翻转/模糊/闪白 + 运镜（镜头推进/拉远/甩镜）
 * + 虚拟相机（横摇追拍/轨道环绕）+ 遮挡物（cardSweep 卡片扫场/shapeBloom 形状绽放，合成器注入品牌色过场元素）。
 * 转场数学（样式/重叠帧数/焦点推导）在 shared/transition-style.ts，与主进程帧范围计算共用。
 *
 * 时间模型（关键，B3 骑跨版）:
 * - 每段内容精确占 [contentStart, contentEnd]（beatGrid 切片/旁白/字幕/镜头窗都锚内容边界）。
 * - 转场窗口骑跨切点：[切点 − peak×W, 切点 + (1−peak)×W)，高潮帧 = 切点 = 拍点（炸点压拍）；
 *   窗口数学在 shared/transition-style.ts computeTransitionWindows（含双侧钳制防相邻窗口重叠）。
 *   crossfade（peak=0）不骑跨 = 窗口挂在切点后（旧模型，零回归）；硬切无窗口。
 * - 转场由「前一段的 transition」驱动：前段出场（out）与后段入场（in）在同一窗口、同一进度 q 同步进行；
 *   后段挂载提前 headPad 帧（seqFrom 前移），头垫期间模板时钟冻结在第 0 帧（入场动画从拍点起跑）。
 * - 运镜转场（zoomIn/zoomOut）in/out 两侧围绕同一焦点缩放（焦点 = 下一片段画面上的归一化点）。
 * - 末段固定 fadeToBlack（尾部 0.5s）。
 *
 * 用法（在 Remotion Player 中）:
 * <MultiSegmentPromo segments={segments} orientation="landscape" />
 */

import {AbsoluteFill, Sequence, Audio, Freeze, useCurrentFrame} from 'remotion';
import {RevealSlide} from '../templates/RevealSlide';
import {StackCards} from '../templates/StackCards';
import {CinematicPan} from '../templates/CinematicPan';
import {SplitShowcase} from '../templates/SplitShowcase';
import {MinimalFloat} from '../templates/MinimalFloat';
import {KenBurns} from '../templates/KenBurns';
import {CursorFollow} from '../templates/CursorFollow';
import {PanelFlyout} from '../templates/PanelFlyout';
import {ChatConversation} from '../templates/ChatConversation';
import {WhiteboardCanvas} from '../templates/WhiteboardCanvas';
import {DocPanel} from '../templates/DocPanel';
import {ScreenDemo} from '../templates/ScreenDemo';
import {TutorialStep} from '../templates/TutorialStep';
import {Montage} from '../templates/Montage';
import {ProductFloat} from '../templates/ProductFloat';
import {AiPromptCard} from '../templates/AiPromptCard';
import {DeviceShowcase} from '../templates/DeviceShowcase';
import {DeviceShowcase3D} from '../templates/DeviceShowcase3D';
import {ModelTurntable} from '../templates/ModelTurntable';
import {Hero3DTitle} from '../templates/Hero3DTitle';
import {GridMosaic} from '../templates/GridMosaic';
import {VerticalScroll} from '../templates/VerticalScroll';
import {SplitCompare} from '../templates/SplitCompare';
import {NeonTech} from '../templates/NeonTech';
import {TextSlide} from '../templates/TextSlide';
import {BrandIntro} from '../templates/BrandIntro';
import {OutroCTA} from '../templates/OutroCTA';
import {VideoCut} from '../templates/VideoCut';
import {FullbleedTitle} from '../templates/FullbleedTitle';
import {FullbleedFeature} from '../templates/FullbleedFeature';
import {FullbleedCTA} from '../templates/FullbleedCTA';
import {ScreenRecord} from '../templates/ScreenRecord';
import {LowerThird} from '../templates/LowerThird';
import {StatCounter} from '../templates/StatCounter';
import {Testimonial} from '../templates/Testimonial';
import {FeatureList} from '../templates/FeatureList';
import {KineticType} from '../templates/KineticType';
import {ChapterProgress} from '../templates/ChapterProgress';
import {TimelineRoadmap} from '../templates/TimelineRoadmap';
import {PricingTiers} from '../templates/PricingTiers';
import {PriceAnchorPro} from '../templates/PriceAnchorPro';
import {ComingSoon} from '../templates/ComingSoon';
import {LogoCloud} from '../templates/LogoCloud';
import {UICallout} from '../templates/UICallout';
import {BeforeAfter} from '../templates/BeforeAfter';
import {DiffReveal} from '../templates/DiffReveal';
import {CodeTerminal} from '../templates/CodeTerminal';
import {GlobePoints} from '../templates/GlobePoints';
import {CardConverge} from '../templates/CardConverge';
import {VlogStamp} from '../templates/VlogStamp';
import {VlogPolaroid} from '../templates/VlogPolaroid';
import {TalkingPoint} from '../templates/TalkingPoint';
import {StepCard} from '../templates/StepCard';
import {RowEmbed} from '../templates/RowEmbed';
import {GrowthBars3D} from '../templates/GrowthBars3D';
import {TrendLine3D} from '../templates/TrendLine3D';
import {CameraJourney3D} from '../templates/CameraJourney3D';
import {GalleryHall3D} from '../templates/GalleryHall3D';
import {OrbitCarousel3D} from '../templates/OrbitCarousel3D';
import {TimeTunnel3D} from '../templates/TimeTunnel3D';
import {CityScape3D} from '../templates/CityScape3D';
import {SpiralAtrium3D} from '../templates/SpiralAtrium3D';
import {Starfield3D} from '../templates/Starfield3D';
import {CustomTemplateRender} from '../templates/CustomTemplateRender';
import {GeneratedTemplateRender} from '../templates/GeneratedTemplateRender';
import {MultiSegmentProps, TransitionType, TransitionAnchor, DEFAULT_BEAT_PULSE, DEFAULT_CURSOR_ENABLED} from '../../shared/types';
import {bgmStartAtSec, bgmTrimStartSec, bgmLoopSpanSec, bgmTimelineBeats, bgmVolumeAt} from '../../shared/bgm-track';
import {sliceBeatGrid, mergeUserBeats} from '../../shared/beat-grid';
import {beatPulseEnvelope, PULSE_SCALE_AMOUNT, PULSE_FLASH_AMOUNT} from '../../shared/beat-pulse';
import {planSfxPlacements, planUiSfxPlacements, sfxClipVariant, clampSfxClipVolume, SFX_KIND_GAIN, type SfxSegmentTiming} from '../../shared/sfx-plan';
import {planBgmLoop, bgmLoopEnvelopeAt} from '../../shared/bgm-loop';
import {SfxKind} from '../../shared/types';
import {
  computeTransitionWindows,
  getOutroFadeFrames,
  resolveFocus,
  transitionStyle,
  type TransitionStyle,
} from '../../shared/transition-style';
import {
  evalOccluderProgress,
  isOccluderTransition,
  occluderState,
  OCCLUDER_CARD_FRAC,
  type OccluderState,
} from '../../shared/transition-occluder';
import {isDataDrivenTemplateId, isRawOutputTemplate, isGeneratedTemplateId, getTemplateById} from '../../shared/template-registry';
import {resolveZoomTransitionOpts} from '../../shared/transition-anchor';
import {FPS} from '../config/resolutions';
import {setBrandTheme, getBrandPalette} from '../config/designTokens';
import {getColorLook, autoMatchFactor, medianTargetLuma, colorMatchFilter} from '../../shared/color-grade';
import {ColorMatchContext} from '../layers/colorMatch';
import {StabilizationContext, type StabEntry} from '../layers/stabilization';
import {GroundTrackingContext, type GroundOverlayEntry} from '../layers/groundTracking';
import {VideoEffectContext, CursorContext} from '../layers/videoEffects';
import {BackgroundEffectContext} from '../layers/backgroundEffects';
import {Watermark} from '../layers/Watermark';
import {TextureLayer} from '../layers/TextureLayer';
import {LogoLayer} from '../layers/LogoLayer';
import {CaptionLayer} from '../layers/CaptionLayer';
import {FinePrintLayer} from '../layers/FinePrintLayer';
import {BgmCreditLayer} from '../layers/BgmCreditLayer';
import {isAttributionRequired} from '../../shared/bgm-credits';
import {FloatingCardLayer} from '../layers/FloatingCardLayer';
import {applyShotPlanToSegments} from '../../shared/shot-engine';

// 末段淡出到黑的帧数（全片收尾固定 0.5s）
const OUTRO_FADE_FRAMES = getOutroFadeFrames(FPS);

// 模板组件映射 - ★ 单一来源：由 root.tsx 和 MultiSegmentPromo 共同导入 ★
export const TEMPLATE_MAP: Record<string, React.ComponentType<any>> = {
  RevealSlide,
  StackCards,
  CinematicPan,
  SplitShowcase,
  MinimalFloat,
  KenBurns,
  CursorFollow,
  PanelFlyout,
  ChatConversation,
  WhiteboardCanvas,
  DocPanel,
  ScreenDemo,
  TutorialStep,
  Montage,
  ProductFloat,
  AiPromptCard,
  DeviceShowcase,
  DeviceShowcase3D,
  ModelTurntable,
  Hero3DTitle,
  GridMosaic,
  VerticalScroll,
  SplitCompare,
  NeonTech,
  TextSlide,
  BrandIntro,
  OutroCTA,
  VideoCut,
  FullbleedTitle,
  FullbleedFeature,
  FullbleedCTA,
  ScreenRecord,
  LowerThird,
  StatCounter,
  Testimonial,
  FeatureList,
  KineticType,
  ChapterProgress,
  TimelineRoadmap,
  PricingTiers,
  PriceAnchorPro,
  ComingSoon,
  LogoCloud,
  UICallout,
  BeforeAfter,
  DiffReveal,
  CodeTerminal,
  GlobePoints,
  CardConverge,
  VlogStamp,
  VlogPolaroid,
  TalkingPoint,
  StepCard,
  RowEmbed,
  GrowthBars3D,
  TrendLine3D,
  CameraJourney3D,
  GalleryHall3D,
  OrbitCarousel3D,
  TimeTunnel3D,
  CityScape3D,
  SpiralAtrium3D,
  Starfield3D,
};

export const MultiSegmentPromo: React.FC<MultiSegmentProps> = ({
  segments: inputSegments,
  editPlan,
  orientation,
  customTemplates = [],
  generatedTemplates = [],
  bgm = null,
  sfx = null,
  sfxSources,
  texture = 'clean',
  beatPulse = DEFAULT_BEAT_PULSE,
  cursor = DEFAULT_CURSOR_ENABLED,
  logo = null,
  captionStyle,
  finePrint = null,
  colorGrade = null,
  brandColor = null,
  fontMood,
  licensed = true,  // 缺省视为已授权（不加水印）；渲染门禁会显式覆写
  previewLiteCut = false,  // 仅整片预览传 true：转场窗口按硬切呈现（出段不渲染，消双解码卡顿）；导出路径不传
}) => {
  const frame = useCurrentFrame();

  // Stale plans are retained for inspection but must not drive rendering
  // after a segment-level edit changes the timeline contract.
  const activeEditPlan = editPlan?.stale ? undefined : editPlan;
  const beatIds = activeEditPlan?.beats
    ? activeEditPlan.beats.reduce<string[]>((ids, beat) => {
        if (Number.isInteger(beat.index) && beat.index >= 0) ids[beat.index] = beat.id;
        return ids;
      }, [])
    : undefined;
  // Keep the renderer's Segment contract as the single template boundary;
  // source-window selection itself lives in shared/shot-engine.
  const segments = activeEditPlan?.shots?.length
    ? applyShotPlanToSegments(inputSegments, activeEditPlan.shots, {}, beatIds)
    : inputSegments;

  // ====== 品牌主题（项目级）======
  // 每次渲染先把工程的品牌色/字体氛围写进模块主题，再渲染子树；
  // 模板经 VIDEO_DESIGN（getter）取到品牌 accent 与氛围字体栈。
  setBrandTheme({accent: brandColor, fontMood});
  // 当前品牌色板（T2 遮挡物转场的卡片/几何形取色：accent 原色 + accentDeep/accentMuted 渐变端）
  const palette = getBrandPalette();

  // ====== 色彩统一（项目级，见 shared/color-grade.ts）======
  // 1) 色调预设：内容层整体套风格 filter（字幕/Logo/水印在叠加层之上不受影响）；
  // 2) 自动曝光匹配：以全片素材亮度中位数为基准，逐素材算温和的 brightness 校正，
  //    经 Context 下发给 ClipMedia（所有媒体的唯一渲染出口）。
  const look = getColorLook(colorGrade?.look);
  const colorFilters = new Map<string, string>();
  if (colorGrade?.autoMatch) {
    const lumas = segments.flatMap((seg) =>
      (seg.videos ?? [])
        .map((v) => v.colorStats?.luma)
        .filter((v): v is number => typeof v === 'number'),
    );
    const target = medianTargetLuma(lumas);
    if (target !== null) {
      for (const seg of segments) {
        for (const v of seg.videos ?? []) {
          if (!v.src || typeof v.colorStats?.luma !== 'number') continue;
          const f = colorMatchFilter(autoMatchFactor(v.colorStats.luma, target));
          if (f) colorFilters.set(v.src, f);
        }
      }
    }
  }

  // ====== 跟踪稳定（素材级，见 layers/stabilization.ts）======
  // 收录「已开启稳定且内存态校正表已填充」的视频素材：src → {corrections, zoom, 画幅}，
  // 经 Context 下发给 ClipMedia 按帧套 transform。内存态（stabCorrections 等）在工程
  // 加载/稳定分析时填充（保存工程时剥离），缺失即不收录——零数据零开销零回归。
  const stabEntries = new Map<string, StabEntry>();
  for (const seg of segments) {
    for (const v of seg.videos ?? []) {
      if (!v.src || v.type !== 'video') continue;
      if (!v.stabilization?.enabled || !v.stabCorrections?.length) continue;
      stabEntries.set(v.src, {
        corrections: v.stabCorrections,
        zoom: v.stabZoom ?? 1,
        videoW: v.width,
        videoH: v.height,
      });
    }
  }

  // ====== 3D 地面追踪（素材级轨迹 + 段级元素配对，见 layers/groundTracking.ts）======
  // 同一素材被多个段使用时各段可有不同元素集：按 (src, 段) 配对 → src 取首个带
  // 元素的段（v1 语义：素材一份轨迹，元素随首个消费段；多数场景一段一素材）。
  const groundEntries = new Map<string, GroundOverlayEntry>();
  for (const seg of segments) {
    const elements = (seg.groundElements ?? []).filter((e) => e && e.id);
    if (elements.length === 0) continue;
    for (const v of seg.videos ?? []) {
      if (!v.src || v.type !== 'video') continue;
      if (!v.groundTrack?.enabled || !v.groundData?.anchors?.length || !v.groundData?.samples?.length) continue;
      if (groundEntries.has(v.src)) continue;
      groundEntries.set(v.src, {
        track: {anchors: v.groundData.anchors, samples: v.groundData.samples},
        elements,
        videoW: v.width,
        videoH: v.height,
      });
      break; // 每段只挂它的首个可追踪素材
    }
  }

  // 查找自定义模板定义 / AI 生成模板定义
  const getCustomDef = (id: string) => customTemplates.find((t) => t.id === id);
  const getGenDef = (id: string) => generatedTemplates.find((t) => t.id === id);

  // 模板可渲染性：内置模板查 TEMPLATE_MAP，数据驱动模板（自定义/市场）查 customTemplates，
  // AI 生成模板（gen- 前缀）查 generatedTemplates。
  // 引用已删除/未知模板的片段按 0 时长从时间线剔除（不再留整段黑洞；下方渲染 map 中仍 return null）。
  const isSegmentRenderable = (seg: (typeof segments)[number]): boolean =>
    !!TEMPLATE_MAP[seg.templateId] ||
    (isDataDrivenTemplateId(seg.templateId) && !!getCustomDef(seg.templateId)) ||
    (isGeneratedTemplateId(seg.templateId) && !!getGenDef(seg.templateId));
  const contentFramesArr = segments.map((seg) =>
    isSegmentRenderable(seg) ? Math.round((seg.duration || 8) * FPS) : 0,
  );

  // 实际内容总帧数（不含尾部过渡），用于背景音乐淡出定位
  const totalContentFrames = contentFramesArr.reduce((sum, n) => sum + n, 0);
  // 末段为「原样输出」模板（屏幕录制）时豁免收尾淡黑：原始录像成片结尾也保持原始画面
  const outroFadeFrames = isRawOutputTemplate(segments[segments.length - 1]?.templateId) ? 0 : OUTRO_FADE_FRAMES;
  const bgmEndFrame = totalContentFrames + outroFadeFrames;

  // 每片段时间位置（B3 骑跨）：内容精确占 [contentStart, contentEnd]；转场窗口由
  // computeTransitionWindows 规划（高潮帧 = 切点），后段挂载提前 headPad 帧、前段尾部多挂 tail 帧。
  const transitionWindows = computeTransitionWindows(segments, contentFramesArr, FPS);
  const segmentTimings = segments.map((seg, i) => {
    const contentStartFrame = contentFramesArr.slice(0, i).reduce((sum, n) => sum + n, 0);
    const contentDuration = contentFramesArr[i];
    const isLast = i === segments.length - 1;
    const inW = i > 0 ? transitionWindows[i - 1] : null; // 前一边界窗口（驱动本段入场）
    const outW = transitionWindows[i]; // 本段驱动的窗口（驱动本段出场）
    // 末段尾部扩展 = 淡黑帧（原样输出模板豁免）；无模板片段窗口为 0（直接从时间线消失）
    const tail = contentDuration === 0 ? 0 : isLast ? outroFadeFrames : outW.tail;
    const headPad = contentDuration === 0 ? 0 : inW ? inW.headPad : 0;
    return {
      contentStartFrame,
      contentDuration,
      contentEndFrame: contentStartFrame + contentDuration,
      // 入场窗口（前一窗口全范围，q 0→1 骑跨切点）
      inWindowStart: contentStartFrame - headPad,
      inWindowFrames: inW ? inW.frames : 0,
      // 出场窗口（本段窗口全范围）
      outWindowStart: contentStartFrame + contentDuration - outW.headPad,
      outWindowFrames: outW.frames,
      seqFrom: contentStartFrame - headPad,
      seqDuration: headPad + contentDuration + tail,
      outOverlap: tail, // 尾长（sfx-plan 等消费方沿用旧字段名）
      headPad,
      isLast,
    };
  });

  // ====== 音效（SFX）自动放置 ======
  // 规则在 shared/sfx-plan.ts：转场中点按转场类型放匹配音效（swish/sweep/drop/whoosh/impact）、
  // 节拍落点 impact（节拍由 BGM 波形实时检测）、片头 riser。
  // SFX 独立音量、不受旁白 ducking 影响；无源类别（sfxSources 缺货）自动跳过/降级。
  const sfxEnabled = !!sfx?.enabled && !!sfxSources;
  // 节拍来源：音频分析产出的 bgm.beats（帧级网格）；旧工程无 beats 时回退峰值检测
  // 时间轴坐标的节拍（P2.5 v1.5：BGM 起播点/截取映射后的拍——看到的拍=听到的拍；
  // 缺省字段时与 getBgmBeats 原样一致）
  const bgmBeats = bgmTimelineBeats(bgm);
  const sfxBeats = sfxEnabled && sfx?.beatImpact ? bgmBeats : [];
  const sfxPlacements = sfxEnabled
    ? planSfxPlacements(
        segmentTimings.map(
          (t, i): SfxSegmentTiming => ({
            contentStartFrame: t.contentStartFrame,
            contentEndFrame: t.contentEndFrame,
            outOverlap: t.outOverlap,
            isLast: t.isLast,
            transition: segments[i].transition,
            sfxOverride: segments[i].transitionSfx,
          }),
        ),
        sfxBeats,
        FPS,
        sfx!,
        Object.fromEntries(
          Object.entries(sfxSources ?? {}).map(([k, arr]) => [k, arr.length]),
        ) as Record<SfxKind, number>,
      ).filter((p) => !!sfxSources?.[p.kind][p.variant])
    : [];
  // UI 元素音效（P6）：对话气泡 pop/打字轻点/勾选 ding——时间线数学与模板同源
  // （shared chat-conversation/prompt-drag/doc-panel 纯函数），看到的入场=听到的提示。
  // 手放 clips 不受 uiCues 影响（用户显式摆放的永远保留）。
  const sfxUiPlacements = sfxEnabled
    ? planUiSfxPlacements(
        segments,
        segmentTimings.map((t) => t.contentStartFrame),
        FPS,
        sfx!,
        Object.fromEntries(
          Object.entries(sfxSources ?? {}).map(([k, arr]) => [k, arr.length]),
        ) as Record<SfxKind, number>,
      ).filter((p) => !!sfxSources?.[p.kind][p.variant])
    : [];
  const sfxAllPlacements = [...sfxPlacements, ...sfxUiPlacements];
  // 各类音效的相对响度：SFX_KIND_GAIN（shared/sfx-plan，时间轴「试听」与渲染混音同源）

  // 手放音效（时间轴「+ 音效」，v4）：与自动放置同轨混音、独立音量，可多轨叠加；
  // 变体按 clip id 确定性哈希（增删其它 clip 不改变本 clip 选中的变体，导出可复现）
  const sfxClipPlacements = sfxEnabled
    ? (sfx?.clips ?? [])
        .map((c) => {
          const srcs = sfxSources?.[c.kind] ?? [];
          if (srcs.length === 0) return null;
          return {
            id: c.id,
            frame: Math.round(c.atSec * FPS),
            src: srcs[sfxClipVariant(c.id, srcs.length)],
            volume: (sfx.volume ?? 0.8) * clampSfxClipVolume(c.volume ?? 1) * SFX_KIND_GAIN[c.kind],
          };
        })
        .filter((p): p is {id: string; frame: number; src: string; volume: number} => p !== null)
    : [];

  // ====== 节拍脉冲（画面随鼓点微缩放 + 光效闪动）======
  // 与 SFX 的节拍检测相互独立：音效关闭时画面脉冲仍可生效；无 BGM / 无节拍时不启用。
  // 包络带重拍加权和快拍衰减（beatPulseEnvelope），不会逐拍频闪。
  const pulse = beatPulse && bgmBeats.length > 0 ? beatPulseEnvelope(bgmBeats, frame, FPS) : 0;

  // ====== BGM 自动避让旁白（ducking）======
  // 旁白时间窗（绝对帧）：每段从其起点 + 段内偏移起、持续 narration.duration。窗口外不压低。
  const narrationWindows = segments
    .map((seg, i) => {
      const n = seg.narration;
      if (!n || !n.src || !n.duration || n.duration <= 0) return null;
      const start = segmentTimings[i].contentStartFrame + Math.round((n.offsetSec ?? 0) * FPS);
      return {start, end: start + Math.round(n.duration * FPS)};
    })
    .filter((w): w is {start: number; end: number} => w !== null);

  const duck = bgm?.ducking;
  const duckAmount = duck?.enabled ? Math.max(0.1, Math.min(1, duck.amount ?? 0.25)) : 1;
  const attackF = Math.round(0.3 * FPS); // 0.3s 平滑过渡，避免咔哒声
  /** 给定帧的 BGM 音量倍率：旁白期间压低到 duckAmount，窗口前后 attack/release 平滑 */
  const duckMultiplierAt = (f: number): number => {
    if (!duck?.enabled || narrationWindows.length === 0) return 1;
    let level = 0; // 0 = 不压低，1 = 完全压低
    for (const w of narrationWindows) {
      if (f >= w.start && f < w.end) {
        const sinceStart = f - w.start;
        level = Math.max(level, sinceStart < attackF ? sinceStart / attackF : 1);
      } else if (f >= w.start - attackF && f < w.start) {
        level = Math.max(level, (f - (w.start - attackF)) / attackF);
      } else if (f >= w.end && f < w.end + attackF) {
        level = Math.max(level, 1 - (f - w.end) / attackF);
      }
    }
    return 1 - level * (1 - duckAmount);
  };

  // 当前帧的方向拖影量：扫描各段转场窗口（同一时刻至多一个转场激活）。
  // 只为 SVG 滤镜定义服务（JSX 中 <svg> 先于片段 map 求值）；与下方 map 内的
  // effect 计算同参数调用 transitionStyle，数学一致。
  // T3 转场锚点（形状接形状）：zoomIn/zoomOut 入段从后段锚点缩出、zoomIn 出段俯冲前段锚点
  // （zoomOut 出段是拉远不俯冲）；优先级显式 transitionParams > 锚点拟合 > 旧默认。
  const anchorOf = (templateId: string, type: TransitionType): TransitionAnchor | undefined =>
    (type === 'zoomIn' || type === 'zoomOut') ? getTemplateById(templateId)?.transitionAnchor : undefined;
  let motionBlurActive: {x: number; y: number} | null = null;
  for (let i = 0; i < segments.length; i++) {
    const t = segmentTimings[i];
    const prev = i > 0 ? segments[i - 1] : null;
    let style: TransitionStyle = {};
    // 轻量硬切（仅预览）：转场窗口不产生转场样式/拖影，与下方渲染 map 的跳过逻辑一致
    if (previewLiteCut) {
      style = {};
    } else if (prev && t.inWindowFrames > 0 && frame >= t.inWindowStart && frame < t.inWindowStart + t.inWindowFrames) {
      const zIn = resolveZoomTransitionOpts(prev.transitionParams, anchorOf(segments[i].templateId, prev.transition), segments[i].layout, segments[i].layout);
      style = transitionStyle(prev.transition, 'in', (frame - t.inWindowStart) / t.inWindowFrames, {
        ...zIn,
        curve: prev.transitionParams?.curve,
        direction: prev.transitionParams?.direction,
      });
    } else if (!t.isLast && t.outWindowFrames > 0 && frame >= t.outWindowStart && frame < t.outWindowStart + t.outWindowFrames) {
      const zOut = resolveZoomTransitionOpts(
        segments[i].transitionParams,
        segments[i].transition === 'zoomIn' ? anchorOf(segments[i].templateId, segments[i].transition) : undefined,
        segments[i].layout,
        segments[i + 1]?.layout,
      );
      style = transitionStyle(segments[i].transition, 'out', (frame - t.outWindowStart) / t.outWindowFrames, {
        ...zOut,
        curve: segments[i].transitionParams?.curve,
        direction: segments[i].transitionParams?.direction,
      });
    }
    if (style.motionBlur && (style.motionBlur.x > 0.05 || style.motionBlur.y > 0.05)) {
      motionBlurActive = style.motionBlur;
    }
  }

  // ====== BGM 循环平铺规划 ======
  // BGM 短于成片时按交叉淡化接缝平铺 N 份（消灭后半段无声）；不短于成片时
  // copies=1、接缝淡化 0，与旧的单 <Audio> 行为逐帧一致。包络（淡入/淡出/ducking）
  // 按绝对帧算，每份 Sequence 内本地帧换算绝对帧。
  const bgmLoopPlan =
    bgm && bgm.src
      ? planBgmLoop({
          spanSec: bgmLoopSpanSec(bgm),
          startAtSec: bgmStartAtSec(bgm),
          videoTotalSec: bgmEndFrame / FPS,
          fadeOutSec: bgm.fadeOut,
          fps: FPS,
        })
      : null;

  return (
    <AbsoluteFill style={{background: '#000'}}>
      {/* 方向性运动模糊滤镜定义：whip/push/slide 转场窗口内逐帧更新 stdDeviation，
          各段 wrapper 通过 filter: url(#vt-motion-blur) 引用（无转场拖影时不渲染，零开销） */}
      {motionBlurActive && (
        <svg width={0} height={0} style={{position: 'absolute', pointerEvents: 'none'}} aria-hidden="true">
          <filter
            id="vt-motion-blur"
            x="-10%"
            y="-10%"
            width="120%"
            height="120%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation={`${motionBlurActive.x} ${motionBlurActive.y}`} />
          </filter>
        </svg>
      )}
      {/* 美化光标项目级开关：Video3D / CustomTemplateRender 的 CursorOverlay 消费 */}
      <CursorContext.Provider value={cursor}>
      {/* 背景音乐：从起播点铺到片尾，按淡入/淡出包络调音量；媒体只用 [trimStart, trimEnd) 窗，
          短于剩余时长时按循环规划平铺多份（接缝交叉淡化防咔哒声），旁白响起时自动压低。
          缺省 startAt=0 / 窗=全长时与旧的单 Audio 行为逐帧一致（P2.5 v1.5）。 */}
      {bgm && bgm.src && bgmLoopPlan && bgmLoopPlan.startFrames.map((startF, k) => {
        const isLastCopy = k === bgmLoopPlan.copies - 1;
        const bgmStartF = Math.round(bgmStartAtSec(bgm) * FPS); // 淡入锚定在 BGM 起播点
        return (
          <Sequence
            key={`bgm-${k}`}
            from={startF}
            durationInFrames={isLastCopy ? Math.max(1, bgmEndFrame - startF) : bgmLoopPlan.copyFrames}
          >
            <Audio
              src={bgm.src}
              startFrom={Math.round(bgmTrimStartSec(bgm) * FPS)}
              volume={(f) => {
                const af = startF + f; // 本地帧 → 绝对帧（包络按绝对时间轴算）
                const fadeInF = Math.round((bgm.fadeIn || 0) * FPS);
                const fadeOutF = Math.round(bgmLoopPlan.effectiveFadeOutSec * FPS);
                const fadeOutStart = bgmEndFrame - fadeOutF;
                let v = bgm.volume ?? 1;
                if (fadeInF > 0 && af >= bgmStartF && af < bgmStartF + fadeInF) v *= (af - bgmStartF) / fadeInF;
                if (fadeOutF > 0 && af > fadeOutStart) v *= Math.max(0, (bgmEndFrame - af) / fadeOutF);
                v *= duckMultiplierAt(af); // 旁白响起时自动压低 BGM
                v *= bgmVolumeAt(bgm.volumeKeys, (af - bgmStartF) / FPS); // 音量包络（时间轴音量线，相对起播点）
                v *= bgmLoopEnvelopeAt(bgmLoopPlan, k, f); // 循环接缝交叉淡化
                return v;
              }}
            />
          </Sequence>
        );
      })}
      {/* 音效轨：转场音效（类别随转场类型）/ 节拍 impact / 片头 riser，按放置表从各自帧起播 */}
      {sfxAllPlacements.map((p, idx) => (
        <Sequence key={`sfx-${idx}`} from={p.frame}>
          <Audio src={sfxSources![p.kind][p.variant]} volume={(sfx?.volume ?? 0.8) * SFX_KIND_GAIN[p.kind]} />
        </Sequence>
      ))}
      {/* 手放音效（时间轴音效轨「+ 音效」）：任意位置、多个时间重叠自动多轨混音叠加 */}
      {sfxClipPlacements.map((p) => (
        <Sequence key={`sfxclip-${p.id}`} from={p.frame}>
          <Audio src={p.src} volume={p.volume} />
        </Sequence>
      ))}
      {/* 旁白：每段从其起点 + 段内偏移起播（放顶层而非段 Sequence 内，避免被段时长截断；可重叠到下段） */}
      {segments.map((segment, i) => {
        const n = segment.narration;
        if (!n || !n.src) return null;
        const startFrame = segmentTimings[i].contentStartFrame + Math.round((n.offsetSec ?? 0) * FPS);
        return (
          <Sequence key={`narr-${segment.id}`} from={startFrame}>
            <Audio src={n.src} volume={n.volume ?? 1} />
          </Sequence>
        );
      })}
      {/* 片段内容层：鼓点脉冲时整体微缩放（Logo/字幕/质感层保持稳定，不随之动）；
          色调预设的 filter 套在本层（内容整体风格化，顶层字幕/Logo 不被染色） */}
      <ColorMatchContext.Provider value={{filters: colorFilters}}>
      <StabilizationContext.Provider value={{entries: stabEntries}}>
      <GroundTrackingContext.Provider value={groundEntries}>
      <AbsoluteFill
        style={{
          transform: pulse > 0 ? `scale(${1 + pulse * PULSE_SCALE_AMOUNT})` : undefined,
          transformOrigin: '50% 50%',
          filter: look.filter || undefined,
        }}
      >
      {segments.map((segment, i) => {
        const t = segmentTimings[i];
        const Template = TEMPLATE_MAP[segment.templateId];
        const customDef = isDataDrivenTemplateId(segment.templateId) ? getCustomDef(segment.templateId) : undefined;
        const genDef = isGeneratedTemplateId(segment.templateId) ? getGenDef(segment.templateId) : undefined;

        if (!Template && !customDef && !genDef) return null;

        // 轻量硬切（仅预览）：前段渲到拍点（内容结束）即隐藏、后段头垫期间不挂载——
        // 同一时刻只有一段在解码（消双解码卡顿），画面呈现为在拍点硬切。时间轴/总时长不变，
        // 导出路径不传 previewLiteCut，成片转场不受影响。
        if (previewLiteCut && t.headPad > 0 && frame < t.contentStartFrame) {
          return null;
        }
        if (previewLiteCut && !t.isLast && t.outOverlap > 0 && frame >= t.contentEndFrame && frame < t.contentEndFrame + t.outOverlap) {
          return null;
        }

        // 入场（i>0）：由前一段的 transition 驱动，窗口骑跨切点（高潮帧 = 切点 = 拍点）。
        // 运镜焦点在「下一片段」= 本段画面上，由前段 transitionParams + 本段 layout 解析。
        const prev = i > 0 ? segments[i - 1] : null;
        const entranceType: TransitionType = prev ? prev.transition : 'none';
        const inL = t.inWindowFrames;
        let effect: TransitionStyle = {};
        let flashOpacity = 0;
        let occluder: OccluderState | null = null;
        if (prev && inL > 0 && frame >= t.inWindowStart && frame < t.inWindowStart + inL) {
          const q = (frame - t.inWindowStart) / inL;
          if (previewLiteCut) {
            // 轻量硬切：入段不套转场样式，全程满不透明（与硬切视觉一致）
          } else {
            const zIn = resolveZoomTransitionOpts(prev.transitionParams, anchorOf(segment.templateId, entranceType), segment.layout, segment.layout);
            effect = transitionStyle(entranceType, 'in', q, {
              ...zIn,
              curve: prev.transitionParams?.curve,
              direction: prev.transitionParams?.direction,
            });
            if (entranceType === 'flash') {
              flashOpacity = q < 0.25 ? 1 : Math.max(0, 1 - (q - 0.25) / 0.75);
            }
            // 遮挡物转场（T2 cardSweep/shapeBloom）：几何状态供下方覆盖层渲染；
            // 前后段可见性切换已在 transitionStyle 内按覆盖度完成
            if (isOccluderTransition(entranceType)) {
              occluder = occluderState(entranceType, evalOccluderProgress(q, prev.transitionParams?.curve), {
                focus: resolveFocus(prev.transitionParams, segment.layout),
                direction: prev.transitionParams?.direction,
              });
            }
          }
        }

        // 出场（i<last）：由本段 transition 驱动，窗口骑跨切点（提前 headPad 帧开始）；焦点在下一片段画面上
        if (!previewLiteCut && !t.isLast && t.outWindowFrames > 0 && frame >= t.outWindowStart && frame < t.outWindowStart + t.outWindowFrames) {
          const q = (frame - t.outWindowStart) / t.outWindowFrames;
          const zOut = resolveZoomTransitionOpts(
            segment.transitionParams,
            segment.transition === 'zoomIn' ? anchorOf(segment.templateId, segment.transition) : undefined,
            segment.layout,
            segments[i + 1]?.layout,
          );
          effect = transitionStyle(segment.transition, 'out', q, {
            ...zOut,
            curve: segment.transitionParams?.curve,
            direction: segment.transitionParams?.direction,
          });
        }
        // 末段：淡黑
        if (t.isLast && frame >= t.contentEndFrame) {
          const q = Math.min(1, (frame - t.contentEndFrame) / OUTRO_FADE_FRAMES);
          effect = {opacity: 1 - q};
        }

        // 片尾退场预设 fade：内容末尾 0.4s 整帧渐隐（叠加在转场/淡黑效果之上）
        if (segment.exitStyle === 'fade' && frame < t.contentEndFrame) {
          const fadeFrames = Math.min(12, Math.max(1, Math.floor(t.contentDuration / 4)));
          if (frame >= t.contentEndFrame - fadeFrames) {
            const q = (frame - (t.contentEndFrame - fadeFrames)) / fadeFrames;
            effect = {...effect, opacity: (effect.opacity ?? 1) * (1 - q)};
          }
        }

        // 方向性运动模糊（whip/push/slide）：由共享转场数学产出拖影量，
        // 这里渲染成逐帧更新的 SVG feGaussianBlur(x y) 挂到该段 wrapper 上
        // （CSS blur() 各向同性做不了方向拖影；stdDeviation 每帧随 effect 变化，确定性渲染）。
        const motionBlur = effect.motionBlur;
        const wrapperStyle: React.CSSProperties = {
          width: '100%',
          height: '100%',
          opacity: effect.opacity ?? 1,
          transform: effect.transform,
          transformOrigin: effect.transformOrigin,
          clipPath: effect.clipPath,
          filter:
            [effect.filter, motionBlur ? 'url(#vt-motion-blur)' : null].filter(Boolean).join(' ') || undefined,
        };

        // 模板播放起点：>0 时把模板内部时间轴整体后移（负 from 的 Sequence），跳过入场动画
        const offsetFrames = Math.min(
          Math.max(0, Math.round((segment.startOffsetSec ?? 0) * FPS)),
          Math.max(0, t.contentDuration - 1),
        );

        // 段内节拍网格（B2 模板感知节拍）：BGM 真实拍点按段窗口切片下发，模板自愿消费
        // （逐词踩拍/逐拍生长/入场落拍），不消费零影响；无 BGM/无 beats 时 undefined。
        // 只用分析产出的 bgm.beats（帧级精度），不用 peaks 回退网格（桶分辨率太粗，落拍无意义）。
        // 窗口取模板时间轴原点（段起点 − startOffsetSec），与模板内 useCurrentFrame 口径一致。
        const offsetSec = offsetFrames / FPS;
        // M3 L2 合流（v1.4）：手放节拍标记并入段 beatGrid（补充不替换；无 BGM 也生效）。
        // 坐标换算：拍点网格相对模板时间轴原点（= 段内容起点 − startOffsetSec），用户 beats
        // 是段内容相对 → 合流前 +offsetSec；段外标记由 mergeUserBeats 过滤（消费方 distributeOnBeats 已钳位）。
        const userBeats = offsetFrames > 0 ? segment.beats?.map((b) => ({...b, t: b.t + offsetSec})) : segment.beats;
        const beatGrid = mergeUserBeats(
          sliceBeatGrid(
            bgm?.beats?.length ? bgmBeats : undefined,
            bgm?.bpm,
            t.contentStartFrame / FPS - offsetSec,
            t.contentDuration / FPS + offsetSec,
          ),
          userBeats,
          (segment.duration || 8) + offsetSec,
        );

        const templateContent = customDef ? (
          <CustomTemplateRender
            def={customDef}
            videos={segment.videos}
            text={segment.text}
            orientation={orientation}
            segmentDuration={segment.duration}
            style={segment.style}
            layout={segment.layout}
            params={segment.customParams}
          />
        ) : genDef ? (
          <GeneratedTemplateRender
            def={genDef}
            videos={segment.videos}
            text={segment.text}
            orientation={orientation}
            segmentDuration={segment.duration}
            style={segment.style}
            layout={segment.layout}
            params={segment.customParams}
          />
        ) : (
          <Template
            videos={segment.videos}
            text={segment.text}
            orientation={orientation}
            segmentDuration={segment.duration}
            style={segment.style}
            layout={segment.layout}
            params={segment.customParams}
            textAnim={segment.textAnim}
            exitStyle={segment.exitStyle}
            beatGrid={beatGrid}
            planCaptionWindows={segment.materialized?.captions}
          />
        );

        // 真实时钟体（模板第 0 帧 = contentStart = 拍点）：offsetFrames>0 时用负 from 的
        // 内层 Sequence 跳过入场（endThreshold = from + durationInFrames - 1，见 remotion
        // Sequence 实现），durationInFrames 需加上 offsetFrames 补偿，否则片段尾部渲染为黑。
        const bodyDuration = t.seqDuration - t.headPad;
        const anchoredBody = (
          <>
            {offsetFrames > 0 ? (
              <Sequence from={-offsetFrames} durationInFrames={bodyDuration + offsetFrames}>
                {templateContent}
              </Sequence>
            ) : (
              templateContent
            )}
            {/* 悬浮图片层：浮在模板场景之上，随片段一起进出场/转场（不受模板起点偏移影响） */}
            {segment.overlay && <FloatingCardLayer overlay={segment.overlay} />}
          </>
        );

        return (
          <Sequence key={segment.id} from={t.seqFrom} durationInFrames={t.seqDuration}>
            <VideoEffectContext.Provider value={segment.videoEffect || 'none'}>
              <BackgroundEffectContext.Provider value={segment.backgroundEffect || 'none'}>
                <div style={wrapperStyle}>
                  {t.headPad > 0 ? (
                    <>
                      {/* 头垫（拍点前的骑跨段）：模板时钟冻结在入场前状态（offsetFrames = 起播帧），
                          只随 wrapper 的转场样式入画——入场动画本身从拍点起跑（B3 到位帧压拍） */}
                      <Sequence from={0} durationInFrames={t.headPad}>
                        <Freeze frame={offsetFrames}>{templateContent}</Freeze>
                      </Sequence>
                      {/* 真实时钟体：本 Sequence 内本地帧从 headPad 起，模板 useCurrentFrame 与
                          旧模型（from=contentStart）逐帧一致 */}
                      <Sequence from={t.headPad} durationInFrames={bodyDuration}>
                        {anchoredBody}
                      </Sequence>
                    </>
                  ) : (
                    anchoredBody
                  )}
                </div>
              </BackgroundEffectContext.Provider>
            </VideoEffectContext.Provider>
            {flashOpacity > 0 && (
              <AbsoluteFill style={{background: '#ffffff', opacity: flashOpacity, pointerEvents: 'none'}} />
            )}
            {/* 遮挡物转场覆盖层（T2）：品牌色过场元素，不属于任何模板。
                cardSweep：圆角卡片从一侧扫入、驻留盖满、另一侧扫出（translate% 以卡片自身尺寸
                为基准，故屏分数偏移 ÷ OCCLUDER_CARD_FRAC 换算）；盖满帧前后段已在卡后完成切换 */}
            {occluder?.kind === 'cardSweep' && (
              <AbsoluteFill style={{pointerEvents: 'none', overflow: 'hidden'}}>
                <div
                  style={{
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: `${OCCLUDER_CARD_FRAC * 100}%`,
                    height: `${OCCLUDER_CARD_FRAC * 100}%`,
                    borderRadius: 36,
                    background: `linear-gradient(115deg, ${palette.accentDeep} 0%, ${palette.accent} 52%, ${palette.accentMuted} 100%)`,
                    boxShadow: `0 24px 80px ${palette.accentGlow}, inset 0 0 0 1px rgba(255, 255, 255, 0.18)`,
                    transform: `translate(-50%, -50%) translate(${(occluder.card.x / OCCLUDER_CARD_FRAC) * 100}%, ${(occluder.card.y / OCCLUDER_CARD_FRAC) * 100}%) rotate(${occluder.card.rotateDeg}deg) scale(${occluder.card.scale})`,
                  }}
                />
              </AbsoluteFill>
            )}
            {/* shapeBloom：品牌色圆形从焦点绽放盖满全屏再收拢（clip-path 圆收放，圆心 = 焦点） */}
            {occluder?.kind === 'shapeBloom' && occluder.bloom.radiusPct > 0.01 && (
              <AbsoluteFill
                style={{
                  pointerEvents: 'none',
                  background: `radial-gradient(circle at ${occluder.bloom.cx * 100}% ${occluder.bloom.cy * 100}%, ${palette.accentMuted} 0%, ${palette.accent} 70%)`,
                  clipPath: `circle(${occluder.bloom.radiusPct}% at ${occluder.bloom.cx * 100}% ${occluder.bloom.cy * 100}%)`,
                }}
              />
            )}
          </Sequence>
        );
      })}
      </AbsoluteFill>
      </GroundTrackingContext.Provider>
      </StabilizationContext.Provider>
      </ColorMatchContext.Provider>
      {/* 色调染层：soft-light 混合叠在内容之上（字幕/Logo/水印之下，不被染色） */}
      {look.tint && (
        <AbsoluteFill
          style={{
            background: look.tint.color,
            opacity: look.tint.opacity,
            mixBlendMode: look.tint.blendMode,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* 节拍光效闪动：鼓点上全屏微亮（内容层之上、Logo 之下） */}
      {pulse > 0 && (
        <AbsoluteFill style={{background: '#ffffff', opacity: pulse * PULSE_FLASH_AMOUNT, pointerEvents: 'none'}} />
      )}
      {/* 用户品牌 Logo：顶层常驻四角之一（水印之下） */}
      {logo && <LogoLayer logo={logo} />}
      {/* 烧录字幕：每段从其起点起显示该段字幕行（顶层，不被段时长截断） */}
      {captionStyle &&
        segments.map((segment, i) => {
          if (!segment.captions || segment.captions.length === 0) return null;
          const startFrame = segmentTimings[i].contentStartFrame;
          const dur = segmentTimings[i].contentDuration;
          // 无模板片段时长为 0：Sequence 不接受 durationInFrames<=0，且字幕无所依附，跳过
          if (dur <= 0) return null;
          return (
            <Sequence key={`cap-${segment.id}`} from={startFrame} durationInFrames={dur}>
              <CaptionLayer lines={segment.captions} style={captionStyle} />
            </Sequence>
          );
        })}
      {/* 全局质感层：暗角/颗粒/扫光（字幕之上、水印之下；clean 档组件内部直接不渲染） */}
      <TextureLayer preset={texture} />
      {/* 边缘小字/免责声明：顶层常驻（质感层之上不被压暗，水印之下） */}
      {finePrint && <FinePrintLayer config={finePrint} />}
      {/* 配乐署名（CC BY 强制）：片尾 2.8s 淡入一行标准署名，无开关（用户拍板 2026-10-13） */}
      {bgm?.credit && isAttributionRequired(bgm.credit) && (
        <BgmCreditLayer credit={bgm.credit} endFrame={bgmEndFrame} />
      )}
      {/* 免费版水印：全程叠加在右下角（licensed === false 时） */}
      {!licensed && <Watermark />}
      </CursorContext.Provider>
    </AbsoluteFill>
  );
};

export default MultiSegmentPromo;
