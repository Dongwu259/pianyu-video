/**
 * 录屏即成品 - 一键编排核心（1.5.0「ScreenDemo」M3，纯函数，按钮 / MCP 工具 / 单测共用）。
 *
 * 流程（RESEARCH-SCREENDEMO.md §三.3）：纯录屏素材 → 导播镜头计划（M1）→ 重建故事板：
 * 标题钩子（节拍大字）+ ScreenDemo 导播主段（每段录屏一段）+ 结尾 CTA。
 * BGM/align_beats 由调用方接续（渲染器 runner 已串好，MCP agent 按工作流指南调用）。
 *
 * 设计约束：
 * - 不碰文件系统/Store：素材元信息与 sidecar 由调用方读好传入（渲染端 window.api / 单测直接构造）；
 * - 确定性：同输入同故事板；
 * - 主段尾部修剪：最后一个光标活动（移动/点击）之后只保留 TAIL_PAD 秒——录屏常见的
 *   「录完停在那儿」的尾巴直接剪掉；剪完不足 MIN_MAIN_SEC 则放弃修剪保留全长。
 */

import type {Segment} from './types';
import type {CursorTrackFile} from './capture';
import {planDirectorShots} from './director-plan';

/** 素材输入（src 由调用方给可直接播放的形态：视频服务器 URL 或相对路径） */
export interface ScreenDemoSourceInput {
  src: string;
  name: string;
  width: number;
  height: number;
  /** 原始时长（秒） */
  duration: number;
  /** 鼠标轨迹 sidecar（可空：ScreenDemo 会退化为单宽景缓推） */
  track?: CursorTrackFile | null;
  /** sidecar 文件路径（相对工程目录或绝对路径；给了 track 才有意义，落 clip.cursorTrack 持久化） */
  sidecarPath?: string;
}

export interface ScreenDemoBuildOptions {
  /** 标题钩子文案（缺省「产品演示」） */
  title?: string;
  /** 标题钩子副文案（缺省空） */
  subtitle?: string;
  /** CTA 落版标题（缺省同 title） */
  ctaTitle?: string;
  /** CTA 行动要点（每行一条；缺省['立即下载体验']） */
  ctaLines?: string[];
  /** 标题钩子时长（缺省 2.8s） */
  hookSec?: number;
  /** CTA 段时长（缺省 4.5s） */
  ctaSec?: number;
}

export interface ScreenDemoBuildResult {
  segments: Segment[];
  /** 主段镜头计划统计（反馈给用户/agent 的抓手） */
  stats: {
    /** 主段镜头数（全部主段计划之和；无轨迹 = 0） */
    shotCount: number;
    /** 主段总时长（修剪后，秒） */
    mainSec: number;
    /** 尾部修剪掉的秒数（0 = 未修剪） */
    tailTrimmedSec: number;
    /** 点击数（全部轨迹合计） */
    clickCount: number;
  };
  notes: string[];
}

/** 主段尾部保留的最后一活动秒数 */
const TAIL_PAD_SEC = 1.5;
/** 主段修剪下限：剪后短于此则保留全长 */
const MIN_MAIN_SEC = 3;
const DEFAULT_HOOK_SEC = 2.8;
const DEFAULT_CTA_SEC = 4.5;

/** 主段尾修：最后光标活动 + 1.5s；素材过短不剪 */
export const trimEndForTrack = (duration: number, track?: CursorTrackFile | null): {trimEnd: number; trimmed: number} => {
  const lastMs = Math.max(
    track?.points?.length ? track.points[track.points.length - 1].t : 0,
    track?.clicks?.length ? track.clicks[track.clicks.length - 1].t : 0,
  );
  if (lastMs <= 0) return {trimEnd: duration, trimmed: 0};
  const candidate = Math.min(duration, lastMs / 1000 + TAIL_PAD_SEC);
  if (candidate < MIN_MAIN_SEC) return {trimEnd: duration, trimmed: 0};
  return {trimEnd: candidate, trimmed: Math.max(0, duration - candidate)};
};

/**
 * 构建录屏即成品故事板：[标题钩子] + [ScreenDemo 主段 ×N] + [CTA]。
 * 返回的 Segment 与 auto_beat_montage 同构（直接喂 applyMontageSegments）。
 */
export const buildScreenDemoStoryboard = (
  sources: ScreenDemoSourceInput[],
  opts?: ScreenDemoBuildOptions,
): ScreenDemoBuildResult => {
  const notes: string[] = [];
  const title = (opts?.title || '产品演示').trim() || '产品演示';
  const ctaLines = opts?.ctaLines && opts.ctaLines.length > 0 ? opts.ctaLines : ['立即下载体验'];
  const hookSec = Math.max(1.5, opts?.hookSec ?? DEFAULT_HOOK_SEC);
  const ctaSec = Math.max(2.5, opts?.ctaSec ?? DEFAULT_CTA_SEC);

  const valid = sources.filter((s) => s.src && s.duration > 0.5);
  if (valid.length === 0) {
    return {segments: [], stats: {shotCount: 0, mainSec: 0, tailTrimmedSec: 0, clickCount: 0}, notes: ['没有有效录屏素材（时长不足 0.5s）']};
  }

  const segments: Segment[] = [];
  const now = Date.now();
  const segId = (i: number) => `${now}-sd${i}-${Math.random().toString(36).slice(2, 8)}`;

  // 标题钩子（节拍大字，无素材）
  segments.push({
    id: segId(0),
    templateId: 'KineticType',
    videos: [],
    text: {title, subtitle: opts?.subtitle ?? '', features: [], brandName: ''},
    style: {},
    layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
    duration: hookSec,
    transition: 'slide',
  } as unknown as Segment);

  // ScreenDemo 主段：每段录屏一段（尾部修剪 + 计划统计）
  let shotCount = 0;
  let clickCount = 0;
  let mainSec = 0;
  let tailTrimmedSec = 0;
  valid.forEach((s, i) => {
    const {trimEnd, trimmed} = trimEndForTrack(s.duration, s.track);
    const clipSec = trimEnd;
    if (s.track && s.track.points.length >= 2) {
      const plan = planDirectorShots({
        points: s.track.points,
        clicks: s.track.clicks ?? [],
        videoWidth: s.track.videoWidth || s.width || 1,
        videoHeight: s.track.videoHeight || s.height || 1,
        durationSec: s.duration,
      });
      shotCount += plan.length;
      clickCount += (s.track.clicks ?? []).length;
      if (plan.length === 1 && plan[0].reason === 'coverage') {
        notes.push(`「${s.name}」没有可用光标轨迹，该段退化为宽景缓推`);
      }
    } else {
      notes.push(`「${s.name}」没有光标轨迹 sidecar，该段退化为宽景缓推（本软件录制的素材才有轨迹）`);
    }
    mainSec += clipSec;
    tailTrimmedSec += trimmed;
    const main = {
      id: segId(i + 1),
      templateId: 'ScreenDemo',
      videos: [
        {
          id: `screendemo-${i}`,
          src: s.src,
          name: s.name,
          width: s.width,
          height: s.height,
          duration: s.duration,
          type: 'video' as const,
          trimStart: 0,
          trimEnd,
          trimmedDuration: clipSec,
          muted: true,
          // 轨迹：sidecar 持久化字段 + 内存态（渲染即时可用；保存工程时内存态自动剥离）
          ...(s.track && s.sidecarPath ? {cursorTrack: s.sidecarPath} : {}),
          ...(s.track ? {cursorPoints: s.track.points, cursorClicks: s.track.clicks ?? []} : {}),
        },
      ],
      text: {title: '', subtitle: '', features: [], brandName: ''},
      style: {},
      layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
      duration: clipSec,
      // 转场不花哨（参照研究结论）：主段之间 crossfade，最后主段进 CTA 用 zoomIn
      transition: i < valid.length - 1 ? 'crossfade' : 'zoomIn',
    } as unknown as Segment;
    segments.push(main);
  });

  // CTA（结尾行动号召）
  segments.push({
    id: segId(valid.length + 1),
    templateId: 'OutroCTA',
    videos: [],
    text: {title: opts?.ctaTitle?.trim() || title, subtitle: '', features: ctaLines, brandName: ''},
    style: {},
    layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
    duration: ctaSec,
    transition: 'none',
  } as unknown as Segment);

  return {segments, stats: {shotCount, mainSec, tailTrimmedSec, clickCount}, notes};
};

// ====== 教程编排（1.6「操作视频」M2）：点击锚点 → 步骤切分 → 步骤字幕卡 ======

/** 步骤卡时长（秒） */
const STEP_CARD_SEC = 1.6;
/** 步骤起点提前量：从该步第一次点击前这么多秒开始播（观众先看到动作前的画面） */
export const TUTORIAL_PRE_SEC = 1.0;
/** 步骤聚簇：两次点击间隔 ≤ 该值算同一步 */
export const TUTORIAL_CLUSTER_GAP_SEC = 2.5;
/** 单步最短时长（更短并入前一步） */
export const TUTORIAL_MIN_STEP_SEC = 1.2;
/** 每个素材的步骤数上限 */
export const TUTORIAL_MAX_STEPS = 12;

export interface TutorialBuildOptions {
  /** 片头卡标题（缺省「操作教程」） */
  title?: string;
  /** 片头卡副文案 */
  subtitle?: string;
  /** 每步标题（下标对应步骤序号-1；缺省的步骤只有步骤号没有标题） */
  stepTitles?: string[];
  /** 结尾卡标题（缺省「搞定！」） */
  outroTitle?: string;
  /** 片头/结尾卡时长（缺省 2.5s） */
  cardSec?: number;
}

export interface TutorialStepInfo {
  /** 步骤序号（1 起，跨素材连续） */
  index: number;
  /** 该步对应素材下标 */
  sourceIndex: number;
  startSec: number;
  endSec: number;
  clickCount: number;
  title: string;
}

export interface TutorialBuildResult {
  segments: Segment[];
  steps: TutorialStepInfo[];
  stats: {stepCount: number; mainSec: number; clickCount: number};
  notes: string[];
}

/** 点击聚簇：返回每簇的首次点击时间（秒，已排序） */
const clusterClicks = (clicks: Array<{t: number}>, gapSec: number): number[] => {
  const sorted = [...clicks].map((c) => c.t / 1000).sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const t of sorted) {
    if (clusters.length === 0 || t - clusters[clusters.length - 1] > gapSec) clusters.push(t);
  }
  return clusters;
};

/** 教程主段 clip（某步的时间窗） */
const tutorialClip = (s: ScreenDemoSourceInput, i: number, start: number, end: number) => ({
  id: `tutorial-${i}`,
  src: s.src,
  name: s.name,
  width: s.width,
  height: s.height,
  duration: s.duration,
  type: 'video' as const,
  trimStart: start,
  trimEnd: end,
  trimmedDuration: end - start,
  muted: true,
  ...(s.track && s.sidecarPath ? {cursorTrack: s.sidecarPath} : {}),
  ...(s.track ? {cursorPoints: s.track.points, cursorClicks: s.track.clicks ?? []} : {}),
});

const textSeg = (id: string, templateId: string, title: string, subtitle: string, features: string[], duration: number, transition: string) =>
  ({
    id,
    templateId,
    videos: [],
    text: {title, subtitle, features, brandName: ''},
    style: {},
    layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
    duration,
    transition,
  }) as unknown as Segment;

/**
 * 构建教程故事板：[片头卡] + ([步骤卡] + [该步导播段]) ×N + [结尾卡]。
 * 步骤切分自点击聚簇（gap ≤2.5s 同步；每步 ≥1.2s，更短并前步；每素材上限 12 步）。
 * 教程无 CTA（不是促销片），结尾是「搞定」收束卡。
 */
export const buildTutorialStoryboard = (
  sources: ScreenDemoSourceInput[],
  opts?: TutorialBuildOptions,
): TutorialBuildResult => {
  const notes: string[] = [];
  const title = (opts?.title || '操作教程').trim() || '操作教程';
  const cardSec = Math.max(1.5, opts?.cardSec ?? 2.5);
  const stepTitles = opts?.stepTitles ?? [];

  const valid = sources.filter((s) => s.src && s.duration > 0.5);
  if (valid.length === 0) {
    return {segments: [], steps: [], stats: {stepCount: 0, mainSec: 0, clickCount: 0}, notes: ['没有有效录屏素材（时长不足 0.5s）']};
  }

  const segments: Segment[] = [];
  const steps: TutorialStepInfo[] = [];
  const now = Date.now();
  const segId = () => `${now}-tu-${Math.random().toString(36).slice(2, 8)}`;

  // 片头卡
  segments.push(textSeg(segId(), 'KineticType', title, opts?.subtitle ?? '', [], cardSec, 'slide'));

  let stepNo = 0;
  let mainSec = 0;
  let clickCount = 0;
  valid.forEach((s, si) => {
    const {trimEnd: tailEnd} = trimEndForTrack(s.duration, s.track);
    const allClicks = s.track?.clicks ?? [];
    const clusters = allClicks.length ? clusterClicks(allClicks, TUTORIAL_CLUSTER_GAP_SEC) : [];

    // 1) 规划窗口：第 i 簇起点-1s → 第 i+1 簇起点-1s；首步从 0 起，末步到尾修点
    let windows: Array<{start: number; end: number; clicks: number}> = [];
    if (clusters.length === 0) {
      notes.push(`「${s.name}」没有点击事件，整段作为一步`);
      windows = [{start: 0, end: tailEnd, clicks: 0}];
    } else {
      if (clusters.length > TUTORIAL_MAX_STEPS) {
        notes.push(`「${s.name}」点击聚簇 ${clusters.length} 个，超出 ${TUTORIAL_MAX_STEPS} 步上限，只取前 ${TUTORIAL_MAX_STEPS} 步`);
      }
      const capped = clusters.slice(0, TUTORIAL_MAX_STEPS);
      windows = capped.map((cStart, k) => {
        const start = k === 0 ? 0 : Math.max(cStart - TUTORIAL_PRE_SEC, 0);
        const rawEnd = k < capped.length - 1 ? Math.max(capped[k + 1] - TUTORIAL_PRE_SEC, start + TUTORIAL_MIN_STEP_SEC) : tailEnd;
        const end = Math.max(start + TUTORIAL_MIN_STEP_SEC, Math.min(rawEnd, tailEnd));
        const nextC = k < capped.length - 1 ? capped[k + 1] : Infinity;
        return {start, end, clicks: allClicks.filter((c) => c.t / 1000 >= cStart && c.t / 1000 < nextC).length};
      });
    }

    // 2) 合并过短步（< MIN）：把窗口并入前一步（扩前一步的 end），避免内容丢失
    const merged: Array<{start: number; end: number; clicks: number}> = [];
    for (const w of windows) {
      if (w.end - w.start < TUTORIAL_MIN_STEP_SEC && merged.length > 0) {
        merged[merged.length - 1].end = w.end;
        merged[merged.length - 1].clicks += w.clicks;
      } else {
        merged.push({...w});
      }
    }

    // 3) 产段：每窗 = [步骤卡] + [导播主段]
    for (const w of merged) {
      stepNo += 1;
      const stepTitle = stepTitles[stepNo - 1] ?? '';
      segments.push(textSeg(segId(), 'TutorialStep', `第 ${stepNo} 步`, stepTitle, [], STEP_CARD_SEC, 'slide'));
      segments.push({
        id: segId(),
        templateId: 'ScreenDemo',
        videos: [tutorialClip(s, si, w.start, w.end)],
        text: {title: stepTitle, subtitle: '', features: [], brandName: ''},
        style: {},
        layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
        duration: w.end - w.start,
        transition: 'crossfade',
      } as unknown as Segment);
      steps.push({index: stepNo, sourceIndex: si, startSec: w.start, endSec: w.end, clickCount: w.clicks, title: stepTitle});
      mainSec += w.end - w.start;
      clickCount += w.clicks;
    }
  });

  // 结尾卡（教程收束，无 CTA）
  segments.push(textSeg(segId(), 'KineticType', opts?.outroTitle?.trim() || '搞定！', '', [], cardSec, 'zoomIn'));

  return {segments, steps, stats: {stepCount: stepNo, mainSec, clickCount}, notes};
};
