/**
 * 屏幕录制 / 截屏 IPC
 */

import {ipcMain} from 'electron';
import fs from 'node:fs';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import {parseUiRegionsJson} from '../../shared/ui-regions';
import {listCaptureSources, saveRecording, captureScreenshot, captureElementRaw, saveElementPng, setPendingDisplayMediaSource, pollCursor, readCursorTrack, startInputHook, stopInputHook} from '../services/capture';
import {getVideoFrameStats} from '../services/ffprobe';
import {trackCapture} from '../services/usage';
import type {CursorClick, CursorPoint, ElementClipRect, WindowRectSample} from '../../shared/capture';

export const registerCaptureIpc = () => {
  // 枚举可采集源（整个屏幕 + 应用窗口，带缩略图/窗口图标）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_LIST_SOURCES, async () => {
    return listCaptureSources();
  });

  // 保存录屏（渲染端 MediaRecorder 的 webm 字节）到 userData/captures/recordings；
  // 附带 cursorTrack 时同目录写 <同名>.cursor.json sidecar；
  // 落盘后用 ffprobe 探测实际帧率统计（nb_frames/avg_frame_rate，帧率不足警告的数据源）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_SAVE_RECORDING, async (_, bytes: ArrayBuffer, cursorTrack?: {displayId: number; points: CursorPoint[]; clicks?: CursorClick[]; videoWidth?: number; videoHeight?: number; sourceKind?: 'screen' | 'window'; windowRects?: WindowRectSample[]}) => {
    if (!bytes || !(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
      throw new Error('录制数据为空');
    }
    const result = saveRecording(bytes, cursorTrack);
    // 帧率统计失败返回全 null，不阻断保存
    const frameStats = await getVideoFrameStats(result.path);
    // 匿名用量统计：落盘成功才计数（track 内部静默容错）
    trackCapture();
    return {...result, frameStats};
  });

  // 截取某源当前画面（缺省主屏）；窗口最小化等失败以中文 Error 抛回渲染进程
  ipcMain.handle(IPC_CHANNELS.CAPTURE_SCREENSHOT, async (_, sourceId?: string) => {
    const result = await captureScreenshot(sourceId);
    // 匿名用量统计：截图落盘成功才计数（track 内部静默容错）
    trackCapture();
    return result;
  });

  // 设置下一次 getDisplayMedia 的目标源 id（系统声音录制路径，handler 据此匹配 video 源）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_SET_DISPLAY_MEDIA_SOURCE, async (_, sourceId: string | null) => {
    setPendingDisplayMediaSource(sourceId ?? null);
  });

  // 元素截图：截取调用方渲染页内的指定 DOM 区域原图（不落盘；透明抠图由渲染端双底法完成）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_ELEMENT, async (event, clip: ElementClipRect) => {
    return captureElementRaw(event.sender, clip);
  });

  // 元素抠图 PNG 落盘（渲染端双底抠图完成的字节）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_SAVE_ELEMENT, async (_, bytes: ArrayBuffer) => {
    const result = saveElementPng(bytes);
    // 匿名用量统计：落盘成功才计数（track 内部静默容错）
    trackCapture();
    return result;
  });

  // 轮询光标位置（DIP）与各屏布局（录制期鼠标轨迹采集）；带 hwnd 时附窗口矩形（窗口录制轨迹）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_CURSOR_POLL, async (_, hwnd?: number) => {
    return pollCursor(typeof hwnd === 'number' && Number.isFinite(hwnd) ? hwnd : undefined);
  });

  // 读取鼠标轨迹 sidecar JSON；缺失/损坏/版本不符返回 null
  ipcMain.handle(IPC_CHANNELS.CAPTURE_READ_CURSOR_TRACK, async (_, filePath: string) => {
    return typeof filePath === 'string' && filePath ? readCursorTrack(filePath) : null;
  });

  // 读取 UI 区域 sidecar JSON（拆层飞出）；缺失/损坏/结构不符返回 null
  ipcMain.handle(IPC_CHANNELS.UI_REGIONS_READ, async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return null;
    try {
      return parseUiRegionsJson(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  });

  // 全局鼠标点击钩子（录制期点击采集）：原生模块不可用返回 false，调用方静默降级
  ipcMain.handle(IPC_CHANNELS.CAPTURE_INPUT_HOOK_START, async () => {
    return startInputHook();
  });

  // 停止点击钩子并返回本轮事件（物理像素坐标 + 墙钟时间，渲染端负责换算锚定）
  ipcMain.handle(IPC_CHANNELS.CAPTURE_INPUT_HOOK_STOP, async () => {
    return stopInputHook();
  });
};
