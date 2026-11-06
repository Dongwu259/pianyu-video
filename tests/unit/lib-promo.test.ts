/**
 * lib-promo.ts 单测：promo 共享管线库（P0-2）
 * BGM 合成器长度/节拍表/归一、WAV 头、旁白适配断言与 captions 回填、卡点吸附断言、素材入库钳制。
 * （需要 ffmpeg/ffprobe 在 PATH——本仓库渲染管线环境即有）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {
  SR, synthBgm, writeWav, mixNarration, snapAndAssert, ingestTakes,
} from '../../smoke_test/lib-promo.ts';
import type {Segment} from '../../src/shared/types.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

{
  // BGM：长度= musicSec*SR、节拍 0.5s 网格（120BPM）、norm 把峰值归到 0.72、种子确定性
  const a = synthBgm({musicSec: 5});
  assert.equal(a.music.length, 5 * SR);
  assert.equal(a.sr, SR);
  assert.equal(a.bpm, 120);
  assert.ok(Math.abs(a.beats[1] - a.beats[0] - 0.5) < 1e-6, '120BPM 半秒一拍');
  assert.ok(a.beats.length >= 9, '5s 至少 9 拍');
  let peak = 0;
  for (let i = 0; i < a.music.length; i++) peak = Math.max(peak, Math.abs(a.music[i]));
  assert.ok(Math.abs(peak * a.norm - 0.72) < 1e-6, `峰值归一 0.72（实测峰 ${peak.toFixed(3)}）`);
  const b = synthBgm({musicSec: 5});
  assert.equal(a.music[12345], b.music[12345], '默认种子确定性（对照渲染等价的前提）');
  ok('synthBgm 长度/节拍/归一/种子确定性');
}

{
  // WAV：RIFF 头字段与数据长度
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libpromo-wav-'));
  const p = path.join(dir, 't.wav');
  writeWav(p, new Float32Array([0, 0.5, -0.5, 1]), SR);
  const buf = fs.readFileSync(p);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt32LE(24), SR, '采样率');
  assert.equal(buf.readUInt16LE(34), 16, '位深');
  assert.equal(buf.length, 44 + 4 * 2, '44 头 + 4 样本×2 字节');
  fs.rmSync(dir, {recursive: true, force: true});
  ok('writeWav RIFF 头/长度');
}

{
  // 旁白混音：句长≤段长-0.4s 断言、侧链叠加写进 bgm、captions 同窗回填
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libpromo-nar-'));
  // 生成 1s 440Hz 正弦 wav，命名 .mp3（ffmpeg 按内容识别，旁白通路走 mp3→wav 转码同链）
  const raw = path.join(dir, 'src.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', raw], {timeout: 30_000});
  fs.copyFileSync(raw, path.join(dir, 'nar.mp3'));
  const bgm = synthBgm({musicSec: 6});
  const segments: Segment[] = [
    {id: 's0', templateId: 'KineticType', videos: [], text: {title: '', subtitle: '', features: [], brandName: ''}, style: {}, layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0}, duration: 3, transition: 'crossfade'},
    {id: 's1', templateId: 'KineticType', videos: [], text: {title: '', subtitle: '', features: [], brandName: ''}, style: {}, layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0}, duration: 3, transition: 'none'},
  ];
  const before = bgm.music[10];
  mixNarration({
    bgm, narDir: dir, workDir: dir,
    lines: [{file: 'nar.mp3', seg: 0, text: '测试句'}],
    segStarts: [0, 3], finalDurations: [3, 3], segments, tag: 't',
  });
  assert.ok(bgm.music[10] !== before, '旁白叠加改变了 bgm 样本');
  assert.ok(segments[0].captions?.[0]?.text === '测试句');
  assert.ok((segments[0].captions?.[0]?.endSec ?? 0) <= 3 - 0.1, 'captions 钳制在段长内');

  // 断言型（P1-3 双向）：句长 1s > 段长 1.2s - 0.4s → 拦 + 给吸附整拍的最小建议段长
  try {
    mixNarration({
      bgm, narDir: dir, workDir: dir,
      lines: [{file: 'nar.mp3', seg: 1, text: '超长句'}],
      segStarts: [0, 3], finalDurations: [3, 1.2], segments, tag: 't',
    });
    assert.fail('应抛错');
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(msg.includes('只短不足 0.4s'), '口径不变');
    assert.ok(/最小建议段长 1\.50s/.test(msg), `带吸附整拍建议（实测：${msg}）`);
  }
  fs.rmSync(dir, {recursive: true, force: true});
  ok('mixNarration 断言/侧链/captions 回填/双向建议段长');
}

{
  // 卡点吸附：吸附后切点全部 ≤80ms（snapDurationsToBeats 的调用方断言口径）
  const bgm = synthBgm({musicSec: 20});
  const mk = (id: string, duration: number): Segment => ({id, templateId: 'KineticType', videos: [], text: {title: '', subtitle: '', features: [], brandName: ''}, style: {}, layout: {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0, videoOffsetY: 0}, duration, transition: 'velocityPush'});
  const segments = [mk('a', 4), mk('b', 6.5), mk('c', 4.5), mk('d', 5)];
  const snap = snapAndAssert(segments, bgm, 't');
  assert.equal(snap.segStarts[0], 0);
  assert.equal(snap.segStarts[1], segments[0].duration, 'segStarts 与吸附后时长一致');
  assert.ok(snap.totalSec > 0);
  assert.ok(segments[0].transitionParams?.durationSec !== undefined, '转场时长吸附回填');
  ok('snapAndAssert 吸附/前缀和/压拍断言');
}

{
  // 素材入库：ffprobe 元数据、裁剪钳制（trimEnd 超实长收口）、regions 缺 sidecar 报错
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libpromo-ing-'));
  const mp4 = path.join(dir, 'take.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-pix_fmt', 'yuv420p', mp4], {timeout: 60_000});
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, {recursive: true});
  const {clip} = ingestTakes({recDir: dir, workDir: work, files: ['take.mp4'], tag: 't'});
  const c = clip({src: 'take.mp4', trimStart: 0.5, trimEnd: 5});
  assert.equal(c.width, 320);
  assert.equal(c.height, 240);
  assert.ok(Math.abs(c.trimEnd - 1.75) < 0.05, `trimEnd 钳到实长-0.25（实测 ${c.trimEnd}）`);
  assert.equal(c.muted, true);
  assert.equal(c.cursorTrack, undefined, '无 sidecar 不挂轨迹');
  assert.throws(() => clip({src: 'take.mp4', trimStart: 0, trimEnd: 1, regions: true}), /无 \.regions\.json/);
  fs.rmSync(dir, {recursive: true, force: true});
  ok('ingestTakes 元数据/钳制/regions 报错');
}

console.log(`\n共 ${passed} 项全部通过`);
