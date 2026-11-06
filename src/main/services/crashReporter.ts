/**
 * 崩溃上报（主进程，opt-in）
 *
 * 隐私约束（与隐私政策「崩溃报告」条款一致）：
 * - 默认关闭：仅当设置 crashReporting === true 且为生产构建（app.isPackaged）时才发送
 * - 内容仅：应用版本号、系统平台/架构、错误类型、错误信息与堆栈前 3 行
 *   （路径中的用户名/home 目录已脱敏）；绝不含文件内容、工程数据、激活码
 *
 * 可靠性约束：崩溃上报永远不能影响主流程 —— 5s 超时、任何异常静默吞掉，
 * 上报模块自身绝不能成为新的崩溃源。
 *
 * 服务端接收端见 server/src/routes/crashReport.ts。
 */

import os from 'os';
import {app} from 'electron';
import {getServerBaseUrl} from './license';

/** 崩溃类型（与服务端 CRASH_KINDS 一一对应） */
export type CrashKind = 'uncaughtException' | 'unhandledRejection' | 'render-process-gone';

/** 上报请求超时：崩溃现场不宜久等 */
const REPORT_TIMEOUT_MS = 5000;

/** 去 PII：路径中的用户名/home 目录脱敏（如 C:\Users\<name> → C:\Users\***） */
const scrubPii = (text: string): string => {
  let out = text;
  // 当前用户 home 目录精确替换（覆盖 OneDrive 等非常规 home）
  const home = os.homedir();
  if (home) out = out.split(home).join('<home>');
  // 通用用户名路径模式（含其他用户目录、正斜杠写法）
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s:]+/g, '$1***'); // Windows
  out = out.replace(/\/home\/[^/\s:]+/g, '/home/***'); // Linux
  out = out.replace(/\/Users\/[^/\s:]+/g, '/Users/***'); // macOS
  return out;
};

/** 从异常对象/任意 rejection 值提取错误信息与堆栈前 3 行 */
const extract = (detail: unknown): {message: string; stackTop: string} => {
  if (detail instanceof Error) {
    const stack = typeof detail.stack === 'string' ? detail.stack : '';
    return {message: detail.message || String(detail), stackTop: stack.split('\n').slice(0, 3).join('\n')};
  }
  // render-process-gone 的 details 对象（{reason, exitCode}）/ 非 Error 的 rejection 值
  let text: string;
  try {
    text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    text = String(detail);
  }
  return {message: text || 'unknown', stackTop: ''};
};

/**
 * 初始化崩溃上报，返回 reportCrash 供 uncaughtException / unhandledRejection /
 * render-process-gone 三处兜底追加调用。getSettings 在每次上报时实时读取，
 * 用户在设置页改开关立即生效。
 */
export const initCrashReporter = (getSettings: () => {crashReporting?: boolean}) => {
  const reportCrash = (kind: CrashKind, detail: unknown): void => {
    try {
      // 双重门槛：仅生产构建 + 用户显式开启（开发环境永不发送）
      if (!app.isPackaged) return;
      if (getSettings().crashReporting !== true) return;

      const {message, stackTop} = extract(detail);
      const body = {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        kind,
        message: scrubPii(message).slice(0, 500),
        stackTop: scrubPii(stackTop).slice(0, 500),
        ts: Date.now(),
      };

      // 服务端地址复用授权服务的解析逻辑（生产环境强制内置地址，忽略自定义 licenseServerUrl）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
      fetch(`${getServerBaseUrl()}/api/crash-report`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .catch(() => {
          // 静默失败：离线/超时/服务端异常都不影响主流程
        })
        .finally(() => clearTimeout(timer));
    } catch {
      // 上报路径自身任何异常都静默吞掉，绝不反向成为崩溃源
    }
  };
  return reportCrash;
};
