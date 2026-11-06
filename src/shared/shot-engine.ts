/** Shot-level timeline compiler. Keeps the renderer's Segment contract while
 * allowing a plan to choose exact source windows and cut transitions. */

import type {EditPlanShot} from './edit-plan.ts';
import type {Segment, VideoClip, TransitionType} from './types.ts';

export interface ShotPlan extends EditPlanShot {
  sourceType?: 'video' | 'image' | 'model';
}

export interface ShotTimelineItem {
  shot: ShotPlan;
  startFrame: number;
  durationFrames: number;
  sourceStartSec: number;
  sourceEndSec: number;
}

export interface VideoCutSpec {
  id: string;
  sourcePath: string;
  sourceStartSec: number;
  sourceEndSec: number;
  timelineStartSec: number;
  timelineEndSec: number;
  templateId?: string;
  transition?: TransitionType;
}

export const normalizeShotPlan = (shots: ShotPlan[], mediaDurations: Record<string, number> = {}): ShotPlan[] => {
  let cursor = 0;
  return shots
    .filter((s) => s && s.id && s.sourcePath)
    .map((s) => {
      const duration = Math.max(0.05, Number.isFinite(s.timelineEndSec - s.timelineStartSec) ? s.timelineEndSec - s.timelineStartSec : 0.5);
      const maxSource = Math.max(0, mediaDurations[s.sourcePath] ?? s.sourceEndSec);
      const sourceStartSec = Math.max(0, Math.min(maxSource, Number.isFinite(s.sourceStartSec) ? s.sourceStartSec : 0));
      const sourceEndSec = Math.max(sourceStartSec + 0.05, Math.min(maxSource || sourceStartSec + duration, Number.isFinite(s.sourceEndSec) ? s.sourceEndSec : sourceStartSec + duration));
      const timelineStartSec = Math.max(cursor, Number.isFinite(s.timelineStartSec) ? s.timelineStartSec : cursor);
      const timelineEndSec = timelineStartSec + duration;
      cursor = timelineEndSec;
      return {...s, sourceStartSec, sourceEndSec, timelineStartSec, timelineEndSec, confidence: Math.max(0, Math.min(1, Number.isFinite(s.confidence) ? s.confidence : 0.5))};
    });
};

export const buildShotTimeline = (shots: ShotPlan[], fps = 30, mediaDurations: Record<string, number> = {}): ShotTimelineItem[] =>
  normalizeShotPlan(shots, mediaDurations).map((shot) => ({shot, startFrame: Math.round(shot.timelineStartSec * fps), durationFrames: Math.max(1, Math.round((shot.timelineEndSec - shot.timelineStartSec) * fps)), sourceStartSec: shot.sourceStartSec, sourceEndSec: shot.sourceEndSec}));

/** Group adjacent shots that use the same template; source windows remain in order. */
export const groupShotsIntoTemplateSegments = (shots: ShotPlan[]): Array<{templateId?: string; shots: ShotPlan[]; startSec: number; endSec: number}> => {
  const groups: Array<{templateId?: string; shots: ShotPlan[]; startSec: number; endSec: number}> = [];
  for (const shot of normalizeShotPlan(shots)) {
    const last = groups[groups.length - 1];
    if (last && last.templateId === shot.templateId && shot.timelineStartSec <= last.endSec + 0.01) {
      last.shots.push(shot);
      last.endSec = shot.timelineEndSec;
    } else groups.push({templateId: shot.templateId, shots: [shot], startSec: shot.timelineStartSec, endSec: shot.timelineEndSec});
  }
  return groups;
};

export const planJLCuts = (shots: ShotPlan[], minDurationSec = 0.25): ShotPlan[] => normalizeShotPlan(shots).filter((s) => s.timelineEndSec - s.timelineStartSec >= minDurationSec);

export const planBrollInsertions = (shots: ShotPlan[], broll: ShotPlan[], maxPerBeat = 2): ShotPlan[] => {
  const out = [...shots];
  const byBeat = new Map<string, number>();
  for (const item of broll) {
    const count = byBeat.get(item.beatId) ?? 0;
    if (count >= maxPerBeat) continue;
    const anchor = shots.find((s) => s.beatId === item.beatId);
    if (!anchor) continue;
    out.push({...item, timelineStartSec: Math.max(anchor.timelineStartSec, item.timelineStartSec), timelineEndSec: Math.min(anchor.timelineEndSec, item.timelineEndSec)});
    byBeat.set(item.beatId, count + 1);
  }
  return normalizeShotPlan(out.sort((a, b) => a.timelineStartSec - b.timelineStartSec));
};

export const planShotTransitions = (shots: ShotPlan[], transition: TransitionType = 'none'): ShotPlan[] => normalizeShotPlan(shots).map((shot, i, all) => ({...shot, transition: i < all.length - 1 ? {...shot.transition, type: shot.transition?.type ?? transition} : shot.transition}));

/** Turn each shot into a renderer-compatible VideoClip with an exact trim window. */
export const compileShotsToVideoClips = (
  shots: ShotPlan[],
  clipsByPath: Record<string, VideoClip>,
): VideoClip[] => normalizeShotPlan(shots).flatMap((shot, i) => {
  const clip = clipsByPath[shot.sourcePath];
  if (!clip) return [];
  const trimStart = Math.max(0, Math.min(clip.duration, shot.sourceStartSec));
  const trimEnd = Math.max(trimStart + 0.01, Math.min(clip.duration, shot.sourceEndSec));
  return [{...clip, id: `${clip.id}-shot-${i + 1}`, trimStart, trimEnd, trimmedDuration: trimEnd - trimStart}];
});

/** Compatibility adapter: attach shot clips to existing segments without changing template rendering. */
export const applyShotPlanToSegments = (
  segments: Segment[],
  shots: ShotPlan[],
  clipsByPath: Record<string, VideoClip>,
  beatIds?: string[],
): Segment[] => {
  const byBeat = new Map<string, ShotPlan[]>();
  for (const shot of shots) byBeat.set(shot.beatId, [...(byBeat.get(shot.beatId) ?? []), shot]);
  return segments.map((segment, index) => {
    const beatId = beatIds?.[index] ?? `beat-${index}`;
    const segmentShots = [
      ...(byBeat.get(beatId) ?? []),
      ...(byBeat.get(`beat-${index}`) ?? []).filter((shot) => shot.beatId !== beatId),
      ...shots.filter((shot) => shot.sceneId === `scene-${index}` && shot.beatId !== beatId),
    ].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
    if (segmentShots.length === 0) return segment;
    // Prefer the clip already attached to this segment. This matters when one
    // source file is reused with different viewport/effect metadata in two beats.
    const localClips: Record<string, VideoClip> = {...clipsByPath};
    for (const clip of segment.videos ?? []) {
      localClips[clip.src] = clip;
      localClips[clip.name] = clip;
      try {
        const path = new URL(clip.src).searchParams.get('path');
        if (path) {
          localClips[path] = clip;
          localClips[path.split(/[\\/]/).pop() || path] = clip;
        }
      } catch {
        // src can be a plain filesystem path in headless/project-file tests.
      }
      localClips[clip.name.split(/[\\/]/).pop() || clip.name] = clip;
    }
    const clips = compileShotsToVideoClips(segmentShots, localClips);
    return clips.length > 0 ? {...segment, videos: clips} : segment;
  });
};
