/**
 * Shot 时间轴投影（P2.5 阶段三：shot 升一等公民的第一片，2026-10-02）。
 *
 * 定位与边界（见 docs/agent-timeline-schema.md 定稿 v1.0）：
 * - **shot = 时间线上可独立寻址的最小内容单元**：素材 shot（segment 内一个视频/图片/模型
 *   clip，媒体出入点 = trim 窗）或纯模板 shot（无素材段的内容本体）。稳定 id = clip.id
 *   （工程内持久）或 `text-{segment.id}`。
 * - 本层是**纯投影**（segments 仍是存储主键）：computeShotTimeline 从 segments 确定性导出
 *   全片有序 shot 列表；agent 面（get_timeline.shots）与 UI 时间轴（shot 粒度指示）同源消费，
 *   渲染端按片分步接入（下一片：ClipMedia 按 shot 窗消费）。
 * - **向后兼容铁律**：get_timeline 已发布的字段冻结，shots 为 additive 字段——蒸馏痕迹按
 *   定稿 schema 采，后续演进只增不改。
 *
 * 段内多素材 = 画中画叠层：各 clip 同窗并行（layered=true），不引入段内时序语义。
 */
import type {Segment} from './types';
import {computeTimelineLayout, TIMELINE_FPS} from './timeline-layout';

/** shot 类别：video/image/model 对应 VideoClip.type；text = 无素材段的纯模板内容 */
export type ShotKind = 'video' | 'image' | 'model' | 'text';

export interface TimelineShot {
  /** 稳定 id：素材 shot = clip.id（随工程持久）；纯模板 shot = `text-{segment.id}` */
  id: string;
  kind: ShotKind;
  /** 归属段下标（0 起）——segment 是 shot 的视觉包装策略（模板/文案/转场挂在段上） */
  segIndex: number;
  /** 段内素材下标（kind=text 时缺省） */
  clipIndex?: number;
  /** 素材名（kind=text 缺省；纯模板 shot 用段模板名） */
  name: string;
  /** 时间轴窗口（秒，段内容坐标系；与 get_timeline.clips[i].startSec/durationSec 同源） */
  startSec: number;
  endSec: number;
  durationSec: number;
  /** 媒体出入点（秒，素材绝对时间；kind=text 缺省）。挖段（cuts）在窗内扣洞，细节经
   *  get_segment_media 查——投影层只给 cutsCount 摘要 */
  mediaInSec?: number;
  mediaOutSec?: number;
  /** 源素材时长（video/model） */
  sourceDurationSec?: number;
  /** 窗内挖段数 */
  cutsCount?: number;
  /** 画中画叠层：同段存在多个素材 shot 共享同一时间窗 */
  layered?: boolean;
}

export interface ShotTimeline {
  shots: TimelineShot[];
  totalSec: number;
  fps: number;
}

/**
 * 全片 shot 列表（纯函数；与 computeTimelineLayout 同一口径取整）。
 * @param opts.isRenderable 段可渲染谓词（模板缺失/未安装的段占 0 帧不产 shot——与渲染
 *   isSegmentRenderable 语义一致；UI 时间轴块仍显示缺失段作修复入口，故本投影与 UI 块数
 *   在该边例下允许不等）。缺省 = 全部可渲染（纯层默认）。
 */
export const computeShotTimeline = (
  segments: Segment[],
  opts?: {isRenderable?: (seg: Segment) => boolean},
): ShotTimeline => {
  const layout = computeTimelineLayout(segments);
  const isRenderable = opts?.isRenderable ?? (() => true);
  const shots: TimelineShot[] = [];
  segments.forEach((seg, i) => {
    const clip = layout.clips[i];
    if (!clip || clip.durationSec <= 0 || !isRenderable(seg)) return;
    const media = seg.videos.filter((v) => v && (v.type === 'video' || v.type === 'image' || v.type === 'model'));
    const layered = media.length > 1;
    if (media.length === 0) {
      // 纯模板 shot：无素材段的内容本体（文字动画/3D 场景）
      shots.push({
        id: `text-${seg.id}`,
        kind: 'text',
        segIndex: i,
        name: seg.templateId,
        startSec: clip.startSec,
        endSec: clip.endSec,
        durationSec: clip.durationSec,
      });
      return;
    }
    media.forEach((v, clipIndex) => {
      shots.push({
        id: v.id || `seg${i}-clip${clipIndex}`,
        kind: v.type,
        segIndex: i,
        clipIndex: seg.videos.indexOf(v),
        name: v.name,
        startSec: clip.startSec,
        endSec: clip.endSec,
        durationSec: clip.durationSec,
        ...(v.type === 'image'
          ? {}
          : {
              mediaInSec: v.trimStart ?? 0,
              mediaOutSec: v.trimEnd ?? v.duration,
              sourceDurationSec: v.duration,
              cutsCount: v.cuts?.length ?? 0,
            }),
        ...(layered ? {layered: true} : {}),
      });
    });
  });
  return {shots, totalSec: layout.totalSec, fps: TIMELINE_FPS};
};

/** 时间点 → 该时刻的 shot 集（叠层段返回多个；无内容返回空） */
export const findShotsAt = (timeline: ShotTimeline, sec: number): TimelineShot[] => {
  const EPS = 1e-9;
  return timeline.shots.filter((s) => sec >= s.startSec - EPS && sec < s.endSec - EPS);
};

/**
 * 全片 shot 摘要（get_timeline 的 shots 字段数据源；消息用）。
 * 不变量：Σ(每段 shot 数) = shots.length；shot 窗 ⊆ [0, totalSec]；同段 shot 同窗。
 */
export const shotSummary = (timeline: ShotTimeline): {count: number; mediaCount: number; textCount: number; layeredSegs: number} => {
  let mediaCount = 0;
  let textCount = 0;
  const layeredSegs = new Set<number>();
  for (const s of timeline.shots) {
    if (s.kind === 'text') textCount++;
    else mediaCount++;
    if (s.layered) layeredSegs.add(s.segIndex);
  }
  return {count: timeline.shots.length, mediaCount, textCount, layeredSegs: layeredSegs.size};
};
