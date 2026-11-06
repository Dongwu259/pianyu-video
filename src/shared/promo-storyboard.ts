/**
 * 宣传片故事板单一源与平台派生（管线路线图 P0-1，2026-10-11）
 *
 * 一条片衍生 N 个发布物（横版/竖版/15s 切条）的成本与一致性：故事板只写一次（平台无关的
 * 段序/文案/素材窗/参数），画幅差异全部走「机械层 + 每模板竖屏覆盖表」派生——
 * 横竖并行迭代不再双源漂移（v11 竖版曾是横版 470 行全文复制改参）。
 *
 * 派生分三层叠加（后者覆盖前者同名键）：
 *   ① presetId 预设包（template-presets）——观感语言底座
 *   ② params 段参数——逐段微调（倾斜方向/点击节奏等）
 *   ③ 竖屏时：portraitParamsFor(templateId) 模板层竖屏配方（registry TemplateMeta.portraitParams，
 *      只收渲染验收过的值）→ 段级 portraitParams（罕用兜底）
 *
 * 竖屏节奏压缩/素材窗微调不进覆盖表（那是每条片的编辑决策）：段上写 portraitDuration /
 * portraitTrim，单一源自持。装配侧管线（素材入库→混音→渲染）见 smoke_test/lib-promo.ts。
 */

import type {Segment, VideoClip} from './types.ts';
import {presetParams} from './template-presets.ts';
import {portraitParamsFor} from './template-registry.ts';

export interface StoryClip {
  /** 素材文件名（相对 board.mediaDir；入库见 lib-promo ingestTakes） */
  src: string;
  trimStart: number;
  trimEnd: number;
  /** false = 不带光标轨迹 sidecar（白板视频卡等静态展示），缺省 true */
  withTrack?: boolean;
  /** true = 挂 uiRegionsTrack（PanelFlyout 拆层段必需；sidecar 不存在时入库报错），缺省 false */
  regions?: boolean;
  /** 竖屏专用窗（节奏压缩后保交互 payoff 的微调），缺省 = 横屏窗 */
  portraitTrim?: [number, number];
}

export interface StorySegment {
  id: string;
  templateId: string;
  duration: number;
  /** 竖屏时长（节奏压缩；缺省 = duration） */
  portraitDuration?: number;
  transition: Segment['transition'];
  text: Segment['text'];
  clips?: StoryClip[];
  /** 预设 id（template-presets；与 params 叠加：预设铺底、params 覆写单项） */
  presetId?: string;
  /** 段参数（叠加在 presetId 之上；无 presetId 时即全部参数） */
  params?: Record<string, number>;
  /** 段级竖屏覆写（优先于模板层 portraitParams，罕用） */
  portraitParams?: Record<string, number>;
  style?: Segment['style'];
  /** 转场方向档（0自动/1上/2下/3左/4右）；0/缺省不设 transitionParams */
  direction?: number;
  /** layout 覆写（叠加在全幅缺省之上） */
  layout?: Partial<Segment['layout']>;
}

export interface NarLine {
  file: string;
  seg: number;
  text: string;
}

export interface BoardCanvas {
  aspectRatioId: string;
  orientation: 'landscape' | 'portrait';
  /** logo 尺寸（横版实录段录屏自带顶栏 UI 用 0.09 防压角，竖屏窗口卡不到角落 0.12 安全） */
  logoSize: number;
  projectName: string;
  /** 成片名（输出 <outName>.mp4、renderSettings.filename） */
  outName: string;
}

export interface Storyboard {
  id: string;
  /** 实录素材目录（相对仓库根） */
  mediaDir: string;
  /** 旁白 mp3 目录（相对仓库根） */
  narrationDir: string;
  /** 旁白单一源 manifest（相对仓库根；P1-3）：词表/段位/新鲜度契约见 shared/narration-manifest.ts。
   *  设了它 narration 内联表即弃用（探针板等无旁白板继续用 narration: []） */
  narrationManifest?: string;
  /** 节奏卡点自动化（旁白 manifest → 段长下限向上拉长+整拍吸附，见 shared/narration-rhythm.ts）。
   *  开了它装配还容忍 mp3 全缺（TTS 波降级 captions-only，估测时长驱动节奏）。
   *  冻结板（v11/v12）不开——板长即定稿。 */
  rhythmFromNarration?: boolean;
  /** 库配乐（resources/bgm 下文件名，六情绪×2 条 CC BY 曲库）——缺省走内置合成器。
   *  CC BY 曲自动把署名行烧入片尾段 features（装配侧等价 BgmCreditLayer）。 */
  bgmFile?: string;
  canvas: {landscape: BoardCanvas; portrait: BoardCanvas};
  segments: StorySegment[];
  /** 内联旁白表（无 manifest 的板用：探针板 narration: [] 等；v11 起正式板走 narrationManifest） */
  narration?: NarLine[];
  theme?: {brandColor?: string; texture?: string; fontMood?: string};
}

export type Platform = 'landscape' | 'portrait';

/** 派生结果：已应用平台变换（时长/窗/参数叠加），clips 仍为 StoryClip（元数据入库时解析） */
export interface DerivedPlan {
  platform: Platform;
  canvas: BoardCanvas;
  segments: StorySegment[];
  narration: NarLine[];
  theme?: Storyboard['theme'];
}

const mergeParams = (seg: StorySegment, platform: Platform): Record<string, number> | undefined => {
  let p: Record<string, number> | undefined = seg.presetId ? presetParams(seg.templateId, seg.presetId) : undefined;
  if (seg.params) p = {...(p ?? {}), ...seg.params};
  if (platform === 'portrait') {
    const overlay = portraitParamsFor(seg.templateId);
    if (Object.keys(overlay).length > 0) p = {...(p ?? {}), ...overlay};
    if (seg.portraitParams) p = {...(p ?? {}), ...seg.portraitParams};
  }
  return p && Object.keys(p).length > 0 ? p : undefined;
};

/** 平台派生：竖屏 = 时长压缩 + 素材窗替换 + 参数叠加（预设→段参→竖屏覆盖）；横屏 = 原样摊平 */
export const deriveBoard = (board: Storyboard, platform: Platform): DerivedPlan => ({
  platform,
  canvas: board.canvas[platform],
  theme: board.theme,
  narration: board.narration ?? [],
  segments: board.segments.map((s) => {
    const params = mergeParams(s, platform);
    const out: StorySegment = {
      ...s,
      duration: platform === 'portrait' ? (s.portraitDuration ?? s.duration) : s.duration,
      // 已摊平进 params，去掉派生痕迹（防二次派生重复叠加）
      presetId: undefined,
      portraitParams: undefined,
      ...(params ? {params} : {params: undefined}),
      clips: s.clips?.map((c) =>
        platform === 'portrait' && c.portraitTrim
          ? {...c, trimStart: c.portraitTrim[0], trimEnd: c.portraitTrim[1], portraitTrim: undefined}
          : c,
      ),
    };
    return out;
  }),
});

export const deriveLandscape = (board: Storyboard): DerivedPlan => deriveBoard(board, 'landscape');
export const derivePortrait = (board: Storyboard): DerivedPlan => deriveBoard(board, 'portrait');

/** StoryClip → VideoClip 的解析交给装配侧（ffprobe 元数据 + 拷贝进工程目录），这里只做结构装配 */
export const materializeBoard = (
  plan: DerivedPlan,
  resolveClip: (c: StoryClip) => VideoClip,
): Segment[] =>
  plan.segments.map((s, i) => ({
    id: s.id || `seg-${i}`,
    templateId: s.templateId,
    videos: (s.clips ?? []).map(resolveClip),
    text: s.text,
    style: s.style ?? {},
    layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0, ...(s.layout ?? {})},
    duration: s.duration,
    transition: s.transition,
    ...(s.direction ? {transitionParams: {direction: s.direction}} : {}),
    ...(s.params ? {customParams: s.params} : {}),
  })) as Segment[];

const isCtaSegment = (s: StorySegment): boolean =>
  s.templateId === 'OutroCTA' || s.templateId === 'FullbleedCTA';

/**
 * 前缀切条（社媒 15s 短版）：从故事板头部按 seconds 预算取段，横竖通用（切完仍可 deriveBoard 派生）。
 * keepCta：先给末页 CTA 段预留时长（min(CTA 时长, 预算 40%, 5s)），剩余预算从头装钩子段——
 * 「钩子前置 + 落 CTA」的切条惯例；旁白行随段过滤并重排 seg 位。
 */
export const deriveCut = (board: Storyboard, seconds: number, opts?: {keepCta?: boolean}): Storyboard => {
  const last = board.segments[board.segments.length - 1];
  const ctaReserve =
    opts?.keepCta && last && isCtaSegment(last)
      ? Math.min(last.duration, Math.min(seconds * 0.4, 5))
      : 0;
  const budget = seconds - ctaReserve;
  const kept: Array<{seg: StorySegment; origIndex: number}> = [];
  let used = 0;
  for (let i = 0; i < board.segments.length; i++) {
    const s = board.segments[i];
    if (isCtaSegment(s) && ctaReserve > 0) continue; // CTA 由预留位统一处理
    if (kept.length > 0 && used + s.duration > budget) break;
    kept.push({seg: s, origIndex: i});
    used += s.duration;
  }
  if (kept.length === 0) {
    // 预算连第一段都装不下：只留第一段（时长后续卡点吸附再收）
    kept.push({seg: board.segments[0], origIndex: 0});
    used = board.segments[0].duration;
  }
  const ctaRoom = seconds - used;
  const ctaKept = ctaReserve > 0 && last && kept[kept.length - 1].seg !== last && ctaRoom >= 2.5;
  // CTA 用自身设计时长（预算剩余再多也不拉长——宁可全片短于预算，不切内容不变形）
  const segments = ctaKept
    ? [...kept.map((k) => k.seg), {...last, duration: Math.min(ctaRoom, last.duration)}]
    : kept.map((k) => k.seg);
  if (ctaKept) kept.push({seg: last, origIndex: board.segments.length - 1});
  const remap = new Map<number, number>();
  kept.forEach((k, ni) => remap.set(k.origIndex, ni));
  const narration = (board.narration ?? [])
    .filter((l) => remap.has(l.seg))
    .map((l) => ({...l, seg: remap.get(l.seg) as number}));
  return {...board, segments, narration};
};
