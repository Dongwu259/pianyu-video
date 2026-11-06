/**
 * agent 面时间线工具（P2.5 阶段三 v3）单测：
 * get_timeline / set_bgm_position / set_narration_timing / reorder_segments
 * 校验器边界 + 执行器与 mock store 的读写闭环 + 与 UI 时间轴同源的布局断言。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/timeline-tools.test.ts
 */
import assert from 'node:assert/strict';
// 必须在 toolExecutors 链（最终引用 ThreeText 的 .ttf 字体 import）之前求值
import './asset-stub.cjs';
import {TOOL_EXECUTORS} from '../../src/renderer/ai/toolExecutors.ts';
import {applyTimelineCommand} from '../../src/renderer/store/timeline-core.ts';
import {LLM_TOOL_REGISTRY, EDGE_TOOL_NAMES,
  validateSetBgmPositionArgs, validateSetNarrationTimingArgs, validateReorderSegmentsArgs, validateMoveShotArgs, validateSetSegmentBeatsArgs} from '../../src/shared/llm-tools.ts';
import {computeTimelineLayout} from '../../src/shared/timeline-layout.ts';
import type {BgmTrack, Segment, SfxConfig} from '../../src/shared/types.ts';

let passed = 0;
const t = (name: string, fn: () => void | Promise<void>) => {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  })();
};

const seg = (id: string, duration: number, over: Partial<Segment> = {}): Segment =>
  ({
    // 用真实内置模板 id：get_timeline 的可渲染谓词查模板注册表
    id, templateId: 'RevealSlide', videos: [], text: {title: id}, style: {}, layout: {} as Segment['layout'],
    duration, transition: 'crossfade', ...over,
  }) as Segment;

const SFX: SfxConfig = {enabled: true, volume: 0.8, transitionWhoosh: true, beatImpact: false, introRiser: true};

/** mock store：只实现四个工具触及的字段与动作（bgm、segments、sfx、update 系列、sync、applySegmentOrder） */
const makeStore = (segments: Segment[], bgm: BgmTrack | null) => {
  const store: any = {
    segments,
    bgm,
    sfx: SFX,
    customTemplates: [],
    marketTemplates: [],
    generatedTemplates: [],
    updateBgm: (patch: Record<string, number | undefined>) => {
      if (!store.bgm) return;
      store.bgm = {...store.bgm};
      for (const [k, v] of Object.entries(patch)) {
        (store.bgm as any)[k] = v; // undefined 值也写入 = 清除字段（与真 store 展开语义一致）
      }
    },
    updateSegmentNarration: (index: number, patch: Record<string, number | undefined>) => {
      store.segments = [...store.segments];
      const s = {...store.segments[index], narration: {...(store.segments[index].narration ?? {text: ''})}};
      for (const [k, v] of Object.entries(patch)) (s.narration as any)[k] = v;
      store.segments[index] = s;
    },
    syncCurrentToSegment: () => {},
    writeSegmentTiming: () => {},
    // M1.5 命令通道：mock 直挂真实分发表（事务入史由真 store 走，这里只测写效果）
    runTimelineCommand: (cmd: any) => applyTimelineCommand(store, cmd),
    applySegmentOrder: (order: number[]) => {
      const n = store.segments.length;
      if (!Array.isArray(order) || order.length !== n || !order.every((i) => Number.isInteger(i) && i >= 0 && i < n) || new Set(order).size !== n) return;
      store.segments = order.map((i) => store.segments[i]);
    },
    moveVideoAcrossSegments: (fromSeg: number, clipIdx: number, toSeg: number, position?: number) => {
      const from = store.segments[fromSeg];
      const to = store.segments[toSeg];
      if (!from || !to) return false;
      const clip = from.videos[clipIdx];
      if (!clip) return false;
      const fromVideos = from.videos.filter((_, i) => i !== clipIdx);
      const insertAt = position === undefined ? to.videos.length : Math.max(0, Math.min(to.videos.length, position));
      const toVideos = fromSeg === toSeg
        ? [...fromVideos.slice(0, insertAt), clip, ...fromVideos.slice(insertAt)]
        : [...to.videos.slice(0, insertAt), clip, ...to.videos.slice(insertAt)];
      const segments = [...store.segments];
      if (fromSeg === toSeg) {
        segments[toSeg] = {...to, videos: toVideos};
      } else {
        segments[fromSeg] = {...from, videos: fromVideos};
        segments[toSeg] = {...to, videos: toVideos};
      }
      store.segments = segments;
      return true;
    },
    // M3 L2（v1.4）：节拍标记命令分发目标（真 store 里另有 0.1 钳制规整，mock 直写）
    setSegmentBeats: (index: number, beats: any) => {
      store.segments = [...store.segments];
      store.segments[index] = {...store.segments[index], beats: beats && beats.length > 0 ? beats : undefined};
    },
  };
  return store;
};
const ctxOf = (store: any) => ({getStore: () => store});

const tasks = (async () => {
  console.log('timeline-tools（agent 面时间线工具）:');

  // ===== 注册表与面归属 =====
  // v6 翻面已落地（4fc9dab，模型线按 schema §5 建议）：四时间轴工具 + set_bgm 进 EDGE（19→24）；
  // set_narration_timing 随旁白族（synthesize_narration 不在 EDGE）后置
  await t('六个时间线工具已注册且执行器一一对应；EDGE 24 面 = v6 翻面后形态', () => {
    for (const name of ['get_timeline', 'set_bgm_position', 'set_narration_timing', 'reorder_segments', 'move_shot', 'set_segment_beats']) {
      assert.ok(LLM_TOOL_REGISTRY.some((e) => e.name === name), `${name} 应在注册表`);
      assert.ok(TOOL_EXECUTORS[name], `${name} 应有执行器`);
    }
    for (const name of ['get_timeline', 'move_shot', 'reorder_segments', 'set_bgm_position', 'set_bgm']) {
      assert.ok(EDGE_TOOL_NAMES.has(name), `${name} 应在 EDGE 面（v6 翻面已落地）`);
    }
    assert.ok(!EDGE_TOOL_NAMES.has('set_narration_timing'), 'set_narration_timing 随旁白族后置，不在 EDGE 面');
    // v1.4 新工具不进 EDGE（现役不见未训练工具纪律；翻面节奏模型线拍板）
    assert.ok(!EDGE_TOOL_NAMES.has('set_segment_beats'), 'set_segment_beats（v1.4）不在 EDGE 面');
    // 2026-11-03 数据走私收编：26→29（+get_app_status / import_segment_media / set_video_type）
    // 依据：sft-v9 832 窗里 761 窗在调这三个工具，但它们此前不在 EDGE schema 内。
    assert.equal(EDGE_TOOL_NAMES.size, 29); // v7 翻面 26 + 收编 3
  });

  // ===== get_timeline =====
  {
    const store = makeStore(
      [
        seg('a', 4, {transition: 'whip', transitionParams: {durationSec: 0.8}, transitionSfx: 'drop'}),
        seg('b', 6, {
          transition: 'none',
          narration: {text: '旁白', duration: 3},
          videos: [{id: 'v1', src: '', name: 'clip1.mp4', width: 1920, height: 1080, duration: 10, type: 'video', trimStart: 2, trimEnd: 5.5}] as any,
        }),
      ],
      {name: 'bgm-a', src: '', path: '', duration: 30, volume: 0.6, fadeIn: 0.5, fadeOut: 1.5, startAtSec: 3, trimStartSec: 4, trimEndSec: 10, beats: [5, 6, 7], bpm: 120},
    );
    await t('get_timeline：布局与 UI 同源（起点/时长/转场窗）+ BGM 派生值 + 素材窗', async () => {
      const r: any = await TOOL_EXECUTORS.get_timeline({}, ctxOf(store) as any);
      assert.equal(r.result.ok, true);
      const layout = computeTimelineLayout(store.segments);
      assert.equal(r.result.totalSec, layout.totalSec);
      assert.equal(r.result.clips[0].startSec, 0);
      assert.equal(r.result.clips[1].startSec, 4);
      assert.equal(r.result.clips[0].transition.type, 'whip');
      assert.equal(r.result.clips[0].transition.durationSec, 0.8);
      assert.equal(r.result.clips[0].transition.sfx, 'drop');
      assert.equal(r.result.clips[1].transition, 'none');
      // 素材窗（shot 的媒体出入点）
      assert.deepEqual(
        {s: r.result.clips[1].media[0].trimStartSec, e: r.result.clips[1].media[0].trimEndSec},
        {s: 2, e: 5.5},
      );
      // 旁白偏移缺省 0
      assert.equal(r.result.clips[1].narration.offsetSec, 0);
      // shots 投影（additive 字段）：b 段 1 素材 shot（c1，trim 2~5.5）+ a 段为纯模板 shot
      const c1 = r.result.shots.find((s: any) => s.id === 'v1');
      assert.ok(c1, '素材 shot v1 应在 shots');
      assert.equal(c1.mediaInSec, 2);
      assert.equal(c1.mediaOutSec, 5.5);
      assert.equal(c1.segIndex, 1);
      assert.ok(r.result.shots.some((s: any) => s.id === 'text-a' && s.kind === 'text'));
      // BGM 派生：循环窗 4~10（6s），节拍时间轴映射后窗内 3 拍（5/6/7 → 4/5/6 映射）
      assert.equal(r.result.bgm.startAtSec, 3);
      assert.equal(r.result.bgm.loopSpanSec, 6);
      assert.equal(r.result.bgm.beatCount, 3);
    });

    await t('get_timeline：sfx.clips 透传（v1.1 additive；未添加时键缺省）', async () => {
      // 基线：无 clips → result.sfx 无 clips 键（v1.0 消费方无感）
      const base: any = await TOOL_EXECUTORS.get_timeline({}, ctxOf(store) as any);
      assert.equal(base.result.ok, true);
      assert.equal(base.result.sfx.clips, undefined);
      // 有手放音效 → additive 透出（agent 可感知用户手放的音效轨）
      store.sfx = {
        ...SFX,
        clips: [
          {id: 'sfxclip-x1', kind: 'impact', atSec: 2.5, volume: 0.9},
          {id: 'sfxclip-x2', kind: 'whoosh', atSec: 9.9, volume: 1},
        ],
      };
      const r: any = await TOOL_EXECUTORS.get_timeline({}, ctxOf(store) as any);
      assert.equal(r.result.sfx.clips.length, 2);
      assert.deepEqual(r.result.sfx.clips[0], {id: 'sfxclip-x1', kind: 'impact', atSec: 2.5, volume: 0.9});
      assert.equal(r.result.sfx.clips[1].kind, 'whoosh');
      store.sfx = SFX; // 还原，不影响后续用例
    });
  }

  // ===== set_bgm_position =====
  {
    const store = makeStore([seg('a', 10)], {name: 'bgm-a', src: '', path: '', duration: 30, volume: 0.6, fadeIn: 0.5, fadeOut: 1});
    await t('set_bgm_position：写入并回读生效值（钳制：起播 ≤ 片长-1、窗 ≥ 2s）', async () => {
      const r: any = await TOOL_EXECUTORS.set_bgm_position({startAtSec: 99, trimStartSec: 28.7, fadeInSec: 12}, ctxOf(store) as any);
      assert.equal(r.result.ok, true);
      assert.equal(r.result.applied.startAtSec, 9); // 片长 10-1
      assert.equal(r.result.applied.trimStartSec, 28); // dur-2
      assert.equal(r.result.applied.fadeInSec, 8); // 0-8
      // 窗终点跟随生效 start 抬升
      const r2: any = await TOOL_EXECUTORS.set_bgm_position({trimEndSec: 5}, ctxOf(store) as any);
      assert.equal(r2.result.applied.trimEndSec, 30); // < trimStart+2 → 抬到 28+2 = 30
    });
    await t('set_bgm_position：无 BGM 报可行动错误；空参数被校验器拦下', async () => {
      const noBgm = makeStore([seg('a', 5)], null);
      const r: any = await TOOL_EXECUTORS.set_bgm_position({startAtSec: 2}, ctxOf(noBgm) as any);
      assert.equal(r.result.ok, false);
      assert.ok(r.result.errors[0].includes('背景音乐'));
      const bad = validateSetBgmPositionArgs({fadeInSec: 'x'});
      assert.equal(bad.ok, false);
      const empty = validateSetBgmPositionArgs({});
      assert.equal(empty.ok, false);
      const neg = validateSetBgmPositionArgs({startAtSec: -1});
      assert.equal(neg.ok, false);
    });
  }

  // ===== set_narration_timing =====
  {
    const store = makeStore([seg('a', 5, {narration: {text: 'x', duration: 4}}), seg('b', 5)], null);
    await t('set_narration_timing：偏移钳制到段长 + 音量钳制 + 回读', async () => {
      const r: any = await TOOL_EXECUTORS.set_narration_timing({segmentIndex: 0, offsetSec: 9, volume: 2}, ctxOf(store) as any);
      assert.equal(r.result.ok, true);
      assert.equal(r.result.applied.offsetSec, 5); // 段长 5
      assert.equal(r.result.applied.volume, 1);
      assert.equal(store.segments[0].narration.offsetSec, 5);
    });
    await t('set_narration_timing：无旁白音频 / 段越界 / 空参数报错', async () => {
      const r1: any = await TOOL_EXECUTORS.set_narration_timing({segmentIndex: 1, offsetSec: 1}, ctxOf(store) as any);
      assert.equal(r1.result.ok, false);
      assert.ok(r1.result.errors[0].includes('没有旁白'));
      const r2: any = await TOOL_EXECUTORS.set_narration_timing({segmentIndex: 9, offsetSec: 1}, ctxOf(store) as any);
      assert.equal(r2.result.ok, false);
      assert.equal(validateSetNarrationTimingArgs({segmentIndex: 0}).ok, false);
      assert.equal(validateSetNarrationTimingArgs({segmentIndex: -1, offsetSec: 1}).ok, false);
    });
  }

  // ===== reorder_segments =====
  {
    const store = makeStore([seg('a', 4), seg('b', 6), seg('c', 8)], null);
    await t('reorder_segments：全排列一次到位，转场随片段走', async () => {
      const r: any = await TOOL_EXECUTORS.reorder_segments({order: [2, 0, 1]}, ctxOf(store) as any);
      assert.equal(r.result.ok, true);
      assert.deepEqual(store.segments.map((s: Segment) => s.id), ['c', 'a', 'b']);
      assert.deepEqual(r.result.templateIds, ['RevealSlide', 'RevealSlide', 'RevealSlide']);
    });
    await t('reorder_segments：恒等序号直通；非法排列（长度/越界/重复）报错', async () => {
      const r0: any = await TOOL_EXECUTORS.reorder_segments({order: [0, 1, 2]}, ctxOf(store) as any);
      assert.equal(r0.result.ok, true);
      assert.ok(r0.result.message.includes('未做改动'));
      const before = store.segments.map((s: Segment) => s.id);
      for (const order of [[0, 1], [0, 1, 3], [0, 0, 2]]) {
        const r: any = await TOOL_EXECUTORS.reorder_segments({order}, ctxOf(store) as any);
        assert.equal(r.result.ok, false, `order=${order} 应被拒`);
      }
      assert.deepEqual(store.segments.map((s: Segment) => s.id), before, '非法输入不改 store');
      assert.equal(validateReorderSegmentsArgs({order: []}).ok, false);
      assert.equal(validateReorderSegmentsArgs({order: [0, 0]}).ok, false);
      assert.equal(validateReorderSegmentsArgs({}).ok, false);
    });
  }

  // ===== move_shot =====
  {
    const v1 = {id: 'sv1', src: '', name: 'hero.mp4', width: 1920, height: 1080, duration: 20, type: 'video', trimStart: 1, trimEnd: 5};
    const v2 = {id: 'sv2', src: '', name: 'cta.mp4', width: 1920, height: 1080, duration: 20, type: 'video'};
    const store = makeStore([seg('a', 4, {videos: [v1] as any}), seg('b', 6, {videos: [v2] as any})], null);
    await t('move_shot：跨段搬移（裁剪窗保留、回读新位置）+ 段内重排', async () => {
      const r: any = await TOOL_EXECUTORS.move_shot({fromSegmentIndex: 0, clipIndex: 0, toSegmentIndex: 1, position: 0}, ctxOf(store) as any);
      assert.equal(r.result.ok, true);
      assert.equal(r.result.shotId, 'sv1');
      assert.deepEqual(r.result.moved, {toSegmentIndex: 1, clipIndex: 0});
      assert.deepEqual(store.segments[0].videos.map((v: any) => v.id), []);
      assert.deepEqual(store.segments[1].videos.map((v: any) => v.id), ['sv1', 'sv2']);
      assert.equal(store.segments[1].videos[0].trimStart, 1, '裁剪窗应随搬迁保留');
      // 段内重排：b 段内把 sv2 挪到最前
      const r2: any = await TOOL_EXECUTORS.move_shot({fromSegmentIndex: 1, clipIndex: 1, toSegmentIndex: 1, position: 0}, ctxOf(store) as any);
      assert.equal(r2.result.ok, true);
      assert.deepEqual(store.segments[1].videos.map((v: any) => v.id), ['sv2', 'sv1']);
    });
    await t('move_shot：段/素材越界报错；校验器拦非整数', async () => {
      const r1: any = await TOOL_EXECUTORS.move_shot({fromSegmentIndex: 9, clipIndex: 0, toSegmentIndex: 0}, ctxOf(store) as any);
      assert.equal(r1.result.ok, false);
      const r2: any = await TOOL_EXECUTORS.move_shot({fromSegmentIndex: 0, clipIndex: 5, toSegmentIndex: 1}, ctxOf(store) as any);
      assert.equal(r2.result.ok, false);
      assert.ok(r2.result.errors[0].includes('shots[].clipIndex'));
      assert.equal(validateMoveShotArgs({fromSegmentIndex: -1, clipIndex: 0, toSegmentIndex: 0}).ok, false);
      assert.equal(validateMoveShotArgs({fromSegmentIndex: 0.5, clipIndex: 0, toSegmentIndex: 0}).ok, false);
      assert.equal(validateMoveShotArgs({fromSegmentIndex: 0, clipIndex: 0, toSegmentIndex: 0, position: -2}).ok, false);
      assert.equal(validateMoveShotArgs({fromSegmentIndex: 0, clipIndex: 0, toSegmentIndex: 0}).ok, true);
    });
  }

  // ===== set_segment_beats（v1.4 M3 L2：手放节拍标记） =====
  {
    const store = makeStore([seg('a', 6), seg('b', 4)], null);
    await t('set_segment_beats：写入→get_timeline clips[i].beats 回读→清除', async () => {
      const r1: any = await TOOL_EXECUTORS.set_segment_beats(
        {segmentIndex: 0, beats: [{t: 1.04, kind: 'accent', target: '第三行'}, {t: 2.5, kind: 'mark'}]},
        ctxOf(store) as any,
      );
      assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
      assert.equal(r1.result.beats.length, 2);
      assert.equal(r1.result.beats[0].t, 1.0, 't 收 0.1 步进（校验器）');
      const g: any = await TOOL_EXECUTORS.get_timeline({}, ctxOf(store) as any);
      assert.deepEqual(g.result.clips[0].beats, r1.result.beats, 'get_timeline 回读（v1.4 additive 键）');
      assert.equal(g.result.clips[1].beats, undefined, '未手放的段键缺省（旧消费方无感）');
      const r2: any = await TOOL_EXECUTORS.set_segment_beats({segmentIndex: 0}, ctxOf(store) as any);
      assert.equal(r2.result.ok, true);
      assert.ok((r2.result.message as string).includes('清除'));
      assert.equal(store.segments[0].beats, undefined, '清除 = undefined');
    });
    await t('set_segment_beats：越界 t/坏 kind/超 32 个拒绝', async () => {
      const oob: any = await TOOL_EXECUTORS.set_segment_beats({segmentIndex: 0, beats: [{t: 6, kind: 'mark'}]}, ctxOf(store) as any);
      assert.equal(oob.result.ok, false);
      assert.ok((oob.result.errors[0] as string).includes('超出'));
      const badKind = validateSetSegmentBeatsArgs({segmentIndex: 0, beats: [{t: 1, kind: 'drop'}]});
      assert.equal(badKind.ok, false);
      const tooMany = validateSetSegmentBeatsArgs({segmentIndex: 0, beats: Array.from({length: 33}, () => ({t: 1, kind: 'mark'}))});
      assert.equal(tooMany.ok, false && tooMany.errors[0].includes('32'));
      const okForm = validateSetSegmentBeatsArgs({segmentIndex: 1, beats: [{t: 2.26, kind: 'accent', note: '副歌', target: ''}]});
      assert.ok(okForm.ok);
      assert.equal((okForm as any).args.beats[0].t, 2.3, '校验器 0.1 进位');
      assert.equal((okForm as any).args.beats[0].target, undefined, '空 target 不落键');
      const clear = validateSetSegmentBeatsArgs({segmentIndex: 1});
      assert.ok(clear.ok && (clear as any).args.beats === undefined, 'beats 缺省 = 清除形态');
    });
  }

  const total = 12;
  console.log(passed === total ? `timeline-tools: ✓ 全部通过（${passed}/${total}）` : `timeline-tools: ${passed}/${total}`);
})();

export {};
