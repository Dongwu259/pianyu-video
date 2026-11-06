/**
 * 演示鼠标轨迹生成器（src/shared/demo-cursor-track.ts）单元测试
 *
 * 覆盖：
 * - 时长正确（首点 t=0、末点 = 时长×1000、时间轴单调、采样间隔 ≈33ms）
 * - 坐标在界内（0..width / 0..height，整数；停顿点位于留边有效区内）
 * - 有停顿段（≥0.5s 近乎静止的关键位置停留）与移动段（路径确有位移）
 * - 确定性（同 seed 输出完全一致；不同 seed 输出不同）
 * - 最短时长钳制（<1s 按 1s 生成）；竖屏/小尺寸不越界
 * - projectStore：cursorDemoSeed 随工程落盘、cursorPoints 剥离；
 *   加载时无真实轨迹则按种子确定性重建演示轨迹
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/demo-cursor-track.test.ts
 */

import assert from 'node:assert/strict';
import {generateDemoCursorTrack} from '../../src/shared/demo-cursor-track.ts';
import type {CursorPoint} from '../../src/shared/capture.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const OPTS = {durationSec: 8, width: 1920, height: 1080, seed: 42};

// ====== 时长与时间轴 ======

console.log('时长与时间轴:');
{
  const pts = generateDemoCursorTrack(OPTS);
  assert.ok(pts.length > 100, `8s @30Hz 应有 240+ 采样点，实际 ${pts.length}`);
  assert.equal(pts[0].t, 0, '首点 t=0');
  assert.equal(pts[pts.length - 1].t, 8000, '末点 t = 时长×1000');
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].t - pts[i - 1].t;
    assert.ok(gap >= 0, `时间轴应单调不减（点 ${i} 回退 ${gap}ms）`);
    assert.ok(gap <= 34, `采样间隔应 ≈33ms（点 ${i} 间隔 ${gap}ms）`);
  }
  ok('首末点时间正确 / 时间轴单调 / 采样间隔 ≈33ms');
}

// ====== 坐标界内 ======

console.log('坐标界内:');
{
  const pts = generateDemoCursorTrack(OPTS);
  for (const p of pts) {
    assert.ok(p.x >= 0 && p.x <= 1920, `x 越界: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= 1080, `y 越界: ${p.y}`);
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), '坐标应为整数（对齐真实采集）');
  }
  // 留边：停顿点（近乎静止段的中心）应位于 8% 边距的有效区内（容差 = 抖动幅度）
  const marginX = 1920 * 0.08;
  const marginY = 1080 * 0.08;
  let checked = 0;
  for (let i = 0; i < pts.length; i++) {
    // 找近乎静止的连续段（相邻点位移 ≤1px）
    let j = i;
    while (j + 1 < pts.length && Math.abs(pts[j + 1].x - pts[j].x) <= 1 && Math.abs(pts[j + 1].y - pts[j].y) <= 1) j++;
    if (pts[j].t - pts[i].t >= 500) {
      assert.ok(pts[i].x >= marginX - 3 && pts[i].x <= 1920 - marginX + 3, `停顿点 x 应留边: ${pts[i].x}`);
      assert.ok(pts[i].y >= marginY - 3 && pts[i].y <= 1080 - marginY + 3, `停顿点 y 应留边: ${pts[i].y}`);
      checked++;
    }
    i = j;
  }
  assert.ok(checked >= 2, `8s 轨迹应至少检查到 2 个留边停顿点，实际 ${checked}`);
  ok('全部采样点在画面内 / 停顿点位于留边有效区');
}

// ====== 停顿段与移动段 ======

console.log('停顿段与移动段:');
{
  const pts = generateDemoCursorTrack(OPTS);
  // 停顿：存在时间跨度 ≥0.5s、最大偏移 ≤5px 的连续段
  let hasPause = false;
  let pauseCount = 0;
  for (let i = 0; i < pts.length; i++) {
    let j = i;
    let minX = pts[i].x;
    let maxX = pts[i].x;
    let minY = pts[i].y;
    let maxY = pts[i].y;
    while (
      j + 1 < pts.length &&
      Math.abs(pts[j + 1].x - pts[i].x) <= 5 &&
      Math.abs(pts[j + 1].y - pts[i].y) <= 5
    ) {
      j++;
      minX = Math.min(minX, pts[j].x);
      maxX = Math.max(maxX, pts[j].x);
      minY = Math.min(minY, pts[j].y);
      maxY = Math.max(maxY, pts[j].y);
    }
    if (pts[j].t - pts[i].t >= 500 && maxX - minX <= 5 && maxY - minY <= 5) {
      hasPause = true;
      pauseCount++;
    }
    i = j;
  }
  assert.ok(hasPause, '应存在 ≥0.5s 的停顿段');
  assert.ok(pauseCount >= 2, `8s 轨迹应有多个停顿段，实际 ${pauseCount}`);
  // 移动：整段轨迹的总位移应足够大（不是原地不动）
  let totalDist = 0;
  for (let i = 1; i < pts.length; i++) {
    totalDist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  assert.ok(totalDist > 1920, `轨迹应有明显移动，总位移 ${Math.round(totalDist)}px`);
  ok('有 ≥0.5s 停顿段（多个）/ 移动段位移充足');
}

// ====== 确定性 ======

console.log('确定性:');
{
  const a = generateDemoCursorTrack(OPTS);
  const b = generateDemoCursorTrack(OPTS);
  assert.deepEqual(a, b, '相同 seed 两次生成应完全一致');
  const c = generateDemoCursorTrack({...OPTS, seed: 43});
  assert.notDeepEqual(c, a, '不同 seed 应生成不同轨迹');
  ok('同 seed 输出一致 / 不同 seed 输出不同');
}

// ====== 边界：最短时长 / 竖屏 ======

console.log('边界:');
{
  const short = generateDemoCursorTrack({durationSec: 0.2, width: 1920, height: 1080, seed: 7});
  assert.equal(short[short.length - 1].t, 1000, '<1s 按 1s 生成');
  assert.ok(short.length >= 2);

  const portrait = generateDemoCursorTrack({durationSec: 5, width: 1080, height: 1920, seed: 7});
  for (const p of portrait) {
    assert.ok(p.x >= 0 && p.x <= 1080 && p.y >= 0 && p.y <= 1920, `竖屏越界: ${p.x},${p.y}`);
  }
  assert.equal(portrait[portrait.length - 1].t, 5000);
  ok('最短时长钳制 1s / 竖屏坐标不越界');
}

// ====== projectStore：演示种子随工程落盘 / 加载确定性重建 ======

console.log('projectStore 演示轨迹持久化:');
{
  (globalThis as any).window = {
    api: {
      getVideoHttpUrl: async (p: string) => `http://127.0.0.1:1/video?path=${encodeURIComponent(p)}`,
      captureReadCursorTrack: async () => null,
      getStore: async () => [],
      setStore: async () => true,
    },
    confirm: () => true,
  };
  const {useProjectStore, createEmptySegment} = await import('../../src/renderer/store/projectStore.ts');
  const S = useProjectStore.getState;

  const demoPts = generateDemoCursorTrack({durationSec: 10, width: 1920, height: 1080, seed: 123});
  const seg = {
    ...createEmptySegment('CursorFollow'),
    videos: [
      {
        id: 'c1',
        src: 'http://127.0.0.1:1/video?path=' + encodeURIComponent('D:\\cap\\plain.mp4'),
        name: 'plain.mp4',
        width: 1920,
        height: 1080,
        duration: 10,
        type: 'video' as const,
        cursorDemoSeed: 123,
        cursorPoints: demoPts,
      },
    ],
  };
  useProjectStore.setState({segments: [seg], activeSegmentIndex: 0});

  // 序列化：种子保留（小字段，随 {...rest} 落盘），采样点剥离
  const data = S().serializeProject();
  const savedClip = data.segments[0].videos[0] as any;
  assert.equal(savedClip.cursorDemoSeed, 123, 'cursorDemoSeed 应随工程落盘');
  assert.equal('cursorPoints' in savedClip, false, 'cursorPoints 不应持久化');
  ok('serializeProject 保留 cursorDemoSeed、剥离 cursorPoints');

  // 加载：无 cursorTrack（sidecar 读回 null）→ 按种子重建演示轨迹，与生成器输出一致
  await S().applyLoadedProject('测试', data as any, null, []);
  const loadedClip = S().segments[0].videos[0] as any;
  assert.equal(loadedClip.cursorDemoSeed, 123);
  assert.deepEqual(loadedClip.cursorPoints, demoPts, '加载后演示轨迹应按种子确定性重建');
  ok('applyLoadedProject 按种子确定性重建演示轨迹');

  // store 动作：生成写入 seed+采样点；清除剥离两者
  useProjectStore.setState({
    videos: [seg.videos[0] ? {...seg.videos[0], cursorDemoSeed: undefined, cursorPoints: undefined} as any : seg.videos[0]],
  });
  S().updateVideoCursorDemo(0, 555);
  const gen1 = S().videos[0];
  assert.equal(gen1.cursorDemoSeed, 555);
  assert.deepEqual(gen1.cursorPoints, generateDemoCursorTrack({durationSec: 10, width: 1920, height: 1080, seed: 555}));
  S().updateVideoCursorDemo(0, undefined);
  const cleared = S().videos[0] as any;
  assert.equal('cursorDemoSeed' in cleared, false);
  assert.equal('cursorPoints' in cleared, false);
  ok('updateVideoCursorDemo 生成/清除演示轨迹');
}

console.log(`\n共 ${passed} 项全部通过`);
