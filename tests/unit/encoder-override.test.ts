/**
 * 硬件编码器探测与 ffmpegOverride 参数改写（services/encoderOverride.ts）纯逻辑单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/encoder-override.test.ts
 * （被测模块不依赖 electron；ffmpeg 子进程探测不在此测试范围，只测纯函数部分）
 */

import assert from 'node:assert/strict';
import {
  parseEncoderList,
  resolveEncoder,
  makeFfmpegOverride,
} from '../../src/main/services/encoderOverride.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 模拟 `ffmpeg -hide_banner -encoders` 输出（含 NVENC + QSV） */
const ENCODERS_WITH_BOTH = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
 V....D libvpx_vp9           WebM VP9 (codec vp9)
 A....D aac                  AAC (Advanced Audio Coding) (codec aac)
`;

/** 模拟无硬件编码器的输出 */
const ENCODERS_SOFTWARE_ONLY = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 A....D aac                  AAC (Advanced Audio Coding) (codec aac)
`;

/** 构造一条贴近 Remotion stitcher 真实形态的 argv（h264/mp4，见 stitch-frames-to-video.js） */
const makeStitcherArgs = (): string[] => [
  '-r', '30',
  '-f', 'image2',
  '-s', '1920x1080',
  '-start_number', '0',
  '-i', 'C:\\tmp\\remotion-assets\\element-%d.png',
  '-i', 'C:\\tmp\\remotion-assets\\audio.wav',
  '-c:a', 'copy',
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-preset', 'slow',
  '-video_track_timescale', '90000',
  '-crf', '23',
  '-movflags', 'faststart',
  '-map_metadata', '-1',
  '-y',
  'D:\\out\\promo.mp4',
];

// ====== 1. parseEncoderList：编码器列表解析 ======

console.log('parseEncoderList 解析:');
{
  assert.deepEqual(parseEncoderList(ENCODERS_WITH_BOTH), {nvenc: true, qsv: true}, '应同时识别 NVENC 与 QSV');
  assert.deepEqual(parseEncoderList(ENCODERS_SOFTWARE_ONLY), {nvenc: false, qsv: false}, '纯软件列表应全部为 false');
  assert.deepEqual(parseEncoderList(''), {nvenc: false, qsv: false}, '空输出不报错');
  // 只命中描述文本不算（描述里没有第二列编码器名）
  assert.deepEqual(
    parseEncoderList(' V....D h264_qsv             Intel Quick Sync（描述里提到 h264_nvenc 字样不算数）\n'),
    {nvenc: false, qsv: true},
    '只匹配第二列编码器名，描述文本不命中',
  );
  ok('NVENC/QSV/纯软件/空输出/描述文本干扰 五种形态解析正确');
}

// ====== 2. resolveEncoder：auto 与显式指定的解析 ======

console.log('resolveEncoder 解析:');
{
  const both = {nvenc: true, qsv: true};
  const qsvOnly = {nvenc: false, qsv: true};
  const none = {nvenc: false, qsv: false};

  assert.equal(resolveEncoder('auto', both), 'nvenc', 'auto 优先 NVENC');
  assert.equal(resolveEncoder('auto', qsvOnly), 'qsv', 'auto 无 NVENC 时退 QSV');
  assert.equal(resolveEncoder('auto', none), 'software', 'auto 全无时退软件');
  assert.equal(resolveEncoder('nvenc', both), 'nvenc', '显式 nvenc 可用即用之');
  assert.equal(resolveEncoder('nvenc', qsvOnly), 'software', '显式 nvenc 不可用回退软件（不擅自换 QSV）');
  assert.equal(resolveEncoder('qsv', none), 'software', '显式 qsv 不可用回退软件');
  assert.equal(resolveEncoder('software', both), 'software', '显式软件编码不受探测结果影响');
  ok('auto 优先级 / 显式不可用回退 / 显式软件 七组解析正确');
}

// ====== 3. makeFfmpegOverride：不engag的场景返回 undefined ======

console.log('makeFfmpegOverride 不engag场景:');
{
  assert.equal(makeFfmpegOverride({encoder: 'nvenc', codec: 'prores'}), undefined, 'prores 不改写');
  assert.equal(makeFfmpegOverride({encoder: 'qsv', codec: 'vp9'}), undefined, 'vp9 不改写');
  assert.equal(makeFfmpegOverride({encoder: 'software', codec: 'h264'}), undefined, '软件编码不改写');
  ok('prores/vp9/software 均返回 undefined');
}

// ====== 4. NVENC 改写：-c:v / -preset / -crf 映射 + 其余透传 ======

console.log('makeFfmpegOverride NVENC 改写:');
{
  const override = makeFfmpegOverride({encoder: 'nvenc', codec: 'h264'})!;
  assert.equal(typeof override, 'function');

  const args = makeStitcherArgs();
  const out = override({type: 'stitcher', args});

  // -c:v libx264 → h264_nvenc
  const cvIdx = out.indexOf('-c:v');
  assert.equal(out[cvIdx + 1], 'h264_nvenc', '-c:v 应改写为 h264_nvenc');
  assert.ok(!out.includes('libx264'), '不应残留 libx264');

  // -preset slow → p7
  const presetIdx = out.indexOf('-preset');
  assert.equal(out[presetIdx + 1], 'p7', 'slow 应映射到 p7');

  // -crf 23 → -rc vbr -cq 23（-crf 不复存在）
  assert.ok(!out.includes('-crf'), '不应残留 -crf');
  const rcIdx = out.indexOf('-rc');
  assert.equal(out[rcIdx + 1], 'vbr', '应补 -rc vbr');
  const cqIdx = out.indexOf('-cq');
  assert.equal(out[cqIdx + 1], '23', 'crf 值应变成 -cq 值');

  // 其余参数逐位透传（输入/输出路径、pix_fmt、timescale、movflags、音频、-y 等）
  for (const tok of ['-pix_fmt', 'yuv420p', '-video_track_timescale', '90000', '-movflags', 'faststart', '-map_metadata', '-1', '-c:a', 'copy', '-y', 'D:\\out\\promo.mp4', '-start_number', '0']) {
    assert.ok(out.includes(tok), `应原样保留: ${tok}`);
  }
  // 长度守恒：原 argv 中 -crf 对（2 token）换成 -rc vbr -cq（4 token），净 +2
  assert.equal(out.length, args.length + 2, '改写后只应多 -rc vbr 两个 token');

  // 纯函数：入参不被修改
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264', '入参 argv 不应被修改');
  ok('NVENC：编码器/预设/CRF 映射正确，其余参数透传，入参不被修改');
}

// ====== 5. NVENC 预设全档映射 ======

console.log('NVENC 预设全档映射:');
{
  const override = makeFfmpegOverride({encoder: 'nvenc', codec: 'h264'})!;
  const cases: Array<[string, string]> = [
    ['ultrafast', 'p1'], ['superfast', 'p2'], ['veryfast', 'p3'], ['faster', 'p4'],
    ['fast', 'p5'], ['medium', 'p6'], ['slow', 'p7'], ['slower', 'p7'], ['veryslow', 'p7'],
  ];
  for (const [x264, expected] of cases) {
    const out = override({type: 'stitcher', args: ['-c:v', 'libx264', '-preset', x264, '-crf', '23', 'out.mp4']});
    assert.equal(out[out.indexOf('-preset') + 1], expected, `${x264} → ${expected}`);
  }
  ok('9 档 x264 预设全部正确映射到 p1..p7');
}

// ====== 6. QSV 改写：-c:v / -preset / -crf → -global_quality ======

console.log('makeFfmpegOverride QSV 改写:');
{
  const override = makeFfmpegOverride({encoder: 'qsv', codec: 'h264'})!;

  const out = override({type: 'stitcher', args: makeStitcherArgs()});
  assert.equal(out[out.indexOf('-c:v') + 1], 'h264_qsv', '-c:v 应改写为 h264_qsv');
  assert.equal(out[out.indexOf('-preset') + 1], 'slow', 'slow 在 QSV 同名保留');
  assert.ok(!out.includes('-crf'), '不应残留 -crf');
  const gqIdx = out.indexOf('-global_quality');
  assert.equal(out[gqIdx + 1], '23', 'crf 值应变成 -global_quality 值');
  assert.ok(!out.includes('-rc'), 'QSV 不应加 -rc');

  // QSV 预设全档映射（ultrafast/superfast 并入 veryfast，其余同名）
  const cases: Array<[string, string]> = [
    ['ultrafast', 'veryfast'], ['superfast', 'veryfast'], ['veryfast', 'veryfast'], ['faster', 'faster'],
    ['fast', 'fast'], ['medium', 'medium'], ['slow', 'slow'], ['slower', 'slower'], ['veryslow', 'veryslow'],
  ];
  for (const [x264, expected] of cases) {
    const o = override({type: 'stitcher', args: ['-c:v', 'libx264', '-preset', x264, '-crf', '18', 'out.mp4']});
    assert.equal(o[o.indexOf('-preset') + 1], expected, `${x264} → ${expected}`);
  }
  ok('QSV：编码器/9 档预设/global_quality 映射正确，不加 -rc');
}

// ====== 7. 保守透传：pre-stitcher / 非 libx264 / 不认识的值 ======

console.log('保守透传场景:');
{
  const nvenc = makeFfmpegOverride({encoder: 'nvenc', codec: 'h264'})!;

  // pre-stitcher 一律原样
  const preArgs = ['-i', 'in.png', '-c:v', 'libx264', '-crf', '23', 'chunk.mp4'];
  assert.deepEqual(nvenc({type: 'pre-stitcher', args: preArgs}), preArgs, 'pre-stitcher 原样透传');

  // 非 libx264 的 stitcher（如 prores_ks）：整体透传，连 -crf 都不动
  const proresArgs = ['-i', 'seq-%d.png', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', 'out.mov'];
  assert.deepEqual(nvenc({type: 'stitcher', args: proresArgs}), proresArgs, '无 -c:v libx264 时整体透传');

  // 不认识的 -preset 值原样保留
  const unknownPreset = nvenc({type: 'stitcher', args: ['-c:v', 'libx264', '-preset', 'placebo', 'out.mp4']});
  assert.equal(unknownPreset[unknownPreset.indexOf('-preset') + 1], 'placebo', '不认识的预设值原样保留');
  assert.equal(unknownPreset[unknownPreset.indexOf('-c:v') + 1], 'h264_nvenc', '编码器本身仍改写');

  // -b:v/-maxrate/-bufsize（Remotion 按码率模式时可能产出）原样保留
  const withBitrate = nvenc({type: 'stitcher', args: ['-c:v', 'libx264', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '16M', 'out.mp4']});
  for (const tok of ['-b:v', '8M', '-maxrate', '10M', '-bufsize', '16M']) {
    assert.ok(withBitrate.includes(tok), `码率参数应原样保留: ${tok}`);
  }

  // 无 -crf 时不多加质量参数
  assert.ok(!withBitrate.includes('-cq') && !withBitrate.includes('-rc'), '无 -crf 时不应补质量参数');
  ok('pre-stitcher / 非 libx264 / 未知预设 / 码率参数 / 无 CRF 五种场景全部保守处理');
}

console.log(`\n全部通过（${passed} 组断言）`);
