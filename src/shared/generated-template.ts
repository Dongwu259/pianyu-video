/**
 * AI 生成模板（三期 D2 受约束生成）——共享契约层。
 *
 * LLM 现场写一段「受限 TSX」定义一个 Remotion 组件，主进程 esbuild 编译成 JS 后
 * 随工程模板库分发；渲染/预览时由 remotion/generated/instantiate.ts 以
 * new Function 注入白名单全局（React/remotion 钩子/设计令牌/AnimatedText 原语）
 * 实例化，错误边界 + 回退占位兜底，渲染超时由 Remotion delayRender 既有熔断兜底。
 *
 * 与 .vttemplate（纯 JSON 数据解释）的根本区别：这里是「代码级」表现力——
 * LLM 可以写任意动画逻辑，但源码先经本模块的静态扫描（无网络/存储/DOM/异步/
 * 非确定性 API），编译只在主进程发生，渲染端永远不接触 TS 源码。
 *
 * 持久化：应用级（userData/generated-templates.json），与自定义模板同口径——
 * 不进 .vtproj，跨工程可复用；分享工程到无此模板的机器时该段按未知模板剔除。
 */

import type {TemplateMeta, TemplateParamSpec} from './types';
import {isValidParamSpec, isValidTextSlots} from './custom-template';

// ====== 类型 ======

export interface GeneratedTemplateDef {
  /** gen- 前缀 id（生成一次不变；迭代覆盖时沿用，故事板引用不断） */
  id: string;
  name: string;          // ≤30 字
  description: string;   // ≤200 字
  /** LLM 写的受限 TSX 源码（保留用于审计/重新编译） */
  source: string;
  /** esbuild 编译产物（JS，React.createElement 形态；渲染端只跑这份） */
  compiled: string;
  /** 默认时长（秒，1-60） */
  duration: number;
  /** 可选滑块参数（≤8 个；组件内经 props.params 读取） */
  paramSpecs?: TemplateParamSpec[];
  /** 文字槽位声明：组件实际消费的 props.text 字段（title/subtitle/features/brandName 子集）。
   *  缺省 = 未标注（校验器不发提示）；[] = 显式声明不展示文字。由 generate_template 的 textSlots 参数写入。 */
  textSlots?: string[];
  createdAt: number;
  updatedAt: number;
}

// ====== 常量 ======

export const GENERATED_TEMPLATE_ID_PREFIX = 'gen-';
/** 源码上限（字符）：足够写复杂模板，又能挡住失控输出 */
export const GENERATED_SOURCE_MAX = 24000;
/** 编译产物上限（字符） */
export const GENERATED_COMPILED_MAX = 80000;
/** 模板数量上限（userData 单文件 JSON） */
export const GENERATED_TEMPLATE_MAX_COUNT = 20;
export const GENERATED_NAME_MAX = 30;
export const GENERATED_DESCRIPTION_MAX = 200;
export const GENERATED_PARAM_MAX = 8;

export const isGeneratedTemplateId = (id: string): boolean =>
  id.startsWith(GENERATED_TEMPLATE_ID_PREFIX);

// ====== 静态扫描（LLM 源码准入）======

/**
 * 黑名单规则。原则：渲染必须逐帧确定、纯函数、不接触任何宿主能力。
 * 误伤可接受（报错会把命中 token 回给 LLM 让它改写），漏放不可接受。
 */
const FORBIDDEN_RULES: {pattern: RegExp; label: string}[] = [
  {pattern: /\bimport\b|\bexport\b|\brequire\s*\(/, label: '模块语法 import/export/require（无需导入，全局已注入）'},
  {pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, label: '网络请求'},
  {pattern: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\b|\bnavigator\b|\bhistory\b|\blocation\b/, label: '浏览器存储/环境 API'},
  {pattern: /\bdocument\b|\bwindow\b|\bglobalThis\b|\bself\b/, label: 'DOM/BOM 访问（document/window/globalThis）'},
  {pattern: /\beval\s*\(|\bFunction\s*\(/, label: '二次求值 eval/Function'},
  {pattern: /\bsetTimeout\b|\bsetInterval\b|\brequestAnimationFrame\b|\bqueueMicrotask\b|\bsetImmediate\b/, label: '异步计时器（动画只能用 useCurrentFrame 驱动）'},
  {pattern: /\basync\b|\bawait\b|\bPromise\b/, label: '异步语法 async/await/Promise（渲染必须同步确定）'},
  {pattern: /\bprocess\b|\bBuffer\b|\b__dirname\b|\bmodule\b/, label: 'Node.js API'},
  {pattern: /Math\.random|\bDate\b|\bperformance\b/, label: '非确定性 API（随机用注入的 random(seed)，禁止 Math.random/Date）'},
  {pattern: /\bwhile\s*\(|for\s*\(\s*;/, label: '无界循环 while/for(;;)（遍历用数组 map）'},
  {pattern: /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|\.postMessage\b|\bWorker\b/, label: 'DOM 注入/Worker'},
  {pattern: /\balert\s*\(|\bconfirm\s*\(/, label: '弹窗 API'},
];

export interface ScanResult {
  ok: boolean;
  errors: string[];
}

/**
 * 扫描受限 TSX 源码：长度上限 + 必须定义 GeneratedTemplate + 黑名单。
 * 返回的 errors 全部面向 LLM（含命中 token 与规则说明），可直接回喂改稿。
 */
export const scanGeneratedSource = (source: string): ScanResult => {
  const errors: string[] = [];
  if (typeof source !== 'string' || !source.trim()) {
    return {ok: false, errors: ['源码为空']};
  }
  if (source.length > GENERATED_SOURCE_MAX) {
    errors.push(`源码 ${source.length} 字符超上限（≤${GENERATED_SOURCE_MAX}）`);
  }
  if (!/\bGeneratedTemplate\b/.test(source)) {
    errors.push('必须定义名为 GeneratedTemplate 的组件：const GeneratedTemplate = (props) => { ... }');
  }
  for (const rule of FORBIDDEN_RULES) {
    const m = rule.pattern.exec(source);
    if (m) {
      errors.push(`命中禁用规则「${rule.label}」：出现了 ${JSON.stringify(m[0])}`);
    }
  }
  return {ok: errors.length === 0, errors};
};

// ====== 持久化结构校验（主进程 list/save 准入）======

export const validateGeneratedTemplateDef = (raw: unknown): string[] => {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return ['模板必须是对象'];
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || !isGeneratedTemplateId(d.id) || d.id.length > 64) {
    errors.push('id 必须是 gen- 前缀字符串（≤64 字符）');
  }
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > GENERATED_NAME_MAX) {
    errors.push(`名称必填且 ≤${GENERATED_NAME_MAX} 字`);
  }
  if (typeof d.description !== 'string' || d.description.length > GENERATED_DESCRIPTION_MAX) {
    errors.push(`描述必须是字符串且 ≤${GENERATED_DESCRIPTION_MAX} 字`);
  }
  if (typeof d.source !== 'string' || !d.source.trim() || d.source.length > GENERATED_SOURCE_MAX) {
    errors.push(`源码必填且 ≤${GENERATED_SOURCE_MAX} 字符`);
  }
  if (typeof d.compiled !== 'string' || !d.compiled.trim() || d.compiled.length > GENERATED_COMPILED_MAX) {
    errors.push(`编译产物必填且 ≤${GENERATED_COMPILED_MAX} 字符`);
  }
  if (typeof d.duration !== 'number' || !Number.isFinite(d.duration) || d.duration < 1 || d.duration > 60) {
    errors.push('默认时长必须是 1-60 秒的数字');
  }
  if (d.paramSpecs !== undefined) {
    if (!Array.isArray(d.paramSpecs)) {
      errors.push('paramSpecs 必须是数组');
    } else {
      if (d.paramSpecs.length > GENERATED_PARAM_MAX) errors.push(`paramSpecs 超过 ${GENERATED_PARAM_MAX} 个参数`);
      const keys = new Set<string>();
      d.paramSpecs.forEach((s, i) => {
        if (!isValidParamSpec(s)) {
          errors.push(`参数 ${i + 1}：结构非法（需要 key/label/min/max/step/default）`);
          return;
        }
        const key = (s as {key: string}).key;
        if (keys.has(key)) errors.push(`参数 ${i + 1}：key「${key}」重复`);
        keys.add(key);
      });
    }
  }
  if (d.textSlots !== undefined && !isValidTextSlots(d.textSlots)) {
    errors.push('textSlots 必须是 title/subtitle/features/brandName 组成的数组');
  }
  if (typeof d.createdAt !== 'number' || typeof d.updatedAt !== 'number') {
    errors.push('createdAt/updatedAt 必须是数字');
  }
  return errors;
};

// ====== meta 转换（并入模板清单，供选择器/LLM get_templates 展示）======

export const generatedTemplateToMeta = (def: GeneratedTemplateDef): TemplateMeta => ({
  id: def.id,
  name: `🤖 ${def.name}`,
  description: def.description || 'AI 生成模板',
  thumbnail: 'custom',
  minVideos: 0,
  maxVideos: 6,
  defaultDuration: def.duration,
  supportsPortrait: true,
  paramSpecs: def.paramSpecs,
  ...(def.textSlots ? {textSlots: def.textSlots} : {}),
});

/** 按 id 查生成模板 def */
export const findGeneratedDef = (
  id: string,
  generatedTemplates: GeneratedTemplateDef[] = [],
): GeneratedTemplateDef | undefined => generatedTemplates.find((t) => t.id === id);

// ====== LLM 契约文本（generate_template 工具描述用）======

/**
 * 写给 LLM 的受限 TSX 契约。工具描述直接引用——改这里即改 LLM 看到的规范。
 * 保持紧凑：每多 100 字都是每次会话的固定上下文成本。
 */
export const GENERATED_TSX_CONTRACT = `你写一段受限 TSX 定义一个 Remotion 组件，系统编译后即可像内置模板一样被 set_storyboard 的 templateId 引用渲染。
【契约】
- 必须定义：const GeneratedTemplate = (props) => { ...return (...JSX...); };
- 禁止 import/export/require；下列全局已注入直接使用：
  React / useCurrentFrame / useVideoConfig / spring / interpolate / Sequence / AbsoluteFill / Img / Video / OffthreadVideo / Audio / Easing / random(seed)（种子随机，确定性） / AnimatedText（文字动效，props: {text, preset, startFrame?, duration?, style?}，preset 如 charPop/wordReveal/fadeUp/maskWipe/typewriter/glowPulse） / VIDEO_DESIGN（设计令牌：colors.accent、fontSize{title,subtitle,body,caption}、borderRadius、shadow） / getScaledTokens(画布宽→缩放令牌) / getBrandPalette() / SPRINGS / STAGGER / easeOutQuint / ThreeStage / ThreeAmbience / TurntableModel / ThreeText / PhoneShell / LaptopShell / DEVICE_SCREEN（3D 原语，规则见下）
- props 可用：videos（素材数组，v.type 'video'|'image'|'model'，v.src 喂 Video/Img/TurntableModel，v.width/v.height 像素）/ text（{title, subtitle, features[], brandName}）/ orientation（'landscape'|'portrait'）/ segmentDuration（秒）/ params（paramSpecs 声明的滑块值，用 params.xxx ?? 默认值 读取）
- 文字槽位：按组件实际消费的 props.text 字段填 textSlots 参数（如只用 title/subtitle 就传 ["title","subtitle"]；不用文字传 []）——校验器据此提醒「文案给了但不显示」的字段；覆盖迭代时重传以更新，缺省沿用旧声明
- 禁止：网络/存储/DOM(document/window)/异步(async/await/Promise/setTimeout)/eval/Function/while 循环/Math.random/Date
- 逐帧确定性：同一帧号必须渲染同一画面；动画一律 useCurrentFrame + spring/interpolate 驱动
- 画布宽高用 useVideoConfig().width/height，布局按 orientation 同时适配横竖屏
- 节奏：总帧数 = Math.round(segmentDuration * fps)；入场 0.5-0.8s，元素错峰 STAGGER，按 segmentDuration 等比缩放，结尾 0.3s 内保持稳定（方便接转场）
【3D 组件（可选，three.js 场景）】
- ThreeStage 是全部 3D 内容的唯一包裹层（放 AbsoluteFill 内；一个模板至多一个 ThreeStage），totalFrames 必传 = Math.round(props.segmentDuration * fps)；常用 props：rig('static'|'orbit'|'dolly'|'crane')、rigSpeed、ambience(0-3)、ambienceColor、radius、fov、shadows
- 氛围二选一：ThreeStage 的 ambience prop，或其内部放 <ThreeAmbience level={1-3} color="#7FA8FF" />，不要叠加
- ThreeText 真 3D 挤出文字：{text, size?, depth?, color?, sideColor?, letterSpacing?, maxWidth?, startFrame?, stagger?, position?}（position 是 [x,y,z]）
- TurntableModel glb 模型旋转台：{src, size?, periodSec?, spinSpeed?}；src 只能取 props.videos 里 v.type === 'model' 的 v.src（没有 model 素材就不要用；仅支持未压缩 glb）
- PhoneShell / LaptopShell 参数化设备壳（props: color?）；children 是 three 场景内的屏幕锚点，只能放空或 three 内容，不要放 DOM/Video/Img（本轮无屏幕纹理组件）；屏幕区域尺寸常量 DEVICE_SCREEN.phone / .laptop = {w, h}
- 3D 动画同铁律：只准 useCurrentFrame + interpolate/spring 逐帧算坐标与旋转；禁 Math.random/Date
【3D 示例】（片段；props/fps 同骨架示例）
const model = (props.videos || []).find((v) => v.type === 'model');
return (
  <AbsoluteFill style={{background: '#0b1020'}}>
    <ThreeStage rig="orbit" totalFrames={Math.round(props.segmentDuration * fps)} ambience={2}>
      <ThreeText text={props.text.title} size={1.1} position={[0, 1.4, 0]} />
      {model ? <TurntableModel src={model.src} size={2.6} /> : null}
    </ThreeStage>
  </AbsoluteFill>
);
【骨架示例】
const GeneratedTemplate = (props) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const enter = spring({frame, fps, config: SPRINGS.smooth});
  return (
    <AbsoluteFill style={{background: '#0b1020', justifyContent: 'center', alignItems: 'center'}}>
      <AnimatedText text={props.text.title} preset="charPop"
        style={{fontSize: VIDEO_DESIGN.fontSize.title, color: '#fff', fontWeight: 700, opacity: enter}} />
    </AbsoluteFill>
  );
};`;
