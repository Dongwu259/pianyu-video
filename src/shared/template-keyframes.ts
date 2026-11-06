/**
 * 模板特性帧（关键帧时刻）声明——质量路线图第四层
 *
 * 背景（roadmap）：v1-v9 十轮装配期间「目检帧时刻」人肉算段界+0.043s 修正错了三轮；
 * 微步进拼条 contact sheet 是唯一可靠证据。本模块把「哪一刻值得看」从人脑落成
 * 模板声明的纯函数：渲完自动抽帧自动拼条（renderSample 消费）。
 *
 * 纪律（与 checkpoints 同）：时刻规划器只做静态推导（segment + 参数 → 时刻表），
 * 每个规划器的依据写注释；无声明的模板走通用回退（段中点——v10 装配 mids 目检
 * 同款，有十轮实战依据）。
 */

import type {Segment} from './types';
import {TEMPLATES} from './template-registry';
import {readParam} from './template-checkpoints';
import {isRenderableSegment} from './render-blocks';
import {parseWhiteboardCards} from './whiteboard-canvas';
import {parseChatLines, bubbleEnterFrame} from './chat-conversation';

/** 一个关键帧标记：段内容时间轴时刻（0=段内容起点，不含转场 headPad）+ 人话标签 */
export interface TemplateKeyframeMark {
  atSec: number;
  label: string;
}

/** 规划器：segment + 参数读取（与 checkpoints 同 read 语义）→ 关键帧列表 */
export type KeyframePlanner = (
  seg: Segment,
  read: (key: string) => number,
  fps: number,
) => TemplateKeyframeMark[];

/**
 * WhiteboardCanvas：每卡「驻留推近中点」（roadmap 点名）——相机时间线（whiteboard-
 * canvas.ts whiteboardCameraAt 同源）：intro 10 帧 + usable 均分/卡数，卡内前 45%
 * 横移后 55% 推近驻留 → 驻留中点 = intro + (i+0.725)×seg；pullBack 尾窗 16% 扣除。
 */
const whiteboardPlanner: KeyframePlanner = (seg, read, fps) => {
  const cards = parseWhiteboardCards(seg.text?.features ?? [], 99);
  if (cards.length === 0) return [];
  const totalFrames = Math.max(1, Math.round((seg.duration || 8) * fps));
  const intro = 10;
  const tail = read('pullBack') >= 0.5 ? Math.round(totalFrames * 0.16) : 0;
  const usable = Math.max(1, totalFrames - intro - tail);
  const segF = usable / cards.length;
  return cards.map((_, i) => ({
    atSec: (intro + (i + 0.725) * segF) / fps,
    label: `卡${i + 1}驻留`,
  }));
};

/**
 * PanelFlyout：拆层前后两帧（roadmap 点名 flyAt+0.3）——flyAt×段长是起飞时刻，
 * 前一帧看主界面完整态、后一帧看区域卡飞出形态（v6/v7 调 flyAmp 看的正是这两态）。
 */
const panelFlyoutPlanner: KeyframePlanner = (seg, read) => {
  const flyAt = read('flyAt');
  const dur = seg.duration || 8;
  return [
    {atSec: Math.max(0, flyAt * dur - 0.2), label: '拆层前'},
    {atSec: flyAt * dur + 0.3, label: '拆层后'},
  ];
};

/**
 * ChatConversation：每泡入场+0.1s（roadmap 点名）——入场弹簧 18 帧已落定、
 * 文本已可读；时刻与 bubbleEnterFrame 同源（装配侧改 pace 不会漂）。
 */
const chatPlanner: KeyframePlanner = (seg, read, fps) => {
  const lines = parseChatLines(seg.text?.features ?? []);
  const totalFrames = Math.max(1, Math.round((seg.duration || 8) * fps));
  const pace = read('pace');
  return lines.map((l, i) => ({
    atSec: (bubbleEnterFrame(i, lines.length, totalFrames, fps, pace) + 0.1 * fps) / fps,
    label: `泡${i + 1}${l.role === 'user' ? '用户' : 'AI'}`,
  }));
};

export const TEMPLATE_KEYFRAME_PLANNERS: Record<string, KeyframePlanner> = {
  WhiteboardCanvas: whiteboardPlanner,
  PanelFlyout: panelFlyoutPlanner,
  ChatConversation: chatPlanner,
};

/**
 * 通用回退：段中点一帧——无声明模板的目检基线（v10 装配 mids 目检同款，
 * 十轮实战在用的口径）。
 */
export const fallbackKeyframe = (seg: Segment): TemplateKeyframeMark[] => [
  {atSec: (seg.duration || 8) / 2, label: '段中点'},
];

export interface SegmentKeyframeRow {
  segmentIndex: number;
  templateId: string;
  /** 绝对帧（整片时间线，含前段累计——与 MultiSegmentPromo contentStart 同口径） */
  absFrames: number[];
  marks: TemplateKeyframeMark[];
}

/**
 * 全片关键帧时刻表：逐段跑规划器（未注册模板走段中点回退），把段内时刻换算成
 * 整片绝对帧（0 时长段=不可渲染段跳过，与 segmentPreviewWindow 同判定）。
 */
export const keyframeTimetable = (segments: Segment[], fps: number): SegmentKeyframeRow[] => {
  const meta = (id: string) => TEMPLATES.find((t) => t.id === id);
  const rows: SegmentKeyframeRow[] = [];
  let contentAcc = 0; // 段内容起点游标（绝对帧）；customIds 空=工程无自定义模板（renderSample 组装口径）
  segments.forEach((seg, i) => {
    const frames = contentFramesOf(seg, fps);
    if (frames <= 0) return; // 不可渲染段从时间线消失（不占内容帧）
    const m = meta(seg.templateId);
    const read = readParam(m?.paramSpecs ?? [], seg.customParams as Record<string, number> | undefined);
    const planner = TEMPLATE_KEYFRAME_PLANNERS[seg.templateId];
    const marks = planner ? planner(seg, read, fps) : fallbackKeyframe(seg);
    // 时刻钳进段内容窗（规划器公式漂移时不抽到邻段）
    const clamped = marks
      .map((k) => ({...k, atSec: Math.min(Math.max(0, k.atSec), (seg.duration || 8) - 1 / fps)}))
      .filter((k) => k.atSec >= 0);
    if (clamped.length > 0) {
      rows.push({
        segmentIndex: i,
        templateId: seg.templateId,
        absFrames: clamped.map((k) => contentAcc + Math.round(k.atSec * fps)),
        marks: clamped,
      });
    }
    contentAcc += frames;
  });
  return rows;
};

const contentFramesOf = (seg: Segment, fps: number): number =>
  isRenderableSegment(seg, []) ? Math.round((seg.duration || 8) * fps) : 0;
