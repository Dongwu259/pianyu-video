/**
 * 舞台底色容器（1.6 操作视频内核 M1，共享色板与样式常量）。
 *
 * 第二轮参照研究结论的落地：顶级软件 demo 的录屏从不「满屏贴死」——loom-demo 品牌粉底+白卡、
 * Screen Studio 彩虹壁纸+悬浮窗、FocuSee 紫罗兰光斑+窗口。stageBg 把「舞台底色 + 圆角窗口卡」
 * 做成 ScreenDemo / CursorFollow 的通用参数（ProductFloat 模板复用同一色板）。
 */

export interface StagePalette {
  /** 色板名（UI 展示） */
  name: string;
  /** 纯色模式底色 / 渐变起点 */
  solid: string;
  /** 渐变终点 */
  to: string;
  /** 辉光卡模式的光晕色 */
  glow: string;
}

/** 舞台色板（暗调为主与片语深色 UI 同族；8-9 为浅色档——随变临摹 P3「浅色主题族」补齐，
 *  卡描边经 stageCardBorder 随档自适应，浅底上白描边不可见的问题就此关闭） */
export const STAGE_PALETTES: StagePalette[] = [
  {name: '深空蓝', solid: '#0b1026', to: '#182449', glow: '#7c9cff'},
  {name: '紫罗兰', solid: '#190f2e', to: '#2f1c52', glow: '#b48cff'},
  {name: '暖琥珀', solid: '#1f1408', to: '#3c2b10', glow: '#ffb45c'},
  {name: '青碧', solid: '#06201e', to: '#0e3d38', glow: '#4fd1c5'},
  {name: '玫粉', solid: '#241019', to: '#46203c', glow: '#ff8fb8'},
  {name: '墨绿', solid: '#0c1a10', to: '#173423', glow: '#6ee7a0'},
  {name: '石墨', solid: '#101214', to: '#262b33', glow: '#9aa4b2'},
  {name: '酒红', solid: '#200a10', to: '#3d1322', glow: '#ff6b81'},
  {name: '奶油', solid: '#FBF7E8', to: '#F3E6BE', glow: '#E3A93C'},
  {name: '浅灰', solid: '#F5F6F8', to: '#E4E8EF', glow: '#7c9cff'},
];

/** 浅色档下标（stageCardBorder 等按此判断明暗；新增浅色档加进集合即可） */
export const LIGHT_STAGE_PALETTES = new Set([8, 9]);

export const STAGE_CARD_RADIUS = 22;
/** 圆角卡的投影（悬浮展品感） */
export const STAGE_CARD_SHADOW = '0 42px 90px -18px rgba(0, 0, 0, 0.66)';
/** 卡内描边（细白线勾边，参照 Framer 黑底发光描边手法） */
export const STAGE_CARD_BORDER = '1px solid rgba(255, 255, 255, 0.14)';
/** 卡内描边（浅色舞台档：深描边——白线在浅底不可见） */
export const STAGE_CARD_BORDER_LIGHT = '1px solid rgba(23, 24, 28, 0.14)';

/** 按色板档位取卡描边（浅色档返回深描边；未开舞台/未知档回退白描边=历史行为） */
export const stageCardBorder = (paletteIdx: number): string =>
  LIGHT_STAGE_PALETTES.has(Math.round(paletteIdx)) ? STAGE_CARD_BORDER_LIGHT : STAGE_CARD_BORDER;

/**
 * 舞台背景 CSS；mode = 0 关（返回 null，调用方用默认模板背景）。
 * mode = 1 纯色 / 2 双色渐变（对角线，光斑感）。
 */
export const stageBackgroundCss = (mode: number, paletteIdx: number): string | null => {
  if (mode < 1) return null;
  const p = STAGE_PALETTES[Math.max(0, Math.min(STAGE_PALETTES.length - 1, Math.round(paletteIdx)))];
  if (mode === 1) return p.solid;
  return `linear-gradient(135deg, ${p.solid} 0%, ${p.to} 62%, ${p.solid} 100%)`;
};

/** 辉光卡的外发光阴影（叠在投影前） */
export const stageCardGlowShadow = (paletteIdx: number): string => {
  const p = STAGE_PALETTES[Math.max(0, Math.min(STAGE_PALETTES.length - 1, Math.round(paletteIdx)))];
  return `0 0 0 1px ${p.glow}44, 0 0 46px ${p.glow}55`;
};

/** hex → [h(0-360), s(0-1), l(0-1)]（仅 Auto Accent 用，容忍非法输入回退灰） */
const hexToHsl = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0.5];
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, s, l];
};

const hueDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Auto Accent 的低饱和兜底档（石墨）——灰白 UI 不给乱配色 */
export const AUTO_ACCENT_FALLBACK_IDX = 6;
/** 低于此饱和度视为无强调色 */
const AUTO_GRAY_SAT = 0.18;

/**
 * Auto Accent（第四轮参照研究：CleanShot Background「自动取色配底」的软件版）：
 * 从素材色彩统计取主色调色相，映射到色相距离最近的舞台色板 glow 色。
 * 素材低饱和（灰白 UI）或无统计时回退石墨档。返回 STAGE_PALETTES 下标。
 */
export const autoAccentPaletteIdx = (stats?: {r: number; g: number; b: number}): number => {
  if (!stats) return AUTO_ACCENT_FALLBACK_IDX;
  const max = Math.max(stats.r, stats.g, stats.b) / 255;
  const min = Math.min(stats.r, stats.g, stats.b) / 255;
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < AUTO_GRAY_SAT) return AUTO_ACCENT_FALLBACK_IDX;
  const [hue] = hexToHsl(
    `#${[stats.r, stats.g, stats.b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`,
  );
  let best = AUTO_ACCENT_FALLBACK_IDX;
  let bestDist = 361;
  STAGE_PALETTES.forEach((p, i) => {
    if (i === AUTO_ACCENT_FALLBACK_IDX) return; // 石墨是无彩兜底，不参与彩色匹配
    const [ph, ps] = hexToHsl(p.glow);
    if (ps < 0.1) return;
    const d = hueDist(hue, ph);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
};
