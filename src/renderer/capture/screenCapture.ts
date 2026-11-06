/**
 * 屏幕采集控制器（渲染进程单例）
 *
 * 采集路径一（默认，AI 工具与手动共用）：getUserMedia + chromeMediaSource:'desktop'
 * （Electron 传统路径，无需用户手势）。视频轨 + 可选麦克风轨合并进 MediaRecorder，
 * 产出 webm（vp9→vp8 回退，opus 音频）。
 *
 * 采集路径二（仅手动「同时录制系统声音」）：getDisplayMedia，由主进程
 * setDisplayMediaRequestHandler 按选中源直接指定 video 并请求 loopback 系统声音
 * （需真实用户手势，录屏弹窗按钮点击满足）。拿不到系统声音轨时静默降级为无声录像。
 *
 * 音频增益：有音轨（麦克风/系统声音）时统一经 AudioContext 混成单轨，每路挂独立
 * GainNode（初值取 captureStore 的 micGain/systemGain，录制中拖滑块实时生效）。
 *
 * 画布合成阶段（选区裁剪 / 摄像头构图 / 降采样启用时才接管，否则保持直录原流零回归）：
 * 源 <video> → rAF 逐帧画到 <canvas>（几何由 shared/recordingLayout 纯函数算清：
 * 画中画贴角圆角小窗 / 左右·上下分屏等比拼接 / 仅摄像头全画幅），→ canvas.captureStream(30)
 * 进 MediaRecorder。摄像头流由 enableWebcam/disableWebcam 管理（模块级单例），录制中
 * 摄像头轨中断只降级为纯屏幕画面、不终止录制；cleanup 统一释放 rAF / 合成元素 / 摄像头流。
 *
 * 生命周期：流与 MediaRecorder 是模块级单例，不随弹窗关闭而销毁（与 OBS 行为一致）；
 * 系统侧结束共享（Windows 停止共享条 / 窗口被关闭）触发 video track ended → 自动停止并保存。
 * stopRecording 去重：手动停止与 track ended 同时触发只执行一次。
 */

import {useCaptureStore} from '../store/captureStore';
import {useProjectStore} from '../store/projectStore';
import type {CaptureRegion, CaptureSaveResult, CaptureSourceInfo, CursorClick, CursorPoint, InputHookEvent, WindowRectSample} from '../../shared/capture';
import {estimateBitrateMbps, dipToVideoPoint} from '../../shared/capture';
import {computeRecordingLayout} from '../../shared/recordingLayout';
import {makeClipThumbnail} from '../utils/clipThumbnail';
import type {LayoutRect, RecordingLayout, RecordingLayoutResult, WebcamPosition, WebcamSize} from '../../shared/recordingLayout';
import type {VideoClip} from '../../shared/types';

// 摄像头相关类型迁移至 shared/recordingLayout（构图几何共用），这里转发保持旧导入路径可用
export type {WebcamPosition, WebcamSize};

/** 录制可选增强：选区裁剪（视频像素矩形）/ 摄像头构图（画中画·分屏·仅摄像头） */
export interface RecordEnhancements {
  region?: CaptureRegion;
  /** 画面构成：pip 画中画 / side 左右分屏 / stack 上下分屏 / camera 仅摄像头；
   *  给了 layout 即要求摄像头可用（执行器/弹窗负责先开启），摄像头流中断时降级为纯屏幕继续录 */
  layout?: RecordingLayout;
  /** 画中画参数（仅 layout=pip 或未给 layout 时的旧用法生效）；position 为窗口中心归一化位置（预设/拖拽自定义） */
  webcam?: {position: WebcamPosition; size: WebcamSize};
}

/** 录制画质参数（录屏弹窗与 AI 工具共用） */
export interface RecordQuality {
  /** 帧率（10-60，缺省 30） */
  fps?: number;
  /** 输出高度上限（像素）：源更高时等比缩小到该高度（宽同比例、偶数取整），源更矮时不放大 */
  maxHeight?: number;
  /** 视频码率 Mbps（缺省按输出分辨率×帧率估算，约 1080p30=8） */
  bitrateMbps?: number;
}

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
/** stop() 去重：进行中的停止流程（手动停止与 track ended 并发时复用同一 Promise） */
let stopping: Promise<CaptureSaveResult | null> | null = null;
/** 最长录制时长：chunks 全驻内存（8Mbps ≈ 1MB/s），到点自动停止保存，防长时间录制 OOM */
const MAX_RECORDING_MS = 15 * 60 * 1000;
let maxTimer: ReturnType<typeof setTimeout> | null = null;
/** 系统声 + 麦克风混流用的 AudioContext（有音轨即创建，cleanup 时关闭） */
let mixAudioCtx: AudioContext | null = null;
/** 混流时未并入主录制流的原始流（displayStream / videoStream / micStream），cleanup 时一并停止 */
let auxStreams: MediaStream[] = [];
/** 麦克风/系统声音增益节点（挂 mixAudioCtx；store 订阅实时写入 gain.value） */
let micGainNode: GainNode | null = null;
let systemGainNode: GainNode | null = null;
/** 画布合成阶段：隐藏源 <video> / 目标 canvas / rAF 句柄（仅选区或画中画启用时非空） */
let compositeVideo: HTMLVideoElement | null = null;
let compositeCanvas: HTMLCanvasElement | null = null;
let compositeRaf: number | null = null;
/** 摄像头流与对应隐藏 <video>（画中画用；enableWebcam 创建，disableWebcam/cleanup 停止） */
let webcamStream: MediaStream | null = null;
let webcamVideo: HTMLVideoElement | null = null;
/** 鼠标轨迹采集定时器（仅整屏/选区录制启用；cleanup 时清除） */
let cursorTimer: ReturnType<typeof setInterval> | null = null;
/** 本次录制采到的轨迹点（视频像素坐标，t 锚定 recorder.start() 时刻）；保存后随 clip 入片段 */
let cursorPoints: CursorPoint[] = [];
/** 本次录制采到的点击事件（视频像素坐标，与轨迹同一零点）；保存后随 clip 入片段 */
let cursorClicks: CursorClick[] = [];
/** 被录显示器 id（屏幕源 id = screen:<displayId>:0 解析而来；非屏幕源为 null 不采轨迹） */
let cursorDisplayId: number | null = null;
/** 被录窗口 HWND（窗口源 id = window:<hwnd>:0 解析而来；非窗口源为 null） */
let recordingHwnd: number | null = null;
/** 窗口矩形时间线（仅窗口录制；物理像素，点击坐标换算用） */
let windowRects: WindowRectSample[] = [];
/** 本次录制的选区（轨迹换算与 sidecar 尺寸用；非选区录制为 null） */
let recordingRegion: CaptureRegion | null = null;
/** 轨迹 t=0 锚点：recorder.start() 时刻的 performance.now() */
let recordStartPerf = 0;
/** 点击 t=0 锚点：recorder.start() 时刻的 Date.now() 墙钟（与主进程钩子事件同一时钟） */
let recordStartWall = 0;
/** 全局点击钩子是否在本轮录制启动成功（原生模块不可用时为 false，静默降级） */
let inputHookOn = false;
/** 被录显示器的布局（DIP 原点 + 缩放比，轮询光标时刷新；点击坐标换算用） */
let recordedDisplay: {x: number; y: number; scaleFactor: number} | null = null;
/** 本次录制输出画面的视频像素尺寸（点击越界过滤用；选区 = 选区尺寸，整屏 = 屏物理像素，降采样 = 缩后尺寸） */
let recordingVideoSize: {width: number; height: number} | null = null;
/** 输出缩放比（maxHeight 降采样时 <1；光标轨迹/点击坐标按它换算成输出像素，窗口路径经 recordingVideoSize 自动覆盖） */
let outputScale: {x: number; y: number} | null = null;
/** 本轮录制帧率（get_capture_status 展示用） */
let recordingFps = 30;
/** 本轮录制的码率 Mbps（get_capture_status 展示用） */
let recordingBitrateMbps = 8;
/** 本轮录制的实测时长（秒，停止时锚定）：MediaRecorder 的 webm 无 duration 元数据，ffprobe 读出 0，用实测值兜底 */
let lastRecordDurationSec = 0;
/** 本轮录制实际生效的画面构图（get_capture_status 展示用；纯屏幕 = 'screen'） */
let recordingLayoutEff: RecordingLayoutResult['layout'] = 'screen';

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

const pickMime = (): string => MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';

/** 枚举可采集源（整个屏幕 + 应用窗口） */
export const listCaptureSources = (): Promise<CaptureSourceInfo[]> => window.api.captureListSources();

/** 当前录制流的只读引用（录屏弹窗的实时预览用；未录制时为 null） */
export const getActiveStream = (): MediaStream | null => stream;

/** 摄像头流只读引用（弹窗画中画拖拽预览直接挂 <video> 所见即所得；未开启为 null） */
export const getWebcamStream = (): MediaStream | null => webcamStream;

/** 录制状态详情（get_capture_status 用）：输出尺寸/帧率/码率/构图/选区与音频开关 */
export const getRecordingInfo = (): {
  recording: boolean;
  sourceName: string;
  elapsedSec: number;
  width: number | null;
  height: number | null;
  fps: number;
  bitrateMbps: number;
  layout: RecordingLayoutResult['layout'];
  region: CaptureRegion | null;
  withMic: boolean;
  withSystemAudio: boolean;
} => {
  const st = useCaptureStore.getState();
  return {
    recording: st.recording,
    sourceName: st.sourceName,
    elapsedSec: st.elapsedSec,
    width: recordingVideoSize?.width ?? null,
    height: recordingVideoSize?.height ?? null,
    fps: recordingFps,
    bitrateMbps: recordingBitrateMbps,
    layout: recordingLayoutEff,
    region: recordingRegion,
    withMic: st.withMic,
    withSystemAudio: st.withSystemAudio,
  };
};

/** 停止摄像头流并释放对应 <video>（disableWebcam 与 cleanup 共用） */
const stopWebcam = (): void => {
  webcamStream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* 已停止的 track 忽略 */
    }
  });
  webcamStream = null;
  webcamVideo = null;
};

const cleanup = (): void => {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (cursorTimer !== null) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  if (maxTimer !== null) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
  // 画布合成阶段：停 rAF、摘源 <video>（其 track 由 auxStreams 停止）、释放 canvas 引用
  if (compositeRaf !== null) {
    cancelAnimationFrame(compositeRaf);
    compositeRaf = null;
  }
  if (compositeVideo) {
    compositeVideo.srcObject = null;
    compositeVideo = null;
  }
  compositeCanvas = null;
  stopWebcam();
  micGainNode = null;
  systemGainNode = null;
  recordingRegion = null;
  // 点击钩子兜底停止（正常路径 stopRecording 已停；discardRecording/异常路径走这里）
  if (inputHookOn) {
    inputHookOn = false;
    void window.api.captureStopInputHook().catch(() => {});
  }
  recordedDisplay = null;
  recordingVideoSize = null;
  outputScale = null;
  recordingFps = 30;
  recordingBitrateMbps = 8;
  recordingLayoutEff = 'screen';
  recordingHwnd = null;
  windowRects = [];
  stream?.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      /* 已停止的 track 忽略 */
    }
  });
  auxStreams.forEach((s) =>
    s.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* 已停止的 track 忽略 */
      }
    }),
  );
  auxStreams = [];
  if (mixAudioCtx) {
    void mixAudioCtx.close().catch(() => {});
    mixAudioCtx = null;
  }
  stream = null;
  recorder = null;
  stopping = null;
  useCaptureStore.setState({recording: false, sourceName: '', startedAt: 0, elapsedSec: 0, withMic: false, withSystemAudio: false, webcamOn: false});
};

/**
 * 开启摄像头（画中画用）：幂等，已开启直接置位复用。
 * 权限被拒/无设备等失败抛中文错（弹窗展示）；成功置 captureStore.webcamOn。
 * 流是模块级单例：开始录制时并入合成阶段，cleanup 统一停止。
 */
export const enableWebcam = async (): Promise<void> => {
  if (webcamStream) {
    useCaptureStore.setState({webcamOn: true});
    return;
  }
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: {width: {ideal: 640}},
      audio: false,
    });
  } catch (err) {
    throw new Error(`无法开启摄像头：${err instanceof Error ? err.message : String(err)}`);
  }
  useCaptureStore.setState({webcamOn: true});
};

/** 关闭摄像头（停止流并复位开关；录制进行中由 cleanup 统一停止，不走这里） */
export const disableWebcam = (): void => {
  stopWebcam();
  useCaptureStore.setState({webcamOn: false});
};

/**
 * 音频混流 + 增益：每路音源（麦克风/系统声音）经独立 GainNode 进 MediaStreamDestination
 * 混成单轨。增益初值取 captureStore（录制中拖滑块经下方订阅实时写入 gain.value）。
 * 无任何音轨返回 null；mixAudioCtx 在 cleanup 时关闭。
 */
const mixAudioTracks = (tracks: {mic?: MediaStreamTrack; system?: MediaStreamTrack}): MediaStreamTrack | null => {
  const entries: [kind: 'mic' | 'system', track: MediaStreamTrack][] = [];
  if (tracks.mic) entries.push(['mic', tracks.mic]);
  if (tracks.system) entries.push(['system', tracks.system]);
  if (entries.length === 0) return null;
  mixAudioCtx = new AudioContext();
  // Electron 默认 no-user-gesture-required 即 running；保险起见显式 resume（已 running 时为空操作）
  void mixAudioCtx.resume().catch(() => {});
  const dest = mixAudioCtx.createMediaStreamDestination();
  const st = useCaptureStore.getState();
  for (const [kind, track] of entries) {
    const gain = mixAudioCtx.createGain();
    gain.gain.value = kind === 'mic' ? st.micGain : st.systemGain;
    if (kind === 'mic') micGainNode = gain;
    else systemGainNode = gain;
    mixAudioCtx.createMediaStreamSource(new MediaStream([track])).connect(gain).connect(dest);
  }
  return dest.stream.getAudioTracks()[0] ?? null;
};

// 增益滑块实时生效：store 变化写入进行中的 GainNode（未录制时节点为 null，跳过）
useCaptureStore.subscribe((s) => {
  if (micGainNode) micGainNode.gain.value = s.micGain;
  if (systemGainNode) systemGainNode.gain.value = s.systemGain;
});

/**
 * 画布合成：按构图几何把两路画面逐帧画到 canvas，返回 canvas.captureStream(fps)。
 * - 屏幕帧：源矩形（选区裁剪）→ screenRect（等比缩放在此一次完成）
 * - 摄像头帧：cameraRect 落位；pip 构图圆角 + 描边，分屏/全画幅直角硬边
 * - 每帧先铺黑底（分屏缝隙/摄像头轨中断时不残留上一帧或透明）
 * 画面主体轨（camera 构图 = 摄像头轨，其余 = 源视频轨）ended 时触发自动停止保存。
 * 摄像头轨中断只跳过摄像头绘制、录制继续（与画中画时代行为一致）。
 */
const buildCompositeStream = (
  sourceStream: MediaStream,
  opts: {src: LayoutRect; geo: RecordingLayoutResult; fps?: number},
): MediaStream => {
  const videoTrack = sourceStream.getVideoTracks()[0];
  const geo = opts.geo;

  compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = geo.outWidth;
  compositeCanvas.height = geo.outHeight;
  const ctx = compositeCanvas.getContext('2d');

  if (geo.screenRect) {
    compositeVideo = document.createElement('video');
    compositeVideo.muted = true;
    compositeVideo.srcObject = new MediaStream([videoTrack]);
    void compositeVideo.play().catch(() => {});
  }
  if (geo.cameraRect && webcamStream) {
    webcamVideo = document.createElement('video');
    webcamVideo.muted = true;
    webcamVideo.srcObject = webcamStream;
    void webcamVideo.play().catch(() => {});
  }
  // 合成后 canvas 轨不会随源结束：画面主体轨 ended 也要触发自动停止并保存
  // （camera 构图屏幕不参与，主体是摄像头；其余构图主体是源视频轨）
  const masterTrack = geo.screenRect ? videoTrack : (webcamStream?.getVideoTracks()[0] ?? videoTrack);
  masterTrack.addEventListener('ended', () => {
    void stopRecording();
  });

  // 画中画圆角/描边按 1080p 等比缩放（均按输出尺寸计）
  const pipRadius = Math.max(4, Math.round(16 * (geo.outHeight / 1080)));
  const pipBorder = Math.max(1, Math.round(2 * (geo.outHeight / 1080)));

  const draw = (): void => {
    if (!compositeCanvas) return; // cleanup 后兜底（rAF 已取消，双保险）
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, geo.outWidth, geo.outHeight);
      const sr = geo.screenRect;
      if (sr && compositeVideo && compositeVideo.readyState >= 2) {
        // 源矩形（选区或整幅）→ screenRect，一次 drawImage 同时完成裁剪与缩放
        ctx.drawImage(compositeVideo, opts.src.x, opts.src.y, opts.src.width, opts.src.height, sr.x, sr.y, sr.width, sr.height);
      }
      // 摄像头：轨中断/无帧时跳过本次绘制，录制继续（不终止）
      const camTrack = webcamStream?.getVideoTracks()[0];
      const cr = geo.cameraRect;
      if (webcamVideo && cr && camTrack && camTrack.readyState === 'live' && webcamVideo.readyState >= 2) {
        if (geo.cameraRounded) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(cr.x, cr.y, cr.width, cr.height, pipRadius);
          ctx.clip();
          ctx.drawImage(webcamVideo, cr.x, cr.y, cr.width, cr.height);
          ctx.restore();
          ctx.beginPath();
          ctx.roundRect(cr.x, cr.y, cr.width, cr.height, pipRadius);
          ctx.lineWidth = pipBorder;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.stroke();
        } else {
          ctx.drawImage(webcamVideo, cr.x, cr.y, cr.width, cr.height);
        }
      }
    }
    compositeRaf = requestAnimationFrame(draw);
  };
  compositeRaf = requestAnimationFrame(draw);

  return compositeCanvas.captureStream(opts.fps ?? 30);
};

/**
 * 起录前算清构图几何：源帧裁剪矩形（选区）+ 输出画布与两路落位。
 * 屏幕画面尺寸 = 选区尺寸或视频轨实际尺寸；摄像头尺寸取摄像头轨 settings
 * （无摄像头轨时任何构图都降级纯屏幕，录制不失败）。窗口源轨尺寸未知时回退源枚举尺寸再回退 1920×1080。
 */
const computeCompositeGeometry = (
  opts: RecordEnhancements & RecordQuality,
  source: CaptureSourceInfo,
  region: CaptureRegion | undefined,
  trackSettings: MediaTrackSettings | undefined,
): {src: LayoutRect; geo: RecordingLayoutResult} => {
  const srcW = trackSettings?.width || (source.width > 0 ? source.width : 1920);
  const srcH = trackSettings?.height || (source.height > 0 ? source.height : 1080);
  const camTrack = webcamStream?.getVideoTracks()[0];
  const camSettings = camTrack?.getSettings();
  const camera = (opts.layout || opts.webcam) && camTrack
    ? {width: camSettings?.width || 640, height: camSettings?.height || 480}
    : null;
  const geo = computeRecordingLayout({
    layout: opts.layout,
    screen: {width: region?.width ?? srcW, height: region?.height ?? srcH},
    camera,
    pipPosition: opts.webcam?.position,
    size: opts.webcam?.size,
    maxHeight: opts.maxHeight,
  });
  return {src: region ?? {x: 0, y: 0, width: srcW, height: srcH}, geo};
};

/**
 * 两条采集路径共用的收尾：给组装好的流挂 MediaRecorder、计时与录制状态。
 * 调用前需已确认 recorder 为 null（无进行中录制）。
 * source 用于启动鼠标轨迹采集（屏幕源按屏换算；窗口源经 koffi 取窗口矩形换算）；
 * 鼠标轨迹只在画面与屏幕像素 1:1 的构图（纯屏幕/画中画）下采集——分屏/仅摄像头构图里
 * 屏幕只是画布的一部分（或不在画面里），轨迹坐标与成片对不上，采了也是误导数据。
 * opts.region 为选区录制时的输出矩形（轨迹换算锚定选区原点、sidecar 记选区尺寸）。
 */
const beginRecording = (
  mediaStream: MediaStream,
  source: CaptureSourceInfo,
  opts: {withMic: boolean; withSystemAudio: boolean; region?: CaptureRegion; output?: {width: number; height: number}; fps?: number; bitrateMbps?: number; effectiveLayout?: RecordingLayoutResult['layout']},
): void => {
  stream = mediaStream;
  chunks = [];
  const fps = opts.fps ?? 30;
  recordingLayoutEff = opts.effectiveLayout ?? 'screen';
  const trackCursor = recordingLayoutEff === 'screen' || recordingLayoutEff === 'pip';
  // 码率按输出尺寸估算（窗口源无先验尺寸，缺省按 1080p 基准，误差只影响文件体积）
  const estSize = opts.output ?? (opts.region ? {width: opts.region.width, height: opts.region.height} : source.width > 0 && source.height > 0 ? {width: source.width, height: source.height} : {width: 1920, height: 1080});
  const bitrateMbps = estimateBitrateMbps(estSize.width, estSize.height, fps, opts.bitrateMbps);
  recordingFps = fps;
  recordingBitrateMbps = bitrateMbps;
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, {
    ...(mimeType ? {mimeType} : {}),
    videoBitsPerSecond: Math.round(bitrateMbps * 1_000_000),
    audioBitsPerSecond: 128_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  // 编码器异常（驱动/GPU 抖动、容器写失败等）不会自然触发 onstop/track ended——
  // 不接管的话录制会永远挂在「录制中」。这里自动走停止保存流程：已录到的内容落盘，
  // 与手动停止/track ended 同一条去重路径（stopping），不会重复保存。
  recorder.onerror = () => {
    console.warn('[capture] MediaRecorder 异常，自动停止并保存已录内容');
    void stopRecording();
  };
  // 系统侧结束共享（Windows 停止共享条 / 窗口被关）→ 自动停止并保存
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    void stopRecording();
  });

  stopping = null;
  recorder.start(1000);
  recordStartPerf = performance.now(); // 轨迹 t=0 锚点
  recordStartWall = Date.now(); // 点击 t=0 锚点（与主进程钩子事件同一墙钟）
  lastRecordDurationSec = 0; // 实测时长兜底值清零（停止时重新锚定）
  // 鼠标轨迹采集（仅屏幕源录制）：30Hz 轮询主进程光标位置（DIP），换算为视频像素坐标。
  // 光标移到其他屏时暂停采样；回到被录屏时先把轨迹钉在离开位置（渲染期保持最后已知
  // 位置而非滑移），再接续新采样。单次轮询失败静默忽略。
  // 选区录制时坐标锚定选区原点，光标在选区外钳制在选区边缘（钉边）。
  cursorPoints = [];
  cursorClicks = [];
  cursorDisplayId = null;
  recordingHwnd = null;
  windowRects = [];
  recordingRegion = opts.region ?? null;
  recordingVideoSize = opts.region
    ? {width: opts.region.width, height: opts.region.height}
    : source.width > 0 && source.height > 0
      ? {width: source.width, height: source.height}
      : null;
  if (trackCursor && source.kind === 'screen') {
    // 屏幕源 id 形如 screen:0:0，中间段是枚举序号而非 Display.id；
    // 真实 Display.id 由主进程经 display_id 透出（CaptureSourceInfo.displayId）。
    // 误用序号会导致与 pollCursor 的 displayId 永不匹配 → 轨迹/点击全程判为离屏、一个点都采不到。
    const displayId = source.displayId ?? Number(source.id.split(':')[1]);
    if (Number.isFinite(displayId)) {
      cursorDisplayId = displayId;
      // 点击采集：全局输入钩子（原生模块不可用时返回 false，静默降级为只录移动轨迹）
      void window.api.captureStartInputHook().then((ok) => {
        inputHookOn = ok;
      }).catch(() => {});
      let offScreen = false;
      cursorTimer = setInterval(() => {
        void window.api.capturePollCursor().then((cur) => {
          if (cur.displayId !== displayId) {
            offScreen = true;
            return;
          }
          const disp = cur.displays.find((d) => d.id === displayId);
          if (!disp) return;
          recordedDisplay = {x: disp.x, y: disp.y, scaleFactor: disp.scaleFactor};
          const pt = dipToVideoPoint(cur.x, cur.y, disp, opts.region);
          const now = performance.now() - recordStartPerf;
          if (offScreen && cursorPoints.length > 0) {
            // 回屏前补一个离开位置的钉点：离屏期间轨迹保持最后已知位置
            const lastPt = cursorPoints[cursorPoints.length - 1];
            if (now - 40 > lastPt.t) cursorPoints.push({t: now - 40, x: lastPt.x, y: lastPt.y});
          }
          offScreen = false;
          // 降采样时坐标乘缩放比落到输出像素（无缩放时 1:1）
          const sx = outputScale?.x ?? 1;
          const sy = outputScale?.y ?? 1;
          cursorPoints.push({t: now, x: Math.round(pt.x * sx), y: Math.round(pt.y * sy)});
        }).catch(() => {});
      }, 33);
    }
  } else if (trackCursor && source.kind === 'window') {
    // 窗口源轨迹采集：HWND 来自源 id（window:<hwnd>:0），窗口矩形由主进程 koffi
    // 查询（物理像素，DWM 可见框）；坐标换算 = (光标物理坐标 − 矩形原点) × (视频尺寸/矩形尺寸)，
    // 光标在窗口外时钳到画面边缘（钉边）。窗口最小化/关闭（矩形为 null）时暂停采样，
    // 恢复后先补钉点再接续（与屏幕源离屏处理一致）。
    const hwnd = Number(source.id.split(':')[1]);
    if (Number.isFinite(hwnd)) {
      recordingHwnd = hwnd;
      // 视频实际尺寸：窗口源系统按窗口实际尺寸给，从视频轨 settings 取
      const trackSettings = mediaStream.getVideoTracks()[0]?.getSettings?.();
      if (trackSettings?.width && trackSettings?.height) {
        recordingVideoSize = {width: trackSettings.width, height: trackSettings.height};
      }
      void window.api.captureStartInputHook().then((ok) => {
        inputHookOn = ok;
      }).catch(() => {});
      let offWindow = false;
      cursorTimer = setInterval(() => {
        void window.api.capturePollCursor(hwnd).then((cur) => {
          const rect = cur.windowRect;
          const size = recordingVideoSize;
          const now = performance.now() - recordStartPerf;
          if (!rect || !size) {
            offWindow = true;
            return;
          }
          windowRects.push({t: Math.round(now), x: rect.x, y: rect.y, w: rect.w, h: rect.h});
          // DIP → 物理像素：物理原点 = DIP 原点 × scaleFactor（光标所在屏的缩放比）
          const disp = cur.displays.find((d) => d.id === cur.displayId);
          const sf = disp?.scaleFactor ?? 1;
          const vx = Math.round(Math.max(0, Math.min(size.width, (cur.x * sf - rect.x) * (size.width / rect.w))));
          const vy = Math.round(Math.max(0, Math.min(size.height, (cur.y * sf - rect.y) * (size.height / rect.h))));
          if (offWindow && cursorPoints.length > 0) {
            const lastPt = cursorPoints[cursorPoints.length - 1];
            if (now - 40 > lastPt.t) cursorPoints.push({t: now - 40, x: lastPt.x, y: lastPt.y});
          }
          offWindow = false;
          cursorDisplayId = cur.displayId; // sidecar 参考值（窗口中心所在屏近似）
          cursorPoints.push({t: now, x: vx, y: vy});
        }).catch(() => {});
      }, 33);
    }
  }
  // 降采样收尾：轨迹/点击换算用的输出尺寸与缩放比（窗口路径的 recordingVideoSize
  // 已在上方按轨 settings 解析，这里统一换成缩后尺寸并记缩放比供屏幕路径与钩子换算）
  if (opts.output && recordingVideoSize && (recordingVideoSize.width !== opts.output.width || recordingVideoSize.height !== opts.output.height)) {
    outputScale = {x: opts.output.width / recordingVideoSize.width, y: opts.output.height / recordingVideoSize.height};
    recordingVideoSize = {width: opts.output.width, height: opts.output.height};
  }
  // 时长上限：到点自动停止并保存（与手动停止走同一路径，结果照常落盘）
  maxTimer = setTimeout(() => {
    console.warn('[capture] 已达最长录制时长（15 分钟），自动停止并保存');
    void stopRecording();
  }, MAX_RECORDING_MS);
  useCaptureStore.setState({recording: true, sourceName: source.name, startedAt: Date.now(), elapsedSec: 0, withMic: opts.withMic, withSystemAudio: opts.withSystemAudio});
  timer = setInterval(() => {
    const st = useCaptureStore.getState();
    if (st.startedAt > 0) {
      useCaptureStore.setState({elapsedSec: (Date.now() - st.startedAt) / 1000});
    }
  }, 500);
};

/** 选区规整：偶数取整 + 钳回屏幕内（AI 给的任意整数像素也能安全起录）；无法容纳时抛中文错误 */
const normalizeRegionToScreen = (region: CaptureRegion, source: CaptureSourceInfo): CaptureRegion => {
  if (source.kind !== 'screen') {
    throw new Error('选区录制（region）仅支持屏幕源；录制窗口请去掉 region 参数（窗口本身就是精确画面）');
  }
  if (source.width <= 0 || source.height <= 0) return region; // 屏幕尺寸未知时不钳制（保持原值）
  const evenFloor = (v: number): number => Math.max(0, Math.floor(v / 2) * 2);
  const maxW = evenFloor(source.width);
  const maxH = evenFloor(source.height);
  const width = Math.min(evenFloor(region.width), maxW);
  const height = Math.min(evenFloor(region.height), maxH);
  if (width < 320 || height < 180) {
    throw new Error(`选区无法落在屏幕内：屏幕 ${source.width}×${source.height}，钳制后仅 ${width}×${height}（至少 320×180），请调整 region`);
  }
  const x = Math.max(0, Math.min(evenFloor(region.x), maxW - width));
  const y = Math.max(0, Math.min(evenFloor(region.y), maxH - height));
  return {x, y, width, height};
};

/**
 * 开始录制。sourceId 缺省 = 主屏；withMic = 同时录麦克风（默认 false）。
 * layout（画面构成：pip/side/stack/camera，需先开启摄像头）/ region（选区裁剪，仅屏幕源，
 * camera 构图忽略）/ webcam（画中画参数）/ fps / maxHeight（降采样）/ bitrateMbps
 * 启用时改走画布合成阶段。已在录制中 / 源不存在 / 系统拒绝采集时抛中文错误。
 */
export const startRecording = async (
  opts: {sourceId?: string; withMic?: boolean} & RecordEnhancements & RecordQuality = {},
): Promise<{sourceName: string}> => {
  if (recorder) throw new Error('已有录制正在进行中，请先停止');
  if (opts.layout && !webcamStream) {
    throw new Error('当前画面构成需要摄像头画面：请先开启摄像头（录屏弹窗「画面构成」选带摄像头的构图即自动开启）');
  }

  const sources = await window.api.captureListSources();
  const source =
    (opts.sourceId && sources.find((s) => s.id === opts.sourceId)) ||
    sources.find((s) => s.kind === 'screen') ||
    sources[0];
  if (!source) throw new Error('未找到可录制的屏幕/窗口');

  // 仅摄像头构图不录屏幕画面，选区无意义直接忽略
  const region = opts.layout === 'camera' ? undefined : opts.region ? normalizeRegionToScreen(opts.region, source) : undefined;

  const mandatory: Record<string, unknown> = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: source.id,
    maxFrameRate: opts.fps ?? 30,
  };
  // 屏幕源按物理像素请求满分辨率（画面不糊）；窗口源由系统按窗口实际尺寸给
  if (source.kind === 'screen' && source.width > 0 && source.height > 0) {
    mandatory.minWidth = source.width;
    mandatory.maxWidth = source.width;
    mandatory.minHeight = source.height;
    mandatory.maxHeight = source.height;
  } else {
    mandatory.maxWidth = 3840;
    mandatory.maxHeight = 2160;
  }

  let videoStream: MediaStream;
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {mandatory},
      audio: false,
    } as unknown as MediaStreamConstraints);
  } catch (err) {
    throw new Error(
      `无法开始采集：${err instanceof Error ? err.message : String(err)}` +
        (source.kind === 'window' ? '（如目标窗口被最小化，请先还原再试）' : ''),
    );
  }

  // 麦克风独立一路请求（桌面采集与音频同一次请求在 Windows 上会失败，必须分开）
  let micStream: MediaStream | null = null;
  if (opts.withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
    } catch {
      console.warn('[capture] 麦克风不可用，仅录画面');
    }
  }

  // 有麦克风轨时经 GainNode 混流（滑块实时调音量）；无音轨返回 null
  const recordAudioTrack = mixAudioTracks({mic: micStream?.getAudioTracks()[0]});
  // 构图几何（选区裁剪矩形 + 输出画布与两路落位；降采样/摄像头构图都体现在这里）
  const trackSettings = videoStream.getVideoTracks()[0]?.getSettings?.();
  const {src, geo} = computeCompositeGeometry(opts, source, region, trackSettings);
  // 选区/摄像头参与/输出与源帧不一致（降采样或拼接画布）时走画布合成，否则直录原流（零回归路径）
  const fullFrameW = trackSettings?.width || (source.width > 0 ? source.width : 0);
  const fullFrameH = trackSettings?.height || (source.height > 0 ? source.height : 0);
  const downscaled = fullFrameW > 0 && fullFrameH > 0 && (geo.outWidth !== fullFrameW || geo.outHeight !== fullFrameH);
  const useComposite = Boolean(region) || Boolean(geo.cameraRect) || downscaled;
  const videoTracks = useComposite
    ? buildCompositeStream(videoStream, {src, geo, fps: opts.fps}).getVideoTracks()
    : videoStream.getVideoTracks();
  // 原始流不再直接进录制流（混流/合成引用了其 track），登记 cleanup 时统一停止
  auxStreams = micStream ? [videoStream, micStream] : [videoStream];
  beginRecording(
    new MediaStream([...videoTracks, ...(recordAudioTrack ? [recordAudioTrack] : [])]),
    source,
    {
      withMic: Boolean(micStream),
      withSystemAudio: false,
      region,
      output: useComposite ? {width: geo.outWidth, height: geo.outHeight} : undefined,
      fps: opts.fps,
      bitrateMbps: opts.bitrateMbps,
      effectiveLayout: geo.layout,
    },
  );
  return {sourceName: source.name};
};

/**
 * 手动路径：录制画面 + 系统声音（loopback），可选再混麦克风。
 *
 * 走 getDisplayMedia（需真实用户手势，录屏弹窗的按钮点击满足），源由主进程
 * setDisplayMediaRequestHandler 按 sourceId 直接指定（不弹系统选择器）并请求 loopback。
 * 拿不到系统声音轨（平台不支持等）时静默降级为无声录像，返回值 systemAudio 标记 false。
 * 无真实用户手势时（如 AI 工具触发）Chromium 拒绝 getDisplayMedia：抛
 * GestureRequiredError（name 标记），由调用方引导用户手动点击。
 * region（选区裁剪）/ webcam（画中画）与默认路径一样走画布合成阶段。
 */
export const startWithSystemAudio = async (
  sourceId: string,
  opts: {withMic?: boolean} & RecordEnhancements & RecordQuality = {},
): Promise<{sourceName: string; systemAudio: boolean}> => {
  if (recorder) throw new Error('已有录制正在进行中，请先停止');
  if (opts.layout && !webcamStream) {
    throw new Error('当前画面构成需要摄像头画面：请先开启摄像头（录屏弹窗「画面构成」选带摄像头的构图即自动开启）');
  }

  const sources = await window.api.captureListSources();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error('未找到要录制的屏幕/窗口');

  // 选区规整放在建流之前：非法选区抛错时不会泄漏已获取的采集流（仅摄像头构图忽略选区）
  const region = opts.layout === 'camera' ? undefined : opts.region ? normalizeRegionToScreen(opts.region, source) : undefined;

  // 目标源经 IPC 告知主进程（getDisplayMedia 的 request 不携带 chromeMediaSourceId）
  await window.api.captureSetDisplayMediaSource(source.id);

  let displayStream: MediaStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      // 源由主进程 handler 按 sourceId 指定，这里不用 chromeMediaSource 约束
      //（getDisplayMedia 不接受 mandatory 精确约束，Electron 32 实测报 exact constraints are not supported）
      video: true,
      audio: true,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      // 无真实用户手势（AI 工具触发等）时 Chromium 拒绝 getDisplayMedia
      const gestureErr = new Error('录制系统声音需要在录屏弹窗中手动点击「开始录制」（浏览器要求真实点击手势，AI 无法代为触发）');
      gestureErr.name = 'GestureRequiredError';
      throw gestureErr;
    }
    throw new Error(`无法开始采集：${err instanceof Error ? err.message : String(err)}`);
  }

  const systemAudioTracks = displayStream.getAudioTracks();
  const systemAudio = systemAudioTracks.length > 0;
  if (!systemAudio) {
    console.warn('[capture] 未获取到系统声音轨，降级为无声录像');
  }

  // 麦克风独立一路请求（桌面采集与音频同一次请求在 Windows 上会失败，必须分开）
  let micStream: MediaStream | null = null;
  if (opts.withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
    } catch {
      console.warn('[capture] 麦克风不可用，仅录系统声音');
    }
  }

  // 系统声/麦克风各自经独立 GainNode 混成单轨（增益滑块实时生效）；无音轨返回 null
  const recordAudioTrack = mixAudioTracks({system: systemAudioTracks[0], mic: micStream?.getAudioTracks()[0]});
  // 构图几何（与默认路径同口径）
  const trackSettings = displayStream.getVideoTracks()[0]?.getSettings?.();
  const {src, geo} = computeCompositeGeometry(opts, source, region, trackSettings);
  const fullFrameW = trackSettings?.width || (source.width > 0 ? source.width : 0);
  const fullFrameH = trackSettings?.height || (source.height > 0 ? source.height : 0);
  const downscaled = fullFrameW > 0 && fullFrameH > 0 && (geo.outWidth !== fullFrameW || geo.outHeight !== fullFrameH);
  const useComposite = Boolean(region) || Boolean(geo.cameraRect) || downscaled;
  const videoTracks = useComposite
    ? buildCompositeStream(displayStream, {src, geo, fps: opts.fps}).getVideoTracks()
    : displayStream.getVideoTracks();

  auxStreams = micStream ? [displayStream, micStream] : [displayStream];
  beginRecording(
    new MediaStream([...videoTracks, ...(recordAudioTrack ? [recordAudioTrack] : [])]),
    source,
    {
      withMic: Boolean(micStream),
      withSystemAudio: systemAudio,
      region,
      output: useComposite ? {width: geo.outWidth, height: geo.outHeight} : undefined,
      fps: opts.fps,
      bitrateMbps: opts.bitrateMbps,
      effectiveLayout: geo.layout,
    },
  );
  return {sourceName: source.name, systemAudio};
};

/**
 * 主进程钩子事件（物理像素 + Date.now() 墙钟）→ CursorClick（视频像素 + 录制零点）。
 * uiohook 事件坐标是物理像素：显示器物理原点 = DIP 原点 × scaleFactor，
 * 故视频像素 = 事件物理坐标 − 物理原点（选区录制再减选区原点）；
 * 窗口录制改按点击时刻的窗口矩形换算（矩形时间线在录制期轮询记录）；
 * 落在输出画面外的点击（其他屏 / 选区外 / 窗口外）丢弃，不进成片。
 */
const convertHookEventsToClicks = (events: InputHookEvent[]): CursorClick[] => {
  const size = recordingVideoSize;
  if (!size) return [];
  const region = recordingRegion;
  const clicks: CursorClick[] = [];
  for (const e of events) {
    const t = Math.round(e.wallTime - recordStartWall);
    if (t < 0) continue; // 录制正式开始前的事件（启动钩子与 recorder.start 的微小时间差）
    let vx: number;
    let vy: number;
    if (recordingHwnd !== null) {
      // 窗口录制：取点击时刻之前最近一次窗口矩形（无更早样本用首个）
      let rect: WindowRectSample | null = null;
      for (const r of windowRects) {
        if (r.t <= t) rect = r;
        else break;
      }
      if (!rect) rect = windowRects[0] ?? null;
      if (!rect) continue;
      vx = Math.round((e.x - rect.x) * (size.width / rect.w));
      vy = Math.round((e.y - rect.y) * (size.height / rect.h));
    } else {
      const disp = recordedDisplay;
      if (!disp) break; // 无屏幕布局信息（轨迹都没采到），后续事件同样无法换算
      vx = Math.round((e.x - disp.x * disp.scaleFactor - (region ? region.x : 0)) * (outputScale?.x ?? 1));
      vy = Math.round((e.y - disp.y * disp.scaleFactor - (region ? region.y : 0)) * (outputScale?.y ?? 1));
    }
    if (vx < 0 || vy < 0 || vx >= size.width || vy >= size.height) continue;
    clicks.push({t, x: vx, y: vy, button: e.button});
  }
  return clicks;
};

/** 停止并保存。无进行中录制返回 null；重复/并发调用复用同一次停止流程 */export const stopRecording = (): Promise<CaptureSaveResult | null> => {
  if (stopping) return stopping;
  const rec = recorder;
  if (!rec) return Promise.resolve(null);

  // 实测时长在此刻锚定（手动停止与 track ended 都经过这里）：
  // MediaRecorder 的 webm 无 duration 元数据，addCaptureToSegment 以此兜底
  lastRecordDurationSec = recordStartPerf > 0 ? (performance.now() - recordStartPerf) / 1000 : 0;

  stopping = new Promise<CaptureSaveResult | null>((resolve) => {
    const finalize = async (): Promise<CaptureSaveResult | null> => {
      try {
        const blob = new Blob(chunks, {type: rec.mimeType || 'video/webm'});
        chunks = [];
        if (blob.size === 0) return null;
        const bytes = await blob.arrayBuffer();
        // 屏幕源录制采到的鼠标轨迹随保存上送，主进程写 sidecar 并回传 cursorTrackPath；
        // 选区录制时附带选区尺寸作为 sidecar 的视频宽高（轨迹点已是选区相对坐标）
        let clicks: CursorClick[] | undefined;
        if (inputHookOn) {
          inputHookOn = false;
          const raw = await window.api.captureStopInputHook().catch(() => [] as InputHookEvent[]);
          clicks = convertHookEventsToClicks(raw);
        }
        cursorClicks = clicks ?? [];
        const isWindowRec = recordingHwnd !== null;
        const cursorTrack =
          (cursorDisplayId !== null || isWindowRec) && cursorPoints.length > 0
            ? {
                displayId: cursorDisplayId ?? 0,
                points: cursorPoints,
                ...(clicks && clicks.length > 0 ? {clicks} : {}),
                ...(recordingVideoSize
                  ? {videoWidth: recordingVideoSize.width, videoHeight: recordingVideoSize.height}
                  : {}),
                sourceKind: isWindowRec ? ('window' as const) : ('screen' as const),
                ...(isWindowRec && windowRects.length > 0 ? {windowRects} : {}),
              }
            : undefined;
        return await window.api.captureSaveRecording(bytes, cursorTrack);
      } finally {
        cleanup();
      }
    };
    if (rec.state === 'inactive') {
      void finalize().then(resolve);
      return;
    }
    rec.onstop = () => void finalize().then(resolve);
    try {
      rec.stop();
    } catch {
      // 'stopping' 态（track ended 已触发内部停止）：onstop 会自然触发，无需再 stop
    }
  });
  return stopping;
};

/** 放弃录制（停止采集但不落盘） */
export const discardRecording = (): void => {
  if (!recorder) return;
  try {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
  } catch {
    /* 忽略 */
  }
  chunks = [];
  cleanup();
};

/**
 * 把已落盘的采集文件（录像/截图）构建成 VideoClip 并加入指定片段（缺省当前选中段）。
 * 元数据走主进程 ffprobe/nativeImage，与上传素材的处理完全一致。
 */
export const addCaptureToSegment = async (
  saved: CaptureSaveResult,
  segmentIndex?: number,
): Promise<{segmentIndex: number; duration: number; width: number; height: number}> => {
  const store = useProjectStore.getState();
  const idx = segmentIndex ?? store.activeSegmentIndex;
  if (!store.segments[idx]) {
    throw new Error(`段下标 ${idx} 越界，当前共 ${store.segments.length} 段`);
  }
  const meta = await window.api.getVideoMetadata(saved.path);
  // 时长兜底：录屏 webm 无 duration 元数据（ffprobe 读 0/NaN）时用实测录制时长，
  // 否则裁剪面板会显示 0:00:00、裁剪滑条不可用
  const duration =
    Number.isFinite(meta.duration) && meta.duration > 0.05
      ? meta.duration
      : lastRecordDurationSec > 0.05
        ? lastRecordDurationSec
        : Number.isFinite(meta.duration)
          ? meta.duration
          : 0;
  const clip: VideoClip = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    src: saved.src, // HTTP URL，渲染时直接可用
    name: saved.name,
    type: meta.type, // 'video' | 'image'
    width: meta.width,
    height: meta.height,
    duration,
    trimStart: 0,
    trimEnd: duration,
    trimmedDuration: duration,
    // 本软件录屏产物：素材来源类型确定标录屏（AI 选型信号；摄像头出镜素材也被
    // 烧录成演示画面，按录屏口径选模板）
    sourceKind: 'screen-recording' as const,
  };
  // 屏幕源录制带鼠标轨迹：sidecar 路径持久化，采样点/点击留内存态供 CursorFollow 模板消费
  if (saved.cursorTrackPath && cursorPoints.length > 0) {
    clip.cursorTrack = saved.cursorTrackPath;
    clip.cursorPoints = cursorPoints;
    if (cursorClicks.length > 0) clip.cursorClicks = cursorClicks;
  }
  // 色彩统计（自动曝光匹配用；失败静默跳过，不影响入段）
  try {
    const stats = await window.api.analyzeMediaColor(saved.path);
    if (stats) clip.colorStats = stats;
  } catch {
    /* 分析失败不阻塞 */
  }
  // 缩略图（时间线/故事板卡片的胶片条；与文件导入链路同口径，失败退文字预览不阻塞）
  clip.thumbnail = await makeClipThumbnail(saved.path, duration);
  store.addVideosToSegment(idx, [clip]);
  return {segmentIndex: idx, duration, width: meta.width, height: meta.height};
};
