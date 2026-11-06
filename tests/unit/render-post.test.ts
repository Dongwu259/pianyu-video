/**
 * 渲染后处理计划（loudnorm/缩放合并）单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/render-post.test.ts
 * （被测模块 src/main/services/renderPost.ts 纯函数、不依赖 electron）
 */

import assert from 'node:assert/strict';
import {planPostProcess, loudnormApplicable, LOUDNORM_FILTER} from '../../src/main/services/renderPost.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('loudnormApplicable:');
{
  assert.equal(loudnormApplicable('mp4', false), true);
  assert.equal(loudnormApplicable('mp4-hevc', false), true);
  assert.equal(loudnormApplicable('webm', false), true);
  assert.equal(loudnormApplicable('mov', false), true);
  ok('有声轨格式生效');
}
{
  assert.equal(loudnormApplicable('gif', false), false);
  assert.equal(loudnormApplicable('mp4', true), false);
  ok('gif 与静音跳过');
}

console.log('planPostProcess 组合:');
{
  const p = planPostProcess({needsResize: false, loudnorm: false, format: 'mp4', muted: false});
  assert.equal(p.needed, false);
  ok('无需后处理');
}
{
  const p = planPostProcess({needsResize: false, loudnorm: true, format: 'mp4', muted: false});
  assert.equal(p.needed, true);
  assert.equal(p.hasLoudnorm, true);
  const i = p.args.indexOf('-af');
  assert.ok(i >= 0 && p.args[i + 1] === LOUDNORM_FILTER, JSON.stringify(p.args));
  const v = p.args.indexOf('-c:v');
  assert.ok(v >= 0 && p.args[v + 1] === 'copy');
  const a = p.args.indexOf('-c:a');
  assert.ok(a >= 0 && p.args[a + 1] === 'aac');
  assert.ok(p.args.includes('192k'));
  const sr = p.args.indexOf('-ar');
  assert.ok(sr >= 0 && p.args[sr + 1] === '48000', 'loudnorm 输出须钉 48kHz（防 AAC 落 96kHz 无声）');
  assert.ok(!p.args.includes('-vf'));
  ok('仅 loudnorm：-af + -c:v copy + aac 192k + -ar 48000（不动视频流）');
}
{
  const p = planPostProcess({needsResize: false, loudnorm: true, format: 'webm', muted: false});
  assert.ok(p.args.includes('libopus'));
  const m = planPostProcess({needsResize: false, loudnorm: true, format: 'mov', muted: false});
  assert.ok(m.args.includes('pcm_s16le'));
  ok('webm→libopus / mov→pcm_s16le');
}
{
  const p = planPostProcess({needsResize: true, targetWidth: 1280, targetHeight: 720, loudnorm: false, format: 'mp4', muted: false});
  assert.equal(p.hasLoudnorm, false);
  assert.ok(p.args.includes('-vf'));
  assert.ok(p.args.some((a) => String(a).startsWith('scale=1280:720:force_original_aspect_ratio=decrease')), JSON.stringify(p.args));
  const a = p.args.indexOf('-c:a');
  assert.ok(a >= 0 && p.args[a + 1] === 'copy');
  assert.ok(!p.args.includes('-af'));
  ok('仅缩放：-vf + -c:a copy（与原 renderTo 行为一致）');
}
{
  const p = planPostProcess({needsResize: true, targetWidth: 1279, targetHeight: 721, loudnorm: true, format: 'mp4', muted: false});
  assert.equal(p.hasLoudnorm, true);
  assert.ok(p.args.includes('-vf') && p.args.includes('-af'));
  assert.ok(p.args.some((a) => String(a).startsWith('scale=1278:720:')), `奇数尺寸取偶：${p.args.join(' ')}`);
  ok('缩放+loudnorm 合并为一次调用，奇数尺寸取偶');
}
{
  const p = planPostProcess({needsResize: true, targetWidth: 1280, targetHeight: 720, loudnorm: true, format: 'gif', muted: false});
  assert.equal(p.hasLoudnorm, false);
  assert.ok(p.args.includes('-vf') && !p.args.includes('-af'));
  ok('gif：缩放保留、loudnorm 自动跳过');
}

console.log(`\n全部通过（${passed} 组断言）`);

// ====== 两遍线性 loudnorm（2026-10-12：治「BGM 开头响后面软」的动态沉降） ======
console.log('两遍线性 loudnorm:');
import {linearLoudnormFilter, parseLoudnormMeasurement, loudnormMeasureArgs} from '../../src/main/services/renderPost.ts';
{
  const sample = `[Parsed_loudnorm_0 @ ...] {"input_i": "-18.05","input_tp": "-3.02","input_lra": "3.50","input_thresh": "-28.35","output_i": "-14.00","target_offset": "0.20"}\n`;
  const m = parseLoudnormMeasurement(sample);
  assert.ok(m && m.inputI === -18.05 && m.inputTp === -3.02 && m.inputLra === 3.5 && m.inputThresh === -28.35);
  assert.equal(parseLoudnormMeasurement('no json here'), null, '无 JSON 返回 null（走单遍降级）');
  ok('测量解析（input_* 四字段 / 无 JSON null）');
}
{
  const f = linearLoudnormFilter({inputI: -18.05, inputTp: -3.02, inputLra: 3.5, inputThresh: -28.35});
  assert.ok(f.includes('linear=true') && f.includes('measured_I=-18.05') && f.includes('measured_TP=-3.02') && f.includes('measured_thresh=-28.35'));
  assert.ok(f.includes('LRA=11'), 'LRA 目标 11（实测 3.5 < 11 保持）');
  const wide = linearLoudnormFilter({inputI: -20, inputTp: -2, inputLra: 17.2, inputThresh: -30});
  assert.ok(wide.includes('LRA=17.2'), '实测 LRA > 目标时放宽到实测值（防 ffmpeg 静默回退动态模式）');
  ok('线性滤镜串（measured_*/linear=true/LRA 放宽护栏）');
}
{
  const plan = planPostProcess({needsResize: false, loudnorm: true, loudnormMeasured: {inputI: -18, inputTp: -3, inputLra: 3.5, inputThresh: -28}, format: 'mp4', muted: false});
  assert.equal(plan.isLinear, true);
  assert.ok(plan.args.includes('loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-18:measured_TP=-3:measured_LRA=3.5:measured_thresh=-28:linear=true'));
  const degraded = planPostProcess({needsResize: false, loudnorm: true, format: 'mp4', muted: false});
  assert.equal(degraded.isLinear, false);
  assert.ok(degraded.args.includes(LOUDNORM_FILTER), '无测量=单遍动态降级（行为同旧版）');
  ok('计划两态（线性优先/缺测量动态降级）');
}
{
  const args = loudnormMeasureArgs();
  assert.ok(args[0] === '-vn' && args[1] === '-af' && args[2].includes('print_format=json') && args.includes('-f') && args.includes('null'));
  ok('测量遍参数（-f null + print_format=json）');
}
