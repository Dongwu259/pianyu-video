/**
 * 3D 地面追踪数据 Context（与 layers/stabilization.ts 同构）
 *
 * MultiSegmentPromo 组装：收录「已开启地面追踪且内存态锚点轨迹已填充」的素材
 * （src → {track, elements, 画幅}），经 Context 下发给 ClipMedia 内的地面 3D 层
 * （GroundScene）逐帧解投影矩阵渲染。内存态（groundData）在工程加载/分析时填充，
 * 保存工程时剥离；段级 groundElements 由组装侧按素材归属配对（同一素材多个段
 * 使用时，取该段自己的元素列表）。缺数据/未开启即不收录——零数据零开销零回归。
 */

import {createContext, useContext} from 'react';
import type {GroundElement} from '../../shared/types';
import type {GroundTrackData} from '../../shared/groundTrack';

export interface GroundOverlayEntry {
  track: GroundTrackData;
  elements: GroundElement[];
  videoW: number;
  videoH: number;
}

export const GroundTrackingContext = createContext<ReadonlyMap<string, GroundOverlayEntry> | null>(null);

/** 查素材 src 的地面追踪条目；无上下文/未命中返回 null（走无地面层路径） */
export const useGroundOverlay = (src: string): GroundOverlayEntry | null => {
  const ctx = useContext(GroundTrackingContext);
  if (!ctx) return null;
  return ctx.get(src) ?? null;
};
