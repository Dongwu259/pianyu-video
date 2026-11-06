/**
 * 元素截图模式 + 双底抠图（capture_element 的渲染端核心）
 *
 * 两个工程约束决定了实现方式：
 * 1. 应用窗口是不透明的（Electron 默认），CDP omitBackground 得不到真透明——
 *    解法：同一元素分别在纯白/纯黑底上各截一张，逐像素解算 alpha（双底抠图）：
 *      C_white = α·F + (1-α)·255，C_black = α·F
 *      → α = 1 - (C_white - C_black)/255，F = C_black / α
 * 2. 全局 `transition: all` 会让 inline 的 visibility:hidden 延迟 0.2-0.3s 才生效——
 *    解法：进入截图模式时注入 * { transition: none !important; animation: none !important; }
 *    冻结动画，否则隐藏指令在截取瞬间还没应用完（computed 仍为 visible）。
 *
 * 流程：enterElementCaptureMode(el, bg) → CDP 截 → 换底色再截 → restore() →
 * matteTwoPass(白底图, 黑底图) → 透明 PNG（自动裁掉全透明边）。
 */

/** 进入元素截图模式：只留目标元素（含祖先链/后代），其余隐藏；bg = 兜底底色（'white' | 'black'） */
export const enterElementCaptureMode = (el: HTMLElement, bg: 'white' | 'black'): (() => void) => {
  const touched: {node: HTMLElement; visibility: string; background: string; boxShadow: string}[] = [];
  const remember = (node: HTMLElement) => {
    touched.push({node, visibility: node.style.visibility, background: node.style.background, boxShadow: node.style.boxShadow});
  };

  // 冻结过渡/动画：否则 visibility 变化被 transition 离散动画拖延，截取瞬间还没生效
  const freeze = document.createElement('style');
  freeze.textContent = '* { transition: none !important; animation: none !important; }';
  document.head.appendChild(freeze);

  const html = document.documentElement;
  const body = document.body;
  remember(html);
  remember(body);
  const bgColor = bg === 'white' ? '#ffffff' : '#000000';
  html.style.background = bgColor;
  body.style.background = bgColor;

  // 全量隐藏（inline visibility 覆盖继承；之后再点亮目标链路）
  const all = body.querySelectorAll('*');
  all.forEach((node) => {
    const he = node as HTMLElement;
    remember(he);
    he.style.visibility = 'hidden';
  });

  // 点亮目标 + 祖先链（祖先背景/投影清掉，保持版式但露出兜底底色）
  let node: Element | null = el;
  while (node && node !== html) {
    const he = node as HTMLElement;
    he.style.visibility = 'visible';
    if (he !== el && he !== body) {
      he.style.background = 'transparent';
      he.style.boxShadow = 'none';
    }
    node = node.parentElement;
  }
  // 点亮目标的后代（目标自身样式保留——那是它的外观）
  el.querySelectorAll('*').forEach((d) => {
    (d as HTMLElement).style.visibility = 'visible';
  });

  return () => {
    freeze.remove();
    for (const {node: n, visibility, background, boxShadow} of touched) {
      n.style.visibility = visibility;
      n.style.background = background;
      n.style.boxShadow = boxShadow;
    }
  };
};

/** 等两帧让样式 flush 到合成器 */
export const nextFrames = (n = 2): Promise<void> =>
  new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('底图解码失败'));
    img.src = dataUrl;
  });

export interface MatteResult {
  /** 透明 PNG 的字节（toBlob 产出） */
  pngBytes: ArrayBuffer;
  /** 预览用 JPEG dataUrl（透明区合成到白底，仅供看图） */
  previewDataUrl: string;
  /** 抠图+自动裁边后的尺寸 */
  width: number;
  height: number;
}

/**
 * 双底抠图：whiteData / blackData 为同一区域在白/黑底上的 PNG base64（不含 mime 前缀也可）。
 * 逐像素解 α 与去预乘颜色，再按 alpha 包围盒自动裁边（吸收 clip 亚像素对齐误差）。
 */
export const matteTwoPass = async (whiteData: string, blackData: string): Promise<MatteResult> => {
  const toUrl = (d: string) => (d.startsWith('data:') ? d : `data:image/png;base64,${d}`);
  const [imgW, imgB] = await Promise.all([loadImage(toUrl(whiteData)), loadImage(toUrl(blackData))]);
  const w = Math.min(imgW.naturalWidth, imgB.naturalWidth);
  const h = Math.min(imgW.naturalHeight, imgB.naturalHeight);
  if (w < 2 || h < 2) throw new Error('底图尺寸异常');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (!ctx) throw new Error('canvas 2d 不可用');
  ctx.drawImage(imgW, 0, 0, w, h);
  const dataW = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(imgB, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const dataB = imgData.data;
  const out = imgData.data;

  // α = 1 - (Cw - Cb)/255（逐通道平均）；F = Cb/α（去预乘，钳 0-255）
  for (let i = 0; i < out.length; i += 4) {
    const dr = dataW[i] - dataB[i];
    const dg = dataW[i + 1] - dataB[i + 1];
    const db = dataW[i + 2] - dataB[i + 2];
    const alpha = 255 - (dr + dg + db) / 3;
    if (alpha <= 2) {
      out[i] = out[i + 1] = out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    const a = alpha / 255;
    out[i] = Math.min(255, Math.round(dataB[i] / a));
    out[i + 1] = Math.min(255, Math.round(dataB[i + 1] / a));
    out[i + 2] = Math.min(255, Math.round(dataB[i + 2] / a));
    out[i + 3] = Math.round(alpha);
  }

  // alpha 包围盒自动裁边
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (out[(y * w + x) * 4 + 3] > 4) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('抠图结果全透明（目标元素可能不可见）');
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  // 写出裁边后的 PNG
  ctx.putImageData(imgData, 0, 0);
  const cropped = document.createElement('canvas');
  cropped.width = cw;
  cropped.height = ch;
  const cctx = cropped.getContext('2d');
  if (!cctx) throw new Error('canvas 2d 不可用');
  cctx.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  const pngBytes: ArrayBuffer = await new Promise((resolve, reject) =>
    cropped.toBlob((b) => (b ? b.arrayBuffer().then(resolve) : reject(new Error('PNG 编码失败'))), 'image/png'),
  );

  // 预览图：透明区铺白底再导 JPEG（看图模型对透明底不友好）
  const pv = document.createElement('canvas');
  const pvScale = Math.min(1, 1280 / Math.max(cw, ch));
  pv.width = Math.round(cw * pvScale);
  pv.height = Math.round(ch * pvScale);
  const pctx = pv.getContext('2d');
  if (pctx) {
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, pv.width, pv.height);
    pctx.drawImage(cropped, 0, 0, pv.width, pv.height);
  }
  return {pngBytes, previewDataUrl: pv.toDataURL('image/jpeg', 0.72), width: cw, height: ch};
};
