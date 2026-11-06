/**
 * 屏幕录制 / 截屏的共享数据结构（主进程 / preload / 渲染端共用）
 *
 * 采集路径：渲染端 getUserMedia + chromeMediaSource:'desktop'（Electron 传统路径，
 * 无需用户手势，AI 助手可程序化调用）；主进程负责源枚举、截屏与录像落盘。
 */

/** 可采集源（OBS 式：整个屏幕或单个应用窗口） */
export interface CaptureSourceInfo {
  /** desktopCapturer 源 id（形如 screen:0:0 / window:12345:0） */
  id: string;
  /** 显示名（「屏幕 1」/ 应用窗口标题） */
  name: string;
  kind: 'screen' | 'window';
  /**
   * 屏幕源的真实 Display.id（来自 desktopCapturer 的 display_id）。
   * 注意：源 id 形如 screen:0:0，中间段是枚举序号而非 Display.id，不能 split 解析！
   * 轨迹采集按此 id 与 pollCursor 的 displayId 比较判断是否在被录屏上。
   */
  displayId?: number;
  /** 像素尺寸（屏幕 = 物理像素 size×scaleFactor；窗口未知时为 0） */
  width: number;
  height: number;
  /** 列表缩略图 data URL（约 480×270） */
  thumbnailDataUrl: string;
  /** 窗口应用图标 data URL（仅 window 且系统提供时） */
  appIconDataUrl?: string;
}

/** 录像实际帧率统计（主进程保存后用 ffprobe 探测；读不到的维度为 null，调用方降级） */
export interface CaptureFrameStats {
  /** 实际帧数（nb_frames） */
  frameCount: number | null;
  /** 容器声明的平均帧率（avg_frame_rate；webm 时长不可靠时的降级来源） */
  avgFps: number | null;
  /** 时长（秒；MediaRecorder 的 webm 无 Duration 元素时为 null） */
  durationSec: number | null;
}

/** 录像保存结果 */
export interface CaptureSaveResult {
  /** 落盘路径（userData/captures/...） */
  path: string;
  /** 本地视频服务器 HTTP URL（Remotion 渲染可用） */
  src: string;
  /** 文件名 */
  name: string;
  /** 鼠标轨迹 sidecar 落盘路径（仅整屏录制且采到轨迹时存在） */
  cursorTrackPath?: string;
  /** 实际帧率统计（仅录像；截图无此字段） */
  frameStats?: CaptureFrameStats;
}

/** 选区录制区域（视频像素坐标；width/height 即输出画面尺寸，均取偶数） */
export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 鼠标轨迹采样点（t=0 锚定 recorder.start() 时刻；x/y 为视频像素坐标） */
export interface CursorPoint {
  /** 距录制开始的毫秒数 */
  t: number;
  /** 视频像素坐标 X */
  x: number;
  /** 视频像素坐标 Y */
  y: number;
  /** 按下状态（声明式脚本合成的拖拽/按住期间为 true；真实录屏 sidecar 不含此字段） */
  down?: boolean;
}

/** 鼠标点击事件（t 与轨迹同一零点；x/y 为视频像素坐标） */
export interface CursorClick {
  /** 距录制开始的毫秒数 */
  t: number;
  /** 视频像素坐标 X */
  x: number;
  /** 视频像素坐标 Y */
  y: number;
  /** 按键：1 左键 / 2 右键 / 3 中键（uiohook 约定） */
  button: number;
}

/** 声明式动作事件（cursorScript 合成轨迹专属；真实录屏只采轨迹与点击）：滚动/打字等
 *  非点击动作的视觉事件，模板层在光标附近渲染滚轮箭头/打字气泡 */
export interface CursorActionEvent {
  /** 距录制开始的毫秒数 */
  t: number;
  kind: 'scroll' | 'type';
  /** scroll：滚轮格数（正 = 向下滚，负 = 向上滚） */
  ticks?: number;
  /** type：输入文本 */
  text?: string;
  /** 事件视觉时长（ms） */
  durMs: number;
}

/** 全局输入钩子原始事件（主进程 → 渲染端）：物理像素坐标 + 墙钟时间，渲染端负责换算与锚定 */
export interface InputHookEvent {
  /** Date.now() 墙钟毫秒（与渲染端 recordStartWall 同一时钟） */
  wallTime: number;
  /** 物理像素坐标 X（uiohook 事件原始坐标系，= DIP × scaleFactor） */
  x: number;
  /** 物理像素坐标 Y */
  y: number;
  /** 按键：1 左键 / 2 右键 / 3 中键 */
  button: number;
}

/** 窗口矩形时间戳采样（窗口录制用；物理像素全局坐标） */
export interface WindowRectSample {
  /** 距录制开始的毫秒数（与轨迹同一零点） */
  t: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 鼠标轨迹 sidecar 文件结构（与录像同目录的 <同名>.cursor.json） */
export interface CursorTrackFile {
  /** v1 = 仅移动轨迹；v2 = 附带点击事件与窗口矩形序列（读取端两个版本都接受） */
  version: 1 | 2;
  /** 被录显示器 id（窗口录制 = 窗口中心所在显示器，仅供回退参考） */
  displayId: number;
  /** 录像宽度（被录屏物理像素 / 窗口内容像素） */
  videoWidth: number;
  /** 录像高度（被录屏物理像素 / 窗口内容像素） */
  videoHeight: number;
  points: CursorPoint[];
  /** 点击事件（v2 起；v1 文件无此字段） */
  clicks?: CursorClick[];
  /** 录制源类型（缺省 = screen；window = 应用窗口录制） */
  sourceKind?: 'screen' | 'window';
  /** 窗口矩形序列（仅窗口录制；坐标换算的历史依据，物理像素） */
  windowRects?: WindowRectSample[];
}

/** 光标轮询结果（CAPTURE_CURSOR_POLL）：主进程返回 DIP 坐标与各屏布局，渲染端据此换算视频像素 */
export interface CursorPollResult {
  /** 光标位置（DIP，全局桌面坐标系） */
  x: number;
  y: number;
  /** 光标当前所在显示器 id */
  displayId: number;
  /** 全部显示器的布局（DIP 原点 + 缩放比） */
  displays: {id: number; x: number; y: number; scaleFactor: number}[];
  /** 窗口矩形（物理像素；仅请求带 hwnd 时返回；最小化/已关闭为 null） */
  windowRect?: {x: number; y: number; w: number; h: number} | null;
}

/**
 * DIP 坐标 → 视频像素坐标（纯函数，供渲染端轨迹采集与单元测试共用）。
 * 屏幕源按物理像素录制：视频像素 = (DIP - 屏原点) × scaleFactor。
 * 选区录制时传 region（选区的视频像素矩形）：坐标改锚定选区原点；
 * 光标在选区外时钳制在选区边缘（轨迹钉在边缘，不跑出裁剪画面）。
 */
export const dipToVideoPoint = (
  dipX: number,
  dipY: number,
  display: {x: number; y: number; scaleFactor: number},
  region?: {x: number; y: number; width: number; height: number},
): {x: number; y: number} => {
  const px = (dipX - display.x) * display.scaleFactor;
  const py = (dipY - display.y) * display.scaleFactor;
  if (!region) {
    return {x: Math.round(px), y: Math.round(py)};
  }
  return {
    x: Math.round(Math.max(0, Math.min(region.width, px - region.x))),
    y: Math.round(Math.max(0, Math.min(region.height, py - region.y))),
  };
};

/**
 * 降采样输出尺寸（纯函数，渲染端录制与单元测试共用）：
 * maxHeight 未给/源不高于上限时返回 null（不缩放，直录原流）；
 * 否则等比缩小（高度=上限、宽同比例，均取偶数，编码器友好）。
 */
export const computeOutputSize = (
  nativeWidth: number,
  nativeHeight: number,
  maxHeight?: number,
): {width: number; height: number} | null => {
  if (!maxHeight || !(nativeWidth > 0) || !(nativeHeight > 0) || nativeHeight <= maxHeight) return null;
  const evenFloor = (v: number): number => Math.max(2, Math.floor(v / 2) * 2);
  const height = evenFloor(maxHeight);
  return {width: evenFloor((nativeWidth * height) / nativeHeight), height};
};

/** 码率估算（纯函数）：以 1920×1080@30=8Mbps 为基准按像素×帧率等比折算，钳在 2-8；显式指定则直接用 */
export const estimateBitrateMbps = (width: number, height: number, fps: number, explicit?: number): number => {
  if (explicit && explicit > 0) return explicit;
  const ratio = (width * height * (fps || 30)) / (1920 * 1080 * 30);
  return Math.min(8, Math.max(2, Math.round(8 * ratio * 10) / 10));
};

/** 截屏结果（在保存结果上附加预览/多模态看图用 data URL 与落盘尺寸） */
export interface CaptureScreenshotResult extends CaptureSaveResult {
  /** 预览用 JPEG data URL（最长边 ~1280；落盘文件为原始尺寸 PNG） */
  dataUrl: string;
  /** 落盘 PNG 宽度（像素） */
  width: number;
  /** 落盘 PNG 高度（像素） */
  height: number;
}

/** 元素截图的裁剪区域（CSS 像素，来自 getBoundingClientRect；scale 为输出分辨率倍率） */
export interface ElementClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 输出分辨率倍率（通常取 devicePixelRatio，透明 PNG 更清晰） */
  scale: number;
}
