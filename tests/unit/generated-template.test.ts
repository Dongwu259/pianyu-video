/**
 * AI 生成模板（三期 D2）单测：静态扫描黑名单、参数校验、结构校验、esbuild 编译冒烟、实例化。
 * 运行：node server/node_modules/tsx/dist/cli.mjs tests/unit/generated-template.test.ts
 */
import assert from 'node:assert/strict';
// 必须在 instantiate.ts 之前求值：stub 掉 ThreeText 的 .ttf 字体 import（node 无法编译二进制资源）
import './asset-stub.cjs';
import {
  GENERATED_SOURCE_MAX,
  findGeneratedDef,
  generatedTemplateToMeta,
  isGeneratedTemplateId,
  scanGeneratedSource,
  validateGeneratedTemplateDef,
  type GeneratedTemplateDef,
} from '../../src/shared/generated-template.ts';
import {validateGenerateTemplateArgs} from '../../src/shared/llm-tools.ts';
import {compileGeneratedSource} from '../../src/main/services/templateGenCompile.ts';
import {instantiateGenerated} from '../../src/remotion/generated/instantiate.ts';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); process.exitCode = 1; }
};

/** 合法样例：用到注入全局 + CSS top 属性（黑名单回归：top: 不得误伤） */
const CLEAN_SOURCE = `
const GeneratedTemplate = (props) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const enter = spring({frame, fps, config: SPRINGS.smooth});
  const items = props.text.features.map((f, i) => (
    <div key={i} style={{top: 100 + i * 60, position: 'absolute', color: '#fff'}}>{f}</div>
  ));
  return (
    <AbsoluteFill style={{background: '#0b1020', justifyContent: 'center', alignItems: 'center'}}>
      <AnimatedText text={props.text.title} preset="charPop"
        style={{fontSize: VIDEO_DESIGN.fontSize.title, color: '#fff', opacity: enter}} />
      {items}
    </AbsoluteFill>
  );
};
`;

const goodDef = (): GeneratedTemplateDef => ({
  id: 'gen-abc123',
  name: '测试模板',
  description: '单测用',
  source: CLEAN_SOURCE,
  compiled: 'const x = 1;',
  duration: 8,
  createdAt: 1,
  updatedAt: 2,
});

/** 合法 3D 样例：ThreeStage 唯一包裹 + totalFrames 由 fps×segmentDuration 算出 + 动画全帧驱动 */
const THREE_SOURCE = `
const GeneratedTemplate = (props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const totalFrames = Math.round(props.segmentDuration * fps);
  const model = (props.videos || []).find((v) => v.type === 'model');
  const fade = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{background: '#0b1020', opacity: fade}}>
      <ThreeStage rig="orbit" rigSpeed={1} totalFrames={totalFrames} ambience={2}>
        <ThreeText text={props.text.title} size={1.1} position={[0, 1.4, 0]} startFrame={6} />
        {model ? <TurntableModel src={model.src} size={2.6} periodSec={8} /> : null}
      </ThreeStage>
    </AbsoluteFill>
  );
};
`;

/** 3D 注入探针：顶层引用全部 7 个 3D 原语——任何一个没进注入作用域都会在工厂执行时抛错 → null */
const THREE_SCOPE_PROBE = `
const probe = [ThreeStage, ThreeAmbience, TurntableModel, ThreeText, PhoneShell, LaptopShell, DEVICE_SCREEN];
if (probe.some((x) => x === undefined || x === null)) { throw new Error('3D 原语未注入'); }
const GeneratedTemplate = () => <div>{probe.length}</div>;
`;

console.log('generated-template 单元测试');

// ====== 静态扫描 ======
t('扫描：合法源码通过（含 CSS top 属性不误伤）', () => {
  const r = scanGeneratedSource(CLEAN_SOURCE);
  assert.equal(r.ok, true, r.errors.join('；'));
});

t('扫描：空源码/缺 GeneratedTemplate 拒绝', () => {
  assert.equal(scanGeneratedSource('').ok, false);
  const r = scanGeneratedSource('const Foo = () => <div/>;');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('GeneratedTemplate')));
});

t('扫描：超长源码拒绝', () => {
  const big = `const GeneratedTemplate = () => <div>${'a'.repeat(GENERATED_SOURCE_MAX)}</div>;`;
  const r = scanGeneratedSource(big);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('超上限')));
});

t('扫描：模块语法（import/export/require）拒绝', () => {
  for (const src of [
    `import {foo} from './x';\nconst GeneratedTemplate = () => <div/>;`,
    `export const GeneratedTemplate = () => <div/>;`,
    `const GeneratedTemplate = () => <div/>;\nconst x = require('fs');`,
  ]) {
    const r = scanGeneratedSource(src);
    assert.equal(r.ok, false, src);
    assert.ok(r.errors.some((e) => e.includes('模块语法')), src);
  }
});

t('扫描：网络/存储/DOM/Node 拒绝', () => {
  const cases: [string, string][] = [
    ['const GeneratedTemplate = () => { fetch("/api"); return <div/>; };', '网络'],
    ['const GeneratedTemplate = () => { const s = new WebSocket("ws://x"); return <div/>; };', '网络'],
    ['const GeneratedTemplate = () => { localStorage.setItem("a","b"); return <div/>; };', '存储'],
    ['const GeneratedTemplate = () => { document.title = "x"; return <div/>; };', 'DOM'],
    ['const GeneratedTemplate = () => { window.location = "x"; return <div/>; };', 'DOM'],
    ['const GeneratedTemplate = () => { process.exit(0); return <div/>; };', 'Node'],
  ];
  for (const [src, label] of cases) {
    const r = scanGeneratedSource(src);
    assert.equal(r.ok, false, src);
    assert.ok(r.errors.some((e) => e.includes(label)), `${label}: ${r.errors.join('；')}`);
  }
});

t('扫描：异步/非确定性/无界循环/二次求值拒绝', () => {
  const cases: [string, string][] = [
    ['const GeneratedTemplate = async () => <div/>;', '异步'],
    ['const GeneratedTemplate = () => { setTimeout(() => {}, 100); return <div/>; };', '计时器'],
    ['const GeneratedTemplate = () => { const p = new Promise(() => {}); return <div/>; };', '异步'],
    ['const GeneratedTemplate = () => { const r = Math.random(); return <div/>; };', '非确定'],
    ['const GeneratedTemplate = () => { const d = new Date(); return <div/>; };', '非确定'],
    ['const GeneratedTemplate = () => { while (true) {} return <div/>; };', '无界循环'],
    ['const GeneratedTemplate = () => { for (;;) {} return <div/>; };', '无界循环'],
    ['const GeneratedTemplate = () => { return eval("<div/>"); };', '二次求值'],
    ['const GeneratedTemplate = new Function("return () => null");', '二次求值'],
  ];
  for (const [src, label] of cases) {
    const r = scanGeneratedSource(src);
    assert.equal(r.ok, false, src);
    assert.ok(r.errors.some((e) => e.includes(label)), `${label}: ${r.errors.join('；')}`);
  }
});

// ====== 3D 原语注入（three.js 组件开放给生成模板）======
t('扫描：3D 合规源码（ThreeStage/ThreeText/TurntableModel）通过', () => {
  const r = scanGeneratedSource(THREE_SOURCE);
  assert.equal(r.ok, true, r.errors.join('；'));
  const r2 = scanGeneratedSource(THREE_SCOPE_PROBE);
  assert.equal(r2.ok, true, r2.errors.join('；'));
});

t('扫描：Math.random/Date 驱动 3D 动画仍被黑名单拦下', () => {
  const cases: [string, string][] = [
    [
      'const GeneratedTemplate = (props) => { const seed = Math.random(); return (<AbsoluteFill><ThreeStage totalFrames={30}><ThreeText text={"x" + seed} /></ThreeStage></AbsoluteFill>); };',
      '非确定',
    ],
    [
      'const GeneratedTemplate = (props) => { const t = new Date().getTime(); return (<AbsoluteFill><ThreeStage totalFrames={30}><TurntableModel src={String(t)} /></ThreeStage></AbsoluteFill>); };',
      '非确定',
    ],
  ];
  for (const [src, label] of cases) {
    const r = scanGeneratedSource(src);
    assert.equal(r.ok, false, src);
    assert.ok(r.errors.some((e) => e.includes(label)), `${label}: ${r.errors.join('；')}`);
  }
});

// ====== 结构校验（持久化准入）======
t('结构校验：合法 def 通过 + meta 转换 + 查找', () => {
  const def = goodDef();
  assert.deepEqual(validateGeneratedTemplateDef(def), []);
  const meta = generatedTemplateToMeta(def);
  assert.equal(meta.id, def.id);
  assert.ok(meta.name.startsWith('🤖'));
  assert.equal(meta.defaultDuration, 8);
  assert.equal(isGeneratedTemplateId(def.id), true);
  assert.equal(isGeneratedTemplateId('RevealSlide'), false);
  assert.equal(findGeneratedDef(def.id, [def])?.id, def.id);
  assert.equal(findGeneratedDef('gen-nope', [def]), undefined);
});

t('结构校验：坏 id/坏时长/坏 paramSpecs 拒绝', () => {
  assert.ok(validateGeneratedTemplateDef({...goodDef(), id: 'custom-x'}).some((e) => e.includes('gen-')));
  assert.ok(validateGeneratedTemplateDef({...goodDef(), duration: 0}).some((e) => e.includes('时长')));
  assert.ok(validateGeneratedTemplateDef({...goodDef(), duration: 61}).some((e) => e.includes('时长')));
  assert.ok(
    validateGeneratedTemplateDef({...goodDef(), paramSpecs: [{key: 'a', label: 'A', min: 1, max: 0, step: 1, default: 1}]})
      .some((e) => e.includes('结构非法')),
  );
  assert.ok(
    validateGeneratedTemplateDef({
      ...goodDef(),
      paramSpecs: [
        {key: 'a', label: 'A', min: 0, max: 1, step: 1, default: 0},
        {key: 'a', label: 'B', min: 0, max: 1, step: 1, default: 0},
      ],
    }).some((e) => e.includes('重复')),
  );
});

// ====== 工具参数校验 ======
t('参数校验：最小合法 + 默认值', () => {
  const r = validateGenerateTemplateArgs({name: 'X', code: CLEAN_SOURCE});
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.defaultDuration, 8);
    assert.equal(r.args.description, '');
    assert.equal(r.args.templateId, undefined);
  }
});

t('参数校验：完整参数（含 paramSpecs/templateId）', () => {
  const r = validateGenerateTemplateArgs({
    name: 'X', description: 'd', code: CLEAN_SOURCE, defaultDuration: 5.5,
    templateId: 'gen-abc',
    paramSpecs: [{key: 'speed', label: '速度', min: 0.5, max: 2, step: 0.1, default: 1}],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.args.defaultDuration, 5.5);
    assert.equal(r.args.templateId, 'gen-abc');
    assert.equal(r.args.paramSpecs?.length, 1);
  }
});

t('参数校验：坏 name/code/duration/templateId/paramSpecs 拒绝', () => {
  assert.equal(validateGenerateTemplateArgs({code: CLEAN_SOURCE}).ok, false); // 缺 name
  assert.equal(validateGenerateTemplateArgs({name: 'X'}).ok, false); // 缺 code
  assert.equal(validateGenerateTemplateArgs({name: 'X', code: CLEAN_SOURCE, defaultDuration: 0}).ok, false);
  assert.equal(validateGenerateTemplateArgs({name: 'X', code: CLEAN_SOURCE, templateId: 'custom-x'}).ok, false);
  assert.equal(
    validateGenerateTemplateArgs({name: 'X', code: CLEAN_SOURCE, paramSpecs: [{key: 'a', label: '', min: 0, max: 1, step: 1, default: 0}]}).ok,
    false,
  );
});

// ====== esbuild 编译冒烟 ======
t('编译：合法源码 → React.createElement 产物', () => {
  const r = compileGeneratedSource(CLEAN_SOURCE);
  assert.equal(r.ok, true, r.errors?.join('；'));
  assert.ok(r.code!.includes('React.createElement'));
  assert.ok(!r.code!.includes('import'));
});

t('编译：语法错误 → 带位置信息的错误', () => {
  const r = compileGeneratedSource('const GeneratedTemplate = () => <div>;');
  assert.equal(r.ok, false);
  assert.ok(r.errors!.some((e) => e.includes('编译失败')));
});

// ====== 实例化冒烟（new Function 白名单作用域）======
t('实例化：编译产物 → 组件函数；缺 GeneratedTemplate → null', () => {
  const r = compileGeneratedSource(CLEAN_SOURCE);
  assert.equal(r.ok, true);
  const comp = instantiateGenerated(r.code!);
  assert.equal(typeof comp, 'function');
  // 无组件定义的产物 → null（不抛错）
  assert.equal(instantiateGenerated('const x = 1;'), null);
});

t('实例化：3D 模板编译实例化成功，且 7 个 3D 原语全部在注入作用域', () => {
  // 合规 3D 源码：编译 → 实例化 → 组件函数
  const r = compileGeneratedSource(THREE_SOURCE);
  assert.equal(r.ok, true, r.errors?.join('；'));
  assert.equal(typeof instantiateGenerated(r.code!), 'function');
  // 探针顶层引用全部 3D 原语：任一未注入会在工厂执行时抛 ReferenceError → null
  const probe = compileGeneratedSource(THREE_SCOPE_PROBE);
  assert.equal(probe.ok, true, probe.errors?.join('；'));
  assert.equal(typeof instantiateGenerated(probe.code!), 'function');
  // 对照：探针引用未注入的标识符 → 实例化返回 null（不抛错）
  assert.equal(instantiateGenerated('const probe = NotInjected3D;\nconst GeneratedTemplate = () => null;'), null);
});

console.log(`\n${passed} 项通过`);
if ((process.exitCode ?? 0) !== 0) process.exit(process.exitCode);
