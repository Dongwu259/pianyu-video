/**
 * 全自动流水线（提示词构造 / 防御性 JSON 解析）+ 素材打标解析 单元测试
 *
 * 运行方式：node server/node_modules/tsx/dist/cli.mjs tests/unit/auto-pipeline.test.ts
 */

import assert from 'node:assert/strict';
import {
  extractJsonText,
  isPipelineMiningGenre,
  buildOutlinePrompt,
  parseOutline,
  formatOutlineBeats,
  buildStoryboardGenPrompt,
  parseStoryboardGen,
  buildPolishPrompt,
  parsePolish,
  applyPolishPatches,
  buildMaterialsPlanPrompt,
  parseMaterialsPlan,
  buildAutoFixPrompt,
  parseAutoFix,
  buildMetadataPrompt,
  parseMetadataGen,
  buildPipelinePlanText,
  paramsBriefOf,
  PIPELINE_STEPS,
} from '../../src/shared/auto-pipeline.ts';
import {buildMediaTagPrompt, mediaTagStorySummary, parseMediaTagResponse} from '../../src/shared/media-tags.ts';
import {
  validateRunPipelineArgs,
  validateSearchStockArgs,
  validateGenerateImageArgs,
  validateSetBgmArgs,
  validateAnalyzeAudioArgs,
} from '../../src/shared/llm-tools.ts';

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

const TEMPLATES = [
  {id: 'BrandIntro', name: '片头', description: '品牌片头', minVideos: 0, maxVideos: 2, defaultDuration: 2},
  {id: 'FeatureShowcase', name: '功能展示', description: 'PiP 展示', minVideos: 1, maxVideos: 3, defaultDuration: 5},
  {id: 'KineticType', name: '节拍大字', description: '零素材大字', minVideos: 0, maxVideos: 0, defaultDuration: 4},
];

console.log('extractJsonText（防御性 JSON 提取）:');
check('裸数组 / 围栏 / 前后夹文本 / 对象', () => {
  assert.equal(extractJsonText('[{"a":1}]'), '[{"a":1}]');
  assert.equal(extractJsonText('```json\n[1,2]\n```'), '[1,2]');
  assert.equal(extractJsonText('好的，结果如下：{"a":1} 以上。'), '{"a":1}');
  assert.equal(extractJsonText('没有 JSON'), null);
  assert.equal(extractJsonText(''), null);
});

console.log('buildStoryboardGenPrompt / parseStoryboardGen:');
check('提示词含需求/时长/模板清单/素材能力/零素材标注（promo 口径与历史文案一致）', () => {
  const p = buildStoryboardGenPrompt({
    brief: '剪辑猫 AI 剪辑软件宣传片',
    videoType: 'promo',
    orientation: 'landscape',
    aspectRatioId: '16:9',
    targetDurationSec: 30,
    templates: TEMPLATES,
    hasExistingMaterials: false,
    stockAvailable: false,
    imageGenAvailable: false,
  });
  assert.ok(p.includes('剪辑猫'));
  assert.ok(p.includes('你是商业宣传片编导。'));
  assert.ok(p.includes('钩子→展开→佐证→收尾/CTA'));
  assert.ok(p.includes('30s'));
  assert.ok(p.includes('BrandIntro'));
  assert.ok(p.includes('【零素材可用】'));
  assert.ok(p.includes('【需 1-3 条素材】'));
  assert.ok(p.includes('只能用【零素材可用】模板'));
  assert.ok(p.includes('"features"'));
});
check('体裁化：vlog 换编导人设与叙事结构，长素材预告挖矿承载段', () => {
  const p = buildStoryboardGenPrompt({
    brief: '把青海湖自驾的 40 分钟素材剪成 vlog',
    videoType: 'vlog',
    orientation: 'portrait',
    aspectRatioId: '9:16',
    targetDurationSec: 45,
    templates: TEMPLATES,
    hasExistingMaterials: true,
    stockAvailable: false,
    imageGenAvailable: false,
    miningPlannedSec: 2400,
  });
  assert.ok(p.includes('你是生活 vlog 编导。'));
  assert.ok(p.includes('钩子前置'));
  assert.ok(p.includes('第一人称'));
  assert.ok(!p.includes('商业宣传片编导'));
  assert.ok(p.includes('长素材策略'));
  assert.ok(p.includes('2400s'));
  assert.ok(p.includes('VideoCut'));
  // 无长素材时不出挖矿预告
  const p2 = buildStoryboardGenPrompt({
    brief: 'x', videoType: 'vlog', orientation: 'portrait', aspectRatioId: '9:16',
    targetDurationSec: 30, templates: TEMPLATES, hasExistingMaterials: true,
    stockAvailable: false, imageGenAvailable: false,
  });
  assert.ok(!p2.includes('长素材策略'));
});
check('解析正常输出 / 围栏 / 剔除无 templateId 项', () => {
  const good = parseStoryboardGen('[{"templateId":"KineticType","duration":4,"text":{"title":"快"}}]');
  assert.ok(good.ok);
  assert.equal((good as {segments: unknown[]}).segments.length, 1);
  const fenced = parseStoryboardGen('```json\n[{"templateId":"BrandIntro","duration":2}]\n```');
  assert.ok(fenced.ok);
  const mixed = parseStoryboardGen('[{"templateId":"KineticType"},{"foo":1},2]');
  assert.ok(mixed.ok);
  assert.equal((mixed as {segments: unknown[]}).segments.length, 1);
});
check('坏输出明确报错', () => {
  assert.ok(!parseStoryboardGen('不会').ok);
  assert.ok(!parseStoryboardGen('[]').ok);
  assert.ok(!parseStoryboardGen('[{"noTemplate":1}]').ok);
});

console.log('buildMaterialsPlanPrompt / parseMaterialsPlan:');
check('提示词含片段/已有素材/可用源；existing-only 时不出 stock 选项', () => {
  const p = buildMaterialsPlanPrompt({
    videoType: 'promo',
    segments: [{index: 1, templateId: 'FeatureShowcase', minVideos: 1, title: 'AI 自动剪辑'}],
    existing: [{name: 'demo.mp4', path: 'C:\\v\\demo.mp4', durationSec: 12, tag: '界面录屏'}],
    stockAvailable: true,
    imageGenAvailable: true,
    strategy: 'auto',
  });
  assert.ok(p.includes('你是宣传片执行制片。'));
  assert.ok(p.includes('第 1 段'));
  assert.ok(p.includes('demo.mp4'));
  assert.ok(p.includes('动作单元'));
  assert.ok(p.includes('全局顺序'));
  assert.ok(p.includes('stock'));
  assert.ok(!p.includes('长素材'));
  const p2 = buildMaterialsPlanPrompt({
    videoType: 'promo', segments: [], existing: [], stockAvailable: true, imageGenAvailable: true, strategy: 'existing-only',
  });
  assert.ok(!p2.includes('stock（免费商用素材搜索'));
});
check('体裁化：vlog + 长素材时制片换人设并约束长素材只进一段', () => {
  const p = buildMaterialsPlanPrompt({
    videoType: 'vlog',
    segments: [{index: 0, templateId: 'VideoCut', minVideos: 1, title: '高光主体'}],
    existing: [{name: 'road.mp4', path: 'C:\\v\\road.mp4', durationSec: 2400}],
    stockAvailable: false,
    imageGenAvailable: false,
    strategy: 'auto',
  });
  assert.ok(p.includes('你是vlog 执行制片。'));
  assert.ok(p.includes('长素材只分配到 1 个段'));
  // 挖矿体裁（口播/教程）同样给约束；非挖矿体裁（混剪）不给
  const pTalking = buildMaterialsPlanPrompt({
    videoType: 'talkingHead', segments: [],
    existing: [{name: 'talk.mp4', path: 'C:\\v\\talk.mp4', durationSec: 1800}],
    stockAvailable: false, imageGenAvailable: false, strategy: 'auto',
  });
  assert.ok(pTalking.includes('长素材只分配到 1 个段'));
  const pMontage = buildMaterialsPlanPrompt({
    videoType: 'montage', segments: [],
    existing: [{name: 'a.mp4', path: 'C:\\a.mp4', durationSec: 1800}],
    stockAvailable: false, imageGenAvailable: false, strategy: 'auto',
  });
  assert.ok(!pMontage.includes('长素材只分配到 1 个段'));
  // vlog 但无长素材：不出约束
  const p2 = buildMaterialsPlanPrompt({
    videoType: 'vlog',
    segments: [], existing: [{name: 'a.mp4', path: 'C:\\a.mp4', durationSec: 12}],
    stockAvailable: false, imageGenAvailable: false, strategy: 'auto',
  });
  assert.ok(!p2.includes('长素材只分配到 1 个段'));
});
check('isPipelineMiningGenre：vlog/口播/教程走自动挖矿，promo/混剪不走', () => {
  assert.ok(isPipelineMiningGenre('vlog'));
  assert.ok(isPipelineMiningGenre('talkingHead'));
  assert.ok(isPipelineMiningGenre('tutorial'));
  assert.ok(!isPipelineMiningGenre('promo'));
  assert.ok(!isPipelineMiningGenre('montage'));
});
check('解析 assignments + bgm / 非法项剔除 / 空数组报错', () => {
  const plan = parseMaterialsPlan('{"assignments":[{"index":0,"source":"stock","stockQuery":"city night","stockType":"photo"},{"index":1,"source":"bogus"},{"index":2,"source":"existing","existingPath":"C:\\\\a.mp4"}],"bgm":{"wantMood":"epic","wantEnergy":"high"}}');
  assert.ok(plan.ok);
  const p = (plan as {plan: {assignments: Array<{source: string; index: number}>; bgm?: {wantMood?: string}}}).plan;
  assert.equal(p.assignments.length, 2);
  assert.equal(p.assignments[0].source, 'stock');
  assert.equal(p.bgm?.wantMood, 'epic');
  assert.ok(!parseMaterialsPlan('{"assignments":[]}').ok);
  assert.ok(!parseMaterialsPlan('没 JSON').ok);
});
check('解析动作单元与时间窗，并钳制非法区间', () => {
  const plan = parseMaterialsPlan(
    '{"assignments":[{"index":0,"source":"existing","existingPath":"C:\\\\demo.mp4","storyUnitIndex":4,"sourceStartSec":-2,"sourceEndSec":99,"continuityRole":"action"}]}',
    {segmentCount: 1, existing: [{name: 'demo.mp4', path: 'C:\\demo.mp4', durationSec: 10, storyUnits: [
      {startSec: 0, endSec: 4, subject: '', before: '', action: '做事', after: '', roles: ['action']},
    ]}]},
  );
  assert.ok(plan.ok);
  const a = (plan as {plan: {assignments: Array<{storyUnitIndex?: number; sourceStartSec?: number; sourceEndSec?: number; continuityRole?: string}>}}).plan.assignments[0];
  assert.equal(a.storyUnitIndex, undefined);
  assert.equal(a.sourceStartSec, 0);
  assert.equal(a.sourceEndSec, 10);
  assert.equal(a.continuityRole, 'action');
});

console.log('buildAutoFixPrompt / parseAutoFix:');
check('提示词含问题清单与当前故事板；解析补丁字段映射', () => {
  const p = buildAutoFixPrompt({
    videoType: 'promo',
    overall: 3, verdict: 'revise',
    issues: [{segmentIndex: 1, severity: 'high', problem: '标题被裁切', suggestion: '缩短标题'}],
    segments: [{index: 1, templateId: 'FeatureShowcase', title: '超长标题超长标题超长', subtitle: 'x', features: ['a', 'b']}],
  });
  assert.ok(p.includes('你是宣传片剪辑指导。'));
  assert.ok(p.includes('第 1 段'));
  assert.ok(p.includes('标题被裁切'));
  assert.ok(p.includes('超长标题'));
  const fix = parseAutoFix('[{"index":1,"title":"短标题","features":["新要点"],"templateId":"KineticType"}]');
  assert.ok(fix.ok);
  const patches = (fix as {patches: Array<{title?: string; features?: string[]; templateId?: string}>}).patches;
  assert.equal(patches[0].title, '短标题');
  assert.equal(patches[0].templateId, 'KineticType');
  assert.deepEqual(patches[0].features, ['新要点']);
  assert.ok(!parseAutoFix('[]').ok);
  assert.ok(!parseAutoFix('没有数组').ok);
  const vlogFix = buildAutoFixPrompt({
    videoType: 'vlog', overall: 3, verdict: 'revise', issues: [], segments: [],
  });
  assert.ok(vlogFix.includes('你是vlog 剪辑指导。'));
});

console.log('buildMetadataPrompt / parseMetadataGen:');
check('提示词含需求与各段文案；解析 + 缺 title 报错', () => {
  const p = buildMetadataPrompt({videoType: 'promo', brief: '剪辑猫', segments: [{title: 'AI 自动剪辑', subtitle: '三步出片'}]});
  assert.ok(p.includes('剪辑猫'));
  assert.ok(p.includes('AI 自动剪辑'));
  assert.ok(p.includes('「产品宣传片」'));
  assert.ok(p.includes('行动召唤'));
  const meta = parseMetadataGen('{"title":"剪辑猫：废片自动剪","description":"三步出片。","tags":["剪辑","AI"]}');
  assert.ok(meta.ok);
  assert.equal((meta as {meta: {title: string}}).meta.title, '剪辑猫：废片自动剪');
  assert.ok(!parseMetadataGen('{"description":"无标题"}').ok);
});
check('体裁化：vlog 元数据提示词给第一人称口径', () => {
  const p = buildMetadataPrompt({videoType: 'vlog', brief: '青海湖自驾', segments: []});
  assert.ok(p.includes('「生活 vlog / 素材混剪」'));
  assert.ok(p.includes('第一人称'));
});

console.log('parseMediaTagResponse（素材打标）:');
check('正常 / 围栏 / 缺 description 返回 null', () => {
  const tag = parseMediaTagResponse('{"description":"城市夜景航拍，车流光轨","mood":"现代科技","scene":"产品发布","note":"构图稳定"}');
  assert.equal(tag?.description, '城市夜景航拍，车流光轨');
  assert.equal(tag?.note, '构图稳定');
  assert.equal(parseMediaTagResponse('```json\n{"description":"会议室白板","mood":"商务","scene":"企业宣传"}\n```')?.scene, '企业宣传');
  assert.equal(parseMediaTagResponse('{"mood":"x"}'), null);
  assert.equal(parseMediaTagResponse('坏输出'), null);
  assert.ok(buildMediaTagPrompt('素材 x 的画面：').includes('严格输出 JSON'));
});

check('时间动作单元清洗角色、钳制时长，并提供给排片的过程摘要', () => {
  const tag = parseMediaTagResponse(JSON.stringify({
    description: '手指在应用中提交表单并看到成功状态',
    mood: '清晰专业',
    scene: '产品演示',
    temporalSummary: '填写表单 → 点击提交 → 显示成功提示',
    storyUnits: [
      {startSec: -3, endSec: 99, subject: '提交按钮', before: '表单已填写', action: '点击提交并显示成功提示', after: '提交完成', roles: ['setup', 'action', 'invalid', 'action']},
      {startSec: 3, endSec: 3.01, subject: '无效区间', action: '不应保留', roles: ['result']},
    ],
  }), {durationSec: 6});
  assert.deepEqual(tag?.storyUnits, [{
    startSec: 0, endSec: 6, subject: '提交按钮', before: '表单已填写', action: '点击提交并显示成功提示', after: '提交完成', roles: ['setup', 'action'],
  }]);
  assert.equal(mediaTagStorySummary(tag), '填写表单 → 点击提交 → 显示成功提示');
  assert.equal(mediaTagStorySummary({description: '产品旋转展示', mood: '', scene: '', storyUnits: [
    {startSec: 0, endSec: 2.5, subject: '产品', before: '', action: '旋转展示', after: '', roles: ['reveal']},
  ]}), '0.0-2.5s 旋转展示');
});

console.log('PIPELINE_STEPS:');
check('九步齐全且 key 唯一（含 vlog 高光挖掘步与 montage 卡点混剪步）', () => {
  assert.equal(PIPELINE_STEPS.length, 9);
  assert.equal(new Set(PIPELINE_STEPS.map((s) => s.key)).size, 9);
  assert.ok(PIPELINE_STEPS.some((s) => s.key === 'mining'));
  assert.ok(PIPELINE_STEPS.some((s) => s.key === 'montage'));
  // 挖矿步在配素材之后、卡点混剪步在挖矿之后、两者都在旁白之前（浓缩/重切影响段时长与旁白对齐）
  const keys = PIPELINE_STEPS.map((s) => s.key);
  assert.ok(keys.indexOf('mining') > keys.indexOf('materials') && keys.indexOf('mining') < keys.indexOf('montage'));
  assert.ok(keys.indexOf('montage') > keys.indexOf('mining') && keys.indexOf('montage') < keys.indexOf('audio'));
});

console.log('大纲阶段（buildOutlinePrompt / parseOutline）:');
check('提示词含需求/体裁人设/时长/结构要求；解析正常输出与钳制', () => {
  const p = buildOutlinePrompt({brief: '剪辑猫宣传片', videoType: 'promo', targetDurationSec: 30, orientation: 'landscape'});
  assert.ok(p.includes('你是商业宣传片编导。'));
  assert.ok(p.includes('剪辑猫'));
  assert.ok(p.includes('30s'));
  assert.ok(p.includes('钩子→展开→佐证→收尾/CTA'));
  assert.ok(p.includes('第一拍必须是'));
  const o = parseOutline('[{"role":"钩子","message":"3秒立住痛点","mood":"快、悬念","approxSec":5},{"role":"展开","message":"展示三大功能","approxSec":999},{"bad":1}]');
  assert.ok(o.ok);
  const beats = (o as {beats: Array<{role: string; message: string; approxSec?: number}>}).beats;
  assert.equal(beats.length, 2);
  assert.equal(beats[0].role, '钩子');
  assert.equal(beats[1].approxSec, 60); // 钳到 60 上限
  assert.ok(!parseOutline('[]').ok);
  assert.ok(!parseOutline('没有 JSON').ok);
  assert.ok(!parseOutline('[{"message":"缺 role"}]').ok);
});
check('formatOutlineBeats 行含拍序/职责/秒数/情绪/信息', () => {
  const lines = formatOutlineBeats([{role: '钩子', message: '痛点', mood: '快', approxSec: 5}]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('第1拍【钩子】'));
  assert.ok(lines[0].includes('约5s'));
  assert.ok(lines[0].includes('痛点'));
});

console.log('三阶段分镜（outlineBeats 注入 + paramsBrief）:');
check('有大纲时分镜提示词逐拍落实并带参数简报；无大纲保持原结构', () => {
  const templates = TEMPLATES.map((t) => ({...t, paramsBrief: t.id === 'KineticType' ? 'direction(0-4默认0)' : undefined}));
  const p = buildStoryboardGenPrompt({
    brief: '剪辑猫', videoType: 'promo', orientation: 'landscape', aspectRatioId: '16:9',
    targetDurationSec: 30, templates, hasExistingMaterials: false, stockAvailable: false, imageGenAvailable: false,
    outlineBeats: [{role: '钩子', message: '废片太多剪不动', approxSec: 4}],
  });
  assert.ok(p.includes('按已定大纲规划故事板分镜'));
  assert.ok(p.includes('第1拍【钩子】'));
  assert.ok(p.includes('废片太多剪不动'));
  assert.ok(p.includes('严格按大纲拍序与职责分段'));
  assert.ok(p.includes('参数: direction(0-4默认0)'));
  assert.ok(p.includes('customParams'));
  // 无大纲：保持旧结构断言锚点
  const p2 = buildStoryboardGenPrompt({
    brief: '剪辑猫', videoType: 'promo', orientation: 'landscape', aspectRatioId: '16:9',
    targetDurationSec: 30, templates: TEMPLATES, hasExistingMaterials: false, stockAvailable: false, imageGenAvailable: false,
  });
  assert.ok(p2.includes('根据需求写脚本并规划故事板'));
  assert.ok(p2.includes('钩子→展开→佐证→收尾/CTA'));
  assert.ok(!p2.includes('按已定大纲'));
});
check('paramsBriefOf：压缩 paramSpecs、空返回 undefined、最多 6 个', () => {
  assert.equal(paramsBriefOf(undefined), undefined);
  assert.equal(paramsBriefOf([]), undefined);
  assert.equal(paramsBriefOf([{key: 'zoom', min: 1, max: 3, default: 1.5}]), 'zoom(1-3默认1.5)');
  const many = Array.from({length: 9}, (_, i) => ({key: `p${i}`, min: 0, max: 1, default: 0}));
  assert.equal(paramsBriefOf(many)!.split(' ').length, 6);
});

console.log('文案润色（buildPolishPrompt / parsePolish / applyPolishPatches）:');
check('提示词含分镜与硬约束；解析补丁；合并只动指定字段', () => {
  const p = buildPolishPrompt({
    videoType: 'promo',
    segments: [{index: 0, templateId: 'KineticType', title: '很强', narration: '我们很强'}],
  });
  assert.ok(p.includes('你是宣传片剪辑指导。'));
  assert.ok(p.includes('很强'));
  assert.ok(p.includes('≤14 字'));
  const parsed = parsePolish('[{"index":0,"title":"废片一键成片","narration":"拍了一堆素材不想剪？交给它。"},{"index":1}]');
  assert.ok(parsed.ok);
  const patches = (parsed as {patches: Array<{index: number; title?: string; narration?: string}>}).patches;
  assert.equal(patches.length, 2);
  assert.equal(patches[0].title, '废片一键成片');
  const merged = applyPolishPatches(
    [{templateId: 'KineticType', duration: 4, text: {title: '很强', subtitle: '保持'}, narration: {text: '我们很强'}}],
    patches,
  );
  const t0 = merged[0].text as {title: string; subtitle: string};
  const n0 = merged[0].narration as {text: string};
  assert.equal(t0.title, '废片一键成片');
  assert.equal(t0.subtitle, '保持'); // 未给的字段不动
  assert.equal(n0.text, '拍了一堆素材不想剪？交给它。');
  assert.equal(merged[0].duration, 4); // 非文案字段不动
  assert.ok(!parsePolish('[]').ok);
});

console.log('autofix 画面层扩展（lint/audio/时长/参数/转场）:');
check('提示词分区含画面/lint/音频问题与可调参数；解析新字段与钳制', () => {
  const p = buildAutoFixPrompt({
    videoType: 'promo', overall: 3, verdict: 'revise',
    issues: [{segmentIndex: 0, severity: 'high', problem: '色调不统一', suggestion: '换模板'}],
    lintIssues: [{segmentIndex: 1, severity: 'warn', problem: '第 2 段可见文字约 40 字需 3.5s', suggestion: '延长到 ≥3.5s'}],
    audioIssues: ['12s-15s 存在 3s 静音段'],
    segments: [{index: 0, templateId: 'StackCards', title: '功能', duration: 6, paramsBrief: 'direction(0-4默认0)'}],
  });
  assert.ok(p.includes('画面问题清单'));
  assert.ok(p.includes('本地可读性体检'));
  assert.ok(p.includes('音频问题'));
  assert.ok(p.includes('静音段'));
  assert.ok(p.includes('可调参数: direction(0-4默认0)'));
  assert.ok(p.includes('durationSec'));
  assert.ok(p.includes('transitionType'));
  // 无 lint/audio 时不出分区
  const p2 = buildAutoFixPrompt({videoType: 'promo', overall: 3, verdict: 'revise', issues: [], segments: []});
  assert.ok(!p2.includes('本地可读性体检'));
  assert.ok(!p2.includes('音频问题'));
  const fix = parseAutoFix('[{"index":0,"durationSec":999,"customParams":{"direction":3,"bad":"x"},"transitionType":"slide","transitionParams":{"durationSec":9,"direction":7}},{"index":1,"transitionType":"bogus"}]');
  assert.ok(fix.ok);
  const patches = (fix as {patches: Array<{durationSec?: number; customParams?: Record<string, number>; transitionType?: string; transitionParams?: {durationSec?: number; direction?: number}}>}).patches;
  assert.equal(patches[0].durationSec, 60); // 钳上限
  assert.deepEqual(patches[0].customParams, {direction: 3}); // 非数值键剔除
  assert.equal(patches[0].transitionType, 'slide');
  assert.equal(patches[0].transitionParams?.durationSec, 2); // 钳 0.2-2
  assert.equal(patches[0].transitionParams?.direction, 4); // 钳 0-4
  assert.equal(patches[1].transitionType, undefined); // 非法转场类型拒收
});

console.log('PIPELINE_STEPS 标签:');
check('故事板步标注三阶段链路', () => {
  assert.ok(PIPELINE_STEPS.find((s) => s.key === 'storyboard')?.label.includes('大纲→分镜→润色'));
});

console.log('buildPipelinePlanText（可编辑计划层）:');
check('计划文本含体裁头/逐段摘要/合计时长/素材策略/执行指引', () => {
  const text = buildPipelinePlanText({
    videoType: 'vlog',
    segments: [
      {templateId: 'VlogStamp', duration: 3, text: {title: 'DAY 1', subtitle: '青海湖 · 二郎剑'}, narration: {text: '出发去青海湖，四十分钟的素材剪成四十秒'}},
      {templateId: 'VideoCut', duration: 30, text: {title: '环湖公路'}},
    ],
    templateNames: {VlogStamp: '日期打卡', VideoCut: '全屏视频快切', KineticType: '节拍大字'},
    targetDurationSec: 45,
    narration: true,
    materials: 'auto',
    miningPlannedSec: 2400,
    hasExistingMaterials: true,
    stockAvailable: false,
    imageGenAvailable: false,
  });
  assert.ok(text.includes('【成片计划 · 生活 vlog / 素材混剪】'));
  assert.ok(text.includes('合计 33s'));
  assert.ok(text.includes('1. 日期打卡 3s「DAY 1」｜青海湖 · 二郎剑'));
  assert.ok(text.includes('旁白：出发去青海湖'));
  assert.ok(text.includes('2. 全屏视频快切 30s「环湖公路」'));
  assert.ok(text.includes('高光挖掘：检测到最长素材约 2400s'));
  assert.ok(text.includes('run_auto_pipeline(segments='));
  // 未知模板 id 裸显；无长素材不出挖矿行
  const text2 = buildPipelinePlanText({
    videoType: 'promo', segments: [{templateId: 'Nope'}], templateNames: {},
    targetDurationSec: 30, narration: false, materials: 'auto',
    hasExistingMaterials: false, stockAvailable: false, imageGenAvailable: false,
  });
  assert.ok(text2.includes('1. Nope'));
  assert.ok(!text2.includes('高光挖掘'));
  assert.ok(text2.includes('不加旁白'));
});

console.log('新工具参数校验器:');
check('run_auto_pipeline：合法 / 越界值拒绝', () => {
  assert.ok(validateRunPipelineArgs({brief: '做一条 AI 剪辑软件宣传片'}).ok);
  assert.ok(validateRunPipelineArgs({brief: 'x', targetDurationSec: 45, reviewRounds: 2, materials: 'stock-first', narration: false}).ok);
  assert.ok(!validateRunPipelineArgs({}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', targetDurationSec: 5}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', reviewRounds: 3}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', materials: 'nope'}).ok);
});
check('run_auto_pipeline 计划层：plan_only / segments 校验与互斥', () => {
  const segs = [{templateId: 'KineticType', duration: 4, text: {title: '快'}}];
  assert.ok(validateRunPipelineArgs({brief: 'x', planOnly: true}).ok);
  assert.ok(validateRunPipelineArgs({brief: 'x', segments: segs}).ok);
  // 互斥 + 类型错误 + 缺 templateId + 空数组 + 超 12 段
  assert.ok(!validateRunPipelineArgs({brief: 'x', planOnly: true, segments: segs}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', planOnly: 'yes'}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', segments: [{duration: 4}]}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', segments: []}).ok);
  assert.ok(validateRunPipelineArgs({brief: 'x', segments: Array.from({length: 13}, () => ({templateId: 'a'}))}).ok);
  assert.ok(!validateRunPipelineArgs({brief: 'x', segments: Array.from({length: 61}, () => ({templateId: 'a'}))}).ok);
});
check('search/generate/bgm/analyze 组合校验', () => {
  assert.ok(validateSearchStockArgs({query: 'city night', type: 'photo', orientation: 'portrait', perPage: 10}).ok);
  assert.ok(!validateSearchStockArgs({query: ''}).ok);
  assert.ok(!validateSearchStockArgs({query: 'x', perPage: 99}).ok);
  assert.ok(validateGenerateImageArgs({prompt: 'cinematic city', index: 0, size: '1024x1792'}).ok);
  assert.ok(!validateGenerateImageArgs({prompt: 'x', size: 'abc'}).ok);
  assert.ok(validateSetBgmArgs({track: 'epic', volume: 0.4}).ok);
  assert.ok(validateSetBgmArgs({wantMood: 'calm', wantEnergy: 'low'}).ok);
  assert.ok(!validateSetBgmArgs({volume: 2}).ok);
  assert.ok(!validateSetBgmArgs({wantMood: 'happy'}).ok);
  assert.ok(validateAnalyzeAudioArgs({path: 'D:\\out\\a.mp4', checkTranscript: false}).ok);
  assert.ok(!validateAnalyzeAudioArgs({path: ''}).ok);
});

console.log(failed === 0 ? `\n全部通过（${passed} 组断言）` : `\n${failed} 组失败`);
process.exit(failed === 0 ? 0 : 1);
