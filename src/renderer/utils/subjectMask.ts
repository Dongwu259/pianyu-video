/**
 * 封面主体遮挡检测：从成片帧估计「主体 mask」（主体区域透明、其余不透明的 PNG），
 * 供封面 behind 图层渲染到主体后面，形成前后遮挡关系。
 *
 * 算法（简单显著性，无模型依赖）：
 *   边缘能量（Sobel） + 与边框底色的色距 各归一后加权合成，乘以中心先验，
 *   自适应阈值二值化 → 膨胀闭合成块 → 轻模糊软化边缘。
 * 适合「主体明确、背景相对干净」的产品图/演示画面；背景杂乱时 coverage 会提示。
 *
 * 核心 computeSubjectAlpha 是纯函数（可在 Node 单测中用合成数组验证）；
 * DOM 封装（加载图片/画布/导出 dataURL）只在浏览器侧使用。
 */

/** 纯函数核心：输入 RGBA 像素，输出同尺寸的 mask alpha（1=透出文字，0=主体挡住文字）与主体覆盖率 */
export const computeSubjectAlpha = (
  data: Uint8ClampedArray | number[],
  w: number,
  h: number,
): {alpha: Uint8ClampedArray; coverage: number} => {
  const n = w * h;
  const gray = new Float32Array(n);
  // 边框条带各通道采样（取中位数作为背景色估计）
  const border: number[] = [];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const idx = (x: number, y: number) => y * w + x;
  for (let x = 0; x < w; x++) {
    for (let b = 0; b < band; b++) {
      border.push(data[idx(x, b) * 4], data[idx(x, b) * 4 + 1], data[idx(x, b) * 4 + 2]);
      border.push(data[idx(x, h - 1 - b) * 4], data[idx(x, h - 1 - b) * 4 + 1], data[idx(x, h - 1 - b) * 4 + 2]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let b = 0; b < band; b++) {
      border.push(data[idx(b, y) * 4], data[idx(b, y) * 4 + 1], data[idx(b, y) * 4 + 2]);
      border.push(data[idx(w - 1 - b, y) * 4], data[idx(w - 1 - b, y) * 4 + 1], data[idx(w - 1 - b, y) * 4 + 2]);
    }
  }
  const median3 = (arr: number[]): [number, number, number] => {
    const pick = (off: number) => {
      const vals = arr.filter((_, i) => i % 3 === off).sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)] ?? 0;
    };
    return [pick(0), pick(1), pick(2)];
  };
  const [bgR, bgG, bgB] = median3(border);

  const edge = new Float32Array(n);
  const colorDist = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      const p = i * 4;
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      colorDist[i] = Math.abs(data[p] - bgR) + Math.abs(data[p + 1] - bgG) + Math.abs(data[p + 2] - bgB);
    }
  }
  // Sobel（仅内圈：边界外没有真实像素，零填充会在四边产生整圈假边缘，
  // 膨胀后会把画面边缘误判为主体——边界像素 edge 保持 0）
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const g = (xx: number, yy: number) => gray[idx(xx, yy)];
      const gx =
        g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1) -
        g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1);
      const gy =
        g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1) -
        g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1);
      edge[idx(x, y)] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  const normalize = (arr: Float32Array): Float32Array => {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, arr[i]);
    if (max <= 0) return new Float32Array(n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = arr[i] / max;
    return out;
  };
  const edgeN = normalize(edge);
  const colorN = normalize(colorDist);

  // 中心先验：离中心越远权重越低（主体多在画面中部/三分位）
  const cx = w / 2;
  const cy = h / 2;
  const sigma = Math.max(w, h) * 0.55;
  const score = new Float32Array(n);
  let scoreMean = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const prior = 0.6 + 0.4 * Math.exp(-d2 / (2 * sigma * sigma));
      score[i] = (0.55 * edgeN[i] + 0.45 * colorN[i]) * prior;
      scoreMean += score[i];
    }
  }
  scoreMean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (score[i] - scoreMean) ** 2;
  const std = Math.sqrt(variance / n);
  const threshold = scoreMean + 0.8 * std;

  // 二值主体图 + 最大值滤波膨胀（半径 4，两轮闭合成块）
  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array(n);
  let subject = 0;
  for (let i = 0; i < n; i++) {
    bin[i] = score[i] > threshold ? 1 : 0;
    subject += bin[i];
  }
  const dilate = (src: Uint8Array, r: number): Uint8Array => {
    const out = new Uint8Array(n);
    // 可分离两趟 max（水平+垂直）近似方形结构元
    const tmp = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let d = -r; d <= r && !m; d++) {
          const xx = x + d;
          if (xx >= 0 && xx < w && src[idx(xx, y)]) m = 1;
        }
        tmp[idx(x, y)] = m;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let d = -r; d <= r && !m; d++) {
          const yy = y + d;
          if (yy >= 0 && yy < h && tmp[idx(x, yy)]) m = 1;
        }
        out[idx(x, y)] = m;
      }
    }
    return out;
  };
  bin = dilate(dilate(bin, 4), 3);

  // 盒模糊软化边缘（半径 2），输出 alpha：主体 → 0（文字不可见），背景 → 255
  const blurR = 2;
  const alpha = new Uint8ClampedArray(n);
  let covered = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -blurR; dy <= blurR; dy++) {
        for (let dx = -blurR; dx <= blurR; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += bin[idx(xx, yy)];
          cnt++;
        }
      }
      const v = 1 - sum / cnt;
      alpha[idx(x, y)] = Math.round(v * 255);
      if (v < 0.5) covered++;
    }
  }
  return {alpha, coverage: covered / n};
};

/** DOM 封装：帧图（data URL）→ 主体 mask PNG data URL（与输入同纵横比）。失败抛中文错误 */
export const computeSubjectMaskFromImage = async (
  frameDataUrl: string,
): Promise<{maskDataUrl: string; coverage: number}> => {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('主体检测：帧图片加载失败'));
    el.src = frameDataUrl;
  });
  // 处理分辨率：长边压到 320（检测够用，mask 被封面拉伸到全幅）
  const scale = Math.min(1, 320 / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (!ctx) throw new Error('主体检测：画布不可用');
  ctx.drawImage(img, 0, 0, w, h);
  const frame = ctx.getImageData(0, 0, w, h);

  const {alpha, coverage} = computeSubjectAlpha(frame.data, w, h);
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    out.data[i * 4] = 255;
    out.data[i * 4 + 1] = 255;
    out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = alpha[i];
  }
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  maskCanvas.getContext('2d')!.putImageData(out, 0, 0);
  return {maskDataUrl: maskCanvas.toDataURL('image/png'), coverage};
};
