/**
 * 色彩统一（项目级）：色调风格预设 + 自动曝光匹配
 *
 * 商业成片的「整体感」一半来自色彩统一。两层处理，均在 Remotion 合成内以
 * CSS filter / 混合模式实现——预览与成片走同一个 Chromium 渲染器，天然 WYSIWYG，
 * 不依赖 ffmpeg 滤镜（内置精简 ffmpeg 缺 lut3d 等滤镜）。
 *
 * 1. 色调预设（look）：全片内容层套一层风格化 filter + 可选染色叠层
 *    （字幕/Logo/水印在叠层之上，不被染色，保证可读性与品牌色准确）。
 * 2. 自动曝光匹配（autoMatch）：素材入库时分析平均亮度（colorStats），渲染时
 *    以全片素材亮度中位数为基准，给每路素材算一个温和的 brightness 校正系数，
 *    消除「录屏偏亮 / 本地文件偏暗」的拼凑感。系数钳在 [0.85, 1.18]，
 *    只拉齐曝光不做风格化，风格交给 look。
 */

/** 素材色彩统计（入库时分析一次，随 VideoClip 持久化） */
export interface ColorStats {
  /** 红通道均值 0-255 */
  r: number;
  /** 绿通道均值 0-255 */
  g: number;
  /** 蓝通道均值 0-255 */
  b: number;
  /** 感知亮度均值 0-255（Rec.709 加权） */
  luma: number;
}

/** 项目级色彩设置 */
export interface ColorGrade {
  /** 色调预设 id（COLOR_LOOKS 之一；'none' = 不处理） */
  look: string;
  /** 自动曝光匹配：素材亮度向全片中位数看齐 */
  autoMatch: boolean;
}

export const DEFAULT_COLOR_GRADE: ColorGrade = {look: 'none', autoMatch: true};

/** 染色叠层（soft-light 混合，模拟 LUT 的色调倾向） */
export interface ColorTint {
  color: string;
  opacity: number;
  blendMode: 'soft-light' | 'overlay' | 'multiply';
}

export interface ColorLook {
  id: string;
  label: string;
  desc: string;
  /** 叠加在内容层上的 CSS filter（空串 = 无） */
  filter: string;
  tint?: ColorTint;
}

/**
 * 色调预设。filter 数值克制（单参数 ≤12%），追求「贵」而非「重」——
 * 商业宣传片的调色是统一与克制，不是滤镜堆砌。
 */
export const COLOR_LOOKS: ColorLook[] = [
  {id: 'none', label: '原生', desc: '不做色调处理', filter: ''},
  {
    id: 'cleanCool',
    label: '清冷商业',
    desc: '微降饱和、提对比、冷一点：科技/效率工具的干净感',
    filter: 'saturate(0.94) contrast(1.06) brightness(1.02) hue-rotate(-4deg)',
  },
  {
    id: 'warmFilm',
    label: '暖调胶片',
    desc: '暖色倾向 + 轻微褪色：生活/消费/品牌故事',
    filter: 'saturate(1.05) contrast(1.04) sepia(0.06)',
    tint: {color: '#FF9E4F', opacity: 0.06, blendMode: 'soft-light'},
  },
  {
    id: 'tealOrange',
    label: '青橙大片',
    desc: '青色阴影 + 暖色高光的影院倾向：硬件/游戏/性能向',
    filter: 'contrast(1.08) saturate(1.1)',
    tint: {color: '#0E7C86', opacity: 0.08, blendMode: 'soft-light'},
  },
  {
    id: 'monoContrast',
    label: '黑白高对比',
    desc: '去色 + 拉对比：声明式/复古/人文向',
    filter: 'grayscale(1) contrast(1.12) brightness(1.02)',
  },
  {
    id: 'fadedRetro',
    label: '复古褪色',
    desc: '降饱和降对比 + 米色染：文艺/怀旧向',
    filter: 'saturate(0.84) contrast(0.95) brightness(1.04)',
    tint: {color: '#F2E6D8', opacity: 0.07, blendMode: 'soft-light'},
  },
];

export const getColorLook = (id: string | undefined | null): ColorLook =>
  COLOR_LOOKS.find((l) => l.id === id) ?? COLOR_LOOKS[0];

/** 亮度 → Rec.709 感知亮度（0-255） */
export const lumaOf = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 自动匹配校正系数：素材亮度向目标亮度看齐，钳在温和区间 */
export const autoMatchFactor = (luma: number, targetLuma: number): number => {
  if (!Number.isFinite(luma) || luma <= 1 || !Number.isFinite(targetLuma) || targetLuma <= 1) return 1;
  return Math.min(1.18, Math.max(0.85, targetLuma / luma));
};

/** 全片基准亮度：所有有统计素材的亮度中位数；无统计数据时返回 null（不匹配） */
export const medianTargetLuma = (lumas: number[]): number | null => {
  const valid = lumas.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (valid.length < 2) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
};

/** 校正系数 → CSS filter 片段（≈1 时返回空串，避免无谓的合成层） */
export const colorMatchFilter = (factor: number): string =>
  Math.abs(factor - 1) < 0.005 ? '' : `brightness(${factor.toFixed(3)})`;
