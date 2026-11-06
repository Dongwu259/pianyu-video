/**
 * 素材录制构图（纯几何，渲染端采集与单元测试共用）
 *
 * 屏幕与摄像头一起录制时不再只有画中画一种烧录方式，而是独立的画面构成：
 * - pip    摄像头圆角画中画叠在屏幕角落（沿用原有观感）
 * - side   屏幕与摄像头左右并排（等高拼接，中间留缝）
 * - stack  屏幕与摄像头上下堆叠（等宽拼接）
 * - camera 仅摄像头全画幅（口播出镜素材，不录屏幕画面）
 *
 * 输出画布尺寸与两路画面的落位矩形都在这里一次算清（偶数取整，编码器友好），
 * 采集侧只负责把视频帧画进矩形；轨迹/点击坐标只在画面与屏幕 1:1 的构图
 * （纯屏幕/画中画）下才有意义，其余构图采集侧跳过鼠标轨迹。
 */

/** 画面构成（素材录制的烧录方式） */
export type RecordingLayout = 'pip' | 'side' | 'stack' | 'camera';

/** 摄像头画中画落点预设（3×3 九宫格：四角 + 四边中点 + 正中） */
export type WebcamPreset =
  | 'topLeft' | 'topCenter' | 'topRight'
  | 'middleLeft' | 'center' | 'middleRight'
  | 'bottomLeft' | 'bottomCenter' | 'bottomRight';

/** 画中画窗口中心的归一化位置（0-1，x 向右 y 向下；自定义拖拽的落点，越界会被钳回画布内） */
export interface WebcamPosition {
  x: number;
  y: number;
}

/** 摄像头画中画尺寸档（占输出画面短边比例） */
export type WebcamSize = 'small' | 'medium' | 'large';

/** 画中画尺寸档：长边占输出画面短边比例 */
export const WEBCAM_SIZE_RATIO: Record<WebcamSize, number> = {small: 0.18, medium: 0.24, large: 0.3};

/** 九宫格预设 → 锚点（0 = 靠左/上，0.5 = 居中，1 = 靠右/下） */
const PIP_PRESET_ANCHORS: Record<WebcamPreset, {ax: 0 | 0.5 | 1; ay: 0 | 0.5 | 1}> = {
  topLeft: {ax: 0, ay: 0},
  topCenter: {ax: 0.5, ay: 0},
  topRight: {ax: 1, ay: 0},
  middleLeft: {ax: 0, ay: 0.5},
  center: {ax: 0.5, ay: 0.5},
  middleRight: {ax: 1, ay: 0.5},
  bottomLeft: {ax: 0, ay: 1},
  bottomCenter: {ax: 0.5, ay: 1},
  bottomRight: {ax: 1, ay: 1},
};

/**
 * 预设落点 → 归一化中心位置（预设与自定义共用同一坐标系，UI 切预设即换算成位置）。
 * 边角/边中预设离画布边缘留短边 3% 边距；正中/中点预设精确居中。
 */
export const pipPresetPosition = (
  preset: WebcamPreset,
  out: {width: number; height: number},
  rect: {width: number; height: number},
): WebcamPosition => {
  const {ax, ay} = PIP_PRESET_ANCHORS[preset];
  const margin = Math.round(Math.min(out.width, out.height) * 0.03);
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  return {
    x: clamp(ax === 0 ? margin + rect.width / 2 : ax === 1 ? out.width - margin - rect.width / 2 : out.width / 2, rect.width / 2, out.width - rect.width / 2) / out.width,
    y: clamp(ay === 0 ? margin + rect.height / 2 : ay === 1 ? out.height - margin - rect.height / 2 : out.height / 2, rect.height / 2, out.height - rect.height / 2) / out.height,
  };
};

export const RECORDING_LAYOUTS: RecordingLayout[] = ['pip', 'side', 'stack', 'camera'];

/** 构图的中文显示名（确认卡 / 状态回报用） */
export const RECORDING_LAYOUT_LABEL: Record<RecordingLayout, string> = {
  pip: '摄像头画中画',
  side: '左右分屏（屏幕 + 摄像头）',
  stack: '上下分屏（屏幕 + 摄像头）',
  camera: '仅摄像头',
};

/** 输出画布上的落位矩形（像素） */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputeLayoutArgs {
  /** 画面构成；缺省 = 纯屏幕（无摄像头参与）。摄像头不可用（未开/流中断）时自动降级为纯屏幕 */
  layout?: RecordingLayout;
  /** 屏幕画面尺寸（选区录制时 = 选区尺寸） */
  screen: {width: number; height: number};
  /** 摄像头尺寸；未开启摄像头为 null/缺省 */
  camera?: {width: number; height: number} | null;
  /** 画中画窗口中心位置（归一化 0-1；仅 pip 构图生效，缺省右下预设，越界钳回画布内） */
  pipPosition?: WebcamPosition;
  /** 画中画尺寸档（仅 pip 构图生效，缺省中） */
  size?: WebcamSize;
  /** 输出高度上限（像素）：输出更高时等比缩小（宽同比例、偶数取整），更矮时不放大 */
  maxHeight?: number;
}

export interface RecordingLayoutResult {
  /** 实际生效构图：无摄像头参与时降级为 'screen'（纯屏幕） */
  layout: RecordingLayout | 'screen';
  outWidth: number;
  outHeight: number;
  /** 屏幕画面落位（camera 构图为 null） */
  screenRect: LayoutRect | null;
  /** 摄像头画面落位（纯屏幕为 null） */
  cameraRect: LayoutRect | null;
  /** 摄像头是否走圆角 + 描边样式（仅画中画叠加；分屏/全画幅为直角硬边） */
  cameraRounded: boolean;
}

const evenFloor = (v: number): number => Math.max(0, Math.floor(v / 2) * 2);

/** 高度上限规整：超过上限等比缩小到上限，否则保持（均偶数取整；保证 ≥2 保证画布有效） */
const capSize = (
  width: number,
  height: number,
  maxHeight?: number,
): {width: number; height: number} => {
  const safe = (w: number, h: number): {width: number; height: number} => ({
    width: Math.max(2, evenFloor(w)),
    height: Math.max(2, evenFloor(h)),
  });
  if (!maxHeight || !(height > 0) || height <= maxHeight) return safe(width, height);
  const scale = maxHeight / height;
  return safe(width * scale, maxHeight);
};

/**
 * 计算素材录制的构图几何。
 *
 * - 纯屏幕 / pip：输出 = 屏幕（选区）尺寸经 maxHeight 规整；pip 在四角叠加圆角小窗。
 * - side：两路等高拼接，宽度按各自宽高比分摊，中间留 2% 短边（≥4px）黑缝。
 * - stack：两路等宽上下拼接，缝同上。
 * - camera：输出 = 摄像头尺寸经 maxHeight 规整，屏幕不参与。
 * 摄像头缺失时任何构图都降级为纯屏幕（录制不因摄像头中断而失败）。
 */
export const computeRecordingLayout = (args: ComputeLayoutArgs): RecordingLayoutResult => {
  const screenW = args.screen.width > 0 ? args.screen.width : 1920;
  const screenH = args.screen.height > 0 ? args.screen.height : 1080;
  const cam = args.camera ?? null;
  // 摄像头不可用：一律降级纯屏幕（画面主体不能丢）
  if (!cam || !(cam.width > 0) || !(cam.height > 0) || !args.layout) {
    const out = capSize(screenW, screenH, args.maxHeight);
    return {
      layout: 'screen',
      outWidth: out.width,
      outHeight: out.height,
      screenRect: {x: 0, y: 0, width: out.width, height: out.height},
      cameraRect: null,
      cameraRounded: false,
    };
  }
  const camW = cam.width;
  const camH = cam.height;

  if (args.layout === 'camera') {
    const out = capSize(camW, camH, args.maxHeight);
    return {
      layout: 'camera',
      outWidth: out.width,
      outHeight: out.height,
      screenRect: null,
      cameraRect: {x: 0, y: 0, width: out.width, height: out.height},
      cameraRounded: false,
    };
  }

  if (args.layout === 'side' || args.layout === 'stack') {
    // 等高（side）/ 等宽（stack）拼接：缝 = 拼接方向基边 2%（≥4px），计入总尺寸后统一过高度上限
    const base = args.layout === 'side' ? screenH : screenW;
    const gap = Math.max(4, evenFloor(base * 0.02));
    if (args.layout === 'side') {
      // 等高 H=screenH：屏宽 = screenW，摄像头宽 = camW·H/camH
      const out = capSize(screenW + (camW * screenH) / camH + gap, screenH, args.maxHeight);
      const wS = evenFloor((screenW * out.height) / screenH);
      const wC = evenFloor((camW * out.height) / camH);
      // 取整误差归入缝；缝不足 2px 时削摄像头宽补足，保证矩形不越出画布
      let realGap = out.width - wS - wC;
      let camW2 = wC;
      if (realGap < 2) {
        camW2 = Math.max(2, wC - (2 - realGap));
        realGap = out.width - wS - camW2;
      }
      return {
        layout: 'side',
        outWidth: out.width,
        outHeight: out.height,
        screenRect: {x: 0, y: 0, width: wS, height: out.height},
        cameraRect: {x: wS + realGap, y: 0, width: camW2, height: out.height},
        cameraRounded: false,
      };
    }
    // 等宽 W=screenW：屏高 = screenH，摄像头高 = camH·W/camW
    const out = capSize(screenW, screenH + (camH * screenW) / camW + gap, args.maxHeight);
    const wS2 = out.width;
    const hS = evenFloor((screenH * out.width) / screenW);
    const hC = evenFloor((camH * out.width) / camW);
    let realGap = out.height - hS - hC;
    let camH2 = hC;
    if (realGap < 2) {
      camH2 = Math.max(2, hC - (2 - realGap));
      realGap = out.height - hS - camH2;
    }
    return {
      layout: 'stack',
      outWidth: out.width,
      outHeight: out.height,
      screenRect: {x: 0, y: 0, width: wS2, height: hS},
      cameraRect: {x: 0, y: hS + realGap, width: out.width, height: camH2},
      cameraRounded: false,
    };
  }

  // pip：输出 = 屏幕尺寸，摄像头小窗按原始宽高比放置在指定位置（缺省右下预设）
  const out = capSize(screenW, screenH, args.maxHeight);
  const shortSide = Math.min(out.width, out.height);
  const pipLong = Math.round(shortSide * WEBCAM_SIZE_RATIO[args.size ?? 'medium']);
  const pipW = camW >= camH ? pipLong : Math.round((pipLong * camW) / camH);
  const pipH = camW >= camH ? Math.round((pipLong * camH) / camW) : pipLong;
  // 归一化位置 → 像素中心（缺省右下预设），钳制小窗完整落在画布内（自定义拖到边上不越界/不裁切）
  const pos = args.pipPosition ?? pipPresetPosition('bottomRight', out, {width: pipW, height: pipH});
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const cx = clamp(pos.x * out.width, pipW / 2, out.width - pipW / 2);
  const cy = clamp(pos.y * out.height, pipH / 2, out.height - pipH / 2);
  return {
    layout: 'pip',
    outWidth: out.width,
    outHeight: out.height,
    screenRect: {x: 0, y: 0, width: out.width, height: out.height},
    cameraRect: {x: Math.round(cx - pipW / 2), y: Math.round(cy - pipH / 2), width: pipW, height: pipH},
    cameraRounded: true,
  };
};
