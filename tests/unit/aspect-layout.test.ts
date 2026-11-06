/**
 * aspectLayout.ts 单测：画幅适配布局原语（aspect 审计 P0/P1 公共层）
 * 纪律锚点：所有原语在 16:9 及更窄画幅恒为无操作（现役行为零漂移）。
 */
import assert from 'node:assert/strict';
import {REF_ASPECT, wideAspectCap, coverCropFrac, cavityLift} from '../../src/remotion/utils/aspectLayout.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ====== wideAspectCap：宽画幅字号/尺寸封顶系数 ======
{
  assert.equal(wideAspectCap(1920, 1080), 1, '16:9 恒 1（+1px 余量不触顶）');
  ok('16:9 恒 1');
  assert.equal(wideAspectCap(2520, 1080) < 1, true, '21:9 触顶压回');
  // 21:9：cap × 宽度系数 = 16:9 等效（密度一致）
  const capped = 2520 * wideAspectCap(2520, 1080);
  assert.ok(Math.abs(capped - 1921) < 1.5, `21:9 封顶后 ≈ 16:9 等效宽（得 ${capped.toFixed(1)}）`);
  ok('21:9 封顶后 ≈ 16:9 等效密度');
  assert.equal(wideAspectCap(1080, 1080), 1, '1:1 更窄不封顶');
  assert.equal(wideAspectCap(1080, 1920), 1, '9:16 更窄不封顶');
  assert.equal(wideAspectCap(1440, 1080), 1, '4:3 更窄不封顶');
  ok('1:1 / 9:16 / 4:3 恒 1（零漂移）');
}

// ====== coverCropFrac：cover 满幅裁切率 ======
{
  assert.equal(coverCropFrac(1920, 1080, 1920, 1080), 0, '同画幅无裁切');
  ok('同画幅裁切率 0');
  // 实录素材 2538×1434（≈16:9）在三类画幅下的实测值（ScreenDemo 窗口卡分支依据）
  const f169 = coverCropFrac(1920, 1080, 2538, 1434);
  assert.ok(f169 > 0 && f169 < 0.01, `16:9 画布裁切 <1%（得 ${(f169 * 100).toFixed(2)}%）`);
  ok('16:9 + 16:9 素材裁切 <1%（不触发窗口卡）');
  const f219 = coverCropFrac(2520, 1080, 2538, 1434);
  assert.ok(f219 > 0.2 && f219 < 0.3, `21:9 裁上下 ~24%（得 ${(f219 * 100).toFixed(1)}%）`);
  ok('21:9 裁切率 ~24%（触发窗口卡）');
  const f11 = coverCropFrac(1080, 1080, 2538, 1434);
  assert.ok(f11 > 0.4, `1:1 裁左右 >40%（得 ${(f11 * 100).toFixed(1)}%）`);
  ok('1:1 裁切率 >40%（触发窗口卡）');
  // 方向无关性：画幅比素材宽/窄对称
  assert.ok(Math.abs(coverCropFrac(1000, 1000, 2000, 1000) - coverCropFrac(1000, 1000, 500, 1000) - 0) < 1e-9, '宽/窄两向裁切率对称');
  ok('宽/窄两向对称');
}

// ====== cavityLift：内容盒垂直重心提升 ======
{
  assert.equal(cavityLift(900, 700), 0, '内容 ≥ 可用区一半不抬（16:9 五泡零漂移口径）');
  assert.equal(cavityLift(900, 450), 0, '恰在一半不抬（fireBelow=0.5 严格小于）');
  ok('内容够满恒 0（零漂移）');
  const lift = cavityLift(900, 260);
  assert.ok(Math.abs(lift - (900 - 260) / 2 * 0.9) < 1e-9, `空腔一半×0.9（得 ${lift.toFixed(1)}）`);
  assert.ok(lift > 0 && lift < 900 - 260, '抬量在空腔内');
  ok('空腔场景抬空腔一半×0.9（仍偏下保对话观感）');
  assert.equal(cavityLift(900, 800, 0.8), 0, '自定义阈值内不抬');
  ok('fireBelow 可调');
}

// ====== REF_ASPECT 锚点 ======
{
  assert.ok(Math.abs(REF_ASPECT - 16 / 9) < 1e-12, '基准 16:9');
  ok('REF_ASPECT 锚点');
}

console.log(`aspect-layout: ${passed} 组全 PASS`);
