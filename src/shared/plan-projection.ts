/**
 * 模板 plan 物化投影（timeline-master-plan M1 影子对拍首批；纯读投影）。
 *
 * 纪律（总纲 §一/§二.7，template-keyframes 同款）：
 * - **静态推导**：segment（含 customParams/素材/文案）→ 时间线原语（节拍/字幕窗/素材窗），
 *   不触碰 store、不产生副作用；渲染端不动（不变量 1：不重写模板渲染引擎）。
 * - **同源**：每类推导的依据写注释并锚定到渲染端消费的同一份 shared 推导
 *   （doc-panel.ts docPanelTimeline / whiteboard-canvas.ts 相机时间线 / clipCuts 映射）；
 *   漂移由单测抓（tests/unit/plan-projection.test.ts 含 whiteboardPlanner 同源锚定断言）。
 * - **白名单**：模板 registry 未声明 plan.materializable 的字段不出现在投影里
 *   （未声明被投射 = 代码 bug，guard 抛错——宁少勿猜）。
 *
 * 坐标系：段内容时间轴（0 = 段内容起点，秒 + 帧双口径，frame-grid 统一取整）；
 * 绝对时间轴 = get_timeline.clips[i].startSec + 段内秒（与 captions/narration 同口径）。
 */

import type {Segment} from './types';
import {TEMPLATES} from './template-registry';
import {readParam} from './template-checkpoints';
import type {PlanMaterializableField} from './template-plan';
import {secToFrame, TIMELINE_FPS} from './frame-grid';
import {parseWhiteboardCards, WHITEBOARD_DWELL_POS} from './whiteboard-canvas';
import {parseDocParagraphs, parseDocPlaceholders, docPanelTimeline} from './doc-panel';
import {mediaToTimelineSec, clipEndSec} from './clipCuts';

/** 段内节拍标记（L2 物化目标原语；kind 枚举只增不改） */
export interface PlanBeat {
  sec: number;
  frame: number;
  kind: 'click' | 'dwell' | 'pop' | 'cell';
  /** 节拍主体（卡标题/段落摘要；点击 = 归一化坐标） */
  target?: string;
  note: string;
}

/** 可物化字幕行（模板自身排版的文字，非产品字幕轨） */
export interface PlanCaption {
  text: string;
  startSec: number;
  endSec: number;
  startFrame: number;
  endFrame: number;
}

/** 素材槽窗（与 TimelineShot.mediaIn/mediaOut 同口径） */
export interface PlanMediaWindow {
  clipIndex: number;
  name: string;
  mediaInSec: number;
  mediaOutSec: number;
  sourceDurationSec?: number;
  cutsCount?: number;
}

export interface SegmentPlan {
  templateId: string;
  segmentId?: string;
  durationSec: number;
  /** 生效白名单回读（消费方免二次查 registry） */
  materializable: PlanMaterializableField[];
  beats?: PlanBeat[];
  captions?: PlanCaption[];
  mediaWindows?: PlanMediaWindow[];
}

/** get_timeline plan 摘要（token 便宜：只有计数 + 白名单；细节经 get_segment_plan 定点拉） */
export interface SegmentPlanSummary {
  beatsCount: number;
  typographyCount: number;
  materializable: PlanMaterializableField[];
}

const durSecOf = (seg: Segment): number => seg.duration || 8;

/** 白名单 guard：字段未声明却被投影 = 实现 bug（宁少勿猜，fail loud） */
const allow = (plan: PlanMaterializableField[], field: PlanMaterializableField, templateId: string): void => {
  if (!plan.includes(field)) {
    throw new Error(`[plan-projection] ${templateId} 未声明 materializable '${field}' 却被投影——白名单纪律违规`);
  }
};

const caption = (text: string, startSec: number, endSec: number): PlanCaption => ({
  text,
  startSec,
  endSec,
  startFrame: secToFrame(startSec),
  endFrame: secToFrame(endSec),
});

// ====== beats 推导器（beatsDeriver 分发；依据注释锚定渲染端同源） ======

/**
 * cursorClicks（CursorFollow）：点击时刻表 = 素材侧标 cursorClicks（媒体毫秒）→ 段内秒。
 * 同源：模板渲染 mediaSec = timelineToMediaSec(段内秒, trimStart, cuts)（CursorFollow/
 * CursorOverlay 同口径），此处走其精确逆 mediaToTimelineSec——落在挖段洞内/裁剪窗外的
 * 点击在成片里不存在，跳过（宁少勿猜，不猜最近出口）。
 */
const deriveCursorClicks = (seg: Segment, fps: number): PlanBeat[] => {
  const v = seg.videos[0];
  if (!v || v.type !== 'video' || !v.cursorClicks || v.cursorClicks.length === 0) return [];
  const trimStart = v.trimStart ?? 0;
  const endSec = clipEndSec(v) ?? v.duration;
  const dur = durSecOf(seg);
  const beats: PlanBeat[] = [];
  for (const c of v.cursorClicks) {
    const mediaSec = c.t / 1000;
    const sec = mediaToTimelineSec(mediaSec, trimStart, endSec, v.cuts);
    if (sec === null || sec > dur + 1e-9) continue;
    const pos =
      v.width && v.height ? `(${(c.x / v.width).toFixed(3)},${(c.y / v.height).toFixed(3)})` : undefined;
    beats.push({
      sec: Math.round(sec * 1000) / 1000,
      frame: secToFrame(sec),
      kind: 'click',
      ...(pos ? {target: pos} : {}),
      note: `点击（media ${mediaSec.toFixed(2)}s${pos ? ` @ ${pos}` : ''}）`,
    });
  }
  return beats.sort((a, b) => a.sec - b.sec);
};

/**
 * cardDwell（WhiteboardCanvas）：每卡驻留中点。
 * 同源：相机时间线 whiteboardCameraAt——intro 10 帧 + usable/卡数，卡内前 45% 横移
 * 后 55% 推近驻留（panMode 恒定展台档下驻留=相机静止可读窗）；与 template-keyframes
 * whiteboardPlanner（目检帧实战 v10-v12）逐值一致（单测锚定，含 clamp-取整同路径）。
 * 卡数口径 = 渲染端 WhiteboardCanvas.tsx 的显式 9（缺省 6 会静默截断——v6-v8 实锤）。
 */
const WHITEBOARD_MAX_CARDS = 9;
const deriveCardDwell = (seg: Segment, read: (k: string) => number, fps: number): PlanBeat[] => {
  const cards = parseWhiteboardCards(seg.text?.features ?? [], WHITEBOARD_MAX_CARDS);
  if (cards.length === 0) return [];
  const dur = durSecOf(seg);
  // M2 冻结接管：驻留节拍由卡槽窗推导（槽 i = [w_i.start, w_{i+1}.start)，末卡到 w_last.end；
  // 驻留位置 WHITEBOARD_DWELL_POS 与渲染端 camFor 45%/55% 同源）。窗与卡数不齐 = 文案槽位
  // 变过，回退均匀数学（宁少勿猜）。
  const overlay = seg.materialized?.captions;
  if (overlay && overlay.length >= cards.length) {
    return cards.map((card, i) => {
      const slotStart = overlay[i].startSec;
      const slotEnd = i + 1 < cards.length ? overlay[i + 1].startSec : overlay[cards.length - 1].endSec;
      const atSec = Math.min(Math.max(0, slotStart + WHITEBOARD_DWELL_POS * Math.max(0.001, slotEnd - slotStart)), dur - 1 / fps);
      return {
        sec: Math.round(atSec * 1000) / 1000,
        frame: Math.round(atSec * fps),
        kind: 'dwell' as const,
        target: card.title,
        note: `卡${i + 1}驻留（${card.type === 'video' ? '视频卡' : '文字卡'}·窗接管）`,
      };
    });
  }
  const totalFrames = Math.max(1, Math.round(dur * fps));
  const intro = 10;
  const tail = read('pullBack') >= 0.5 ? Math.round(totalFrames * 0.16) : 0;
  const usable = Math.max(1, totalFrames - intro - tail);
  const segF = usable / cards.length;
  return cards.map((card, i) => {
    // 规划器同路径：sec 域 clamp（[0, dur-1/fps]）后再取整——先取整再 clamp 在边界差 1 帧
    const atSec = Math.min(Math.max(0, (intro + (i + 0.725) * segF) / fps), dur - 1 / fps);
    return {
      sec: Math.round(atSec * 1000) / 1000,
      frame: Math.round(atSec * fps),
      kind: 'dwell' as const,
      target: card.title,
      note: `卡${i + 1}驻留（${card.type === 'video' ? '视频卡' : '文字卡'}）`,
    };
  });
};

/**
 * docTimeline（DocPanel）：段落浮现 + 占位格弹入时刻表。
 * 同源：直接调渲染端消费的 doc-panel.ts docPanelTimeline（DocPanel.tsx 同参调用：
 * 段落数/占位格数/总帧/fps/pace——「看到的段落入场」即投影出的节拍）。
 */
const deriveDocTimeline = (seg: Segment, read: (k: string) => number, fps: number): PlanBeat[] => {
  const paras = parseDocParagraphs(seg.text?.features ?? []);
  const cells = parseDocPlaceholders(seg.text?.features ?? []);
  if (paras.length === 0 && cells.length === 0) return [];
  const dur = durSecOf(seg);
  const totalFrames = Math.max(1, Math.round(dur * fps));
  // M2 冻结接管：段落/占位格节拍直接走泛化 docPanelTimeline（窗口驱动，与渲染端同一份
  // 推导——同源纪律）。窗与段落数不齐 = 文案槽位变过，回退均匀数学（宁少勿猜）。
  const overlay = seg.materialized?.captions;
  const hasTitle = !!seg.text?.title;
  const paraWins =
    overlay && overlay.length - (hasTitle ? 1 : 0) >= paras.length && paras.length > 0
      ? overlay
          .slice(hasTitle ? 1 : 0)
          .map((w) => ({startFrame: secToFrame(w.startSec), endFrame: secToFrame(w.endSec)}))
      : undefined;
  const tl = docPanelTimeline(paras.length, cells.length, totalFrames, fps, read('pace'), paraWins);
  const beats: PlanBeat[] = paras.map((para, i) => {
    const f = tl.paraEnter(i);
    const text = para.segments.map((s) => s.text).join('');
    return {
      sec: Math.round((f / fps) * 1000) / 1000,
      frame: Math.round(f),
      kind: 'pop' as const,
      ...(text ? {target: text.slice(0, 12)} : {}),
      note: `段落${i + 1}浮现${text ? `「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」` : ''}`,
    };
  });
  cells.forEach((label, i) => {
    const f = tl.cellEnter(i);
    beats.push({
      sec: Math.round((f / fps) * 1000) / 1000,
      frame: Math.round(f),
      kind: 'cell',
      target: label,
      note: `占位格${i + 1}「${label}」弹入`,
    });
  });
  return beats;
};

// ====== captions / mediaWindows 推导 ======

/** CursorFollow：底部标题/副标题条全程在场（模板文字层同窗） */
const cursorFollowCaptions = (seg: Segment, dur: number): PlanCaption[] => {
  const out: PlanCaption[] = [];
  if (seg.text?.title) out.push(caption(seg.text.title, 0, dur));
  if (seg.text?.subtitle) out.push(caption(seg.text.subtitle, 0, dur));
  return out;
};

/** WhiteboardCanvas：卡 i 的可读窗 = [卡 i 段落起点, 卡 i+1 段落起点)（横移到位起，下一卡横移前止） */
const whiteboardCaptions = (seg: Segment, read: (k: string) => number, fps: number): PlanCaption[] => {
  const cards = parseWhiteboardCards(seg.text?.features ?? [], WHITEBOARD_MAX_CARDS);
  if (cards.length === 0) return [];
  const dur = durSecOf(seg);
  const totalFrames = Math.max(1, Math.round(dur * fps));
  const intro = 10;
  const tail = read('pullBack') >= 0.5 ? Math.round(totalFrames * 0.16) : 0;
  const usable = Math.max(1, totalFrames - intro - tail);
  const segF = usable / cards.length;
  return cards.map((card, i) => {
    const start = Math.min((intro + i * segF) / fps, dur);
    const end = Math.min((intro + (i + 1) * segF) / fps, dur);
    const text = card.sub ? `${card.title}｜${card.sub}` : card.title;
    return caption(text, start, end);
  });
};

/** DocPanel：窗口条标题全程 + 段落 i 浮现后持续在场（滚动只挪位置不减内容） */
const docPanelCaptions = (seg: Segment, read: (k: string) => number, fps: number): PlanCaption[] => {
  const paras = parseDocParagraphs(seg.text?.features ?? []);
  const cells = parseDocPlaceholders(seg.text?.features ?? []);
  const dur = durSecOf(seg);
  const out: PlanCaption[] = [];
  if (seg.text?.title) out.push(caption(seg.text.title, 0, dur));
  if (paras.length > 0) {
    const totalFrames = Math.max(1, Math.round(dur * fps));
    const tl = docPanelTimeline(paras.length, cells.length, totalFrames, fps, read('pace'));
    paras.forEach((para, i) => {
      const text = para.segments.map((s) => s.text).join('');
      if (text.trim()) out.push(caption(text, tl.paraEnter(i) / fps, dur));
    });
  }
  return out;
};

/** 素材槽窗（TimelineShot.mediaIn/mediaOut 同口径；cuts 只给计数，细节 get_segment_media） */
const deriveMediaWindows = (seg: Segment): PlanMediaWindow[] =>
  seg.videos
    .filter((v) => v && (v.type === 'video' || v.type === 'image' || v.type === 'model'))
    .map((v) => ({
      clipIndex: seg.videos.indexOf(v),
      name: v.name,
      mediaInSec: v.trimStart ?? 0,
      mediaOutSec: v.type === 'image' ? (v.trimStart ?? 0) : (v.trimEnd ?? v.duration),
      ...(v.type === 'image' ? {} : {sourceDurationSec: v.duration, cutsCount: v.cuts?.length ?? 0}),
    }));

/**
 * 段 plan 投影（纯函数）。模板未声明 plan（未入 M1 批次）→ null（消费方不显示该键）。
 */
export const projectSegmentPlan = (seg: Segment, fps: number = TIMELINE_FPS): SegmentPlan | null => {
  const meta = TEMPLATES.find((t) => t.id === seg.templateId);
  const plan = meta?.plan;
  if (!meta || !plan) return null;
  const read = readParam(meta.paramSpecs ?? [], seg.customParams as Record<string, number> | undefined);
  const dur = durSecOf(seg);
  const out: SegmentPlan = {
    templateId: seg.templateId,
    ...(seg.id ? {segmentId: seg.id} : {}),
    durationSec: dur,
    materializable: plan.materializable,
  };
  if (plan.materializable.includes('beats')) {
    const beats =
      plan.beatsDeriver === 'cursorClicks'
        ? deriveCursorClicks(seg, fps)
        : plan.beatsDeriver === 'cardDwell'
          ? deriveCardDwell(seg, read, fps)
          : plan.beatsDeriver === 'docTimeline'
            ? deriveDocTimeline(seg, read, fps)
            : [];
    out.beats = beats;
  }
  if (plan.materializable.includes('captions')) {
    const caps =
      seg.templateId === 'CursorFollow'
        ? cursorFollowCaptions(seg, dur)
        : seg.templateId === 'WhiteboardCanvas'
          ? whiteboardCaptions(seg, read, fps)
          : seg.templateId === 'DocPanel'
            ? docPanelCaptions(seg, read, fps)
            : [];
    // M2 冻结接管：窗由 materialized 覆盖层治理（按投影序对齐；文案仍按当前 text 推导——
    // 文案回写永远可反解不冻结）。覆盖层比推导长出的窗无文字槽可配，弃（宁少勿猜）。
    const overlay = seg.materialized?.captions;
    out.captions =
      overlay && overlay.length > 0
        ? caps.map((c, i) =>
            overlay[i]
              ? {
                  ...c,
                  startSec: overlay[i].startSec,
                  endSec: overlay[i].endSec,
                  startFrame: secToFrame(overlay[i].startSec),
                  endFrame: secToFrame(overlay[i].endSec),
                }
              : c,
          )
        : caps;
  }
  if (plan.materializable.includes('mediaWindows')) {
    out.mediaWindows = deriveMediaWindows(seg);
  }
  return out;
};

/** plan 摘要（get_timeline 逐段 additive 键；计数 + 白名单，token 便宜） */
export const segmentPlanSummary = (seg: Segment, fps: number = TIMELINE_FPS): SegmentPlanSummary | null => {
  const p = projectSegmentPlan(seg, fps);
  if (!p) return null;
  return {
    beatsCount: p.beats?.length ?? 0,
    typographyCount: p.captions?.length ?? 0,
    materializable: p.materializable,
  };
};
