/**
 * Electron 主进程入口
 */

// 必须最先 import：开发环境 userData 隔离（在 store 构造前 setPath）
import './dev-userdata';

import {app, BrowserWindow, ipcMain, shell, Menu, protocol} from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {startVideoServer, stopVideoServer, getVideoServerPort} from './services/videoServer';
import {ProxyTranscodeService} from './services/proxyTranscode';
import {setProxyResolver} from './services/frameExtract';
import {setContactSheetProxyResolver} from './services/contactSheet';
import {IPC_CHANNELS} from '../shared/ipc-channels';
import {setupDisplayMediaHandler, listCaptureSources, pollCursor, startInputHook, stopInputHook} from './services/capture';
import {verifyIfNeeded, restoreLicenseIfMissing} from './services/license';
import {scheduleUsageReporting} from './services/usage';
import {initCrashReporter} from './services/crashReporter';
import {initUpdater} from './services/updater';
import {runRenderSample} from './services/renderSample';
import {getGlobalSettings} from './services/store';
import type {IpcCtx} from './ipc/ctx';
import {registerSettingsIpc} from './ipc/settings';
import {registerMediaIpc} from './ipc/media';
import {registerStabilizationIpc} from './ipc/stabilization';
import {registerGroundIpc} from './ipc/ground';
import {registerProjectIpc} from './ipc/project';
import {registerRenderIpc} from './ipc/render';
import {registerLicenseIpc} from './ipc/license';
import {registerCaptureIpc} from './ipc/capture';
import {registerAiIpc} from './ipc/ai';
import {registerCustomTemplatesIpc} from './ipc/templates';
import {registerTemplateGenIpc} from './ipc/templateGen';
import {registerAiChatIpc} from './ipc/aiChat';
import {registerMarketIpc} from './ipc/market';
import {registerMcpIpc, shutdownMcpServer, startMcpServerIfEnabled} from './ipc/mcp';
import {registerComputerUseIpc, shutdownComputerUse} from './ipc/computerUse';

// 开发渲染判定：electron-vite dev 会向主进程注入 ELECTRON_RENDERER_URL（preview / 打包不注入）。
// 不能按 !app.isPackaged 判定——electron-vite preview 同样未打包，若按此判定会去连 5173 dev
// server（没起就白屏）；preview 应加载 out/renderer 构建产物。
// PIANYU_FORCE_PROD=1：未打包进程也强制加载生产渲染（out/renderer），用于无 dev server 的端到端自检。
const devRendererUrl = !app.isPackaged && process.env.PIANYU_FORCE_PROD !== '1' ? process.env.ELECTRON_RENDERER_URL : undefined;
const isDev = !!devRendererUrl;

// local-video:// 需 fetch 能力：3D 模板预览（VideoScreenTexture 的 @remotion/media/mediabunny
// 管线）用 fetch() 拉媒体流做 WebCodecs 解码——自定义协议缺 supportFetchAPI 特权注册时
// fetch 直接 "Failed to fetch"（实测，scripts/local-video-fetch-probe.cjs），视频展板黑屏且
// 预览卡死。必须在 app ready 之前注册；不动 URL 形态（standard 不开，避免盘符被解析成 host）。
protocol.registerSchemesAsPrivileged([
  {scheme: 'local-video', privileges: {supportFetchAPI: true, corsEnabled: true, stream: true}},
]);

// 录屏链路诊断/端到端模式：独立 userData，避免与本机正在运行的 dev/生产实例共享 session 导致页面加载失败
if (process.env.CAPTURE_DIAG === '1' || process.env.CAPTURE_E2E === '1') {
  app.setPath('userData', path.join(app.getPath('temp'), 'pianyu-capture-diag'));
}

// RENDER_SAMPLE 脚本模式（官网样片渲染 + 打包渲染探测，见 services/renderSample.ts）：
// 设置后主进程不创建窗口，渲染示例工程到指定 mp4 后按成败退出。
const renderSampleOut = process.env.RENDER_SAMPLE || '';

// 崩溃上报（opt-in，默认关闭；仅生产构建 + 设置开启时发送，静默失败，见 services/crashReporter.ts）
// 脚本模式跳过崩溃上报初始化（无窗口、进程短时运行，上报无意义）
const reportCrash = renderSampleOut ? () => {} : initCrashReporter(getGlobalSettings);

// 主进程异常兜底：未捕获异常只记录不杀进程（默认行为是直接退出，用户未保存工作全丢）
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err);
  reportCrash('uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[Main] unhandledRejection:', err);
  reportCrash('unhandledRejection', err);
});

// 禁用 GPU 沙箱（某些 Windows 环境下需要）
app.commandLine.appendSwitch('disable-gpu-sandbox');

let mainWindow: BrowserWindow | null = null;
/** 渲染进程确认后才允许真正关窗（见 app:close-request / app:confirm-close） */
let allowClose = false;

// ====== 启动画面与主窗口延迟显示 ======
// 背景：渲染端 bundle 大、React 挂载慢，主窗口立即显示会白屏 3-4 秒。
// 方案：splash 在 whenReady 里尽早创建（视频服务器等 await 之前）兜底首屏反馈；
// 主窗口 show:false 起步，渲染端挂载完成发 app:ready 信号后才显示。

/** 启动画面窗口（无边框透明小窗，仅首次启动创建） */
let splashWin: BrowserWindow | null = null;
/** 启动画面只出现一次：渲染进程崩溃重建窗口时不再弹出（避免二次打扰） */
let splashUsed = false;
/** 当前主窗口是否已显示（app:ready / 12s 超时 / did-fail-load 任一触发后置 true） */
let mainWindowRevealed = false;
/** 显示兜底定时器：12 秒未收到渲染端就绪信号也强制显示，防卡死 */
let revealTimer: NodeJS.Timeout | null = null;

/**
 * 启动画面 HTML：品牌渐变底（紫 #A855F7 → 靛 #6366F1）+ 白色分段播放三角
 *（与 server/public/icon.svg 同组图形，去掉底色 rect，viewBox 调整到白色图形区域）
 * + 名称/slogan + 纯 CSS 呼吸圆点。inline data: URL 加载，不依赖任何外部文件（dev/prod 通用）。
 */
const SPLASH_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif; }
  .card {
    width: 400px; height: 240px; border-radius: 24px;
    background: linear-gradient(135deg, #A855F7 0%, #6366F1 100%);
    box-shadow: 0 12px 32px rgba(99, 102, 241, 0.4);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #fff; user-select: none; cursor: default;
    animation: fade-in 0.45s ease-out;
  }
  @keyframes fade-in { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: none; } }
  .logo { width: 72px; height: 67px; filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.18)); }
  .name { margin-top: 14px; font-size: 26px; font-weight: 700; letter-spacing: 6px; text-indent: 6px; }
  .slogan { margin-top: 8px; font-size: 12px; opacity: 0.85; letter-spacing: 1px; }
  .dots { display: flex; gap: 8px; margin-top: 22px; }
  .dots span { width: 7px; height: 7px; border-radius: 50%; background: #fff; animation: breathe 1.2s ease-in-out infinite; }
  .dots span:nth-child(2) { animation-delay: 0.18s; }
  .dots span:nth-child(3) { animation-delay: 0.36s; }
  @keyframes breathe { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
</style>
</head>
<body>
  <div class="card">
    <svg class="logo" viewBox="370 286 482 448" xmlns="http://www.w3.org/2000/svg">
      <g fill="#FFFFFF">
        <polygon points="380,300 602.3,424 380,424"/>
        <polygon points="380,450 648.9,450 760,512 648.9,574 380,574"/>
        <polygon points="380,600 602.3,600 380,724"/>
        <polygon points="790,378 801.1,418.9 842,430 801.1,441.1 790,482 778.9,441.1 738,430 778.9,418.9" fill-opacity="0.92"/>
        <polygon points="720,296 725.1,314.9 744,320 725.1,325.1 720,344 714.9,325.1 696,320 714.9,314.9" fill-opacity="0.8"/>
      </g>
    </svg>
    <div class="name">片语</div>
    <div class="slogan">AI 全自动视频制作 · 一句话出片</div>
    <div class="dots"><span></span><span></span><span></span></div>
  </div>
</body>
</html>`;

/** 关闭启动画面（destroy 前判 isDestroyed；splash 是独立窗口，不挂主窗口那套关窗确认逻辑） */
const destroySplash = () => {
  if (splashWin && !splashWin.isDestroyed()) splashWin.destroy();
  splashWin = null;
};

/** 显示主窗口并关闭启动画面。幂等：app:ready / 12s 超时 / did-fail-load 都会走到 */
const revealMainWindow = () => {
  if (mainWindowRevealed) return;
  mainWindowRevealed = true;
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = null;
  }
  destroySplash();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
};

/** 创建启动画面：无边框透明小窗 + inline data: URL HTML（base64 编码中文，不依赖外部文件） */
const createSplashWindow = () => {
  if (splashUsed) return; // 只首次启动出现；崩溃重建的窗口不再弹
  splashUsed = true;
  splashWin = new BrowserWindow({
    width: 460,
    height: 300,
    // Windows 下 transparent 必须搭配 frame:false 才生效
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    backgroundColor: '#00000000',
    webPreferences: {
      // 纯静态内容：不需要 preload / node 能力
      sandbox: true,
    },
  });
  splashWin.setMenu(null);
  splashWin.on('closed', () => {
    splashWin = null;
  });
  void splashWin.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(SPLASH_HTML).toString('base64')}`);
};

/** 菜单动作派发到渲染进程（文件/关于等需要项目状态的自定义项） */
const sendMenuAction = (action: string) => {
  mainWindow?.webContents.send('menu:action', action);
};

/** 工作区面板显隐（视图菜单复选项同步用；由渲染进程 setMenuWorkspace 推送） */
let workspacePanels: Record<string, boolean> = {bgm: true, brand: true, timeline: true, editor: true, preview: true};

/** 中文本地化应用菜单（替换 Electron 默认英文菜单） */
const setupMenu = () => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {label: '新建工程', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new')},
        {label: '打开工程…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('open')},
        {label: '保存工程', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save')},
        {label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('saveAs')},
        {type: 'separator'},
        {role: 'quit', label: '退出'},
      ],
    },
    {
      label: '编辑',
      submenu: [
        {role: 'undo', label: '撤销', accelerator: 'CmdOrCtrl+Z'},
        {role: 'redo', label: '重做', accelerator: 'CmdOrCtrl+Shift+Z'},
        {type: 'separator'},
        {role: 'cut', label: '剪切'},
        {role: 'copy', label: '复制'},
        {role: 'paste', label: '粘贴'},
        {role: 'selectAll', label: '全选'},
      ],
    },
    {
      label: '视图',
      submenu: [
        {role: 'reload', label: '重新加载'},
        {role: 'forceReload', label: '强制重新加载'},
        // 开发者工具仅开发环境可见：生产环境保留会降低 self-XSS 门槛
        ...(isDev ? [{role: 'toggleDevTools', label: '开发者工具'} as Electron.MenuItemConstructorOptions] : []),
        {type: 'separator'},
        {role: 'resetZoom', label: '重置缩放'},
        {role: 'zoomIn', label: '放大'},
        {role: 'zoomOut', label: '缩小'},
        {type: 'separator'},
        {role: 'togglefullscreen', label: '全屏'},
        {type: 'separator'},
        {type: 'checkbox', label: '声音面板', checked: workspacePanels.bgm, click: () => sendMenuAction('toggle:bgm')},
        {type: 'checkbox', label: '风格面板', checked: workspacePanels.brand, click: () => sendMenuAction('toggle:brand')},
        {type: 'checkbox', label: '故事板时间轴', checked: workspacePanels.timeline, click: () => sendMenuAction('toggle:timeline')},
        {type: 'checkbox', label: '左侧编辑面板', checked: workspacePanels.editor, click: () => sendMenuAction('toggle:editor')},
        {type: 'checkbox', label: '右侧预览面板', checked: workspacePanels.preview, click: () => sendMenuAction('toggle:preview')},
        {type: 'separator'},
        {label: '重置默认工作区', click: () => sendMenuAction('resetWorkspace')},
      ],
    },
    {
      label: '窗口',
      submenu: [
        {role: 'minimize', label: '最小化'},
        {role: 'close', label: '关闭'},
      ],
    },
    {
      label: '帮助',
      submenu: [
        {label: '关于片语', click: () => sendMenuAction('about')},
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const createWindow = () => {
  // 每次建窗（含崩溃重建）都回到「等待渲染端就绪」状态
  mainWindowRevealed = false;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: '片语',
    backgroundColor: '#ffffff',
    // 先隐藏：渲染端 bundle 大、挂载慢，立即显示会白屏数秒；
    // 等渲染端 app:ready 信号（或 12s 兜底）再 revealMainWindow
    show: false,
    icon: isDev ? path.join(__dirname, '../../resources/icons/icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 安全说明: webSecurity:false 是为了让 http://127.0.0.1 本地视频服务器和
      // local-video:// 自定义协议能加载本地视频文件。代价是禁用了同源策略。
      // 本应用仅加载本地资源和本地 HTTP 服务器，不加载任何外部 CDN，风险可接受。
      webSecurity: false,
    },
  });

  // 录屏链路自检：CAPTURE_DIAG=1 启动时跑一轮诊断（主进程直调服务 + 渲染进程全链路），
  // 结果打主进程终端。用于定位轨迹/点击采集断点，不进正常启动路径。
  if (process.env.CAPTURE_DIAG === '1') {
    // 主进程半边：枚举源（有无片语窗口）/ displayId 解析与比较 / 钩子启停 / 光标轮询
    setTimeout(() => {
      void (async () => {
        try {
          const srcs = await listCaptureSources();
          console.log('[DIAG:main] sources:', JSON.stringify(srcs.map((s) => `${s.id}|${s.kind}|${s.name}`)));
          console.log('[DIAG:main] selfWindowPianyu:', srcs.some((s) => s.name === '片语'));
          const scr = srcs.find((s) => s.kind === 'screen');
          const poll = pollCursor();
          if (scr) {
            const real = scr.displayId ?? Number(scr.id.split(':')[1]);
            console.log('[DIAG:main] screenId:', scr.id, '| source.displayId:', scr.displayId, '| poll.displayId:', poll.displayId, '| equal:', real === poll.displayId);
            console.log('[DIAG:main] poll.displays:', JSON.stringify(poll.displays));
          }
          console.log('[DIAG:main] hookStart:', startInputHook());
          console.log('[DIAG:main] hookStopEvents:', stopInputHook().length);
        } catch (e) {
          console.error('[DIAG:main] 失败:', e);
        }
      })();
    }, 4000);
    // 渲染端全链路（window.api IPC + setInterval 节流实测 + 模拟轨迹采集）：
    // 盲等 8s 让页面就绪后直接执行（did-finish-load 在共享 userData 冲突场景下可能不触发）
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`(async () => {
        const r = {};
        try {
          r.apiKeys = typeof window.api === 'object' ? ['captureListSources','capturePollCursor','captureStartInputHook'].map((k) => k + ':' + typeof window.api[k]) : 'no-window.api';
          const srcs = await window.api.captureListSources();
          r.selfWindow = srcs.some((s) => s.name === '片语');
          r.hookStart = await window.api.captureStartInputHook();
          await window.api.captureStopInputHook();
          const poll = await window.api.capturePollCursor();
          r.pollOk = Number.isFinite(poll.displayId) && Array.isArray(poll.displays);
          r.timerMs10ticks = await new Promise((res) => {
            const t0 = performance.now(); let n = 0;
            const t = setInterval(() => { if (++n >= 10) { clearInterval(t); res(Math.round(performance.now() - t0)); } }, 33);
          });
          r.trackSim = await (async () => {
            const screen = srcs.find((s) => s.kind === 'screen');
            if (!screen) return 'no-screen-source';
            const displayId = screen.displayId ?? Number(screen.id.split(':')[1]);
            const pts = [];
            const t0 = performance.now();
            await new Promise((res) => {
              const t = setInterval(() => {
                window.api.capturePollCursor().then((cur) => {
                  if (cur.displayId !== displayId) return;
                  pts.push('ok');
                }).catch((e) => pts.push('err:' + (e && e.message)));
                if (performance.now() - t0 > 1000) { clearInterval(t); res(); }
              }, 33);
            });
            return {screenId: screen.id, displayId, samples: pts.length, first: pts[0] || 'none'};
          })();
        } catch (e) { r.fatal = String(e && e.message || e); }
        return '[DIAG:renderer] ' + JSON.stringify(r);
      })()`).then((out) => console.log(out)).catch((e) => console.error('[DIAG:renderer] 执行失败:', e));
    }, 8000);
  }

  // 录屏端到端自检：CAPTURE_E2E=1 时 DOM 驱动一次真实录制（首页下一步 → 录屏弹窗 → 开始 →
  // SendInput 注入两次左键点击 → 停止保存），校验 savedNote 时长与 sidecar 的 points/clicks。
  if (process.env.CAPTURE_E2E === '1') {
    const e2eSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const simulateClicks = () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');
        const SendInput = user32.func('SendInput', 'uint32', ['uint32', 'void*', 'int']);
        // INPUT(x64)=40B：type@0 + pad@4；MOUSEINPUT：dx@8 dy@12 mouseData@16 dwFlags@20 time@24 dwExtraInfo@28
        const buf = (flags: number) => {
          const b = Buffer.alloc(40);
          b.writeUInt32LE(flags, 20);
          return b;
        };
        for (let i = 0; i < 2; i++) {
          SendInput(1, buf(0x0002), 40); // LEFTDOWN
          SendInput(1, buf(0x0004), 40); // LEFTUP
          const until = Date.now() + 350;
          while (Date.now() < until) { /* 间隔 */ }
        }
        console.log('[E2E] SendInput 注入 2 次左键点击');
      } catch (e) {
        console.error('[E2E] SendInput 失败:', e);
      }
    };
    setTimeout(() => {
      void (async () => {
        const wc = mainWindow?.webContents;
        if (!wc) return;
        const js = (code: string): Promise<unknown> => wc.executeJavaScript(code);
        try {
          // vite 冷启动 transform 可能很慢：轮询等 React 渲染出按钮再驱动（最多 30s）
          let ready = false;
          for (let i = 0; i < 60; i++) {
            const n = await js(`document.querySelectorAll('button').length`);
            if (typeof n === 'number' && n > 3) {
              ready = true;
              break;
            }
            await e2eSleep(500);
          }
          console.log('[E2E] 页面就绪:', ready);
          if (!ready) throw new Error('页面 30s 内未渲染出按钮');
          console.log('[E2E] 下一步:', await js(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('下一步'));
            if (b) { b.click(); return 'clicked'; }
            return 'missing | btns: ' + [...document.querySelectorAll('button')].map((x) => x.textContent.trim()).slice(0, 12).join(' | ');
          })()`));
          await e2eSleep(900);
          console.log('[E2E] 录屏弹窗:', await js(`(() => {
            const b = document.querySelector('.btn-record-entry');
            if (b) { b.click(); return 'opened'; }
            return 'missing-entry';
          })()`));
          await e2eSleep(1800);
          console.log('[E2E] 开始录制:', await js(`(() => {
            const b = [...document.querySelectorAll('.capture-modal button')].find((x) => x.textContent.includes('开始录制'));
            if (b && !b.disabled) { b.click(); return 'clicked'; }
            return 'missing | modal btns: ' + [...document.querySelectorAll('.capture-modal button')].map((x) => x.textContent.trim()).join(' | ');
          })()`));
          await e2eSleep(1500);
          simulateClicks();
          await e2eSleep(1800);
          console.log('[E2E] 停止:', await js(`(() => {
            const b = [...document.querySelectorAll('.capture-modal button')].find((x) => x.textContent.includes('停止并保存'));
            if (b && !b.disabled) { b.click(); return 'clicked'; }
            return 'missing-stop';
          })()`));
          await e2eSleep(4000);
          console.log('[E2E] 保存结果:', await js(`(document.querySelector('.capture-saved span') || {}).textContent || (document.querySelector('.capture-error') || {}).textContent || '（无提示）'`));
          const dir = path.join(app.getPath('userData'), 'captures', 'recordings');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.cursor.json')) : [];
          for (const f of files) {
            const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            console.log(`[E2E] sidecar: ${f} points=${o.points?.length} clicks=${JSON.stringify(o.clicks || [])}`);
          }
          if (files.length === 0) console.log('[E2E] sidecar: 无（轨迹采集仍失败）');
        } catch (e) {
          console.error('[E2E] 失败:', e);
        }
        console.log('[E2E] done');
        setTimeout(() => app.exit(0), 400);
      })();
    }, 9000);
  }

  // 开发模式加载 Vite dev server（URL 以 electron-vite 注入的为准，端口被占时会变），生产模式加载构建产物
  if (devRendererUrl) {
    mainWindow.loadURL(devRendererUrl);
    // 不自动打开 DevTools：其前端初始化时会请求本版 Chromium 未实现的 Autofill CDP 域，
    // 在控制台刷 'Autofill.enable' wasn't found 红色噪音（无害但吓人）。
    // 需要调试时用菜单「开发者工具」或 F12 手动打开。
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // 就绪再显示：渲染端 React 挂载完成后经 preload 发 app:ready 信号（见下方 ipcMain.on）；
  // 12 秒未收到信号强制显示（防卡死），加载失败也显示（露出错误页便于排查）
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(revealMainWindow, 12_000);
  mainWindow.webContents.on('did-fail-load', () => revealMainWindow());

  // 关窗拦截：转发给渲染进程确认（有未保存更改时由用户决定），确认后走 app:confirm-close
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow?.webContents.send('app:close-request');
  });

  mainWindow.on('closed', () => {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    mainWindow = null;
  });

  // 渲染进程崩溃：关窗确认已无法执行，直接销毁并重建窗口，避免白屏卡死
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[App] 渲染进程异常退出:', details);
    reportCrash('render-process-gone', details);
    allowClose = true;
    const win = mainWindow;
    mainWindow = null;
    win?.destroy();
    createWindow();
  });

  // 渲染进程不允许自开窗口：http(s) 链接转系统浏览器，其余一律拒绝
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return {action: 'deny'};
  });

  // 禁止导航离开应用页面（dev 只允许 vite server（以注入 URL 为准），生产只允许本地文件）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = devRendererUrl ? url.startsWith(devRendererUrl) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
};

// 注册自定义协议 local-video:// 来提供视频文件（最高效）
// 在 app.ready 之后注册
const registerCustomProtocol = () => {
  protocol.registerStreamProtocol('local-video', (request, callback) => {
    // 整个处理器必须无异常逸出：协议回调里的同步异常会击穿主进程
    try {
      // 解析 URL 中的文件路径
      // 支持两种格式:
      // 1. local-video://D:/path/to/video.mp4 (直接路径)
      // 2. local-video://http://127.0.0.1:port/video?path=... (HTTP URL 编码在协议中)
      let urlPath = request.url.replace(/^local-video:\/\/\/?/, '');

      let filePath: string;

      // 检测是否为嵌套的 HTTP URL
      if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
        // 从 HTTP URL 的 path 参数中提取原始文件路径
        // 注意：searchParams.get 已解码一次，不能再 decodeURIComponent（含 % 的文件名会抛 URIError）
        try {
          const innerUrl = new URL(urlPath);
          filePath = innerUrl.searchParams.get('path') || '';
        } catch {
          filePath = '';
        }
      } else {
        // 直接路径格式: D:/xxx → D:\xxx
        filePath = urlPath;
        if (filePath.match(/^[A-Za-z]:/)) {
          filePath = filePath.replace(/\//g, '\\');
        }
      }

      // 检查文件是否存在
      // 有 ready 代理（mxf/超大/4K）优先回代理：预览立刻可播（mxf Chromium 解不动），
      // Log 代理已是恢复色；无代理 = 原文件（普通素材零开销）
      const readPath = proxyService ? proxyService.resolveForRead(filePath) : filePath;
      if (!fs.existsSync(readPath)) {
        console.error(`[local-video] 文件不存在: ${filePath}`);
        callback({statusCode: 404, data: undefined});
        return;
      }
      // Range 基于实际读的文件（代理与源大小不同）
      filePath = readPath;

      // 获取文件 MIME 类型
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        // 3D 模型（three.js GLTFLoader）
        '.glb': 'model/gltf-binary',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';

      // statSync 与 existsSync 之间有 TOCTOU 窗口，必须 try-catch
      let fileSize: number;
      try {
        fileSize = fs.statSync(filePath).size;
      } catch {
        callback({statusCode: 404, data: undefined});
        return;
      }

      // 处理 Range 请求（视频拖动需要）；非法 Range 返回 416
      const range = request.headers.Range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
          callback({statusCode: 416, headers: {'Content-Range': `bytes */${fileSize}`}, data: undefined});
          return;
        }
        const safeEnd = Math.min(end, fileSize - 1);
        const chunksize = safeEnd - start + 1;
        callback({
          statusCode: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(chunksize),
            'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            // CORS：fetch 拉流（@remotion/media）与 crossOrigin 图像加载的通行证
            'Access-Control-Allow-Origin': '*',
          },
          data: fs.createReadStream(filePath, {start, end: safeEnd}),
        });
      } else {
        callback({
          statusCode: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          },
          data: fs.createReadStream(filePath),
        });
      }
    } catch (err) {
      console.error('[local-video] 处理器异常:', err);
      callback({statusCode: 500, data: undefined});
    }
  });
};

app.whenReady().then(async () => {
  // RENDER_SAMPLE 脚本模式（early branch）：只渲染示例工程，跳过临时文件清理、
  // 授权恢复、自定义协议、菜单、窗口、自动更新等全部 GUI 初始化，渲染完按退出码退出
  if (renderSampleOut) {
    app.exit(await runRenderSample(renderSampleOut));
    return;
  }

  // 启动画面尽早创建：随后的临时文件清理、视频服务器、授权恢复都是 await，
  // 主窗口又要等渲染端就绪才显示，先给用户即时首屏反馈（不再白屏 3-4 秒）
  createSplashWindow();

  // 清理遗留的转码/渲染临时文件（超过 24h）：崩溃/强退会留下它们，不清理会无限膨胀
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const dirName of ['promo-transcode', 'promo-render']) {
      const dir = path.join(os.tmpdir(), dirName);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        try {
          const fp = path.join(dir, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch {
          // 单文件失败不影响其余
        }
      }
    }
    // 孤儿 Remotion bundle 目录：bundle() 每次打包写入 tmpdir/remotion-webpack-bundle-*，
    // Remotion 不回收（曾累积 249 个 ×69MB 把磁盘顶满，诱发渲染期 Chrome "Failed to fetch"
    // 低磁盘拒绝）。1h 窗口保证当前/并行实例的产物不被误删。
    const bundleCutoff = Date.now() - 60 * 60 * 1000;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('remotion-webpack-bundle-')) continue;
      try {
        const fp = path.join(os.tmpdir(), name);
        const st = fs.statSync(fp);
        if (st.isDirectory() && st.mtimeMs < bundleCutoff) fs.rmSync(fp, {recursive: true, force: true});
      } catch {
        // 单目录失败不影响其余
      }
    }
  } catch {
    // 清理失败不影响启动
  }

  // 启动本地视频 HTTP 服务器（Remotion 渲染需要 http:// 而非 file://）
  try {
    await startVideoServer();
    console.log(`[App] 视频服务器端口: ${getVideoServerPort()}`);
  } catch (err) {
    console.warn('[App] 视频服务器启动失败:', err);
  }

  // 代理转码服务（mxf/超大/4K 素材后台 960 宽代理；Log 素材烧入技术转换 LUT）。
  // 抽帧（setProxyResolver）/ local-video 预览协议 / 导入链路共享此单例。
  const lutDirCandidates = [
    path.join(process.cwd(), 'resources', 'luts'),
    path.join(__dirname, '../../', 'resources', 'luts'),
  ];
  const lutDir = lutDirCandidates.find((d) => fs.existsSync(d)) ?? lutDirCandidates[0];
  proxyService = new ProxyTranscodeService({
    cacheDir: path.join(app.getPath('userData'), 'proxies'),
    lutDir,
    onEvent: (e) => {
      // job 状态变化推送渲染进程（素材卡进度/缩略图刷新/store 补写 proxyPath）
      try {
        mainWindow?.webContents.send(IPC_CHANNELS.PROXY_PROGRESS, e);
      } catch {
        // 窗口销毁瞬间发送失败可忽略
      }
    },
  });
  setProxyResolver((p) => proxyService!.resolveForRead(p));
  setContactSheetProxyResolver((p) => proxyService!.resolveForRead(p));

  // 启动时优先从持久凭证（注册表）恢复授权：userData 被删/重装时免重输码（异步，不阻塞主进程）
  await restoreLicenseIfMissing();

  // 授权滑动续期校验（超过 7 天未校验才发起请求；非阻塞，离线静默跳过）
  verifyIfNeeded().catch((err) => console.warn('[License] 启动校验失败:', err));

  // 本地模型运行时自启：权重与 llama.cpp 引擎齐备时拉起 llama-server 并接线 AI 设置
  // （装好即用，不随窗口开关起落；失败静默——弹窗检测会给出红灯与重试入口）
  void (async () => {
    try {
      const {isWeightsReady} = await import('./services/localModel');
      const {ensureRuntimeStarted, autoConfigureAiSettings} = await import('./services/localRuntime');
      const {getGlobalSettings, getLlmApiKeyEncrypted, setGlobalSettings} = await import('./services/store');
      const {setLlmApiKey} = await import('./services/llm');
      if (!isWeightsReady(app.getPath('userData'))) return;
      const port = await ensureRuntimeStarted(app.getPath('userData'));
      const settings = getGlobalSettings();
      const patch = autoConfigureAiSettings(port, {llmBaseUrl: settings.llmBaseUrl, llmModel: settings.llmModel});
      if (patch) {
        setGlobalSettings({...settings, ...patch});
        if (!getLlmApiKeyEncrypted()) setLlmApiKey('pianyu-local');
        console.log(`[LocalRuntime] AI 设置已接线 ${patch.llmBaseUrl} / ${patch.llmModel}`);
      }
    } catch (err) {
      console.warn('[LocalRuntime] 自启失败（弹窗内可重试）:', err instanceof Error ? err.message : err);
    }
  })();

  // 匿名用量统计调度：立即尝试一次 + 之后每 6h 尝试（24h 间隔/开关/静默失败均在内部处理）
  scheduleUsageReporting();

  // 注册自定义协议（必须在 createWindow 之前）
  registerCustomProtocol();

  // 中文应用菜单（替换 Electron 默认英文菜单）
  setupMenu();
  // 视图菜单面板复选项同步：渲染进程推送最新显隐状态，重建菜单复选
  ipcMain.handle('menu:setWorkspace', (_, p: Record<string, boolean>) => {
    workspacePanels = {...workspacePanels, ...p};
    setupMenu();
  });

  createWindow();

  // 自动更新：仅 NSIS 直链版生效（dev 与商店 appx 包在 updater 内部门禁）
  if (mainWindow) initUpdater(mainWindow);

  // getDisplayMedia 系统声音（loopback）handler：录屏弹窗「同时录制系统声音」手动路径用
  //（getUserMedia 传统路径不经过这里，AI 工具发起录制不受影响）
  setupDisplayMediaHandler();

  // MCP 服务接口：设置里启用过则随启动拉起（仅 127.0.0.1 + Bearer token，见 ipc/mcp.ts）
  startMcpServerIfEnabled(ipcCtx).catch((err) => console.warn('[MCP] 启动失败:', err));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出时关闭本地视频服务器，释放端口
app.on('before-quit', () => {
  // 启动画面若还在（极端情况：未收到就绪信号就退出）一并销毁，保证进程能正常退
  destroySplash();
  stopVideoServer();
  void shutdownMcpServer();
  shutdownComputerUse();
  void import('./services/localRuntime').then((m) => m.shutdownRuntime());
});

// ====== IPC 处理函数（按域拆分至 ./ipc/，此处组装注册）======

// 代理转码服务单例（app.ready 后于主初始化流程构造；此前为 null，IPC 层判空降级）
let proxyService: ProxyTranscodeService | null = null;

// ctx.proxyService 用 getter 延迟求值：组装时服务尚未构造（app.ready 流程里才建）
const ipcCtx: IpcCtx = {getMainWindow: () => mainWindow, isDev};
Object.defineProperty(ipcCtx, 'proxyService', {get: () => proxyService ?? undefined, configurable: true});
registerSettingsIpc(ipcCtx);
registerMediaIpc(ipcCtx);
registerStabilizationIpc(ipcCtx);
registerGroundIpc(ipcCtx);
registerProjectIpc(ipcCtx);
registerRenderIpc(ipcCtx);
registerLicenseIpc();
registerCaptureIpc();
registerAiIpc();
registerCustomTemplatesIpc(ipcCtx);
registerTemplateGenIpc(ipcCtx);
registerAiChatIpc(ipcCtx);
registerMarketIpc(ipcCtx);
registerMcpIpc(ipcCtx);
registerComputerUseIpc();

// 渲染进程确认关窗（配合 createWindow 的 close 拦截）
ipcMain.handle('app:confirm-close', () => {
  allowClose = true;
  mainWindow?.close();
});

// 渲染端 React 挂载完成 → 显示主窗口并关闭启动画面。
// 校验 sender：渲染进程崩溃重建后，旧窗口迟到的信号不应误触发新窗口的 reveal
ipcMain.on('app:ready', (e) => {
  if (mainWindow && e.sender === mainWindow.webContents) revealMainWindow();
});

// 应用信息（渲染端按 isPackaged 隐藏仅开发用的设置项；windowsStore 用于隐藏自动更新入口）
ipcMain.handle('app:get-info', () => {
  return {isPackaged: app.isPackaged, version: app.getVersion(), windowsStore: !!process.windowsStore};
});
