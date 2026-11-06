/**
 * 素材色彩统计服务（主进程）
 *
 * 素材入库时分析平均 R/G/B/亮度（喂给「自动曝光匹配」，见 shared/color-grade.ts）。
 * 实现：抽 1-5 帧小图（复用 frameExtract 的 JPEG 产物，零新增 ffmpeg 滤镜依赖），
 * nativeImage 解码缩到 ~48px 宽后在 JS 里逐像素平均。视频取片长 8%/25%/50%/75%/92%
 * 五个采样点抗单帧偏差；图片取一帧。失败返回 null（素材照常入库，匹配时跳过）。
 */

import {nativeImage} from 'electron';
import {extractFrame} from './frameExtract';
import {lumaOf, type ColorStats} from '../../shared/color-grade';

/** 采样帧的解码目标宽度（48px 足够估计均值，像素级成本 ≤ 数千次加法） */
const SAMPLE_WIDTH = 48;

/** 视频采样点（占片长比例；避开首尾黑场/淡入淡出） */
const VIDEO_SAMPLE_POINTS = [0.08, 0.25, 0.5, 0.75, 0.92];

const averageBitmap = (buf: Buffer): {r: number; g: number; b: number} | null => {
  // nativeImage bitmap 为 BGRA 排布（Chromium 内部格式），4 字节/像素
  if (buf.length < 4) return null;
  const pixels = buf.length / 4;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < pixels; i++) {
    b += buf[i * 4];
    g += buf[i * 4 + 1];
    r += buf[i * 4 + 2];
  }
  return {r: r / pixels, g: g / pixels, b: b / pixels};
};

const averageFrame = async (filePath: string, timeSec: number): Promise<{r: number; g: number; b: number} | null> => {
  try {
    const frame = await extractFrame(filePath, timeSec, 192);
    const img = nativeImage.createFromDataURL(frame.dataUrl);
    if (img.isEmpty()) return null;
    const small = img.getSize().width > SAMPLE_WIDTH ? img.resize({width: SAMPLE_WIDTH}) : img;
    return averageBitmap(small.getBitmap());
  } catch {
    return null;
  }
};

/**
 * 分析素材色彩统计。type 'image' 取一帧；'video' 按片长取 5 个采样点。
 * 全部采样失败（损坏/解码失败）返回 null。
 */
export const analyzeColorStats = async (
  filePath: string,
  type: 'video' | 'image' | 'model',
  durationSec: number,
): Promise<ColorStats | null> => {
  // 3D 模型无像素帧可采样（three.js 渲染时才着色），直接跳过色彩分析
  if (type === 'model') return null;
  const times =
    type === 'image'
      ? [0]
      : VIDEO_SAMPLE_POINTS.map((p) => Math.max(0, (durationSec || 0) * p));
  const frames: Array<{r: number; g: number; b: number}> = [];
  for (const t of times) {
    const avg = await averageFrame(filePath, t);
    if (avg) frames.push(avg);
  }
  if (frames.length === 0) return null;
  const r = frames.reduce((s, f) => s + f.r, 0) / frames.length;
  const g = frames.reduce((s, f) => s + f.g, 0) / frames.length;
  const b = frames.reduce((s, f) => s + f.b, 0) / frames.length;
  return {r, g, b, luma: lumaOf(r, g, b)};
};
