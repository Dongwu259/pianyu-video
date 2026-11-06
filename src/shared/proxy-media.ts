/**
 * 代理转码 + Log→709 色彩恢复（真实电影机工作流，纯函数层）
 *
 * 电影机素材（mxf 容器 / 4K+ / 超大文件 / Log 灰片）直接编辑的问题：
 * - Chromium 预览解不动 mxf/hevc 等 → 抽帧/缩略图/预览全黑；
 * - Log 编码画面灰平 → AI 看图与成片都不正常色。
 *
 * 方案：导入命中探测规则的素材 → 后台 CPU 队列生成 960 宽 H.264 代理
 * （Log 素材同时烧入「技术转换 LUT」恢复正常色）→ 抽帧/预览/缩略图全部
 * 读代理（时间轴等价：代理只缩分辨率不改时间/帧率）；渲染回源（全分辨率），
 * Log 源渲染前先经带 LUT 的一次性转码得到恢复版源。
 *
 * LUT 分发合规：厂商官方 .cube LUT 多数禁止再分发，本仓库的技术转换 LUT
 * 由**公开数学公式生成**（脚本 scripts/gen-log-luts.ts，曲线公式出处：
 * ARRI 白皮书「ALEXA Log C Curve – Usage in VFX」/「ARRI LogC4 Specification」、
 * Sony/Canon/DJI/BMD 公开文档，实现对照开源 colour 库 BSD-3 校验），
 * 属纯数学查表，无版权负担。注意这是「log 编码曲线 → Rec.709」的技术转换
 * （不含厂商色域矩阵/tone map），用于恢复正常色，不做精确色彩管理。
 */

/** 色彩曲线 id（VideoClip.colorCurve 取值；'none' 之外的值触发 LUT 恢复链路） */
export type ColorCurveId = 'slog3' | 'clog2' | 'clog3' | 'logc3' | 'logc4' | 'dlog' | 'bmdfilm5';

export const COLOR_CURVE_IDS: readonly ColorCurveId[] = ['slog3', 'clog2', 'clog3', 'logc3', 'logc4', 'dlog', 'bmdfilm5'];

export interface ColorCurveMeta {
  id: ColorCurveId;
  /** 中文标签（UI 下拉 / AI 工具描述用） */
  label: string;
  /** 生成的技术转换 LUT 文件名（resources/luts/ 下） */
  lutFile: string;
  /** 厂商（用于 ffprobe make/model 猜测） */
  makeHint: string;
}

export const COLOR_CURVES: readonly ColorCurveMeta[] = [
  {id: 'slog3', label: 'Sony S-Log3', lutFile: 'slog3_to_rec709.cube', makeHint: 'sony'},
  {id: 'clog2', label: 'Canon C-Log2', lutFile: 'clog2_to_rec709.cube', makeHint: 'canon'},
  {id: 'clog3', label: 'Canon C-Log3', lutFile: 'clog3_to_rec709.cube', makeHint: 'canon'},
  {id: 'logc3', label: 'ARRI LogC3 (EI800)', lutFile: 'logc3_to_rec709.cube', makeHint: 'arri'},
  {id: 'logc4', label: 'ARRI LogC4', lutFile: 'logc4_to_rec709.cube', makeHint: 'arri'},
  {id: 'dlog', label: 'DJI D-Log', lutFile: 'dlog_to_rec709.cube', makeHint: 'dji'},
  {id: 'bmdfilm5', label: 'BMD Film Gen5', lutFile: 'bmdfilm5_to_rec709.cube', makeHint: 'blackmagic'},
];

export const colorCurveMeta = (id: ColorCurveId): ColorCurveMeta =>
  COLOR_CURVES.find((c) => c.id === id)!;

// ====== 各家 Log 曲线：码值 → 场景线性（公式出处见文件头注） ======

/** Sony S-Log3 decode（10bit 码值的归一形式；18% 灰 → 0.4106 官方锚点自洽） */
const slog3ToLinear = (v: number): number => {
  const code = v * 1023;
  if (code >= 171.2102946973654) {
    return Math.pow(10, (code - 420) / 261.5) * (0.18 + 0.01) - 0.01;
  }
  return (code * 0.01125) / 171.2102946973654;
};

/** ARRI LogC3 EI800 decode（exposure value 版系数；18% 灰 → 0.391 官方锚点） */
const logc3ToLinear = (t: number): number => {
  // cut 编码侧分界 = e*cut+f = 5.367655*0.010591+0.092809 = 0.149658
  if (t > 0.149658) {
    return (Math.pow(10, (t - 0.385537) / 0.247190) - 0.052272) / 5.555556;
  }
  return (t - 0.092809) / 5.367655;
};

/** ARRI LogC4 派生常数（官方规格的闭式定义） */
const LOGC4_A = (Math.pow(2, 18) - 16) / 117.45;
const LOGC4_B = (1023 - 95) / 1023;
const LOGC4_C = 95 / 1023;
const LOGC4_S = (7 * Math.LN2 * Math.pow(2, 7 - (14 * LOGC4_C) / LOGC4_B)) / (LOGC4_A * LOGC4_B);
const LOGC4_T = (Math.pow(2, (14 * -LOGC4_C) / LOGC4_B + 6) - 64) / LOGC4_A;

/** ARRI LogC4 decode（18% 灰 → 0.2784 官方锚点） */
const logc4ToLinear = (e: number): number => {
  if (e >= 0) {
    return (Math.pow(2, (14 * (e - LOGC4_C)) / LOGC4_B + 6) - 64) / LOGC4_A;
  }
  return e * LOGC4_S + LOGC4_T;
};

/** Canon C-Log2 decode（v1.2 legal-range 码值；输出场景线性含 ×0.9 反射率还原） */
const clog2ToLinear = (v: number): number => {
  const mag = Math.pow(10, Math.abs(v - 0.092864125) / 0.24136077) - 1;
  return (v < 0.092864125 ? -mag : mag) / 87.09937546 * 0.9;
};

/** Canon C-Log3 decode（v1.2 legal-range 码值，三段） */
const clog3ToLinear = (v: number): number => {
  let x: number;
  if (v < 0.097465473) {
    x = -(Math.pow(10, (0.12783901 - v) / 0.36726845) - 1) / 14.98325;
  } else if (v <= 0.15277891) {
    x = (v - 0.12512219) / 1.9754798;
  } else {
    x = (Math.pow(10, (v - 0.12240537) / 0.36726845) - 1) / 14.98325;
  }
  return x * 0.9;
};

/** DJI D-Log decode（18% 灰 → 0.3988 官方锚点） */
const dlogToLinear = (v: number): number => {
  if (v <= 0.14) {
    return (v - 0.0929) / 6.025;
  }
  return (Math.pow(10, 3.89616 * v - 2.27752) - 0.0108) / 0.9892;
};

/** BMD Film Generation 5 decode */
const BMDFILM5_D = 8.283605932402494;
const BMDFILM5_E = 0.09246575342465753;
const BMDFILM5_LOG_CUT = BMDFILM5_D * 0.005 + BMDFILM5_E;
const bmdfilm5ToLinear = (v: number): number => {
  if (v < BMDFILM5_LOG_CUT) {
    return (v - BMDFILM5_E) / BMDFILM5_D;
  }
  return Math.exp((v - 0.5300133392291939) / 0.08692876065491224) - 0.005494072432257808;
};

/** Log 码值 → 场景线性（各曲线逐通道相同） */
export const logToLinear = (curve: ColorCurveId, v: number): number => {
  switch (curve) {
    case 'slog3': return slog3ToLinear(v);
    case 'logc3': return logc3ToLinear(v);
    case 'logc4': return logc4ToLinear(v);
    case 'clog2': return clog2ToLinear(v);
    case 'clog3': return clog3ToLinear(v);
    case 'dlog': return dlogToLinear(v);
    case 'bmdfilm5': return bmdfilm5ToLinear(v);
  }
};

/** Rec.709 OETF（场景线性 → 显示码值；负值镜像，超 1 软钳） */
export const linearToRec709 = (l: number): number => {
  const a = Math.abs(l);
  const v = a >= 0.018 ? 1.099 * Math.pow(a, 0.45) - 0.099 : 4.5 * a;
  return Math.max(0, Math.min(1, l < 0 ? -v : v));
};

/** Log 码值 → Rec.709 显示码值（技术转换全链） */
export const curveToRec709 = (curve: ColorCurveId, v: number): number =>
  linearToRec709(logToLinear(curve, v));

// ====== .cube 生成（技术转换 LUT；对角 1D 曲线存成 3D cube 供 lut3d 滤镜用） ======

/**
 * 生成指定曲线的 3D .cube 文本（IRIDAS/Resolve 格式）。
 * 三通道同一曲线；red 变化最快（.cube 标准行序）。
 */
export const buildLutCubeText = (curve: ColorCurveId, size = 33): string => {
  const lines: string[] = [
    `# ${colorCurveMeta(curve).label} -> Rec.709 technical transform (math-generated, see src/shared/proxy-media.ts)`,
    `TITLE "${curve.toUpperCase()} to Rec709 (Pianyu technical)"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];
  const toFixed = (v: number) => v.toFixed(6);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const vr = curveToRec709(curve, r / (size - 1));
        const vg = curveToRec709(curve, g / (size - 1));
        const vb = curveToRec709(curve, b / (size - 1));
        lines.push(`${toFixed(vr)} ${toFixed(vg)} ${toFixed(vb)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
};

// ====== 代理触发探测 ======

/** 触发代理的源容器（Chromium 播不了 / 电影机常见容器） */
export const PROXY_SOURCE_EXTS = ['mxf', 'mts', 'm2ts', 'avi', 'wmv', 'flv', 'ts'];

/** 文件大小阈值（2GB） */
export const PROXY_SIZE_THRESHOLD = 2 * 1024 * 1024 * 1024;

/** 分辨率阈值：宽 ≥3840 或高 ≥2160（4K 及以上；含竖拍 2160×3840） */
export const proxyResolutionHit = (width: number, height: number): boolean =>
  width >= 3840 || height >= 2160;

export interface ProxyProbeInput {
  filePath: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/** 是否触发代理转码（mxf 等容器 / >2GB / ≥4K） */
export const shouldMakeProxy = (input: ProxyProbeInput): boolean => {
  const ext = (input.filePath.split('.').pop() || '').toLowerCase();
  if (PROXY_SOURCE_EXTS.includes(ext)) return true;
  if (input.sizeBytes >= PROXY_SIZE_THRESHOLD) return true;
  return proxyResolutionHit(input.width, input.height);
};

/** 代理目标宽（高按比例 -2 对齐偶数；ffmpeg scale=960:-2） */
export const PROXY_WIDTH = 960;

/** 代理参数版本（升级转码参数时 bump，旧缓存自动失配重生成） */
export const PROXY_VERSION = 1;

// ====== ffprobe 设备元数据 → 色彩曲线猜测 ======

export interface ColorCurveGuess {
  /** 无歧义厂牌直接给出的曲线（Sony/DJI/BMD：log 家族基本唯一） */
  curve?: ColorCurveId;
  /** 有代数歧义的厂牌：候选曲线（Canon/ARRI 新旧机型并存，不自动填） */
  candidates?: ColorCurveId[];
  note: string;
}

/**
 * 按厂商猜色彩曲线。策略：曲线家族唯一的厂牌（Sony 全系 S-Log3、DJI D-Log、
 * BMD 新机型 Gen5）自动填；Canon（clog2/clog3 并存）与 ARRI（LogC3/LogC4
 * 按机型代）只提示候选，由用户/AI 用 set_media_colorspace 确认。
 */
export const guessColorCurveFromTags = (make: string, model: string): ColorCurveGuess | null => {
  const hay = `${make} ${model}`.toLowerCase();
  if (!hay.trim()) return null;
  if (hay.includes('sony')) {
    return {curve: 'slog3', note: 'Sony 素材（有 Log 拍摄的 Sony 相机均用 S-Log3），已自动标记'};
  }
  if (hay.includes('canon')) {
    return {candidates: ['clog3', 'clog2'], note: 'Canon 素材：C-Log3 与 C-Log2 并存（机型/菜单决定），请确认后 set_media_colorspace'};
  }
  if (hay.includes('arri')) {
    return {candidates: ['logc4', 'logc3'], note: 'ARRI 素材：ALEXA 35 用 LogC4、更早机型 LogC3，请按机型确认'};
  }
  if (hay.includes('dji')) {
    return {curve: 'dlog', note: 'DJI 素材（D-Log），已自动标记；消费线 D-Log M 机器请改选确认'};
  }
  if (hay.includes('blackmagic') || hay.includes('black magic')) {
    return {curve: 'bmdfilm5', note: 'Blackmagic 素材（Film Gen5，2020 后机型），已自动标记；旧 Gen4 机型请改选'};
  }
  return null;
};
