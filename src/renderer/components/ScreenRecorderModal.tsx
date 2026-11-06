/**
 * ScreenRecorderModal — 素材录制弹窗（屏幕 / 摄像头 / 截屏）
 *
 * OBS 式源选择：整个屏幕 / 单个应用窗口（缩略图卡片 + 窗口图标）。
 * 录制由 capture/screenCapture 控制器驱动（模块级单例）：关闭弹窗不中断录制，
 * 悬浮指示条随时可停止；系统侧结束共享会自动停止并保存。
 * 录像与截图保存后自动加入当前选中片段的素材列表（与上传素材同等待遇：可裁剪/取景/调音量）。
 *
 * 画面构成（屏幕 + 摄像头一起录的烧录方式，均走控制器画布合成，仅本次录制生效）：
 * - 纯屏幕：不启用摄像头（鼠标轨迹照常采集）
 * - 画中画：摄像头圆角小窗叠在四角（角落/大小可选）
 * - 左右分屏 / 上下分屏：屏幕与摄像头等比拼接，中间留缝
 * - 仅摄像头：出镜口播素材，不录屏幕画面（选区与鼠标轨迹不生效）
 *
 * 其他录制增强：
 * - 选区录制（仅屏幕源）：在源缩略图上拖动框选，只录该区域（最小 320×180，偶数取整）
 * - 麦克风/系统声音增益：0~200% 滑块，值存 captureStore（localStorage 持久化），录制中可实时调
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {useCaptureStore} from '../store/captureStore';
import {
  listCaptureSources, startRecording, startWithSystemAudio, stopRecording, discardRecording,
  getActiveStream, addCaptureToSegment, enableWebcam, disableWebcam,
} from '../capture/screenCapture';
import type {WebcamPosition, WebcamSize} from '../capture/screenCapture';
import {pipPresetPosition, WEBCAM_SIZE_RATIO} from '../../shared/recordingLayout';
import type {RecordingLayout, WebcamPreset} from '../../shared/recordingLayout';
import {getWebcamStream} from '../capture/screenCapture';
import type {CaptureRegion, CaptureScreenshotResult, CaptureSourceInfo} from '../../shared/capture';
import {Monitor, AppWindow, Camera, Square, RefreshCw, Mic, Volume2, X, Loader2, Trash2, Crop, Webcam, FolderOpen, Wand2} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import {runScreenDemoAuto} from '../ai/screenDemoAuto';
import './ScreenRecorderModal.css';

interface ScreenRecorderModalProps {
  onClose: () => void;
  /** 纯录屏模式（首页「只录屏」入口）：保存到录制文件夹即止，不导入故事板片段 */
  standalone?: boolean;
}

/** 弹窗里的画面构成选择（'screen' = 不启用摄像头，其余为带摄像头的构图） */
type LayoutChoice = 'screen' | RecordingLayout;

/** 格式化已录时长 mm:ss */
const fmtElapsed = (sec: number): string => {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** 选区最小尺寸（视频像素） */
const MIN_REGION_W = 320;
const MIN_REGION_H = 180;
/** 取偶（向下）：偶数尺寸/坐标对编码器与裁剪都更稳妥 */
const evenFloor = (v: number): number => Math.max(0, Math.floor(v / 2) * 2);

/** 两个视频像素点 → 选区矩形：偶数取整 + 最小 320×180 + 钳在源画面内 */
const buildRegionRect = (
  a: {vx: number; vy: number},
  b: {vx: number; vy: number},
  srcW: number,
  srcH: number,
): CaptureRegion => {
  const maxW = evenFloor(srcW);
  const maxH = evenFloor(srcH);
  const width = Math.max(Math.min(MIN_REGION_W, maxW), Math.min(evenFloor(Math.abs(b.vx - a.vx)), maxW));
  const height = Math.max(Math.min(MIN_REGION_H, maxH), Math.min(evenFloor(Math.abs(b.vy - a.vy)), maxH));
  const x = Math.max(0, Math.min(evenFloor(Math.min(a.vx, b.vx)), maxW - width));
  const y = Math.max(0, Math.min(evenFloor(Math.min(a.vy, b.vy)), maxH - height));
  return {x, y, width, height};
};

const WEBCAM_SIZES: [WebcamSize, string][] = [
  ['small', '小'],
  ['medium', '中'],
  ['large', '大'],
];
/** 画中画预设九宫格（行优先；ax/ay 为锚点：0 靠左/上，0.5 居中，1 靠右/下） */
const PIP_PRESETS: {key: WebcamPreset; label: string; ax: 0 | 0.5 | 1; ay: 0 | 0.5 | 1}[] = [
  {key: 'topLeft', label: '左上', ax: 0, ay: 0},
  {key: 'topCenter', label: '上中', ax: 0.5, ay: 0},
  {key: 'topRight', label: '右上', ax: 1, ay: 0},
  {key: 'middleLeft', label: '左中', ax: 0, ay: 0.5},
  {key: 'center', label: '正中', ax: 0.5, ay: 0.5},
  {key: 'middleRight', label: '右中', ax: 1, ay: 0.5},
  {key: 'bottomLeft', label: '左下', ax: 0, ay: 1},
  {key: 'bottomCenter', label: '下中', ax: 0.5, ay: 1},
  {key: 'bottomRight', label: '右下', ax: 1, ay: 1},
];
/** 画面构成选项（示意图标由 CSS 按 data-layout 画） */
const LAYOUT_OPTIONS: {value: LayoutChoice; label: string; hint: string}[] = [
  {value: 'screen', label: '纯屏幕', hint: '只录屏幕/窗口画面（照常采集鼠标轨迹）'},
  {value: 'pip', label: '画中画', hint: '摄像头圆角小窗叠在角落'},
  {value: 'side', label: '左右分屏', hint: '屏幕与摄像头左右并排拼接'},
  {value: 'stack', label: '上下分屏', hint: '屏幕与摄像头上下堆叠拼接'},
  {value: 'camera', label: '仅摄像头', hint: '出镜口播素材，不录屏幕画面（选区/鼠标轨迹不生效）'},
];
/** 画质档：0 = 原画（不缩放），其余为输出高度上限（超过时等比缩小） */
const QUALITY_CAPS: [number, string][] = [
  [0, '原画'],
  [1080, '1080p'],
  [720, '720p'],
];
const FPS_OPTIONS: number[] = [30, 60];

export const ScreenRecorderModal: React.FC<ScreenRecorderModalProps> = ({onClose, standalone = false}) => {
  const recording = useCaptureStore((s) => s.recording);
  const sourceName = useCaptureStore((s) => s.sourceName);
  const elapsedSec = useCaptureStore((s) => s.elapsedSec);
  const recordingWithMic = useCaptureStore((s) => s.withMic);
  const recordingWithSystemAudio = useCaptureStore((s) => s.withSystemAudio);
  const webcamOn = useCaptureStore((s) => s.webcamOn);
  const micGain = useCaptureStore((s) => s.micGain);
  const systemGain = useCaptureStore((s) => s.systemGain);
  const setMicGain = useCaptureStore((s) => s.setMicGain);
  const setSystemGain = useCaptureStore((s) => s.setSystemGain);

  const [sources, setSources] = useState<CaptureSourceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [withMic, setWithMic] = useState(false);
  const [withSystemAudio, setWithSystemAudio] = useState(false);
  const [regionOn, setRegionOn] = useState(false);
  const [regionRect, setRegionRect] = useState<CaptureRegion | null>(null);
  /** 画面构成：弹窗打开时沿用摄像头开关（已开 = 画中画，未开 = 纯屏幕） */
  const [layout, setLayout] = useState<LayoutChoice>(() => (useCaptureStore.getState().webcamOn ? 'pip' : 'screen'));
  /** 画中画位置：预设九宫格 or 拖拽自定义（pipPos 仅自定义模式生效） */
  const [pipMode, setPipMode] = useState<'preset' | 'custom'>('preset');
  const [pipPreset, setPipPreset] = useState<WebcamPreset>('bottomRight');
  const [pipPos, setPipPos] = useState<WebcamPosition>({x: 0.8, y: 0.8});
  const [webcamSize, setWebcamSize] = useState<WebcamSize>('medium');
  /** 摄像头画面宽高比（拖拽预览小窗的形状；从摄像头轨 settings 读，缺省 4:3） */
  const [camAspect, setCamAspect] = useState(4 / 3);
  /** 输出高度上限（0 = 原画不缩放）；超过上限的源等比缩小，省体积 */
  const [qualityCap, setQualityCap] = useState(0);
  const [fps, setFps] = useState(30);
  const [loadingSources, setLoadingSources] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 保存完成提示（录像名 / 截图预览） */
  const [savedNote, setSavedNote] = useState('');
  /** 纯录屏模式：最近一次保存的文件路径（「打开所在文件夹」用） */
  const [savedPath, setSavedPath] = useState('');
  /** 纯录屏模式：最近保存的是录像（ true，可一键成片）还是截图（false） */
  const [savedIsVideo, setSavedIsVideo] = useState(false);
  const [shotPreview, setShotPreview] = useState<CaptureScreenshotResult | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const regionSurfaceRef = useRef<HTMLDivElement>(null);
  /** 选区拖拽起点（视频像素；null = 未在拖） */
  const regionDragRef = useRef<{vx: number; vy: number} | null>(null);
  /** 画中画拖拽预览：表面元素 / 小窗视频 / 拖拽抓取偏移（归一化；null = 未在拖） */
  const pipSurfaceRef = useRef<HTMLDivElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const pipDragRef = useRef<{fx: number; fy: number} | null>(null);

  const selectedSource = sources.find((s) => s.id === selectedId);

  // 摄像头开启后：读画面宽高比（拖拽小窗形状所见即所得），并把实时流挂进预览小窗
  useEffect(() => {
    if (!webcamOn) return;
    const settings = getWebcamStream()?.getVideoTracks()[0]?.getSettings();
    if (settings?.width && settings?.height && settings.height > 0) {
      setCamAspect(settings.width / settings.height);
    }
  }, [webcamOn]);
  useEffect(() => {
    if (webcamOn && layout === 'pip' && pipVideoRef.current) {
      pipVideoRef.current.srcObject = getWebcamStream();
    }
  }, [webcamOn, layout]);

  /**
   * 画中画小窗几何（按所选源的像素尺寸换算成表面内比例）：
   * 长边 = 源短边 × 尺寸档比例；小窗按摄像头宽高比定形；
   * 显示位置 = 预设换算 or 自定义落点（同一归一化坐标系，与录制烧录一致）。
   */
  const pipGeometry = (() => {
    const w = selectedSource && selectedSource.width > 0 ? selectedSource.width : 1920;
    const h = selectedSource && selectedSource.height > 0 ? selectedSource.height : 1080;
    const pipLong = Math.min(w, h) * WEBCAM_SIZE_RATIO[webcamSize];
    let rw: number;
    let rh: number;
    if (camAspect >= 1) {
      rw = pipLong;
      rh = pipLong / camAspect;
    } else {
      rh = pipLong;
      rw = pipLong * camAspect;
    }
    const fracW = Math.min(0.98, rw / w);
    const fracH = Math.min(0.98, rh / h);
    const pos =
      pipMode === 'preset'
        ? pipPresetPosition(pipPreset, {width: w, height: h}, {width: rw, height: rh})
        : pipPos;
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    return {
      fracW,
      fracH,
      x: clamp(pos.x, fracW / 2, 1 - fracW / 2),
      y: clamp(pos.y, fracH / 2, 1 - fracH / 2),
    };
  })();

  /** 拖拽小窗：指针位置 − 抓取偏移 = 新中心（归一化并钳制在小窗不出表面），拖动即切自定义 */
  const handlePipPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // 捕获设在小窗自身：后续 pointermove 仍路由到小窗（挂 surface 会把 move 抢走，拖不动）
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const surface = pipSurfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    pipDragRef.current = {
      fx: (e.clientX - rect.left) / rect.width - pipGeometry.x,
      fy: (e.clientY - rect.top) / rect.height - pipGeometry.y,
    };
  };
  const handlePipPointerMove = (e: React.PointerEvent) => {
    const surface = pipSurfaceRef.current;
    const grab = pipDragRef.current;
    if (!surface || !grab) return;
    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
    setPipMode('custom');
    setPipPos({
      x: clamp((e.clientX - rect.left) / rect.width - grab.fx, pipGeometry.fracW / 2, 1 - pipGeometry.fracW / 2),
      y: clamp((e.clientY - rect.top) / rect.height - grab.fy, pipGeometry.fracH / 2, 1 - pipGeometry.fracH / 2),
    });
  };
  const handlePipPointerUp = () => {
    pipDragRef.current = null;
  };

  const refreshSources = useCallback(async () => {
    setLoadingSources(true);
    setError('');
    try {
      const list = await listCaptureSources();
      setSources(list);
      // 默认选主屏（第一个屏幕源）；当前选中源已消失时回退主屏
      setSelectedId((prev) =>
        list.some((s) => s.id === prev) ? prev : (list.find((s) => s.kind === 'screen') ?? list[0])?.id ?? '',
      );
    } catch (err) {
      setError(`获取屏幕/窗口列表失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  // 录制结束/放弃后控制器会释放摄像头流（webcamOn 复位 false）：构图选择同步退回纯屏幕，
  // 避免弹窗不关连录时上一次的带摄像头构图在下次起录报「需要摄像头」。
  // 只响应 开→关 跃迁——选构图时先 setLayout 再异步 enableWebcam，期间 webcamOn 仍为 false 不能误伤。
  const prevWebcamOn = useRef(webcamOn);
  useEffect(() => {
    if (prevWebcamOn.current && !webcamOn && !recording) setLayout('screen');
    prevWebcamOn.current = webcamOn;
  }, [webcamOn, recording]);

  // 录制中把活动流挂到预览 <video>（控制器单例，弹窗重开也能接回画面；
  // 选区/画中画启用时活动流即画布合成流，预览所见即所得）
  useEffect(() => {
    if (recording && previewRef.current) {
      previewRef.current.srcObject = getActiveStream();
    }
  }, [recording]);

  /** 未录制时关弹窗顺手释放摄像头（录制中摄像头归录制生命周期，cleanup 统一释放） */
  const handleClose = () => {
    const st = useCaptureStore.getState();
    if (!st.recording && st.webcamOn) disableWebcam();
    onClose();
  };

  const handleStart = async () => {
    if (busy || recording) return;
    setBusy(true);
    setError('');
    setSavedNote('');
    setSavedPath('');
    setShotPreview(null);
    try {
      // 会话标记先行落 store：从悬浮指示条停止时也按纯录屏口径处理
      useCaptureStore.getState().setStandaloneMode(standalone);
      if (layout !== 'camera' && regionOn && selectedSource?.kind === 'screen' && !regionRect) {
        throw new Error('请先在缩略图上拖动框选录制区域');
      }
      // 仅摄像头构图不使用屏幕画面：选区不生效
      const region =
        layout !== 'camera' && regionOn && selectedSource?.kind === 'screen' ? (regionRect ?? undefined) : undefined;
      const webcam = layout === 'pip' ? {position: {x: pipGeometry.x, y: pipGeometry.y}, size: webcamSize} : undefined;
      const layoutOpt = layout === 'screen' ? undefined : layout;
      const quality = {fps, ...(qualityCap > 0 ? {maxHeight: qualityCap} : {})};
      if (withSystemAudio && selectedId) {
        // 系统声音走 getDisplayMedia 路径：真实点击 = 用户手势，满足其手势要求；
        // 拿不到 loopback 音轨时控制器静默降级为无声录像
        await startWithSystemAudio(selectedId, {withMic, region, webcam, layout: layoutOpt, ...quality});
      } else {
        await startRecording({sourceId: selectedId || undefined, withMic, region, webcam, layout: layoutOpt, ...quality});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    const durSec = elapsedSec;
    try {
      const saved = await stopRecording();
      if (!saved) {
        setError('未获取到录制数据（录制时间可能太短）');
        return;
      }
      if (standalone) {
        // 纯录屏：文件已落盘（stopRecording 内 captureSaveRecording），不进故事板
        setSavedPath(saved.path);
        setSavedIsVideo(true);
        setSavedNote(`已保存「${saved.name}」（${fmtElapsed(durSec)}），存放在录制文件夹`);
        return;
      }
      const res = await addCaptureToSegment(saved);
      setSavedNote(`已保存「${saved.name}」（${res.duration.toFixed(1)} 秒），并加入第 ${res.segmentIndex + 1} 段素材`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 录屏即成品：刚保存的纯录屏 → 一键生成「钩子+导播主段+CTA」故事板（BGM 自动选+压拍），跳到故事板 */
  const handleFinishFilm = async () => {
    if (busy || !savedPath) return;
    setBusy(true);
    setError('');
    try {
      const r = await runScreenDemoAuto(useProjectStore.getState(), savedPath, {withBgm: true});
      if (!r.ok) {
        setError(r.message);
        return;
      }
      onClose();
      useProjectStore.getState().setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleScreenshot = async () => {
    if (busy || recording) return;
    setBusy(true);
    setError('');
    setSavedNote('');
    try {
      const shot = await window.api.captureScreenshot(selectedId || undefined);
      if (standalone) {
        setSavedPath(shot.path);
        setSavedIsVideo(false);
        setShotPreview(shot);
        setSavedNote(`已保存「${shot.name}」（${shot.width}×${shot.height}），存放在录制文件夹`);
        return;
      }
      const res = await addCaptureToSegment(shot);
      setShotPreview(shot);
      setSavedNote(`已保存「${shot.name}」（${shot.width}×${shot.height}），并加入第 ${res.segmentIndex + 1} 段素材`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 画面构成选择：切到带摄像头的构图即请求摄像头权限（失败报错并回退纯屏幕）；
   * 切回纯屏幕顺手关掉摄像头流。录制进行中不允许切换（合成几何起录时已定）。
   */
  const handleLayoutSelect = async (choice: LayoutChoice) => {
    if (recording) return;
    setError('');
    if (choice === 'screen') {
      setLayout('screen');
      if (useCaptureStore.getState().webcamOn) disableWebcam();
      return;
    }
    setLayout(choice);
    try {
      await enableWebcam();
    } catch (err) {
      setLayout('screen');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 选区拖拽：指针位置 → 源视频像素坐标（缩略图与屏幕同宽高比，按比例换算） */
  const posToVideo = (e: React.PointerEvent): {vx: number; vy: number} | null => {
    const el = regionSurfaceRef.current;
    if (!el || !selectedSource || selectedSource.width <= 0 || selectedSource.height <= 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const fy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return {vx: fx * selectedSource.width, vy: fy * selectedSource.height};
  };

  const handleRegionPointerDown = (e: React.PointerEvent) => {
    const p = posToVideo(e);
    if (!p || !selectedSource) return;
    e.preventDefault();
    regionSurfaceRef.current?.setPointerCapture(e.pointerId);
    regionDragRef.current = p;
    // 单击先放一个最小尺寸选区，拖动再拉大
    setRegionRect(buildRegionRect(p, p, selectedSource.width, selectedSource.height));
  };

  const handleRegionPointerMove = (e: React.PointerEvent) => {
    const start = regionDragRef.current;
    if (!start || !selectedSource) return;
    const p = posToVideo(e);
    if (!p) return;
    setRegionRect(buildRegionRect(start, p, selectedSource.width, selectedSource.height));
  };

  const handleRegionPointerUp = () => {
    regionDragRef.current = null;
  };

  /** 增益滑块行（麦克风/系统声音共用；录制中也可调，GainNode 实时生效） */
  const renderGainRow = (kind: 'mic' | 'system') => {
    const value = kind === 'mic' ? micGain : systemGain;
    const setValue = kind === 'mic' ? setMicGain : setSystemGain;
    return (
      <div className="capture-gain-row">
        {kind === 'mic' ? <Mic size={12} /> : <Volume2 size={12} />}
        <span className="capture-gain-label">{kind === 'mic' ? '麦克风音量' : '系统声音音量'}</span>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(value * 100)}
          onChange={(e) => setValue(Number(e.target.value) / 100)}
        />
        <span className="capture-gain-value">{Math.round(value * 100)}%</span>
      </div>
    );
  };

  const screens = sources.filter((s) => s.kind === 'screen');
  // 本应用窗口（片语自身）排最前：录制软件操作演示是高频场景，不用在长列表里翻
  const windows = [...sources.filter((s) => s.kind === 'window')].sort((a, b) => {
    const sa = a.name === '片语' ? 0 : 1;
    const sb = b.name === '片语' ? 0 : 1;
    return sa - sb;
  });

  const renderSourceCard = (s: CaptureSourceInfo) => (
    <button
      key={s.id}
      className={`capture-source-card ${selectedId === s.id ? 'selected' : ''}`}
      onClick={() => {
        setSelectedId(s.id);
        setRegionRect(null); // 换源后原选区（旧源像素坐标）作废
      }}
      disabled={recording}
      title={s.name}
    >
      <div className="capture-source-thumb">
        {s.thumbnailDataUrl ? (
          <img src={s.thumbnailDataUrl} alt={s.name} />
        ) : (
          <div className="capture-source-thumb-empty">
            {s.kind === 'screen' ? <Monitor size={22} /> : <AppWindow size={22} />}
          </div>
        )}
      </div>
      <div className="capture-source-name">
        {s.appIconDataUrl && <img className="capture-source-icon" src={s.appIconDataUrl} alt="" />}
        <span>{s.name}</span>
        {s.kind === 'window' && s.name === '片语' && <em className="capture-self-badge">本应用</em>}
      </div>
    </button>
  );

  return (
    <div className="capture-overlay" onClick={handleClose}>
      <div className="capture-modal" onClick={(e) => e.stopPropagation()}>
        <div className="capture-header">
          <h3>{standalone ? '录制屏幕' : '素材录制'}</h3>
          <button className="btn-close" onClick={handleClose}><X size={18} /></button>
        </div>
        <p className="capture-subtitle">
          {standalone
            ? '纯录屏模式：录屏幕 / 应用窗口 / 摄像头，录完存成视频文件直接拿走用（不建工程、不进故事板）。关闭本窗口不会中断录制。'
            : '录制屏幕 / 应用窗口 / 摄像头（可多种画面构成一起烧录），保存后自动加入当前片段素材。关闭本窗口不会中断录制。'}
        </p>

        {recording ? (
          /* ====== 录制中：实时预览 + 计时 + 控制 ====== */
          <div className="capture-recording">
            <div className="capture-live">
              <video ref={previewRef} autoPlay muted className="capture-live-video" />
              <div className="capture-live-badge">
                <span className="capture-rec-dot" /> REC {fmtElapsed(elapsedSec)}
              </div>
            </div>
            <div className="capture-recording-info">
              正在录制「{sourceName}」{recordingWithMic ? '（含麦克风）' : ''}{recordingWithSystemAudio ? '（含系统声音）' : ''}
            </div>
            {recordingWithMic && renderGainRow('mic')}
            {recordingWithSystemAudio && renderGainRow('system')}
            <div className="capture-actions">
              <button className="btn-primary capture-btn-stop" onClick={handleStop} disabled={busy}>
                {busy ? <Loader2 size={14} className="icon-spin" /> : <Square size={14} />} 停止并保存
              </button>
              <button
                className="btn-ghost"
                onClick={() => discardRecording()}
                disabled={busy}
                title="放弃本次录制（不保存）"
              >
                <Trash2 size={14} /> 放弃
              </button>
            </div>
          </div>
        ) : (
          /* ====== 未录制：源选择 + 操作 ====== */
          <>
            <div className="capture-sources-header">
              <span className="capture-section-title">选择画面来源</span>
              <button className="btn-ghost capture-refresh" onClick={() => void refreshSources()} disabled={loadingSources} title="刷新列表">
                <RefreshCw size={13} className={loadingSources ? 'icon-spin' : ''} /> 刷新
              </button>
            </div>

            {loadingSources && sources.length === 0 ? (
              <div className="capture-loading"><Loader2 size={16} className="icon-spin" /> 正在枚举屏幕与窗口…</div>
            ) : (
              <div className="capture-sources">
                {screens.length > 0 && (
                  <>
                    <div className="capture-group-label"><Monitor size={12} /> 屏幕</div>
                    <div className="capture-grid">{screens.map(renderSourceCard)}</div>
                  </>
                )}
                {windows.length > 0 && (
                  <>
                    <div className="capture-group-label"><AppWindow size={12} /> 应用窗口</div>
                    <div className="capture-grid">{windows.map(renderSourceCard)}</div>
                  </>
                )}
                {sources.length === 0 && <div className="capture-loading">未发现可采集的屏幕/窗口</div>}
              </div>
            )}

            <label className="capture-mic-row">
              <input type="checkbox" checked={withMic} onChange={(e) => setWithMic(e.target.checked)} />
              <Mic size={13} /> 同时录制麦克风
            </label>

            <label className="capture-mic-row">
              <input type="checkbox" checked={withSystemAudio} onChange={(e) => setWithSystemAudio(e.target.checked)} />
              <Volume2 size={13} /> 同时录制系统声音
              <span className="capture-mic-hint">录制电脑播放的声音，如软件音效/视频声</span>
            </label>

            {selectedSource?.kind === 'screen' && layout !== 'camera' && (
              <label className="capture-mic-row">
                <input
                  type="checkbox"
                  checked={regionOn}
                  onChange={(e) => {
                    setRegionOn(e.target.checked);
                    if (!e.target.checked) setRegionRect(null);
                  }}
                />
                <Crop size={13} /> 选区录制
                <span className="capture-mic-hint">只录制屏幕上的一块区域</span>
              </label>
            )}

            {(layout === 'screen' || layout === 'pip') && (
              <div className="capture-mic-row capture-mic-hint" style={{cursor: 'default'}}>
                录制屏幕/窗口时会同时记录鼠标移动与点击位置（仅保存在本地，用于「鼠标跟随运镜」模板；分屏/仅摄像头构图不采集）
              </div>
            )}

            {regionOn && selectedSource?.kind === 'screen' && layout !== 'camera' && (
              <div className="capture-region-panel">
                <div
                  ref={regionSurfaceRef}
                  className="capture-region-surface"
                  onPointerDown={handleRegionPointerDown}
                  onPointerMove={handleRegionPointerMove}
                  onPointerUp={handleRegionPointerUp}
                  onPointerCancel={handleRegionPointerUp}
                >
                  <img src={selectedSource.thumbnailDataUrl} alt={selectedSource.name} draggable={false} />
                  {regionRect && (
                    <div
                      className="capture-region-rect"
                      style={{
                        left: `${(regionRect.x / selectedSource.width) * 100}%`,
                        top: `${(regionRect.y / selectedSource.height) * 100}%`,
                        width: `${(regionRect.width / selectedSource.width) * 100}%`,
                        height: `${(regionRect.height / selectedSource.height) * 100}%`,
                      }}
                    />
                  )}
                </div>
                <div className="capture-region-info">
                  <span>
                    {regionRect
                      ? `选区 ${regionRect.width}×${regionRect.height}，起点 (${regionRect.x}, ${regionRect.y})`
                      : '在缩略图上拖动框选录制区域（最小 320×180）'}
                  </span>
                  {regionRect && (
                    <button className="btn-ghost capture-region-clear" onClick={() => setRegionRect(null)}>清除选区</button>
                  )}
                </div>
              </div>
            )}

            <div className="capture-webcam-options">
              <div className="capture-webcam-group">
                <span className="capture-webcam-group-label">画质</span>
                {QUALITY_CAPS.map(([v, label]) => (
                  <button
                    key={v}
                    className={`capture-chip ${qualityCap === v ? 'selected' : ''}`}
                    onClick={() => setQualityCap(v)}
                    title={v > 0 ? `超过 ${v}p 的画面等比缩小到 ${v}p` : '按源原始分辨率录制，不缩放'}
                  >
                    {label}
                  </button>
                ))}
                <span className="capture-mic-hint">4K 屏录 1080p 省体积</span>
              </div>
              <div className="capture-webcam-group">
                <span className="capture-webcam-group-label">帧率</span>
                {FPS_OPTIONS.map((v) => (
                  <button
                    key={v}
                    className={`capture-chip ${fps === v ? 'selected' : ''}`}
                    onClick={() => setFps(v)}
                    title={v === 30 ? '界面演示足够流畅' : '有快速运动画面时更顺滑，文件更大'}
                  >
                    {v} fps
                  </button>
                ))}
              </div>
            </div>

            <div className="capture-layout-section">
              <div className="capture-section-title capture-layout-title">
                <Webcam size={13} /> 画面构成
                <span className="capture-mic-hint">屏幕与摄像头怎么一起录（选带摄像头的构图会立即请求摄像头权限）</span>
              </div>
              <div className="capture-layout-grid">
                {LAYOUT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={`capture-layout-card ${layout === o.value ? 'selected' : ''}`}
                    onClick={() => void handleLayoutSelect(o.value)}
                    disabled={recording}
                    title={o.hint}
                  >
                    <span className="capture-layout-glyph" data-layout={o.value} />
                    <span className="capture-layout-label">{o.label}</span>
                  </button>
                ))}
              </div>
              <div className="capture-mic-hint capture-layout-hint">
                {LAYOUT_OPTIONS.find((o) => o.value === layout)?.hint ?? ''}
              </div>
            </div>

            {layout === 'pip' && (
              <div className="capture-pip-panel">
                {/* 拖拽预览：缩略图背景 + 实时摄像头小窗，拖到哪录出来就在哪 */}
                <div className="capture-pip-side">
                  <div ref={pipSurfaceRef} className="capture-pip-surface">
                    {selectedSource?.thumbnailDataUrl ? (
                      <img src={selectedSource.thumbnailDataUrl} alt="" draggable={false} />
                    ) : null}
                    <div
                      className="capture-pip-rect"
                      data-pip-rect="1"
                      style={{
                        left: `${(pipGeometry.x - pipGeometry.fracW / 2) * 100}%`,
                        top: `${(pipGeometry.y - pipGeometry.fracH / 2) * 100}%`,
                        width: `${pipGeometry.fracW * 100}%`,
                        height: `${pipGeometry.fracH * 100}%`,
                      }}
                      onPointerDown={handlePipPointerDown}
                      onPointerMove={handlePipPointerMove}
                      onPointerUp={handlePipPointerUp}
                      onPointerCancel={handlePipPointerUp}
                      title="按住拖动小窗位置"
                    >
                      <video ref={pipVideoRef} autoPlay muted playsInline />
                    </div>
                  </div>
                  <div className="capture-mic-hint">
                    在预览里拖动摄像头小窗到任意位置（当前：
                    {pipMode === 'custom' ? '自定义' : PIP_PRESETS.find((p) => p.key === pipPreset)?.label}）
                  </div>
                </div>
                {/* 预设九宫格 + 尺寸档 */}
                <div className="capture-pip-controls">
                  <span className="capture-pip-ctrl-label">位置预设</span>
                  <div className="capture-pip-grid">
                    {PIP_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        className={`capture-pip-grid-btn ${pipMode === 'preset' && pipPreset === p.key ? 'selected' : ''}`}
                        data-pip-preset={p.key}
                        title={p.label}
                        onClick={() => {
                          setPipPreset(p.key);
                          setPipMode('preset');
                        }}
                      >
                        <span
                          className="capture-pip-dot"
                          style={{left: `${12.5 + p.ax * 75}%`, top: `${12.5 + p.ay * 75}%`}}
                        />
                      </button>
                    ))}
                  </div>
                  <span className="capture-pip-ctrl-label">大小</span>
                  <div className="capture-pip-sizes">
                    {WEBCAM_SIZES.map(([v, label]) => (
                      <button
                        key={v}
                        className={`capture-chip ${webcamSize === v ? 'selected' : ''}`}
                        onClick={() => setWebcamSize(v)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {withMic && renderGainRow('mic')}
            {withSystemAudio && renderGainRow('system')}

            <div className="capture-actions">
              <button className="btn-primary" onClick={handleStart} disabled={busy || !selectedId}>
                {busy ? <Loader2 size={14} className="icon-spin" /> : <span className="capture-rec-dot-inline" />} 开始录制
              </button>
              <button className="btn-secondary" onClick={handleScreenshot} disabled={busy || !selectedId}>
                <Camera size={14} /> 截取画面
              </button>
            </div>
          </>
        )}

        {error && <div className="capture-error">{error}</div>}
        {savedNote && (
          <div className="capture-saved">
            {shotPreview && <img className="capture-saved-thumb" src={shotPreview.dataUrl} alt="截图预览" />}
            <span>{savedNote}</span>
            {standalone && savedPath && (
              <span className="capture-saved-actions">
                {savedIsVideo && (
                  <button className="capture-finish-btn" onClick={() => void handleFinishFilm()} disabled={busy}>
                    {busy ? <Loader2 size={12} className="icon-spin" /> : <Wand2 size={12} />} 录屏即成品
                  </button>
                )}
                <button
                  className="capture-reveal-btn"
                  onClick={() => void window.api.openInExplorer(savedPath)}
                  title={savedPath}
                >
                  <FolderOpen size={12} /> 打开所在文件夹
                </button>
                <span className="capture-saved-hint">{savedIsVideo ? '一键生成「标题 + 导播多镜头 + 结尾」演示片（自动配 BGM）' : '要做成片子：故事板「添加素材」或素材库可随时导入'}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ScreenRecorderModal;
