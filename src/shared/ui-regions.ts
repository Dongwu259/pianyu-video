/**
 * UI 区域（ui-regions）共享类型与 sidecar 解析（B6 PanelFlyout 的数据侧）
 *
 * 一条录屏素材可以附带一份 `.regions.json` sidecar（与 .cursor.json 同机制），
 * 描述画面里软件面板的归一化矩形（侧栏/时间轴/属性板/主界面…），供拆层飞出等
 * 模板把「软件的一部分」作为独立层处理。区域来源三路（source 字段区分）：
 * - `visual`：视觉检测（shared/ui-region-detect.ts，通用能力，任意录屏可用）
 * - `cdp`：Electron/web UI 经 CDP 直接分析 DOM 结构元素的精确包围盒
 * - `ax`：无障碍树 / computer-use UI 列表（录制目标暴露 AX 接口时的精确源，接口留位）
 *
 * 坐标全部归一化（0-1 相对画面宽高），与分辨率解耦。
 */

export type UiRegionRole = 'sidebar' | 'panel' | 'timeline' | 'main' | 'band';

/** 单个 UI 区域：归一化矩形 + 语义角色 */
export interface UiRegionSource {
  /** 稳定 id（同一次检测内唯一；飞出动画的确定性抖动种子） */
  id: string;
  /** 语义角色（决定飞出方向优先级；缺省按位置推断） */
  role: UiRegionRole;
  /** 归一化矩形（0-1 相对画面宽高） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 可选显示名（视觉检测线缺省空；cdp/ax 线可带元素语义名） */
  label?: string;
  /** 检测置信度 0-1（视觉线=边界对比度支持度；cdp/ax 线=1） */
  score?: number;
}

/** `.regions.json` sidecar 文件结构（与录像同目录的 <同名>.regions.json） */
export interface UiRegionsFile {
  version: 1;
  videoWidth: number;
  videoHeight: number;
  /** 区域来源：visual 视觉检测 / cdp DOM 分析 / ax 无障碍树（接口留位） */
  source: 'visual' | 'cdp' | 'ax';
  /** 视觉检测的采样时刻（秒，仅 visual 线；审计用） */
  sampleSec?: number[];
  regions: UiRegionSource[];
}

/** 解析并校验 sidecar JSON 文本；结构不符返回 null（不阻断工程加载，与 cursorTrack 同纪律） */
export const parseUiRegionsJson = (text: string): UiRegionsFile | null => {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  if (o.version !== 1) return null;
  const src = o.source;
  if (src !== 'visual' && src !== 'cdp' && src !== 'ax') return null;
  if (!Array.isArray(o.regions) || o.regions.length === 0) return null;
  const regions: UiRegionSource[] = [];
  for (const r of o.regions) {
    if (typeof r !== 'object' || r === null) continue;
    const ro = r as Record<string, unknown>;
    const x = Number(ro.x);
    const y = Number(ro.y);
    const w = Number(ro.w);
    const h = Number(ro.h);
    if (![x, y, w, h].every((v) => Number.isFinite(v))) continue;
    const clampedW = Math.min(Math.max(w, 0.01), 1);
    const clampedH = Math.min(Math.max(h, 0.01), 1);
    regions.push({
      id: String(ro.id ?? regions.length),
      role: (ro.role === 'sidebar' || ro.role === 'panel' || ro.role === 'timeline' || ro.role === 'band' ? ro.role : 'main') as UiRegionSource['role'],
      x: Math.min(Math.max(x, 0), 1 - clampedW),
      y: Math.min(Math.max(y, 0), 1 - clampedH),
      w: clampedW,
      h: clampedH,
      ...(typeof ro.label === 'string' && ro.label ? {label: ro.label} : {}),
      ...(Number.isFinite(Number(ro.score)) ? {score: Math.min(1, Math.max(0, Number(ro.score)))} : {}),
    });
  }
  if (regions.length === 0) return null;
  return {
    version: 1,
    videoWidth: Number(o.videoWidth) || 0,
    videoHeight: Number(o.videoHeight) || 0,
    source: src,
    ...(Array.isArray(o.sampleSec) ? {sampleSec: o.sampleSec.map(Number).filter(Number.isFinite)} : {}),
    regions,
  };
};
