/**
 * 片语本地模型契约层单测：显存/磁盘判定红绿灯、清单完整性（sha256 与官网 SHA256SUMS 一致）、
 * 运行时分发件、模型命名（pianyu-v1-2b 全称）、商业文案常量（8 元口径单点维护）。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/local-model.test.ts
 */

import assert from 'node:assert/strict';
import {
  LEGACY_MODEL_ID,
  LOCAL_MODEL_ALL_FILES,
  LOCAL_MODEL_BASE,
  LOCAL_MODEL_BASE_URL,
  LOCAL_MODEL_COMMERCIAL,
  LOCAL_MODEL_DECISION_KEY,
  LOCAL_MODEL_FILES,
  LOCAL_MODEL_MIN_DISK_BYTES,
  LOCAL_MODEL_MIN_VRAM_MB,
  LOCAL_MODEL_NAME,
  LOCAL_MODEL_PORT_BASE,
  LOCAL_MODEL_TOTAL_GB,
  RUNTIME_FILE,
  diskVerdict,
  vramVerdict,
} from '../../src/shared/local-model.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

console.log('local-model（付费版权重下载契约）');

t('vramVerdict：8GB 门槛红绿灯（8188MiB 实标卡必须过——2026-10 误判回归案例）', () => {
  assert.ok(vramVerdict(8192).ok, '恰好 8192 应满足');
  assert.ok(vramVerdict(8188).ok, 'RTX 4060 系 nvidia-smi 实标 8188MiB，按 8192 判会误杀（红线回归）');
  assert.ok(vramVerdict(16384).ok && vramVerdict(16384).label === '显存满足');
  const low = vramVerdict(4096);
  assert.ok(!low.ok && low.label === '显存不足' && low.detail.includes('8GB'), '4GB 应红灯并说明门槛');
  const none = vramVerdict(0);
  assert.ok(!none.ok && none.label === '未检测到显卡');
  assert.equal(LOCAL_MODEL_MIN_VRAM_MB, 8000, '门槛取 8000：容纳 8188MiB 实标，且与 7GB 档（7168）保持距离');
});

t('diskVerdict：6GB 门槛（权重 4.3GB + llama.cpp 运行时；无导入副本）', () => {
  assert.ok(diskVerdict(LOCAL_MODEL_MIN_DISK_BYTES).ok);
  assert.ok(!diskVerdict(LOCAL_MODEL_MIN_DISK_BYTES - 1).ok);
  const low = diskVerdict(3 * 1024 * 1024 * 1024);
  assert.ok(!low.ok && low.detail.includes('运行时'), '不足时应说明磁盘构成');
  assert.ok(!low.detail.includes('ollama'), 'Ollama 已换代移除，文案不再出现');
});

t('权重清单：两件 sha256 与官网 SHA256SUMS 一致 + 尺寸为正 + 基地址 https', () => {
  assert.equal(LOCAL_MODEL_FILES.length, 2);
  // 与 server/public/downloads/models/SHA256SUMS 逐字节一致的硬校验（2026-10-05 分发件）
  assert.equal(LOCAL_MODEL_FILES[0].sha256, 'e765986ee68c49c1b8b0214adecf7121557ea4a2292423e253bcb6a1029d28a9');
  assert.equal(LOCAL_MODEL_FILES[1].sha256, '486dee15ea6e4d332f57042a4c3796c9c998214f194ed3b79e09499b23d6f52a');
  for (const f of LOCAL_MODEL_FILES) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.sizeBytes > 100 * 1024 * 1024, `${f.name} 尺寸应为真实量级`);
  }
  assert.ok(LOCAL_MODEL_BASE_URL.startsWith('https://') && LOCAL_MODEL_BASE_URL.endsWith('/'));
});

t('运行时分发件：llama.cpp 裁剪包有名校验值 + 下载清单 = 权重×2 + 运行时', () => {
  assert.equal(LOCAL_MODEL_ALL_FILES.length, 3);
  assert.match(RUNTIME_FILE.name, /^llamacpp-runtime-b\d+-win64-cuda[\d.]+\.zip$/);
  assert.match(RUNTIME_FILE.sha256, /^[0-9a-f]{64}$/, '裁剪包 sha256 必须回填（分发完整性红线）');
  assert.ok(RUNTIME_FILE.sizeBytes > 100 * 1024 * 1024, '裁剪后仍应为百 MB 量级');
});

t('模型命名与基座：全称 pianyu-v1-2b（对外唯一身份）+ 旧 Ollama 名仅作迁移识别', () => {
  assert.equal(LOCAL_MODEL_NAME, 'pianyu-v1-2b');
  assert.equal(LOCAL_MODEL_BASE, 'Qwen3-VL-2B-Instruct');
  assert.equal(LEGACY_MODEL_ID, 'pianyu-2b');
  assert.ok(LOCAL_MODEL_PORT_BASE >= 1024 && LOCAL_MODEL_PORT_BASE !== 11434, '端口避开 Ollama 默认 11434');
});

t('商业口径单点：¥6/月订阅 + 本地不限 token + 8GB 显存文案齐备', () => {
  // 2026-11-06 开源转型：模型从「8 元付费版内包含」改为「专有模型，订阅 ¥6/月 可下载」。
  // 同时断言「订阅」语义在场——防止文案回退成「解锁软件」（开源后这是必须守住的表述）。
  assert.ok(LOCAL_MODEL_COMMERCIAL.priceNote.includes('¥6/月'), '模型价格口径必须是 ¥6/月');
  assert.ok(LOCAL_MODEL_COMMERCIAL.priceNote.includes('订阅'), '必须是订阅语义，不能是解锁软件');
  assert.ok(LOCAL_MODEL_COMMERCIAL.benefit.includes('不限 token'));
  assert.ok(LOCAL_MODEL_COMMERCIAL.hardwareNote.includes('8GB'));
  assert.equal(LOCAL_MODEL_TOTAL_GB, '4.3');
  assert.ok(LOCAL_MODEL_DECISION_KEY.length > 0);
});

console.log(`\n${passed} 项通过`);
