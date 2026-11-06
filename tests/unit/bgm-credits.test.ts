/**
 * 内置配乐署名链路（bgm-credits 纯函数 + bgmLibrary 服务）单元测试
 *
 * 覆盖：情绪槽位派生/署名行格式/署名义务判定（强制烧录总开关的判据）、
 * BGM_CREDITS 数据完整性、listBuiltinBgm 的 credits∩磁盘 过滤与真实曲库集成。
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/bgm-credits.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  BGM_CREDITS,
  BGM_MOOD_LABELS,
  bgmMoodFromFile,
  creditHost,
  bgmCreditLine,
  isAttributionRequired,
} from '../../src/shared/bgm-credits.ts';
import {listBuiltinBgm} from '../../src/main/services/bgmLibrary.ts';

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
};

console.log('bgm-credits（署名数据与派生函数）:');

check('BGM_CREDITS 完整性：12 首、全部 CC BY 4.0、文件名唯一、六情绪槽位 ×2', () => {
  assert.equal(BGM_CREDITS.length, 12);
  assert.ok(BGM_CREDITS.every((c) => c.license === 'CC BY 4.0'));
  assert.ok(BGM_CREDITS.every((c) => c.author === 'Kevin MacLeod'));
  assert.equal(new Set(BGM_CREDITS.map((c) => c.file)).size, 12);
  const byMood = new Map<string, number>();
  for (const c of BGM_CREDITS) byMood.set(bgmMoodFromFile(c.file), (byMood.get(bgmMoodFromFile(c.file)) ?? 0) + 1);
  assert.equal(byMood.size, 6, `六情绪槽位，实际 ${[...byMood.keys()].join(',')}`);
  assert.ok([...byMood.values()].every((n) => n === 2));
});

check('bgmMoodFromFile：`uplifting-2.mp3` → uplifting；无前缀回退 other', () => {
  assert.equal(bgmMoodFromFile('uplifting-2.mp3'), 'uplifting');
  assert.equal(bgmMoodFromFile('Dramatic-1.mp3'), 'dramatic');
  assert.equal(bgmMoodFromFile('whatever.mp3'), 'other');
  assert.equal(bgmMoodFromFile(''), 'other');
});

check('六情绪槽位全部有中文标签', () => {
  for (const mood of new Set(BGM_CREDITS.map((c) => bgmMoodFromFile(c.file)))) {
    assert.ok(BGM_MOOD_LABELS[mood], `槽位 ${mood} 缺标签`);
  }
});

check('creditHost：域名提取 + 非法 url 回退原文', () => {
  assert.equal(creditHost('https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ripples.mp3'), 'incompetech.com');
  assert.equal(creditHost('不是 url'), '不是 url');
});

check('bgmCreditLine：标准格式（片尾烧录/提示/复制三处共用）', () => {
  const line = bgmCreditLine(BGM_CREDITS[2]); // Ripples
  assert.equal(line, 'Music: Ripples by Kevin MacLeod (incompetech.com) · CC BY 4.0');
});

check('isAttributionRequired：CC BY 系 true；CC0/空/缺字段 false', () => {
  assert.ok(isAttributionRequired({file: 'a.mp3', title: 'A', author: 'X', license: 'CC BY 4.0', url: 'https://x.com/a'}));
  assert.ok(isAttributionRequired({file: 'a.mp3', title: 'A', author: 'X', license: 'cc by 3.0', url: 'https://x.com/a'}));
  assert.ok(!isAttributionRequired({file: 'a.mp3', title: 'A', author: 'X', license: 'CC0', url: 'https://x.com/a'}));
  assert.ok(!isAttributionRequired(null));
  assert.ok(!isAttributionRequired(undefined));
});

console.log('\nbgmLibrary 服务（credits ∩ 磁盘）:');

check('真实曲库集成：12 首全部在磁盘上、path 绝对、槽位/标签派生正确', () => {
  // 测试文件在 tests/unit/ → resolve(../..) = 仓库根 → resources/bgm（与服务运行时同公式）
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const list = listBuiltinBgm(testsDir);
  assert.equal(list.length, 12, `实际 ${list.length} 首`);
  const calm = list.find((t) => t.file === 'calm-1.mp3');
  assert.ok(calm, 'calm-1 缺失');
  assert.equal(calm!.title, 'Ripples');
  assert.equal(calm!.mood, 'calm');
  assert.equal(calm!.moodLabel, '舒缓');
  assert.ok(path.isAbsolute(calm!.path) && fs.existsSync(calm!.path));
  assert.ok(list.every((t) => t.license === 'CC BY 4.0'));
});

check('临时目录：credits∩磁盘过滤——缺货曲剔除、无 credits 的多余文件不列出、顺序随 credits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pianyu-bgm-lib-'));
  try {
    // 复刻服务候选公式：dirname=«tmp»/main/services → ../../ = tmp → tmp/resources/bgm
    const bgmDir = path.join(tmp, 'resources', 'bgm');
    fs.mkdirSync(bgmDir, {recursive: true});
    fs.writeFileSync(path.join(bgmDir, 'calm-1.mp3'), 'x');
    fs.writeFileSync(path.join(bgmDir, 'zzz-not-in-credits.mp3'), 'x');
    const list = listBuiltinBgm(path.join(tmp, 'main', 'services'));
    assert.equal(list.length, 1);
    assert.equal(list[0].file, 'calm-1.mp3');
    assert.equal(list[0].title, 'Ripples');
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

console.log(`\nbgm-credits: ${passed} 组断言${failed === 0 ? '全部通过' : `（失败 ${failed}）`}`);
if (failed > 0 || passed < 8) process.exit(1);
