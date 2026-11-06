/**
 * TimelinePanel - 剪辑软件式时间轴（P2.5 阶段二「时间线作为视图」；pro 模式高级功能）
 *
 * 故事板的 NLE 投影：segment 仍是存储主键，本组件只读投影 + 直写既有字段，零渲染管线改动
 * （布局数学与渲染同源：转场块 = computeTransitionWindows 骑跨窗，音效标记 = planSfxPlacements）。
 *
 * 轨道（上→下）：
 * - 标尺：时间刻度 + BGM 节拍点 ● + 播放头（拖拽定位，松手选中所在片段）；
 * - 视频：片段块宽∝时长（拖右缘调时长、整块拖拽重排），段间转场块骑跨切点
 *   （拖宽度 = 转场时长，点击弹层编辑类型/时长/音效 = 视频+音频双轨转场）；
 * - 旁白：段旁白音频块（从段起点起，跨段溢出如实显示——渲染同口径）；
 * - 音乐：BGM 波形（peaks 平铺循环）+ 淡入/淡出手柄（拖拽调 fadeIn/fadeOut）+ 音量/静音；
 * - 音效：转场音效 ◆ / 节拍重音 ● / 轻点 · / 片头 ▮（与 SfxLane 同源摆放，按同一比例尺）。
 *
 * 工具行：迷你整片监视器（MultiSegmentPromo + 轻量预览，播放头双向联动）、
 * 播放头拆分（splitSegment）、磁性吸附开关（节拍 + 片段边界/播放头/BGM 起播）、
 * 撤销/重做、缩放（−/适配/+ 与 Ctrl+滚轮光标锚缩放）。
 * v5 交互档：Delete/S 快捷键、片段块胶片条缩略图（视频/图片）与文字预览、
 * 音效试听（变体/音量与导出同源）、底部整片概览条（minimap 视口导航）、
 * 音效轨可折叠、旁白轨波形（analyzeAudio peaks）。
 *
 * v5 代契约：不改 AI 工具面与 storyboard schema；写路径全走 store 既有字段
 * （updateSegmentDirect / reorderSegments / splitSegment / updateBgm / setSfx）。
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Player, type PlayerRef} from '@remotion/player';
import {
  Play, Pause, X, ZoomIn, ZoomOut, Maximize2, Scissors, Magnet, Sparkles,
  Video, Mic, Music, AudioLines, Volume2, VolumeX, Clock, Plus, Copy, Trash2,
  Undo2, Redo2, Film, RefreshCw, Type, History as HistoryIcon, Zap,
} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import {useUIStore} from '../store/uiStore';
import {
  computeTimelineLayout, findClipIndexAt, clampSegmentDuration, clampTimelineTransitionSec,
  clampNarrationOffsetSec, snapSecMagnetic, medianBeatSec, planRulerTicks, formatTimelineTc, TIMELINE_FPS,
  MIN_SEGMENT_SEC, MAX_SEGMENT_SEC,
} from '../../shared/timeline-layout';
import {bgmStartAtSec, bgmTrimStartSec, bgmTrimEndSec, bgmLoopSpanSec, bgmTimelineBeats, normalizeBgmVolumeKeys} from '../../shared/bgm-track';
import {computeShotTimeline} from '../../shared/shot-timeline';
import {planSfxPlacements, SFX_KIND_META, SFX_KIND_GAIN, TRANSITION_SFX_KIND, SFX_LEAD_SEC, SFX_CLIP_VISUAL_SEC, assignSfxClipLanes, sfxClipVariant, clampSfxClipVolume} from '../../shared/sfx-plan';
import {getTransitionDefaultSec, getOutroFadeFrames, snapTransitionSecToBeats, DEFAULT_TRANSITION_PRESET} from '../../shared/transition-style';
import {projectSegmentPlan} from '../../shared/plan-projection';
import {solveCaptionText, solveCaptionWindow, effectiveCaptionWindows} from '../../shared/plan-writeback';
import {presetCurve, type EasingCurve} from '../../shared/easing-curve';
import {CurveEditorModal} from './CurveEditorModal';
import {MultiSegmentPromo} from '../../remotion/main/MultiSegmentPromo';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {isRawOutputTemplate, mergeTemplateMetas} from '../../shared/template-registry';
import {FPS} from '../../remotion/config/resolutions';
import {toLocalVideoUrl} from './RemotionPreviewPlayer';
import {getSfxSources} from '../sfx/sfxSources';
import {useStartRender} from '../hooks/useStartRender';
import {TRANSITION_OPTIONS, type MultiSegmentProps, type SfxSources, type SfxKind, type SfxClip, type TransitionType, type BgmTrack} from '../../shared/types';
import './TimelinePanel.css';

const LABEL_W = 64;
const RIGHT_PAD = 48;
/** 右键菜单时长微调 ±0.5s 的禁用边界（与钳制上下限同口径，留一个步进余量） */
const MAX_DUR_EPS = MAX_SEGMENT_SEC - 0.05;
const MIN_DUR_EPS = MIN_SEGMENT_SEC + 0.05;
/** 变体数近似（只影响缺货降级判定；真值按音效库表在渲染管线里算，与 SfxLane 同注释） */
const APPROX_VARIANT_COUNTS: Record<SfxKind, number> = {whoosh: 6, swish: 5, sweep: 4, drop: 5, impact: 5, riser: 3, click: 4, pop: 2, ding: 2};
const OUTRO_FADE = getOutroFadeFrames(FPS);

/** 旁白 peaks 会话缓存（narration.path → 波形数组）：切视图重挂组件不重复解码（ffmpeg 有成本） */
const narrPeaksCache = new Map<string, number[]>();

/** 一次性窗口拖拽（pointerup/pointercancel 自动解绑；组件卸载兜底解绑，防悬挂监听） */
const useWindowDrag = () => {
  const cleanupRef = useRef<(() => void) | null>(null);
  const start = useCallback((onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) => {
    const move = (ev: PointerEvent) => onMove(ev);
    const up = (ev: PointerEvent) => {
      cleanupRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // pointercancel（窗口失焦/触控中断）按 pointerup 收尾，否则拖拽状态悬挂
    window.addEventListener('pointercancel', up);
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);
  useEffect(() => () => cleanupRef.current?.(), [cleanupRef]); // eslint-disable-line react-hooks/exhaustive-deps
  return start;
};

export const TimelinePanel: React.FC = () => {
  const startWindowDrag = useWindowDrag();
  // ---- store（读按字段订阅，避免无关状态触发重渲）----
  const segments = useProjectStore((s) => s.segments);
  const activeSegmentIndex = useProjectStore((s) => s.activeSegmentIndex);
  const bgm = useProjectStore((s) => s.bgm);
  const sfx = useProjectStore((s) => s.sfx);
  const orientation = useProjectStore((s) => s.orientation);
  const aspectRatioId = useProjectStore((s) => s.aspectRatioId);
  const customTemplates = useProjectStore((s) => s.customTemplates);
  const marketTemplates = useProjectStore((s) => s.marketTemplates);
  const generatedTemplates = useProjectStore((s) => s.generatedTemplates);
  const logo = useProjectStore((s) => s.logo);
  const captionStyle = useProjectStore((s) => s.captionStyle);
  const finePrint = useProjectStore((s) => s.finePrint);
  const colorGrade = useProjectStore((s) => s.colorGrade);
  const brandColor = useProjectStore((s) => s.brandColor);
  const fontMood = useProjectStore((s) => s.fontMood);
  const texture = useProjectStore((s) => s.texture);
  const beatPulse = useProjectStore((s) => s.beatPulse);
  const cursor = useProjectStore((s) => s.cursor);
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const setActiveSegmentIndex = useProjectStore((s) => s.setActiveSegmentIndex);
  const loadSegmentToCurrent = useProjectStore((s) => s.loadSegmentToCurrent);
  const syncCurrentToSegment = useProjectStore((s) => s.syncCurrentToSegment);
  const addSegment = useProjectStore((s) => s.addSegment);
  const duplicateSegment = useProjectStore((s) => s.duplicateSegment);
  const removeSegment = useProjectStore((s) => s.removeSegment);
  const updateSegmentDirect = useProjectStore((s) => s.updateSegmentDirect);
  // 拖拽括号内的逐帧原始写（薄壳化后 updateSegmentDirect=命令壳，逐帧走壳=逐帧灌史）
  const writeSegmentTiming = useProjectStore((s) => s.writeSegmentTiming);
  const updateSegmentNarration = useProjectStore((s) => s.updateSegmentNarration);
  // M1.5 切片二命令通道：离散编辑直接命令；拖拽 beginDragTransaction 括号（逐帧直写豁免防抖、释放一笔事务）
  const runTimelineCommand = useProjectStore((s) => s.runTimelineCommand);
  const beginDragTransaction = useProjectStore((s) => s.beginDragTransaction);
  // M2 回写环：排版字幕窗冻结复合写 + 拖拽括号内逐帧直写
  const applySegmentPlanFreeze = useProjectStore((s) => s.applySegmentPlanFreeze);
  const writeSegmentCaptionWindows = useProjectStore((s) => s.writeSegmentCaptionWindows);
  const updateSegmentVideoTrim = useProjectStore((s) => s.updateSegmentVideoTrim);
  // M3 L2：节拍标记原始写（拖拽括号内逐帧直写）
  const writeSegmentBeats = useProjectStore((s) => s.writeSegmentBeats);
  const historyPast = useProjectStore((s) => s.historyPast);
  const [historyOpen, setHistoryOpen] = useState(false);
  const updateBgm = useProjectStore((s) => s.updateBgm);
  const updateSegmentVideoAudio = useProjectStore((s) => s.updateSegmentVideoAudio);
  const lastRenderInfo = useProjectStore((s) => s.lastRenderInfo);
  const setSfx = useProjectStore((s) => s.setSfx);
  const updateSfxClip = useProjectStore((s) => s.updateSfxClip);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore((s) => s.historyPast.length > 0);
  const canRedo = useProjectStore((s) => s.historyFuture.length > 0);
  const setStatusText = useUIStore((s) => s.setStatusText);
  // 监视器/右栏预览状态（uiStore：跨组件共享 + 持久化，v4）
  const monitorOpen = useUIStore((s) => s.monitorOpen);
  const monitorWidth = useUIStore((s) => s.monitorWidth);
  const monitorPos = useUIStore((s) => s.monitorPos);
  const rightPreview = useUIStore((s) => s.rightPreview);
  const setMonitorOpen = useUIStore((s) => s.setMonitorOpen);
  const setMonitorWidth = useUIStore((s) => s.setMonitorWidth);
  const setMonitorPos = useUIStore((s) => s.setMonitorPos);
  const dockMonitor = useUIStore((s) => s.dockMonitor);
  const undockMonitor = useUIStore((s) => s.undockMonitor);

  // ---- 布局（与渲染同源的投影）----
  const layout = useMemo(() => computeTimelineLayout(segments), [segments]);
  // 时间轴坐标的拍（BGM 起播点/截取映射；缺省字段 = 媒体拍原样，v1 行为不变）
  const beats = useMemo(() => bgmTimelineBeats(bgm), [bgm]);
  const allTemplates = useMemo(
    () => mergeTemplateMetas(customTemplates, marketTemplates, generatedTemplates),
    [customTemplates, marketTemplates, generatedTemplates],
  );
  const templateName = useCallback(
    (templateId: string) => allTemplates.find((t) => t.id === templateId)?.name ?? templateId,
    [allTemplates],
  );
  // shot 投影（与 get_timeline.shots 同源；可渲染谓词与渲染端 isSegmentRenderable 同义）
  const shotTimeline = useMemo(
    () =>
      computeShotTimeline(segments, {
        isRenderable: (seg) => allTemplates.some((t) => t.id === seg.templateId),
      }),
    [segments, allTemplates],
  );

  // ---- 缩放 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(600);
  const [pxPerSec, setPxPerSec] = useState(30);
  const [fitMode, setFitMode] = useState(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const fitPxPerSec = useCallback(
    (totalSec: number) => Math.max(3, Math.min(150, (viewportW - LABEL_W - RIGHT_PAD) / Math.max(1, totalSec))),
    [viewportW],
  );
  useEffect(() => {
    if (fitMode) setPxPerSec(fitPxPerSec(layout.totalSec));
  }, [fitMode, fitPxPerSec, layout.totalSec]);
  // fit 退出的同步护栏：setFitMode(false) 要到下一帧渲染才生效，期间段时长更新触发的
  // fit effect 会用旧 fit 公式再缩一次比例尺（指针→秒映射跳变 = 拖右缘头几帧非单调抽搐）
  const fitSuppressedRef = useRef(false);
  useEffect(() => {
    if (fitMode && fitSuppressedRef.current) return; // 拖拽刚请求退出 fit：挡住过渡帧的 fit 重算
    if (fitMode) setPxPerSec(fitPxPerSec(layout.totalSec));
  }, [fitMode, fitPxPerSec, layout.totalSec]);
  const contentWidth = Math.max(layout.totalSec * pxPerSec + RIGHT_PAD, viewportW - LABEL_W);

  // ---- Ctrl+滚轮缩放（光标为锚）：React onWheel 是 passive（preventDefault 无效），
  // 且 Chromium 的 Ctrl+滚轮默认整页缩放——必须原生非 passive 监听才能拦下 ----
  const pxPerSecRef = useRef(pxPerSec);
  useEffect(() => {
    pxPerSecRef.current = pxPerSec;
  }, [pxPerSec]);
  const zoomAnchorRef = useRef<{tAt: number; anchorX: number} | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        // 轨道区纵向几乎无溢出：普通滚轮转横向滚动（Shift+滚轮仍走原生横滚；触控板 deltaX 原生）
        if (el.scrollHeight <= el.clientHeight + 1) {
          const dx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (dx !== 0) {
            e.preventDefault();
            el.scrollLeft += dx;
          }
        }
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      zoomAnchorRef.current = {
        tAt: Math.max(0, (anchorX + el.scrollLeft - LABEL_W) / pxPerSecRef.current),
        anchorX,
      };
      fitSuppressedRef.current = true;
      setFitMode(false);
      // 指数步进：滚轮一格约 ±25%，触控板小增量连续缩放
      setPxPerSec((v) => Math.max(3, Math.min(150, Math.exp(Math.log(v) - e.deltaY * 0.0022))));
    };
    el.addEventListener('wheel', onWheel, {passive: false});
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // 缩放生效后把锚点时间放回光标下（此刻 contentWidth 已按新比例铺开）
  useEffect(() => {
    const a = zoomAnchorRef.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = Math.max(0, a.tAt * pxPerSec + LABEL_W - a.anchorX);
  }, [pxPerSec]);
  // 缩放按钮：以视口中心的时间点为锚（与 Ctrl+滚轮同机制）——缩放前后正在看的内容不飞走
  const zoomAtCenter = useCallback((scale: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const anchorX = LABEL_W + (rect.width - LABEL_W) / 2;
    zoomAnchorRef.current = {
      tAt: Math.max(0, (anchorX + el.scrollLeft - LABEL_W) / pxPerSecRef.current),
      anchorX,
    };
    fitSuppressedRef.current = true;
    setFitMode(false);
    setPxPerSec((v) => Math.max(3, Math.min(150, v * scale)));
  }, []);

  // ---- 播放头 / 吸附 ----
  const [playheadSec, setPlayheadSec] = useState(0);
  const playheadRef = useRef(0);
  useEffect(() => {
    playheadRef.current = playheadSec;
  }, [playheadSec]);
  const [snapOn, setSnapOn] = useState(true);
  const snapThresholdSec = 8 / pxPerSec;
  const beatSec = useMemo(() => medianBeatSec(beats), [beats]);
  // 边界类吸附目标：片段边界 / 片尾 / BGM 起播点（播放头拖拽中动态，调用时并入）
  const magneticTargets = useMemo(() => {
    const t: number[] = [0, layout.totalSec];
    for (const c of layout.clips) t.push(c.startSec, c.endSec);
    if (bgm) t.push(bgmStartAtSec(bgm));
    return t;
  }, [layout, bgm]);
  // 磁性吸附：节拍点与边界目标同权竞争，阈值内取最近（snapSecMagnetic 纯函数）
  const maybeSnap = useCallback(
    (sec: number) =>
      snapOn ? snapSecMagnetic(sec, beats, [...magneticTargets, playheadRef.current], snapThresholdSec) : sec,
    [snapOn, beats, magneticTargets, snapThresholdSec],
  );
  const secFromClientX = useCallback(
    (clientX: number, opts?: {unclamped?: boolean}): number => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft - LABEL_W;
      const sec = x / pxPerSec;
      // 缺省钳在全片内（播放头/标尺/块体拖拽的语义）；右缘拖时长等「拖出片尾延长全片」
      // 的调用方传 unclamped——且不能钳：拖动闭包捕获的是当次渲染的 layout，
      // totalSec 不更新的话指针永远出不了旧片尾（=右缘只能减不能加的根因）
      return opts?.unclamped ? Math.max(0, sec) : Math.max(0, Math.min(layout.totalSec, sec));
    },
    [pxPerSec, layout.totalSec],
  );
  const selectSegment = useCallback(
    (index: number) => {
      syncCurrentToSegment();
      loadSegmentToCurrent(index);
    },
    [syncCurrentToSegment, loadSegmentToCurrent],
  );

  // ---- 拖拽反馈（各拖拽共用）：光标处数值气泡 + 吸附命中指示线 ----
  const [dragTip, setDragTip] = useState<{x: number; y: number; text: string} | null>(null);
  const [snapHintSec, setSnapHintSec] = useState<number | null>(null);
  const endDragFeedback = useCallback(() => {
    setDragTip(null);
    setSnapHintSec(null);
  }, []);
  // 横向拖拽的视口自动跟随：指针距滚动区左/右缘 80px 内时步进滚（拖出视口继续操作不中断）
  const followX = useCallback((clientX: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const fromRight = rect.right - clientX;
    const fromLeft = clientX - rect.left - LABEL_W;
    if (fromRight < 80) el.scrollLeft += Math.min(28, 80 - fromRight);
    else if (fromLeft < 80) el.scrollLeft -= Math.min(28, 80 - fromLeft);
  }, []);

  // ---- 整片监视器（v4：浮窗可拖动/8 向等比缩放，拖到右侧预览区停靠成大窗）----
  const docked = rightPreview === 'full';
  const monitorMounted = monitorOpen || docked;
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<PlayerRef>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const monitorFloatRef = useRef<HTMLDivElement>(null);
  // 停靠槽（StoryboardEditor 右栏在全片模式下渲染；同一提交内先于本组件 effect 出现）
  const [dockSlot, setDockSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!docked) {
      setDockSlot(null);
      return;
    }
    const find = () => document.querySelector<HTMLElement>('[data-dock-monitor-slot]');
    const el = find();
    if (el) setDockSlot(el);
    else {
      // 首次停靠与右栏同帧渲染：下一帧再找一次兜底
      const raf = requestAnimationFrame(() => setDockSlot(find()));
      return () => cancelAnimationFrame(raf);
    }
  }, [docked]);
  const [sfxSources, setSfxSources] = useState<SfxSources | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!monitorMounted) return;
    getSfxSources().then((src) => {
      if (cancelled) return;
      setSfxSources(
        Object.fromEntries(
          Object.entries(src).map(([k, arr]) => [k, arr.map(toLocalVideoUrl)]),
        ) as SfxSources,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [monitorMounted]);
  // 监视器打开/停靠（播放器重挂载）时定位到当前播放头（此后播放头以播放器为准）
  useEffect(() => {
    if (monitorMounted && (dockSlot || !docked)) playerRef.current?.seekTo(Math.round(playheadRef.current * FPS));
  }, [monitorMounted, docked, dockSlot]);
  const monitorInputProps = useMemo(
    () =>
      ({
        segments: segments.map((seg) => ({
          ...seg,
          videos: seg.videos.map((v) => ({...v, src: toLocalVideoUrl(v.src)})),
        })),
        orientation,
        customTemplates: [...customTemplates, ...marketTemplates.map((t) => t.def)],
        generatedTemplates,
        bgm: bgm ? {...bgm, src: toLocalVideoUrl(bgm.src)} : null,
        logo: logo ? {...logo, src: toLocalVideoUrl(logo.src)} : logo,
        captionStyle,
        finePrint,
        colorGrade,
        brandColor,
        fontMood,
        sfx,
        ...(sfxSources ? {sfxSources} : {}),
        texture,
        beatPulse,
        cursor,
        licensed: licenseStatus ? licenseStatus.entitlement === 'licensed' : true,
        // 监视器常驻编辑页：轻量硬切消双解码卡顿（与导出页「轻量预览」同开关语义，成片不受影响）
        previewLiteCut: true,
      }) as MultiSegmentProps,
    [segments, orientation, customTemplates, marketTemplates, generatedTemplates, bgm, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood, sfx, sfxSources, texture, beatPulse, cursor, licenseStatus],
  );
  const monitorDuration = useMemo(() => {
    const total = segments.reduce((sum, seg) => sum + Math.round((seg.duration || 8) * FPS), 0);
    const lastRaw = isRawOutputTemplate(segments[segments.length - 1]?.templateId);
    return Math.max(1, total + (lastRaw ? 0 : OUTRO_FADE));
  }, [segments]);
  // 播放头 ← 播放器帧回调（打开监视器后播放头以播放器为准；停靠模式同样驱动）
  useEffect(() => {
    if (!monitorMounted) return;
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: {detail: {frame: number}}) => {
      const sec = e.detail.frame / FPS;
      setPlayheadSec(sec);
      // 播放追帧：播放头快出右缘时滚动时间轴
      const el = scrollRef.current;
      if (el && playing) {
        const px = sec * pxPerSec;
        if (px > el.scrollLeft + el.clientWidth - LABEL_W - 60) {
          el.scrollLeft = px - (el.clientWidth - LABEL_W) + 60;
        }
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [monitorMounted, playing, pxPerSec]);
  const seekPlayer = useCallback((sec: number) => {
    playerRef.current?.seekTo(Math.round(sec * FPS));
  }, []);
  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pause();
    else p.play();
  }, [playing]);

  // ---- 监视器浮窗：拖头移动 / 8 向等比缩放 / 拖到右侧预览区停靠 ----
  const MONITOR_HEAD_H = 26;
  const aspectRatioValue = getAspectRatioPreset(aspectRatioId).width / getAspectRatioPreset(aspectRatioId).height;
  const monitorBoxH = useCallback((w: number) => Math.round(w / aspectRatioValue) + MONITOR_HEAD_H, [aspectRatioValue]);
  const clampMonitorPos = useCallback(
    (left: number, top: number, w: number) => {
      const W = panelRef.current?.clientWidth ?? 1200;
      const H = panelRef.current?.clientHeight ?? 420;
      return {
        left: Math.max(0, Math.min(Math.max(0, W - w), Math.round(left))),
        top: Math.max(0, Math.min(Math.max(0, H - monitorBoxH(w) - 2), Math.round(top))),
      };
    },
    [monitorBoxH],
  );
  // 指针是否落在右侧预览画布上（停靠目标）
  const overPreviewPane = useCallback((x: number, y: number) => {
    const pane = document.querySelector('.editor-right .preview-canvas');
    if (!pane) return false;
    const r = pane.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }, []);
  const [draggingMonitor, setDraggingMonitor] = useState(false);
  const onMonitorHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || docked) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const el = monitorFloatRef.current;
    const panel = panelRef.current;
    if (!el || !panel) return;
    const rect = el.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const grabLeft = rect.left - panelRect.left;
    const grabTop = rect.top - panelRect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    setDraggingMonitor(true);
    startWindowDrag(
      (ev) => {
        const c = clampMonitorPos(grabLeft + (ev.clientX - startX), grabTop + (ev.clientY - startY), monitorWidth);
        setMonitorPos(c);
        document.documentElement.classList.toggle('tl-dock-hover', overPreviewPane(ev.clientX, ev.clientY));
      },
      (ev) => {
        setDraggingMonitor(false);
        document.documentElement.classList.remove('tl-dock-hover');
        if (overPreviewPane(ev.clientX, ev.clientY)) {
          dockMonitor();
          setStatusText('整片监视器已停靠到右侧预览（下拉框可切回片段预览，小窗自动恢复）');
        }
      },
    );
  };
  // 等比缩放：宽度是唯一自由量（高度由画幅比例跟随）；西/北向手柄同时回拉左/上缘
  const onMonitorResizeDown = (e: React.PointerEvent, dir: string) => {
    if (e.button !== 0 || docked) return;
    e.preventDefault();
    e.stopPropagation();
    const el = monitorFloatRef.current;
    const panel = panelRef.current;
    if (!el || !panel) return;
    const rect = el.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const left0 = rect.left - panelRect.left;
    const top0 = rect.top - panelRect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    const w0 = monitorWidth;
    const h0 = monitorBoxH(w0);
    startWindowDrag(
      (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const east = dir.includes('e');
        const west = dir.includes('w');
        const north = dir.includes('n');
        const south = dir.includes('s');
        // 各轴对「宽度增量」的贡献（向外拖为正），取扩张更大的一轴（角柄双向）
        const cand: number[] = [];
        if (east || west) cand.push(east ? dx : -dx);
        if (north || south) cand.push((south ? dy : -dy) * aspectRatioValue);
        const dw = cand.length > 0 ? Math.max(...cand) : 0;
        const w = Math.max(200, Math.min(640, w0 + dw));
        // 西/北向手柄锚定右/下缘：宽度变化量由左/上缘吸收
        const c = clampMonitorPos(left0 + (west ? w0 - w : 0), top0 + (north ? h0 - monitorBoxH(w) : 0), w);
        setMonitorWidth(w);
        setMonitorPos(c);
      },
      () => {
        /* 拖拽中已实时写入 */
      },
    );
  };

  // ---- 标尺拖拽（定位播放头；松手选中所在片段）----
  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const apply = (clientX: number) => {
      const sec = secFromClientX(clientX);
      setPlayheadSec(sec);
      if (monitorOpen) seekPlayer(sec);
      return sec;
    };
    apply(e.clientX);
    startWindowDrag(
      (ev) => {
        const sec = apply(ev.clientX);
        setDragTip({x: ev.clientX + 12, y: ev.clientY + 18, text: formatTimelineTc(sec)});
        followX(ev.clientX);
      },
      () => {
        endDragFeedback();
        const idx = findClipIndexAt(layout, playheadRef.current);
        if (idx >= 0 && idx !== activeSegmentIndex) selectSegment(idx);
      },
    );
  };

  // ---- 片段块：点击选中 / 整块拖拽重排 / 右缘拖拽调时长 ----
  const [dragOver, setDragOver] = useState<{from: number; insert: number} | null>(null);
  const onClipPointerDown = (e: React.PointerEvent, segIndex: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tl-clip-resize')) return; // 缘柄有自己的处理器
    const startX = e.clientX;
    let isMove = false;
    let insert = segIndex;
    startWindowDrag(
      (ev) => {
        if (!isMove && Math.abs(ev.clientX - startX) < 6) return;
        if (!isMove) isMove = true;
        followX(ev.clientX);
        const pointerSec = secFromClientX(ev.clientX);
        const j = findClipIndexAt(layout, pointerSec);
        const c = layout.clips[j];
        if (c) insert = pointerSec > (c.startSec + c.endSec) / 2 ? j + 1 : j;
        setDragOver({from: segIndex, insert});
      },
      () => {
        if (!isMove) {
          selectSegment(segIndex);
          return;
        }
        setDragOver(null);
        if (insert === segIndex || insert === segIndex + 1) return;
        const to = insert > segIndex ? insert - 1 : insert;
        runTimelineCommand({kind: 'moveSegment', index: segIndex, to});
      },
    );
  };
  const onResizeHandleDown = (e: React.PointerEvent, segIndex: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // fit 模式下拖右缘是自相矛盾的：本段变长 → totalSec 增 → fit 反算把 pxPerSec 缩小 →
    // 时间轴总宽恒等于视口宽，块右边界在屏幕上钉死在内容右端不跟手，且拖动闭包的旧
    // 比例尺与新渲染错位（指针到窗口右缘时长大被封顶——「只能减不能加」的完整机理）。
    // 退出 fit 固化当前比例尺：拖动全程一个比例，块边界跟手，内容真实变宽可滚。
    fitSuppressedRef.current = true; // 同步护栏：挡住 setFitMode(false) 生效前的过渡帧 fit 重算
    setFitMode(false);
    // clipStart 在拖动中稳定（本段时长变化不移动本段起点）；sec 用 unclamped——
    // 增加时长 = 拖出当前片尾延长全片，钳 totalSec 会让指针永远到不了更远处
    const clipStart = layout.clips[segIndex]?.startSec ?? 0;
    const commitDrag = beginDragTransaction('拖拽片段时长'); // 拖拽事务：逐帧直写豁免防抖，释放一笔入史
    startWindowDrag(
      (ev) => {
        followX(ev.clientX); // 视口跟随：时长可拖出旧片尾后，还得能拖出视口
        const sec = secFromClientX(ev.clientX, {unclamped: true});
        const raw = clampSegmentDuration(sec - clipStart);
        const cut = maybeSnap(clipStart + raw);
        const dur = clampSegmentDuration(cut - clipStart);
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `${dur.toFixed(1)}s`});
        setSnapHintSec(snapOn && cut !== clipStart + raw ? cut : null); // 吸附命中亮线（吸到边界/节拍/播放头）
        const cur = segments[segIndex]?.duration ?? 8;
        if (dur !== cur) writeSegmentTiming(segIndex, {duration: dur});
      },
      () => {
        commitDrag();
        const final = useProjectStore.getState().segments[segIndex]?.duration;
        if (final != null) setStatusText(`第 ${segIndex + 1} 片段时长 ${final.toFixed(1)}s（Ctrl+Z 可撤销）`);
        endDragFeedback();
      },
    );
  };

  // ---- 转场块：点击选中边界（弹层）/ 拖宽度 = 时长 ----
  const [selectedBoundary, setSelectedBoundary] = useState<number | null>(null);
  // 弹层「缓动曲线」入口：非空 = 该边界的转场打开曲线大窗
  const [curveFor, setCurveFor] = useState<number | null>(null);
  // 弹层屏幕坐标（fixed 定位在滚动容器外，不被 overflow 裁剪；滚动/缩放/时长变化时重算）
  const [popPos, setPopPos] = useState<{left: number; top: number} | null>(null);
  useEffect(() => {
    if (selectedBoundary == null || selectedBoundary >= segments.length - 1) {
      setPopPos(null);
      return;
    }
    const compute = () => {
      const el = scrollRef.current;
      const b = layout.transitions[selectedBoundary];
      if (!el || !b) return;
      const rect = el.getBoundingClientRect();
      const left = Math.max(
        rect.left + 4,
        Math.min(rect.left + LABEL_W + b.cutSec * pxPerSec - el.scrollLeft - 100, rect.right - 232),
      );
      // 标尺（26）+ 视频轨（54）下缘；下缘留出弹层自身高度防出窗
      const top = Math.min(rect.top + 26 + 54 + 6, window.innerHeight - 190);
      setPopPos({left, top});
    };
    compute();
    const el = scrollRef.current;
    el?.addEventListener('scroll', compute);
    window.addEventListener('resize', compute);
    return () => {
      el?.removeEventListener('scroll', compute);
      window.removeEventListener('resize', compute);
    };
  }, [selectedBoundary, layout, pxPerSec]);
  const onTransitionPointerDown = (e: React.PointerEvent, segIndex: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const grabSec = secFromClientX(e.clientX);
    const startDur =
      segments[segIndex]?.transitionParams?.durationSec ??
      getTransitionDefaultSec(segments[segIndex]?.transition ?? 'crossfade') ??
      0.5;
    let moved = false;
    const commitDrag = beginDragTransaction('拖拽转场时长');
    startWindowDrag(
      (ev) => {
        if (Math.abs(ev.clientX - startX) < 5) return;
        moved = true;
        followX(ev.clientX);
        const delta = secFromClientX(ev.clientX) - grabSec;
        let dur = clampTimelineTransitionSec(startDur + delta);
        if (snapOn && beatSec > 0.2) {
          dur = clampTimelineTransitionSec(snapTransitionSecToBeats(dur, beatSec));
        }
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `${dur.toFixed(2)}s`});
        const cur = segments[segIndex]?.transitionParams?.durationSec;
        if (Math.abs(dur - (cur ?? getTransitionDefaultSec(segments[segIndex].transition) ?? 0.5)) > 0.001) {
          writeSegmentTiming(segIndex, {transitionParams: {durationSec: dur}});
        }
      },
      () => {
        commitDrag();
        endDragFeedback();
        if (!moved) setSelectedBoundary((v) => (v === segIndex ? null : segIndex));
      },
    );
  };
  const onBoundaryHitDown = (e: React.PointerEvent, segIndex: number) => {
    // 硬切边界（无转场块）的命中区：点击直接打开弹层加转场
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedBoundary((v) => (v === segIndex ? null : segIndex));
  };

  // ---- 拆分（播放头处）----
  const onSplit = () => {
    const idx = findClipIndexAt(layout, playheadSec);
    const clip = layout.clips[idx];
    if (!clip) return;
    const at = playheadSec - clip.startSec;
    if (!runTimelineCommand({kind: 'splitSegment', index: idx, atSec: at})) {
      setStatusText('拆分点离片段头尾太近（两侧需各留 0.5 秒）');
    } else {
      setStatusText(`已在 ${formatTimelineTc(playheadSec)} 拆分第 ${idx + 1} 片段`);
    }
  };
  const splitValid = useMemo(() => {
    const idx = findClipIndexAt(layout, playheadSec);
    const clip = layout.clips[idx];
    if (!clip) return false;
    const at = playheadSec - clip.startSec;
    return at >= 0.5 && at <= clip.durationSec - 0.5;
  }, [layout, playheadSec]);

  // ---- BGM 淡入/淡出手柄 ----
  const onFadeHandleDown = (e: React.PointerEvent, which: 'in' | 'out') => {
    if (e.button !== 0 || !bgm) return;
    e.preventDefault();
    e.stopPropagation();
    const total = layout.totalSec;
    const commitDrag = beginDragTransaction('拖拽淡入淡出');
    startWindowDrag(
      (ev) => {
        followX(ev.clientX);
        const sec = secFromClientX(ev.clientX);
        // 淡入从 BGM 块头（起播点）起算；淡出从片尾倒算（手柄越靠左淡出越长）
        const raw = which === 'in' ? sec - bgmStartAtSec(bgm) : total - sec;
        const v = Math.max(0, Math.min(8, Math.round(raw * 10) / 10));
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `${which === 'in' ? '淡入' : '淡出'} ${v.toFixed(1)}s`});
        if (which === 'in') updateBgm({fadeIn: v});
        else updateBgm({fadeOut: v});
      },
      () => {
        commitDrag();
        endDragFeedback();
      },
    );
  };

  // ---- BGM 块（v1.5）：拖块体 = 调起播点（吸节拍）；拖循环窗终点把手 = 调 trimEnd；双击 = 弹层 ----
  const [bgmPopAt, setBgmPopAt] = useState<{x: number; y: number} | null>(null);
  const onBgmClipDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !bgm) return;
    const startX = e.clientX;
    const startAt0 = bgmStartAtSec(bgm);
    let moved = false;
    const commitDrag = beginDragTransaction('拖拽 BGM 起播');
    startWindowDrag(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        const rawSec = secFromClientX(ev.clientX);
        const sec = maybeSnap(rawSec);
        followX(ev.clientX);
        const v = Math.max(0, Math.min(Math.max(0, layout.totalSec - 1), Math.round(sec * 10) / 10));
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `起播 ${v.toFixed(1)}s`});
        setSnapHintSec(snapOn && sec !== rawSec ? sec : null);
        if (v !== bgmStartAtSec(bgm)) updateBgm({startAtSec: v});
      },
      () => {
        commitDrag();
        endDragFeedback();
        if (!moved) setBgmPopAt({x: e.clientX, y: e.clientY}); // 单击 = 打开 BGM 定位弹层
      },
    );
  };
  const onBgmTrimEndDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !bgm) return;
    e.preventDefault();
    e.stopPropagation();
    const startAt = bgmStartAtSec(bgm);
    const commitDrag = beginDragTransaction('拖拽循环窗终点');
    startWindowDrag(
      (ev) => {
        followX(ev.clientX);
        const sec = secFromClientX(ev.clientX) - startAt; // 相对块头 = 窗内偏移
        const ts = bgmTrimStartSec(bgm);
        const v = Math.max(ts + 2, Math.min(bgm.duration, Math.round((ts + sec) * 10) / 10));
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `循环窗终点 ${v.toFixed(1)}s`});
        if (v !== bgmTrimEndSec(bgm)) updateBgm({trimEndSec: v});
      },
      () => {
        commitDrag();
        endDragFeedback();
      },
    );
  };

  // ---- BGM 音量包络（音量线）：双击块加点 / 拖点移动 / 双击点删除 ----
  // 包络 sec 相对 BGM 起播点（拖块时线随块走）；volume 由块内 Y 位置映射（顶=1 底=0）
  const bgmEnvSpan = bgm ? Math.max(1, layout.totalSec - bgmStartAtSec(bgm)) : 1;
  const volFromClientY = (clientY: number, clipEl: HTMLElement | null): number => {
    if (!clipEl) return 1;
    const r = clipEl.getBoundingClientRect();
    const v = 1 - (clientY - r.top - 4) / Math.max(1, r.height - 8);
    return Math.max(0, Math.min(1, Math.round(v * 20) / 20)); // 0.05 步进
  };
  const onBgmEnvPointDown = (e: React.PointerEvent, idx: number) => {
    if (e.button !== 0 || !bgm) return;
    e.preventDefault();
    e.stopPropagation();
    const clipEl = (e.currentTarget as HTMLElement).closest('.tl-bgm-clip') as HTMLElement | null;
    const startAt = bgmStartAtSec(bgm);
    const keys0 = bgm.volumeKeys ?? [];
    const commitDrag = beginDragTransaction('拖音量点');
    startWindowDrag(
      (ev) => {
        followX(ev.clientX);
        const rawSec = secFromClientX(ev.clientX) - startAt;
        const sec = Math.max(0, Math.min(bgmEnvSpan, Math.round(rawSec * 10) / 10));
        const v = volFromClientY(ev.clientY, clipEl);
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `音量 ${(v * 100) | 0}% @ ${sec.toFixed(1)}s`});
        const next = normalizeBgmVolumeKeys(
          keys0.map((k, i) => (i === idx ? {sec, volume: v} : k)),
          bgmEnvSpan,
        );
        if (next) updateBgm({volumeKeys: next});
      },
      () => {
        commitDrag();
        endDragFeedback();
      },
    );
  };
  const onBgmClipDoubleClick = (e: React.MouseEvent) => {
    if (!bgm || e.button !== 0) return;
    const clipEl = (e.currentTarget as HTMLElement).closest('.tl-bgm-clip') as HTMLElement | null;
    const startAt = bgmStartAtSec(bgm);
    const rawSec = secFromClientX(e.clientX) - startAt;
    if (rawSec < -0.2 || rawSec > bgmEnvSpan + 0.2) return;
    const sec = Math.max(0, Math.min(bgmEnvSpan, Math.round(rawSec * 10) / 10));
    const v = volFromClientY(e.clientY, clipEl ?? (e.currentTarget as HTMLElement));
    setBgmPopAt(null); // 双击优先包络交互，关闭单击弹出的定位弹层
    const next = normalizeBgmVolumeKeys([...(bgm.volumeKeys ?? []), {sec, volume: v}], bgmEnvSpan);
    if (next) runTimelineCommand({kind: 'bgm', patch: {volumeKeys: next}});
  };
  const onBgmEnvPointDoubleClick = (e: React.MouseEvent, idx: number) => {
    if (!bgm) return;
    e.preventDefault();
    e.stopPropagation();
    const next = (bgm.volumeKeys ?? []).filter((_, i) => i !== idx);
    runTimelineCommand({kind: 'bgm', patch: {volumeKeys: next.length > 0 ? next : undefined}}); // 删到 0 个 = 回恒定音量
  };

  // ---- 旁白块：拖块体 = 调段内偏移（等转场过去再开口）；单击 = 选中该段 ----
  const onNarrPointerDown = (e: React.PointerEvent, segIndex: number) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let moved = false;
    const commitDrag = beginDragTransaction('拖旁白偏移');
    startWindowDrag(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 5) return;
        moved = true;
        const clip = layout.clips[segIndex];
        const n = segments[segIndex]?.narration;
        if (!clip || !n) return;
        followX(ev.clientX);
        // 磁性吸附（绝对秒上吸：对齐片段边界/播放头等），再换算回段内偏移
        const rawSec = secFromClientX(ev.clientX);
        const sec = maybeSnap(rawSec);
        const offset = clampNarrationOffsetSec(sec - clip.startSec, clip.durationSec);
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `段内 ${offset.toFixed(1)}s`});
        setSnapHintSec(snapOn && sec !== rawSec ? sec : null);
        if (offset !== clampNarrationOffsetSec(n.offsetSec ?? 0, clip.durationSec)) {
          updateSegmentNarration(segIndex, {offsetSec: offset});
        }
      },
      () => {
        commitDrag();
        endDragFeedback();
        if (!moved) selectSegment(segIndex);
      },
    );
  };

  // ---- M2 回写环：排版字幕巷（模板排版文字的时间线物化视图）----
  // 投影与 get_segment_plan 同源（plan-projection 纯函数；冻结段窗=物化层真值，投影层已消费覆盖层）
  const planCapsBySeg = useMemo(
    () => segments.map((seg) => projectSegmentPlan(seg)?.captions ?? null),
    [segments],
  );
  const anyPlanCaps = planCapsBySeg.some((c) => c && c.length > 0);
  // 双击改文案：内联输入 → planCaptionText 命令（反解回 text/features，永不冻结；一命令=一步撤销）
  const [planEditing, setPlanEditing] = useState<{segIndex: number; captionIndex: number; text: string} | null>(null);
  const commitPlanText = () => {
    if (!planEditing) return;
    const {segIndex, captionIndex, text} = planEditing;
    setPlanEditing(null);
    if (!text.trim()) return;
    const seg = useProjectStore.getState().segments[segIndex];
    if (!seg) return;
    const r = solveCaptionText(seg, captionIndex, text);
    if (!r.ok) {
      setStatusText(r.reason);
      return;
    }
    if (runTimelineCommand({kind: 'planCaptionText', index: segIndex, captionIndex, text})) {
      setStatusText(`已回写第 ${segIndex + 1} 段排版文案（Ctrl+Z 可撤销）`);
    }
  };
  // 拖缘调时序窗：时序在任何 v0 模板参数里都表达不了 → 冻结接管（paramSnapshot + 物化层窗真值；
  // 渲染消费逐模板开放——未开放模板拖前预检给原因）。逐模板开放名单见 shared/plan-writeback。
  const onPlanEdgeDown = (e: React.PointerEvent, segIndex: number, captionIndex: number, edge: 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const seg = segments[segIndex];
    if (!seg) return;
    const cur = (planCapsBySeg[segIndex] ?? [])[captionIndex];
    if (!cur) return;
    // 可解性预检（含渲染消费开放名单）：失败给原因，不进拖拽
    const probe = solveCaptionWindow(seg, captionIndex, cur.startSec, cur.endSec);
    if (!probe.ok) {
      setStatusText(probe.reason);
      return;
    }
    if (probe.value.frozeNow) {
      setStatusText(`第 ${segIndex + 1} 段排版时序已由时间线接管（模板参数冻结快照，Ctrl+Z 可整步撤销）`);
    }
    const startX = e.clientX;
    let moved = false;
    const commitDrag = beginDragTransaction('拖拽排版字幕窗');
    // 建立冻结 + 覆盖层（初值=当前窗；已冻结则幂等沿用）——括号作用域内，无独立历史条目
    applySegmentPlanFreeze(segIndex, captionIndex, cur.startSec, cur.endSec);
    startWindowDrag(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        const clip = layout.clips[segIndex];
        if (!clip) return;
        followX(ev.clientX);
        const rawSec = secFromClientX(ev.clientX);
        const local = Math.max(0, Math.min(clip.durationSec, maybeSnap(rawSec) - clip.startSec));
        // 窗真值从 store 实时回读（覆盖层是唯一真值源；最小窗长 2 帧）
        const segNow = useProjectStore.getState().segments[segIndex];
        const wins = effectiveCaptionWindows(segNow);
        const w = wins[captionIndex];
        if (!w) return;
        const minSpan = 2 / TIMELINE_FPS;
        const next =
          edge === 'start'
            ? {startSec: Math.min(local, w.endSec - minSpan), endSec: w.endSec}
            : {startSec: w.startSec, endSec: Math.max(local, w.startSec + minSpan)};
        writeSegmentCaptionWindows(
          segIndex,
          wins.map((x, i) => (i === captionIndex ? next : x)),
        );
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `字幕窗 ${next.startSec.toFixed(2)}~${next.endSec.toFixed(2)}s`});
      },
      () => {
        commitDrag();
        endDragFeedback();
      },
    );
  };

  // ---- M2 切片三：素材窗手势（视频轨段块内的素材条；mediaIn/mediaOut 是媒体域值，段时长不动） ----
  // 拖条体 = 滑窗（胶片跟手：左拖看素材更晚段，mediaIn/out 同步平移）；拖左缘 = 掐头（mediaIn）、
  // 右缘 = 去尾（mediaOut）。挖段（cuts）素材不可拖——cut 编辑域在素材页（宁少勿猜）；
  // 图片无时窗。反解与命令走 planMediaWindow（mediaIn/out ↔ trim 同口径），拖拽括号内逐帧直写。
  const onMediaWindowDown = (e: React.PointerEvent, segIndex: number, clipIndex: number, mode: 'slide' | 'in' | 'out') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const v = segments[segIndex]?.videos[clipIndex];
    if (!v || (v.type !== 'video' && v.type !== 'model')) return;
    if (v.cuts && v.cuts.length > 0) {
      setStatusText('该素材含挖段（cuts）——素材窗编辑请到片段「素材」页（时间线暂不改挖段结构）');
      return;
    }
    const srcDur = v.duration || 0;
    if (srcDur <= 0.2) return;
    const startX = e.clientX;
    const in0 = v.trimStart ?? 0;
    const out0 = v.trimEnd ?? v.duration;
    let moved = false;
    const commitDrag = beginDragTransaction(mode === 'slide' ? '拖素材窗（滑窗）' : mode === 'in' ? '拖素材窗（掐头）' : '拖素材窗（去尾）');
    const apply = (inS: number, outS: number, ev: {clientX: number; clientY: number}) => {
      const a = Math.max(0, Math.min(srcDur - 0.1, inS));
      const b = Math.max(a + 0.1, Math.min(srcDur, outS));
      updateSegmentVideoTrim(segIndex, clipIndex, Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000);
      setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `素材窗 ${a.toFixed(1)}~${b.toFixed(1)}s（源 ${srcDur.toFixed(1)}s）`});
    };
    startWindowDrag(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        followX(ev.clientX);
        // d>0 = 指针左移。滑窗=胶片跟手（左拖看更晚段，in/out 同步 +d）；
        // 缘把手=跟手方向相反（右拖掐头/去尾 = in/out -d）
        const d = (startX - ev.clientX) / pxPerSec;
        if (mode === 'slide') apply(in0 + d, out0 + d, ev);
        else if (mode === 'in') apply(in0 - d, out0, ev);
        else apply(in0, out0 - d, ev);
      },
      () => {
        commitDrag();
        endDragFeedback();
        if (moved) setStatusText(`素材窗已调整（Ctrl+Z 可整步撤销）`);
      },
    );
  };

  // ---- M3 L2 节拍巷手势：拖 = 调位置（0.1 步进钳制，括号事务）；双击 = 切重拍/普通；右键 = 删 ----
  const onBeatPointerDown = (e: React.PointerEvent, segIndex: number, beatIdx: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const clip = layout.clips[segIndex];
    const beat = segments[segIndex]?.beats?.[beatIdx];
    if (!clip || !beat) return;
    const startX = e.clientX;
    const grabT = secFromClientX(startX) - clip.startSec;
    let moved = false;
    const commitDrag = beginDragTransaction('拖节拍标记');
    startWindowDrag(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        followX(ev.clientX);
        const t = Math.max(0, Math.min(clip.durationSec - 0.1, Math.round((grabT + (ev.clientX - startX) / pxPerSec) * 10) / 10));
        const cur = useProjectStore.getState().segments[segIndex]?.beats ?? [];
        writeSegmentBeats(segIndex, cur.map((b, i) => (i === beatIdx ? {...b, t} : b)));
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `节拍 ${t.toFixed(1)}s${beat.kind === 'accent' ? '（重拍）' : ''}`});
      },
      () => {
        commitDrag();
        endDragFeedback();
        if (!moved) selectSegment(segIndex);
      },
    );
  };
  const onBeatDoubleClick = (segIndex: number, beatIdx: number) => {
    const cur = segments[segIndex]?.beats ?? [];
    if (!cur[beatIdx]) return;
    runTimelineCommand({
      kind: 'segmentBeats',
      index: segIndex,
      beats: cur.map((b, i) => (i === beatIdx ? {...b, kind: b.kind === 'accent' ? 'mark' : 'accent'} : b)),
    });
    setStatusText(`节拍已切为${cur[beatIdx].kind === 'accent' ? '普通标记' : '重拍/强调'}（Ctrl+Z 可撤销）`);
  };
  const onBeatContextMenu = (e: React.MouseEvent, segIndex: number, beatIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const cur = segments[segIndex]?.beats ?? [];
    if (!cur[beatIdx]) return;
    runTimelineCommand({kind: 'segmentBeats', index: segIndex, beats: cur.length > 1 ? cur.filter((_, i) => i !== beatIdx) : undefined});
    setStatusText('已删节拍标记（Ctrl+Z 可撤销）');
  };

  // ---- 片段块右键菜单（复制 / 删除 / 在播放头拆分）----
  const [clipMenuAt, setClipMenuAt] = useState<{x: number; y: number; segIndex: number} | null>(null);
  const onClipContextMenu = (e: React.MouseEvent, segIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setClipMenuAt({x: e.clientX, y: e.clientY, segIndex});
  };
  const menuSplitValid = useMemo(() => {
    if (!clipMenuAt) return false;
    const clip = layout.clips[clipMenuAt.segIndex];
    if (!clip) return false;
    const at = playheadSec - clip.startSec;
    return at >= 0.5 && at <= clip.durationSec - 0.5;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipMenuAt, layout, playheadSec]);
  const menuDuplicate = () => {
    if (!clipMenuAt) return;
    syncCurrentToSegment();
    duplicateSegment(clipMenuAt.segIndex);
    setStatusText(`已复制第 ${clipMenuAt.segIndex + 1} 片段`);
    setClipMenuAt(null);
  };
  // 删除片段（右键菜单与 Delete 键共用）：时间轴域不弹原生 confirm——打断剪辑手感，
  // Ctrl+Z 全程兜底（卡片模式仍保持确认口径）；opts.confirm 保留给需要确认的调用方
  const removeSegmentAt = useCallback(
    (idx: number, opts?: {confirm?: boolean}): boolean => {
      if (segments.length <= 1) return false;
      const seg = segments[idx];
      if (!seg) return false;
      const hasContent =
        seg.videos.length > 0 || Boolean(seg.text?.title || seg.text?.subtitle || (seg.text?.features || []).length);
      if (hasContent && opts?.confirm !== false && !window.confirm(`确定删除第 ${idx + 1} 个片段吗？（可用 Ctrl+Z 撤销）`)) return false;
      syncCurrentToSegment();
      removeSegment(idx);
      setStatusText(`已删除第 ${idx + 1} 片段（Ctrl+Z 可撤销）`);
      return true;
    },
    [segments, syncCurrentToSegment, removeSegment, setStatusText],
  );
  const menuRemove = () => {
    if (!clipMenuAt) return;
    removeSegmentAt(clipMenuAt.segIndex, {confirm: false});
    setClipMenuAt(null);
  };
  const menuSplit = () => {
    if (!clipMenuAt || !menuSplitValid) return;
    const clip = layout.clips[clipMenuAt.segIndex];
    if (!runTimelineCommand({kind: 'splitSegment', index: clipMenuAt.segIndex, atSec: playheadSec - clip.startSec})) {
      setStatusText('拆分点离片段头尾太近（两侧需各留 0.5 秒）');
    } else {
      setStatusText(`已在 ${formatTimelineTc(playheadSec)} 拆分第 ${clipMenuAt.segIndex + 1} 片段`);
    }
    setClipMenuAt(null);
  };
  // 时长微调（右键菜单 ±0.5s）：拖右缘难精调时的数值补充路径
  const menuNudge = (delta: number) => {
    if (!clipMenuAt) return;
    const idx = clipMenuAt.segIndex;
    const next = clampSegmentDuration((segments[idx]?.duration ?? 8) + delta);
    runTimelineCommand({kind: 'segmentTiming', index: idx, patch: {duration: next}});
    setStatusText(`第 ${idx + 1} 片段时长 ${next.toFixed(1)}s`);
    setClipMenuAt(null);
  };
  // 播放头跳到此段开头：与空格播放组合 = 从该段起预览（菜单保持开着也行，先关防遮挡）
  const menuSeekToStart = () => {
    if (!clipMenuAt) return;
    const clip = layout.clips[clipMenuAt.segIndex];
    if (!clip) return;
    setPlayheadSec(clip.startSec);
    if (monitorOpen) seekPlayer(clip.startSec);
    setStatusText(`播放头已到第 ${clipMenuAt.segIndex + 1} 片段开头（空格从此段预览）`);
    setClipMenuAt(null);
  };
  // M3 L2：在播放头加节拍标记（0.1 步进钳制；一命令=一事务；节拍巷随后出现可拖动）
  const menuAddBeat = () => {
    if (!clipMenuAt) return;
    const clip = layout.clips[clipMenuAt.segIndex];
    if (!clip) return;
    const idx = clipMenuAt.segIndex;
    const t = Math.max(0, Math.min(clip.durationSec - 0.1, Math.round((playheadSec - clip.startSec) * 10) / 10));
    const cur = segments[idx]?.beats ?? [];
    const beat = {t, kind: 'mark' as const};
    runTimelineCommand({kind: 'segmentBeats', index: idx, beats: [...cur, beat]});
    setStatusText(`已在第 ${idx + 1} 段 ${t.toFixed(1)}s 加节拍标记（节拍巷可拖动调整，Ctrl+Z 撤销）`);
    setClipMenuAt(null);
  };
  // 重渲此段：强制失效该段±邻段的缓存块后渲片（输出沿用上次渲片目录，无记录则弹目录选择）
  const startRender = useStartRender();
  const menuRerenderSeg = async () => {
    if (!clipMenuAt) return;
    const idx = clipMenuAt.segIndex;
    setClipMenuAt(null);
    const lastDir = lastRenderInfo?.outputPath?.match(/^(.*[\\/])/)?.[1] ?? '';
    setStatusText(`已发起重渲第 ${idx + 1} 片段（含边界转场，其余段走缓存）…`);
    const r = await startRender(lastDir, {forceSegments: [idx]});
    if (!r.success) setStatusText(`重渲失败：${r.error ?? '未知错误'}`);
    else setStatusText(`重渲完成：${r.outputPath ?? ''}`);
  };

  // ---- 手放音效块（v4）：拖块体 = 移动位置（吸节拍）；单击 = 弹层编辑 ----
  const [sfxClipSel, setSfxClipSel] = useState<string | null>(null);
  const [sfxClipPopAt, setSfxClipPopAt] = useState<{x: number; y: number} | null>(null);
  const onSfxClipPointerDown = (e: React.PointerEvent, clip: SfxClip) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const grabSec = secFromClientX(startX);
    let moved = false;
    const commitDrag = beginDragTransaction('拖音效点');
    startWindowDrag(
      (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) < 5) return;
        moved = true;
        followX(ev.clientX);
        const raw = grabSec + (ev.clientX - startX) / pxPerSec;
        const sec = maybeSnap(raw);
        const v = Math.round(sec * 10) / 10;
        setDragTip({x: ev.clientX + 12, y: ev.clientY - 8, text: `${v.toFixed(1)}s`});
        setSnapHintSec(snapOn && sec !== raw ? sec : null);
        if (v !== clip.atSec) updateSfxClip(clip.id, {atSec: v});
      },
      () => {
        commitDrag();
        endDragFeedback();
        if (moved) return;
        if (sfxClipSel === clip.id) {
          setSfxClipSel(null);
          setSfxClipPopAt(null);
        } else {
          setSfxClipSel(clip.id);
          setSfxClipPopAt({x: e.clientX, y: e.clientY});
        }
      },
    );
  };

  // ---- 播放头键盘操作（时间轴视图挂载期间生效；焦点在输入控件时不拦截；空格仅在监视器开着时播放）----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const total = layout.totalSec;
      const move = (sec: number) => {
        const next = Math.max(0, Math.min(total, sec));
        setPlayheadSec(next);
        if (monitorOpen) seekPlayer(next);
      };
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        move(playheadRef.current - (e.shiftKey ? 1 : 1 / TIMELINE_FPS));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        move(playheadRef.current + (e.shiftKey ? 1 : 1 / TIMELINE_FPS));
      } else if (e.key === 'Home') {
        e.preventDefault();
        move(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        move(total);
      } else if (e.key === ' ' && monitorMounted) {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // 优先删选中的手放音效块，否则删选中片段（确认口径与右键菜单一致）
        e.preventDefault();
        if (sfxClipSel) {
          runTimelineCommand({kind: 'sfxClipRemove', id: sfxClipSel});
          setSfxClipSel(null);
          setSfxClipPopAt(null);
        } else {
          removeSegmentAt(activeSegmentIndex, {confirm: false});
        }
      } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (splitValid) {
          e.preventDefault();
          onSplit();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout.totalSec, monitorMounted, monitorOpen, seekPlayer, togglePlay, sfxClipSel, removeSegmentAt, activeSegmentIndex, splitValid, onSplit]);

  // ---- 音效标记（与 SfxLane 同源计算）----
  const sfxMarks = useMemo(() => {
    if (!sfx?.enabled) return {beats: [] as Array<{sec: number; kind: SfxKind}>, transitions: [] as Array<{sec: number; kind: SfxKind; segIndex: number; off: boolean}>};
    let acc = 0;
    const timings = segments.map((seg, i) => {
      const startF = Math.round(acc * FPS);
      acc += seg.duration;
      const isLast = i === segments.length - 1;
      const tail = isLast || seg.transition === 'none'
        ? 0
        : Math.round((seg.transitionParams?.durationSec ?? getTransitionDefaultSec(seg.transition) ?? 0.5) * FPS);
      return {
        contentStartFrame: startF,
        contentEndFrame: Math.round(acc * FPS),
        outOverlap: tail,
        isLast,
        transition: seg.transition,
        sfxOverride: seg.transitionSfx,
      };
    });
    const beatPlacements = sfx.beatImpact
      ? planSfxPlacements(timings, beats, FPS, sfx, APPROX_VARIANT_COUNTS)
          .filter((p) => p.kind === 'impact' || p.kind === 'click' || p.kind === 'riser')
          .map((p) => ({sec: p.frame / FPS, kind: p.kind}))
      : [];
    let acc2 = 0;
    const transitionMarks: Array<{sec: number; kind: SfxKind; segIndex: number; off: boolean}> = [];
    segments.forEach((seg, i) => {
      acc2 += seg.duration;
      if (i === segments.length - 1 || seg.transition === 'none') return;
      const kind = seg.transitionSfx && seg.transitionSfx !== 'off' ? seg.transitionSfx : TRANSITION_SFX_KIND[seg.transition] ?? 'whoosh';
      transitionMarks.push({
        sec: acc2 - SFX_LEAD_SEC[kind],
        kind,
        segIndex: i,
        off: seg.transitionSfx === 'off',
      });
    });
    return {beats: beatPlacements, transitions: transitionMarks};
  }, [segments, beats, sfx]);

  // ---- 手放音效块（v4）：车道分配（时间重叠的块上下错开 = 多轨叠加视图）----
  const sfxClips = useMemo(() => (sfx?.enabled ? sfx.clips ?? [] : []), [sfx]);
  const sfxClipLanes = useMemo(() => assignSfxClipLanes(sfxClips), [sfxClips]);
  // 音效轨折叠：收起时手放块压成单行小刻度（多层叠轨不再撑高轨道），点标签切回
  const [sfxLaneCollapsed, setSfxLaneCollapsed] = useState(false);
  // 选中块被删（弹层外删除/批量清理）时摘掉悬挂选中：弹层随块卸载没人走 onClose，
  // 不清的话 Delete 键会一直打在已不存在的音效块上（表现为「按了没反应」）
  useEffect(() => {
    if (sfxClipSel && !sfxClips.some((c) => c.id === sfxClipSel)) {
      setSfxClipSel(null);
      setSfxClipPopAt(null);
    }
  }, [sfxClips, sfxClipSel]);

  // ---- 旁白波形 peaks（v5）：path → analyzeAudio（主进程 ffmpeg 解码，会话级缓存防重复解码）----
  const [narrPeaksVer, setNarrPeaksVer] = useState(0);
  const narrPendingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const seg of segments) {
      const p = seg.narration?.path;
      if (!p || narrPeaksCache.has(p) || narrPendingRef.current.has(p)) continue;
      narrPendingRef.current.add(p);
      window.api
        .analyzeAudio(p)
        .then((r) => {
          narrPeaksCache.set(p, r.peaks ?? []);
        })
        .catch(() => {
          narrPeaksCache.set(p, []); // 解码失败按无波形处理，块照常显示
        })
        .finally(() => {
          narrPendingRef.current.delete(p);
          setNarrPeaksVer((v) => v + 1);
        });
    }
  }, [segments]);
  const narrPeaksOf = useCallback((p?: string): number[] | null => {
    void narrPeaksVer; // 缓存是模块级可变态：版本号变化触发重取
    if (!p) return null;
    const v = narrPeaksCache.get(p);
    return v && v.length > 0 ? v : null;
  }, [narrPeaksVer]);

  // ---- 标尺刻度 ----
  const ruler = useMemo(() => planRulerTicks(layout.totalSec, pxPerSec), [layout.totalSec, pxPerSec]);
  const rulerLabel = useCallback((sec: number) => {
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    return s === 0 ? `${m}m` : `${m}m${s}`;
  }, []);

  // ---- 渲染 ----
  const px = (sec: number) => sec * pxPerSec;
  const hasNarration = segments.some((s) => s.narration && s.narration.duration && s.narration.duration > 0);
  const boundarySeg = selectedBoundary != null ? segments[selectedBoundary] : undefined;

  return (
    <div className="tl-panel" ref={panelRef}>
      {/* 工具行 */}
      <div className="tl-toolbar">
        <button
          type="button"
          className={`tl-tool-btn ${monitorMounted ? 'on' : ''}`}
          onClick={() => {
            if (docked) {
              // 已停靠：回浮动小窗（monitorReopen 语义由 undock 处理，这里显式开小窗）
              undockMonitor();
              setMonitorOpen(true);
              return;
            }
            setMonitorOpen(!monitorOpen);
            if (monitorOpen) setPlaying(false);
          }}
          title={
            docked
              ? '整片预览已停靠右侧大窗：点击回到浮动小窗'
              : '整片监视器：浮窗播放全片（可拖标题移动、拖边角等比缩放，拖到右侧预览区停靠成大窗）'
          }
        >
          {docked ? <Maximize2 size={13} /> : monitorOpen ? <X size={13} /> : <Play size={13} />} 整片预览{docked ? '·转小窗' : ''}
        </button>
        {monitorMounted && !docked && (
          <button type="button" className="tl-tool-btn" onClick={togglePlay} title="播放/暂停整片（播放头随之走；空格同）">
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
        )}
        <span className="tl-tc" title="播放头 / 全片时长">
          {formatTimelineTc(playheadSec)} <em>/</em> {formatTimelineTc(layout.totalSec)}
        </span>
        <span className="tl-sep" />
        <button
          type="button"
          className="tl-tool-btn"
          disabled={!canUndo}
          onClick={() => undo()}
          title={`撤销上一步（Ctrl+Z）${historyPast.length > 0 && historyPast[historyPast.length - 1].opName ? `：${historyPast[historyPast.length - 1].opName}` : ''}`}
        >
          <Undo2 size={13} />
        </button>
        <button type="button" className="tl-tool-btn" disabled={!canRedo} onClick={() => redo()} title="重做（Ctrl+Shift+Z）">
          <Redo2 size={13} />
        </button>
        {/* M2 历史面板（总纲 M2「历史面板显示操作来源」）：最近事务列表 + 来源标（You/AI）。
            合并事务（弹层逐键等）显示 ⊕ 标记；条目只读——撤销仍走 Ctrl+Z 逐条弹回 */}
        <div className="tl-history-wrap">
          <button
            type="button"
            className={`tl-tool-btn ${historyOpen ? 'on' : ''}`}
            disabled={!canUndo && !canRedo}
            onClick={() => setHistoryOpen((v) => !v)}
            title="操作历史（最近的事务与来源；Ctrl+Z 逐步撤销）"
          >
            <HistoryIcon size={13} /> {historyPast.length}
          </button>
          {historyOpen && (
            <>
              <div className="tl-history-backdrop" onClick={() => setHistoryOpen(false)} />
              <div className="tl-history-pop">
                <div className="tl-history-head">操作历史（新→旧，点外部关闭）</div>
                {historyPast.length === 0 && <div className="tl-history-empty">暂无历史</div>}
                {historyPast
                  .slice(-12)
                  .reverse()
                  .map((h, i) => (
                    <div key={`h${i}`} className="tl-history-item">
                      <span className={`tl-history-src ${h.source ?? 'user'}`}>{h.source === 'agent' ? 'AI' : 'You'}</span>
                      <span className="tl-history-name">{h.opName ?? '编辑'}</span>
                      {h.coalesceKey && <span className="tl-history-coalesce" title="合并事务（连续同键编辑并入一笔）">⊕</span>}
                      {i === 0 && <span className="tl-history-next">← 撤销将回到此前</span>}
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
        <span className="tl-sep" />
        <button
          type="button"
          className="tl-tool-btn"
          onClick={() => {
            syncCurrentToSegment();
            addSegment();
            setStatusText(`已添加第 ${segments.length + 1} 片段（右键片段块可复制/删除/拆分）`);
          }}
          title="在片尾添加一个空白片段（视频轨加内容；右键片段块可复制/删除/拆分）"
        >
          <Plus size={13} /> 片段
        </button>
        <button
          type="button"
          className="tl-tool-btn"
          disabled={!sfx?.enabled}
          onClick={() => {
            const at = Math.round(playheadSec * 10) / 10;
            runTimelineCommand({kind: 'sfxClipAdd', sfxKind: 'whoosh', atSec: at});
            const id = useProjectStore.getState().sfx?.clips?.at(-1)?.id ?? null; // 命令返回布尔，id 从库尾回读
            setSfxClipSel(id);
            setStatusText(`已在 ${formatTimelineTc(at)} 添加音效（可拖动，点击块改类别/音量；多个音效自动多轨混音）`);
          }}
          title={sfx?.enabled ? '在播放头位置添加手放音效（多个音效可叠加，渲染自动多轨混音）' : '音效关闭：先在「声音」面板开启音效'}
        >
          <AudioLines size={13} /> 音效
        </button>
        <button type="button" className="tl-tool-btn" onClick={onSplit} disabled={!splitValid} title="在播放头处把片段拆成两段（素材裁剪自动跟手，Ctrl+Z 可撤销）">
          <Scissors size={13} /> 拆分
        </button>
        <button
          type="button"
          className={`tl-tool-btn ${snapOn ? 'on' : ''}`}
          onClick={() => setSnapOn((v) => !v)}
          title="磁性吸附：拖拽时对齐 BGM 节拍点 / 片段边界 / 播放头 / BGM 起播点（阈值随缩放自适应；关 = 自由拖拽）"
        >
          <Magnet size={13} /> 吸附
        </button>
        <span className="tl-sep" />
        <button type="button" className="tl-tool-btn" onClick={() => zoomAtCenter(1 / 1.5)} title="缩小（以视口中心为锚）">
          <ZoomOut size={13} />
        </button>
        <button type="button" className={`tl-tool-btn ${fitMode ? 'on' : ''}`} onClick={() => {fitSuppressedRef.current = false; setFitMode(true);}} title="适配窗口宽度">
          <Maximize2 size={13} />
        </button>
        <button type="button" className="tl-tool-btn" onClick={() => zoomAtCenter(1.5)} title="放大（以视口中心为锚；Ctrl+滚轮以光标为锚）">
          <ZoomIn size={13} />
        </button>
        <span className="tl-hint" title="拖右缘调时长 · 整块拖拽重排 · 拖转场块调时长 · 点转场块改类型/音效 · S 拆分 · Delete 删除 · 空格播放 · Ctrl+滚轮缩放 · 右键片段块更多操作">拖右缘调时长 · 拖块重排 · 点转场块编辑 · S 拆分 · Ctrl+滚轮缩放 · 右键片段块更多</span>
      </div>

      {/* 轨道区（横向滚动；标签列 sticky） */}
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{width: LABEL_W + contentWidth}}>
          {/* 标尺（时间刻度 + 节拍点；纵向滚动时 sticky 置顶） */}
          <div className="tl-row tl-ruler">
            <div className="tl-label tl-label-ruler" title="时间标尺：点击/拖拽定位播放头，松手选中所在片段">
              <Clock size={11} />
            </div>
            <div className="tl-cells" onPointerDown={onRulerPointerDown}>
              {ruler.majors.map((sec) => (
                <div key={`M${sec}`} className="tl-tick" style={{left: px(sec)}}>
                  <span className="tl-tick-label">{rulerLabel(sec)}</span>
                </div>
              ))}
              {ruler.minors.map((sec) => (
                <div key={`m${sec}`} className="tl-tick tl-tick-minor" style={{left: px(sec)}} />
              ))}
              {beats.map((b, i) => (
                <span key={`b${i}`} className="tl-beat-dot" style={{left: px(b)}} title={`节拍 ${b.toFixed(2)}s`} />
              ))}
            </div>
          </div>

          {/* 视频轨 */}
          <div className="tl-row tl-row-video">
            <div className="tl-label"><Video size={11} /> 视频</div>
            <div className="tl-cells">
              {layout.clips.map((clip) => {
                const seg = segments[clip.segIndex];
                const active = clip.segIndex === activeSegmentIndex;
                const dragging = dragOver?.from === clip.segIndex;
                return (
                  <div
                    key={seg.id}
                    className={`tl-clip ${active ? 'active' : ''} ${dragging ? 'dragging' : ''}`}
                    style={{left: px(clip.startSec), width: Math.max(10, px(clip.durationSec))}}
                    onPointerDown={(e) => onClipPointerDown(e, clip.segIndex)}
                    onContextMenu={(e) => onClipContextMenu(e, clip.segIndex)}
                    title={`${clip.segIndex + 1}. ${templateName(seg.templateId)} · ${clip.durationSec.toFixed(1)}s（拖右缘调时长，整块拖拽重排，右键复制/删除/拆分）`}
                  >
                    {/* 胶片条背景（v5）：段内首个缩略图/图片素材沿块宽平铺；纯模板段给文字预览 */}
                    {(() => {
                      const thumb = seg.videos.find((v) => v.thumbnail)?.thumbnail;
                      const img = thumb ?? seg.videos.find((v) => v.type === 'image' && v.src)?.src;
                      if (img) return <div className="tl-clip-film" style={{backgroundImage: `url(${img})`}} />;
                      const t = seg.text;
                      const preview = t?.title || t?.subtitle || t?.features?.[0];
                      if (preview) return <div className="tl-clip-textprev">{preview}</div>;
                      return null;
                    })()}
                    <span className="tl-clip-num">{clip.segIndex + 1}</span>
                    <span className="tl-clip-name">{templateName(seg.templateId)}</span>
                    <span className="tl-clip-dur">{clip.durationSec.toFixed(1)}s</span>
                    {/* 素材原声静音（时间轴直达；数据模型与素材页/AI muted 同源） */}
                    {seg.videos[0]?.type === 'video' && (
                      <button
                        type="button"
                        className={`tl-mini-btn tl-clip-mute ${seg.videos[0].muted ? 'off' : ''}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateSegmentVideoAudio(clip.segIndex, 0, !seg.videos[0].muted);
                        }}
                        title={seg.videos[0].muted ? '素材已静音（点击恢复原声）' : '静音素材原声（BGM/旁白不受影响）'}
                      >
                        {seg.videos[0].muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                      </button>
                    )}
                    {/* shot 粒度指示（M2 切片三定位化）：视频/model 条按时间窗定位 + 可拖
                        （拖体=滑窗看素材不同段、拖缘=掐头/去尾——mediaIn/out 媒体域值，段时长不动）；
                        挖段素材显示不可拖（cut 编辑域在素材页）；图/文条静态；叠层段逐条一行。
                        与 get_timeline.shots 同源 */}
                    {(() => {
                      const segShots = shotTimeline.shots.filter((s) => s.segIndex === clip.segIndex);
                      if (segShots.length === 0) return null;
                      const layerRow = new Map(
                        segShots.filter((s) => s.layered).map((s, i) => [s.id, i + 1] as const),
                      );
                      const rows = Math.max(1, ...[...layerRow.values()].map((r) => r + 1));
                      return (
                        <span className="tl-clip-shots" style={{height: rows * 6}}>
                          {segShots.map((s) => {
                            const draggable =
                              (s.kind === 'video' || s.kind === 'model') &&
                              (s.cutsCount ?? 0) === 0 &&
                              s.clipIndex !== undefined;
                            const row = layerRow.get(s.id) ?? 0;
                            const left = px(Math.max(0, s.startSec));
                            const width = Math.max(6, px(Math.max(0.05, s.endSec - s.startSec)));
                            const mediaNote =
                              s.mediaInSec !== undefined ? `，媒体 ${s.mediaInSec.toFixed(1)}~${s.mediaOutSec!.toFixed(1)}s` : '';
                            return (
                              <i
                                key={s.id}
                                className={`tl-shot tl-shot-${s.kind}${draggable ? ' grab' : ''}`}
                                style={{left, width, bottom: row * 6}}
                                onPointerDown={
                                  draggable
                                    ? (ev) => onMediaWindowDown(ev, clip.segIndex, s.clipIndex!, 'slide')
                                    : undefined
                                }
                                title={`shot ${s.id}（${s.kind}${s.clipIndex !== undefined ? `，段内第 ${s.clipIndex + 1} 素材` : ''}${mediaNote}${s.layered ? '，叠层' : ''}）${
                                  draggable
                                    ? '\n拖条体=滑窗（看素材不同段）；拖左右缘=掐头/去尾（段时长不变）'
                                    : s.cutsCount
                                      ? '\n含挖段：素材窗在片段「素材」页编辑'
                                      : ''
                                }`}
                              >
                                {draggable && (
                                  <>
                                    <span
                                      className="tl-shot-edge left"
                                      onPointerDown={(ev) => onMediaWindowDown(ev, clip.segIndex, s.clipIndex!, 'in')}
                                      title="拖动调素材起点（掐头；段时长不变）"
                                    />
                                    <span
                                      className="tl-shot-edge right"
                                      onPointerDown={(ev) => onMediaWindowDown(ev, clip.segIndex, s.clipIndex!, 'out')}
                                      title="拖动调素材终点（去尾；段时长不变）"
                                    />
                                  </>
                                )}
                              </i>
                            );
                          })}
                        </span>
                      );
                    })()}
                    <span className="tl-clip-resize" onPointerDown={(e) => onResizeHandleDown(e, clip.segIndex)} title="拖拽调整片段时长" />
                  </div>
                );
              })}
              {/* 转场块（骑跨切点）+ 硬切边界加号。
                  命中区仲裁：边界容器 pointer-events:none（不挡片段右缘拖柄），
                  转场块与「+」自行接管点击（各自 z-index 高于片段）。 */}
              {layout.transitions.map((b) => {
                if (b.segIndex >= segments.length - 1) return null;
                const segT = segments[b.segIndex];
                const sfxKind: SfxKind =
                  segT.transitionSfx && segT.transitionSfx !== 'off'
                    ? segT.transitionSfx
                    : TRANSITION_SFX_KIND[b.type] ?? 'whoosh';
                return (
                  <div
                    key={`bd${b.segIndex}`}
                    className={`tl-boundary ${selectedBoundary === b.segIndex ? 'selected' : ''}`}
                    style={{left: px(b.cutSec)}}
                  >
                    {b.type !== 'none' ? (
                      <span
                        className="tl-trans"
                        style={{left: px(b.startSec) - px(b.cutSec), width: Math.max(12, px(b.endSec - b.startSec))}}
                        onPointerDown={(e) => onTransitionPointerDown(e, b.segIndex)}
                        title={`${b.type} 转场 ${b.durationSec.toFixed(2)}s（拖宽度调时长，点击编辑类型/音效）`}
                      >
                        <span className="tl-trans-glyph" style={{color: SFX_KIND_META[sfxKind].color}}>◆</span>
                        <span className="tl-trans-dur">{b.durationSec.toFixed(1)}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="tl-add-trans"
                        onPointerDown={(e) => onBoundaryHitDown(e, b.segIndex)}
                        title="硬切边界：点击添加转场"
                      >
                        +
                      </button>
                    )}
                  </div>
                );
              })}
              {/* 重排插入指示线 */}
              {dragOver && (
                <div
                  className="tl-insert-line"
                  style={{
                    left: px(
                      dragOver.insert >= layout.clips.length
                        ? layout.totalSec
                        : layout.clips[dragOver.insert]?.startSec ?? 0,
                    ),
                  }}
                />
              )}
            </div>
          </div>

          {/* 排版字幕轨（M2 回写环第一片）：模板排版文字的时间线物化视图——
              双击 = 改文案（反解回 text/features，永不冻结）；拖缘 = 调时序窗
              （模板参数表达不了 → 冻结接管，渲染消费逐模板开放）；❄ = 该段已冻结 */}
          {anyPlanCaps && (
            <div className="tl-row tl-row-plan">
              <div className="tl-label"><Type size={11} /> 排版</div>
              <div className="tl-cells">
                {layout.clips.map((clip) => {
                  const caps = planCapsBySeg[clip.segIndex];
                  if (!caps || caps.length === 0) return null;
                  const frozen = !!segments[clip.segIndex].frozen;
                  return caps.map((c, ci) => {
                    const editing = planEditing?.segIndex === clip.segIndex && planEditing?.captionIndex === ci;
                    const isSub = ci > 0 && segments[clip.segIndex].templateId === 'CursorFollow';
                    return (
                      <div
                        key={`pc${clip.segIndex}-${ci}`}
                        className={`tl-plan-chip${frozen ? ' frozen' : ''}${clip.segIndex === activeSegmentIndex ? ' active' : ''}${isSub ? ' sub' : ''}`}
                        style={{left: px(clip.startSec + c.startSec), width: Math.max(14, px(c.endSec - c.startSec))}}
                        onDoubleClick={() => setPlanEditing({segIndex: clip.segIndex, captionIndex: ci, text: c.text})}
                        title={`第 ${clip.segIndex + 1} 段排版字幕：${c.text}（${c.startSec.toFixed(1)}~${c.endSec.toFixed(1)}s）\n双击改文案（回写模板文案槽）；拖左右缘调时序窗${frozen ? '\n❄ 该段已冻结：时序由时间线接管，模板参数锁定快照' : ''}`}
                      >
                        {editing ? (
                          <input
                            className="tl-plan-input"
                            value={planEditing.text}
                            autoFocus
                            spellCheck={false}
                            onChange={(e) => setPlanEditing({...planEditing, text: e.target.value})}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitPlanText();
                              if (e.key === 'Escape') setPlanEditing(null);
                            }}
                            onBlur={commitPlanText}
                            onPointerDown={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            {frozen && <span className="tl-plan-frozen" title="已冻结：时序由时间线接管">❄</span>}
                            <span className="tl-plan-chip-text">{c.text}</span>
                            <span
                              className="tl-plan-edge left"
                              onPointerDown={(e) => onPlanEdgeDown(e, clip.segIndex, ci, 'start')}
                              title="拖动调窗起点（冻结接管）"
                            />
                            <span
                              className="tl-plan-edge right"
                              onPointerDown={(e) => onPlanEdgeDown(e, clip.segIndex, ci, 'end')}
                              title="拖动调窗终点（冻结接管）"
                            />
                          </>
                        )}
                      </div>
                    );
                  });
                })}
              </div>
            </div>
          )}

          {/* 节拍巷（M3 L2，v1.4）：手放节拍标记——合成时与 BGM 拍点并流成段节拍网格
              （踩拍/逐拍生长类模板消费；无 BGM 也生效）。拖 = 调位置（0.1 步进）；
              双击 = 切重拍/普通；右键 = 删。入口 = 片段右键「在播放头加节拍标记」 */}
          {segments.some((s) => (s.beats?.length ?? 0) > 0) && (
            <div className="tl-row tl-row-beats">
              <div className="tl-label"><Zap size={11} /> 节拍</div>
              <div className="tl-cells">
                {layout.clips.map((clip) => {
                  const beats = segments[clip.segIndex]?.beats ?? [];
                  if (beats.length === 0) return null;
                  return beats.map((b, bi) => (
                    <span
                      key={`bt${clip.segIndex}-${bi}`}
                      className={`tl-beat ${b.kind === 'accent' ? 'accent' : 'mark'}`}
                      style={{left: px(clip.startSec + b.t)}}
                      onPointerDown={(e) => onBeatPointerDown(e, clip.segIndex, bi)}
                      onDoubleClick={() => onBeatDoubleClick(clip.segIndex, bi)}
                      onContextMenu={(e) => onBeatContextMenu(e, clip.segIndex, bi)}
                      title={`节拍 ${b.t.toFixed(1)}s · ${b.kind === 'accent' ? '重拍/强调' : '普通标记'}${b.target ? ` · ${b.target}` : ''}${b.note ? ` · ${b.note}` : ''}\n拖动调位置（0.1s 步进）；双击切重拍/普通；右键删除`}
                    />
                  ));
                })}
              </div>
            </div>
          )}

          {/* 旁白轨（块起点 = 段起点 + 段内偏移；拖块体 = 调偏移（等转场过去再开口），单击 = 选中该段） */}
          <div className="tl-row tl-row-narr">
            <div className="tl-label"><Mic size={11} /> 旁白</div>
            <div className="tl-cells">
              {!hasNarration && <span className="tl-lane-empty">无旁白（片段「旁白」页可添加）</span>}
              {layout.clips.map((clip) => {
                const n = segments[clip.segIndex].narration;
                if (!n || !n.duration || n.duration <= 0) return null;
                const offset = clampNarrationOffsetSec(n.offsetSec ?? 0, clip.durationSec);
                const peaks = narrPeaksOf(n.path);
                return (
                  <div
                    key={`n${clip.segIndex}`}
                    className={`tl-narr ${clip.segIndex === activeSegmentIndex ? 'active' : ''}`}
                    style={{left: px(clip.startSec + offset), width: Math.max(8, px(n.duration))}}
                    onPointerDown={(e) => onNarrPointerDown(e, clip.segIndex)}
                    title={`第 ${clip.segIndex + 1} 段旁白 · ${n.duration.toFixed(1)}s（段内偏移 ${offset.toFixed(1)}s）：${n.text.slice(0, 30)}（拖动调偏移，单击选中该段，文案在「旁白」页编辑）`}
                  >
                    {peaks && <NarrWave peaks={peaks} duration={n.duration} pxPerSec={pxPerSec} />}
                    <Mic size={9} /> {n.text.slice(0, 14)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* BGM 轨（v1.5：块 = [起播点, 片尾]，波形只画 [截取起点, 截取终点) 窗并循环平铺；
              拖块体/块头 = 调起播点（吸节拍）、块首接缝把手 = 调循环窗终点、单击 = 定位弹层） */}
          <div className="tl-row tl-row-bgm">
            <div className="tl-label tl-label-bgm">
              <Music size={11} /> 音乐
              {bgm && (
                <>
                  <button
                    type="button"
                    className="tl-mini-btn"
                    onClick={() => runTimelineCommand({kind: 'bgm', patch: {volume: bgm.volume > 0 ? 0 : 0.7}})}
                    title={bgm.volume > 0 ? '静音 BGM' : '恢复 BGM 音量'}
                  >
                    {bgm.volume > 0 ? <Volume2 size={11} /> : <VolumeX size={11} />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={bgm.volume}
                    onChange={(e) => runTimelineCommand({kind: 'bgm', patch: {volume: parseFloat(e.target.value)}}, {coalesceKey: 'bgm-volume'})}
                    title={`BGM 音量 ${(bgm.volume * 100) | 0}%`}
                  />
                </>
              )}
            </div>
            <div className="tl-cells">
              {!bgm && <span className="tl-lane-empty">未设置背景音乐（「声音」面板可添加）</span>}
              {bgm && (
                <div
                  className="tl-bgm-clip"
                  style={{left: px(bgmStartAtSec(bgm)), width: Math.max(6, px(Math.max(0.2, layout.totalSec - bgmStartAtSec(bgm))))}}
                  onPointerDown={onBgmClipDown}
                  onDoubleClick={onBgmClipDoubleClick}
                  title={`BGM「${bgm.name}」· 起播 ${bgmStartAtSec(bgm).toFixed(1)}s · 循环窗 ${bgmTrimStartSec(bgm).toFixed(1)}~${bgmTrimEndSec(bgm).toFixed(1)}s（拖动调起播点，单击打开定位；双击空白处加音量包络点）`}
                >
                  {bgm.peaks && bgm.peaks.length > 0 && (
                    <TimelineWaveform
                      peaks={bgm.peaks}
                      srcStartSec={bgmTrimStartSec(bgm)}
                      spanSec={bgmLoopSpanSec(bgm)}
                      srcDuration={bgm.duration}
                      totalSec={layout.totalSec}
                      startAtSec={bgmStartAtSec(bgm)}
                      pxPerSec={pxPerSec}
                    />
                  )}
                  {/* 循环窗终点把手（画在首个接缝处 = 块头 + 窗长；右拖带走更长素材，左拖循环更短） */}
                  <span
                    className="tl-bgm-trim-end"
                    style={{left: px(bgmLoopSpanSec(bgm))}}
                    onPointerDown={onBgmTrimEndDown}
                    title={`循环窗终点 ${bgmTrimEndSec(bgm).toFixed(1)}s（素材时长 ${bgm.duration.toFixed(1)}s；拖动调整，从「截取起点」起的这段循环平铺到片尾）`}
                  />
                  {/* 音量包络线（音量随时间起伏；双击块加点、拖点移动、双击点删除。
                      无点时画 bgm.volume 水平虚线提示可双击；点后折线首尾延伸端值。
                      底部节拍刻度（W3）：时间轴坐标拍位竖刻度，拖段/拖包络点时可目视对齐 bar 线 */}
                  <svg className="tl-bgm-env" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {bgmTimelineBeats(bgm).map((beatSec) => {
                      const x = ((beatSec - bgmStartAtSec(bgm)) / bgmEnvSpan) * 100;
                      if (x < 0 || x > 100) return null;
                      return (
                        <line
                          key={`beat-${beatSec}`}
                          x1={x}
                          y1={88}
                          x2={x}
                          y2={97}
                          stroke="rgba(165, 180, 252, 0.55)"
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                    {(() => {
                      const keys = bgm.volumeKeys ?? [];
                      const yOf = (v: number) => 3 + (1 - v) * 94;
                      const pts = keys.length > 0
                        ? [
                            {x: 0, y: yOf(keys[0].volume)},
                            ...keys.map((k) => ({x: (k.sec / bgmEnvSpan) * 100, y: yOf(k.volume)})),
                            {x: 100, y: yOf(keys[keys.length - 1].volume)},
                          ]
                        : [
                            {x: 0, y: yOf(bgm.volume)},
                            {x: 100, y: yOf(bgm.volume)},
                          ];
                      return (
                        <polyline
                          points={pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
                          fill="none"
                          stroke={keys.length > 0 ? 'rgba(165, 180, 252, 0.95)' : 'rgba(165, 180, 252, 0.45)'}
                          strokeWidth={keys.length > 0 ? 1.6 : 1.2}
                          strokeDasharray={keys.length > 0 ? undefined : '3 3'}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })()}
                  </svg>
                  {(bgm.volumeKeys ?? []).map((k, i) => (
                    <span
                      key={`env-${i}`}
                      className="tl-bgm-env-point"
                      style={{left: `${(k.sec / bgmEnvSpan) * 100}%`, top: `${3 + (1 - k.volume) * 94}%`}}
                      onPointerDown={(e) => onBgmEnvPointDown(e, i)}
                      onDoubleClick={(e) => onBgmEnvPointDoubleClick(e, i)}
                      title={`音量点 ${(k.volume * 100) | 0}% @ ${k.sec.toFixed(1)}s（拖动调整；双击删除）`}
                    />
                  ))}
                  <span className="tl-bgm-name">{bgm.name}</span>
                </div>
              )}
              {bgm && (
                <>
                  <div
                    className="tl-fade tl-fade-in"
                    style={{left: px(bgmStartAtSec(bgm)), width: px(bgm.fadeIn)}}
                    title={`淡入 ${bgm.fadeIn.toFixed(1)}s（从 BGM 起播点起算，拖右缘调整）`}
                    onPointerDown={(e) => onFadeHandleDown(e, 'in')}
                  />
                  <div
                    className="tl-fade tl-fade-out"
                    style={{left: px(layout.totalSec - bgm.fadeOut), width: px(bgm.fadeOut)}}
                    title={`淡出 ${bgm.fadeOut.toFixed(1)}s（片尾收束，拖左缘调整）`}
                    onPointerDown={(e) => onFadeHandleDown(e, 'out')}
                  />
                </>
              )}
            </div>
          </div>

          {/* 音效轨（v4：自动放置标记 + 手放音效块——时间重叠的块上下错开 = 多轨叠加视图；
              v5：标签可点击折叠，收起时手放块压成单行小刻度不再撑高轨道） */}
          <div className="tl-row tl-row-sfx">
            <div className="tl-label tl-label-sfx">
              <button
                type="button"
                className={`tl-label-toggle ${sfxLaneCollapsed ? 'on' : ''}`}
                onClick={() => setSfxLaneCollapsed((v) => !v)}
                title={sfxLaneCollapsed ? '展开手放音效块（多层叠轨视图，可拖动/点击编辑）' : '收起手放音效块（轨道压回单行，只留小刻度示意）'}
              >
                <AudioLines size={11} /> 音效{!sfxLaneCollapsed && sfxClips.length > 0 ? `·${sfxClips.length}` : ''}
              </button>
              {sfx?.enabled && (
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sfx.volume}
                  onChange={(e) => setSfx({volume: parseFloat(e.target.value)})}
                  title={`音效轨音量 ${(sfx.volume * 100) | 0}%`}
                />
              )}
            </div>
            <div className="tl-cells" style={!sfxLaneCollapsed && sfxClipLanes.laneCount > 1 ? {height: 24 + (sfxClipLanes.laneCount - 1) * 13} : undefined}>
              {!sfx?.enabled && <span className="tl-lane-empty">音效关闭（「声音」面板可开启）</span>}
              {sfx?.enabled && sfxMarks.transitions.map((m, i) => {
                const meta = SFX_KIND_META[m.kind];
                return (
                  <button
                    key={`t${i}`}
                    type="button"
                    className={`tl-sfx-mark tl-sfx-trans ${m.off ? 'off' : ''} ${selectedBoundary === m.segIndex ? 'selected' : ''}`}
                    style={{left: px(m.sec), borderColor: meta.color}}
                    title={`第 ${m.segIndex + 1} → ${m.segIndex + 2} 段转场音效：${m.off ? '已关' : meta.label}（点击编辑该转场）`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedBoundary((v) => (v === m.segIndex ? null : m.segIndex));
                    }}
                  />
                );
              })}
              {sfx?.enabled && sfxMarks.beats.map((m, i) => {
                const meta = SFX_KIND_META[m.kind];
                return (
                  <span
                    key={`s${i}`}
                    className={`tl-sfx-mark tl-sfx-beat ${m.kind === 'impact' ? 'impact' : m.kind === 'click' ? 'click' : 'riser'}`}
                    style={{left: px(m.sec), background: meta.color}}
                    title={`${meta.label}${m.kind === 'impact' ? '（节拍重音）' : m.kind === 'click' ? '（弱拍轻点）' : '（片头）'}`}
                  />
                );
              })}
              {sfx?.enabled && sfxClips.map((c, i) => {
                const meta = SFX_KIND_META[c.kind];
                const lane = sfxClipLanes.lanes[i] ?? 0;
                if (sfxLaneCollapsed) {
                  // 收起态：单行小刻度（不交互；点标签展开编辑）
                  return (
                    <span
                      key={c.id}
                      className="tl-sfx-clipmark mini"
                      style={{left: px(c.atSec), background: meta.color}}
                      title={`手放音效 ${meta.label} · ${c.atSec.toFixed(1)}s（展开音效轨可编辑）`}
                    />
                  );
                }
                return (
                  <span
                    key={c.id}
                    className={`tl-sfx-clipmark ${sfxClipSel === c.id ? 'selected' : ''}`}
                    style={{left: px(c.atSec), width: Math.max(14, px(SFX_CLIP_VISUAL_SEC)), top: 4 + lane * 13, borderColor: meta.color}}
                    onPointerDown={(e) => onSfxClipPointerDown(e, c)}
                    title={`手放音效 ${meta.label} · ${c.atSec.toFixed(1)}s · 音量 ${Math.round(c.volume * 100)}%（拖动调位置，点击改类别/音量/删除）`}
                  >
                    {SFX_KIND_META[c.kind].label.slice(0, 2)}
                  </span>
                );
              })}
            </div>
          </div>

          {/* 覆盖层：节拍网格 + 播放头 + 吸附命中线（pointer-events: none） */}
          <div className="tl-overlay" style={{left: LABEL_W, width: contentWidth}}>
            {beats.map((b, i) =>
              pxPerSec > 8 && (i === 0 || b - beats[i - 1] > 0.01) ? (
                <div key={`g${i}`} className="tl-beat-grid" style={{left: px(b)}} />
              ) : null,
            )}
            <div className="tl-playhead" style={{left: px(playheadSec)}} />
            {snapHintSec != null && <div className="tl-snap-line" style={{left: px(snapHintSec)}} />}
          </div>

          {/* 转场编辑弹层（fixed 定位，挂在滚动容器外防裁剪） */}
          {boundarySeg && selectedBoundary != null && popPos && (
            <TimelineTransitionPopover
              segIndex={selectedBoundary}
              transition={boundarySeg.transition}
              durationSec={
                boundarySeg.transitionParams?.durationSec ??
                getTransitionDefaultSec(boundarySeg.transition) ??
                0.5
              }
              sfxOverride={boundarySeg.transitionSfx}
              left={popPos.left}
              top={popPos.top}
              onChange={(patch) => updateSegmentDirect(selectedBoundary, patch)}
              onOpenCurve={() => setCurveFor(selectedBoundary)}
              onClose={() => setSelectedBoundary(null)}
            />
          )}
        </div>
      </div>

      {/* 整片概览条（v5）：片段布局 + 播放头 + 当前视口窗；点击/拖拽把视口对到该处 */}
      <TimelineMinimap
        scrollRef={scrollRef}
        totalSec={layout.totalSec}
        clips={layout.clips.map((c) => ({
          startSec: c.startSec,
          durationSec: c.durationSec,
          media: (segments[c.segIndex]?.videos?.length ?? 0) > 0,
          active: c.segIndex === activeSegmentIndex,
        }))}
        playheadSec={playheadSec}
        pxPerSec={pxPerSec}
      />

          {/* BGM 定位弹层（fixed 定位在点击处附近） */}
          {bgm && bgmPopAt && (
            <BgmPositionPopover
              bgm={bgm}
              totalSec={layout.totalSec}
              at={bgmPopAt}
              onChange={(patch) => runTimelineCommand({kind: 'bgm', patch}, {coalesceKey: 'bgm-pop'})}
              onClose={() => setBgmPopAt(null)}
            />
          )}

      {/* 转场缓动曲线大窗（弹层入口打开；720px 大画布与「转场行」同一组件） */}
      {curveFor != null && segments[curveFor] && (
        <CurveEditorModal
          open
          title="转场缓动曲线"
          curve={
            segments[curveFor].transitionParams?.curve ??
            presetCurve(DEFAULT_TRANSITION_PRESET[segments[curveFor].transition] ?? 'easeOut')
          }
          onChange={(c) => updateSegmentDirect(curveFor, {transitionParams: {curve: c}})}
          onClose={() => setCurveFor(null)}
        />
      )}

      {/* 片段右键菜单（复制 / 删除 / 在播放头拆分 / 时长微调 / 重渲此段） */}
      {clipMenuAt && (
        <ClipContextMenu
          segIndex={clipMenuAt.segIndex}
          at={{x: clipMenuAt.x, y: clipMenuAt.y}}
          canSplit={menuSplitValid}
          canRemove={segments.length > 1}
          dur={segments[clipMenuAt.segIndex]?.duration ?? 8}
          segLabel={`${clipMenuAt.segIndex + 1}. ${templateName(segments[clipMenuAt.segIndex]?.templateId ?? '')}`}
          onDuplicate={menuDuplicate}
          onRemove={menuRemove}
          onSplit={menuSplit}
          onNudge={menuNudge}
          onSeekToStart={menuSeekToStart}
          onAddBeat={menuAddBeat}
          onRerender={menuRerenderSeg}
          onClose={() => setClipMenuAt(null)}
        />
      )}

      {/* 手放音效编辑弹层（fixed 定位在点击处附近） */}
      {sfx?.enabled && sfxClipSel && sfxClipPopAt && (() => {
        const clip = sfxClips.find((c) => c.id === sfxClipSel);
        if (!clip) return null;
        return (
          <SfxClipPopover
            clip={clip}
            totalSec={layout.totalSec}
            masterVolume={sfx.volume}
            at={sfxClipPopAt}
            onChange={(patch) => runTimelineCommand({kind: 'sfxClipUpdate', id: clip.id, patch}, {coalesceKey: `sfx-${clip.id}`})}
            onRemove={() => {
              runTimelineCommand({kind: 'sfxClipRemove', id: clip.id});
              setSfxClipSel(null);
              setSfxClipPopAt(null);
            }}
            onClose={() => {
              setSfxClipSel(null);
              setSfxClipPopAt(null);
            }}
          />
        );
      })()}

      {/* 整片监视器（v4）：浮窗（标题拖动 / 8 向等比缩放 / 拖到右侧预览区停靠）
          或停靠右栏大窗（portal 进停靠槽；槽未就绪时不挂播放器，就绪后 seek 回播放头） */}
      {monitorMounted && (!docked || dockSlot) && (
        docked && dockSlot ? (
          createPortal(
            <div className="tl-monitor tl-monitor-docked">
              <div className="tl-monitor-head">
                <span>整片预览 <em>已停靠</em></span>
                <div>
                  <button type="button" className="tl-mini-btn" onClick={togglePlay} title="播放/暂停（空格同）">
                    {playing ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                  <button
                    type="button"
                    className="tl-mini-btn"
                    onClick={() => {
                      undockMonitor();
                      setMonitorOpen(true);
                    }}
                    title="取消停靠，回到浮动小窗"
                  >
                    <Maximize2 size={12} />
                  </button>
                </div>
              </div>
              <div className="tl-monitor-body tl-monitor-body-fill">
                <Player
                  ref={playerRef}
                  component={MultiSegmentPromo as React.ComponentType<any>}
                  inputProps={monitorInputProps}
                  durationInFrames={monitorDuration}
                  fps={FPS}
                  compositionWidth={getAspectRatioPreset(aspectRatioId).width}
                  compositionHeight={getAspectRatioPreset(aspectRatioId).height}
                  style={{width: '100%', height: '100%'}}
                  controls
                  loop={false}
                  autoPlay={false}
                  initiallyMuted
                  spaceKeyToPlayOrPause={false}
                  clickToPlay={false}
                />
              </div>
            </div>,
            dockSlot,
          )
        ) : (
          <div
            className={`tl-monitor ${draggingMonitor ? 'dragging' : ''}`}
            ref={monitorFloatRef}
            style={monitorPos ? {left: monitorPos.left, top: monitorPos.top, right: 'auto', width: monitorWidth} : {width: monitorWidth}}
          >
            <div className="tl-monitor-head" onPointerDown={onMonitorHeadDown} title="拖动移动浮窗；拖到右侧预览区停靠成大窗">
              <span>整片监视器 <em>轻量预览</em></span>
              <div>
                <button type="button" className="tl-mini-btn" onClick={togglePlay} title="播放/暂停（空格同）">
                  {playing ? <Pause size={12} /> : <Play size={12} />}
                </button>
                <button
                  type="button"
                  className="tl-mini-btn"
                  onClick={() => {
                    setMonitorOpen(false);
                    setPlaying(false);
                  }}
                  title="关闭监视器"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <div
              className="tl-monitor-body"
              style={{aspectRatio: `${getAspectRatioPreset(aspectRatioId).width} / ${getAspectRatioPreset(aspectRatioId).height}`}}
            >
              <Player
                ref={playerRef}
                component={MultiSegmentPromo as React.ComponentType<any>}
                inputProps={monitorInputProps}
                durationInFrames={monitorDuration}
                fps={FPS}
                compositionWidth={getAspectRatioPreset(aspectRatioId).width}
                compositionHeight={getAspectRatioPreset(aspectRatioId).height}
                style={{width: '100%', height: '100%'}}
                controls={false}
                loop={false}
                autoPlay={false}
                initiallyMuted
                spaceKeyToPlayOrPause={false}
                clickToPlay={false}
              />
            </div>
            {/* 8 向等比缩放手柄（宽度唯一自由量，高度按画幅跟随） */}
            {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map((dir) => (
              <span
                key={dir}
                className={`tl-mon-handle tl-mon-${dir}`}
                onPointerDown={(e) => onMonitorResizeDown(e, dir)}
                title={dir.length === 2 ? '拖动等比缩放（锁定画幅比例）' : '拖动等比缩放（锁定画幅比例）'}
              />
            ))}
          </div>
        )
      )}

      {/* 拖拽数值气泡（fixed，跟随光标；各拖拽 move 中实时更新） */}
      {dragTip && (
        <div className="tl-drag-tip" style={{left: dragTip.x, top: dragTip.y}}>
          {dragTip.text}
        </div>
      )}
    </div>
  );
};

/** 片段右键菜单（fixed 定位在点击处；外点/滚动关闭） */
const ClipContextMenu: React.FC<{
  segIndex: number;
  at: {x: number; y: number};
  canSplit: boolean;
  canRemove: boolean;
  dur: number;
  segLabel: string;
  onDuplicate: () => void;
  onRemove: () => void;
  onSplit: () => void;
  onNudge: (delta: number) => void;
  onSeekToStart: () => void;
  onAddBeat: () => void;
  onRerender: () => void;
  onClose: () => void;
}> = ({segIndex, at, canSplit, canRemove, dur, segLabel, onDuplicate, onRemove, onSplit, onNudge, onSeekToStart, onAddBeat, onRerender, onClose}) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const left = Math.min(Math.max(8, at.x), window.innerWidth - 168);
  const top = Math.min(Math.max(8, at.y), window.innerHeight - 232);
  return (
    <div className="tl-ctx-menu" ref={ref} style={{left, top}} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tl-ctx-title">{segLabel}</div>
      <button type="button" className="tl-ctx-item" onClick={onSeekToStart} title="播放头跳到此段开头（空格即从此段预览）">
        <Play size={12} /> 播放头到段首
      </button>
      <button type="button" className="tl-ctx-item" onClick={onAddBeat} title="在播放头处加一个节拍标记（M3 L2：合成时与 BGM 拍点并流供踩拍类模板消费，无 BGM 也生效；节拍巷可拖动/双击切重拍/右键删）">
        <Zap size={12} /> 加节拍标记
      </button>
      <button type="button" className="tl-ctx-item" onClick={() => onNudge(0.5)} disabled={dur >= MAX_DUR_EPS} title="时长加 0.5 秒（拖右缘难精调时的数值微调）">
        <Clock size={12} /> 时长 +0.5s
      </button>
      <button type="button" className="tl-ctx-item" onClick={() => onNudge(-0.5)} disabled={dur <= MIN_DUR_EPS} title="时长减 0.5 秒">
        <Clock size={12} /> 时长 −0.5s
      </button>
      <button type="button" className="tl-ctx-item" onClick={onDuplicate}>
        <Copy size={12} /> 复制片段
      </button>
      <button type="button" className="tl-ctx-item" onClick={onSplit} disabled={!canSplit} title={canSplit ? '在播放头处拆成两段' : '播放头不在该片段内（或离头尾不足 0.5 秒）'}>
        <Scissors size={12} /> 在播放头拆分
      </button>
      <button type="button" className="tl-ctx-item" onClick={onRerender} title="强制重渲该段及其边界转场（其余段走缓存直接拼接；怀疑画面旧/缓存脏时用）">
        <RefreshCw size={12} /> 重渲此段
      </button>
      <button type="button" className="tl-ctx-item tl-ctx-danger" onClick={onRemove} disabled={!canRemove} title={canRemove ? '删除该片段（Ctrl+Z 可撤销）' : '只剩一个片段，不可删除'}>
        <Trash2 size={12} /> 删除片段
      </button>
      <div className="tl-ctx-note">第 {segIndex + 1} 片段 · 左键拖拽重排 / 拖右缘调时长</div>
    </div>
  );
};

/** 手放音效编辑弹层：试听 / 类别 / 位置 / 音量 / 删除（fixed 定位在点击处附近）。
 *  试听与导出同源：变体按 clip id 确定性哈希、音量 = 主音量 × 块音量 × 类别增益（SFX_KIND_GAIN）。 */
const SfxClipPopover: React.FC<{
  clip: SfxClip;
  totalSec: number;
  masterVolume: number;
  at: {x: number; y: number};
  onChange: (patch: Partial<Pick<SfxClip, 'kind' | 'atSec' | 'volume'>>) => void;
  onRemove: () => void;
  onClose: () => void;
}> = ({clip, totalSec, masterVolume, at, onChange, onRemove, onClose}) => {
  const ref = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [auditioning, setAuditioning] = useState(false);
  const [srcCount, setSrcCount] = useState<number | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  // 类别可用变体数（决定试听可否）；卸载/换类别时停掉在放的试听
  useEffect(() => {
    let cancelled = false;
    setSrcCount(null);
    getSfxSources().then((lib) => {
      if (!cancelled) setSrcCount((lib[clip.kind] ?? []).length);
    });
    return () => {
      cancelled = true;
      audioRef.current?.pause();
      audioRef.current = null;
      setAuditioning(false);
    };
  }, [clip.kind]);
  const audition = async () => {
    const lib = await getSfxSources();
    const srcs = lib[clip.kind] ?? [];
    if (srcs.length === 0) return;
    audioRef.current?.pause();
    const a = new Audio(srcs[sfxClipVariant(clip.id, srcs.length)]);
    a.volume = Math.max(0, Math.min(1, masterVolume * clampSfxClipVolume(clip.volume) * SFX_KIND_GAIN[clip.kind]));
    a.onended = () => setAuditioning(false);
    audioRef.current = a;
    try {
      await a.play();
      setAuditioning(true);
    } catch {
      setAuditioning(false);
    }
  };
  const left = Math.min(Math.max(8, at.x - 100), window.innerWidth - 232);
  const top = Math.min(at.y + 12, window.innerHeight - 236);
  return (
    <div className="tl-trans-pop" ref={ref} style={{left, top}} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tl-trans-pop-title">手放音效 · {SFX_KIND_META[clip.kind].label}</div>
      <button
        type="button"
        className="tl-tool-btn"
        style={{justifyContent: 'center'}}
        onClick={audition}
        disabled={srcCount === 0}
        title={srcCount === 0 ? '该类别音效库缺货（导入资源后可试听）' : '试听该音效（变体与音量口径和导出一致）'}
      >
        <Volume2 size={12} /> {auditioning ? '试听中…' : '试听'}
      </button>
      <label className="tl-trans-pop-row">
        类别
        <select
          className="select-compact"
          value={clip.kind}
          onChange={(e) => onChange({kind: e.target.value as SfxKind})}
          style={{width: 118}}
        >
          {(Object.keys(SFX_KIND_META) as SfxKind[]).map((k) => (
            <option key={k} value={k}>{SFX_KIND_META[k].label}</option>
          ))}
        </select>
      </label>
      <label className="tl-trans-pop-row">
        位置
        <input
          type="number"
          className="input-compact"
          min={0}
          max={Math.max(0, totalSec - 0.1)}
          step={0.1}
          value={clip.atSec}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange({atSec: v});
          }}
          style={{width: 70}}
        />
        <span className="tl-trans-pop-unit">秒（全片）</span>
      </label>
      <label className="tl-trans-pop-row">
        音量
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={clip.volume}
          onChange={(e) => onChange({volume: parseFloat(e.target.value)})}
          style={{width: 90, accentColor: SFX_KIND_META[clip.kind].color}}
        />
        <span className="tl-trans-pop-unit">{Math.round(clip.volume * 100)}%</span>
      </label>
      <button type="button" className="tl-tool-btn tl-ctx-danger" style={{justifyContent: 'center'}} onClick={onRemove}>
        <Trash2 size={12} /> 删除该音效
      </button>
      <p className="tl-trans-pop-note">拖块体调位置（开吸附时吸节拍/边界）；多个音效时间重叠自动多轨混音；Delete 键删除选中块</p>
    </div>
  );
};

/** BGM 波形（媒体窗 [srcStartSec, srcStartSec+spanSec) 从块头起循环平铺到片尾；
 *  canvas 按 CSS 像素画，DPR 缩放保清晰；与渲染 planBgmLoop 同语义） */
const TimelineWaveform: React.FC<{
  peaks: number[];
  srcStartSec: number;
  spanSec: number;
  srcDuration: number;
  totalSec: number;
  startAtSec: number;
  pxPerSec: number;
}> = ({peaks, srcStartSec, spanSec, srcDuration, totalSec, startAtSec, pxPerSec}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 画布宽度护栏：超长片高倍缩放时上限 20000px，超出部分不画（canvas 尺寸上限保护）
  const width = Math.min(Math.max(0, totalSec - startAtSec) * pxPerSec, 20000);
  const height = 30;
  const span = Math.max(0.2, spanSec);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0 || srcDuration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const barW = 2;
    // 块内时间轴 x → 窗内偏移 (x/pps) % span → 媒体时间 srcStart + 偏移
    ctx.fillStyle = 'rgba(99, 102, 241, 0.45)';
    for (let x = 0; x < width; x += barW + 1) {
      const intoSpan = (x / pxPerSec) % span;
      const t = srcStartSec + intoSpan;
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor((t / srcDuration) * peaks.length)));
      const h = Math.max(1, peaks[idx] * mid * 0.95);
      ctx.fillRect(x, mid - h, barW, h * 2);
    }
    // 循环接缝淡竖线（从第二份起；与渲染接缝交叉淡化位置一致）
    ctx.fillStyle = 'rgba(99, 102, 241, 0.25)';
    for (let k = 1; k * span * pxPerSec < width; k++) {
      ctx.fillRect(Math.round(k * span * pxPerSec), 2, 1, height - 4);
    }
  }, [peaks, srcStartSec, span, srcDuration, width, pxPerSec, height]);
  return <canvas ref={canvasRef} className="tl-waveform" style={{width, height}} />;
};

/** BGM 定位弹层：起播点 / 截取起点 / 截取终点（音轨「自由调起止」的数值入口；fixed 定位在点击处附近） */
const BgmPositionPopover: React.FC<{
  bgm: BgmTrack;
  totalSec: number;
  at: {x: number; y: number};
  onChange: (patch: {startAtSec?: number; trimStartSec?: number; trimEndSec?: number}) => void;
  onClose: () => void;
}> = ({bgm, totalSec, at, onChange, onClose}) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const startAt = bgmStartAtSec(bgm);
  const ts = bgmTrimStartSec(bgm);
  const te = bgmTrimEndSec(bgm);
  const left = Math.min(Math.max(at.x - 108, 8), window.innerWidth - 232);
  const top = Math.min(at.y + 14, window.innerHeight - 210);
  const num = (v: string): number | undefined => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return (
    <div className="tl-trans-pop" ref={ref} style={{left, top}} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tl-trans-pop-title">BGM 定位 · {bgm.name}</div>
      <label className="tl-trans-pop-row">
        起播点
        <input
          type="number"
          className="input-compact"
          min={0}
          max={Math.max(0, totalSec - 0.5)}
          step={0.1}
          value={startAt}
          onChange={(e) => {
            const v = num(e.target.value);
            if (v !== undefined) onChange({startAtSec: Math.max(0, Math.min(totalSec - 0.5, Math.round(v * 10) / 10))});
          }}
          style={{width: 70}}
        />
        <span className="tl-trans-pop-unit">秒（前段静音）</span>
      </label>
      <label className="tl-trans-pop-row">
        截取起点
        <input
          type="number"
          className="input-compact"
          min={0}
          max={Math.max(0, bgm.duration - 2)}
          step={0.1}
          value={ts}
          onChange={(e) => {
            const v = num(e.target.value);
            if (v !== undefined) onChange({trimStartSec: Math.max(0, Math.min(bgm.duration - 2, Math.round(v * 10) / 10))});
          }}
          style={{width: 70}}
        />
        <span className="tl-trans-pop-unit">秒（掐前奏）</span>
      </label>
      <label className="tl-trans-pop-row">
        截取终点
        <input
          type="number"
          className="input-compact"
          min={ts + 2}
          max={bgm.duration}
          step={0.1}
          value={te}
          onChange={(e) => {
            const v = num(e.target.value);
            if (v !== undefined) onChange({trimEndSec: Math.max(ts + 2, Math.min(bgm.duration, Math.round(v * 10) / 10))});
          }}
          style={{width: 70}}
        />
        <span className="tl-trans-pop-unit">秒（循环窗 {(te - ts).toFixed(1)}s）</span>
      </label>
      <button
        type="button"
        className="tl-tool-btn"
        style={{justifyContent: 'center'}}
        onClick={() => onChange({startAtSec: undefined, trimStartSec: undefined, trimEndSec: undefined})}
        title="清除三个定位字段，回到从头播到尾"
      >
        重置（从头播到尾）
      </button>
      <p className="tl-trans-pop-note">拖动时间轴上的音乐块 = 调起播点（吸节拍）；块首接缝把手 = 调循环窗终点</p>
    </div>
  );
};

/** 转场编辑弹层：类型 / 时长 / 音效 / 缓动曲线入口（视频+音频双轨转场的统一编辑点；fixed 定位在滚动容器外） */
const TimelineTransitionPopover: React.FC<{
  segIndex: number;
  transition: TransitionType;
  durationSec: number;
  sfxOverride?: SfxKind | 'off';
  left: number;
  top: number;
  onChange: (patch: {
    transition?: TransitionType;
    transitionParams?: {durationSec: number} | {curve: EasingCurve};
    transitionSfx?: SfxKind | 'off' | null;
  }) => void;
  onOpenCurve: () => void;
  onClose: () => void;
}> = ({segIndex, transition, durationSec, sfxOverride, left, top, onChange, onOpenCurve, onClose}) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // pointerdown 捕获阶段：先于轨道自己的 pointerdown 收起弹层
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  return (
    <div className="tl-trans-pop" ref={ref} style={{left, top}} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tl-trans-pop-title">
        第 {segIndex + 1} → {segIndex + 2} 段转场
      </div>
      <label className="tl-trans-pop-row">
        类型
        <select
          className="select-compact"
          value={transition}
          onChange={(e) => onChange({transition: e.target.value as TransitionType})}
          style={{width: 118}}
        >
          <option value="none">无（硬切）</option>
          {['基础', '遮罩', '运动', '特效', '运镜', '遮挡'].map((group) => (
            <optgroup key={group} label={group}>
              {TRANSITION_OPTIONS.filter((o) => o.group === group).map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="tl-trans-pop-row">
        时长
        <input
          type="number"
          className="input-compact"
          min={0.2}
          max={2}
          step={0.05}
          value={Number(durationSec.toFixed(2))}
          disabled={transition === 'none'}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange({transitionParams: {durationSec: Math.max(0.2, Math.min(2, v))}});
          }}
          style={{width: 70}}
        />
        <span className="tl-trans-pop-unit">秒</span>
      </label>
      <label className="tl-trans-pop-row">
        音效
        <select
          className="select-compact"
          value={sfxOverride ?? 'auto'}
          disabled={transition === 'none'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'auto') onChange({transitionSfx: null});
            else onChange({transitionSfx: v as SfxKind | 'off'});
          }}
          style={{width: 118}}
        >
          <option value="auto">自动（按转场类型）</option>
          {(Object.keys(SFX_KIND_META) as SfxKind[]).map((k) => (
            <option key={k} value={k}>{SFX_KIND_META[k].label}</option>
          ))}
          <option value="off">关闭</option>
        </select>
      </label>
      <button
        type="button"
        className="tl-tool-btn"
        style={{justifyContent: 'center'}}
        onClick={onOpenCurve}
        disabled={transition === 'none'}
        title="编辑该转场的缓动曲线（AE 风格速度曲线大窗）"
      >
        <Sparkles size={12} /> 缓动曲线
      </button>
      <p className="tl-trans-pop-note">运镜焦点（zoomIn/zoomOut/shapeBloom）在选中片段后的「转场行」细调</p>
    </div>
  );
};

/** 整片概览条（v5）：全片片段布局 + 播放头 + 当前视口窗；点击/拖拽把视口对到该处。
 *  自持滚动监听（rAF 节流）——滚动只重资本组件，不惊动整个时间轴面板。 */
const TimelineMinimap: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  totalSec: number;
  clips: Array<{startSec: number; durationSec: number; media: boolean; active: boolean}>;
  playheadSec: number;
  pxPerSec: number;
}> = ({scrollRef, totalSec, clips, playheadSec, pxPerSec}) => {
  const startDrag = useWindowDrag();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({left: 0, span: 1});
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const upd = () => {
      raf = 0;
      setView({left: el.scrollLeft / pxPerSec, span: Math.max(0.1, (el.clientWidth - LABEL_W) / pxPerSec)});
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(upd);
    };
    el.addEventListener('scroll', onScroll, {passive: true});
    upd();
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, pxPerSec]);
  const jump = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const body = bodyRef.current;
    const el = scrollRef.current;
    if (!body || !el) return;
    const rect = body.getBoundingClientRect();
    const apply = (clientX: number) => {
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      // 视口中心对到点击处（与播放追帧同款 scrollLeft 口径）
      el.scrollLeft = Math.max(0, frac * totalSec * pxPerSec - (el.clientWidth - LABEL_W) / 2);
    };
    apply(e.clientX);
    startDrag(
      (ev) => apply(ev.clientX),
      () => {
        /* 拖拽中已实时跳转 */
      },
    );
  };
  if (totalSec <= 0) return null;
  const pct = (s: number) => `${(Math.max(0, Math.min(totalSec, s)) / totalSec) * 100}%`;
  return (
    <div className="tl-minimap">
      <div className="tl-minimap-label">
        <Film size={11} /> 概览
      </div>
      <div
        className="tl-minimap-body"
        ref={bodyRef}
        onPointerDown={jump}
        title="整片概览：点击/拖拽把视口对到该处（实心=有素材段，空心=文字模板段；矩形=当前视口，红线=播放头）"
      >
        {clips.map((c, i) => (
          <div
            key={i}
            className={`tl-mm-seg ${c.media ? 'media' : 'text'} ${c.active ? 'active' : ''}`}
            style={{left: pct(c.startSec), width: pct(c.durationSec)}}
          />
        ))}
        <div className="tl-mm-view" style={{left: pct(view.left), width: pct(view.span)}} />
        <div className="tl-mm-playhead" style={{left: pct(playheadSec)}} />
      </div>
    </div>
  );
};

/** 旁白波形（v5）：媒体窗直绘（无循环平铺；peaks 与 BGM 同一 analyzeAudio 口径，DPR 保清晰） */
const NarrWave: React.FC<{peaks: number[]; duration: number; pxPerSec: number}> = ({peaks, duration, pxPerSec}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = Math.min(Math.max(2, duration * pxPerSec), 20000);
  const height = 14;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0 || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    for (let x = 0; x < width; x += 2) {
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor((x / pxPerSec / duration) * peaks.length)));
      const h = Math.max(0.5, (peaks[idx] ?? 0) * mid * 0.9);
      ctx.fillRect(x, mid - h, 1.4, h * 2);
    }
  }, [peaks, duration, width, pxPerSec, height]);
  return <canvas ref={canvasRef} className="tl-narr-wave" style={{width, height}} />;
};

export default TimelinePanel;
