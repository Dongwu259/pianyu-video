/**
 * 「What's New」展示判定纯逻辑单元测试（shouldShowWhatsNew）
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/whats-new.test.ts
 * （被测模块不依赖 React / Electron）
 */

import assert from 'node:assert/strict';
import {shouldShowWhatsNew, WHATS_NEW_STORAGE_KEY} from '../../src/renderer/whats-new.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('whats-new shouldShowWhatsNew');

// 首次安装：localStorage 无记录（null）→ 显示
assert.equal(shouldShowWhatsNew(null, '0.9.0'), true);
ok('seen=null 时显示');

// 同一版本已看过 → 不显示（不打扰：同一版本只弹一次）
assert.equal(shouldShowWhatsNew('0.9.0', '0.9.0'), false);
ok('seen 与当前版本相同时不显示');

// 版本升级：已看旧版本 → 显示
assert.equal(shouldShowWhatsNew('0.8.0', '0.9.0'), true);
ok('版本不同时显示');

// 空串视为未看过 → 显示
assert.equal(shouldShowWhatsNew('', '0.9.0'), true);
ok('seen 为空串时显示');

// 当前版本获取失败（null / 空串）→ 不显示
assert.equal(shouldShowWhatsNew(null, null), false);
assert.equal(shouldShowWhatsNew('0.9.0', null), false);
assert.equal(shouldShowWhatsNew(null, ''), false);
assert.equal(shouldShowWhatsNew('0.8.0', ''), false);
ok('当前版本缺失（null/空串）时不显示');

// 存储键固定（展示逻辑依赖该键名，改动会破坏既有用户的已看记录）
assert.equal(WHATS_NEW_STORAGE_KEY, 'pianyu.whatsNewSeen');
ok('存储键为 pianyu.whatsNewSeen');

console.log(`\n${passed} 项断言全部通过`);
