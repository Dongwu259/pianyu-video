/**
 * 帧域栅格（timeline-master-plan 持续基建带①）——时间线帧口径的单一收敛点。
 *
 * 背景：全仓「秒 ↔ 帧」换算散落各处（`Math.round(sec * 30)` 手写十几处），
 * 口径已在 agent-timeline-schema §0 冻结为「秒（float，帧取整口径 round(sec × 30)」。
 * 新代码一律经本模块；既有热路径不动（蒸馏批间隙再逐步收编——总纲 M1.5 纪律）。
 *
 * 与 timeline-layout.TIMELINE_FPS 同源（30）；改动 fps 属于坐标系变更，须走契约 §7。
 */

import {TIMELINE_FPS} from './timeline-layout';

export {TIMELINE_FPS};

/** 秒 → 帧取整（agent 契约冻结口径：round(sec × 30)） */
export const secToFrame = (sec: number): number => Math.round(sec * TIMELINE_FPS);

/** 帧 → 秒（精确除法，不取整——秒域是浮点域） */
export const frameToSec = (frame: number): number => frame / TIMELINE_FPS;

/** 段内秒钳制到段内容窗 [0, durSec]（dur ≤ 0 视为缺省口径由调用方处理） */
export const clampSec = (sec: number, durSec: number): number => Math.min(Math.max(0, sec), Math.max(0, durSec));

/** 帧钳制到 [0, maxFrame]（含端点） */
export const clampFrame = (frame: number, maxFrame: number): number =>
  Math.min(Math.max(0, Math.round(frame)), Math.max(0, Math.round(maxFrame)));
