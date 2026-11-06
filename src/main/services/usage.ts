/**
 * 匿名用量遥测（主进程，默认开启，设置页「帮助改进产品」可关闭）
 *
 * 隐私约束：只统计功能使用次数（渲染 / AI 对话 / 录屏截屏 / 各模板使用频次），
 * 绝不含文件路径、素材内容、工程数据与激活码。machineHash 复用授权的设备指纹
 * （MachineGuid 的 SHA-256，见 license.ts getOrCreateMachineId），仅用于去重。
 *
 * 可靠性约束：遥测永远不能影响主流程 —— 10s 超时、任何异常静默吞掉、失败保留
 * 计数下次重试（单项钳到 MAX_COUNT 防爆），且不在日志刷屏。
 */

import {app} from 'electron';
import {getGlobalSettings, getUsageStats, setUsageStats} from './store';
import type {UsageStats} from './store';
import {getServerBaseUrl, getOrCreateMachineId} from './license';

/** 单项计数上限（长期离线时本地累积防爆） */
const MAX_COUNT = 100000;
/** 累计渲染耗时上限（ms，约 30 天；计数上限对时长太小，单独给个大水位防爆即可） */
const MAX_RENDER_MS = 30 * 24 * 60 * 60 * 1000;
/** 距上次成功上报不足该间隔不尝试 flush */
const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 定时尝试 flush 的周期（到点仅尝试，是否真发由 REPORT_INTERVAL_MS 决定） */
const FLUSH_TIMER_MS = 6 * 60 * 60 * 1000;
/** 上报请求超时 */
const REQUEST_TIMEOUT_MS = 10000;

const clamp = (n: number): number => Math.min(Math.max(0, Math.floor(n) || 0), MAX_COUNT);
const clampMs = (n: number): number => Math.min(Math.max(0, Math.floor(n) || 0), MAX_RENDER_MS);

/** 渲染成功一次；templateIds 为当前工程用到的模板 id 列表（逐个计数）；renderMs 为本次渲染耗时 */
export const trackRender = (templateIds: string[], renderMs = 0): void => {
  try {
    const stats = getUsageStats();
    stats.renders = clamp(stats.renders + 1);
    stats.renderMs = clampMs(stats.renderMs + renderMs);
    for (const id of templateIds) {
      if (typeof id !== 'string' || !id) continue;
      stats.templates[id] = clamp((stats.templates[id] || 0) + 1);
    }
    setUsageStats(stats);
  } catch {
    // 计数失败静默跳过
  }
};

/** 渲染未完成一次（失败或用户取消；模板 id 同样计数——渲染尝试确实用到了这些模板） */
export const trackRenderFailure = (templateIds: string[] = []): void => {
  try {
    const stats = getUsageStats();
    stats.rendersFailed = clamp(stats.rendersFailed + 1);
    for (const id of templateIds) {
      if (typeof id !== 'string' || !id) continue;
      stats.templates[id] = clamp((stats.templates[id] || 0) + 1);
    }
    setUsageStats(stats);
  } catch {
    // 计数失败静默跳过
  }
};

/** AI 对话成功回复一次 */
export const trackAiChat = (): void => {
  try {
    const stats = getUsageStats();
    stats.aiChats = clamp(stats.aiChats + 1);
    setUsageStats(stats);
  } catch {
    // 计数失败静默跳过
  }
};

/** 录屏 / 截屏保存成功一次 */
export const trackCapture = (): void => {
  try {
    const stats = getUsageStats();
    stats.captures = clamp(stats.captures + 1);
    setUsageStats(stats);
  } catch {
    // 计数失败静默跳过
  }
};

const hasPendingCounts = (stats: UsageStats): boolean =>
  stats.renders > 0 || stats.rendersFailed > 0 || stats.renderMs > 0 ||
  stats.aiChats > 0 || stats.captures > 0 || Object.keys(stats.templates).length > 0;

/**
 * 尝试上报一次。条件：打包环境（dev 不上报，本地计数照常）、设置开关开启
 * （老用户设置里无此键，undefined 视为开启）、距上次成功上报 >= 24h、有未上报计数。
 * 2xx 才扣除已上报的 delta 并记 lastReportAt
 * （用减法而非清零：上报在途期间新产生的计数不能丢）；失败原样保留，下次重试。
 */
const flush = async (): Promise<void> => {
  try {
    if (!app.isPackaged) return;
    if (getGlobalSettings().usageReporting === false) return;
    const stats = getUsageStats();
    const now = Date.now();
    if (now - stats.lastReportAt < REPORT_INTERVAL_MS) return;
    if (!hasPendingCounts(stats)) return;

    const delta = {
      renders: stats.renders,
      rendersFailed: stats.rendersFailed,
      renderMs: stats.renderMs,
      aiChats: stats.aiChats,
      captures: stats.captures,
      templates: {...stats.templates},
    };
    const body = {
      appVersion: app.getVersion(),
      platform: process.platform,
      machineHash: getOrCreateMachineId(),
      delta,
    };

    // 服务端地址复用授权服务的解析（生产强制内置地址），与崩溃上报同一约定
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let ok = false;
    try {
      const res = await fetch(`${getServerBaseUrl()}/api/usage-report`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      ok = res.status >= 200 && res.status < 300;
    } finally {
      clearTimeout(timer);
    }
    if (!ok) return;

    const after = getUsageStats();
    const templates: Record<string, number> = {};
    for (const [id, n] of Object.entries(after.templates)) {
      const rest = n - (delta.templates[id] || 0);
      if (rest > 0) templates[id] = clamp(rest);
    }
    setUsageStats({
      renders: clamp(after.renders - delta.renders),
      rendersFailed: clamp(after.rendersFailed - delta.rendersFailed),
      renderMs: clampMs(after.renderMs - delta.renderMs),
      aiChats: clamp(after.aiChats - delta.aiChats),
      captures: clamp(after.captures - delta.captures),
      templates,
      lastReportAt: now,
    });
  } catch {
    // 离线/超时/服务端异常：保留计数，静默等待下次重试
  }
};

let scheduled = false;

/**
 * 启动用量上报调度：立即尝试一次 flush，之后每 6h 尝试一次
 * （实际发送与否由 flush 内部的 24h 间隔与开关决定）。幂等，重复调用无效。
 */
export const scheduleUsageReporting = (): void => {
  if (scheduled) return;
  scheduled = true;
  void flush();
  const timer = setInterval(() => void flush(), FLUSH_TIMER_MS);
  // 不阻止进程退出（主进程常驻靠窗口生命周期，不该被遥测定时器续命）
  if (typeof timer.unref === 'function') timer.unref();
};
