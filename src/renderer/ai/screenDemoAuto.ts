/**
 * 录屏即成品 runner：「一段录屏 → 一键成片故事板」（应用按钮与 MCP 工具共用）。
 *
 * 链路：定位素材 → ffprobe 元数据 + 读轨迹 sidecar → buildScreenDemoStoryboard
 * （标题钩子 + ScreenDemo 主段 + CTA）→ 重建故事板 → 自动选 BGM（可选，缺省开）
 * → align_beats 切点吸附（有 BGM 才做）。渲染请求留给用户/agent（request_render）。
 *
 * 与 set_bgm 执行器同款选曲逻辑（曲库扫描 + 波形能量 + 情绪推导），wantEnergy 缺省
 * 'high'——演示片的气质是节奏感；曲库为空/分析失败不阻断成片（只加 note）。
 */

import {buildScreenDemoStoryboard, buildTutorialStoryboard, type ScreenDemoBuildOptions, type TutorialBuildOptions} from '../../shared/screen-demo-auto';
import {classifyMusicMood, energyFromPeaks, rankMusicForMood} from '../../shared/music-mood';
import {suggestBgmTrimStartSec} from '../../shared/bgm-track';
import type {MusicCandidate} from '../../shared/music-mood';
import type {CursorTrackFile} from '../../shared/capture';
import type {Segment} from '../../shared/types';
import {clipSrcToPath, pathToClipSrc} from '../utils/clipPath';

/** runner 需要的 Store 切面（结构化最小接口，完整 ProjectStore 天然兼容） */
export interface ScreenDemoStoreLike {
  segments: Segment[];
  bgm: {path: string} | null;
  applyMontageSegments: (segments: Segment[]) => void;
  setBgm: (bgm: {
    name: string;
    src: string;
    path: string;
    duration: number;
    volume: number;
    fadeIn: number;
    fadeOut: number;
    peaks?: number[];
    beats?: number[];
    bpm?: number;
    /** 媒体截取起点（J-cut 掐前奏默认；不传 = 从头用） */
    trimStartSec?: number;
  } | null) => void;
  alignSegmentsToBeats: (opts?: {tolerance?: number}) => {movedCount: number} | null | undefined;
}

export interface ScreenDemoAutoOptions extends ScreenDemoBuildOptions {
  /** 自动选 BGM（缺省 true）；曲库空/分析失败只加 note 不阻断 */
  withBgm?: boolean;
  /** 选曲情绪偏好（缺省交给能量） */
  wantMood?: Parameters<typeof rankMusicForMood>[1];
  /** 选曲能量偏好（缺省 'high'） */
  wantEnergy?: Parameters<typeof rankMusicForMood>[2];
}

export interface ScreenDemoAutoResult {
  ok: boolean;
  message: string;
  errors?: string[];
  segmentCount?: number;
  shotCount?: number;
  totalSec?: number;
  bgmName?: string | null;
  beatsMovedCount?: number;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

interface ResolvedRecording {
  path: string;
  width: number;
  height: number;
  duration: number;
  track: CursorTrackFile | null;
  sidecarPath: string;
}

/** 定位素材 + 元数据 + 轨迹（runScreenDemoAuto / runTutorialAuto 共用链路） */
const resolveRecording = async (
  store: ScreenDemoStoreLike,
  videoPath: string | null,
): Promise<{ok: true; r: ResolvedRecording} | {ok: false; message: string; errors: string[]}> => {
  let path = videoPath?.trim() || '';
  if (!path) {
    const withVideo = store.segments.find((s) => s.videos.some((v) => v.type === 'video'));
    const clip = withVideo?.videos.find((v) => v.type === 'video' && v.cursorTrack)
      ?? withVideo?.videos.find((v) => v.type === 'video');
    if (!withVideo || !clip || clip.type !== 'video') {
      return {ok: false, message: '没有可用的录屏素材：请传 path，或先把录屏加入故事板', errors: ['找不到视频素材']};
    }
    path = clipSrcToPath(clip.src);
  }
  let width = 1920;
  let height = 1080;
  let duration = 0;
  try {
    const meta = await window.api.getVideoMetadata(path);
    width = meta.width || width;
    height = meta.height || height;
    duration = meta.duration || 0;
  } catch (err) {
    return {ok: false, message: `读取视频元数据失败：${err instanceof Error ? err.message : String(err)}`, errors: ['getVideoMetadata 失败']};
  }
  // 时长兜底：MediaRecorder 的 webm 无 duration 元数据（ffprobe 读 0/NaN，addCaptureToSegment
  // 同款坑）——轨迹 30Hz 采到停录为止，末点时间即实测时长
  const track = await window.api.readCursorTrack(path).catch(() => null);
  if (!(Number.isFinite(duration) && duration > 0.05) && track?.points?.length) {
    duration = track.points[track.points.length - 1].t / 1000;
  }
  if (!(Number.isFinite(duration) && duration > 0.5)) {
    return {ok: false, message: `素材时长过短（${duration.toFixed(1)}s），做不成演示片`, errors: ['duration 过短']};
  }
  return {
    ok: true,
    r: {
      path,
      width,
      height,
      duration,
      track,
      sidecarPath: basename(path).replace(/\.(webm|mp4|mkv|mov|avi)$/i, '.cursor.json'),
    },
  };
};

/** 自动选 BGM + 压拍（两类 runner 共用；曲库空/失败只加 note 不阻断） */
const autoBgmAndAlign = async (
  store: ScreenDemoStoreLike,
  opts: {withBgm?: boolean; wantMood?: Parameters<typeof rankMusicForMood>[1]; wantEnergy?: Parameters<typeof rankMusicForMood>[2]},
  notes: string[],
): Promise<{bgmName: string | null; beatsMovedCount: number}> => {
  let bgmName: string | null = null;
  let beatsMovedCount = 0;
  if (opts.withBgm !== false) {
    try {
      const tracks = await window.api.scanMusicLibrary();
      const candidates: MusicCandidate[] = [];
      for (const t of tracks.slice(0, 40)) {
        let durationSec = 0;
        let peaks: number[] | undefined;
        try {
          const a = await window.api.analyzeMusic(t.path);
          durationSec = a.duration;
          peaks = a.peaks;
        } catch {
          /* 分析失败按未知能量处理 */
        }
        const energy = energyFromPeaks(peaks);
        candidates.push({name: t.name, path: t.path, durationSec, mood: classifyMusicMood(t.name), energy: energy.level, energyAvg: energy.avg});
      }
      const chosen = rankMusicForMood(candidates, opts.wantMood, opts.wantEnergy ?? 'high')[0];
      if (chosen) {
        const httpUrl = await window.api.getVideoHttpUrl(chosen.path);
        const analysis = await window.api.analyzeMusic(chosen.path).catch(() => null);
        store.setBgm({
          name: chosen.name,
          src: httpUrl,
          path: chosen.path,
          duration: chosen.durationSec || analysis?.duration || 0,
          volume: 0.35,
          fadeIn: 0.5,
          fadeOut: 1.5,
          // J-cut 副歌先行（W3 默认）：按波形能量掐前奏直进主体（不足 1.5s 前奏不掐）
          trimStartSec: suggestBgmTrimStartSec(analysis?.peaks, chosen.durationSec || analysis?.duration || 0),
          peaks: analysis?.peaks,
          beats: analysis?.beats,
          bpm: analysis?.bpm,
        });
        bgmName = chosen.name;
      } else {
        notes.push('曲库为空，未配 BGM（可在声音面板指定曲库目录后再加）');
      }
    } catch {
      notes.push('BGM 自动选曲失败（曲库未配置？），可稍后在声音面板添加');
    }
  }
  if (store.bgm) {
    const aligned = store.alignSegmentsToBeats({tolerance: 0.12});
    beatsMovedCount = aligned?.movedCount ?? 0;
  }
  return {bgmName, beatsMovedCount};
};

/**
 * 执行一键编排。
 * @param store 项目 Store（或结构兼容切面）
 * @param videoPath 录屏文件绝对路径；null = 用当前故事板第一个视频素材（优先带轨迹的）
 */
export const runScreenDemoAuto = async (
  store: ScreenDemoStoreLike,
  videoPath: string | null,
  opts: ScreenDemoAutoOptions = {},
): Promise<ScreenDemoAutoResult> => {
  // 1. 定位素材 + 元数据 + 轨迹
  const res = await resolveRecording(store, videoPath);
  if (!res.ok) return {ok: false, message: res.message, errors: res.errors};
  const {path, width, height, duration, track, sidecarPath} = res.r;

  // 2. 构建故事板（钩子 + ScreenDemo 主段 + CTA）
  const src = await pathToClipSrc(path);
  const built = buildScreenDemoStoryboard(
    [{src, name: basename(path), width, height, duration, track, sidecarPath}],
    opts,
  );
  if (built.segments.length === 0) {
    return {ok: false, message: built.notes.join('；') || '编排失败', errors: built.notes};
  }
  store.applyMontageSegments(built.segments);

  // 3. BGM 自动链（可选）：选曲 → setBgm → align_beats
  const notes = [...built.notes];
  const {bgmName, beatsMovedCount} = await autoBgmAndAlign(store, opts, notes);

  const totalSec = built.segments.reduce((n, s) => n + (s.duration || 0), 0);
  const parts = [
    `已生成「录屏即成品」故事板：标题钩子 + 导播主段（${built.stats.shotCount} 镜头 / ${built.stats.mainSec.toFixed(1)}s${built.stats.tailTrimmedSec > 0.05 ? `，尾部修剪 ${built.stats.tailTrimmedSec.toFixed(1)}s` : ''}）+ CTA，全片约 ${Math.round(totalSec)}s`,
  ];
  if (bgmName) parts.push(`BGM「${bgmName}」${beatsMovedCount > 0 ? `+ ${beatsMovedCount} 个切点已压拍` : ''}`);
  const message = `${parts.join('；')}。可在故事板微调文案后直接渲染${notes.length > 0 ? `。${notes.join('；')}` : ''}`;
  return {ok: true, message, segmentCount: built.segments.length, shotCount: built.stats.shotCount, totalSec: Math.round(totalSec * 10) / 10, bgmName, beatsMovedCount};
};

export interface TutorialAutoOptions extends TutorialBuildOptions {
  /** 自动选 BGM（缺省 true，能量偏好缺省 mid——教程气质平稳） */
  withBgm?: boolean;
  wantMood?: Parameters<typeof rankMusicForMood>[1];
  wantEnergy?: Parameters<typeof rankMusicForMood>[2];
}

export interface TutorialAutoResult {
  ok: boolean;
  message: string;
  errors?: string[];
  segmentCount?: number;
  stepCount?: number;
  totalSec?: number;
  steps?: Array<{index: number; startSec: number; endSec: number; clickCount: number; title: string}>;
  bgmName?: string | null;
  beatsMovedCount?: number;
}

/**
 * 教程一键编排：一段操作录屏 → [片头卡] + ([步骤卡]+[导播段]) ×N + [结尾卡]。
 * 步骤切分自点击聚簇；stepTitles 可由调用方（LLM）逐步命名。
 */
export const runTutorialAuto = async (
  store: ScreenDemoStoreLike,
  videoPath: string | null,
  opts: TutorialAutoOptions = {},
): Promise<TutorialAutoResult> => {
  const res = await resolveRecording(store, videoPath);
  if (!res.ok) return {ok: false, message: res.message, errors: res.errors};
  const {path, width, height, duration, track, sidecarPath} = res.r;

  const src = await pathToClipSrc(path);
  const built = buildTutorialStoryboard(
    [{src, name: basename(path), width, height, duration, track, sidecarPath}],
    opts,
  );
  if (built.segments.length === 0) {
    return {ok: false, message: built.notes.join('；') || '编排失败', errors: built.notes};
  }
  store.applyMontageSegments(built.segments);

  const notes = [...built.notes];
  const {bgmName, beatsMovedCount} = await autoBgmAndAlign(
    store,
    {withBgm: opts.withBgm, wantMood: opts.wantMood, wantEnergy: opts.wantEnergy ?? 'mid'},
    notes,
  );

  const totalSec = built.segments.reduce((n, s) => n + (s.duration || 0), 0);
  const parts = [
    `已生成教程故事板：${built.stats.stepCount} 步（步骤卡 + 导播演示段交替），主内容 ${built.stats.mainSec.toFixed(1)}s、共 ${built.stats.clickCount} 次点击，全片约 ${Math.round(totalSec)}s`,
  ];
  if (bgmName) parts.push(`BGM「${bgmName}」${beatsMovedCount > 0 ? `+ ${beatsMovedCount} 个切点已压拍` : ''}`);
  parts.push('步骤标题可在故事板「文字」页逐步补全（副标题 = 这一步做什么）');
  const message = `${parts.join('；')}。建议 request_render 渲染后 review_render 审片${notes.length > 0 ? `。${notes.join('；')}` : ''}`;
  return {
    ok: true,
    message,
    segmentCount: built.segments.length,
    stepCount: built.stats.stepCount,
    totalSec: Math.round(totalSec * 10) / 10,
    steps: built.steps.map((s) => ({index: s.index, startSec: Math.round(s.startSec * 10) / 10, endSec: Math.round(s.endSec * 10) / 10, clickCount: s.clickCount, title: s.title})),
    bgmName,
    beatsMovedCount,
  };
};
