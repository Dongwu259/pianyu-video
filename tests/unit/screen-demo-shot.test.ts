/**
 * ScreenDemo 逐帧状态解析器（shared/screen-demo-shot.ts）单元测试：
 * 镜头查表 / easeOutBack / 镜内缓推 / 景别 zoom / 焦点偏置 / whoosh 过渡 /
 * 点击渐晕包络 / 点击浮卡生命 / 相机混合。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/screen-demo-shot.test.ts
 */

import assert from 'node:assert/strict';

const {
  resolveShotIndex, easeOutBack, shotDrift, shotZoom, shotFocusPx, biasFocus,
  transitionState, vignetteAlpha, floatCardState, blendCam, WHOOSH_SEC, DRIFT_MAX,
} = await import('../../src/shared/screen-demo-shot.ts');

type Shot = ReturnType<typeof import('../../src/shared/director-plan.ts').planDirectorShots>[number];
type DirectorShot = Shot;

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

/** 构造测试镜头（t 秒，媒体时基） */
const shot = (t0: number, t1: number, scale: DirectorShot['scale'], reason: DirectorShot['reason'] = 'energy', focus?: {x: number; y: number} | null, trans: DirectorShot['trans'] = 'cut'): DirectorShot =>
  ({t0, t1, scale, focus: focus ?? null, tilt: 0, trans, reason});

console.log('镜头查表:');
{
  const plan = [shot(0, 2, 'wide'), shot(2, 4.5, 'close', 'click'), shot(4.5, 8, 'medium')];
  assert.equal(resolveShotIndex([], 1), -1);
  assert.equal(resolveShotIndex(plan, 0), 0);
  assert.equal(resolveShotIndex(plan, 1.99), 0);
  assert.equal(resolveShotIndex(plan, 2), 1);
  assert.equal(resolveShotIndex(plan, 4.7), 2);
  assert.equal(resolveShotIndex(plan, 99), 2, '片尾越界钳到末镜');
  assert.equal(resolveShotIndex(plan, -5), 0, '片头越界钳到首镜');
  ok('二分定位与越界钳制');
}

console.log('缓推与 zoom:');
{
  const s = shot(1, 5, 'medium');
  assert.equal(shotDrift(s, 1), 1);
  assert.ok(Math.abs(shotDrift(s, 5) - (1 + DRIFT_MAX)) < 1e-9);
  assert.ok(shotDrift(s, 3) > 1 && shotDrift(s, 3) < 1 + DRIFT_MAX, '中途介于两者');
  assert.equal(shotDrift(s, 99), 1 + DRIFT_MAX, '越界钳制');
  ok('镜内缓推从 1 → 1+DRIFT_MAX');

  assert.equal(shotZoom(shot(0, 1, 'wide'), {zoomMed: 1.7, zoomClose: 2.6}), 1);
  assert.equal(shotZoom(shot(0, 1, 'medium'), {zoomMed: 1.7, zoomClose: 2.6}), 1.7);
  assert.equal(shotZoom(shot(0, 1, 'close'), {zoomMed: 1.7, zoomClose: 2.6}), 2.6);
  ok('景别 → 基准 zoom');

  assert.deepEqual(shotFocusPx(shot(0, 1, 'wide'), 1000, 800), {cx: 500, cy: 400}, 'wide 居中');
  assert.deepEqual(shotFocusPx(shot(0, 1, 'close', 'click', {x: 0.25, y: 0.75}), 1000, 800), {cx: 250, cy: 600});
  ok('焦点归一化 → 视频像素');
}

console.log('焦点偏置:');
{
  const focus = {cx: 500, cy: 400};
  assert.deepEqual(biasFocus(focus, {x: 900, y: 800}, 1000, 800, 0.3, false), {cx: 620, cy: 520}, '向光标偏 30%');
  assert.deepEqual(biasFocus(focus, {x: 900, y: 800}, 1000, 800, 0.3, true), focus, '点击镜头冻结不偏');
  assert.deepEqual(biasFocus(focus, null, 1000, 800, 0.3, false), focus, '无光标不偏');
  assert.deepEqual(biasFocus(focus, {x: 900, y: 800}, 1000, 800, 0, false), focus, 'bias=0 不偏');
  ok('非点击镜头轻偏光标 / 点击镜头冻结');
}

console.log('easeOutBack 与 whoosh 过渡:');
{
  assert.equal(easeOutBack(0), 0);
  assert.equal(easeOutBack(1), 1);
  assert.ok(easeOutBack(0.7) > 1.02, '中段过冲超过 1');
  assert.ok(easeOutBack(0.5) > 0.5, '缓出：前半程超过线性');
  ok('easeOutBack 端点与过冲');

  const plan = [
    shot(0, 2, 'wide', 'pause'),
    shot(2, 4, 'close', 'click', null, 'whoosh'),
    shot(4, 6, 'medium', 'energy'),
  ];
  const mid = transitionState(plan, 1, 2.09, WHOOSH_SEC);
  assert.ok(mid.q > 1 && mid.q < 1.2, `whoosh 中段过冲 (q=${mid.q.toFixed(3)})`);
  assert.equal(mid.sway, 1, '推近方向 +1');
  const end = transitionState(plan, 1, 2 + WHOOSH_SEC + 0.01, WHOOSH_SEC);
  assert.equal(end.q, 1);
  assert.equal(end.sway, 0);
  const cut = transitionState(plan, 2, 4.001, WHOOSH_SEC);
  assert.equal(cut.q, 1, 'cut 镜头无过渡');
  const out = transitionState(plan, 1, 2.02, WHOOSH_SEC);
  assert.ok(out.qlin > 0 && out.qlin < 1, '线性进度在 0..1');
  ok('whoosh 过冲/方向、cut 直通、结束归位');
}

console.log('点击渐晕:');
{
  const clickShot = shot(2, 6, 'close', 'click');
  assert.equal(vignetteAlpha(shot(0, 2, 'wide', 'pause'), 1), 0, '非点击镜头无渐晕');
  assert.ok(vignetteAlpha(clickShot, 2.01) < 0.05, '淡入起点接近 0');
  const peak = vignetteAlpha(clickShot, 3.5);
  assert.ok(Math.abs(peak - 0.42) < 1e-9, `峰值即 maxAlpha (${peak})`);
  assert.ok(vignetteAlpha(clickShot, 2.15) > 0 && vignetteAlpha(clickShot, 2.15) < 0.42, '淡入中');
  assert.ok(vignetteAlpha(clickShot, 5.9) > 0 && vignetteAlpha(clickShot, 5.9) < 0.42, '淡出中');
  ok('渐晕仅点击镜头、0.25s 出入包络');
}

console.log('点击浮卡:');
{
  const clicks = [
    {t: 2900, x: 250, y: 600, button: 1},
    {t: 3600, x: 250, y: 600, button: 1},
  ];
  const clickShot = shot(2, 6, 'close', 'click', {x: 0.25, y: 0.75});
  assert.equal(floatCardState(clicks, shot(0, 2, 'wide', 'pause'), 1), null, '非点击镜头无浮卡');
  assert.equal(floatCardState(clicks, clickShot, 2.5), null, '点击前（铺垫期）不出现——t0 比点击早 0.4s');
  assert.equal(floatCardState(clicks, clickShot, 3.05), null, 'appearSec 0.2s 内未出现——高亮环先说话');

  const entering = floatCardState(clicks, clickShot, 3.2);
  assert.ok(entering && entering.scale > 0.2 && entering.scale < 1, `入场生长中 (${entering?.scale.toFixed(3)})`);
  const birth = floatCardState(clicks, clickShot, 3.15);
  assert.ok(birth && birth.scale < 0.7 && birth.opacity === 1, '原地生长且全程不透明（无半透明入场期）');

  const alive = floatCardState(clicks, clickShot, 3.6);
  assert.ok(alive, '点击后浮卡在场');
  assert.ok(Math.abs(alive.cx - 0.25) < 1e-9 && Math.abs(alive.cy - 0.75) < 1e-9, '锚定镜头焦点');
  assert.ok(Math.abs(alive.scale - 1) < 0.02, `入场完成后 scale≈1 (${alive.scale.toFixed(3)})`);
  assert.equal(alive.opacity, 1);

  const fading = floatCardState(clicks, clickShot, 4.65);
  assert.ok(fading && fading.opacity > 0 && fading.opacity < 1, '退场末 0.2s 渐出');
  const gone = floatCardState(clicks, clickShot, 2.9 + 0.2 + 1.6 + 0.01);
  assert.equal(gone, null, '生命 1.6s 后消失');
  ok('浮卡等真正点击才出现、锚定焦点、原地生长不透明、生命结束消失');
}

console.log('相机混合:');
{
  const a = {scale: 1, translateX: 0, translateY: 0};
  const b = {scale: 2, translateX: 100, translateY: -50};
  assert.deepEqual(blendCam(a, b, 0), a);
  assert.deepEqual(blendCam(a, b, 1), b);
  const mid = blendCam(a, b, 0.5);
  assert.ok(Math.abs(mid.scale - 1.5) < 1e-9 && Math.abs(mid.translateX - 50) < 1e-9);
  ok('blendCam 端点与中点线性');
}

console.log(`\n共 ${passed} 项断言全部通过`);
