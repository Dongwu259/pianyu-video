/**
 * clip-cues - 素材「精彩时刻」cue 表（录制期声明，编排期查表）
 *
 * 解决的问题：3D 画中画只在驻留窗口播放素材开头 ~1.3-2.6s，素材精彩时刻晚了
 * 就「没放完就转场」。与其事后抽帧理解（贵且不准），不如在录制/设计分镜时就
 * 声明每条素材的高光区间——编排时查表对齐，零模型成本。
 *
 * 落盘格式（与录制 sidecar 同目录同名，后缀 .cues.json）：
 *   {version: 1, source: "rec-xxx.webm", cues: [{t0: 3.2, t1: 5.1, label: "参数面板展开"}]}
 * - t0/t1 为素材媒体绝对秒；来源优先级：录制脚本声明 > 人工标记 > 启发式检测。
 * - 编排（auto_* / 构建脚本 / LLM 工具）优先读 cue 表对齐画中画窗口；
 *   无 cue 表时回退启发式（点击簇/场景切换/运动能量），再无则人工抽帧。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ClipCue {
  /** 高光起点（素材媒体绝对秒） */
  t0: number;
  /** 高光终点（秒，> t0） */
  t1: number;
  /** 人类/模型可读的说明（如「参数面板展开」「悬停预览弹层」） */
  label?: string;
}

export interface ClipCueSheet {
  version: 1;
  /** 源素材文件名（便于溯源） */
  source: string;
  cues: ClipCue[];
}

/** 解析并校验 cue 表（脏数据防御：t0/t1 必须有限且 0 ≤ t0 < t1，label 可缺省） */
export const parseCueSheet = (raw: unknown, sourceHint = ''): ClipCueSheet | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {version?: unknown; source?: unknown; cues?: unknown};
  if (!Array.isArray(obj.cues)) return null;
  const cues: ClipCue[] = [];
  for (const c of obj.cues) {
    if (!c || typeof c !== 'object') continue;
    const {t0, t1, label} = c as {t0?: unknown; t1?: unknown; label?: unknown};
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    const a = Number(t0);
    const b = Number(t1);
    if (a < 0 || b <= a) continue;
    cues.push({t0: a, t1: b, ...(typeof label === 'string' && label ? {label} : {})});
  }
  return {
    version: 1,
    source: typeof obj.source === 'string' && obj.source ? obj.source : sourceHint,
    cues,
  };
};

/** 读取素材旁的 cue 表（<素材路径去后缀>.cues.json）；不存在/损坏返回 null */
export const loadCueSheet = (mediaPath: string): ClipCueSheet | null => {
  const cuePath = mediaPath.replace(/\.[^.]+$/, '') + '.cues.json';
  if (!fs.existsSync(cuePath)) return null;
  try {
    return parseCueSheet(JSON.parse(fs.readFileSync(cuePath, 'utf-8')), path.basename(mediaPath));
  } catch {
    return null;
  }
};

/** cue 表落盘（录制器/脚本写侧） */
export const writeCueSheet = (mediaPath: string, cues: ClipCue[], source?: string): string => {
  const cuePath = mediaPath.replace(/\.[^.]+$/, '') + '.cues.json';
  const sheet: ClipCueSheet = {version: 1, source: source ?? path.basename(mediaPath), cues};
  fs.writeFileSync(cuePath, JSON.stringify(sheet, null, 2), 'utf-8');
  return cuePath;
};

/**
 * 编排对齐检查：素材高光（素材本地秒）是否落在可见窗口 [0, visibleDurSec] 内。
 * visibleDurSec = 模板槽位驻留时长（getTemplateSlotWindows().slots[i].dwellDurSec）。
 * 返回对齐建议：cue 晚于可见窗时给出应设的 trimStart（把高光拉到窗口开头）。
 */
export const cueAlignment = (
  cues: ClipCue[],
  visibleDurSec: number,
): {ok: boolean; cue?: ClipCue; suggestedTrimStart?: number} => {
  for (const c of cues) {
    if (c.t0 <= visibleDurSec) return {ok: true, cue: c};
    // 高光在可见窗之外：建议把裁剪起点提到高光前 0.3s
    return {ok: false, cue: c, suggestedTrimStart: Math.max(0, c.t0 - 0.3)};
  }
  return {ok: true};
};
