/**
 * 白板画布（P2 WhiteboardCanvas）的卡片解析、布局与相机数学（纯函数，单测锚定）
 *
 * 参考片（随变 11-14s / 22-33s）最有辨识度的镜头语言：多张卡片散布在画布上，
 * 相机在卡间横移+逐卡推近+结尾拉远收全貌。卡间连接线是随变产品特点，明确不做
 * （用户裁决 2026-10-10）。
 *
 * 文案编码（features 行）：`[v]标题|副题` = 视频卡（消费 videos 中未用片段，按序）、
 * `[t]标题|副题` / 无前缀 = 文字卡。布局/相机全部确定性（无 Clock）。
 */

export interface WhiteboardCard {
  type: 'text' | 'video';
  title: string;
  sub?: string;
}

/** 解析卡片脚本：`[v]`/`[t]` 前缀 + `|` 副题分隔，封顶 6 张 */
export const parseWhiteboardCards = (features: string[], maxCards = 6): WhiteboardCard[] =>
  (features ?? [])
    .map((raw) => {
      const line = (raw ?? '').trim();
      if (!line) return null;
      const m = /^\[([a-zA-Z])\]\s*(.*)$/.exec(line);
      const type = m && m[1].toLowerCase() === 'v' ? 'video' : 'text';
      const rest = (m ? m[2] : line).trim();
      if (!rest) return null;
      const [title, sub] = rest.split('|').map((s) => s.trim());
      return {type, title, ...(sub ? {sub} : {})} as WhiteboardCard;
    })
    .filter((c): c is WhiteboardCard => c !== null)
    .slice(0, maxCards);

/** 世界平面相对画布的尺寸系数（相机以「适配宽」为全景基准；H 1.55 容三行九卡） */
export const WHITEBOARD_WORLD_W = 1.55;
export const WHITEBOARD_WORLD_H = 1.55;

/** 卡片槽位（世界归一化坐标，三行三列——v6 扩容 9 卡；错落 cy 微差保图纸感） */
const SLOTS: Array<{cx: number; cy: number}> = [
  {cx: 0.16, cy: 0.18},
  {cx: 0.5, cy: 0.14},
  {cx: 0.84, cy: 0.2},
  {cx: 0.18, cy: 0.52},
  {cx: 0.52, cy: 0.48},
  {cx: 0.85, cy: 0.54},
  {cx: 0.16, cy: 0.84},
  {cx: 0.5, cy: 0.86},
  {cx: 0.84, cy: 0.8},
];

export interface WhiteboardCardRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

/** 卡片布局：按槽位取位，尺寸按类型（视频卡 16:9 更宽，文字卡小），旋转 ±2° 微差。
 *  尺寸口径 = 三行三列九卡相切（v6 扩容：0.34 列距 0.34 恰相切、行距 0.32 vs 卡高 0.30），
 *  4-5 卡用例推近驻留仍达 ~50% 屏宽。 */
export const layoutWhiteboard = (cards: WhiteboardCard[]): WhiteboardCardRect[] =>
  cards.map((c, i) => {
    const slot = SLOTS[i % SLOTS.length];
    const w = c.type === 'video' ? 0.34 : 0.27;
    const h = c.type === 'video' ? 0.3 : 0.23;
    const rot = ((i * 37) % 5) - 2; // -2..2 度，确定性
    return {cx: slot.cx, cy: slot.cy, w, h, rot};
  });

export interface WhiteboardCam {
  scale: number;
  tx: number;
  ty: number;
}

const smoothstep = (q: number): number => {
  const x = Math.min(1, Math.max(0, q));
  return x * x * (3 - 2 * x);
};

/** 卡内驻留中点位置（段内 45% 横移 + 55% 推近驻留 → 驻留中点 = 0.725）：
 *  plan-projection deriveCardDwell 与本模块 camFor 同源共用（漂移由单测锚定） */
export const WHITEBOARD_DWELL_POS = 0.725;

/** M2 冻结接管：卡槽窗（帧域；序 = 卡序 = plan 投影 captions 序） */
export interface WhiteboardCardWindow {
  startFrame: number;
  endFrame: number;
}

/**
 * 相机时间线：每张卡一段「驻留推近」，卡间「拉宽横移」，结尾可选「拉远收全貌」。
 * 全部时间均分（段长扣掉首尾入场/拉远窗后按卡数均分）；scale/center 双 smoothstep
 * 保证起停无速度突刺。画布 px 口径：world 平面居中放置，s = 画布宽/世界宽 为全景基准。
 *
 * M2 冻结接管（timeline-master-plan §二.3）：cardWindows 给出时卡槽边界改由物化层窗治理
 * （槽 i = [w_i.start, w_{i+1}.start)，末卡到 w_last.end；窗 end 其余处只影响字幕显示不影响
 * 相机槽界）；intro = w_0.start，拉远窗 = 末窗 end 之后余量（无余量则驻留末卡不硬跳全景）。
 * 缺省（undefined / 长度不足卡数）= 均匀数学，未冻结段零漂移。
 */
export const whiteboardCameraAt = (
  frame: number,
  totalFrames: number,
  rects: WhiteboardCardRect[],
  opts?: {zoomIn?: number; pullBack?: boolean; introFrames?: number; worldW?: number; worldH?: number; panMode?: boolean; cardWindows?: WhiteboardCardWindow[]},
): WhiteboardCam => {
  const zoomIn = opts?.zoomIn ?? 1.45;
  const pullBack = opts?.pullBack ?? true;
  const panMode = opts?.panMode ?? false; // 平面移动模式：移动段纯平移不缩放、仅驻留轻微推近（v7 复盘：缩放循环+卡内放大叠晕）
  const worldW = opts?.worldW ?? WHITEBOARD_WORLD_W;
  const fit = 1 / worldW; // 归一化口径：画布宽=1，世界宽 worldW
  if (rects.length === 0) return {scale: fit, tx: (1 - worldW) / 2, ty: 0};
  // 冻结接管窗（宁少勿猜：覆盖层与卡数不齐 = 文案槽位变过，整段回退均匀数学）
  const wins = opts?.cardWindows && opts.cardWindows.length >= rects.length ? opts.cardWindows.slice(0, rects.length) : null;
  const intro = wins
    ? Math.max(0, Math.round(wins[0].startFrame))
    : Math.max(0, Math.round(opts?.introFrames ?? 10));
  const tail = pullBack ? Math.round(totalFrames * 0.16) : 0;
  // usable 口径 = intro 之后的偏移时长（与 f = frame - intro 同域；wins = 末窗 end 相对首窗 start）
  const usable = wins
    ? Math.max(1, Math.round(wins[wins.length - 1].endFrame) - intro)
    : Math.max(1, totalFrames - intro - tail);

  const camFor = (i: number, q: number): {scale: number; cx: number; cy: number} => {
    // 段内：前 45% 横移到卡 i，后 55% 推近驻留，scale/center 双 smoothstep 起停无速度突刺。
    // 默认：移动段从上一卡驻留档平滑缩回全景（v4 复盘修复的连续性）；
    // panMode：移动段 scale 恒全景（纯平移），驻留段「轻推-回落」拱形（段首段尾都=全景，
    // 跨段零跳变——v8 实锤：push 单调到段尾 1.3、下一段回 1.0=硬跳瞬移），仅驻留中段轻微推近
    const move = smoothstep(Math.min(1, q / 0.45));
    const push = smoothstep(Math.max(0, (q - 0.45) / 0.55));
    const prev = i === 0 ? {cx: 0.5, cy: 0.5} : rects[i - 1];
    const cur = rects[i];
    const startScale = i === 0 || panMode ? fit : fit * zoomIn; // 上一卡驻留档（首卡/panMode 从全景出发）
    // panMode：全程恒展台档（fit×zoomIn）纯平移，无任何往复缩放——v11 复盘：多卡快节奏下
    // 驻留缩放无论拱形还是梯形都是「连续放大缩小」的频闪感；恒定放大+卡间平移卡面全程静止可读。
    // 仅首卡进场借 move 一次性从全景推上展台档（smoothstep 无速度突刺），尾段由 tail 分支对称拉远
    const scalePan = i === 0 ? fit + (fit * zoomIn - fit) * move : fit * zoomIn;
    return {
      scale: panMode ? scalePan : fit + (startScale - fit) * (1 - move) + fit * (zoomIn - 1) * push,
      cx: prev.cx + (cur.cx - prev.cx) * move,
      cy: prev.cy + (cur.cy - prev.cy) * move,
    };
  };

  let cam: {scale: number; cx: number; cy: number};
  const f = Math.max(0, frame - intro);
  if (f < 0) {
    cam = {scale: fit, cx: 0.5, cy: 0.5};
  } else if (f >= usable) {
    // 拉远收全貌：从末卡回到全景。panMode 巡览段恒展台档——尾段从展台档对称回落
    // （pullBack 关则保持展台档到段尾，避免 1.3×→1.0 硬跳）
    // 冻结接管：拉远时长 = 末窗 end 后余量；无余量 = 保持末卡驻留（不硬跳全景）
    const tailLen = wins ? Math.max(0, totalFrames - intro - usable) : tail;
    if (tailLen <= 0) {
      cam = camFor(rects.length - 1, 1);
    } else {
      const q = smoothstep((f - usable) / tailLen);
      const last = rects[rects.length - 1];
      const scale = !panMode
        ? fit + (fit * zoomIn - fit) * (1 - q)
        : fit * zoomIn + (fit - fit * zoomIn) * q;
      cam = {
        scale,
        cx: 0.5 + (last.cx - 0.5) * (1 - q),
        cy: 0.5 + (last.cy - 0.5) * (1 - q),
      };
    }
  } else if (wins) {
    // 窗口驱动：槽 i = [w_i.start, w_{i+1}.start)，末卡到 usable；窗前（扩展 intro）smoothstep 钳 0 = 全景
    let i = wins.length - 1;
    for (let k = 0; k < wins.length; k++) {
      if (f < (k + 1 < wins.length ? Math.round(wins[k + 1].startFrame) - intro : usable)) {
        i = k;
        break;
      }
    }
    const slotStart = Math.round(wins[i].startFrame) - intro;
    const slotEnd = i + 1 < wins.length ? Math.round(wins[i + 1].startFrame) - intro : usable;
    cam = camFor(i, (f - slotStart) / Math.max(1, slotEnd - slotStart));
  } else {
    const seg = usable / rects.length; // 每卡：驻留+横移合一
    const i = Math.min(rects.length - 1, Math.floor(f / seg));
    cam = camFor(i, (f - i * seg) / seg);
  }

  // 画布 px（归一化口径）：世界平面 -50%/-50% 居中锚定，注视点 c 移到画布中心
  // screen(p) = 画布中心 + t + s·worldW·(p−0.5) → t = −s·worldW·(c−0.5)
  const worldH = opts?.worldH ?? WHITEBOARD_WORLD_H;
  return {
    scale: cam.scale,
    tx: -(cam.cx - 0.5) * cam.scale * worldW,
    ty: -(cam.cy - 0.5) * cam.scale * worldH,
  };
};
