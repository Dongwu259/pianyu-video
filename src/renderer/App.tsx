/**
 * 应用根组件 - 故事板模式
 *
 * 新流程:
 * Step 1: 选择方向 + 模板
 * Step 2: 故事板编辑器（核心页面）
 * Step 3: 渲染导出
 *
 * 顶部导航含：步骤按钮 + 设置 + 关于
 */

import React, {useState, useEffect} from 'react';
import {useProjectStore, consumeSuppressDirty, consumeSuppressHistory, takeSnapshot} from './store/projectStore';
import {useUIStore} from './store/uiStore';
import type {HistorySnapshot, HistorySource} from './store/historyUtils';
import {snapshotsEqual, trackedRefsUnchanged, trackedContentDirty, consumeAgentOp, commandEpochAt} from './store/historyUtils';
import {StoryboardEditor} from './components/StoryboardEditor';
import {OrientationSelector} from './components/OrientationSelector';
import {RenderPanel} from './components/RenderPanel';
import {AboutModal} from './components/AboutModal';
import {WhatsNewModal} from './components/WhatsNewModal';
import {WHATS_NEW_STORAGE_KEY, shouldShowWhatsNew} from './whats-new';
/** 新手教程「已看过」标记（首启自动播的控制键，与 What's New 的键同风格） */
const GUIDED_TOUR_STORAGE_KEY = 'pianyu.guidedTourSeen';
import {getWhatsNewForVersion} from './whats-new-content';
import {SettingsModal} from './components/SettingsModal';
import {ScreenRecorderModal} from './components/ScreenRecorderModal';
import {LicenseModal} from './components/LicenseModal';
import {LocalModelModal} from './components/LocalModelModal';
import {LOCAL_MODEL_DECISION_KEY} from '../shared/local-model';
import {CustomTemplateEditor} from './components/CustomTemplateEditor';
import {TemplateMarketModal} from './components/TemplateMarketModal';
import {ProjectMenu} from './components/ProjectMenu';
import {MissingMediaDialog} from './components/MissingMediaDialog';
import {AutosaveRestoreBanner} from './components/AutosaveRestoreBanner';
import {StatusBar} from './components/StatusBar';
import {AIAssistantPanel} from './components/AIAssistantPanel';
import {initMcpBridge} from './ai/mcpBridge';
import {RecordingIndicator} from './components/RecordingIndicator';
import {stopRecording, addCaptureToSegment} from './capture/screenCapture';
import {useCaptureStore} from './store/captureStore';
import {RenewalReminderBanner} from './components/RenewalReminderBanner';
import {GuidedTour} from './components/GuidedTour';
import {Palette, Settings, Info, KeyRound, Undo2, Redo2, Sparkles, CloudDownload} from 'lucide-react';
import {BrandIcon} from './components/BrandIcon';
import './styles/app.css';

/**
 * 退出前 dirty flush：自动保存开启且有未保存改动时，把当前工程落 autosave。
 * 真实踩坑：工程有改动但 30s 周期还没轮到就退出 → autosave 空窗，工作全丢。
 * 在 close-request 握手期间调用：渲染进程存活、主进程在等确认，invoke 异步写可靠；
 * 任何失败都不阻断退出。
 */
const flushAutosaveOnExit = async (): Promise<void> => {
  try {
    const s = useProjectStore.getState();
    if (!s.appSettings.autoSave || !s.isDirty) return;
    // 与 30s 周期同口径：序列化前同步工作副本，只改了当前片段内容也要能恢复
    s.syncCurrentToSegment();
    await window.api.autosaveProject(s.projectName, useProjectStore.getState().serializeProject());
  } catch {
    // flush 失败静默：退出优先
  }
};

export const App: React.FC = () => {
  const {step, setStep, syncCurrentToSegment, setAppSettings, loadCustomTemplates, loadMarketTemplates, loadGeneratedTemplates, refreshLicenseStatus} = useProjectStore();
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const canUndo = useProjectStore((s) => s.historyPast.length > 0);
  const canRedo = useProjectStore((s) => s.historyFuture.length > 0);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** 打开设置弹窗后滚动定位的分区（AI 面板「去设置一键接入」深链到 MCP 分区；页头按钮为 undefined 停顶部） */
  const [settingsSection, setSettingsSection] = useState<'ai' | 'mcp' | undefined>(undefined);
  const [showLicense, setShowLicense] = useState(false);
  const [showLocalModel, setShowLocalModel] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [showMarket, setShowMarket] = useState(false);
  /** 打开模板编辑器时直接编辑的自定义模板 id（从模板管理跳入） */
  const [editorInitialId, setEditorInitialId] = useState<string | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);
  /** 首页「只录屏」入口：纯录屏模式（录完存文件，不导入故事板） */
  const [showHomeRecorder, setShowHomeRecorder] = useState(false);
  /** 「What's New」弹窗显示的版本号（null = 不显示；值即运行时版本，用于标题与查日志） */
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  /** 新手引导教程（首启自动播放；关于页「重播新手教程」随时再看） */
  const [tourOpen, setTourOpen] = useState(false);

  // 通知主进程渲染端已挂载：主窗口以 show:false 启动（防白屏），
  // 主进程收到该信号才显示窗口并关闭启动画面（另有 12s 超时兜底，见 main/index.ts）
  useEffect(() => {
    window.api.appReady?.();
  }, []);

  // 新手教程：首次启动（localStorage 无已看标记）延迟 900ms 自动播放；
  // 完成或跳过时写标记，之后只在关于页手动重播。若 What's New 同场（如老用户升级）优先教程。
  useEffect(() => {
    let seen = true;
    try {
      seen = !!localStorage.getItem(GUIDED_TOUR_STORAGE_KEY);
    } catch {
      seen = true;
    }
    if (seen) return;
    const t = setTimeout(() => setTourOpen(true), 900);
    return () => clearTimeout(t);
  }, []);

  /** 关闭教程 = 完成/跳过：写「已看」标记（写失败不阻断） */
  const closeTour = () => {
    try {
      localStorage.setItem(GUIDED_TOUR_STORAGE_KEY, '1');
    } catch {
      // 隐私模式写失败：教程可能下次再弹一次，无伤大雅
    }
    setTourOpen(false);
  };

  // 「What's New」：升级后首次启动自动弹更新内容。localStorage 记录已看版本，
  // 与当前版本不一致（且该版本有日志数据）才弹；关闭时写入当前版本，同一版本只弹一次。
  // 首次启动（教程将自动播放）本次不弹，避免两个浮层叠加；下次启动版本仍有差异会弹。
  // 版本号获取失败则不打扰；dev / 打包同样生效，方便验证。
  useEffect(() => {
    if (!window.api?.getAppInfo) return;
    void window.api.getAppInfo().then((info) => {
      let seen: string | null = null;
      try {
        seen = localStorage.getItem(WHATS_NEW_STORAGE_KEY);
      } catch {
        seen = null;
      }
      let tourSeen = true;
      try {
        tourSeen = !!localStorage.getItem(GUIDED_TOUR_STORAGE_KEY);
      } catch {
        tourSeen = true;
      }
      if (tourSeen && shouldShowWhatsNew(seen, info.version) && getWhatsNewForVersion(info.version)) {
        setWhatsNewVersion(info.version);
      }
    }).catch(() => {
      // 获取版本失败：不显示弹窗
    });
  }, []);

  /** 手动打开「更新内容」（关于页入口）：取当前版本后弹出 */
  const openWhatsNew = () => {
    if (!window.api?.getAppInfo) return;
    void window.api.getAppInfo()
      .then((info) => setWhatsNewVersion(info.version))
      .catch(() => {});
  };

  /** 关闭「更新内容」：写入当前版本为已看（手动重看再关闭也无妨，本就是当前版本） */
  const closeWhatsNew = () => {
    if (whatsNewVersion) {
      try {
        localStorage.setItem(WHATS_NEW_STORAGE_KEY, whatsNewVersion);
      } catch {
        // 隐私模式等写失败：放弃「只弹一次」控制，不阻断关闭
      }
      setWhatsNewVersion(null);
    }
  };

  // 启动时加载持久化设置（默认输出目录等）、自定义模板、已装市场模板与授权状态到内存 store。
  // 期间状态栏显示「加载中…」，全部落定后回到「就绪」。
  useEffect(() => {
    const {setStatusText} = useUIStore.getState();
    setStatusText('加载中…');
    Promise.allSettled([
      window.api.getSettings().then((saved) => setAppSettings(saved)),
      loadCustomTemplates(),
      loadMarketTemplates(),
      loadGeneratedTemplates(),
      refreshLicenseStatus(),
    ]).finally(() => setStatusText(null));
  }, [setAppSettings, loadCustomTemplates, loadMarketTemplates, loadGeneratedTemplates, refreshLicenseStatus]);

  // 外观主题：跟随设置切换 <html data-theme>，CSS 变量随之整体换肤；
  // 「跟随系统」监听系统深浅色变化实时切换
  const theme = useProjectStore((s) => s.appSettings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // MCP 服务接口：订阅主进程转发的第三方 agent 工具调用（设置 → Agent 接入（MCP）开启后生效）
  useEffect(() => initMcpBridge(), []);

  // 片语本地模型：付费版启动且未做过下载决策时弹一次（首次激活的即时弹在 LicenseModal
  // onActivated；这里覆盖「已激活但一直没理睬」的用户。教程/更新弹窗优先——延迟 6s）
  useEffect(() => {
    if (licenseStatus?.entitlement !== 'licensed') return;
    let decided = true;
    try {decided = !!localStorage.getItem(LOCAL_MODEL_DECISION_KEY);} catch {decided = false;}
    if (decided) return;
    const timer = setTimeout(() => setShowLocalModel(true), 6000);
    return () => clearTimeout(timer);
  }, [licenseStatus?.entitlement]);

  // 代理转码事件回写：job 状态变化 → 工程内素材的 proxyPath/proxyStatus 落库
  // （import_segment_media/上传对话框入队的 mxf/超大/4K 代理转好后，抽帧/预览自动走代理）
  useEffect(() => {
    if (!window.api.onProxyProgress) return () => {};
    return window.api.onProxyProgress((e) => {
      const store = useProjectStore.getState();
      const touched = store.applyClipProxyByPath(e.sourcePath, e.proxyPath, e.status as 'queued' | 'transcoding' | 'ready' | 'failed');
      const {setStatusText} = useUIStore.getState();
      if (e.status === 'ready' && touched > 0) {
        setStatusText(`代理就绪：${e.sourcePath.split(/[\\/]/).pop() ?? ''}（编辑/预览已切代理）`);
      } else if (e.status === 'failed' && touched > 0) {
        setStatusText(`代理转码失败：${e.sourcePath.split(/[\\/]/).pop() ?? ''}（渲染不受影响，回源直渲）`);
      }
    });
  }, []);

  // 脏标记：监听工程内容变化（追踪清单见 historyUtils 的 DIRTY_TRACKED_KEYS，
  // 新增工程内容字段只改那一处）。引用变了再做内容判等——syncCurrentToSegment 等
  // 导航性同步每次都会产生新引用但内容不变，不应置脏；加载/新建工程通过
  // suppressNextDirty 豁免（干净基线），导航性工作副本重载由 loadSegmentToCurrent 自行豁免。
  useEffect(() => {
    const unsub = useProjectStore.subscribe((s, prev) => {
      if (s.isDirty) return;
      if (consumeSuppressDirty()) return;
      if (trackedContentDirty(s as unknown as Record<string, unknown>, prev as unknown as Record<string, unknown>)) {
        useProjectStore.setState({isDirty: true});
      }
    });
    return unsub;
  }, []);

  // 撤销历史采集：与脏标记订阅相互独立，监听快照字段（含当前片段工作副本，打字才能被记录）的引用变化，
  // 500ms 防抖把一串连续改动（打字、拖滑杆）合并为一条历史，记录的是这串改动「之前」的状态。
  // undo/redo/加载/新建通过 suppressNextHistory 豁免；引用变了但内容没变的伪改动（如切步骤时的整体同步）不入栈。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: HistorySnapshot | null = null;
    // 来源标（基建②）：本串改动的操作来源——首个变化时抓取（AI 工具打标/否则 user）
    let pendingMeta: {source: HistorySource; opName?: string} | null = null;
    // 命令纪元（M1.5）：pending 串捕获时的纪元；入史时纪元已变 = 串内跨过命令边界，
    // 整串让位（命令 before 快照已含未决改动，撤销语义=命令吸收本串，防时序倒挂）
    let pendingEpoch = 0;
    const clearPending = () => {
      pending = null;
      pendingMeta = null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const unsub = useProjectStore.subscribe((s, prev) => {
      // 追踪字段（HISTORY_TRACKED_KEYS）引用全部未变：快速跳过
      if (trackedRefsUnchanged(s as unknown as Record<string, unknown>, prev as unknown as Record<string, unknown>)) {
        return;
      }
      if (consumeSuppressHistory()) {
        // 被豁免的变化（undo/redo/加载/新建/命令作用域）会让待合并的旧快照失去意义，一并丢弃
        clearPending();
        return;
      }
      // 一串改动以最早的 prev 为「改动前」基线
      if (!pending) {
        pending = takeSnapshot(prev);
        const agent = consumeAgentOp();
        pendingMeta = agent ? {source: agent.source, opName: agent.opName} : {source: 'user'};
        pendingEpoch = commandEpochAt();
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const snap = pending;
        pending = null;
        if (snap && commandEpochAt() !== pendingEpoch) {
          // 本串被命令事务吸收（命令入史时自增纪元）——不再重复入史
          pendingMeta = null;
          return;
        }
        if (snap && !snapshotsEqual(snap, takeSnapshot(useProjectStore.getState()))) {
          // meta 只在此处附上（判等在无 meta 快照间进行，不被来源标污染）
          useProjectStore.getState().pushHistory({...snap, ...(pendingMeta ?? {source: 'user' as const})});
        }
        pendingMeta = null;
      }, 500);
    });
    return () => {
      clearPending();
      unsub();
    };
  }, []);

  // 自动保存：设置开启时每 30 秒检查一次，有未保存改动才静默写入 autosave.vtproj。
  // 通过 getState() 读取最新设置与脏标记，设置弹窗改动即时生效，无需重启定时器。
  useEffect(() => {
    const timer = setInterval(async () => {
      const s = useProjectStore.getState();
      if (!s.appSettings.autoSave || !s.isDirty) return;
      try {
        // 序列化前同步工作副本：只改了当前片段文案/素材时也要能恢复
        s.syncCurrentToSegment();
        const res = await window.api.autosaveProject(s.projectName, useProjectStore.getState().serializeProject());
        if (res?.success) {
          const d = new Date();
          useUIStore.getState().setStatusText(
            `已自动保存 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          );
        }
      } catch {
        // 自动保存失败静默跳过，下个周期重试
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 关窗拦截：主进程在收到 close 时转发到此，有未保存更改则确认后才放行；
  // 正在录屏时先停止并保存录像再放行（否则录制直接随窗口销毁，已录内容全丢）
  useEffect(() => {
    const off = window.api.onCloseRequest(() => {
      const cap = useCaptureStore.getState();
      if (cap.recording) {
        if (!window.confirm('正在录制屏幕。退出会先停止录制并保存本次录像（随后加入当前片段），确定退出吗？')) {
          return; // 用户取消：什么都不做，窗口保持打开
        }
        void stopRecording()
          .then(async (saved) => {
            if (saved) {
              // 与 stop_screen_recording 同口径：录到的内容加入当前选中段，不静默丢弃
              try {
                await addCaptureToSegment(saved, useProjectStore.getState().activeSegmentIndex);
              } catch {
                // 入段失败不阻断退出（录像已落盘，路径在 saved.path）
              }
            }
            // 录像入段后的最新工程态一并落 autosave，再放行
            await flushAutosaveOnExit();
            return window.api.confirmClose();
          })
          .catch(() => {});
        return;
      }
      const s = useProjectStore.getState();
      if (!s.isDirty || window.confirm('当前工程有未保存的更改，确定退出吗？')) {
        // 先落 autosave 再放行（失败也不阻断退出）
        void flushAutosaveOnExit().finally(() => window.api.confirmClose().catch(() => {}));
      }
      // 用户取消：什么都不做，窗口保持打开
    });
    return off;
  }, []);

  // 退出 flush 兜底（beforeunload 同步通道）：主路径是上面的 close-request 握手 flush，
  // 这里兜住「视图菜单重新加载」等绕过握手的一切卸载——此时渲染进程随时销毁，
  // invoke 异步写不可靠，走 send 同步通道（主进程 writeFileSync 落盘）。
  // 内容与主路径相同，重复写无害；失败不阻断卸载。
  useEffect(() => {
    const onBeforeUnload = () => {
      try {
        const s = useProjectStore.getState();
        if (!s.appSettings.autoSave || !s.isDirty) return;
        s.syncCurrentToSegment();
        window.api.autosaveProjectSync(s.projectName, useProjectStore.getState().serializeProject());
      } catch {
        // 兜底失败不阻断卸载
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // 快捷键：Ctrl+S 保存 / Ctrl+Shift+S 另存为 / Ctrl+O 打开 / Ctrl+Z 撤销 / Ctrl+Shift+Z、Ctrl+Y 重做
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        if (e.shiftKey) {
          useProjectStore.getState().saveProjectAs();
        } else {
          useProjectStore.getState().saveProject();
        }
      } else if (key === 'o') {
        e.preventDefault();
        useProjectStore.getState().openProject();
      } else if (key === 'z' || key === 'y') {
        // 焦点在输入框 / 可编辑区域时不拦截，让浏览器原生文本撤销/重做生效
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        if (key === 'y' || e.shiftKey) {
          useProjectStore.getState().redo();
        } else {
          useProjectStore.getState().undo();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 应用菜单动作（中文菜单的 文件/关于/视图 项派发到此）
  useEffect(() => {
    const off = window.api.onMenuAction((action) => {
      const s = useProjectStore.getState();
      if (action === 'new') s.newProject();
      else if (action === 'open') s.openProject();
      else if (action === 'save') s.saveProject();
      else if (action === 'saveAs') s.saveProjectAs();
      else if (action === 'about') setShowAbout(true);
      else if (action.startsWith('toggle:')) {
        const key = action.slice('toggle:'.length) as keyof ReturnType<typeof useUIStore.getState>['panels'];
        useUIStore.getState().togglePanel(key);
        window.api.setMenuWorkspace(useUIStore.getState().panels);
      } else if (action === 'resetWorkspace') {
        useUIStore.getState().resetWorkspace();
        window.api.setMenuWorkspace(useUIStore.getState().panels);
      }
    });
    return off;
  }, []);

  // 启动时把持久化的工作区面板显隐同步给视图菜单复选项
  useEffect(() => {
    window.api.setMenuWorkspace(useUIStore.getState().panels);
  }, []);

  const steps = [
    {num: 1, label: '方向 & 模板', active: step === 1},
    {num: 2, label: '故事板编辑', active: step === 2},
    {num: 3, label: '渲染导出', active: step === 3},
  ];

  // 切换步骤前自动保存当前工作副本到故事板
  const handleStepChange = (targetStep: 1 | 2 | 3) => {
    if (targetStep !== step) {
      syncCurrentToSegment();
    }
    setStep(targetStep);
  };

  return (
    <div className="app">
      {/* 顶部导航 */}
      <header className="app-header">
        <div className="app-logo">
          <span className="logo-icon"><BrandIcon size={24} /></span>
          <span className="logo-text">片语</span>
        </div>
        <nav className="steps-nav">
          {steps.map((s, i) => (
            <React.Fragment key={s.num}>
              <button
                className={`step-item ${s.active ? 'active' : ''} ${step > s.num ? 'completed' : ''}`}
                onClick={() => handleStepChange(s.num as 1 | 2 | 3)}
              >
                <span className="step-num">{s.num}</span>
                <span className="step-label">{s.label}</span>
              </button>
              {i < steps.length - 1 && <span className="step-divider" />}
            </React.Fragment>
          ))}
        </nav>
        <div className="header-spacer" />
        <div className="header-actions">
          {/* 撤销 / 重做（禁用态置灰） */}
          <button
            className="btn-header"
            onClick={() => useProjectStore.getState().undo()}
            disabled={!canUndo}
            title="撤销 (Ctrl+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            className="btn-header"
            onClick={() => useProjectStore.getState().redo()}
            disabled={!canRedo}
            title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
          >
            <Redo2 size={14} />
          </button>
          <ProjectMenu />
          <button
            className={`btn-header ${showAiPanel ? 'active' : ''}`}
            onClick={() => setShowAiPanel((v) => !v)}
            title="AI 助手"
            data-tour="ai-btn"
          >
            <Sparkles size={14} /> AI 助手
          </button>
          <button className="btn-header" onClick={() => setShowTemplateEditor(true)}>
            <Palette size={14} /> 模板编辑器
          </button>
          <button className="btn-header" onClick={() => setShowMarket(true)} title="浏览/安装云端模板">
            <CloudDownload size={14} /> 模板市场
          </button>
          <button className="btn-header" onClick={() => setShowLicense(true)}>
            <KeyRound size={14} /> 授权
            {/* 免费版时显示琥珀色小圆点提示 */}
            {licenseStatus?.entitlement === 'free' && <span className="header-dot" />}
          </button>
          <button className="btn-header" onClick={() => setShowSettings(true)}>
            <Settings size={14} /> 设置
          </button>
          <button className="btn-header" onClick={() => setShowAbout(true)}>
            <Info size={14} /> 关于
          </button>
        </div>
      </header>

      {/* 主内容区 */}
      <main className="app-main">
        {step === 1 && <OrientationSelector onOpenAiPanel={() => setShowAiPanel(true)} onOpenRecorder={() => setShowHomeRecorder(true)} />}
        {step === 2 && <StoryboardEditor />}
        {step === 3 && <RenderPanel />}
      </main>

      {/* 底部状态栏（加载中/就绪/已自动保存/渲染进度/未保存标记） */}
      <StatusBar />

      {/* 弹窗 */}
      {showAbout && (
        <AboutModal
          onClose={() => setShowAbout(false)}
          onReplayTour={() => {
            setShowAbout(false);
            setTourOpen(true);
          }}
          onShowWhatsNew={() => {
            // 先关「关于」再弹「更新内容」，避免两个模态叠加
            setShowAbout(false);
            openWhatsNew();
          }}
        />
      )}
      {whatsNewVersion && <WhatsNewModal version={whatsNewVersion} onClose={closeWhatsNew} />}
      {showSettings && (
        <SettingsModal
          onClose={() => { setShowSettings(false); setSettingsSection(undefined); }}
          initialSection={settingsSection}
          onOpenLocalModel={() => setShowLocalModel(true)}
        />
      )}
      {showLicense && <LicenseModal onClose={() => setShowLicense(false)} onActivated={() => setShowLocalModel(true)} />}
      {showLocalModel && <LocalModelModal onClose={() => setShowLocalModel(false)} manual={false} />}
      {showTemplateEditor && (
        <CustomTemplateEditor
          onClose={() => { setShowTemplateEditor(false); setEditorInitialId(null); }}
          initialEditId={editorInitialId ?? undefined}
        />
      )}
      {showMarket && (
        <TemplateMarketModal
          onClose={() => setShowMarket(false)}
          onOpenEditor={(defId) => {
            setShowMarket(false);
            setEditorInitialId(defId ?? null);
            setShowTemplateEditor(true);
          }}
        />
      )}
      {/* 打开工程后若有缺失媒体则弹出提示（内部自行判断，无缺失时不渲染） */}
      <MissingMediaDialog />
      {/* 自动保存恢复横幅（非阻塞：检测到上次未保存工程时右下角浮出，恢复/忽略；
          不用同步 confirm——那会冻结渲染线程，把 MCP 桥的工具执行卡死到用户点掉弹窗） */}
      <AutosaveRestoreBanner />
      {/* AI 助手抽屉面板（「前往设置」直接打开设置弹窗并按分区定位，面板保持打开） */}
      {showAiPanel && (
        <AIAssistantPanel
          onClose={() => setShowAiPanel(false)}
          onOpenSettings={(section) => { setSettingsSection(section); setShowSettings(true); }}
        />
      )}
      {/* 首页「只录屏」：纯录屏模式弹窗（录完存文件不进故事板；录制本身工程无关，悬浮指示条全局可用） */}
      {showHomeRecorder && (
        <ScreenRecorderModal standalone onClose={() => setShowHomeRecorder(false)} />
      )}
      {/* 授权临期续费提醒横幅（内部按授权状态 + 24h 频率自行判断，不命中时不渲染） */}
      <RenewalReminderBanner />
      {/* 新手引导教程（首启自动 / 关于页重播；带做模式——打开示例工程/换素材/开 AI 面板真执行） */}
      <GuidedTour open={tourOpen} onClose={closeTour} onOpenAiPanel={() => setShowAiPanel(true)} />
      {/* 全局悬浮录制指示条（录制中任意页面可停止并保存） */}
      <RecordingIndicator />
    </div>
  );
};

export default App;
