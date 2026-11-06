import assert from 'node:assert/strict';
import {applyShotPlanToSegments, buildShotTimeline, compileShotsToVideoClips, groupShotsIntoTemplateSegments} from '../../src/shared/shot-engine.ts';

const shots = [
  {id: 'a', beatId: 'beat-0', sourcePath: 'a.mp4', sourceStartSec: 1, sourceEndSec: 3, timelineStartSec: 0, timelineEndSec: 2, templateId: 'VideoCut', confidence: 0.9},
  {id: 'b', beatId: 'beat-0', sourcePath: 'a.mp4', sourceStartSec: 3, sourceEndSec: 5, timelineStartSec: 2, timelineEndSec: 4, templateId: 'VideoCut', confidence: 0.9},
] as const;
assert.equal(buildShotTimeline([...shots], 30)[1].startFrame, 60);
assert.equal(groupShotsIntoTemplateSegments([...shots]).length, 1);
const clips = compileShotsToVideoClips([...shots], { 'a.mp4': {id: 'v', src: 'x', name: 'a.mp4', width: 1920, height: 1080, duration: 8, type: 'video'} });
assert.deepEqual(clips.map((c) => [c.trimStart, c.trimEnd]), [[1, 3], [3, 5]]);

const segment = {
  id: 'seg-1', templateId: 'VideoCut', duration: 4, videos: [{id: 'v', src: 'http://127.0.0.1/video?path=C%3A%2Fmedia%2Fa.mp4', name: 'a.mp4', width: 1920, height: 1080, duration: 8, type: 'video' as const}],
  text: {title: '', subtitle: '', features: [], brandName: ''}, style: {}, layout: {}, customParams: {}, transition: 'none' as const,
} as any;
const customBeatShots = [{...shots[0], beatId: 'story-beat', sourcePath: 'C:/media/a.mp4'}];
const applied = applyShotPlanToSegments([segment], customBeatShots, {}, ['story-beat']);
assert.equal(applied[0].videos[0].trimStart, 1, 'custom beat id resolves to segment');
assert.equal(applied[0].videos[0].trimEnd, 3, 'HTTP clip path resolves to planned source window');
console.log('shot-engine tests: passed');
