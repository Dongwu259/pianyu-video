/**
 * template-presets.ts 单测：预设与模板参数面同步锚定
 * （预设键必须存在于对应 PARAMS 且值在 min/max 内——防预设与参数面漂移的静态校验）
 */
import assert from 'node:assert/strict';
import {TEMPLATE_PRESETS, presetParams} from '../../src/shared/template-presets.ts';
import {
  CURSOR_FOLLOW_PARAMS, PANEL_FLYOUT_PARAMS, WHITEBOARD_CANVAS_PARAMS,
  CHAT_CONVERSATION_PARAMS, DOC_PANEL_PARAMS, KINETIC_TYPE_PARAMS, AI_PROMPT_CARD_PARAMS,
  portraitParamsFor,
} from '../../src/shared/template-registry.ts';

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const REGISTRY: Record<string, Array<{key: string; min?: number; max?: number}>> = {
  CursorFollow: CURSOR_FOLLOW_PARAMS,
  PanelFlyout: PANEL_FLYOUT_PARAMS,
  WhiteboardCanvas: WHITEBOARD_CANVAS_PARAMS,
  ChatConversation: CHAT_CONVERSATION_PARAMS,
  DocPanel: DOC_PANEL_PARAMS,
  KineticType: KINETIC_TYPE_PARAMS,
  AiPromptCard: AI_PROMPT_CARD_PARAMS,
};

{
  // 覆盖完整性：REGISTRY 里每个模板都有预设（主力模板不许裸奔）
  for (const tpl of Object.keys(REGISTRY)) {
    assert.ok(TEMPLATE_PRESETS[tpl]?.length > 0, `${tpl} 缺预设`);
  }
  ok('主力模板全部有预设');
}

{
  // 同步性：每个预设的参数键存在于 PARAMS、值在 [min,max] 内；id 唯一
  for (const [tpl, presets] of Object.entries(TEMPLATE_PRESETS)) {
    const specs = REGISTRY[tpl];
    assert.ok(specs, `${tpl} 不在同步校验注册表里`);
    const ids = new Set<string>();
    for (const preset of presets) {
      assert.ok(!ids.has(preset.id), `${tpl}/${preset.id} 重复`);
      ids.add(preset.id);
      for (const [k, v] of Object.entries(preset.params)) {
        const spec = specs.find((sp) => sp.key === k);
        assert.ok(spec, `${tpl}/${preset.id} 参数 ${k} 不存在于 PARAMS（参数面改了预设没跟）`);
        if (typeof spec.min === 'number') assert.ok(v >= spec.min, `${tpl}/${preset.id}.${k}=${v} < min ${spec.min}`);
        if (typeof spec.max === 'number') assert.ok(v <= spec.max, `${tpl}/${preset.id}.${k}=${v} > max ${spec.max}`);
      }
    }
  }
  ok('预设键值与 PARAMS 同步（键存在+值域内+id 唯一）');
}

{
  // presetParams：命中返回参数包副本（改返回值不污染预设）、未命中抛错（装配期炸而非静默空参）
  const pack = presetParams('WhiteboardCanvas', 'pan-scan');
  assert.equal(pack.panMode, 1);
  pack.panMode = 0;
  assert.equal(presetParams('WhiteboardCanvas', 'pan-scan').panMode, 1);
  assert.throws(() => presetParams('WhiteboardCanvas', 'nope'));
  assert.throws(() => presetParams('NoTpl', 'nope'));
  ok('presetParams 副本语义/未命中抛错');
}

{
  // P2-6 官方实录语言固化：glow-stage-portrait 必须 = glow-stage + registry portraitParams 组合
  // （双源漂移防线：竖屏直写档与派生叠加层同源，改 portraitParams 时预设被此断言拽住）
  const glow = presetParams('CursorFollow', 'glow-stage');
  const glowP = presetParams('CursorFollow', 'glow-stage-portrait');
  assert.equal(glow.stageCard, 2, 'glow-stage 辉光窗口卡');
  assert.equal(glow.smoothCursor, 0, 'smoothCursor 关（v8.1 重定时坑）');
  const overlay = portraitParamsFor('CursorFollow');
  for (const [k, v] of Object.entries(overlay)) {
    assert.equal(glowP[k], v, `glow-stage-portrait.${k} 与 registry portraitParams 漂移`);
  }
  for (const [k, v] of Object.entries(glow)) {
    if (!(k in overlay)) assert.equal(glowP[k], v, `glow-stage-portrait.${k} 与 glow-stage 漂移`);
  }
  ok('glow-stage / glow-stage-portrait = 基座 + registry 竖屏配方（组合纪律）');
}

console.log(`\n共 ${passed} 项全部通过`);
