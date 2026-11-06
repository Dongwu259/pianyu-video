/**
 * 开发环境 userData 隔离（必须在所有其它主进程模块之前 import）
 *
 * 为什么：electron-store（设置 / 激活态 / 自定义模板 / LLM key）和 autosave.vtproj
 * 都落在 app.getPath('userData')。dev（npm run dev）和打包版用同一个 app name
 * （promo-video-generator），共享同一个 userData 目录，导致 dev 的自动保存工程、
 * 激活态、设置污染打包版——打包版启动会弹「恢复未保存工程」、继承 dev 的激活。
 *
 * 解法：dev 用独立子目录 promo-video-generator-dev，与正式环境彻底隔离；默认放在
 * 系统 temp，规避受管 Windows 环境下 AppData 无写权限的问题。
 *
 * 时机：store 模块在 import 时就 new Store() 构造并读取 userData，所以 setPath 必须在
 * store import 之前执行——本文件要在 index.ts 的最前面 import。app.setPath('userData')
 * 在 app ready 之前调用是支持的。
 */
import {app} from 'electron';
import path from 'path';

if (!app.isPackaged) {
  // A fallback Vite port identifies a separate dev instance. Keep its store
  // isolated so a previous instance cannot lock the shared config.json.
  const rendererPort = (() => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (!rendererUrl) return '';
    try {
      return new URL(rendererUrl).port;
    } catch {
      return '';
    }
  })();
  const profileName = rendererPort && rendererPort !== '5173'
    ? `promo-video-generator-dev-${rendererPort}`
    : 'promo-video-generator-dev';
  // AppData may be read-only in managed Windows environments (and can fail
  // before the renderer has a chance to show a useful error). Keep dev state
  // isolated in the writable temp directory by default; callers can opt into a
  // persistent location with PIANYU_DEV_USER_DATA_DIR.
  const configuredRoot = process.env.PIANYU_DEV_USER_DATA_DIR?.trim();
  const root = configuredRoot || app.getPath('temp');
  app.setPath('userData', path.join(root, profileName));
}
