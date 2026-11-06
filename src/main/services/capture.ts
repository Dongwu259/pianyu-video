/**
 * 屏幕录制 / 截屏 - 主进程服务
 *
 * 职责：
 * - 枚举可采集源（desktopCapturer：整个屏幕 + 单个应用窗口，带缩略图/窗口图标）
 * - 保存渲染端 MediaRecorder 产出的 webm 录像（userData/captures/recordings）
 * - 截屏：desktopCapturer 大尺寸缩略图 → PNG 落盘（userData/captures/screenshots）
 *
 * 说明：视频采集流在渲染端通过 getUserMedia(chromeMediaSource: 'desktop') 建立
 * （Electron 传统路径，无需用户手势，AI 助手可程序化调用），主进程只做枚举与落盘。
 * 截屏直接复用 desktopCapturer 的大尺寸缩略图，无需建立视频流，因此也没有手势限制。
 */

import {app, desktopCapturer, nativeImage, screen, session} from 'electron';
import path from 'path';
import fs from 'fs';
import {filePathToHttpUrl} from './videoServer';
import type {CaptureSourceInfo, CaptureSaveResult, CaptureScreenshotResult, CursorClick, CursorPoint, CursorPollResult, CursorTrackFile, ElementClipRect, InputHookEvent, WindowRectSample} from '../../shared/capture';

const getCapturesDir = (kind: 'recordings' | 'screenshots'): string => {
  const dir = path.join(app.getPath('userData'), 'captures', kind);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
};

const timestampName = (prefix: string, ext: string): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ext}`;
};

/** 屏幕显示器的物理像素尺寸（录屏按此请求满分辨率，截屏按此取全尺寸缩略图） */
const displayPhysicalSize = (disp: Electron.Display): {width: number; height: number} => ({
  width: Math.round(disp.size.width * disp.scaleFactor),
  height: Math.round(disp.size.height * disp.scaleFactor),
});

/**
 * 屏幕源 → 显示器。
 * display_id 优先（macOS/Linux 有值）；Windows 新版 Chromium 的屏幕源 display_id 为空字符串，
 * 回退按源 id 序号（screen:N:0）映射 screen.getAllDisplays()——两者同出 Chromium display 层，顺序一致。
 */
const resolveScreenDisplay = (s: Electron.DesktopCapturerSource): Electron.Display | undefined => {
  const displays = screen.getAllDisplays();
  if (s.display_id) {
    const byId = displays.find((d) => String(d.id) === s.display_id);
    if (byId) return byId;
  }
  const idx = Number(s.id.split(':')[1]);
  if (Number.isFinite(idx) && displays[idx]) return displays[idx];
  return displays[0];
};

/** 屏幕源反查显示器（截屏用）：按源 id 从枚举结果里定位后再 resolve */
const findDisplayForScreenSource = (sourceId: string, sources: Electron.DesktopCapturerSource[]): Electron.Display | undefined => {
  const src = sources.find((s) => s.id === sourceId);
  return src ? resolveScreenDisplay(src) : undefined;
};

/** 枚举可采集源（屏幕 + 应用窗口）。屏幕尺寸为物理像素；窗口尺寸系统不直接给，记 0 */
export const listCaptureSources = async (): Promise<CaptureSourceInfo[]> => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: {width: 480, height: 270},
    fetchWindowIcons: true,
  });
  return sources.map((s) => {
    const isScreen = s.id.startsWith('screen:');
    let width = 0;
    let height = 0;
    let displayId: number | undefined;
    if (isScreen) {
      const disp = resolveScreenDisplay(s);
      if (disp) {
        displayId = disp.id;
        const size = displayPhysicalSize(disp);
        width = size.width;
        height = size.height;
      }
    }
    return {
      id: s.id,
      name: s.name || (isScreen ? '屏幕' : '窗口'),
      kind: isScreen ? ('screen' as const) : ('window' as const),
      // 屏幕源透出真实 Display.id（源 id 的 screen:0:0 中间段是枚举序号，不可用于光标所在屏比较）
      ...(displayId !== undefined ? {displayId} : {}),
      width,
      height,
      thumbnailDataUrl: s.thumbnail.toDataURL(),
      appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
    };
  });
};

/** 保存录像（渲染端 MediaRecorder 的 webm 字节；附带鼠标轨迹时同目录写 <同名>.cursor.json sidecar） */
export const saveRecording = (bytes: ArrayBuffer, cursorTrack?: {displayId: number; points: CursorPoint[]; clicks?: CursorClick[]; videoWidth?: number; videoHeight?: number; sourceKind?: 'screen' | 'window'; windowRects?: WindowRectSample[]}): CaptureSaveResult => {
  const name = timestampName('rec', '.webm');
  const filePath = path.join(getCapturesDir('recordings'), name);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  let cursorTrackPath: string | undefined;
  if (cursorTrack && cursorTrack.points.length > 0) {
    // 轨迹点/点击已由渲染端换算成视频像素坐标，这里只做落盘；
    // 宽高优先取渲染端给的输出尺寸（选区录制 = 选区尺寸），缺省记被录屏物理像素
    const disp = screen.getAllDisplays().find((d) => d.id === cursorTrack.displayId);
    const size = disp ? displayPhysicalSize(disp) : {width: 0, height: 0};
    const trackFile: CursorTrackFile = {
      version: 2,
      displayId: cursorTrack.displayId,
      videoWidth: cursorTrack.videoWidth ?? size.width,
      videoHeight: cursorTrack.videoHeight ?? size.height,
      points: cursorTrack.points,
      ...(cursorTrack.clicks && cursorTrack.clicks.length > 0 ? {clicks: cursorTrack.clicks} : {}),
      ...(cursorTrack.sourceKind ? {sourceKind: cursorTrack.sourceKind} : {}),
      ...(cursorTrack.windowRects && cursorTrack.windowRects.length > 0 ? {windowRects: cursorTrack.windowRects} : {}),
    };
    cursorTrackPath = filePath.replace(/\.webm$/, '.cursor.json');
    fs.writeFileSync(cursorTrackPath, JSON.stringify(trackFile), 'utf8');
  }
  return {path: filePath, src: filePathToHttpUrl(filePath), name, ...(cursorTrackPath ? {cursorTrackPath} : {})};
};

/** 轮询光标位置（DIP）与各屏布局（渲染端录制期 30Hz 调用，自行换算视频像素坐标）。
 *  传入 hwnd（窗口录制）时附带该窗口的可见矩形（物理像素，DWMWA_EXTENDED_FRAME_BOUNDS）；
 *  窗口最小化/已关闭/原生模块不可用时 windowRect 为 null（渲染端按离屏钉点处理）。 */
export const pollCursor = (hwnd?: number): CursorPollResult => {
  const point = screen.getCursorScreenPoint();
  const nearest = screen.getDisplayNearestPoint(point);
  return {
    x: point.x,
    y: point.y,
    displayId: nearest.id,
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id,
      x: d.bounds.x,
      y: d.bounds.y,
      scaleFactor: d.scaleFactor,
    })),
    ...(typeof hwnd === 'number' && Number.isFinite(hwnd) ? {windowRect: getWindowFrameBounds(hwnd)} : {}),
  };
};

// ====== 窗口矩形查询（koffi → Win32，窗口录制轨迹用） ======

type KoffiLib = {
  struct: (name: string, fields: Record<string, string>) => unknown;
  pointer: (t: unknown) => unknown;
  out: (t: unknown) => unknown;
  load: (lib: string) => {func: (name: string, ret: string, args: unknown[]) => (...a: unknown[]) => unknown};
};
let koffiRef: KoffiLib | null | 'failed' = null;
let getWindowFrameBoundsImpl: ((hwnd: number) => {x: number; y: number; w: number; h: number} | null) | null = null;

/** 惰性初始化 koffi + DWM 绑定；失败置 'failed' 后不再重试（本进程内降级） */
const ensureWindowRectBinding = (): boolean => {
  if (koffiRef === 'failed') return false;
  if (koffiRef) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffiRef = require('koffi') as KoffiLib;
    const RECT = koffiRef.struct('RECT', {left: 'long', top: 'long', right: 'long', bottom: 'long'});
    const dwmapi = koffiRef.load('dwmapi.dll');
    const user32 = koffiRef.load('user32.dll');
    const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const DwmGetWindowAttribute = dwmapi.func('DwmGetWindowAttribute', 'long', ['uintptr_t', 'uint32', koffiRef.out(koffiRef.pointer(RECT)), 'uint32']);
    const GetWindowRect = user32.func('GetWindowRect', 'bool', ['uintptr_t', koffiRef.out(koffiRef.pointer(RECT))]);
    const IsIconic = user32.func('IsIconic', 'bool', ['uintptr_t']);
    const rectSize = 16; // 4 × long
    getWindowFrameBoundsImpl = (hwnd) => {
      try {
        if (IsIconic(hwnd)) return null; // 最小化时矩形无意义
        const rect = {left: 0, top: 0, right: 0, bottom: 0};
        // 优先 DWM 可见框（不含隐形缩放边框），失败回退 GetWindowRect
        const hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, rectSize);
        const ok = hr === 0 || GetWindowRect(hwnd, rect);
        if (!ok) return null;
        const w = rect.right - rect.left;
        const h = rect.bottom - rect.top;
        if (w <= 0 || h <= 0) return null;
        return {x: rect.left, y: rect.top, w, h};
      } catch {
        return null;
      }
    };
    return true;
  } catch (e) {
    console.warn('[capture] koffi/Win32 绑定不可用，窗口录制轨迹将不采集：', e instanceof Error ? e.message : e);
    koffiRef = 'failed';
    return false;
  }
};

/** 查询窗口可见矩形（物理像素全局坐标）；原生不可用/最小化/失败返回 null */
export const getWindowFrameBounds = (hwnd: number): {x: number; y: number; w: number; h: number} | null => {
  if (!ensureWindowRectBinding() || !getWindowFrameBoundsImpl) return null;
  return getWindowFrameBoundsImpl(hwnd);
};

/** 读取鼠标轨迹 sidecar JSON；文件缺失/损坏/版本不符一律返回 null（工程加载不因此阻断） */
export const readCursorTrack = (filePath: string): CursorTrackFile | null => {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CursorTrackFile | null;
    if (!obj || (obj.version !== 1 && obj.version !== 2) || !Array.isArray(obj.points)) return null;
    if (obj.clicks !== undefined && !Array.isArray(obj.clicks)) return null;
    return obj;
  } catch {
    return null;
  }
};

// ====== 全局输入钩子（录制期鼠标点击采集，uiohook-napi 原生模块） ======

/** 钩子运行态（同一时刻至多一轮录制，单例即可） */
let hookRunning = false;
let hookEvents: InputHookEvent[] = [];
type Uiohook = {
  on: (event: string, cb: (e: {x: number; y: number; button: number}) => void) => void;
  removeAllListeners: (event?: string) => void;
  start: () => void;
  stop: () => void;
};
let uiohookRef: Uiohook | null = null;

const hookListener = (e: {x: number; y: number; button: number}) => {
  // uiohook 事件坐标是物理像素；墙钟与渲染端 recordStartWall 同一 Date.now() 时钟
  hookEvents.push({wallTime: Date.now(), x: e.x, y: e.y, button: e.button});
};

/**
 * 启动全局鼠标点击钩子（仅 mousedown）。原生模块缺失/加载失败返回 false，
 * 调用方静默降级为「只录移动轨迹」。重复启动幂等（先清旧事件）。
 */
export const startInputHook = (): boolean => {
  try {
    if (!uiohookRef) {
      // 延迟加载：原生模块只在本函数首次调用时 require，启动主进程失败不影响其他功能
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      uiohookRef = require('uiohook-napi').uIOhook as Uiohook;
    }
    if (hookRunning) {
      hookEvents = [];
      return true;
    }
    hookEvents = [];
    uiohookRef.removeAllListeners('mousedown');
    uiohookRef.on('mousedown', hookListener);
    uiohookRef.start();
    hookRunning = true;
    return true;
  } catch (e) {
    console.warn('[capture] 输入钩子不可用，点击事件将不采集：', e instanceof Error ? e.message : e);
    hookRunning = false;
    return false;
  }
};

/** 停止钩子并返回本轮采到的点击事件（未运行返回空数组） */
export const stopInputHook = (): InputHookEvent[] => {
  if (!hookRunning || !uiohookRef) return [];
  try {
    uiohookRef.removeAllListeners('mousedown');
    uiohookRef.stop();
  } catch {
    /* 停止失败忽略，事件照常返回 */
  }
  hookRunning = false;
  const events = hookEvents;
  hookEvents = [];
  return events;
};

/** 下一次 getDisplayMedia 的目标源 id（渲染端发起前经 IPC 写入；getDisplayMedia 的 request 不携带 chromeMediaSourceId） */
let pendingDisplayMediaSourceId: string | null = null;

export const setPendingDisplayMediaSource = (sourceId: string | null): void => {
  pendingDisplayMediaSourceId = sourceId;
};

/**
 * getDisplayMedia 系统声音（loopback）支持（录屏弹窗「同时录制系统声音」手动路径）。
 * 设置 handler 后渲染端 getDisplayMedia 不再弹系统选择器，由这里按 pendingDisplayMediaSourceId
 * 匹配 video 源（缺省回退主屏），audio 固定请求 'loopback'（系统播放的声音）。
 * 平台不支持 loopback 时 Chromium 静默返回纯视频流，渲染端按无系统声音降级处理。
 */
export const setupDisplayMediaHandler = (): void => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({types: ['screen', 'window'], thumbnailSize: {width: 0, height: 0}})
      .then((sources) => {
        const source =
          (pendingDisplayMediaSourceId && sources.find((s) => s.id === pendingDisplayMediaSourceId)) ||
          sources.find((s) => s.id.startsWith('screen:')) ||
          sources[0];
        if (!source) {
          callback({});
          return;
        }
        callback({video: source, audio: 'loopback'});
      })
      .catch(() => callback({}));
  });
};

/**
 * 截取某源当前画面（缺省主屏）。
 * 落盘为源原始尺寸 PNG；另回一张最长边 1280 的 JPEG data URL 做 UI 预览 / LLM 多模态看图。
 * 窗口被最小化时系统只能给到空图，抛中文错误让调用方提示。
 */
export const captureScreenshot = async (sourceId?: string): Promise<CaptureScreenshotResult> => {
  // desktopCapturer 一次调用只接受统一 thumbnailSize：目标是屏幕时按其物理像素取，
  // 目标是窗口（或缺省主屏）时按主屏物理像素取（窗口图随系统缩放适配，足够清晰）。
  const primary = screen.getPrimaryDisplay();
  const primarySize = displayPhysicalSize(primary);

  // 先枚举（thumbSize 先按主屏；屏幕源确定目标显示器后若不同需按目标尺寸重取）
  let sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: primarySize,
    fetchWindowIcons: false,
  });

  // 屏幕源按真实 display_id 反查目标显示器；非主屏时用目标尺寸重新枚举取全尺寸缩略图
  const targetDisplay = sourceId?.startsWith('screen:') ? findDisplayForScreenSource(sourceId, sources) : undefined;
  if (targetDisplay && targetDisplay.id !== primary.id) {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: displayPhysicalSize(targetDisplay),
      fetchWindowIcons: false,
    });
  }

  const source = sourceId
    ? sources.find((s) => s.id === sourceId)
    : sources.find((s) => s.id.startsWith('screen:') && s.display_id === String(primary.id))
      ?? sources.find((s) => s.id.startsWith('screen:'))
      ?? sources[0];
  if (!source) throw new Error('未找到可截取的屏幕/窗口');
  if (source.thumbnail.isEmpty()) {
    throw new Error(
      source.id.startsWith('window:')
        ? '截取失败：目标窗口可能已最小化，请先还原窗口再试'
        : '截取失败：系统未返回画面',
    );
  }

  const img = source.thumbnail;
  const {width, height} = img.getSize();
  const name = timestampName('shot', '.png');
  const filePath = path.join(getCapturesDir('screenshots'), name);
  fs.writeFileSync(filePath, img.toPNG());

  // 预览/LLM 看图：最长边缩到 1280，JPEG 控体积（base64 注入对话上下文）
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const preview = scale < 1
    ? img.resize({width: Math.round(width * scale), height: Math.round(height * scale)})
    : img;
  return {
    path: filePath,
    src: filePathToHttpUrl(filePath),
    name,
    dataUrl: `data:image/jpeg;base64,${preview.toJPEG(72).toString('base64')}`,
    width,
    height,
  };
};

/**
 * 元素截图原图：CDP 截取调用方渲染页内的指定区域（不做落盘）。
 * 窗口是不透明的（Electron 默认），omitBackground 得不到真透明——透明由渲染端
 * 双底抠图完成（enterElementCaptureMode 白/黑两底各截一张 → matteTwoPass 解算 alpha），
 * 本函数只负责忠实取回某一底色的截图。
 */
export const captureElementRaw = async (
  wc: Electron.WebContents,
  clip: ElementClipRect,
): Promise<{data: string; width: number; height: number}> => {
  if (!clip || !(clip.width > 0) || !(clip.height > 0)) {
    throw new Error('元素区域无效（宽/高必须为正数）');
  }
  const dbg = wc.debugger;
  const wasAttached = dbg.isAttached();
  if (!wasAttached) {
    try {
      dbg.attach('1.3');
    } catch {
      throw new Error('无法附加调试器进行元素截图（DevTools 打开中？请关闭后重试）');
    }
  }
  try {
    await dbg.sendCommand('Page.enable');
    const shot = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      clip: {x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale || 1},
    })) as {data: string};
    if (!shot.data) throw new Error('截图为空');
    const img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    const {width, height} = img.getSize();
    return {data: shot.data, width, height};
  } finally {
    if (!wasAttached && dbg.isAttached()) dbg.detach();
  }
};

/** 元素抠图 PNG 落盘（渲染端双底抠图完成的字节）→ userData/captures/screenshots */
export const saveElementPng = (bytes: ArrayBuffer): CaptureSaveResult => {
  if (!bytes || !(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
    throw new Error('图片数据为空');
  }
  const name = timestampName('elem', '.png');
  const filePath = path.join(getCapturesDir('screenshots'), name);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return {path: filePath, src: filePathToHttpUrl(filePath), name};
};
