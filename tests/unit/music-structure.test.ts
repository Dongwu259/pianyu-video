/**
 * 音乐结构重排（shared/music-structure.ts）纯逻辑单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/music-structure.test.ts
 * （被测模块为纯函数、不依赖 electron）
 */

import assert from 'node:assert/strict';
import {planMusicStructureRearrange} from '../../src/shared/music-structure.ts';
import type {MusicSection} from '../../src/shared/music-map.ts';
import type {Segment} from '../../src/shared/types.ts';

let passed = 0;
let failed = 0;
const ok = (name: string, detail = '') => {
  passed++;
  console.log(`  ✓ ${name}${detail ? `：${detail}` : ''}`);
};
const bad = (name: string, detail: string) => {
  failed++;
  console.error(`  ✗ ${name}：${detail}`);
};
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name, detail) : bad(name, detail));

const section = (startSec: number, endSec: number, energy: number, label: MusicSection['label']): MusicSection =>
  ({startSec, endSec, energy, label});

const mkSeg = (duration: number, transition: Segment['transition']): Segment => ({
  id: `s-${duration}-${transition}`,
  templateId: 'RevealSlide',
  videos: [],
  text: {title: '', subtitle: '', features: [], brandName: ''},
  style: {},
  layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0},
  duration,
  transition,
}) as Segment;

console.log('边界对齐音乐段落：');
{
  // 段落起点 0/5/10/15；段 [4,4,4] → 边界 4→5、9→10，末段不动
  const music = {sections: [
    section(0, 5, 0.3, 'intro'), section(5, 10, 0.85, 'drop'), section(10, 15, 0.5, 'build'), section(15, 18, 0.25, 'outro'),
  ]};
  const r = planMusicStructureRearrange([mkSeg(4, 'none'), mkSeg(4, 'none'), mkSeg(4, 'none')], music)!;
  check('切点吸附到段落起点', r.durations[0] === 5 && r.durations[1] === 5, `[${r.durations.join(', ')}]`);
  check('末段时长不动', r.durations[2] === 4);
  check('移动计数', r.boundaryMovedCount === 2, `${r.boundaryMovedCount}`);
  // drop 段（起点5）起落的段1 边界 → whip（fill 模式也补硬切）
  check('drop 边界补 whip', r.transitions[0] === 'whip', r.transitions.join(','));
}
{
  // 容差外不动：段落起点 0/9，段 [4,4] → 边界 4 距 9 太远（>1.5s）不吸附
  const music = {sections: [section(0, 9, 0.5, 'build'), section(9, 12, 0.8, 'drop')]};
  const r = planMusicStructureRearrange([mkSeg(4, 'none'), mkSeg(4, 'none')], music)!;
  check('容差外不吸附', r.boundaryMovedCount === 0 && r.durations[0] === 4);
}
{
  // 最短段保护：吸附目标把段压到 <1.5s 时钳住
  const music = {sections: [section(0, 5.2, 0.5, 'build'), section(5.2, 12, 0.8, 'drop')]};
  const r = planMusicStructureRearrange([mkSeg(5, 'none'), mkSeg(4, 'none'), mkSeg(4, 'none')], music, {minSegmentSec: 1.5})!;
  // 边界0 = 5 → 吸到 5.2（0.2s 内）→ dur0 = 5.2；边界1 = 5.2+4 = 9.2 → 无近锚点不动
  check('近锚点吸附', r.durations[0] === 5.2, `${r.durations[0]}`);
  // 边界1 = 9.2，段落起点只有 5.2 → 距离 4 > 1.5 不动
  check('无锚点边界不动', r.durations[1] === 4);
}
{
  // 顺序推进：吸附后后续边界从新位置累计
  const music = {sections: [section(0, 4, 0.3, 'intro'), section(4, 8, 0.5, 'build'), section(8, 16, 0.9, 'drop')]};
  const r = planMusicStructureRearrange([mkSeg(3.5, 'none'), mkSeg(3.5, 'none'), mkSeg(6, 'none')], music)!;
  // 边界0 = 3.5 → 4；边界1 = 4+3.5 = 7.5 → 距 8 仅 0.5 → 8；末段不动
  check('顺序推进吸附', r.durations[0] === 4 && r.durations[1] === 4, `[${r.durations.join(', ')}]`);
}

console.log('转场随段能量选型：');
{
  // all 模式：drop→whip、再次 strong→flyThrough（轮换）、break→crossfade、build→slide
  const music = {sections: [
    section(0, 4, 0.3, 'intro'), section(4, 8, 0.9, 'drop'), section(8, 12, 0.9, 'drop'),
    section(12, 16, 0.25, 'break'), section(16, 20, 0.55, 'build'),
  ]};
  const segs = [mkSeg(4, 'crossfade'), mkSeg(4, 'slide'), mkSeg(4, 'zoom'), mkSeg(4, 'none'), mkSeg(4, 'none')];
  const r = planMusicStructureRearrange(segs, music, {transitionMode: 'all'})!;
  check('drop 边界 whip', r.transitions[0] === 'whip');
  check('同类轮换 flyThrough', r.transitions[1] === 'flyThrough');
  check('break 边界 crossfade', r.transitions[2] === 'crossfade');
  check('build 边界 slide', r.transitions[3] === 'slide', r.transitions.join(','));
  check('末段转场不动', r.transitions[4] === 'none');
  check('选型明细入 notes', r.notes.length === r.transitionChangedCount, `${r.notes.length} 条`);
}
{
  // 能量阈值（边界 t=4 落座进 t≥4 的新段落，按新段落能量选型）：
  // 段落 (0,4) e0.5 / (4,8) e0.8 / (8,12) e0.2 / (12,16) e0.5
  const music = {sections: [
    section(0, 4, 0.5, 'build'), section(4, 8, 0.8, 'build'), section(8, 12, 0.2, 'build'), section(12, 16, 0.5, 'build'),
  ]};
  const r = planMusicStructureRearrange([mkSeg(4, 'none'), mkSeg(4, 'none'), mkSeg(4, 'none'), mkSeg(4, 'none'), mkSeg(4, 'none')], music, {transitionMode: 'all'})!;
  check('能量>=0.7 走强转场', r.transitions[0] === 'whip');
  check('能量<0.45 走 crossfade', r.transitions[1] === 'crossfade');
  check('中能量走 slide', r.transitions[2] === 'slide');
}
{
  // fill 模式：显式转场保留，只补硬切
  const music = {sections: [section(0, 4, 0.3, 'intro'), section(4, 8, 0.9, 'drop')]};
  const segs = [mkSeg(4, 'push'), mkSeg(4, 'none'), mkSeg(4, 'none')];
  const r = planMusicStructureRearrange(segs, music, {transitionMode: 'fill'})!;
  check('显式转场保留', r.transitions[0] === 'push');
  check('硬切按能量补齐', r.transitions[1] === 'whip', r.transitions.join(','));
  check('末段不动', r.transitions[2] === 'none');
}

console.log('退化场景：');
{
  check('段落不足返回 null', planMusicStructureRearrange([mkSeg(4, 'none'), mkSeg(4, 'none')], {sections: [section(0, 8, 0.5, 'build')]}) === null);
  check('段数不足返回 null', planMusicStructureRearrange([mkSeg(4, 'none')], {sections: [section(0, 4, 0.5, 'build'), section(4, 8, 0.5, 'build')]}) === null);
  const music = {sections: [section(0, 8, 0.3, 'intro'), section(8, 16, 0.9, 'drop')]};
  const r = planMusicStructureRearrange([mkSeg(8, 'whip'), mkSeg(8, 'none')], music)!;
  check('已对齐零移动也有 summary', r.boundaryMovedCount === 0 && r.summary.includes('对齐'), r.summary);
}

console.log(`\nmusic-structure: ${failed === 0 ? `✓ 全部 ${passed} 项通过` : `✗ ${failed} 项失败`}`);
if (failed > 0) process.exit(1);
