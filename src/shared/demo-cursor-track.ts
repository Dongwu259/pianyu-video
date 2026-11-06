/**
 * 演示鼠标轨迹生成器 - 纯函数（与 React/Remotion 解耦，可单测）
 *
 * 用途：CursorFollow（鼠标跟随运镜）模板的素材没有真实录屏轨迹时，
 * 一键生成一条「像真人操作」的演示轨迹，让模板开箱即可预览效果。
 *
 * 轨迹特征（对齐真实录屏轨迹 CursorPoint：t 毫秒、x/y 视频像素坐标）：
 * - 时长跟随素材时长，采样间隔 33ms（≈30Hz，与真实采集一致）；
 * - 路径为「停顿 → 平滑移动 → 停顿」循环：贝塞尔式缓动移动 +
 *   关键位置停顿 0.5~1s + 部分停顿带小幅抖动（模拟手部微颤）；
 * - 坐标限制在画面有效区域内（四周留 8% 边距）；
 * - 传入相同 seed 输出完全确定（工程只持久化 seed，加载时按种子重建）。
 */

import type {CursorActionEvent, CursorClick, CursorPoint} from './capture.ts';

export interface DemoCursorTrackOptions {
  /** 轨迹时长（秒），取素材原始时长（整段时长内任意裁剪窗口都有轨迹） */
  durationSec: number;
  /** 视频像素宽 */
  width: number;
  /** 视频像素高 */
  height: number;
  /** 随机种子：传入则输出确定；省略则随机（调用方需持久化时用传入模式） */
  seed?: number;
}

/** mulberry32 伪随机数发生器：小而确定的种子 PRNG（返回 [0, 1)） */
const makeRng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 采样间隔（ms），与真实录屏轨迹采集（30Hz 轮询）一致 */
const SAMPLE_MS = 33;
/** 画面四周留边比例（轨迹不贴边，运镜留白更自然） */
const MARGIN_RATIO = 0.08;
/** 停顿时长范围（秒）：关键位置停留 0.5~1s */
const PAUSE_MIN_MS = 500;
const PAUSE_MAX_MS = 1000;
/** 停顿带小幅抖动的概率与幅度（±px，模拟手部微颤） */
const JITTER_PROB = 0.5;
const JITTER_PX = 3;

/** 三次缓入缓出（贝塞尔式平滑：起步慢、中段快、停稳）——随机/声明式轨迹共用 */
const easeInOut = (q: number) => (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2);

/** 生成演示鼠标轨迹（给定 seed 时确定性输出） */
export const generateDemoCursorTrack = (opts: DemoCursorTrackOptions): CursorPoint[] => {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const durationMs = Math.max(1000, Math.round(opts.durationSec * 1000));
  const rng = makeRng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));

  // 有效区域：四周留 8% 边距（极小尺寸时区域退化为中心点也不出界）
  const mx = width * MARGIN_RATIO;
  const my = height * MARGIN_RATIO;
  const minX = Math.min(mx, width / 2);
  const minY = Math.min(my, height / 2);
  const maxX = Math.max(minX, width - mx);
  const maxY = Math.max(minY, height - my);

  const rand = (lo: number, hi: number) => lo + rng() * (hi - lo);
  const pickPoint = () => ({x: rand(minX, maxX), y: rand(minY, maxY)});
  const clampRound = (v: number, hi: number) => Math.round(Math.max(0, Math.min(hi, v)));

  // 三次缓入缓出（贝塞尔式平滑：起步慢、中段快、停稳）——已提升为模块级 easeInOut

  const points: CursorPoint[] = [];
  const regionDiag = Math.hypot(maxX - minX, maxY - minY);
  let cur = pickPoint();
  let t = 0;

  /** 在停顿位置补一个采样点（jitter 开启时叠加小幅抖动），并推进时间 */
  const emitPauseSample = (jitter: boolean) => {
    const jx = jitter ? rand(-JITTER_PX, JITTER_PX) : 0;
    const jy = jitter ? rand(-JITTER_PX, JITTER_PX) : 0;
    points.push({t: Math.round(t), x: clampRound(cur.x + jx, width), y: clampRound(cur.y + jy, height)});
    t += SAMPLE_MS;
  };

  while (t < durationMs) {
    // ① 停顿 0.5~1s（首个停顿从 t=0 开始，保证短素材也至少有一段停顿）
    const pauseMs = Math.min(rand(PAUSE_MIN_MS, PAUSE_MAX_MS), durationMs - t);
    const jitter = rng() < JITTER_PROB;
    const pauseEnd = t + pauseMs;
    while (t < pauseEnd && t < durationMs) emitPauseSample(jitter);
    if (t >= durationMs) break;

    // ② 挑下一个停顿点：优先离当前点足够远（≥20% 区域对角线），重试几次后接受任意点
    let next = pickPoint();
    for (let i = 0; i < 8 && Math.hypot(next.x - cur.x, next.y - cur.y) < regionDiag * 0.2; i++) {
      next = pickPoint();
    }

    // ③ 平滑移动：二次贝塞尔（控制点在中点法线方向随机偏移，路径略弯更像人手），
    //    时长按距离与 1.0~2.4 px/ms 的人手速度推算
    const dist = Math.hypot(next.x - cur.x, next.y - cur.y);
    const moveMs = Math.max(250, Math.min(1500, (dist / rand(1.0, 2.4))));
    const midX = (cur.x + next.x) / 2;
    const midY = (cur.y + next.y) / 2;
    // 法线方向（垂直于移动方向），弯曲量 ≤ 距离的 20%
    const nx = dist > 0 ? -(next.y - cur.y) / dist : 0;
    const ny = dist > 0 ? (next.x - cur.x) / dist : 0;
    const bend = rand(-0.2, 0.2) * dist;
    const ctrlX = midX + nx * bend;
    const ctrlY = midY + ny * bend;

    const from = cur;
    const moveEnd = Math.min(t + moveMs, durationMs);
    const moveStart = t;
    while (t < moveEnd) {
      const q = easeInOut((t - moveStart) / moveMs);
      const u = 1 - q;
      points.push({
        t: Math.round(t),
        x: clampRound(u * u * from.x + 2 * u * q * ctrlX + q * q * next.x, width),
        y: clampRound(u * u * from.y + 2 * u * q * ctrlY + q * q * next.y, height),
      });
      t += SAMPLE_MS;
    }
    cur = next;
  }

  // 收尾：末点钉在精确时长处（采样循环因 33ms 步进可能略短于时长）
  if (points.length === 0 || points[points.length - 1].t < durationMs) {
    points.push({t: durationMs, x: clampRound(cur.x, width), y: clampRound(cur.y, height)});
  }
  return points;
};

/**
 * 从轨迹点推导演示点击事件（纯函数，输入确定则输出确定）。
 * 规则：停顿段（位移 ≤12px 持续 ≥400ms）视为「移动到目标后点击」，
 * 点击落在停顿开始处；相邻点击位置需拉开 >80px（避免同一位置反复点）。
 * 用于 CursorFollow 演示数据（真实录屏的点击由输入钩子采集，不走这里）。
 */
export const generateDemoCursorClicks = (points: CursorPoint[]): CursorClick[] => {
  const clicks: CursorClick[] = [];
  if (points.length < 2) return clicks;
  let anchor = 0; // 当前停顿段起点下标
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[anchor].x;
    const dy = points[i].y - points[anchor].y;
    if (Math.hypot(dx, dy) > 12) {
      const dwellMs = points[i].t - points[anchor].t;
      const last = clicks[clicks.length - 1];
      const farFromLast = !last || Math.hypot(points[anchor].x - last.x, points[anchor].y - last.y) > 80;
      if (dwellMs >= 400 && farFromLast && i - anchor >= 2) {
        clicks.push({t: points[anchor + 1].t, x: points[anchor].x, y: points[anchor].y, button: 1});
      }
      anchor = i;
    }
  }
  return clicks;
};

// ====== 声明式动作脚本（update_segment cursorScript / UI 编辑动作共用） ======

/** 动作步骤（结构化格式；字符串 DSL 解析后同构）。坐标为归一化 0-1（视频分辨率无关） */
export type CursorTrackStep =
  | {kind: 'move'; x: number; y: number; sec: number}
  | {kind: 'pause'; sec: number}
  | {kind: 'click'}
  | {kind: 'dblclick'}
  | {kind: 'right'}
  | {kind: 'down'}
  | {kind: 'up'}
  | {kind: 'drag'; x: number; y: number; sec: number}
  | {kind: 'scroll'; ticks: number; sec: number}
  | {kind: 'type'; text: string; sec: number};

export interface ParsedCursorScript {
  /** 起点（归一化；缺省 (0.15, 0.75)）。字符串 DSL 的首坐标令牌设置 */
  start: {x: number; y: number};
  steps: CursorTrackStep[];
  /** 非致命告警（非法令牌跳过等），供 UI/工具回告 */
  warnings: string[];
}

/** 滚轮格数钳制 ±10（超出告警）——视觉上 3 格已是明显一次滚动 */
const clampTicks = (v: number, out: ParsedCursorScript): number => {
  const c = Math.round(v);
  if (c > 10 || c < -10) {
    out.warnings.push(`滚轮格数 ${v} 超出 ±10，已钳制`);
    return Math.max(-10, Math.min(10, c));
  }
  return c;
};
/** 时长钳制（缺省值 default；超出边界告警） */
const clampDur = (v: number, lo: number, hi: number, dflt: number): number => {
  if (!Number.isFinite(v) || v <= 0) return dflt;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
};
/** 滚动默认时长：150ms/格 */
const defaultScrollSec = (ticks: number) => Math.min(1.5, Math.max(0.2, Math.abs(ticks) * 0.15));
/** 打字默认时长：90ms/字符 */
const defaultTypeSec = (text: string) => Math.min(5, Math.max(0.4, text.length * 0.09));
/** 打字文本清洗：去控制字符与双引号（防 DSL 往返序列化破坏），超 40 字截断告警（气泡可读性上限） */
const sanitizeTypeText = (raw: string, at: string, out: ParsedCursorScript): string => {
  const clean = raw.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (clean.length > 40) {
    out.warnings.push(`${at}：type 文本超 40 字，已截断`);
    return clean.slice(0, 40);
  }
  return clean;
};

/**
 * 解析动作脚本。输入两种形态：
 * - 字符串 DSL：`0.15,0.8 > 0.4,0.5 @1.2 | click | dblclick | right | drag > 0.8,0.4 @1 | scroll +3 @0.5 | type "登录" @1.2 | hold`
 *   令牌：`x,y`（首令牌=起点）、`>x,y [@sec]`（滑动，缺省时长按距离推）、
 *   `@sec`（停顿）、`click/点击`、`dblclick/双击`、`right/右键`、`down/按下`、`up/抬起`
 *   （down+up 之间为按住；配对即拖拽）、`drag > x,y [@sec]`（整动作拖拽：按住滑到目标再抬起，
 *   点击落在目标处）、`scroll ±N [@sec]`（滚轮 N 格，正=向下）、`type "文本" [@sec]`（打字，
 *   建议引号包裹防逗号拆分）、`hold`（停顿到结束）；分隔 `|` `;` `，` 或空白。
 * - 结构化数组：[{kind:'move'|'drag',x,y,sec} | {kind:'pause',sec} | {kind:'click'} |
 *   {kind:'dblclick'} | {kind:'right'} | {kind:'down'} | {kind:'up'} |
 *   {kind:'scroll',ticks,sec} | {kind:'type',text,sec}]
 * 非法令牌/字段跳过并记 warnings（不抛错——模型输出容错第一）。
 */
export const parseCursorTrackScript = (input: unknown): ParsedCursorScript => {
  const out: ParsedCursorScript = {start: {x: 0.15, y: 0.75}, steps: [], warnings: []};
  const norm = (v: number, name: string): number | null => {
    if (!Number.isFinite(v)) return null;
    if (v < -0.05 || v > 1.05) {
      out.warnings.push(`${name}=${v} 越界，已钳制到 0-1`);
      return Math.min(1, Math.max(0, v));
    }
    return v;
  };
  if (Array.isArray(input)) {
    for (const [i, s] of input.entries()) {
      if (typeof s !== 'object' || s === null) {out.warnings.push(`步骤 ${i} 非对象，跳过`); continue;}
      const o = s as Record<string, unknown>;
      if (o.kind === 'click') {out.steps.push({kind: 'click'}); continue;}
      if (o.kind === 'dblclick') {out.steps.push({kind: 'dblclick'}); continue;}
      if (o.kind === 'right') {out.steps.push({kind: 'right'}); continue;}
      if (o.kind === 'down') {out.steps.push({kind: 'down'}); continue;}
      if (o.kind === 'up') {out.steps.push({kind: 'up'}); continue;}
      const sec = Number(o.sec);
      if (o.kind === 'pause') {
        if (Number.isFinite(sec) && sec > 0) out.steps.push({kind: 'pause', sec: Math.min(sec, 10)});
        else out.warnings.push(`步骤 ${i} pause.sec 非法，跳过`);
        continue;
      }
      if (o.kind === 'drag') {
        const x = norm(Number(o.x), `步骤 ${i} x`);
        const y = norm(Number(o.y), `步骤 ${i} y`);
        if (x === null || y === null) {out.warnings.push(`步骤 ${i} drag 坐标非法，跳过`); continue;}
        out.steps.push({kind: 'drag', x, y, sec: Number.isFinite(sec) && sec > 0 ? Math.min(Math.max(sec, 0.3), 8) : 0});
        continue;
      }
      if (o.kind === 'scroll') {
        const ticks = Number(o.ticks);
        if (!Number.isFinite(ticks) || ticks === 0) {out.warnings.push(`步骤 ${i} scroll.ticks 非法，跳过`); continue;}
        out.steps.push({kind: 'scroll', ticks: clampTicks(ticks, out), sec: clampDur(sec, 0.2, 2, defaultScrollSec(ticks))});
        continue;
      }
      if (o.kind === 'type') {
        const text = sanitizeTypeText(String(o.text ?? ''), `步骤 ${i}`, out);
        if (text === '') {out.warnings.push(`步骤 ${i} type.text 为空，跳过`); continue;}
        out.steps.push({kind: 'type', text, sec: clampDur(sec, 0.4, 5, defaultTypeSec(text))});
        continue;
      }
      if (o.kind === 'move') {
        const x = norm(Number(o.x), `步骤 ${i} x`);
        const y = norm(Number(o.y), `步骤 ${i} y`);
        if (x === null || y === null) {out.warnings.push(`步骤 ${i} move 坐标非法，跳过`); continue;}
        out.steps.push({kind: 'move', x, y, sec: Number.isFinite(sec) && sec > 0 ? Math.min(Math.max(sec, 0.1), 8) : 0});
        continue;
      }
      out.warnings.push(`步骤 ${i} kind=${String(o.kind)} 未知，跳过`);
    }
    return out;
  }
  if (typeof input !== 'string') {
    out.warnings.push('脚本必须是字符串 DSL 或步骤数组');
    return out;
  }
  // 空格不是分隔符（坐标内允许空格）；「x,y > x,y @s」中的 > 前后插入分隔，
  // 让「起点 > 移动目标」拆成两个令牌（首令牌=起点、>令牌=移动）。
  // drag 的 > 是令牌内前缀不是分隔——先摘出保护（占位符），通用拆分后再还原。
  const DRAG_GT = '\u0000drag-gt\u0000';
  const normalized = input
    .replace(/(drag|拖拽|拖到|拖至|拖)\s*>\s*/gi, `$1${DRAG_GT}`)
    .replace(/\s*>\s*/g, ' | > ')
    .split(DRAG_GT)
    .join('');
  const tokens = normalized.split(/[|;；，\n]+/).map((t) => t.trim()).filter(Boolean);
  for (const [i, tok] of tokens.entries()) {
    // 停顿 / hold
    let m = /^@([\d.]+)s?$/.exec(tok) ?? /^hold\s*@?([\d.]*)s?$/.exec(tok) ?? /^wait\s+([\d.]+)s?$/.exec(tok);
    if (m) {
      const sec = m[1] === '' || m[1] === undefined ? Number.POSITIVE_INFINITY : parseFloat(m[1]);
      out.steps.push({kind: 'pause', sec: Math.min(sec, 60)});
      continue;
    }
    if (/^(click|点击|点一下)$/.test(tok)) {out.steps.push({kind: 'click'}); continue;}
    if (/^(dblclick|dbl|双击)$/.test(tok)) {out.steps.push({kind: 'dblclick'}); continue;}
    if (/^(right|rclick|右键|右击)$/.test(tok)) {out.steps.push({kind: 'right'}); continue;}
    if (/^(down|按下)$/.test(tok)) {out.steps.push({kind: 'down'}); continue;}
    if (/^(up|抬起|松开)$/.test(tok)) {out.steps.push({kind: 'up'}); continue;}
    // 拖拽：drag > x,y [@sec]（> 可省；整动作 = 按住滑到目标再抬起，点击落在目标处）
    m = /^(?:drag|拖拽|拖到|拖至|拖)\s*>?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:@\s*([\d.]+)\s*s?)?$/i.exec(tok);
    if (m) {
      const x = norm(parseFloat(m[1]), `令牌 ${i} x`);
      const y = norm(parseFloat(m[2]), `令牌 ${i} y`);
      if (x === null || y === null) {out.warnings.push(`令牌「${tok}」坐标非法，跳过`); continue;}
      out.steps.push({kind: 'drag', x, y, sec: m[3] !== undefined ? clampDur(parseFloat(m[3]), 0.3, 8, 0) : 0});
      continue;
    }
    // 滚轮：scroll ±N [@sec]（正 = 向下滚；缺省时长 150ms/格）
    m = /^(?:scroll|滚轮|滚动)\s*([+-]?[\d.]+)(?:\s*@\s*([\d.]+)\s*s?)?$/i.exec(tok);
    if (m) {
      const ticks = parseFloat(m[1]);
      if (!Number.isFinite(ticks) || Math.round(ticks) === 0) {
        out.warnings.push(`令牌「${tok}」格数非法（非零整数），跳过`);
        continue;
      }
      const ct = clampTicks(ticks, out);
      out.steps.push({
        kind: 'scroll',
        ticks: ct,
        sec: clampDur(m[2] !== undefined ? parseFloat(m[2]) : NaN, 0.2, 2, defaultScrollSec(ct)),
      });
      continue;
    }
    // 打字：type "文本" [@sec]（引号包裹防逗号/竖线拆分；裸文本吃到令牌尾）
    let tm = /^(?:type|输入|打字)\s*(?:"([^"]*)"|'([^']*)'|「([^」]*)」)\s*(?:@\s*([\d.]+)\s*s?)?$/i.exec(tok);
    if (tm) {
      const text = sanitizeTypeText(tm[1] ?? tm[2] ?? tm[3] ?? '', `令牌 ${i}`, out);
      if (text === '') out.warnings.push(`令牌「${tok}」文本为空，跳过`);
      else out.steps.push({kind: 'type', text, sec: clampDur(tm[4] !== undefined ? parseFloat(tm[4]) : NaN, 0.4, 5, defaultTypeSec(text))});
      continue;
    }
    tm = /^(?:type|输入|打字)\s+(.+?)(?:\s*@\s*([\d.]+)\s*s?)?$/i.exec(tok);
    if (tm) {
      const text = sanitizeTypeText(tm[1], `令牌 ${i}`, out);
      if (text === '') out.warnings.push(`令牌「${tok}」文本为空，跳过`);
      else out.steps.push({kind: 'type', text, sec: clampDur(tm[2] !== undefined ? parseFloat(tm[2]) : NaN, 0.4, 5, defaultTypeSec(text))});
      continue;
    }
    // 移动：> x,y [@sec]（前缀 > 可省略——非首坐标令牌视为移动；坐标允许负值/超 1，norm 钳制）
    m = /^>?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:@\s*([\d.]+)\s*s?)?$/.exec(tok);
    if (m) {
      const x = norm(parseFloat(m[1]), `令牌 ${i} x`);
      const y = norm(parseFloat(m[2]), `令牌 ${i} y`);
      if (x === null || y === null) {out.warnings.push(`令牌「${tok}」坐标非法，跳过`); continue;}
      const sec = m[3] !== undefined ? parseFloat(m[3]) : 0;
      if (i === 0 && sec === 0 && !/^>/.test(tok)) {
        out.start = {x, y}; // 首令牌无 > 无时长 = 起点
        continue;
      }
      out.steps.push({kind: 'move', x, y, sec: sec > 0 ? Math.min(Math.max(sec, 0.1), 8) : 0});
      continue;
    }
    out.warnings.push(`令牌「${tok}」无法识别，跳过`);
  }
  return out;
};

/**
 * 按声明脚本生成轨迹（与 generateDemoCursorTrack 同款手感：二次贝塞尔缓动移动 +
 * 法向随机弯曲 + 停顿手部微颤；同 seed 确定性）。点击/事件来自声明的动作步骤
 * （click/dblclick/right/up/drag 落点即点击；不再靠停顿推导）。
 * drag/down-up 按住期间采样点带 down:true（模板渲染按压态光标）；
 * scroll/type 输出为 events（模板渲染滚轮箭头/打字气泡）。
 * 脚本总时长超出 durationSec 截断（warning）；不足则末尾停住补齐，末点钉在精确时长。
 */
export const buildCursorTrack = (
  parsed: ParsedCursorScript,
  opts: {durationSec: number; width: number; height: number; seed?: number},
): {points: CursorPoint[]; clicks: CursorClick[]; events: CursorActionEvent[]; warnings: string[]} => {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const durationMs = Math.max(1000, Math.round(opts.durationSec * 1000));
  const rng = makeRng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));

  const mx = width * MARGIN_RATIO;
  const my = height * MARGIN_RATIO;
  const minX = Math.min(mx, width / 2);
  const minY = Math.min(my, height / 2);
  const maxX = Math.max(minX, width - mx);
  const maxY = Math.max(minY, height - my);
  const clampRound = (v: number, hi: number) => Math.round(Math.max(0, Math.min(hi, v)));
  const toPx = (p: {x: number; y: number}) => ({
    x: Math.min(Math.max(p.x * width, minX), maxX),
    y: Math.min(Math.max(p.y * height, minY), maxY),
  });

  const points: CursorPoint[] = [];
  const clicks: CursorClick[] = [];
  const events: CursorActionEvent[] = [];
  const warnings: string[] = [...parsed.warnings];
  let cur = toPx(parsed.start);
  let t = 0;
  let press = false; // 按住状态（down/drag 期间为 true，采样点带 down 标记）

  const emitPause = (ms: number, jitter: boolean) => {
    const end = Math.min(t + ms, durationMs);
    while (t < end) {
      const jx = jitter ? rng() * 2 * JITTER_PX - JITTER_PX : 0;
      const jy = jitter ? rng() * 2 * JITTER_PX - JITTER_PX : 0;
      points.push({
        t: Math.round(t),
        x: clampRound(cur.x + jx, width),
        y: clampRound(cur.y + jy, height),
        ...(press ? {down: true} : {}),
      });
      t += SAMPLE_MS;
    }
  };

  const emitMove = (target: {x: number; y: number}, moveMs: number) => {
    const from = cur;
    const dist = Math.hypot(target.x - from.x, target.y - from.y);
    const midX = (from.x + target.x) / 2;
    const midY = (from.y + target.y) / 2;
    const nx = dist > 0 ? -(target.y - from.y) / dist : 0;
    const ny = dist > 0 ? (target.x - from.x) / dist : 0;
    const bend = (rng() * 0.4 - 0.2) * dist;
    const ctrlX = midX + nx * bend;
    const ctrlY = midY + ny * bend;
    const end = Math.min(t + moveMs, durationMs);
    const start = t;
    while (t < end) {
      const q = easeInOut((t - start) / moveMs);
      const u = 1 - q;
      points.push({
        t: Math.round(t),
        x: clampRound(u * u * from.x + 2 * u * q * ctrlX + q * q * target.x, width),
        y: clampRound(u * u * from.y + 2 * u * q * ctrlY + q * q * target.y, height),
        ...(press ? {down: true} : {}),
      });
      t += SAMPLE_MS;
    }
    cur = target;
  };

  /** 点击落在当前时刻的精确位置（最后采样点取整） */
  const clickHere = (button: number) => {
    const last = points[points.length - 1];
    clicks.push({t: Math.round(t), x: last ? last.x : Math.round(cur.x), y: last ? last.y : Math.round(cur.y), button});
  };

  let truncated = false;
  for (const step of parsed.steps) {
    if (t >= durationMs) {truncated = true; break;}
    if (step.kind === 'click') {
      clickHere(1);
      emitPause(120, rng() < 0.5); // 点击后短暂驻留
      continue;
    }
    if (step.kind === 'dblclick') {
      // 双击 = 两记 90ms 间隔的左键点击（同点击运镜包络分组共享焦点 → 单次推近、两圈涟漪）
      clickHere(1);
      emitPause(90, false);
      if (t < durationMs) {
        clickHere(1);
        emitPause(140, rng() < 0.5);
      }
      continue;
    }
    if (step.kind === 'right') {
      clickHere(2); // 右键（模板渲染暖色调点击效果）
      emitPause(140, rng() < 0.5);
      continue;
    }
    if (step.kind === 'down') {
      press = true;
      emitPause(90, false); // 按下瞬间驻留，让按压态可感知
      continue;
    }
    if (step.kind === 'up') {
      press = false;
      clickHere(1); // down+up 配对 = 一次点击，落在抬起位置
      emitPause(120, rng() < 0.5);
      continue;
    }
    if (step.kind === 'drag') {
      // 整动作拖拽：按下 → 匀缓滑到目标（拖拽比普通移动慢）→ 抬起落子（点击落目标处）
      press = true;
      emitPause(90, false);
      const target = toPx(step);
      const dist = Math.hypot(target.x - cur.x, target.y - cur.y);
      const moveMs = step.sec > 0
        ? Math.min(step.sec * 1000, durationMs - t)
        : Math.max(240, Math.min(2000, dist / (0.5 + rng() * 0.5)));
      emitMove(target, Math.max(150, moveMs));
      press = false;
      clickHere(1);
      emitPause(140, rng() < 0.5);
      continue;
    }
    if (step.kind === 'scroll') {
      events.push({t: Math.round(t), kind: 'scroll', ticks: step.ticks, durMs: Math.round(step.sec * 1000)});
      emitPause(step.sec * 1000, true); // 滚轮时手通常微颤
      continue;
    }
    if (step.kind === 'type') {
      events.push({t: Math.round(t), kind: 'type', text: step.text, durMs: Math.round(step.sec * 1000)});
      emitPause(step.sec * 1000, false); // 打字时光标定住
      continue;
    }
    if (step.kind === 'pause') {
      const ms = Number.isFinite(step.sec) ? Math.min(step.sec * 1000, durationMs - t) : durationMs - t;
      emitPause(Math.max(0, ms), rng() < JITTER_PROB);
      continue;
    }
    // move：缺省时长按距离 / 1.0~2.4 px/ms 人手速度推（同随机轨迹口径）
    const target = toPx(step);
    const dist = Math.hypot(target.x - cur.x, target.y - cur.y);
    const moveMs = step.sec > 0
      ? Math.min(step.sec * 1000, durationMs - t)
      : Math.max(120, Math.min(1500, dist / (1.0 + rng() * 1.4)));
    emitMove(target, Math.max(80, moveMs));
  }
  if (truncated) warnings.push('脚本超出片段时长，已截断');
  // 末尾停住补齐 + 末点钉在精确时长（与随机轨迹同收尾；收尾不再按住）
  press = false;
  while (t < durationMs) emitPause(SAMPLE_MS, false);
  if (points.length === 0 || points[points.length - 1].t < durationMs) {
    points.push({t: durationMs, x: clampRound(cur.x, width), y: clampRound(cur.y, height)});
  }
  return {points, clicks, events, warnings};
};
