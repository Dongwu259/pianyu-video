/**
 * 录屏状态 store - 录屏弹窗 / 悬浮指示条 / AI 助手工具三方共享。
 *
 * 状态由 capture/screenCapture.ts 控制器写入，组件只读。
 * 录制不依赖任何组件存活（流与 MediaRecorder 是模块级单例），
 * 关闭弹窗不中断录制，悬浮指示条随时可停止。
 *
 * 另持有录制偏好与开关：
 * - 麦克风/系统声音增益（0~2，录制中可实时调整；localStorage 持久化，模式同 uiStore）
 * - 摄像头画中画开关 webcamOn（流由 screenCapture 模块级持有，cleanup 时复位 false）
 */

import {create} from 'zustand';

const GAINS_STORAGE_KEY = 'vt-capture-gains-v1';

/** 增益钳制到 0~2（0%~200%）；非法值回退 1（100%） */
const clampGain = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1);

const loadGains = (): {micGain: number; systemGain: number} => {
  try {
    const raw = localStorage.getItem(GAINS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{micGain: number; systemGain: number}>;
      return {micGain: clampGain(parsed.micGain ?? 1), systemGain: clampGain(parsed.systemGain ?? 1)};
    }
  } catch {
    // 损坏的存储忽略
  }
  return {micGain: 1, systemGain: 1};
};

const persistGains = (micGain: number, systemGain: number): void => {
  try {
    localStorage.setItem(GAINS_STORAGE_KEY, JSON.stringify({micGain, systemGain}));
  } catch {
    // 隐私模式等写入失败忽略
  }
};

export interface CaptureState {
  /** 是否正在录制 */
  recording: boolean;
  /** 正在录制的源名称（屏幕/窗口标题） */
  sourceName: string;
  /** 录制开始时间戳（ms），0 = 未录制 */
  startedAt: number;
  /** 已录时长（秒，控制器每 500ms 刷新） */
  elapsedSec: number;
  /** 本次录制是否含麦克风 */
  withMic: boolean;
  /** 本次录制是否含系统声音（loopback） */
  withSystemAudio: boolean;
  /** 摄像头画中画开关（勾选即开启摄像头；录制结束/放弃时复位 false） */
  webcamOn: boolean;
  /** 麦克风增益 0~2（100% = 1；持久化；录制中实时写入 GainNode） */
  micGain: number;
  /** 系统声音增益 0~2（同上） */
  systemGain: number;
  /** 纯录屏会话标记：本次录制只落盘不导入故事板（首页「只录屏」入口）。
      录制弹窗 / 悬浮指示条 / AI 工具三方共用——停止链路按此决定是否 addCaptureToSegment */
  standaloneMode: boolean;
  setMicGain: (v: number) => void;
  setSystemGain: (v: number) => void;
  setStandaloneMode: (v: boolean) => void;
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  recording: false,
  sourceName: '',
  startedAt: 0,
  elapsedSec: 0,
  withMic: false,
  withSystemAudio: false,
  webcamOn: false,
  standaloneMode: false,
  ...loadGains(),
  setMicGain: (v) => {
    const micGain = clampGain(v);
    set({micGain});
    persistGains(micGain, get().systemGain);
  },
  setSystemGain: (v) => {
    const systemGain = clampGain(v);
    set({systemGain});
    persistGains(get().micGain, systemGain);
  },
  setStandaloneMode: (v) => set({standaloneMode: v}),
}));
