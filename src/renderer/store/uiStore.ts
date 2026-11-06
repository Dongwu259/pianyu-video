/**
 * UI 工作区状态（与工程数据分离，不入历史快照、不入 .vtproj）。
 *
 * 故事板编辑器的可调工作区：面板尺寸（左编辑宽 / 顶部高）+ 各面板显隐。
 * - 持久化到 localStorage，跨会话保留用户偏好的工作区布局。
 * - resetWorkspace 回到推荐默认工作区。
 * - 视图菜单（native）通过 togglePanel / setPanels 同步面板显隐与复选状态。
 *
 * 时间轴整片监视器（P2.5 v4）：浮窗几何（宽度 / 面板内坐标）与右侧预览模式
 * （片段 ↔ 全片）也是编辑页 UI 偏好，随工作区一起持久化、不入工程。
 */

import {create} from 'zustand';

const STORAGE_KEY = 'vt-workspace-v2';

export interface WorkspacePanels {
  bgm: boolean;       // 声音面板（背景音乐 + 音效设计）
  brand: boolean;     // 风格面板（Logo / 字幕样式 / 画面质感 / BGM 避让）
  timeline: boolean;  // 故事板片段时间轴
  editor: boolean;    // 左侧编辑面板（视频/文字/样式/…）
  preview: boolean;   // 右侧预览
}

/** 浮动监视器在时间轴面板内的坐标（null = 默认右上锚定，跟随面板右缘） */
export interface MonitorPos {
  left: number;
  top: number;
}

/** 推荐默认工作区 */
export const DEFAULT_WORKSPACE = {
  leftWidth: 480, // 8 个编辑标签页需要的宽度（更窄时标签自动换行，不再截断「字幕」）
  topHeight: 240, // 卡片轨单行 + 头部控件可换行；时间轴视图切换时会再自动撑高
  panels: {bgm: true, brand: true, timeline: true, editor: true, preview: true} as WorkspacePanels,
};

/** 监视器浮窗宽度钳制（等比缩放，高度由画幅比例跟随） */
export const MONITOR_MIN_W = 200;
export const MONITOR_MAX_W = 640;

interface WorkspaceSnapshot {
  leftWidth: number;
  topHeight: number;
  panels: WorkspacePanels;
  monitorWidth: number;
  monitorPos: MonitorPos | null;
  rightPreview: 'segment' | 'full';
}

const clampMonitorWidth = (w: number): number =>
  Math.max(MONITOR_MIN_W, Math.min(MONITOR_MAX_W, Math.round(w)));

const load = (): WorkspaceSnapshot => {
  const clampAll = (s: WorkspaceSnapshot): WorkspaceSnapshot => {
    const caps = viewportCaps();
    return {
      ...s,
      leftWidth: Math.max(240, Math.min(caps.maxLeft, s.leftWidth)),
      topHeight: Math.max(120, Math.min(caps.maxTop, s.topHeight)),
      monitorWidth: clampMonitorWidth(s.monitorWidth),
      rightPreview: s.rightPreview === 'full' ? 'full' : 'segment',
    };
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
      return clampAll({
        leftWidth: parsed.leftWidth ?? DEFAULT_WORKSPACE.leftWidth,
        topHeight: parsed.topHeight ?? DEFAULT_WORKSPACE.topHeight,
        panels: {...DEFAULT_WORKSPACE.panels, ...(parsed.panels || {})},
        monitorWidth: parsed.monitorWidth ?? 320,
        monitorPos:
          parsed.monitorPos && Number.isFinite(parsed.monitorPos.left) && Number.isFinite(parsed.monitorPos.top)
            ? {left: Math.max(0, parsed.monitorPos.left), top: Math.max(0, parsed.monitorPos.top)}
            : null,
        rightPreview: parsed.rightPreview ?? 'segment',
      });
    }
  } catch {
    // 损坏的存储忽略
  }
  return {
    leftWidth: DEFAULT_WORKSPACE.leftWidth,
    topHeight: DEFAULT_WORKSPACE.topHeight,
    panels: {...DEFAULT_WORKSPACE.panels},
    monitorWidth: 320,
    monitorPos: null,
    rightPreview: 'segment',
  };
};

const persist = (s: WorkspaceSnapshot) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 隐私模式等写入失败忽略
  }
};

/**
 * 工作区尺寸的实时视口上限：分隔条拖拽与持久化恢复共用，
 * 保证编辑区/预览区/故事板再怎么拖也不会把区域推出窗口外（最大化只是窗口恰好够大）。
 */
const viewportCaps = (): {maxLeft: number; maxTop: number} => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  return {
    maxLeft: Math.max(280, Math.min(760, vw - 420)), // 右侧预览至少留 420px
    maxTop: Math.max(160, Math.min(720, vh - 430)), // 下方编辑区 + 状态栏至少留 430px
  };
};

interface UIState {
  leftWidth: number;
  topHeight: number;
  panels: WorkspacePanels;
  setLeftWidth: (w: number) => void;
  setTopHeight: (h: number) => void;
  /** 按增量调整左编辑宽（读取最新值，供 Splitter 拖拽增量回调） */
  adjustLeftWidth: (delta: number) => void;
  /** 按增量调整顶部高（同上） */
  adjustTopHeight: (delta: number) => void;
  togglePanel: (key: keyof WorkspacePanels) => void;
  setPanels: (p: WorkspacePanels) => void;
  resetWorkspace: () => void;
  /** 底部状态栏文字（如「加载中…」「就绪」「已自动保存 12:30」）；null = 就绪 */
  statusText: string | null;
  setStatusText: (t: string | null) => void;

  // ---- 时间轴整片监视器（编辑页 UI 偏好）----
  /** 浮动小窗开关（停靠到右侧大窗时置 false，取消停靠按 monitorReopen 恢复） */
  monitorOpen: boolean;
  /** 浮窗宽度（高度按画幅比例跟随，等比缩放） */
  monitorWidth: number;
  /** 浮窗在时间轴面板内的坐标；null = 默认右上锚定 */
  monitorPos: MonitorPos | null;
  /** 右侧预览模式：片段预览 / 全片预览（时间轴监视器停靠态） */
  rightPreview: 'segment' | 'full';
  /** 停靠前小窗是否开着（取消停靠时据此恢复小窗） */
  monitorReopen: boolean;
  setMonitorOpen: (open: boolean) => void;
  setMonitorWidth: (w: number) => void;
  setMonitorPos: (pos: MonitorPos | null) => void;
  /** 停靠（浮窗拖到右侧预览区 / 下拉切「全片预览」）与取消停靠的统一入口 */
  dockMonitor: () => void;
  undockMonitor: () => void;
}

export const useUIStore = create<UIState>((set, get) => {
  const init = load();
  const snapshot = (): WorkspaceSnapshot => ({
    leftWidth: get().leftWidth,
    topHeight: get().topHeight,
    panels: get().panels,
    monitorWidth: get().monitorWidth,
    monitorPos: get().monitorPos,
    rightPreview: get().rightPreview,
  });
  const persistSnapshot = () => persist(snapshot());
  return {
    leftWidth: init.leftWidth,
    topHeight: init.topHeight,
    panels: init.panels,
    setLeftWidth: (w) => {
      const leftWidth = Math.max(240, Math.min(760, w));
      set({leftWidth});
      persistSnapshot();
    },
    setTopHeight: (h) => {
      const topHeight = Math.max(120, Math.min(720, h));
      set({topHeight});
      persistSnapshot();
    },
    adjustLeftWidth: (delta) => {
      // 按实时窗口钳制（写死的 240-760 在非最大化窗口会把预览区推出窗外）
      const caps = viewportCaps();
      const leftWidth = Math.max(240, Math.min(caps.maxLeft, get().leftWidth + delta));
      set({leftWidth});
      persistSnapshot();
    },
    adjustTopHeight: (delta) => {
      const caps = viewportCaps();
      const topHeight = Math.max(120, Math.min(caps.maxTop, get().topHeight + delta));
      set({topHeight});
      persistSnapshot();
    },
    togglePanel: (key) => {
      const panels = {...get().panels, [key]: !get().panels[key]};
      set({panels});
      persistSnapshot();
    },
    setPanels: (panels) => {
      set({panels});
      persistSnapshot();
    },
    resetWorkspace: () => {
      set({leftWidth: DEFAULT_WORKSPACE.leftWidth, topHeight: DEFAULT_WORKSPACE.topHeight, panels: {...DEFAULT_WORKSPACE.panels}});
      persistSnapshot();
    },
    statusText: null,
    setStatusText: (statusText) => set({statusText}),

    monitorOpen: false,
    monitorWidth: init.monitorWidth,
    monitorPos: init.monitorPos,
    rightPreview: init.rightPreview,
    monitorReopen: false,
    setMonitorOpen: (monitorOpen) => set({monitorOpen}),
    setMonitorWidth: (w) => {
      const monitorWidth = clampMonitorWidth(w);
      if (monitorWidth === get().monitorWidth) return;
      set({monitorWidth});
      persistSnapshot();
    },
    setMonitorPos: (monitorPos) => {
      set({monitorPos});
      persistSnapshot();
    },
    dockMonitor: () => {
      // 记住停靠前小窗态（开着才需要恢复），关浮窗、右栏切全片
      set({monitorReopen: get().monitorOpen, monitorOpen: false, rightPreview: 'full'});
    },
    undockMonitor: () => {
      set({rightPreview: 'segment'});
      if (get().monitorReopen) set({monitorOpen: true});
      set({monitorReopen: false});
    },
  };
});
