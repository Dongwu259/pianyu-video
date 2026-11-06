/**
 * 封面设计预设（项目级发布准备的一部分）
 *
 * 纯数据 + 纯函数：字体表、版式预设（生成自由文字图层）、默认配置、外部输入清洗、
 * 旧版（固定版式）配置迁移。覆盖层的实际绘制见 src/remotion/layers/CoverOverlay.tsx，
 * 导出渲染见主进程 renderer.ts 的 renderCoverStill。
 */

import type {CoverConfig, CoverFontId, CoverScrimStyle, CoverTextLayer, Orientation, PublishMetadata} from './types';

/** 字体选项（family 栈与渲染/预览共用；MiSans 为内置品牌字体，其余回退系统字体） */
export const COVER_FONTS: {value: CoverFontId; label: string; family: string; weight: number}[] = [
  {value: 'heavy', label: '品牌粗黑', family: '"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif', weight: 800},
  {value: 'sans', label: '现代黑体', family: '"MiSans", "PingFang SC", "Microsoft YaHei", sans-serif', weight: 500},
  {value: 'serif', label: '衬线宋体', family: 'Georgia, "Noto Serif SC", "Source Han Serif SC", "SimSun", serif', weight: 700},
  {value: 'kai', label: '楷体', family: '"Kaiti SC", "KaiTi", "STKaiti", "FangSong", serif', weight: 700},
  {value: 'mono', label: '等宽', family: '"SF Mono", "Consolas", "MiSans", monospace', weight: 700},
];

export const fontById = (id: CoverFontId) => COVER_FONTS.find((f) => f.value === id) ?? COVER_FONTS[0];

/** 版式预设 id（生成一组带 role 的文字图层 + 遮罩样式） */
export type CoverPresetId = 'bottomLeft' | 'centerPoster' | 'leftBand' | 'topBand';

export const COVER_PRESET_OPTIONS: {value: CoverPresetId; label: string; desc: string}[] = [
  {value: 'bottomLeft', label: '底部渐变', desc: '左下角标题，底部渐变压暗（最通用）'},
  {value: 'centerPoster', label: '居中海报', desc: '全屏轻暗化，居中大标题（海报感）'},
  {value: 'leftBand', label: '左侧渐变', desc: '左侧渐变压暗，标题居左'},
  {value: 'topBand', label: '顶部渐变', desc: '顶部渐变压暗，左上标题（主体在下半时用）'},
];

export const COVER_PRESET_IDS = COVER_PRESET_OPTIONS.map((o) => o.value);

export const SCRIM_STYLE_OPTIONS: {value: CoverScrimStyle; label: string}[] = [
  {value: 'bottom', label: '底部压暗'},
  {value: 'full', label: '全屏压暗'},
  {value: 'left', label: '左侧压暗'},
  {value: 'top', label: '顶部压暗'},
  {value: 'none', label: '不压暗'},
];

/** hex 颜色变暗（factor 0-1，0=黑）；用于 3D 挤出侧面色的默认推导 */
export const darkenHex = (hex: string, factor: number): string => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return '#333333';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

/**
 * 版式预设 → 一组文字图层（坐标归一化；size/stroke 以 1920 宽基准）。
 * 竖版时 y 位置整体上移，避开 Reels/TikTok 底部安全区（18%）。
 */
export const coverPresetLayers = (
  preset: CoverPresetId,
  orientation: Orientation,
  texts: {title?: string; subtitle?: string; tag?: string; accent?: string},
): CoverTextLayer[] => {
  const accent = texts.accent || '#2563EB';
  const title = texts.title ?? '';
  const subtitle = texts.subtitle ?? '';
  const tag = texts.tag ?? '';
  const portrait = orientation === 'portrait';
  const base = {
    font: 'heavy' as const, color: '#FFFFFF', strokeColor: '', strokeWidth: 0,
    rotation: 0, depth: 0, angle: 45, sideColor: '#1E293B', behind: false, chipColor: '',
  };
  switch (preset) {
    case 'centerPoster':
      return [
        {...base, id: 'tag', role: 'tag' as const, text: tag, x: 0.5, y: portrait ? 0.3 : 0.34, align: 'center' as const,
          size: 46, chipColor: tag ? accent : ''},
        {...base, id: 'title', role: 'title' as const, text: title, x: 0.5, y: portrait ? 0.44 : 0.47, align: 'center' as const, size: 148},
        {...base, id: 'subtitle', role: 'subtitle' as const, text: subtitle, x: 0.5, y: portrait ? 0.56 : 0.585, align: 'center' as const,
          size: 60, font: 'sans' as const},
      ];
    case 'leftBand':
      return [
        {...base, id: 'tag', role: 'tag' as const, text: tag, x: 0.08, y: 0.32, align: 'left' as const, size: 46, chipColor: tag ? accent : ''},
        {...base, id: 'title', role: 'title' as const, text: title, x: 0.08, y: 0.46, align: 'left' as const, size: 148},
        {...base, id: 'subtitle', role: 'subtitle' as const, text: subtitle, x: 0.08, y: 0.57, align: 'left' as const, size: 60, font: 'sans' as const},
      ];
    case 'topBand':
      return [
        {...base, id: 'tag', role: 'tag' as const, text: tag, x: 0.065, y: 0.075, align: 'left' as const, size: 46, chipColor: tag ? accent : ''},
        {...base, id: 'title', role: 'title' as const, text: title, x: 0.065, y: 0.19, align: 'left' as const, size: 148},
        {...base, id: 'subtitle', role: 'subtitle' as const, text: subtitle, x: 0.065, y: 0.29, align: 'left' as const, size: 60, font: 'sans' as const},
      ];
    case 'bottomLeft':
    default:
      return [
        {...base, id: 'tag', role: 'tag' as const, text: tag, x: 0.065, y: portrait ? 0.6 : 0.665, align: 'left' as const,
          size: 46, chipColor: tag ? accent : ''},
        {...base, id: 'title', role: 'title' as const, text: title, x: 0.065, y: portrait ? 0.7 : 0.78, align: 'left' as const, size: 148},
        {...base, id: 'subtitle', role: 'subtitle' as const, text: subtitle, x: 0.065, y: portrait ? 0.79 : 0.885, align: 'left' as const,
          size: 60, font: 'sans' as const},
      ];
  }
};

export const PRESET_SCRIM: Record<CoverPresetId, CoverScrimStyle> = {
  bottomLeft: 'bottom',
  centerPoster: 'full',
  leftBand: 'left',
  topBand: 'top',
};

/** 默认封面配置（timeSec 由调用方按全片时长落到合适位置） */
export const DEFAULT_COVER: CoverConfig = {
  timeSec: 0.8,
  scrim: 0.55,
  scrimStyle: 'bottom',
  format: 'jpg',
  layers: coverPresetLayers('bottomLeft', 'landscape', {}),
};

/** 按全片时长给一个默认选帧时刻（开场钩子之后、避开片尾淡出；封顶 5s 不深入片中） */
export const defaultCoverTime = (totalDuration: number): number =>
  Math.min(
    Math.max(totalDuration * 0.15, 0.3),
    5,
    Math.max(totalDuration - 0.2, 0.3),
  );

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const hexOr = (v: unknown, fallback: string): string =>
  typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim() : fallback;

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const strOr = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** 旧版固定版式字段 → 新版预设 id（v1 配置迁移用） */
const LEGACY_LAYOUT_MAP: Record<string, CoverPresetId> = {
  bottomLeft: 'bottomLeft',
  center: 'centerPoster',
  sideBar: 'leftBand',
  topBand: 'topBand',
};

/**
 * 清洗外部（MCP/UI 边界）传入的封面图层。
 */
export const sanitizeCoverLayer = (raw: unknown, index: number): CoverTextLayer => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const font = COVER_FONTS.some((f) => f.value === r.font) ? (r.font as CoverFontId) : 'heavy';
  const align = r.align === 'left' || r.align === 'right' ? r.align : (r.align === 'center' ? 'center' : 'left');
  const role = r.role === 'title' || r.role === 'subtitle' || r.role === 'tag' ? r.role : undefined;
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 24) : `text-${index + 1}`;
  return {
    id,
    ...(role ? {role} : {}),
    text: strOr(r.text, 60),
    font,
    x: clampNum(r.x, 0.02, 0.98, 0.5),
    y: clampNum(r.y, 0.02, 0.98, 0.5),
    align,
    size: clampNum(r.size, 40, 400, 148),
    color: hexOr(r.color, '#FFFFFF'),
    strokeColor: r.strokeColor === '' ? '' : hexOr(r.strokeColor, ''),
    strokeWidth: clampNum(r.strokeWidth, 0, 24, 0),
    rotation: clampNum(r.rotation, -45, 45, 0),
    depth: clampNum(r.depth, 0, 48, 0),
    angle: clampNum(r.angle, 0, 360, 45),
    sideColor: hexOr(r.sideColor, '#1E293B'),
    behind: r.behind === true,
    chipColor: r.chipColor === '' ? '' : hexOr(r.chipColor, ''),
  };
};

/**
 * 清洗外部（MCP/UI 边界）传入的封面配置；兼容旧版固定版式字段（layout/title/subtitle/tag/accent）
 * 自动迁移为文字图层。返回全新对象（不修改入参）。
 */
export const sanitizeCoverConfig = (raw: unknown, orientation: Orientation = 'landscape'): CoverConfig => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const timeSec = clampNum(r.timeSec, 0, 3600, DEFAULT_COVER.timeSec);
  const scrim = clampNum(r.scrim, 0, 1, DEFAULT_COVER.scrim);
  const scrimStyle = SCRIM_STYLE_OPTIONS.some((s) => s.value === r.scrimStyle)
    ? (r.scrimStyle as CoverScrimStyle)
    : DEFAULT_COVER.scrimStyle;
  const format = r.format === 'png' ? 'png' : 'jpg';
  if (Array.isArray(r.layers)) {
    return {timeSec, scrim, scrimStyle, format, layers: r.layers.slice(0, 6).map(sanitizeCoverLayer)};
  }
  // 旧版固定版式（layout/title/subtitle/tag/accent）→ 预设图层迁移
  const preset = LEGACY_LAYOUT_MAP[String(r.layout ?? '')] ?? 'bottomLeft';
  return {
    timeSec,
    scrim,
    scrimStyle: PRESET_SCRIM[preset],
    format,
    layers: coverPresetLayers(preset, orientation, {
      title: strOr(r.title, 60),
      subtitle: strOr(r.subtitle, 120),
      tag: strOr(r.tag, 20),
      accent: hexOr(r.accent, '#2563EB'),
    }).map((l) => ({...l, chipColor: l.role === 'tag' && l.text ? hexOr(r.accent, '#2563EB') : ''})),
  };
};

/**
 * 应用版式预设到现有配置：保留各 role 层已填的文字与强调色，重排位置。
 */
export const applyCoverPreset = (
  cover: CoverConfig,
  preset: CoverPresetId,
  orientation: Orientation,
): CoverConfig => {
  const current = new Map<string, CoverTextLayer>();
  for (const l of cover.layers) if (l.role) current.set(l.role, l);
  const accent = current.get('tag')?.chipColor || '#2563EB';
  const layers = coverPresetLayers(preset, orientation, {
    title: current.get('title')?.text ?? '',
    subtitle: current.get('subtitle')?.text ?? '',
    tag: current.get('tag')?.text ?? '',
    accent,
  });
  // 预设层之外的自由图层保留在后
  return {...cover, scrimStyle: PRESET_SCRIM[preset], layers: [...layers, ...cover.layers.filter((l) => !l.role)].slice(0, 6)};
};

/**
 * 封面文案的缺省链：role 层文字为空时按 发布元数据标题 → 首段标题/副标题 补全。
 * 封面输入框留空时按此取值（占位符提示来源），导出与 AI export_cover 共用同一口径。
 */
export const effectiveCoverTexts = (
  cover: CoverConfig,
  meta: PublishMetadata | undefined,
  fallback?: {title?: string; subtitle?: string},
): {title: string; subtitle: string} => {
  const roleText = (role: 'title' | 'subtitle') =>
    cover.layers.find((l) => l.role === role)?.text.trim() || '';
  return {
    title: roleText('title') || meta?.title.trim() || (fallback?.title || '').trim(),
    subtitle: roleText('subtitle') || (fallback?.subtitle || '').trim(),
  };
};

/**
 * 把缺省链算出的文案写回 role 层（导出时让成图带上最终文字）。
 */
export const withEffectiveTexts = (cover: CoverConfig, texts: {title: string; subtitle: string}): CoverConfig => ({
  ...cover,
  layers: cover.layers.map((l) =>
    l.role === 'title' && !l.text.trim() ? {...l, text: texts.title}
      : l.role === 'subtitle' && !l.text.trim() ? {...l, text: texts.subtitle}
      : l,
  ),
});
