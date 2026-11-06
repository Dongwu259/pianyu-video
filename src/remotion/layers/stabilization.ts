/**
 * 跟踪稳定渲染上下文（方案 A 渲染期，见 RESEARCH-STABILIZATION.md）
 *
 * MultiSegmentPromo 把「素材 src → 稳定数据（每帧校正量表 + 全片统一 zoom + 视频画幅）」
 * 映射表放进 Context；ClipMedia（所有视频/图片的唯一渲染出口）按自己的 src 查表，
 * 把当前帧的校正量换算成 CSS transform 套在媒体元素上。模板零改动——无论素材经
 * Video3D 画框还是全屏铺放，稳定都生效。预览（Player）与导出（renderMedia）共用
 * 同一消费点，天然 WYSIWYG。
 *
 * 时间映射（ClipMedia 侧）：片段时间轴帧 f → timelineToMediaSec(f/fps, startFrom/fps,
 * cutsSec)（与挖段切片播放同一映射，媒体绝对秒）→ sampleCorrectionAt 查表（表内 t 也是
 * 媒体绝对秒，分析期按 trimStart 起算回填）→ correctionToCss。
 *
 * 变换挂载点：稳定 transform 前插到媒体元素自身 style.transform 之前（最外层），
 * translate 的 % 相对媒体元素盒（= 适配后的视频盒），旋转/缩放绕视频中心——与
 * requiredZoom 的覆盖推导同口径。不包额外 div：PiP 画框 contain 留白时外框比视频盒大，
 * 包框会让 translate% 按外框缩放而过度校正。
 */

import {createContext, useContext} from 'react';
import type {StabCorrection} from '../../shared/stabilization.ts';

/** 单个素材的稳定数据（corrections 的 t 为媒体绝对秒；videoW/H 为视频像素画幅） */
export interface StabEntry {
  corrections: StabCorrection[];
  zoom: number;
  videoW: number;
  videoH: number;
}

export interface StabilizationState {
  /** 素材 src（模板传入的原始 src）→ 稳定数据 */
  entries: Map<string, StabEntry>;
}

export const StabilizationContext = createContext<StabilizationState | null>(null);

/** 取某素材的稳定数据（无上下文/未命中/空表返回 null，走原路径零回归） */
export const useStabilization = (src: string): StabEntry | null => {
  const ctx = useContext(StabilizationContext);
  if (!ctx || !src) return null;
  const e = ctx.entries.get(src);
  return e && e.corrections.length > 0 ? e : null;
};
