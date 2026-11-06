/**
 * bgm-track 单测：BGM 时间轴定位派生值（起播点/截取窗钳制）与节拍时间轴映射
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/bgm-track.test.ts
 */
import assert from 'node:assert/strict';
import {
  bgmStartAtSec,
  bgmTrimStartSec,
  bgmTrimEndSec,
  bgmLoopSpanSec,
  bgmTimelineBeats,
  BGM_MIN_LOOP_SPAN_SEC,
} from '../../src/shared/bgm-track.ts';
import type {BgmTrack} from '../../src/shared/types.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
};

const track = (over: Partial<BgmTrack>): BgmTrack =>
  ({name: 't', src: '', path: '', duration: 60, volume: 0.7, fadeIn: 0.5, fadeOut: 1, ...over}) as BgmTrack;

console.log('bgm-track:');

t('缺省字段 = 从头播到尾（零回归：派生值即旧语义）', () => {
  const bgm = track({});
  assert.equal(bgmStartAtSec(bgm), 0);
  assert.equal(bgmTrimStartSec(bgm), 0);
  assert.equal(bgmTrimEndSec(bgm), 60);
  assert.equal(bgmLoopSpanSec(bgm), 60);
});

t('起播点负值/NaN 钳 0', () => {
  assert.equal(bgmStartAtSec(track({startAtSec: -3})), 0);
  assert.equal(bgmStartAtSec(track({startAtSec: Number.NaN})), 0);
  assert.equal(bgmStartAtSec(track({startAtSec: 4.5})), 4.5);
});

t('截取窗钳制：start ∈ [0, dur-2]、end ∈ [start+2, dur]、span ≥ 2', () => {
  assert.equal(bgmTrimStartSec(track({trimStartSec: 59.5, duration: 60})), 58);
  assert.equal(bgmTrimStartSec(track({trimStartSec: -1})), 0);
  assert.equal(bgmTrimEndSec(track({trimEndSec: 5, trimStartSec: 0})), 5);
  // end 越过 start+2 下界 → 抬到 start+2
  assert.equal(bgmTrimEndSec(track({trimStartSec: 30, trimEndSec: 31})), 32);
  // end 越过素材尾 → 钳 duration
  assert.equal(bgmTrimEndSec(track({trimEndSec: 99})), 60);
  assert.ok(bgmLoopSpanSec(track({trimStartSec: 30, trimEndSec: 38})) >= BGM_MIN_LOOP_SPAN_SEC);
});

t('节拍时间轴映射：timeline = startAt + (beat − trimStart)，窗外拍丢弃', () => {
  const bgm = track({startAtSec: 8, trimStartSec: 10, trimEndSec: 20, beats: [0, 5, 10, 15, 19.9, 20, 25]});
  const mapped = bgmTimelineBeats(bgm);
  // 0/5 在窗外；10→8、15→13、19.9→17.9；20 恰在窗外（开区间）；25 窗外
  assert.deepEqual(mapped.map((v) => Math.round(v * 10) / 10), [8, 13, 17.9]);
});

t('节拍映射缺省快路径：无定位字段 = 原拍原样（含旧工程 peaks 回退检测）', () => {
  const withBeats = track({beats: [1, 2, 3]});
  assert.deepEqual(bgmTimelineBeats(withBeats), [1, 2, 3]);
  const peaksOnly = track({beats: undefined, peaks: [0, 0.9, 0, 0.8, 0, 0.95, 0], duration: 2});
  const viaPeaks = bgmTimelineBeats(peaksOnly);
  assert.ok(viaPeaks.length > 0, 'peaks 回退检测应产出拍');
  // 空 bgm / 无拍 → 空表
  assert.deepEqual(bgmTimelineBeats(null), []);
  assert.deepEqual(bgmTimelineBeats(track({duration: 0})), []);
});

t('映射往返：映射后的拍经逆变换回到媒体窗内（守恒）', () => {
  const bgm = track({startAtSec: 3.7, trimStartSec: 12.3, trimEndSec: 45.6, beats: Array.from({length: 30}, (_, i) => i * 2)});
  const startAt = bgmStartAtSec(bgm);
  const ts = bgmTrimStartSec(bgm);
  const te = bgmTrimEndSec(bgm);
  for (const b of bgmTimelineBeats(bgm)) {
    const media = b - startAt + ts;
    assert.ok(media >= ts - 1e-9 && media < te + 1e-9, `往返越界 ${media}`);
  }
});

const total = 6;
console.log(passed === total ? 'bgm-track: ✓ 全部通过' : `bgm-track: ${passed}/${total}`);
