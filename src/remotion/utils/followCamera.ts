/**
 * 鼠标跟随运镜 - 纯函数（CursorFollow 模板的相机数学，与 React/Remotion 解耦便于单测）
 *
 * 坐标系：视频像素坐标（与录屏轨迹 CursorPoint 同一坐标系）。
 * 相机模型：视频元素中心锚定在画布中心，施加 translate（画布 px）+ scale（中心缩放）；
 * translate 钳位保证缩放后的视频始终覆盖整个画布（不露背景）。
 */

import type {CursorClick, CursorPoint} from '../../shared/capture';

/** 轨迹采样：t 毫秒处的光标位置（相邻点线性插值；超出范围钳到首/末点；空轨迹回 (0,0)） */
export const sampleTrack = (points: CursorPoint[], tMs: number): {x: number; y: number} => {
  if (points.length === 0) return {x: 0, y: 0};
  const first = points[0];
  const last = points[points.length - 1];
  if (tMs <= first.t) return {x: first.x, y: first.y};
  if (tMs >= last.t) return {x: last.x, y: last.y};
  // 二分定位 t 所在区间 [points[lo], points[hi]]
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.t - a.t;
  const q = span > 0 ? (tMs - a.t) / span : 0;
  return {x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q};
};

/** 每帧注视点（视频像素坐标） */
export interface FollowCameraPoint {
  cx: number;
  cy: number;
}

export interface FollowCameraPathOptions {
  /** 平滑窗口（秒）：对每帧 ±smoothSec/2 窗口内的采样做滑动平均 */
  smoothSec: number;
  /** 轨迹查询的时间偏移（毫秒）：视频从 trimStart 起播时传 trimStart×1000 */
  offsetMs?: number;
  /** 逐帧媒体时间（毫秒）查表：挖段（cuts）时时间轴→媒体时间为分段映射，
   *  线性 offsetMs 无法表达；给出后 offsetMs 被忽略 */
  mediaMsAt?: (frame: number) => number;
}

/**
 * 生成 [0, durationFrames) 每帧的注视点：
 * 先按帧采样轨迹（帧 f → t = offsetMs + f×1000/fps），再做居中滑动平均平滑。
 * 平滑是渲染期离线计算，可以用「未来」的采样（非因果），两端窗口截断按可得点平均。
 */
export const followCameraPath = (
  points: CursorPoint[],
  durationFrames: number,
  fps: number,
  {smoothSec, offsetMs = 0, mediaMsAt}: FollowCameraPathOptions,
): FollowCameraPoint[] => {
  const n = Math.max(0, Math.floor(durationFrames));
  const raw: FollowCameraPoint[] = [];
  for (let f = 0; f < n; f++) {
    const p = sampleTrack(points, mediaMsAt ? mediaMsAt(f) : offsetMs + (f * 1000) / fps);
    raw.push({cx: p.x, cy: p.y});
  }
  const half = Math.max(0, Math.round((smoothSec * fps) / 2));
  if (half === 0 || n === 0) return raw;
  // 前缀和做 O(n) 滑动平均
  const sumX: number[] = [0];
  const sumY: number[] = [0];
  for (let f = 0; f < n; f++) {
    sumX.push(sumX[f] + raw[f].cx);
    sumY.push(sumY[f] + raw[f].cy);
  }
  return raw.map((_, f) => {
    const a = Math.max(0, f - half);
    const b = Math.min(n - 1, f + half);
    const count = b - a + 1;
    return {cx: (sumX[b + 1] - sumX[a]) / count, cy: (sumY[b + 1] - sumY[a]) / count};
  });
};

/** 一帧相机参数：scale = 视频元素缩放倍率（中心锚定），translateX/Y = 画布像素平移 */
export interface CameraFrame {
  scale: number;
  translateX: number;
  translateY: number;
}

// ====== 点击自动运镜 ======

/** 点击包络参数 */
export interface ClickZoomOptions {
  /** 点击放大倍率（直接值，≥1；与基础 zoom 相乘） */
  clickZoom: number;
  /** 放大保持时长（秒） */
  holdSec: number;
  /** 缓入/缓出时长（秒） */
  easeSec: number;
}

/** 某时刻的点击运镜状态 */
export interface ClickZoomState {
  /** 0..1 包络强度（0 = 无点击影响） */
  amount: number;
  /** 叠加在基础 zoom 上的乘数（1 = 无影响） */
  boost: number;
  /** 激活中的点击（视频像素坐标）；amount = 0 时为 null */
  click: CursorClick | null;
}

/** 光滑步进（smoothstep）：两端导数为 0 的 S 曲线 */
const smoothstep = (q: number): number => {
  const x = Math.min(1, Math.max(0, q));
  return x * x * (3 - 2 * x);
};

/**
 * 点击自动运镜包络（纯函数）：tMs 为与轨迹同一零点的全局毫秒。
 * 取 tMs 之前最近一次点击：缓入 easeSec → 保持 holdSec → 缓出 easeSec；
 * 新点击到达即接管（dt 重置）；包络结束后 amount 归 0（画面回到轨迹跟随）。
 * 与轨迹注视点的融合由调用方按 amount 插值；与基础 zoom 按 boost 相乘。
 */
export const clickZoomEnvelope = (
  clicks: CursorClick[],
  tMs: number,
  {clickZoom, holdSec, easeSec}: ClickZoomOptions,
): ClickZoomState => {
  const idle: ClickZoomState = {amount: 0, boost: 1, click: null};
  if (clicks.length === 0) return idle;
  // 最近一次不晚于 tMs 的点击（数组按时间有序，二分/倒扫皆可；量级小直接倒扫）
  let active: CursorClick | null = null;
  for (let i = clicks.length - 1; i >= 0; i--) {
    if (clicks[i].t <= tMs) {
      active = clicks[i];
      break;
    }
  }
  if (!active) return idle;
  const dt = (tMs - active.t) / 1000;
  const ease = Math.max(0.05, easeSec);
  const hold = Math.max(0, holdSec);
  let amount: number;
  if (dt < ease) amount = smoothstep(dt / ease);
  else if (dt < ease + hold) amount = 1;
  else if (dt < ease * 2 + hold) amount = 1 - smoothstep((dt - ease - hold) / ease);
  else return idle;
  const zoom = Math.max(1, clickZoom);
  return {amount, boost: 1 + (zoom - 1) * amount, click: active};
};

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** -0 归一化为 0（避免下游严格相等比较 / JSON 序列化出现负零） */
const normZero = (v: number): number => (v === 0 ? 0 : v);

/**
 * 3D 倾斜的覆盖补偿倍率（数值解）。
 *
 * 问题：画布尺寸的平面绕中心做 rotateZ(tiltZ)∘rotateX(tiltX)（CSS 变换链 = Rx·Rz）
 * 并经 perspective 投影后，其投影四边形未必还能盖住画布（透视压缩远比正交 cos 近似狠，
 * 尤其画布角点）。本函数二分求最小的 k：把平面放大到 k×画布尺寸后，
 * 投影四边形包含全部 4 个画布角点（k=1 且两角为 0 时直接返回 1）。
 *
 * 单调性：投影前的同心放大保持集合包含，单应变换保持包含关系；
 * 角点越过投影面（z ≥ P，投影发散）时把透视系数钳到 1e6（等价于"该角投影到无穷远，
 * 四边形巨大必含画布"），保证二分谓词单调。
 */
export const tiltCoverFactor = (
  tiltXDeg: number,
  tiltZDeg: number,
  perspective: number,
  canvasW: number,
  canvasH: number,
  tiltYDeg = 0,
): number => {
  if (tiltXDeg === 0 && tiltZDeg === 0 && tiltYDeg === 0) return 1;
  const rx = (tiltXDeg * Math.PI) / 180;
  const rz = (tiltZDeg * Math.PI) / 180;
  const ry = (tiltYDeg * Math.PI) / 180;
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);

  /** k×画布尺寸的平面 4 角点经 rotateZ → rotateY → rotateX → perspective 投影后的屏幕坐标
   *  （与 CSS 变换链 rotateX() rotateY() rotateZ() 的右到左作用序一致） */
  const project = (k: number): {x: number; y: number}[] => {
    const hw = (canvasW * k) / 2;
    const hh = (canvasH * k) / 2;
    return [
      {x: -hw, y: -hh},
      {x: hw, y: -hh},
      {x: hw, y: hh},
      {x: -hw, y: hh},
    ].map(({x, y}) => {
      const x1 = x * cosZ - y * sinZ;
      const y1 = x * sinZ + y * cosZ;
      // rotateY（绕竖直轴，平面初始 z=0）：x 压缩 + 产生深度；CSS 正角 = 右侧转向屏幕深处
      const x2 = x1 * cosY;
      const zA = -x1 * sinY;
      const y2 = y1 * cosX;
      const zB = y1 * sinX;
      const s = Math.min(perspective / (perspective - zA - zB), 1e6);
      return {x: x2 * s, y: y2 * s};
    });
  };

  /** 凸四边形包含测试（4 条边叉积同号） */
  const inQuad = (px: number, py: number, q: {x: number; y: number}[]): boolean => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (cross !== 0) {
        const s = Math.sign(cross);
        if (sign === 0) sign = s;
        else if (s !== sign) return false;
      }
    }
    return true;
  };

  const corners = [
    {x: -canvasW / 2, y: -canvasH / 2},
    {x: canvasW / 2, y: -canvasH / 2},
    {x: canvasW / 2, y: canvasH / 2},
    {x: -canvasW / 2, y: canvasH / 2},
  ];
  // 二分上界：任一平面角点深度 z(k)=k·coef 触及投影面（z=P）前，投影四边形才是凸且有界的；
  // 越界后钳制会扭曲四边形使谓词失真（非单调）。hi 钳在 P·0.95 / maxCoef，
  // 极端角度在该上界仍不含画布角点时返回上界尽力而为（几何上已近投影极限）。
  let hi = 12;
  for (const c of corners) {
    const x1 = c.x * cosZ - c.y * sinZ;
    const y1 = c.x * sinZ + c.y * cosZ;
    const coef = -x1 * sinY + y1 * sinX;
    if (coef > 1e-9) hi = Math.min(hi, (perspective * 0.95) / coef);
  }
  let lo = 1;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    const quad = project(mid);
    if (corners.every((c) => inQuad(c.x, c.y, quad))) hi = mid;
    else lo = mid;
  }
  return hi;
};

/**
 * 计算一帧相机：让视频像素点 (cx, cy) 落在画布中心，整体在 cover 基准上放大 zoom 倍。
 * 平移钳位：缩放后视频显示宽高不足画布时居中（平移取 0），否则钳到不露边的范围。
 */
export const cameraFrame = (
  cx: number,
  cy: number,
  videoW: number,
  videoH: number,
  zoom: number,
  canvasW: number,
  canvasH: number,
): CameraFrame => {
  // cover 基准倍率（视频恰好铺满画布）；zoom 在此基础上放大
  const scale = Math.max(canvasW / videoW, canvasH / videoH) * zoom;
  const w = videoW * scale;
  const h = videoH * scale;
  // 注视点移到画布中心所需的平移（视频中心锚定画布中心，再反向移回注视点偏移）
  const tx = -(cx - videoW / 2) * scale;
  const ty = -(cy - videoH / 2) * scale;
  // 覆盖钳位：|t| ≤ (显示尺寸 - 画布尺寸) / 2，保证视频始终铺满画布不露背景
  const maxTx = Math.max(0, (w - canvasW) / 2);
  const maxTy = Math.max(0, (h - canvasH) / 2);
  return {
    scale,
    translateX: normZero(clamp(tx, -maxTx, maxTx)),
    translateY: normZero(clamp(ty, -maxTy, maxTy)),
  };
};

/**
 * 相机帧直接混合（锚点防漂移，B 项）：两端相机帧的 translate（像素）与 scale 按 q 同参
 * 线性插值——每个内容点的屏幕位置是 q 的仿射函数（直线段），兴趣点从起点视图直线收敛
 * 到目标视图中心。移植自 DogSC ScreenMotion.interpolateLayout 的「rect/像素空间直接插值」
 * （github.com/laogou717/dogsc，MIT）：它的注释明说 pos×(W−scaledW) 归一化路径会
 * 「先居中放大、后漂移」。片语的旧路径把 focus 与 zoom 各自插值再交给 cameraFrame 乘
 * 出 translate——内容点屏幕偏移 = d·s₀·(1−q)(1+(k−1)q)，k=zoom×clickZoom>2 时起步先
 * 外甩再收敛（默认参数 1.4×1.8=2.52 必现）；本函数的混合形态下偏移 = d·s₀·(1−q)
 * 恒单调收敛。与导播演示 blendCam 同款语义（scale/translate 逐字段线性）。
 */
export const blendCameraFrame = (
  a: CameraFrame,
  b: CameraFrame,
  q: number,
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
): CameraFrame => {
  const t = Math.min(Math.max(q, 0), 1);
  const scale = a.scale + (b.scale - a.scale) * t;
  // 中间态覆盖重钳制：两端各自的钳制幅度不同（贴边端 |t| 被 clamp 到当时 scale 的上限），
  // 混合后的 translate 可能超出当前 scale 允许的范围（中间 scale 小于大一端）——按混合
  // scale 的上限再钳一次（贴边区间本就是贴边运动，直线性质只在自由区间成立，无碍观感）
  const w = videoW * scale;
  const h = videoH * scale;
  const maxTx = Math.max(0, (w - canvasW) / 2);
  const maxTy = Math.max(0, (h - canvasH) / 2);
  return {
    scale,
    translateX: normZero(clamp(a.translateX + (b.translateX - a.translateX) * t, -maxTx, maxTx)),
    translateY: normZero(clamp(a.translateY + (b.translateY - a.translateY) * t, -maxTy, maxTy)),
  };
};

/**
 * 可视跨度 → 相机 zoom 换算（v9 竖版反馈新增参数 viewSpan 的数学）。
 *
 * span = 沿宽度轴可见的视频占比（0.55 = 画面里恰好看到 55% 宽的录屏内容），
 * 窗口内容以平滑光标为中心（跟随相机原生钳位保证窗口不越出视频边界）。
 * span ≤ 0.01 视为关闭，返回 0（调用方回退 zoom 参数）。
 * 换算：zoom = (planeW/(span·videoW)) / coverBase——coverBase = 平面 cover 基准倍率，
 * 与 cameraFrame 的 scale = coverBase × zoom 同一口径。
 */
export const spanToZoom = (
  span: number,
  planeW: number,
  planeH: number,
  videoW: number,
  videoH: number,
): number => {
  if (!(span > 0.01)) return 0;
  if (!(planeW > 0) || !(planeH > 0) || !(videoW > 0) || !(videoH > 0)) return 0;
  const coverBase = Math.max(planeW / videoW, planeH / videoH);
  return planeW / (span * videoW) / coverBase;
};

// ====== 垂直引导跟随（B3，随变临摹复盘） ======

/** 垂直引导档位系数：0 关 / 1 弱 / 2 强——注视点偏离纵向中线时预留的前进空间比例 */
export const LEAD_TIER_K = [0, 0.18, 0.32];

/**
 * 垂直引导（lead room）注视点偏置（纯函数）：跟随相机不做中心跟随——
 * 注视点在上半区时相机中心下移（下方留白更大，预留向下运动的空间），下半区反之
 * （随变样片的跟随手感：指针在上时下面空间留大一点，在下时上面空间大一些）。
 * 偏置量 = k × (0.5 − 注视点纵向归一) × 当前可见视频高度：zoom 越深可见越少、
 * 偏置越克制；出界由 cameraFrame 的覆盖钳位兜底（贴边时偏置自然失效）。
 * 平滑不在这里做——注视点本身已经过 followCameraPath 滑动平均，偏置随之平滑。
 */
export const leadFocusY = (
  cy: number,
  videoH: number,
  scale: number,
  planeH: number,
  tier: number,
): number => {
  const k = LEAD_TIER_K[Math.min(2, Math.max(0, Math.round(tier)))] ?? 0;
  if (k <= 0 || !(videoH > 0) || !(scale > 0) || !(planeH > 0)) return cy;
  const visibleH = planeH / scale;
  const norm = Math.min(1, Math.max(0, cy / videoH));
  return cy + k * (0.5 - norm) * visibleH;
};
