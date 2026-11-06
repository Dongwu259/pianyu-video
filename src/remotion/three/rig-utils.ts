/**
 * 3D 模板路径相机共用数学工具（帧驱动确定性：全部纯函数，禁 Clock/delta）
 * 从 CameraJourney3D 抽出，GalleryHall3D/OrbitCarousel3D/TimeTunnel3D 同款复用。
 */
import * as THREE from 'three';

/** smoothstep（帧插值统一缓动） */
export const sm = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** smootherstep（五次缓动：起止的一阶/二阶导全为零，加减速比 smoothstep 柔得多） */
export const smx = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * 相机速度曲线三档（camEase 参数；用户要求「动静切换有明显加减速」）：
 * 0 干脆 = smoothstep（轻缓动，峰值速度 1.5× 均值）
 * 1 标准缓动 = 三次 ease-in-out（起止各约 1/3 行程在加/减速，峰值 3× 均值——加速减速肉眼可见）
 * 2 慢起慢停 = 五次 ease-in-out（起止速度近零的时间更长，峰值 5× 均值——最明显的慢起慢停）
 * 三档在 t=0/1 处速度均为零（travel→dwell 边界速度连续，无急停感）。
 */
export const easeCam = (t: number, personality: number): number => {
  const a = Math.min(2, Math.max(0, personality));
  const x = Math.min(1, Math.max(0, t));
  if (a < 0.5) return sm(t);
  if (a < 1.5) return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  return x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2;
};

/** 镜头速度档位（camSpeed 参数）：行程弧度 / 推送距离 / 开场进深的多重缩放 */
export const CAM_SPEED = [0.74, 1, 1.26];

/**
 * 甩头时长倍率（camSpeed → travel 段时长）：v26 前 camSpeed 只缩推送距离，
 * 甩头（travel）快慢完全由段时长÷板数决定——「舒缓」档拉长 travel 时间才是真正的慢
 * （喂 panel-timeline.buildPanelTimeline 的 travelScale）。
 */
export {SLOT_CAM_SPEED_TRAVEL as CAM_SPEED_TRAVEL, slotTravelScaleOf as travelScaleOf} from '../../shared/template-slot-windows';

/**
 * 场景主题色预设（themeColor 参数）：0 = 跟随品牌色（brandColor），
 * 1-5 = 青碧 / 罗兰紫 / 琥珀金 / 玫红 / 翠绿（暗场景友好的高饱和档）。
 * 用法：accent = themeColor > 0 ? THEME_ACCENTS[themeColor] : (brandColor || '#3B82F6')
 */
export const THEME_ACCENTS = ['#3B82F6', '#22D3EE', '#A78BFA', '#FBBF24', '#FB7185', '#34D399'];

/** hex 混色（背景 tint 用：深底色向主题色轻混 ratio） */
export const mixHex = (base: string, tint: string, ratio: number): string => {
  const p = (h: string): number => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h);
    return m ? parseInt(m[1], 16) : 0;
  };
  const a = p(base);
  const b = p(tint);
  const ch = (shift: number): number =>
    Math.round(((a >> shift) & 255) * (1 - ratio) + ((b >> shift) & 255) * ratio);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
};

/**
 * 站级确定性微差（整数 → 0..1，逐帧渲染可复现）：每站行程弧度 / 推送量轻微错开，
 * 破「每站一模一样」的节拍器感。salt 区分用途（行程/推送取不同伪随机序列）。
 */
export const stationJitter = (i: number, salt: number): number => {
  let h = (Math.imul(i + 1, 2654435761) + Math.imul(salt + 1, 40503)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h >>> 8) % 1000) / 1000;
};

/** 二次贝塞尔（travel 注视点：上一焦点 → 中间导向点 → 下一焦点） */
export const quadBezier = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 => {
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const c = t * t;
  return out.set(a * p0.x + b * p1.x + c * p2.x, a * p0.y + b * p1.y + c * p2.y, a * p0.z + b * p1.z + c * p2.z);
};

/** 内容哈希 → 数值（布局 seed 派生用；同文案同布局，逐帧渲染可复现） */
export const hashSeed = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
