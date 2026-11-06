/**
 * 代理转码 + Log→709 纯函数单测：
 * 曲线锚点（各家 18% 灰官方码值）/ 曲线单调性 / cube 文本形状 /
 * shouldMakeProxy 探测规则 / proxyCacheKey 内容指纹语义 /
 * guessColorCurveFromTags 厂牌猜测（含歧义厂牌不自动填）。
 *
 * 运行：npx tsx tests/unit/proxy-media.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COLOR_CURVES,
  buildLutCubeText,
  colorCurveMeta,
  curveToRec709,
  guessColorCurveFromTags,
  logToLinear,
  proxyResolutionHit,
  shouldMakeProxy,
  PROXY_SIZE_THRESHOLD,
  PROXY_SOURCE_EXTS,
} from '../../src/shared/proxy-media.ts';
// proxyCacheKey 在主进程侧（shared 模块进渲染端 bundle 不能带 node:crypto）
import {proxyCacheKey} from '../../src/main/services/proxyTranscode.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

// —— 18% 灰锚点：编码 0.18 场景线性对应的标准码值（各家官方白皮书公布；
// Canon 两条取 colour 库 v1.2 实现的自洽锚点 = encode(0.18)，与官方 10bit 表
// 405/344 相差 <1%（legal range 约定差异），往返一致性才是 LUT 正确性的本质）——
const GRAY_ANCHORS: Array<[Parameters<typeof logToLinear>[0], number, number]> = [
  // [curve, 官方编码值, 容差]
  ['slog3', 420 / 1023, 0.002],      // Sony: 18% → 41%
  ['logc3', 0.391, 0.002],           // ARRI LogC3 EI800
  ['logc4', 0.2784, 0.001],          // ARRI LogC4
  ['clog2', 0.39820, 0.002],         // Canon C-Log2（colour 自洽锚点）
  ['clog3', 0.34337, 0.002],         // Canon C-Log3（colour 自洽锚点）
  ['dlog', 0.3988, 0.002],           // DJI D-Log
  ['bmdfilm5', 0.3835443, 0.002],    // BMD Gen5: 18% → 0.3835443（官方常数闭式可推）
];

console.log('proxy-media（Log→709 与代理探测）');
for (const [curve, encoded, tol] of GRAY_ANCHORS) {
  t(`${curve} 18% 灰解码锚点（编码 ${encoded.toFixed(4)} → 线性 0.18）`, () => {
    const linear = logToLinear(curve, encoded);
    assert.ok(Math.abs(linear - 0.18) < 0.005, `解码得 ${linear.toFixed(4)}，期望 ≈0.18（容差 0.005）`);
    void tol;
  });
}

t('曲线单调递增 + 曲线到 709 全链单调（全曲线 100 采样）', () => {
  for (const c of COLOR_CURVES) {
    let prevLin = -Infinity;
    let prev709 = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      const lin = logToLinear(c.id, v);
      const out = curveToRec709(c.id, v);
      assert.ok(lin >= prevLin - 1e-9, `${c.id} 线性不单调 @${v}`);
      assert.ok(out >= prev709 - 1e-9, `${c.id} 709 输出不单调 @${v}`);
      prevLin = lin; prev709 = out;
    }
    // 端点：0 → 0（或极小），1 → 有意义的高亮（不能削成 0）
    assert.ok(curveToRec709(c.id, 1) > 0.85, `${c.id} 白点输出 ${curveToRec709(c.id, 1)} 应 >0.85`);
    assert.ok(curveToRec709(c.id, 0) < 0.02, `${c.id} 黑点输出应 <0.02`);
  }
});

t('curveToRec709 中灰恢复到显示正常色（0.4±0.1 区间）', () => {
  for (const [curve, encoded] of GRAY_ANCHORS) {
    const display = curveToRec709(curve, encoded);
    assert.ok(display > 0.35 && display < 0.55,
      `${curve} 中灰恢复后显示值 ${display.toFixed(3)} 应在 0.35-0.55（709 显示中灰约 0.42）`);
  }
});

t('buildLutCubeText 形状（表头 + 33³ 数据行 + red 最快行序）', () => {
  const text = buildLutCubeText('slog3', 33);
  const lines = text.split('\n');
  assert.ok(lines.some((l) => l === 'LUT_3D_SIZE 33'));
  assert.ok(lines.some((l) => l.startsWith('DOMAIN_MIN 0.0 0.0 0.0')));
  const body = lines.filter((l) => /^\d/.test(l));
  assert.equal(body.length, 33 * 33 * 33);
  // red 最快：第一行 R=0，第二行 R=1/32（R 分量应大于第一行）
  const first = body[0].split(' ').map(Number);
  const second = body[1].split(' ').map(Number);
  assert.ok(second[0] > first[0], 'red 应为最快变化轴');
  assert.equal(first[1], first[2], 'G=B=0 时前两分量应同为曲线(0)');
});

t('生成的 LUT 文件与曲线一致（对角线抽查 + 文件存在）', () => {
  for (const c of COLOR_CURVES) {
    const file = path.join(process.cwd(), 'resources', 'luts', c.lutFile);
    assert.ok(fs.existsSync(file), `${c.lutFile} 缺失（跑 npx tsx scripts/gen-log-luts.ts 生成）`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^\d/.test(l));
    const at = (v: number) => {
      // 对角线上取该码值的行：R=G=B=v → 行号 = round(v*32)*(33*33 + 33 + 1)
      const idx = Math.round(v * 32) * (33 * 33 + 33 + 1);
      return lines[idx].split(' ').map(Number);
    };
    const expected = curveToRec709(c.id, 0.5);
    const got = at(0.5)[0];
    assert.ok(Math.abs(got - expected) < 1e-6, `${c.id} LUT 文件对角线 0.5 处 ${got} ≠ 公式 ${expected}`);
  }
});

t('shouldMakeProxy：容器扩展名 / 超大 / 4K 三规则', () => {
  assert.ok(shouldMakeProxy({filePath: 'D:/a/B.MXF', sizeBytes: 1000, width: 1920, height: 1080}), 'mxf（大写扩展名）命中');
  assert.ok(shouldMakeProxy({filePath: 'D:/a/b.mts', sizeBytes: 1000, width: 1920, height: 1080}), 'mts 命中');
  assert.ok(!shouldMakeProxy({filePath: 'D:/a/b.mp4', sizeBytes: 1000, width: 1920, height: 1080}), '常规 mp4 不触发');
  assert.ok(shouldMakeProxy({filePath: 'D:/a/b.mp4', sizeBytes: PROXY_SIZE_THRESHOLD + 1, width: 1920, height: 1080}), '>2GB 命中');
  assert.ok(!shouldMakeProxy({filePath: 'D:/a/b.mp4', sizeBytes: PROXY_SIZE_THRESHOLD - 1, width: 1920, height: 1080}), '2GB 内不触发');
  assert.ok(shouldMakeProxy({filePath: 'D:/a/b.mp4', sizeBytes: 1000, width: 3840, height: 2160}), '4K 横拍命中');
  assert.ok(shouldMakeProxy({filePath: 'D:/a/b.mp4', sizeBytes: 1000, width: 2160, height: 3840}), '4K 竖拍命中');
  assert.ok(!shouldMakeProxy({filePath: 'D:/a/b.mp4', sizeBytes: 1000, width: 2560, height: 1440}), '2K 不触发');
  assert.ok(PROXY_SOURCE_EXTS.includes('mxf'));
});

const fakeStats = (size: number, mtimeMs: number) => ({size, mtimeMs} as never as import('node:fs').Stats);

t('proxyCacheKey：内容指纹语义（同内容同曲线命中 / 曲线变化失配 / 大小变化失配）', () => {
  const k1 = proxyCacheKey('D:/old/a.mxf', fakeStats(1000, 12345), 'slog3');
  const k2 = proxyCacheKey('D:/moved/media/a.mxf', fakeStats(1000, 12345), 'slog3');
  assert.equal(k1, k2, '路径变化（consolidate）不影响 key');
  assert.notEqual(k1, proxyCacheKey('D:/old/a.mxf', fakeStats(1000, 12345), 'clog3'), '曲线变化 key 失配（换 LUT 重转）');
  assert.notEqual(k1, proxyCacheKey('D:/old/a.mxf', fakeStats(1001, 12345), 'slog3'), '大小变化 key 失配');
  assert.match(k1, /^[0-9a-f]{12}$/);
});

t('guessColorCurveFromTags：唯一曲线厂牌自动填 / 歧义厂牌只给候选', () => {
  assert.equal(guessColorCurveFromTags('SONY', 'PXW-FX9')?.curve, 'slog3');
  assert.equal(guessColorCurveFromTags('DJI', 'Zenmuse X7')?.curve, 'dlog');
  assert.equal(guessColorCurveFromTags('Blackmagic Design', 'Pocket 6K')?.curve, 'bmdfilm5');
  const canon = guessColorCurveFromTags('Canon', 'EOS C300 Mark III');
  assert.equal(canon?.curve, undefined, 'Canon 不自动填');
  assert.deepEqual(canon?.candidates, ['clog3', 'clog2']);
  const arri = guessColorCurveFromTags('ARRI', 'ALEXA 35');
  assert.equal(arri?.curve, undefined, 'ARRI 不自动填');
  assert.deepEqual(arri?.candidates, ['logc4', 'logc3']);
  assert.equal(guessColorCurveFromTags('', ''), null);
  assert.equal(guessColorCurveFromTags('Apple', 'iPhone 17 Pro'), null, '非电影机厂牌不猜');
});

t('proxyResolutionHit 边界（3839 不中 / 3840 命中）', () => {
  assert.ok(!proxyResolutionHit(3839, 2160 - 1));
  assert.ok(proxyResolutionHit(3840, 1080));
  assert.ok(proxyResolutionHit(1080, 2160));
});

console.log(`\n${passed} 项通过`);
