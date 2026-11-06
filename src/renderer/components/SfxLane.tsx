/**
 * SfxLane - 故事板音效轨（时间轴可视化）
 *
 * 挂在故事板时间线的片段卡片下方，按全片时长铺一条轨道：
 * - 转场音效 ◆（按转场类型自动映射或用户逐段指定；'off' 不显示）——点击选中该段，
 *   在转场行改音效；
 * - 节拍律动（beatImpact 开且有节拍数据）：impact 重音 ● / click 轻点 ·，用与渲染
 *   同源的 planSfxPlacements 计算（预览=渲染，所见即所听）；
 * - 片头 riser ▮。
 * 摆放规则与配色单一数据源在 shared/sfx-plan.ts。
 */
import React, {useMemo} from 'react';
import {AudioLines} from 'lucide-react';
import type {Segment, SfxConfig, BgmTrack, SfxKind} from '../../shared/types';
import {planSfxPlacements, SFX_KIND_META, TRANSITION_SFX_KIND, SFX_LEAD_SEC, type SfxPlacement} from '../../shared/sfx-plan';
import {bgmTimelineBeats} from '../../shared/bgm-track';
import {getTransitionDefaultSec} from '../../shared/transition-style';

const FPS = 30;
/** 变体数近似值（只影响缺货降级判定，不影响放置位置；真值按音效库表在渲染管线里算） */
const APPROX_VARIANT_COUNTS: Record<SfxKind, number> = {whoosh: 6, swish: 5, sweep: 4, drop: 5, impact: 5, riser: 3, click: 4, pop: 2, ding: 2};

interface TransitionMark {
  frame: number;
  kind: SfxKind;
  segIndex: number;
  off: boolean;
}

export const SfxLane: React.FC<{
  segments: Segment[];
  bgm: BgmTrack | null;
  sfx: SfxConfig | null;
  onSelectSegment: (index: number) => void;
}> = ({segments, bgm, sfx, onSelectSegment}) => {
  const totalSec = segments.reduce((a, s) => a + s.duration, 0);

  // 转场音效标记：直接按段推导（含用户 override / off）
  const transitionMarks = useMemo<TransitionMark[]>(() => {
    if (!sfx?.enabled) return [];
    let acc = 0;
    const marks: TransitionMark[] = [];
    segments.forEach((seg, i) => {
      acc += seg.duration;
      if (i === segments.length - 1 || seg.transition === 'none') return;
      const kind = seg.transitionSfx && seg.transitionSfx !== 'off' ? seg.transitionSfx : TRANSITION_SFX_KIND[seg.transition] ?? 'whoosh';
      marks.push({
        frame: Math.round(acc * FPS) - Math.round(SFX_LEAD_SEC[kind] * FPS),
        kind,
        segIndex: i,
        off: seg.transitionSfx === 'off',
      });
    });
    return marks;
  }, [segments, sfx?.enabled]);

  // 节拍律动 + 片头 riser：与渲染同源的放置规划
  const beatMarks = useMemo<SfxPlacement[]>(() => {
    if (!sfx?.enabled) return [];
    let acc = 0;
    const timings = segments.map((seg, i) => {
      const startF = Math.round(acc * FPS);
      acc += seg.duration;
      const isLast = i === segments.length - 1;
      const tail = isLast || seg.transition === 'none'
        ? 0
        : Math.round((seg.transitionParams?.durationSec ?? getTransitionDefaultSec(seg.transition) ?? 0.5) * FPS);
      return {
        contentStartFrame: startF,
        contentEndFrame: Math.round(acc * FPS),
        outOverlap: tail,
        isLast,
        transition: seg.transition,
        sfxOverride: seg.transitionSfx,
      };
    });
    const beats = sfx.beatImpact ? bgmTimelineBeats(bgm) : [];
    return planSfxPlacements(timings, beats, FPS, sfx, APPROX_VARIANT_COUNTS)
      .filter((p) => p.kind === 'impact' || p.kind === 'click' || p.kind === 'riser');
  }, [segments, bgm, sfx]);

  if (!sfx?.enabled || totalSec <= 0) return null;
  const pct = (frame: number) => Math.min(100, Math.max(0, (frame / FPS / totalSec) * 100));

  return (
    <div className="sfx-lane" title="音效轨：◆=转场音效（点击选中片段可改/关）· ●=节拍重音 · ·=轻点 · ▮=片头上升音">
      <span className="sfx-lane-label"><AudioLines size={12} /> 音效</span>
      <div className="sfx-lane-track">
        {beatMarks.map((p, i) => {
          const meta = SFX_KIND_META[p.kind];
          return (
            <span
              key={`b-${i}`}
              className={`sfx-mark sfx-mark-${p.kind}`}
              style={{left: `${pct(p.frame)}%`, background: meta.color}}
              title={`${meta.label}${p.kind === 'impact' ? '（节拍重音）' : p.kind === 'click' ? '（弱拍轻点）' : '（片头）'}`}
            />
          );
        })}
        {transitionMarks.map((m, i) => {
          const meta = SFX_KIND_META[m.kind];
          return (
            <button
              key={`t-${i}`}
              type="button"
              className={`sfx-mark sfx-mark-transition ${m.off ? 'sfx-mark-off' : ''}`}
              style={{left: `${pct(m.frame)}%`, borderColor: meta.color}}
              title={`第 ${m.segIndex + 1} → ${m.segIndex + 2} 段转场音效：${m.off ? '已关' : meta.label}（点击选中该片段修改）`}
              onClick={() => onSelectSegment(m.segIndex)}
            />
          );
        })}
      </div>
    </div>
  );
};
