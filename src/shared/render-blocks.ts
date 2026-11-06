/**
 * 段级渲染分块与缓存键（纯函数，主进程渲染与单测共用）
 *
 * 原理：整片渲染是单合成逐帧确定性渲染——同一份全片 props 下，第 N 帧的像素与
 * 「从哪一帧开始渲」无关。因此可按段边界把时间线切成块，每块用 renderMedia 的
 * frameRange 窗口单独渲染，块间像素/音频与整片渲染逐帧一致，concat 拼回即整片。
 *
 * 缓存键覆盖三类依赖：
 * 1. 全局视觉/编码参数（渲染设置、画幅、质感、BGM、SFX 源可用性、授权标记…）；
 * 2. 时间轴音频签名——BGM ducking 窗口与 SFX 放置表依赖全片各段时长/转场/旁白时长，
 *    任一段时长变化都会平移后续所有音频事件，故全段时长类字段进所有块的键；
 * 3. 邻段内容（k-1..k+1）——转场跨段（出场渲染在下一块开头、运镜焦点取下一段 layout）、
 *    旁白尾巴可溢出到下一段，保守取前后各一段。
 * 段内的文案/样式/模板参数变化只影响本块与相邻块，其余块继续命中。
 */

import crypto from 'crypto';
import {TEMPLATES, isDataDrivenTemplateId, isGeneratedTemplateId, isRawOutputTemplate} from './template-registry';
import {getOutroFadeFrames, computeTransitionWindows} from './transition-style';
import type {Segment} from './types';

/** 缓存结构版本：分块/键语义变化时 +1，旧缓存全部自然失效
 *  v2: 全站缓动口音 cubic-out → easeOutQuint（motion.ts EASINGS.standard），模板画面随之变化
 *  v3: ClipMedia 窗口尾封口（trimEnd 显著小于素材时长时冻结末帧），同工程数据画面变化
 *  v4: 渲染管线开 WebGL（chromiumOptions.gl，three.js 3D 模板前置），并新增 3D 模板
 *  v5: Hero3DTitle/ModelTurntable 画面调优（文字行宽上限、模型基准尺寸）
 *  v6: GrowthBars3D 柱高/取景调优（柱顶数值防裁切），并新增 GrowthBars3D/TrendLine3D
 *  v7: TrendLine3D 首末节点标签/终值标注 x 钳回安全区（防顶出画面右缘）
 *  v8: TrendLine3D 终值标注改用更小的钳位幅度（短数字不与曲线末端脱节）
 *  v9: 虚拟相机转场族（panChase 横摇追拍 / orbitSwipe 轨道环绕）+ flyThrough direction 参数化，转场数学变化
 *  v10: 新增 CameraJourney3D（一镜到底路径相机 3D 旅程）；VideoScreenTexture 加 frameOffset/previewWindow
 *  v11: CameraJourney3D 取景/穿模修复（远景改侧后方投影跨度取景、去光晕管与站位球、展板偏航收敛）
 *  v12: CameraJourney3D 驻留机位移到线管靠板一侧 + 相机悬浮 0.32（线管压到画面下缘，不再糊板/横穿中线）
 *  v13: CameraJourney3D 连接线驻留淡出防穿帮、展板文字提前入场、线管减细（0.065/0.72）
 *  v14: CameraJourney3D 展板文字改第 0 帧就位（飞行途中无半成品字）、副标题提前 4 帧入场
 *  v15: B2 beatGrid 下发（KineticType/数据 3D/入场落拍按拍点对齐，有 BGM beats 时画面变化）；
 *      块键同时新增 bgm 节拍签名字段（beats/bpm 显式进键，见 bgmBeatSignature）
 *  v16: T2 遮挡物转场（cardSweep 卡片扫场 / shapeBloom 形状绽放），转场数学+合成器覆盖层变化
 *  v17: shapeBloom 半径剖面 sin → sin²（盖满驻留收窄到 ~1/3 窗口，收拢显露阶段加长）
 *  v18: B3 转场高潮帧对拍——窗口骑跨切点（高潮帧=拍点），入段提前 headPad 帧挂载（头垫冻结第 0 帧）、
 *      出段提前开始出场；转场音效锚点从窗口中点改高潮帧。转场类型不变时块键字段无差异，靠本版本兜底失效
 *  v19: T3 转场锚点——zoomIn/zoomOut 按模板 transitionAnchor 精确拟合（显式参数 > 锚点 > 旧自动焦点），
 *      MAX_ZOOM 4→6.5（锚点 cover 拟合上限）；RevealSlide/KenBurns/CodeTerminal/SplitShowcase/DeviceShowcase 首批标注
 *  v20: 新增三款媒体 3D 场景模板（GalleryHall3D 艺廊 / OrbitCarousel3D 环游展台 / TimeTunnel3D 穿越隧道）；
 *      展板组件抽公共 PanelBoard，CameraJourney3D 同步改引用（画面不变）
 *  v26: 3D 场景族相机真减速——camSpeed 新增 travel 甩头时长倍率（CAM_SPEED_TRAVEL，舒缓档 ×2），
 *      camSpeed/camEase/dwellRatio 默认档放慢（0/2/2）、家族 defaultDuration 统一 20s（运动时间线变化，失效旧缓存）
 *  v27: 3D 场景族观感升级——旅程路径 9 控制点+符号惯性（板间必弯）、站位连接线/星座连线/街谷连线全部
 *      柔和弧管化、linkLines 数量参数（旅程/城市/星域），城市/星域/旅程/艺廊/隧道/环台/中庭全面加
 *      背景元素与街景细节（场景几何变化，失效旧缓存）
 *  v28: 3D 模板运动/场景解耦——七款 3D 模板新增 sceneStyle 场景参数（星空/银河/都市/乡村/古建/
 *      山水/水墨/虚空/纯净九档），环境装饰收敛到 scene-packs 场景包；默认档 = 模板原生场景
 *      （默认渲染结果与 v27 一致，但参数 schema 变化，失效旧缓存）
 *  v29: ThreeText 字形笔位居中修复——字形路径预移 -advance/2（旧版每个字右移半个步进宽：
 *      Hero3DTitle 大标题偏右 ~5% 画宽、混排字距不匀），全部 3D 文字（片头大字 + 3D 模板
 *      板题/段标题）位置变化，失效旧缓存
 *  v30: 山水/水墨场景山体重做——5 棱锥改「噪声扰动岩峰簇（主峰+侧峰）+ 环形连绵山脊带
 *      （圆柱顶环按角度双正弦+逐列扰动）」，古建远山同款岩峰；山体几何变化，失效旧缓存
 *  v31: TimeTunnel3D 匀速穿越重做——初速直飞无静止帧（去开场缓推/缓出收尾）、文字改头顶航道
 *      （近轴不出画）、ThreeText 逐字入场在 fly 模式禁用（startFrame=-12 首帧完整成行）、
 *      新增 tailHold 参数；fly 模式画面全变，失效旧缓存
 *  v32: PanelBoard 观感升级——纯文字展板改「毛玻璃大字卡」（品牌色半透明板面+大字），
 *      媒体展板新增美化光标精灵（cursorPoints 轨迹 + 点击脉冲，无轨迹零变化）；
 *      文字板画面全变，失效旧缓存
 *  v33: 块键新增 logo 文件指纹（logo 内容替换但路径不变时旧键不失效，v7 烤出旧 logo 实锤）；
 *      PanelBoard 光标精灵缩小去冻结；键结构变化，失效旧缓存
 *  v34: OrbitCarousel3D 转场方位角先行（eA/eT 幂偏置：转场中段目标板正面可读，修
 *      「板间移动时两侧都呈侧棱」）；环台转场画面变化，失效旧缓存
 *  v35: OrbitCarousel3D 开场改沿板 0 正前轴线高空压下（旧版停「板 0 前一格」，n=3 时
 *      恰为板 n-1 正前方——转场进来先看到最后一块板素材再横穿 120°，顺序错乱），
 *      travel0 无方位扫描原地保持；开场画面全变，失效旧缓存 */
export const RENDER_CACHE_VERSION = 35;

/** 一块 = 某个可渲染段的内容窗口（帧区间含两端；末块含尾部淡黑） */
export interface RenderBlock {
  /** 块序号（0 起，按时间顺序） */
  index: number;
  /** 主段在 segments 里的下标 */
  segIndex: number;
  startFrame: number;
  endFrame: number;
  frames: number;
}

export interface RenderBlockPlan {
  blocks: RenderBlock[];
  /** 总帧数（= endFrame + 1，与 calculateFrameRange 口径一致） */
  totalFrames: number;
}

export const isRenderableSegment = (
  seg: Pick<Segment, 'templateId'>,
  customTemplateIds: string[],
  generatedTemplateIds: string[] = [],
): boolean => {
  if (!seg?.templateId) return false;
  if (isDataDrivenTemplateId(seg.templateId)) return customTemplateIds.includes(seg.templateId);
  if (isGeneratedTemplateId(seg.templateId)) return generatedTemplateIds.includes(seg.templateId);
  return TEMPLATES.some((t) => t.id === seg.templateId);
};

/**
 * 按段边界分块。少于 3 个可渲染段时分块开销（每块一次浏览器启动）大于收益，返回 null。
 * 时长为 0 的段（引用已删除模板）从时间线消失，不产生块，也不作为边界。
 */
export const computeRenderBlocks = (
  segments: Array<Pick<Segment, 'duration' | 'templateId'>>,
  customTemplateIds: string[],
  fps: number,
  generatedTemplateIds: string[] = [],
): RenderBlockPlan | null => {
  const contentFrames = segments.map((s) =>
    isRenderableSegment(s, customTemplateIds, generatedTemplateIds) ? Math.round((s.duration || 8) * fps) : 0,
  );
  const renderableIdx = segments.map((_, i) => i).filter((i) => contentFrames[i] > 0);
  if (renderableIdx.length < 3) return null;

  const starts: number[] = [];
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    starts.push(acc);
    acc += contentFrames[i];
  }
  const totalContent = acc;
  const outro = isRenderableSegment(segments[segments.length - 1], customTemplateIds)
    ? getOutroFadeFrames(fps)
    : 0;
  const endFrame = Math.max(0, totalContent + outro - 1);

  const blocks: RenderBlock[] = renderableIdx.map((segIndex, p) => {
    const start = starts[segIndex];
    const end = p === renderableIdx.length - 1 ? endFrame : starts[renderableIdx[p + 1]] - 1;
    return {index: p, segIndex, startFrame: start, endFrame: end, frames: end - start + 1};
  });
  return {blocks, totalFrames: endFrame + 1};
};

/**
 * 段预览窗（RENDER_SEGMENT 单段试渲）：目标段在整片时间线上的绝对帧范围，
 * 与 MultiSegmentPromo 的 segmentTimings 同款数学——seqFrom = 内容起点 - 入场转场
 * headPad（后段提前挂载），seqDuration = headPad + 内容 + 尾（出场转场 tail 或末段
 * 淡黑帧）。含转场垫帧 → 段预览的转场头尾天然完整；**不裁剪 segments**（velocityPush
 * 等骑跨切点的转场裁段会丢上下文）。renderMedia frameRange=[from,to] 闭区间。
 * 段号越界/不可渲染（0 时长）返回 null（调用方报错）。
 */
export const segmentPreviewWindow = (
  segments: Array<Pick<Segment, 'duration' | 'templateId' | 'transition' | 'transitionParams'>>,
  customTemplateIds: string[],
  fps: number,
  segIndex: number,
  generatedTemplateIds: string[] = [],
): {from: number; to: number; frames: number} | null => {
  if (segIndex < 0 || segIndex >= segments.length) return null;
  const contentFrames = segments.map((s) =>
    isRenderableSegment(s, customTemplateIds, generatedTemplateIds) ? Math.round((s.duration || 8) * fps) : 0,
  );
  if (contentFrames[segIndex] <= 0) return null;
  const contentStart = contentFrames.slice(0, segIndex).reduce((sum, n) => sum + n, 0);
  const contentDuration = contentFrames[segIndex];
  const isLast = segIndex === segments.length - 1;
  const windows = computeTransitionWindows(segments, contentFrames, fps);
  const inW = segIndex > 0 ? windows[segIndex - 1] : null; // 前一边界窗口（驱动本段入场）
  const outW = windows[segIndex];                          // 本段驱动的窗口（驱动本段出场）
  // 末段尾 = 淡黑帧（原样输出模板豁免——原始录像成片结尾保持原画面，与 MultiSegmentPromo 同规则）
  const outro = isRawOutputTemplate(segments[segments.length - 1]?.templateId) ? 0 : getOutroFadeFrames(fps);
  const tail = isLast ? outro : outW.tail;
  const headPad = inW ? inW.headPad : 0;
  const from = contentStart - headPad;
  const frames = headPad + contentDuration + tail;
  return {from, to: from + frames - 1, frames};
};

/**
 * 媒体 URL 归一化（进哈希前）：本地媒体服务 http URL 带动态端口，剥离端口只认文件路径，
 * 保证跨会话（端口变化）缓存仍可命中；其余（file://、data:、远程 https）原样返回。
 */
export const normalizeMediaUrl = (u: unknown): unknown => {
  if (typeof u !== 'string') return u;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(u)) return u;
  try {
    const url = new URL(u);
    const p = url.searchParams.get('path');
    if (p) return p.replace(/\\/g, '/');
  } catch {
    // 解析失败按原样参与哈希
  }
  return u.replace(/^[a-z]+:\/\/[^/]+/i, '');
};

/** JSON 序列化（媒体 URL 归一化版），键与值保持稳定 */
const hashJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'string' ? normalizeMediaUrl(v) : v));

/** 时间轴音频签名：影响「块内音频」的全片级字段（时长平移类，非内容类） */
const timelineAudioSignature = (segments: Segment[]) =>
  segments.map((s) => ({
    d: s.duration ?? 8,
    t: s.transition ?? 'none',
    tp: s.transitionParams
      ? {
          du: s.transitionParams.durationSec,
          fx: s.transitionParams.focusX,
          fy: s.transitionParams.focusY,
          z: s.transitionParams.zoom,
        }
      : null,
    nr:
      s.narration && s.narration.src
        ? {s: s.narration.src, d: s.narration.duration ?? 0, v: s.narration.volume ?? 1}
        : null,
  }));

/**
 * BGM 节拍签名：B2 起模板按段窗口消费 beatGrid（逐词踩拍/逐拍生长/入场落拍），
 * beats/bpm 直接决定块内画面。globalProps 本就含完整 bgm 对象（beats 已在键内），
 * 这里再单列一份显式签名——换曲/重测节拍但段落时长不变时也必须换键，
 * 且不依赖「globalProps 永远原样携带 bgm」这一间接事实（防后续瘦身重构挖洞）。
 */
const bgmBeatSignature = (bgm: unknown): unknown => {
  if (!bgm || typeof bgm !== 'object') return null;
  const b = bgm as {path?: unknown; beats?: unknown; bpm?: unknown};
  return {
    p: typeof b.path === 'string' ? b.path : null,
    beats: Array.isArray(b.beats) ? b.beats : null,
    bpm: typeof b.bpm === 'number' ? b.bpm : null,
  };
};

/** 块缓存键的上下文（渲染设置 + 全片 props） */
export interface BlockKeyContext {
  appVersion: string;
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audioCodec?: string;
  crf?: number;
  x264Preset?: string;
  muted: boolean;
  /** 实际使用的编码器（software/nvenc/qsv；码流参数不同不可混拼） */
  encoder: string;
  format: string;
  /** 全片 inputProps（segments 字段会被剔除单独处理） */
  globalProps: Record<string, unknown>;
  segments: Segment[];
  /** 每段每素材的文件指纹（size:mtime；空串 = 未知跳过），下标与 segments 对齐 */
  videoFingerprints?: string[][];
  /** 片尾 logo 文件指纹（size:mtime；logo 内容被替换但路径不变时让缓存键失效） */
  logoFingerprint?: string;
}

/** 计算某块的缓存键（sha1）。邻段窗口：segIndex-1 .. segIndex+1 */
export const blockCacheKey = (ctx: BlockKeyContext, block: RenderBlock): string => {
  const from = Math.max(0, block.segIndex - 1);
  const to = Math.min(ctx.segments.length - 1, block.segIndex + 1);
  const neighbors = ctx.segments.slice(from, to + 1).map((seg, i) => ({
    seg,
    fp: ctx.videoFingerprints?.[from + i] ?? [],
  }));
  const {segments: _sg, ...globalRest} = ctx.globalProps;
  const payload = {
    v: RENDER_CACHE_VERSION,
    app: ctx.appVersion,
    render: {
      compositionId: ctx.compositionId,
      w: ctx.width,
      h: ctx.height,
      fps: ctx.fps,
      codec: ctx.codec,
      audioCodec: ctx.audioCodec ?? null,
      crf: ctx.crf ?? null,
      x264Preset: ctx.x264Preset ?? null,
      muted: ctx.muted === true,
      encoder: ctx.encoder,
      format: ctx.format,
    },
    global: globalRest,
    tl: timelineAudioSignature(ctx.segments),
    bgmBeats: bgmBeatSignature(ctx.globalProps.bgm),
    logo: ctx.logoFingerprint ?? null,
    neighbors,
  };
  return crypto.createHash('sha1').update(hashJson(payload)).digest('hex');
};

/**
 * ffmpeg concat 列表内容（路径统一正斜杠，单引号按 concat 转义规则处理）。
 * durationSec：显式声明该文件的时长——concat demuxer 缺省取「最长流」时长做下一
 * 文件的时间戳偏移，而块内音频因编码器 priming 比视频长约 50ms，不显式声明会在每个
 * 接缝处给视频时间线留下 50ms 空洞（播放时逐缝音画漂移）。必须传视频时长（帧数/帧率）。
 */
export const concatListContent = (paths: string[], durationsSec?: number[]): string =>
  paths
    .map((p, i) => {
      const line = `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
      const d = durationsSec?.[i];
      return d !== undefined && Number.isFinite(d) && d > 0 ? `${line}\nduration ${d}` : line;
    })
    .join('\n') + '\n';
