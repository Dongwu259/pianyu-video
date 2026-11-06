/**
 * template-slot-windows 单测：3D 家族槽位窗口查询（编排查表代替猜窗口）
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/template-slot-windows.test.ts
 */
import assert from 'node:assert/strict';
import {getTemplateSlotWindows, isSlotWindowTemplate, SLOT_WINDOW_TEMPLATE_IDS} from '../../src/shared/template-slot-windows.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('template-slot-windows:');

t('七款 3D 模板受支持，其余模板返回 null', () => {
  assert.equal(SLOT_WINDOW_TEMPLATE_IDS.length, 7);
  for (const id of SLOT_WINDOW_TEMPLATE_IDS) {
    assert.ok(isSlotWindowTemplate(id), id);
    assert.ok(getTemplateSlotWindows(id, 12.3, 3) !== null, id);
  }
  assert.equal(getTemplateSlotWindows('ScreenDemo', 8.9, 1), null);
  assert.equal(getTemplateSlotWindows('ProductFloat', 6, 1), null);
});

t('默认参数（模板注册表缺省：SpiralAtrium camSpeed 0 舒缓）：行进占大头、驻留仅 ~1.3s——这正是「没放完就转走」的量级', () => {
  const w = getTemplateSlotWindows('SpiralAtrium3D', 12.3, 3)!;
  assert.equal(w.panelCount, 3);
  assert.equal(w.slots.length, 3);
  // 开场 12% / 收尾 8%
  assert.ok(Math.abs(w.openSec - 1.48) < 0.02, `openSec=${w.openSec}`);
  assert.ok(Math.abs(w.outroSec - 11.32) < 0.02, `outroSec=${w.outroSec}`);
  assert.ok(w.slots[0].dwellDurSec > 1 && w.slots[0].dwellDurSec < 1.6, `板0驻留 ${w.slots[0].dwellDurSec}s（舒缓档 travel 占比被拉高）`);
  assert.ok(w.effective.camSpeed === 0 && w.effective.dwellRatio === 2, '缺省值取自注册表');
});

t('camSpeed 1（标准）：驻留回到 ~2.3s——素材精彩时刻的可读窗口', () => {
  const w = getTemplateSlotWindows('SpiralAtrium3D', 12.3, 3, {camSpeed: 1})!;
  assert.ok(w.slots[0].dwellDurSec > 2 && w.slots[0].dwellDurSec < 2.8, `板0驻留 ${w.slots[0].dwellDurSec}s`);
  // 顺序推进、行进结束即驻留开始
  for (let i = 1; i < 3; i++) {
    assert.ok(w.slots[i].travelStartSec >= w.slots[i - 1].dwellEndSec - 0.01);
    assert.ok(Math.abs(w.slots[i].dwellStartSec - w.slots[i].travelEndSec) < 0.01);
  }
  assert.ok(w.slots[2].dwellEndSec <= w.outroSec + 0.01);
});

t('focusPanel/focusBoost：重点板驻留被单独拉长（每板单独设置停留）', () => {
  const base = getTemplateSlotWindows('SpiralAtrium3D', 12.3, 3)!;
  const boosted = getTemplateSlotWindows('SpiralAtrium3D', 12.3, 3, {focusPanel: 2, focusBoost: 2})!;
  assert.ok(boosted.slots[2].dwellDurSec > base.slots[2].dwellDurSec * 1.5, `末板驻留 ${base.slots[2].dwellDurSec.toFixed(2)} → ${boosted.slots[2].dwellDurSec.toFixed(2)}`);
  assert.ok(boosted.slots[0].dwellDurSec < base.slots[0].dwellDurSec, '非重点板相应缩短');
});

t('camSpeed 舒缓档拉长行进（驻留相应缩短）', () => {
  const std = getTemplateSlotWindows('OrbitCarousel3D', 12, 3, {camSpeed: 1})!;
  const slow = getTemplateSlotWindows('OrbitCarousel3D', 12, 3, {camSpeed: 0})!;
  assert.ok(slow.slots[0].travelEndSec - slow.slots[0].travelStartSec > std.slots[0].travelEndSec - std.slots[0].travelStartSec, '舒缓档 travel 更长');
});

t('dwellRatio 快档缩短驻留、板数越多每板越短', () => {
  const fast = getTemplateSlotWindows('TimeTunnel3D', 12, 3, {dwellRatio: 0})!;
  const long = getTemplateSlotWindows('TimeTunnel3D', 12, 3, {dwellRatio: 2})!;
  assert.ok(fast.slots[0].dwellDurSec < long.slots[0].dwellDurSec);
  const six = getTemplateSlotWindows('TimeTunnel3D', 12, 6)!;
  assert.ok(six.slots[0].dwellDurSec < long.slots[0].dwellDurSec, '6 板均摊更短');
  assert.equal(six.slots.length, 6);
});

t('编排纪律口径：素材精彩时刻落在槽位开头（0 ~ dwellDurSec）', () => {
  // 画中画从驻留开始播放：素材本地 0 对齐 dwellStartSec
  const w = getTemplateSlotWindows('SpiralAtrium3D', 12.3, 3)!;
  const cueInMaterial = 1.2; // 某素材精彩时刻在素材本地 1.2s
  const slot = w.slots[0];
  assert.ok(cueInMaterial <= slot.dwellDurSec, 'cue 1.2s 落在板 1 可见窗口内');
  const cueTooLate = 3.5;
  assert.ok(cueTooLate > slot.dwellDurSec, 'cue 3.5s 超出板 1 可见窗口（应警告）');
});

t('非法输入安全：时长 0/板数 0 回退合理', () => {
  assert.equal(getTemplateSlotWindows('SpiralAtrium3D', 0, 3), null);
  assert.equal(getTemplateSlotWindows('SpiralAtrium3D', -5, 3), null);
  const w = getTemplateSlotWindows('SpiralAtrium3D', 12, 99)!;
  assert.equal(w.panelCount, 6, '板数钳到装配上限 6');
  const one = getTemplateSlotWindows('SpiralAtrium3D', 12, 0)!;
  assert.equal(one.panelCount, 1);
});

console.log(`template-slot-windows: ${passed} 项通过`);
if (process.exitCode) process.exit(process.exitCode);
