/**
 * 模板 plan 回写器（timeline-master-plan M2 L1 回写环；纯函数，与 plan-projection 对偶）。
 *
 * 投影（plan-projection）：段参数 → 时间线原语（只读）。
 * 回写（本模块）：时间线原语编辑 → 段参数反解；反解不了 → 冻结兜底（§二.3）。
 *
 * 纪律：
 * - **宁少勿猜**：反解歧义 = 显式失败（ok:false + 人话 reason），不做「猜意图」的模糊回写。
 *   例：DocPanel 段落含 `[[选区]]` 时改文案会毁掉选区结构 → 拒绝（选区编辑走片段编辑器）。
 * - **文案永远可反解**：字幕文字 ↔ text.title/subtitle/features 行编辑（往返确定性），
 *   不触发冻结——冻结只接管「模板参数表达不了」的时序窗。
 * - **冻结 = 参数快照 + 外置字段**：窗反解不了 → 段记 frozen（paramSnapshot + detachedFields），
 *   窗真值进 materialized 覆盖层；渲染端逐模板开放消费（首批 CursorFollow）。
 * - **零逻辑复制**：槽位映射/行校验与 plan-projection 共用同一份 parse（whiteboard-canvas/
 *   doc-panel）；序列化器只改目标行、其余行原样保留（保格式往返）。
 */

import type {ClipCut} from './clipCuts';
import type {PromoText, Segment, SegmentFreezeRecord, PlanCaptionWindow} from './types';
import {TEMPLATES} from './template-registry';
import {projectSegmentPlan} from './plan-projection';
import {parseWhiteboardCards} from './whiteboard-canvas';
import {parseDocParagraphs} from './doc-panel';
import {secToFrame, frameToSec, TIMELINE_FPS} from './frame-grid';

/** 反解结果：成功带值 / 失败带人话原因（UI toast 与未来 agent 面共用） */
export type PlanWritebackResult<T> = {ok: true; value: T} | {ok: false; reason: string};

/** 渲染端已实装「物化字幕窗消费」的模板（逐模板开放——渲染端每实装一个加一个；
 *  未实装模板的窗编辑拒绝，避免「数据冻结了但成片不变」的静默失效）。
 *  切片二起三模板全开：CursorFollow 文字层窗 / WhiteboardCanvas 相机卡槽窗 /
 *  DocPanel 段落入场窗（含窗口条标题包络）。 */
export const CAPTION_WINDOW_RENDER_READY: readonly string[] = ['CursorFollow', 'WhiteboardCanvas', 'DocPanel'];

const durSecOf = (seg: Segment): number => seg.duration || 8;

const planOf = (seg: Segment) => TEMPLATES.find((t) => t.id === seg.templateId)?.plan;

const checkCaptionText = (text: string): string | null => {
  const t = text.trim();
  if (!t) return '文案不能为空（清空请走片段编辑器）';
  if (t.includes('\n')) return '排版字幕是单行文案，不支持换行';
  if (t.includes('|')) return '文案不能包含半角竖线 |（模板文案格式保留字符，全角 ｜ 是标题/副题分隔）';
  return null;
};

// ====== features 行序列化器（与 parse 共用同一校验口径；只改目标行，其余行原样保留） ======

/**
 * WhiteboardCanvas：编辑第 cardIndex 张卡的标题/副题（行内原样保留 [v]/[t] 前缀形状）。
 * sub 传 undefined = 无副题（显示什么改什么——投影用全角 ｜ 连接标题与副题，所见即所得）。
 * 返回 null = cardIndex 越界。
 */
export const editWhiteboardCardLine = (
  features: string[],
  cardIndex: number,
  title: string,
  sub?: string,
): string[] | null => {
  let seen = -1;
  const out = [...features];
  for (let i = 0; i < out.length; i++) {
    const raw = out[i] ?? '';
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[([a-zA-Z])\]\s*(.*)$/.exec(line);
    const rest = (m ? m[2] : line).trim();
    if (!rest) continue;
    // 与 parseWhiteboardCards 同口径：有效卡 = 非空且剥前缀后有内容
    seen++;
    if (seen !== cardIndex) continue;
    // 保留原前缀形状（含行首缩进与 [v] 后空白）：只换 rest 部分
    const leading = raw.length - raw.trimStart().length;
    const prefixLen = m ? m[0].length - m[2].length : 0;
    const newRest = sub !== undefined ? `${title}|${sub}` : title;
    out[i] = raw.slice(0, leading + prefixLen) + newRest;
    return out;
  }
  return null;
};

/**
 * DocPanel：编辑第 paraIndex 个段落行（整行替换；选区结构不在此编辑——含选区的段落
 * 由 solveCaptionText 上游拒绝，能到这里的一定是纯文本行）。返回 null = 越界。
 */
export const editDocParagraphLine = (features: string[], paraIndex: number, text: string): string[] | null => {
  let seen = -1;
  const out = [...features];
  for (let i = 0; i < out.length; i++) {
    const line = (out[i] ?? '').trim();
    if (!line || /^img\s*[:：]/i.test(line)) continue;
    seen++;
    if (seen !== paraIndex) continue;
    out[i] = text;
    return out;
  }
  return null;
};

// ====== 字幕文字反解（时间线改文案 → text/features 回写；永不冻结） ======

/** 全角 ｜ = 投影里标题与副题的连接符（whiteboardCaptions 所见即所得） */
const splitDisplayText = (text: string): {title: string; sub?: string} => {
  const i = text.indexOf('｜');
  return i < 0 ? {title: text} : {title: text.slice(0, i), sub: text.slice(i + 1)};
};

/**
 * 字幕文字反解：captionIndex 按 plan-projection 的 captions 序（模板文字槽序）。
 * 成功 → 应用于 segment.text 的局部 patch（features 为整组替换——行编辑器产出新数组）。
 */
export const solveCaptionText = (
  seg: Segment,
  captionIndex: number,
  text: string,
): PlanWritebackResult<Partial<PromoText>> => {
  const plan = planOf(seg);
  if (!plan || !plan.materializable.includes('captions')) {
    return {ok: false, reason: `模板「${seg.templateId}」未开放排版字幕物化（plan 白名单）`};
  }
  const err = checkCaptionText(text);
  if (err) return {ok: false, reason: err};
  const t = text.trim();

  if (seg.templateId === 'CursorFollow') {
    const slots: Array<keyof PromoText> = [];
    if (seg.text?.title) slots.push('title');
    if (seg.text?.subtitle) slots.push('subtitle');
    const key = slots[captionIndex];
    if (key !== 'title' && key !== 'subtitle') {
      return {ok: false, reason: `第 ${captionIndex + 1} 条排版字幕不存在（该段共 ${slots.length} 条）`};
    }
    return {ok: true, value: {[key]: t} as Partial<PromoText>};
  }

  if (seg.templateId === 'WhiteboardCanvas') {
    const cards = parseWhiteboardCards(seg.text?.features ?? [], 9);
    if (captionIndex < 0 || captionIndex >= cards.length) {
      return {ok: false, reason: `第 ${captionIndex + 1} 张卡不存在（该段共 ${cards.length} 张）`};
    }
    const {title, sub} = splitDisplayText(t);
    if (!title.trim()) return {ok: false, reason: '卡标题不能为空'};
    const features = editWhiteboardCardLine(seg.text?.features ?? [], captionIndex, title.trim(), sub?.trim() || undefined);
    if (!features) return {ok: false, reason: '卡行定位失败（文案行结构异常）'};
    return {ok: true, value: {features}};
  }

  if (seg.templateId === 'DocPanel') {
    const hasTitle = !!seg.text?.title;
    if (hasTitle && captionIndex === 0) return {ok: true, value: {title: t}};
    const paras = parseDocParagraphs(seg.text?.features ?? []);
    const paraIndex = captionIndex - (hasTitle ? 1 : 0);
    if (paraIndex < 0 || paraIndex >= paras.length) {
      return {ok: false, reason: `第 ${captionIndex + 1} 条排版字幕不存在（该段共 ${paras.length + (hasTitle ? 1 : 0)} 条）`};
    }
    const para = paras[paraIndex];
    if (para.segments.some((s) => s.selected)) {
      return {ok: false, reason: '该段落含 [[选区]] 高亮结构，时间线改文案会破坏选区——请在片段「文案」页编辑'};
    }
    if (t.includes('[[') || t.includes(']]')) {
      return {ok: false, reason: '文案不能包含 [[ ]]（选区语法保留字符）'};
    }
    const features = editDocParagraphLine(seg.text?.features ?? [], paraIndex, t);
    if (!features) return {ok: false, reason: '段落行定位失败（文案行结构异常）'};
    return {ok: true, value: {features}};
  }

  return {ok: false, reason: `模板「${seg.templateId}」的排版字幕文字回写未实装（逐模板开放）`};
};

// ====== 字幕窗反解（时序编辑 → 冻结兜底；渲染消费逐模板开放） ======

/** 当前生效字幕窗：冻结接管后 = materialized 覆盖层；此前 = plan 投影推导窗 */
export const effectiveCaptionWindows = (seg: Segment, fps: number = TIMELINE_FPS): PlanCaptionWindow[] => {
  const overlay = seg.materialized?.captions;
  if (overlay && overlay.length > 0) {
    return overlay.map((w) => ({startSec: w.startSec, endSec: w.endSec}));
  }
  const p = projectSegmentPlan(seg, fps);
  return (p?.captions ?? []).map((c) => ({startSec: c.startSec, endSec: c.endSec}));
};

/**
 * 字幕窗反解：时序窗在任何 v0 模板参数里都表达不了 → 冻结兜底（安全阀，§一.3）。
 * 返回完整覆盖层窗列表 + 冻结记录（已冻结则沿用原记录——frozenAt/快照锚定首次冻结）。
 */
export const solveCaptionWindow = (
  seg: Segment,
  captionIndex: number,
  startSec: number,
  endSec: number,
  fps: number = TIMELINE_FPS,
): PlanWritebackResult<{frozen: SegmentFreezeRecord; captions: PlanCaptionWindow[]; frozeNow: boolean}> => {
  const plan = planOf(seg);
  if (!plan || !plan.materializable.includes('captions')) {
    return {ok: false, reason: `模板「${seg.templateId}」未开放排版字幕物化（plan 白名单）`};
  }
  if (plan.freezePolicy === 'never') {
    return {ok: false, reason: `模板「${seg.templateId}」声明永不冻结（freezePolicy: never）`};
  }
  if (!CAPTION_WINDOW_RENDER_READY.includes(seg.templateId)) {
    return {ok: false, reason: `模板「${seg.templateId}」的排版字幕时序暂未开放（渲染端消费逐模板开放中）`};
  }
  const dur = durSecOf(seg);
  const windows = effectiveCaptionWindows(seg, fps);
  if (captionIndex < 0 || captionIndex >= windows.length) {
    return {ok: false, reason: `第 ${captionIndex + 1} 条排版字幕不存在（该段共 ${windows.length} 条）`};
  }
  // 帧格对齐 + 段内钳制 + 最小窗长（2 帧）——先对齐再钳制，保证 [0, dur] 端点恒可达
  const minSpan = 2 / fps;
  let s = frameToSec(secToFrame(Math.max(0, Math.min(dur, startSec))));
  let e = frameToSec(secToFrame(Math.max(0, Math.min(dur, endSec))));
  if (e - s < minSpan) {
    // 保窗尾优先（拖起点常见：起点追上终点时窗尾不动）
    e = Math.min(dur, s + minSpan);
    if (e - s < minSpan) s = Math.max(0, e - minSpan);
  }
  windows[captionIndex] = {startSec: s, endSec: e};
  const already = seg.frozen;
  const frozen: SegmentFreezeRecord = already
    ? {
        ...already,
        detachedFields: already.detachedFields.includes('captions')
          ? already.detachedFields
          : [...already.detachedFields, 'captions'],
      }
    : {
        frozenAt: new Date().toISOString(),
        paramSnapshot: {...(seg.customParams ?? {})},
        detachedFields: ['captions'],
      };
  return {ok: true, value: {frozen, captions: windows, frozeNow: !already}};
};

// ====== 素材窗反解（mediaIn/mediaOut ↔ trim——全模板可表达，永不冻结） ======

/**
 * 素材窗反解：PlanMediaWindow.mediaIn/mediaOut 与 trimStart/trimEnd 同口径（投影即 trim），
 * 反解 = trim 回写（cuts 原样带过——挖段结构不在时间线窗编辑域）。图片无时窗，拒绝。
 */
export const solveMediaWindow = (
  seg: Segment,
  videoIndex: number,
  mediaInSec: number,
  mediaOutSec: number,
): PlanWritebackResult<{trimStart: number; trimEnd: number; cuts?: ClipCut[]}> => {
  const v = seg.videos[videoIndex];
  if (!v) return {ok: false, reason: `段内无第 ${videoIndex + 1} 个素材（共 ${seg.videos.length} 个）`};
  if (v.type === 'image') return {ok: false, reason: '图片素材无时间窗（时长由片段决定）'};
  const srcDur = v.duration || 0;
  if (srcDur <= 0) return {ok: false, reason: '素材时长未知（未完成导入分析）'};
  const inS = Math.max(0, Math.min(srcDur, mediaInSec));
  const outS = Math.max(0, Math.min(srcDur, mediaOutSec));
  if (outS - inS < 0.04) return {ok: false, reason: '素材窗过短（最短约 2 帧）'};
  return {
    ok: true,
    value: {
      trimStart: Math.round(inS * 1000) / 1000,
      trimEnd: Math.round(outS * 1000) / 1000,
      ...(v.cuts && v.cuts.length > 0 ? {cuts: v.cuts.map((c) => ({...c}))} : {}),
    },
  };
};
