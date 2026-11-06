/**
 * narration-manifest.ts 单测：旁白单一源契约（P1-3）
 * hash 双端一致性（锚点值=python 同算法实算）、新鲜度对账（改词/缺 mp3/无 stamp）、
 * 建议段长吸附整拍。
 */
import assert from 'node:assert/strict';
import {
  hashNarrationText, checkNarrationFreshness, freshnessError, suggestMinSegmentSec,
  type NarrationStamp,
} from '../../src/shared/narration-manifest.ts';
import type {NarLine} from '../../src/shared/promo-storyboard.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  // hash 契约锚点：python hashlib.sha1(text.encode('utf-8')).hexdigest() 实算值——双端漂移立即红
  assert.equal(hashNarrationText('一句话，开工。'), 'b9e8124cd2d1ac059d74d77c3205f9c89e2a9074');
  assert.equal(hashNarrationText(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709', '空串 sha1 常量');
  ok('hashNarrationText 与 python 同算法一致（锚点值）');
}

const lines: NarLine[] = [
  {file: 'a.mp3', seg: 0, text: '一句话，开工。'},
  {file: 'b.mp3', seg: 1, text: '海量模板，一搜即达。'},
];
const stampOf = (hashes: Record<string, string>): NarrationStamp => ({stampedAt: '2026-10-11T00:00:00', hashes});

{
  // 对账：全对 = ok
  const r = checkNarrationFreshness(lines, stampOf({
    'a.mp3': hashNarrationText('一句话，开工。'),
    'b.mp3': hashNarrationText('海量模板，一搜即达。'),
  }), () => true);
  assert.equal(r.ok, true);
  assert.equal(r.stale.length, 0);
  ok('新鲜度全对通过');
}

{
  // 改词未重生成：stale 命中具体句，报错带文件+词+命令
  const r = checkNarrationFreshness(
    [{...lines[1], text: '海量模板，一搜就到。'}].concat(lines[0]),
    stampOf({
      'a.mp3': hashNarrationText('一句话，开工。'),
      'b.mp3': hashNarrationText('海量模板，一搜即达。'),
    }), () => true,
  );
  assert.equal(r.ok, false);
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].file, 'b.mp3');
  const msg = freshnessError(r, 'python promo/v11-takes/make-narration.py');
  assert.ok(msg.includes('b.mp3') && msg.includes('一搜就到'), '报错带文件与新词');
  assert.ok(msg.includes('make-narration.py'), '报错带重生成命令');
  ok('改词未重生成 → stale + 报错处方');
}

{
  // mp3 不在盘：missingOnDisk 单列（改词与缺文件分开口径）
  const r = checkNarrationFreshness(lines, stampOf({
    'a.mp3': hashNarrationText('一句话，开工。'),
    'b.mp3': hashNarrationText('海量模板，一搜即达。'),
  }), (f) => f !== 'b.mp3');
  assert.equal(r.ok, false);
  assert.equal(r.stale.length, 0);
  assert.equal(r.missingOnDisk.length, 1);
  assert.ok(freshnessError(r, 'cmd').includes('缺失'));
  ok('mp3 缺盘单独报告');
}

{
  // stamp 缺失（生成器没跑过）：noStamp 专用报错
  const r = checkNarrationFreshness(lines, null, () => true);
  assert.equal(r.ok, false);
  assert.equal(r.noStamp, true);
  assert.ok(freshnessError(r, 'cmd').includes('建立基线'));
  ok('无 stamp 专用报错');
}

{
  // 建议段长：吸附到 ≥narDur+0.4 的最近拍（120BPM 半秒网格）
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  assert.equal(suggestMinSegmentSec(2.8, beats), 3.5, '2.8+0.4=3.2 → 最近的 3.5');
  assert.equal(suggestMinSegmentSec(2.6, beats), 3, '3.0 恰在拍上 → 3.0');
  assert.equal(suggestMinSegmentSec(4.7, beats), 5.2, '节拍表装不下（need 5.1 > 末拍 5）→ 退回 need+0.1=5.2');
  assert.equal(suggestMinSegmentSec(2.8, beats, 0.6), 3.5, 'margin 可调（2.8+0.6=3.4→3.5）');
  ok('suggestMinSegmentSec 吸附整拍/回退');
}

console.log(`\n共 ${passed} 项全部通过`);
