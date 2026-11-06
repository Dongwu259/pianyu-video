/**
 * T3 转场锚点（shared/transition-anchor.ts）纯逻辑单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/transition-anchor.test.ts
 * （被测模块为纯函数、不依赖 electron）
 */

import assert from 'node:assert/strict';
import {
  resolveAnchorRect,
  anchorZoomFit,
  resolveZoomTransitionOpts,
  isValidTransitionAnchor,
} from '../../src/shared/transition-anchor.ts';
import {transitionStyle} from '../../src/shared/transition-style.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import type {TransitionAnchor, TemplateLayout} from '../../src/shared/types.ts';

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

const anchor = (w: number, h: number, cx = 0.5, cy = 0.5, followLayout?: boolean): TransitionAnchor =>
  ({shape: 'rect', w, h, cx, cy, ...(followLayout !== undefined ? {followLayout} : {})});

console.log('cover 拟合数学：');
{
  // 宽幅画框（0.84×0.45）：高度是短板 → zoom = 1/0.45 ≈ 2.22
  const f = anchorZoomFit(anchor(0.84, 0.45, 0.5, 0.275, false));
  check('宽幅锚点按高度 cover', Math.abs(f.zoom - 1 / 0.45) < 1e-9, `zoom=${f.zoom.toFixed(3)}`);
  check('焦点=锚点中心', f.focus.x === 0.5 && f.focus.y === 0.275);
}
{
  // 手机壳宽锚点（0.16×0.58）：宽度是短板 → 6.25 ≤ MAX_ZOOM 6.5（T3 放宽后可达）
  const f = anchorZoomFit(anchor(0.16, 0.58, 0.5, 0.55, false));
  check('窄高锚点按宽度 cover（≤6.5）', Math.abs(f.zoom - 6.25) < 1e-9, `zoom=${f.zoom.toFixed(3)}`);
}
{
  // 极小圆（直径 0.1）→ cover 10 → 钳 6.5
  const f = anchorZoomFit(anchor(0.1, 0.1, 0.5, 0.5));
  check('极小锚点钳 6.5', f.zoom === 6.5);
}
{
  // 近满幅（0.9×0.9）→ cover 1.11 → 钳 MIN_ZOOM 1.2
  const f = anchorZoomFit(anchor(0.9, 0.9));
  check('近满幅锚点钳 MIN_ZOOM', f.zoom === 1.2);
}

console.log('layout 跟随：');
{
  const layout: TemplateLayout = {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0.12, videoOffsetY: -0.08};
  const r = resolveAnchorRect(anchor(0.6, 0.5), layout);
  check('followLayout 缺省叠加偏移', r.cx === 0.62 && r.cy === 0.42, `c=(${r.cx},${r.cy})`);
  const r2 = resolveAnchorRect(anchor(0.6, 0.5, 0.5, 0.47, false), layout);
  check('followLayout=false 不动', r2.cx === 0.5 && r2.cy === 0.47);
  const f = anchorZoomFit(anchor(0.6, 0.5), layout);
  check('拟合焦点随偏移', f.focus.x === 0.62 && f.focus.y === 0.42);
}

console.log('优先级（显式参数 > 锚点 > 旧默认）：');
{
  const layout: TemplateLayout = {videoWidthRatio: 1, videoHeightRatio: 1, videoOffsetX: 0.2, videoOffsetY: 0};
  // 显式焦点+倍率全赢
  const a = resolveZoomTransitionOpts({focusX: 0.8, focusY: 0.2, zoom: 1.5}, anchor(0.6, 0.5), layout, layout);
  check('显式焦点+倍率优先', a.focus.x === 0.8 && a.focus.y === 0.2 && a.zoom === 1.5);
  // 显式倍率赢、焦点走锚点
  const b = resolveZoomTransitionOpts({zoom: 1.5}, anchor(0.6, 0.5, 0.5, 0.5, true), layout, layout);
  check('显式倍率+锚点焦点', b.zoom === 1.5 && b.focus.x === 0.7 && b.focus.y === 0.5, `focus=(${b.focus.x},${b.focus.y})`);
  // 无显式 → 锚点拟合；无锚点 → 旧自动焦点（layout 视频 viewport 中心）+ zoom undefined
  const c = resolveZoomTransitionOpts(undefined, anchor(0.62, 0.62, 0.5, 0.47, false), layout, layout);
  check('锚点拟合生效', Math.abs((c.zoom ?? 0) - 1 / 0.62) < 1e-9 && c.focus.y === 0.47);
  const d = resolveZoomTransitionOpts(undefined, undefined, layout, layout);
  check('无锚点回落自动焦点/undefined', d.zoom === undefined && d.focus.x === 0.7 && d.focus.y === 0.5);
}

console.log('transitionStyle 接受锚点倍率（>4 不再被钳）：');
{
  const f = anchorZoomFit(anchor(0.16, 0.58, 0.5, 0.55, false)); // zoom 6.25
  const inStyle = transitionStyle('zoomIn', 'in', 0, {focus: f.focus, zoom: f.zoom});
  // in q=0：scale = zoom + (1-zoom)·ez(0) = zoom = 6.25（不再被钳到 4）
  const m = inStyle.transform?.match(/scale\(([\d.]+)\)/);
  check('zoomIn 起始倍率=锚点 cover 值', !!m && Math.abs(parseFloat(m[1]) - 6.25) < 1e-6, m?.[1] ?? 'none');
}

console.log('注册表标注健全性：');
{
  const anchored = TEMPLATES.filter((t) => t.transitionAnchor);
  check('首批 5 个模板已标注', anchored.length === 5, anchored.map((t) => t.id).join(','));
  check('全部标注合法', anchored.every((t) => isValidTransitionAnchor(t.transitionAnchor)));
  // 标注值抽查：CodeTerminal 终端卡 0.62×0.62 中心 y=0.47
  const ct = TEMPLATES.find((t) => t.id === 'CodeTerminal')!;
  check('CodeTerminal 几何', ct.transitionAnchor?.w === 0.62 && ct.transitionAnchor?.h === 0.62 && ct.transitionAnchor?.cy === 0.47 && ct.transitionAnchor?.followLayout === false);
  // 各标注的 cover 倍率都在合理区间 [1.2, 6.5]
  const fits = anchored.map((t) => anchorZoomFit(t.transitionAnchor!).zoom);
  check('cover 倍率 ∈ [1.2, 6.5]', fits.every((z) => z >= 1.2 && z <= 6.5), fits.map((z) => z.toFixed(2)).join(','));
}

console.log(`\ntransition-anchor: ${failed === 0 ? `✓ 全部 ${passed} 项通过` : `✗ ${failed} 项失败`}`);
if (failed > 0) process.exit(1);
