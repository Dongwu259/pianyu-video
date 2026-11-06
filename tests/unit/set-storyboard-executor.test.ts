import assert from 'node:assert/strict';
// 必须在 toolExecutors 链（最终引用 ThreeText 的 .ttf 字体 import）之前求值
import './asset-stub.cjs';
import {TOOL_EXECUTORS} from '../../src/renderer/ai/toolExecutors.ts';
import {createLlmTools} from '../../src/shared/llm-tools.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS} from '../../src/shared/types.ts';

const llm = createLlmTools({
  templates: TEMPLATES,
  transitions: TRANSITION_OPTIONS.map((x) => x.value),
  videoEffects: VIDEO_EFFECT_OPTIONS.map((x) => x.value),
  backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((x) => x.value),
  textAnims: TEXT_ANIM_OPTIONS.map((x) => x.value),
});

const makeContext = () => {
  let applied: unknown[] | undefined;
  let plan: any;
  const store: any = {
    videoType: 'tutorial',
    customTemplates: [],
    marketTemplates: [],
    generatedTemplates: [],
    segments: [],
    applyAiStoryboard: (segments: unknown[]) => { applied = segments; store.segments = segments; },
    setEditPlan: (next: unknown) => { plan = next; },
  };
  return {store, ctx: {llm, getStore: () => store}, getApplied: () => applied, getPlan: () => plan};
};

const shot = (id: string, confidence: number) => ({
  id,
  beatId: 'custom-beat',
  sourcePath: `${id}.mp4`,
  sourceStartSec: 0,
  sourceEndSec: 2,
  timelineStartSec: confidence === 0.9 ? 0 : confidence === 0.6 ? 2 : 4,
  timelineEndSec: confidence === 0.9 ? 2 : confidence === 0.6 ? 4 : 6,
  confidence,
});

const run = async (args: unknown, context: ReturnType<typeof makeContext>) =>
  TOOL_EXECUTORS.set_storyboard(args, context.ctx as any);

{
  const context = makeContext();
  const result: any = await run({
    segments: [{templateId: 'VideoCut', duration: 6, text: {title: 'story'}}],
    editPlan: {
      beats: [{id: 'custom-beat', index: 0, startSec: 0, endSec: 6, text: 'story'}],
      shots: [shot('low', 0.2), shot('high', 0.9), shot('mid', 0.6)],
    },
  }, context);
  assert.equal(result.result.ok, true);
  assert.equal(context.getApplied()?.length, 1);
  // P1-5B：VideoCut maxVideos 1→6（段内多镜）——三个 shot 全保留（按时序排序），不再砍到只剩最高置信度一镜
  assert.deepEqual(context.getPlan().shots.map((x: any) => x.id), ['high', 'mid', 'low']);
  assert.equal(context.getPlan().shots[0].templateId, 'VideoCut');
  assert.ok(!context.getPlan().notes.some((x: string) => x.includes('超过模板最多')), '未触发素材数封顶（多素材段是合法形态）');
}

{
  const context = makeContext();
  const result: any = await run({
    segments: [{templateId: 'VideoCut', duration: 6}],
    editPlan: {
      beats: [{id: 'b', index: 0, startSec: 4, endSec: 2}],
      shots: [{...shot('bad', 0.5), beatId: 'b'}],
    },
  }, context);
  assert.equal(result.result.ok, false);
  assert.ok(result.result.errors.length > 0);
  assert.equal(context.getApplied(), undefined);
  assert.equal(context.getPlan(), undefined);
}

console.log('set-storyboard executor tests: passed');
