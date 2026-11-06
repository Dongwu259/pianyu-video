/**
 * 演示故事板构建器 单元测试
 *
 * 关键不变量：所有演示分镜选用的模板必须 minVideos: 0（零素材可渲染）——
 * 演示编排的用户往往一条素材都没有，出现需素材模板就会渲染出空展板。
 *
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/demo-storyboard.test.ts
 */

import assert from 'node:assert/strict';
import {buildDemoStoryboardSpecs, demoStoryboardMessage} from '../../src/renderer/ai/demoStoryboard.ts';
import {TEMPLATES} from '../../src/shared/template-registry.ts';
import {VIDEO_TYPES, VIDEO_TYPE_LABEL} from '../../src/shared/video-type.ts';

const ALL_IDS = new Set(TEMPLATES.map((t) => t.id));
const ZERO_MEDIA_IDS = new Set(TEMPLATES.filter((t) => t.minVideos === 0).map((t) => t.id));

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

test('每个体裁都能生成 ≥4 段演示分镜（模板全可用）', () => {
  for (const vt of VIDEO_TYPES) {
    const specs = buildDemoStoryboardSpecs(vt, ALL_IDS);
    assert.ok(specs.length >= 4, `${vt}: 仅 ${specs.length} 段`);
  }
});

test('所有演示模板都 minVideos: 0（零素材可渲染）', () => {
  for (const vt of VIDEO_TYPES) {
    for (const spec of buildDemoStoryboardSpecs(vt, ALL_IDS)) {
      assert.ok(
        ZERO_MEDIA_IDS.has(spec.templateId),
        `${vt} 的 ${spec.templateId} 需要素材（minVideos > 0），演示场景不可用`,
      );
    }
  }
});

test('首段是视觉系开场、末段是 OutroCTA 收尾', () => {
  const specs = buildDemoStoryboardSpecs('promo', ALL_IDS);
  assert.equal(specs[0].templateId, 'Hero3DTitle');
  assert.equal(specs[specs.length - 1].templateId, 'OutroCTA');
});

test('spec 字段完整：时长为正、文案非空、转场合法、text 结构齐', () => {
  for (const vt of VIDEO_TYPES) {
    for (const s of buildDemoStoryboardSpecs(vt, ALL_IDS)) {
      assert.ok(s.duration > 0, `${s.templateId} 时长非法：${s.duration}`);
      assert.ok(s.text.title.trim().length > 0, `${s.templateId} 标题为空`);
      assert.ok(Array.isArray(s.text.features), `${s.templateId} features 非数组`);
      assert.equal(s.transition, 'crossfade');
      assert.equal(s.videoEffect, 'none');
      assert.equal(s.backgroundEffect, 'none');
      assert.equal(s.narration, undefined);
      assert.equal(s.captions, undefined);
      assert.equal(s.customParams, undefined);
    }
  }
});

test('availableIds 过滤生效：空集返回空数组；单 id 只留命中段', () => {
  assert.deepEqual(buildDemoStoryboardSpecs('promo', new Set()), []);
  const only = buildDemoStoryboardSpecs('promo', new Set(['OutroCTA']));
  assert.equal(only.length, 1);
  assert.equal(only[0].templateId, 'OutroCTA');
});

test('说明消息带体裁与段数', () => {
  const msg = demoStoryboardMessage(VIDEO_TYPE_LABEL.promo, 5);
  assert.ok(msg.includes('产品宣传片'), '缺体裁名');
  assert.ok(msg.includes('5 段'), '缺段数');
  assert.ok(msg.includes('快速预览'), '缺下一步指引');
});

console.log(`[demo-storyboard] ✓ ${passed} 项全部通过`);
