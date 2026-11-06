/**
 * 步骤 2: 视频上传组件
 *
 * 修复内容：
 * 1. 修复拖放上传（通过 webUtils.getPathForFile 获取真实文件路径）
 * 2. 添加视频预览（video 缩略图 + blob URL 预览）
 * 3. 添加视频时长限制（默认 30 秒）和剪辑工具入口
 */

import React, {useCallback, useRef, useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {useUIStore} from '../store/uiStore';
import type {VideoClip} from '../../shared/types';
import type {ClipCut} from '../../shared/clipCuts';
import {COLOR_CURVES, colorCurveMeta, guessColorCurveFromTags, type ColorCurveId} from '../../shared/proxy-media.ts';
import {SOURCE_KINDS, SOURCE_KIND_LABELS, guessSourceKind, type MediaSourceKind} from '../../shared/source-kind';
import {clipSrcToPath} from '../utils/clipPath';
import {VideoTrimmer} from './VideoTrimmer';
import {ClipViewportEditor} from './ClipViewportEditor';
import {isDefaultViewport} from '../../remotion/utils/viewport';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import {isDataDrivenTemplateId, findDataDrivenDef} from '../../shared/template-registry';
import {evalProp} from '../../shared/custom-template';
import {Video, Image as ImageIcon, AlertTriangle, Scissors, X, Crop, Volume2, VolumeX, Monitor, MousePointer2, RefreshCw, Crosshair, Box, Sparkles, Info, Pencil} from 'lucide-react';
import {ScreenRecorderModal} from './ScreenRecorderModal';
import {HighlightModal} from './HighlightModal';
import {StabilizeModal} from './StabilizeModal';
import {GroundModal} from './GroundModal';
import {codecPreviewWarning} from '../../shared/codec-preview';
import './VideoUploader.css';

const MAX_DURATION = 120; // 视频时长软上限（秒）：超过只是提示剪辑，不强制拒绝

// 取景仅对 PiP 画框类模板生效（KenBurns 等全幅模板自带构图，不支持取景）
const VIEWPORT_TEMPLATE_IDS = new Set(['RevealSlide', 'StackCards', 'CinematicPan', 'SplitShowcase', 'MinimalFloat']);

/** 导入提示条（内联可关闭，替代原生 alert：不阻塞、多条堆叠、样式随级别） */
interface UploaderNotice {
  id: number;
  kind: 'warn' | 'info';
  text: string;
}
let noticeSeq = 0;

export const VideoUploader: React.FC = () => {
  const {
    videos,
    addVideosToCurrent,
    removeVideoFromCurrent,
    updateVideoTrim,
    updateVideoViewport,
    updateVideoAudio,
    updateVideoCursorDemo,
    updateVideoCursorTrack,
    templateId,
    layout,
    aspectRatioId,
    customTemplates,
    marketTemplates,
  } = useProjectStore();
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // 动作脚本编辑器（null = 收起；字符串 = 编辑中内容）
  const [editingScript, setEditingScript] = useState<string | null>(null);
  // 内联提示条（编码警告/Log 猜测等导入反馈；替代原生 alert 的非阻塞方案）
  const [notices, setNotices] = useState<UploaderNotice[]>([]);
  const pushNotices = useCallback((items: Array<{kind: UploaderNotice['kind']; text: string}>) => {
    if (items.length === 0) return;
    setNotices((prev) => [
      ...prev.slice(-4), // 最多保留 5 条，防反复导入堆屏
      ...items.map((n) => ({id: ++noticeSeq, ...n})),
    ]);
  }, []);
  const [trimmingIndex, setTrimmingIndex] = useState<number | null>(null);
  const [viewportIndex, setViewportIndex] = useState<number | null>(null);
  const [stabIndex, setStabIndex] = useState<number | null>(null);
  const [groundIndex, setGroundIndex] = useState<number | null>(null);
  // 弹窗打开瞬间的活动段下标：分析是异步的（可达数十秒），期间用户可能关弹窗、切片段，
  // 完成时的写回必须锚定打开时的段，否则会写进别的片段（详见 StabilizeModal/GroundModal）
  const stabSegmentRef = useRef(0);
  const groundSegmentRef = useRef(0);
  const [showRecorder, setShowRecorder] = useState(false);

  // 当前模板是否支持取景
  const supportsViewport = templateId
    ? VIEWPORT_TEMPLATE_IDS.has(templateId) || isDataDrivenTemplateId(templateId)
    : false;

  // 推导当前片段 PiP 画框的宽高比（与模板渲染时的画框尺寸算法一致）
  const getPipFrameAspect = (): number => {
    const preset = getAspectRatioPreset(aspectRatioId);
    // SplitShowcase：画框是固定分区（横屏 0.5W×0.8H / 竖屏 0.84W×0.45H），不走 layout 比例
    if (templateId === 'SplitShowcase') {
      return preset.orientation === 'landscape'
        ? (0.5 * preset.width) / (0.8 * preset.height)
        : (0.84 * preset.width) / (0.45 * preset.height);
    }
    // 自定义/市场模板：取第一个视频元素的宽高比（动画尺寸取第 0 帧值，近似）
    if (templateId && isDataDrivenTemplateId(templateId)) {
      const def = findDataDrivenDef(templateId, customTemplates, marketTemplates);
      const videoEl = def?.elements.find((e) => e.type === 'video');
      if (videoEl) {
        const w = evalProp(videoEl.width, 0, 300, 0.6);
        const h = evalProp(videoEl.height, 0, 300, 0.5);
        if (w > 0 && h > 0) return (w * preset.width) / (h * preset.height);
      }
      return preset.width / preset.height; // 无视频元素时回退为画布比例
    }
    // 其余 PiP 模板：画框 = 画布 × layout 比例
    return (layout.videoWidthRatio * preset.width) / (layout.videoHeightRatio * preset.height);
  };

  // 通过文件路径获取视频元数据并添加到列表
  const processAndAddVideos = useCallback(
    async (filePaths: string[]) => {
      if (filePaths.length === 0) return;

      setIsLoading(true);
      try {
        const videoClips: VideoClip[] = [];
        const codecWarnings: string[] = [];

        for (const filePath of filePaths) {
          // 通过 IPC 获取视频元数据
          const metadata = await window.api.getVideoMetadata(filePath);
          // 编码预览白名单警告（hevc/prores 等 Chromium 解不动；导出渲染走 ffmpeg 不受影响）
          const codecWarning = metadata.type === 'video' ? codecPreviewWarning(metadata.codec) : null;
          if (codecWarning) codecWarnings.push(codecWarning);
          // 转为 HTTP URL 供 Remotion 渲染使用（headless Chromium 阻止 file://）
          const httpUrl = await window.api.getVideoHttpUrl(filePath);

          const dur = metadata.duration;
          // Log 曲线猜测（ffprobe 设备元数据 → 厂牌；无歧义自动填）
          const guess = metadata.type === 'video' && (metadata.make || metadata.model)
            ? guessColorCurveFromTags(metadata.make ?? '', metadata.model ?? '')
            : null;
          const clip: VideoClip = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            src: httpUrl,  // HTTP URL，渲染时直接可用
            name: filePath.split('\\').pop() || filePath.split('/').pop() || 'unknown',
            type: metadata.type,  // 'video' | 'image'
            width: metadata.width,
            height: metadata.height,
            duration: dur,
            trimStart: 0,
            trimEnd: dur,
            trimmedDuration: dur,
            ...(guess?.curve ? {colorCurve: guess.curve} : {}),
            sourceKind: guessSourceKind({type: metadata.type, width: metadata.width, height: metadata.height, make: metadata.make, model: metadata.model, ext: filePath.split('.').pop() ?? ''}),
          };
          // mxf/超大/4K：后台代理（缓存命中带 proxyPath；未命中事件回写 proxyStatus）
          if (metadata.type === 'video' && window.api.proxyPrepare) {
            try {
              const job = await window.api.proxyPrepare({path: filePath, colorCurve: guess?.curve});
              if (job.status === 'ready' && job.proxyPath) {
                clip.proxyPath = job.proxyPath;
                clip.proxyStatus = 'ready';
              } else if (job.status !== 'not-needed') {
                clip.proxyStatus = 'queued';
              }
            } catch {
              // 代理探测失败不阻塞上传
            }
          }
          // 色彩统计（自动曝光匹配用；失败静默跳过，不影响上传）
          try {
            const stats = await window.api.analyzeMediaColor(filePath);
            if (stats) clip.colorStats = stats;
          } catch {
            /* 分析失败不阻塞 */
          }

          videoClips.push(clip);
        }

        addVideosToCurrent(videoClips);

        // 编码警告汇总（内联提示条，非阻塞）
        pushNotices(codecWarnings.map((text) => ({kind: 'warn' as const, text})));

        // 如果第一个视频时长超限，自动弹出剪辑器
        if (videoClips[0] && videoClips[0].duration > MAX_DURATION) {
          setTimeout(() => setTrimmingIndex(0), 500);
        }
      } catch (err) {
        console.error('处理视频失败:', err);
      } finally {
        setIsLoading(false);
      }
    },
    [addVideosToCurrent, pushNotices]
  );

  // 点击选择文件
  const handleSelectFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const selected = await window.api.selectVideos();
      if (selected && selected.length > 0) {
        // 主进程已做好探测：colorCurve（厂牌猜测）/ proxyPath（缓存命中）/ proxyStatus 剥临时字段入 store
        const clips = selected.map(({codecWarning: _cw, colorCurveGuessNote: _note, proxyQueued: _pq, ...clip}) => ({
          ...clip,
          ...( _pq ? {proxyStatus: 'queued' as const} : {}),
        }));
        addVideosToCurrent(clips);
        // P0-1 体裁自动路由：从未设定过体裁的新工程 + 实拍占多数 → vlog（一次性，可见提示不静默）
        const routed = useProjectStore.getState().maybeAutoRouteVideoType();
        if (routed) {
          pushNotices([{kind: 'info', text: `检测到实拍素材为主，工程体裁已自动切到「生活 vlog」——AI 工作流与模板推荐随体裁变化，可在故事板上方体裁下拉改回`}]);
        }
        // Log 曲线确认提示（歧义厂牌 Canon/ARRI 猜不了，引导用素材卡「曲线」下拉确认）
        pushNotices(selected.filter((v) => v.colorCurveGuessNote).map((v) => ({kind: 'info' as const, text: `${v.name}：${v.colorCurveGuessNote}`})));
        const proxyQueuedCount = selected.filter((v) => v.proxyQueued).length;
        if (proxyQueuedCount > 0) {
          const {setStatusText} = useUIStore.getState();
          setStatusText(`${proxyQueuedCount} 个大素材正在后台生成代理（编辑不受影响，就绪后自动切换）`);
        }
        // 编码预览白名单警告（主进程已按编码名判好；内联提示条非阻塞）
        pushNotices(selected.filter((v) => v.codecWarning).map((v) => ({kind: 'warn' as const, text: v.codecWarning as string})));
        // 检查时长
        const firstLong = selected.findIndex((v) => v.duration > MAX_DURATION);
        if (firstLong >= 0) {
          setTimeout(() => setTrimmingIndex(firstLong), 500);
        }
      }
    } catch (err) {
      console.error('选择文件失败:', err);
    } finally {
      setIsLoading(false);
    }
  }, [addVideosToCurrent, pushNotices]);

  // 拖放处理 —— 关键修复：使用 webUtils.getPathForFile 获取真实路径
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // 从 File 对象获取 Electron 真实路径
      const paths: string[] = [];
      for (const file of files) {
        const realPath = window.api.getPathForFile(file);
        if (realPath) {
          paths.push(realPath);
        }
      }

      if (paths.length > 0) {
        await processAndAddVideos(paths);
      }
    },
    [processAndAddVideos]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  // 确认剪辑（含挖段列表：null/undefined = 无挖段）
  const handleTrimConfirm = (index: number, trimStart: number, trimEnd: number, cuts?: ClipCut[]) => {
    updateVideoTrim(index, trimStart, trimEnd, cuts);
    setTrimmingIndex(null);

    // 检查下一个是否需要剪辑
    const nextIdx = index + 1;
    if (nextIdx < videos.length && videos[nextIdx].duration > MAX_DURATION) {
      setTimeout(() => setTrimmingIndex(nextIdx), 300);
    }
  };

  // 是否有超限视频
  const hasOversizedVideos = videos.some((v) => (v.trimmedDuration || v.duration) > MAX_DURATION);
  // 高光精选面板（mine_highlights 预筛产物；候选匹配当前素材才显示入口）
  const highlightCandidates = useProjectStore((s) => s.highlightCandidates);
  const [showHighlight, setShowHighlight] = useState(false);
  const highlightForThisClip = (videoIndex: number): boolean =>
    highlightCandidates !== null &&
    highlightCandidates.segmentIndex === useProjectStore.getState().activeSegmentIndex &&
    highlightCandidates.videoIndex === videoIndex;

  // 设置素材来源类型（实拍/录屏/图形；启发式标注的手动修正入口，AI 选型规则消费）
  const handleSourceKindChange = useCallback(
    (index: number, kind: MediaSourceKind | undefined) => {
      const store = useProjectStore.getState();
      const segIdx = store.activeSegmentIndex;
      const clip = store.segments[segIdx]?.videos[index];
      const from = clip?.sourceKind ?? 'live-action';
      store.setSegmentVideoSourceKind(segIdx, index, kind);
      // 手动修正记录（启发式误判真实样本，本地 jsonl——fire-and-forget 不阻塞 UI）
      if (clip && kind && kind !== from) {
        try {
          void window.api.sourcekindRecordChange({
            path: clipSrcToPath(clip.src), name: clip.name, from, to: kind,
          });
        } catch { /* 记录失败不影响修正 */ }
      }
    },
    [],
  );

  // 设置 Log 色彩曲线（素材卡下拉；代理按新曲线重排，渲染回源前自动 LUT 转码）
  const handleColorCurveChange = useCallback(
    (index: number, curve: ColorCurveId | undefined) => {
      const segIdx = useProjectStore.getState().activeSegmentIndex;
      useProjectStore.getState().setSegmentVideoColorCurve(segIdx, index, curve);
      const {setStatusText} = useUIStore.getState();
      const clip = useProjectStore.getState().segments[segIdx]?.videos[index];
      if (clip) {
        setStatusText(curve
          ? `色彩曲线 ${colorCurveMeta(curve).label}：代理/渲染将应用 Log→709 技术转换`
          : '色彩曲线已清除（普通素材直渲）');
        // 触发代理按新曲线重排（探测不触发的素材只影响渲染链路）
        const srcPath = clipSrcToPath(clip.src);
        void window.api.proxyPrepare({path: srcPath, colorCurve: curve}).catch(() => {});
      }
    },
    [],
  );

  // 正在剪辑的视频
  const trimmingVideo = trimmingIndex !== null ? videos[trimmingIndex] : null;

  // 移除素材（状态栏反馈：片段历史快照含素材，Ctrl+Z 可撤销）
  const handleRemoveVideo = (index: number) => {
    const name = videos[index]?.name ?? '';
    removeVideoFromCurrent(index);
    const {setStatusText} = useUIStore.getState();
    setStatusText(`已移除素材「${name}」（Ctrl+Z 可撤销）`);
  };

  return (
    <div className="video-uploader">
      <div className="uploader-header">
        <div>
          <h2>上传素材</h2>
          <p className="uploader-subtitle">
            上传或直接录制操作画面；视频建议 {MAX_DURATION} 秒内，超长会提示裁剪（不强制）
          </p>
        </div>
        <button className="btn-record-entry" onClick={() => setShowRecorder(true)} title="录制屏幕/窗口/摄像头（多种画面构成），或截取画面">
          <Monitor size={14} /> 录制素材
        </button>
      </div>

      {/* 导入反馈提示条（编码警告/Log 猜测；内联非阻塞，手动关闭） */}
      {notices.length > 0 && (
        <div className="uploader-notices">
          {notices.map((n) => (
            <div key={n.id} className={`uploader-notice ${n.kind}`}>
              {n.kind === 'warn' ? <AlertTriangle size={13} /> : <Info size={13} />}
              <span className="uploader-notice-text">{n.text}</span>
              <button
                className="uploader-notice-close"
                onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))}
                title="关闭"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 已上传列表（有素材时排在上传框前面，上传成功立即可见，不用下滑） */}
      {videos.length > 0 && (
        <div className="video-list">
          <div className="video-list-header">
            <span>已上传 {videos.length} 个素材</span>
            <button className="btn-text" onClick={handleSelectFiles}>+ 添加更多</button>
          </div>
          {videos.map((video, i) => {
            const trimmedDur = video.trimmedDuration || video.duration;
            const isOversized = trimmedDur > MAX_DURATION;
            const isTrimmed = video.trimStart !== undefined && video.trimEnd !== undefined
              && (video.trimStart > 0 || video.trimEnd < video.duration);
            const isImage = video.type === 'image';
            const isModel = video.type === 'model';
            const hasViewport = !isDefaultViewport(video.viewport);

            return (
              <div key={video.id} className={`video-item ${isOversized ? 'oversized' : ''}`}>
                {/* 素材预览缩略图 */}
                <div className="video-item-thumb">
                  <VideoThumbnail src={video.src} type={video.type} />
                </div>

                <div className="video-item-info">
                  <span className="video-item-name">{video.name}</span>
                  <span className="video-item-meta">
                    {isImage ? <><ImageIcon size={11} /> 图片 · </> : ''}
                    {isModel ? <><Box size={11} /> 3D 模型 · </> : ''}
                    {video.width}×{video.height} ·{' '}
                    {isModel ? (
                      <>glb</>
                    ) : isTrimmed ? (
                      <>
                        <span className="trimmed-badge">
                          {video.trimStart?.toFixed(1)}s → {video.trimEnd?.toFixed(1)}s
                        </span>
                        <span className="orig-duration">（原 {video.duration.toFixed(1)}s）</span>
                      </>
                    ) : (
                      <>{video.duration.toFixed(1)}秒</>
                    )}
                    {isOversized && <span className="duration-warn"><AlertTriangle size={11} /> 超限</span>}
                    {hasViewport && <span className="viewport-badge">已取景</span>}
                    {video.sourceKind && (
                      <span className="viewport-badge" title={`素材来源：${SOURCE_KIND_LABELS[video.sourceKind]}（AI 选型信号：实拍优先全幅模板族；素材卡「来源」下拉可改）`}>
                        {SOURCE_KIND_LABELS[video.sourceKind]}
                      </span>
                    )}
                    {video.colorCurve && (
                      <span
                        className="viewport-badge"
                        title={`Log 色彩曲线：${colorCurveMeta(video.colorCurve).label}（代理/渲染自动恢复正常色；素材卡「曲线」下拉可改）`}
                      >
                        {colorCurveMeta(video.colorCurve).label}
                      </span>
                    )}
                    {video.proxyStatus === 'queued' || video.proxyStatus === 'transcoding' ? (
                      <span className="viewport-badge" title="大素材后台生成代理中（编辑不受影响，就绪后抽帧/预览自动走代理）">代理生成中…</span>
                    ) : video.proxyStatus === 'ready' ? (
                      <span className="viewport-badge" title="代理就绪：编辑/抽帧/预览走 960 宽代理，渲染回源全分辨率">代理就绪</span>
                    ) : video.proxyStatus === 'failed' ? (
                      <span className="duration-warn" title="代理转码失败（渲染不受影响，回源直渲）">代理失败</span>
                    ) : null}
                    {video.stabilization?.enabled && (
                      <span
                        className={`stab-badge ${(video.stabilization.lostRatio ?? 0) > 0.15 ? 'warn' : ''}`}
                        title={(video.stabilization.lostRatio ?? 0) > 0.15
                          ? `稳定已开启，但 ${(Math.round((video.stabilization.lostRatio ?? 0) * 100))}% 帧跟踪丢失——建议打开「稳定」换跟踪点重新分析`
                          : '跟踪稳定已开启'}
                      >
                        {(video.stabilization.lostRatio ?? 0) > 0.15 ? '部分跟丢' : '已稳定'}
                      </span>
                    )}
                    {video.groundTrack?.enabled && (
                      <span
                        className={`stab-badge ${((video.groundTrack.lostRatio ?? 0) > 0.15 || (video.groundTrack.keptAnchors ?? 9) < 5) ? 'warn' : ''}`}
                        title="3D 地面追踪已开启（可放置钉在地面上的 3D 文字/形状）"
                      >
                        3D地面
                      </span>
                    )}
                  </span>
                  {!isImage && !isModel && (
                    <div className="video-item-audio" style={{display: 'flex', alignItems: 'center', gap: 6, marginTop: 4}}>
                      <button
                        className="btn-mute"
                        style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: video.muted ? '#9CA3AF' : '#374151'}}
                        onClick={() => updateVideoAudio(i, !video.muted, video.volume ?? 1)}
                        title={video.muted ? '取消静音' : '静音'}
                      >
                        {video.muted ? <VolumeX size={14}/> : <Volume2 size={14}/>}
                      </button>
                      <input
                        type="range"
                        min={0} max={1} step={0.05}
                        value={video.muted ? 0 : (video.volume ?? 1)}
                        onChange={(e) => updateVideoAudio(i, false, Number(e.target.value))}
                        disabled={video.muted}
                        style={{width: 80}}
                      />
                      <span style={{fontSize: 11, color: '#6B7280', minWidth: 30}}>
                        {video.muted ? '静音' : `${Math.round((video.volume ?? 1) * 100)}%`}
                      </span>
                    </div>
                  )}
                </div>

                {/* 操作按钮 */}
                <div className="video-item-actions">
                  {highlightForThisClip(i) && (
                    <button
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#f59e0b'}}
                      onClick={() => setShowHighlight(true)}
                      title="高光精选：查看启发式候选墙，点选确认后一键挖段"
                    >
                      <Sparkles size={14} />
                    </button>
                  )}
                  {supportsViewport && !isModel && (
                    <button
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                      onClick={() => setViewportIndex(i)}
                      title="取景"
                    >
                      <Crop size={14} />
                    </button>
                  )}
                  {!isImage && !isModel && (
                    <button
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                      onClick={() => {
                        stabSegmentRef.current = useProjectStore.getState().activeSegmentIndex;
                        setStabIndex(i);
                      }}
                      title="稳定（手持/走动抖动素材的跟踪稳定）"
                    >
                      <Crosshair size={14} />
                    </button>
                  )}
                  {!isImage && !isModel && (
                    <button
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                      onClick={() => {
                        groundSegmentRef.current = useProjectStore.getState().activeSegmentIndex;
                        setGroundIndex(i);
                      }}
                      title="3D 地面追踪（在地面放置随镜头透视的 3D 文字/形状）"
                    >
                      <Box size={14} />
                    </button>
                  )}
                  {!isImage && !isModel && (
                    <button
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                      onClick={() => setTrimmingIndex(i)}
                      title="剪辑"
                    >
                      <Scissors size={14} />
                    </button>
                  )}
                  {!isImage && !isModel && (
                    <select
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, width: 26, height: 26, fontSize: 11, color: video.colorCurve ? '#2563EB' : undefined}}
                      value={video.colorCurve ?? ''}
                      title="Log 色彩曲线（电影机 log 灰片恢复正常色：代理与渲染自动应用技术转换 LUT）"
                      onChange={(e) => handleColorCurveChange(i, e.target.value === '' ? undefined : (e.target.value as ColorCurveId))}
                    >
                      <option value="" label="曲" />
                      {COLOR_CURVES.map((c) => (
                        <option key={c.id} value={c.id} label={c.label}>{c.label}</option>
                      ))}
                    </select>
                  )}
                  {!isImage && !isModel && (
                    <select
                      className="btn-trim"
                      style={{display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, width: 26, height: 26, fontSize: 11, color: video.sourceKind === 'live-action' ? '#2563EB' : undefined}}
                      value={video.sourceKind ?? 'live-action'}
                      title="素材来源类型（实拍/录屏/图形）——AI 模板选型信号：实拍优先全幅模板族，录屏/图形才配画中画展板族"
                      onChange={(e) => handleSourceKindChange(i, e.target.value as MediaSourceKind)}
                    >
                      {SOURCE_KINDS.map((k) => (
                        <option key={k} value={k} label={SOURCE_KIND_LABELS[k].slice(0, 1)}>{SOURCE_KIND_LABELS[k]}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className="btn-remove"
                    style={{display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}}
                    onClick={() => handleRemoveVideo(i)}
                    title="移除（Ctrl+Z 可撤销）"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 鼠标跟随模板：素材无轨迹时给引导（生成演示轨迹 / 编辑动作 / 去录屏）；演示/动作轨迹可区分、可重生成、可清除 */}
      {templateId === 'CursorFollow' && videos[0] && (
        (() => {
          const v0 = videos[0];
          const hasTrack = (v0.cursorPoints?.length ?? 0) >= 2;
          const editBtn = (prefill?: string) => (
            <button
              className="cursor-track-btn"
              onClick={() => setEditingScript(prefill ?? '0.2,0.8 > 0.45,0.5 @1.2 | click | @0.6 | > 0.8,0.35 @1.5 | click | hold')}
              title="用动作脚本指定鼠标路线（滑到哪、点哪里），与 AI 助手的 cursorScript 同一语法"
            >
              <Pencil size={12} /> 编辑动作
            </button>
          );
          return (
            <>
              {hasTrack && v0.cursorDemoSeed !== undefined && (
                <div className="cursor-track-hint demo">
                  <MousePointer2 size={13} />
                  <span className="cursor-track-text">演示轨迹（非真实录制，随工程保存）</span>
                  <button
                    className="cursor-track-btn"
                    onClick={() => updateVideoCursorDemo(0, Math.floor(Math.random() * 2 ** 31))}
                    title="换一条演示轨迹"
                  >
                    <RefreshCw size={12} /> 换一条
                  </button>
                  {editBtn()}
                  <button
                    className="cursor-track-btn"
                    onClick={() => updateVideoCursorDemo(0, undefined)}
                    title="清除演示轨迹"
                  >
                    清除
                  </button>
                </div>
              )}
              {hasTrack && v0.cursorDemoSeed === undefined && v0.cursorActionScript && (
                <div className="cursor-track-hint demo">
                  <MousePointer2 size={13} />
                  <span className="cursor-track-text" title={v0.cursorActionScript}>
                    动作轨迹：{v0.cursorActionScript.length > 42 ? v0.cursorActionScript.slice(0, 42) + '…' : v0.cursorActionScript}
                  </span>
                  {editBtn(v0.cursorActionScript)}
                  <button
                    className="cursor-track-btn"
                    onClick={() => {
                      updateVideoCursorTrack(0, '');
                      setEditingScript(null);
                    }}
                    title="清除动作轨迹"
                  >
                    清除
                  </button>
                </div>
              )}
              {!hasTrack && (
                <div className="cursor-track-hint">
                  <AlertTriangle size={13} />
                  <span className="cursor-track-text">该素材未记录鼠标轨迹，模板将退化为缓慢推拉</span>
                  <button
                    className="cursor-track-btn primary"
                    onClick={() => updateVideoCursorDemo(0, Math.floor(Math.random() * 2 ** 31))}
                    title="生成一条模拟真人操作的演示轨迹，立即可预览跟随运镜效果"
                  >
                    <MousePointer2 size={12} /> 生成演示轨迹
                  </button>
                  {editBtn()}
                  <button
                    className="cursor-track-btn"
                    onClick={() => setShowRecorder(true)}
                    title="用「屏幕」源录制操作，自动记录真实鼠标轨迹"
                  >
                    <Monitor size={12} /> 去录屏
                  </button>
                </div>
              )}
              {editingScript !== null && (
                <div className="cursor-track-hint" style={{flexDirection: 'column', alignItems: 'stretch', gap: 6}}>
                  <span className="cursor-track-text" style={{fontWeight: 600}}>动作脚本（坐标 0-1；与 AI 助手 cursorScript 同语法）</span>
                  <textarea
                    value={editingScript}
                    onChange={(e) => setEditingScript(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    placeholder={'0.2,0.8 > 0.45,0.5 @1.2 | click | type "登录" @1 | drag > 0.75,0.5 @1 | scroll +3 | hold'}
                    style={{width: '100%', fontSize: 12, fontFamily: 'ui-monospace, monospace', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--color-border)', resize: 'vertical', boxSizing: 'border-box'}}
                  />
                  <span className="cursor-track-text" style={{opacity: 0.75}}>
                    语法：「x,y」起点 ·「&gt;x,y @秒」滑动 ·「@秒」停顿 · click 点击 · dblclick 双击 · right 右键 · drag 拖拽 · down/up 按住 · scroll ±格 滚轮 · type "文本" 打字 · hold 停到结尾（| 分隔）
                  </span>
                  <div style={{display: 'flex', gap: 6}}>
                    <button
                      className="cursor-track-btn primary"
                      onClick={() => {
                        const warnings = updateVideoCursorTrack(0, editingScript);
                        pushNotices(warnings.map((w) => ({kind: 'warn' as const, text: `动作脚本：${w}`})));
                        const applied = useProjectStore.getState().videos[0]?.cursorActionScript;
                        if (applied !== undefined) setEditingScript(null); // 无有效步骤时保持编辑器开着让用户改
                      }}
                      title="应用动作脚本，立即合成鼠标轨迹并预览"
                    >
                      应用
                    </button>
                    <button className="cursor-track-btn" onClick={() => setEditingScript(null)}>取消</button>
                  </div>
                </div>
              )}
            </>
          );
        })()
      )}

      {/* 拖放区（有素材时排在列表后面） */}
      <div
        className={`drop-zone ${isDragOver ? 'drag-over' : ''}`}
        onClick={handleSelectFiles}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="drop-icon"><Video size={32} /></div>
        <p className="drop-text">
          {isLoading ? '加载中...' : '点击或拖放视频/图片到此处'}
        </p>
        <p className="drop-hint">
          支持 MP4 · MOV · MKV · WebM · AVI · JPG · PNG · WebP · 建议 {MAX_DURATION} 秒内
        </p>
      </div>

      {/* 录屏 / 截屏弹窗（保存后自动加入当前片段素材） */}
      {showRecorder && <ScreenRecorderModal onClose={() => setShowRecorder(false)} />}

      {/* 剪辑工具模态框 */}
      {trimmingVideo && trimmingIndex !== null && (
        <VideoTrimmer
          src={trimmingVideo.src}
          fileName={trimmingVideo.name}
          duration={trimmingVideo.duration}
          maxDuration={MAX_DURATION}
          initialCuts={trimmingVideo.cuts}
          onConfirm={(start, end, cuts) => handleTrimConfirm(trimmingIndex, start, end, cuts)}
          onCancel={() => setTrimmingIndex(null)}
        />
      )}

      {/* 取景模态框 */}
      {viewportIndex !== null && videos[viewportIndex] && (
        <ClipViewportEditor
          clip={videos[viewportIndex]}
          frameAspect={getPipFrameAspect()}
          onSave={(vp) => {
            updateVideoViewport(viewportIndex, vp);
            setViewportIndex(null);
          }}
          onCancel={() => setViewportIndex(null)}
        />
      )}

      {/* 稳定模态框 */}
      {stabIndex !== null && videos[stabIndex] && (
        <StabilizeModal
          clipIndex={stabIndex}
          segmentIndex={stabSegmentRef.current}
          clip={videos[stabIndex]}
          onClose={() => setStabIndex(null)}
        />
      )}

      {/* 高光精选面板（mine_highlights 预筛候选墙 → 点选确认 → 一键挖段） */}
      {showHighlight && highlightCandidates && (
        <HighlightModal onClose={() => setShowHighlight(false)} />
      )}

      {/* 3D 地面追踪模态框 */}
      {groundIndex !== null && videos[groundIndex] && (
        <GroundModal
          clipIndex={groundIndex}
          segmentIndex={groundSegmentRef.current}
          clip={videos[groundIndex]}
          onClose={() => setGroundIndex(null)}
        />
      )}

      {/* 时长超限提示（软提示：建议剪辑以获得更好节奏，不强制） */}
      {hasOversizedVideos && (
        <div className="uploader-footer">
          <span className="footer-warning">
            <AlertTriangle size={14} /> 有视频超过 {MAX_DURATION} 秒，建议用「剪辑」截取精彩片段
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * 将本地文件路径转为 local-video:// URL（自定义协议，无 CORS 限制）
 */
const toLocalVideoUrl = (src: string): string => {
  // 去掉 file:// 前缀，统一转为正斜杠
  const rawPath = src.replace(/^file:\/\/\//, '').replace(/\\/g, '/');
  // Windows 路径 D:/xxx → local-video://D:/xxx
  return `local-video://${rawPath}`;
};

/**
 * 素材缩略图组件 - 图片用 <img>，视频用 <video>（local-video:// 协议），3D 模型用占位图标
 */
const VideoThumbnail: React.FC<{src: string; type?: 'video' | 'image' | 'model'}> = ({src, type}) => {
  // 图片/视频均走 local-video:// 协议（CSP 白名单内，避开 http 在安全上下文的限制）
  if (type === 'image') {
    return <img src={toLocalVideoUrl(src)} className="thumb-video" alt="缩略图" />;
  }
  if (type === 'model') {
    // 3D 模型无像素缩略图（three.js 渲染时才着色）：深色底 + 立方体图标占位
    return (
      <div
        className="thumb-video"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #141822 0%, #1E2433 100%)',
          color: '#7FA8FF',
        }}
      >
        <Box size={22} />
      </div>
    );
  }
  const videoUrl = toLocalVideoUrl(src);

  return (
    <video
      src={videoUrl}
      className="thumb-video"
      muted
      preload="metadata"
      onLoadedData={(e) => {
        const vid = e.target as HTMLVideoElement;
        vid.currentTime = Math.min(1, vid.duration / 2);
      }}
    />
  );
};

export default VideoUploader;
