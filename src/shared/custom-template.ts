/**
 * 自定义模板 - 数据模型与关键帧求值
 *
 * 模板从"硬编码 React 组件"变为"数据"：用户在编辑器里摆放视频框/文本框，
 * 用关键帧动画化属性，存成 JSON。CustomTemplateRender（Remotion）和
 * CustomTemplateCanvas（CSS 预览）共用本文件的 evalProp 求值逻辑，保证所见即所得。
 *
 * 设计要点：
 * - 位置/尺寸用 0..1 比例（非像素），分辨率无关、横竖屏通用
 * - Keyframe.t 用 0..1（占片段时长的比例），与帧率解耦
 */

import type {Orientation, TextStyle, TemplateParamSpec} from './types';
import {evalEasingCurve, easingToCurve, type EasingCurve} from './easing-curve.ts';

// ====== 缓动 ======

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

const EASING_FN: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
};

// ====== 关键帧与动画属性 ======

export interface Keyframe {
  t: number;        // 0..1，占片段时长的比例
  value: number;
  easing?: Easing;  // 进入此关键帧的缓动（从前一个关键帧过来），默认 linear
  /** 自定义缓动曲线（多点 AE 风格）；设置后覆盖 easing */
  curve?: EasingCurve;
}

export interface AnimatedProp {
  /** 关键帧序列（按 t 排序）。为空则用 static */
  keyframes?: Keyframe[];
  /** 无关键帧时的静态值 */
  static?: number;
}

// ====== 元素 ======

export type CustomElementType = 'video' | 'text' | 'shape';
export type TextRole = 'title' | 'subtitle' | 'feature' | 'brand';
export type VideoFit = 'cover' | 'contain';

/** 装饰形状种类；line 渲染为横条（厚度取 borderWidth） */
export type ShapeKind = 'rect' | 'ellipse' | 'line';

/**
 * 元素入场动画预设（文字 + 视频通用；typewriter 仅文字）。
 * 在片段开头播放一次。CSS 预览与 Remotion 渲染共用 applyEntranceAnim，保证所见即所得。
 */
export type EntranceAnim =
  | 'none'
  | 'fadeIn'
  | 'fadeUp'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'scaleIn'
  | 'popIn'
  | 'bounce'
  | 'blurIn'
  | 'rotateIn'
  | 'typewriter';

/** 入场动画求值结果。tx/ty/blur 用画布比例，分辨率无关（预览与渲染一致）。 */
export interface EntranceAnimResult {
  content: string; // typewriter 切片；其余预设原样返回
  opacity: number; // 与元素 opacity 相乘后的最终透明度
  tx: number; // X 位移占画布宽比例（0.1 = 右移 10% 画布宽）
  ty: number; // Y 位移占画布高比例
  scaleMul: number; // 缩放倍率（与元素 scale 相乘）
  rotateDeg: number; // 额外旋转角度（度）
  blur: number; // 模糊占画布最小边比例（0.01 = 1%）
}

/** 入场动画 UI 选项（分组；textOnly 的不提供给视频元素） */
export const ENTRANCE_ANIM_OPTIONS: {
  group: string;
  value: EntranceAnim;
  label: string;
  textOnly?: boolean;
}[] = [
  {group: '基础', value: 'none', label: '无'},
  {group: '基础', value: 'fadeIn', label: '淡入'},
  {group: '基础', value: 'fadeUp', label: '上浮淡入'},
  {group: '滑入', value: 'slideLeft', label: '从右滑入'},
  {group: '滑入', value: 'slideRight', label: '从左滑入'},
  {group: '滑入', value: 'slideUp', label: '从下滑入'},
  {group: '滑入', value: 'slideDown', label: '从上滑入'},
  {group: '缩放', value: 'scaleIn', label: '缩放淡入'},
  {group: '缩放', value: 'popIn', label: '弹出'},
  {group: '缩放', value: 'bounce', label: '弹跳'},
  {group: '特效', value: 'blurIn', label: '模糊聚焦'},
  {group: '特效', value: 'rotateIn', label: '旋转入场'},
  {group: '特效', value: 'typewriter', label: '打字机', textOnly: true},
];

export interface CustomElement {
  id: string;
  type: CustomElementType;
  name: string;

  // 文本专属
  textRole?: TextRole;
  textStyle?: TextStyle;
  placeholder?: string;  // 编辑器里的占位文案
  /** 固定文本：设置后优先于角色内容（用于装饰性符号，如 “ ★ →；最长 50 字符） */
  fixedText?: string;
  entranceAnim?: EntranceAnim;   // 入场动画（文字 + 视频通用；typewriter 仅文字）

  // 视频专属
  videoFit?: VideoFit;

  // 形状专属
  shape?: ShapeKind;        // 默认 rect
  fill?: string;            // CSS 颜色/渐变；缺省半透明品牌蓝
  borderColor?: string;     // 边线颜色（需配合 borderWidth）
  borderWidth?: number;     // 边线宽度 px；line 形状用它当厚度
  blur?: number;            // 高斯模糊，占画布最小边比例（0.01 = 1%）

  // 动画化属性（比例 0..1，除 rotation 度 / opacity 0..1 / scale 0..2）
  x: AnimatedProp;          // 中心 X（0..1，0.5 = 居中）
  y: AnimatedProp;          // 中心 Y（0..1，0.5 = 居中）
  width: AnimatedProp;      // 宽度（0..1 占画布宽）
  height: AnimatedProp;     // 高度（0..1 占画布高）
  rotation: AnimatedProp;   // Z 轴旋转（度）
  opacity: AnimatedProp;    // 不透明度（0..1）
  scale: AnimatedProp;      // 缩放（0..2）

  // 静态属性
  borderRadius?: number;
  perspective?: number;
  rotateX?: number;
  rotateY?: number;
}

// ====== 模板参数绑定（滑块 → 元素属性） ======

/** 可被参数绑定的元素属性（与 ANIMATED_PROP_KEYS 一致） */
export type BindableProp = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'scale';

/**
 * 参数绑定：把 paramSpecs 里某个滑块的当前值映射到元素属性。
 * - multiply：属性值 × 参数（参数语义为倍率，默认 1）
 * - add：属性值 + 参数（参数语义为增量，默认 0；适合旋转°/位置偏移）
 */
export interface ParamBinding {
  paramKey: string;      // 引用 CustomTemplateDef.paramSpecs 的 key
  elementId: string;
  prop: BindableProp;
  mode: 'multiply' | 'add';
}

// ====== 模板定义 ======

export interface CustomTemplateDef {
  id: string;            // 'custom-<uuid>'（本地）或 'mkt-<slug>'（市场模板包）
  name: string;
  description?: string;
  duration: number;      // 默认片段时长（秒）
  background: string;    // CSS 颜色或渐变
  orientation: Orientation;
  /** 画布比例预设 id（如 '16-9'/'1-1'）；缺省时由 orientation 派生（portrait->9-16, 否则 16-9） */
  aspectRatioId?: string;
  elements: CustomElement[];
  /** 模板暴露给使用者的可调参数（渲染为滑块），配合 paramBindings 生效 */
  paramSpecs?: TemplateParamSpec[];
  /** 参数 → 元素属性的绑定关系 */
  paramBindings?: ParamBinding[];
  /** 文字槽位声明：模板真正会渲染的 text.* 字段（TEXT_SLOT_VALUES 子集）。
   *  缺省 = 未标注（校验器不发提示）；[] = 显式声明不展示文字。
   *  编辑器可手动勾选或用 detectTextSlots 按文本框角色静态检测。 */
  textSlots?: string[];
  isCustom: true;
}

// ====== 文字槽位（textSlots） ======

/**
 * 文字槽位合法取值（与 TemplateMeta.textSlots / TEXT_SLOTS_BUILTIN 同一词汇）：
 * 模板真正会渲染的 text.* 字段。llm-tools 校验器据此对「文案给了但模板不展示」的字段发 notes。
 */
export const TEXT_SLOT_VALUES = ['title', 'subtitle', 'features', 'brandName'] as const;
export type TextSlot = (typeof TEXT_SLOT_VALUES)[number];

/** 槽位 → 中文标签（编辑器勾选框/脚本报告共用） */
export const TEXT_SLOT_OPTIONS: {value: TextSlot; label: string}[] = [
  {value: 'title', label: '主标题'},
  {value: 'subtitle', label: '副标题'},
  {value: 'features', label: '功能要点'},
  {value: 'brandName', label: '品牌名'},
];

/** 文本框角色 → 文字槽位（与 CustomTemplateRender/CustomTemplateCanvas 的 getTextContent 消费点一致） */
const TEXT_ROLE_TO_SLOT: Record<TextRole, TextSlot> = {
  title: 'title',
  subtitle: 'subtitle',
  feature: 'features',
  brand: 'brandName',
};

/**
 * 从模板定义静态检测文字槽位：未设 fixedText 的文本框元素按 textRole（缺省 title）映射得出；
 * fixedText 元素渲染固定文案、不消费 text.*，不计入。返回按 TEXT_SLOT_VALUES 顺序去重。
 */
export const detectTextSlots = (def: Pick<CustomTemplateDef, 'elements'>): TextSlot[] => {
  const hit = new Set<TextSlot>();
  for (const el of def.elements) {
    if (el.type !== 'text' || el.fixedText) continue;
    hit.add(TEXT_ROLE_TO_SLOT[el.textRole ?? 'title']);
  }
  return TEXT_SLOT_VALUES.filter((s) => hit.has(s));
};

/**
 * 清洗外部传入的 textSlots（LLM 参数/导入数据）：非法值剔除并记入 dropped，
 * 去重并按 TEXT_SLOT_VALUES 排序；空数组合法（= 显式声明无文字槽位）。
 */
export const sanitizeTextSlots = (raw: unknown): {slots: TextSlot[]; dropped: string[]} => {
  const dropped: string[] = [];
  const hit = new Set<TextSlot>();
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string' && (TEXT_SLOT_VALUES as readonly string[]).includes(v)) hit.add(v as TextSlot);
      else dropped.push(String(v));
    }
  }
  return {slots: TEXT_SLOT_VALUES.filter((s) => hit.has(s)), dropped};
};

/** textSlots 字段结构校验（validateCustomTemplateDef / validateGeneratedTemplateDef 共用） */
export const isValidTextSlots = (v: unknown): boolean =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && (TEXT_SLOT_VALUES as readonly string[]).includes(s));

/**
 * 参数绑定求值：在 evalProp 的基础值上应用所有命中 (elementId, prop) 的绑定。
 * 参数值来源：Segment.customParams > paramSpecs.default > 1（与内置模板回退语义一致）。
 */
export const applyParamBinding = (
  def: CustomTemplateDef,
  params: Record<string, number> | undefined,
  elementId: string,
  prop: BindableProp,
  base: number,
): number => {
  const bindings = def.paramBindings;
  if (!bindings || bindings.length === 0) return base;
  let v = base;
  for (const b of bindings) {
    if (b.elementId !== elementId || b.prop !== prop) continue;
    const spec = def.paramSpecs?.find((s) => s.key === b.paramKey);
    const p = params?.[b.paramKey] ?? spec?.default ?? 1;
    v = b.mode === 'add' ? v + p : v * p;
  }
  return v;
};

// ====== 求值 ======

/**
 * 纯 JS interpolate（不依赖 Remotion），供 CSS 预览和 Remotion 渲染共用。
 * 在 times[i]..times[i+1] 之间用 values[i]..values[i+1] 插值，应用缓动。
 * 缓动来源（优先级）：该段终点关键帧的 curve（自定义曲线）> easing（命名）> linear。
 */
export const interpolateValues = (
  frame: number,
  times: number[],
  values: number[],
  easings: Easing[] = [],
  curves: (EasingCurve | undefined)[] = [],
): number => {
  if (times.length === 0) return 0;
  if (times.length === 1) return values[0];
  // 越界 clamp
  if (frame <= times[0]) return values[0];
  if (frame >= times[times.length - 1]) return values[values.length - 1];

  // 找到所在区间
  let seg = 0;
  for (let i = 0; i < times.length - 1; i++) {
    if (frame >= times[i] && frame <= times[i + 1]) {
      seg = i;
      break;
    }
  }
  const t0 = times[seg];
  const t1 = times[seg + 1];
  const v0 = values[seg];
  const v1 = values[seg + 1];
  const localT = t1 === t0 ? 0 : (frame - t0) / (t1 - t0);
  // 进入 t1 的缓动（用该区间终点的 curve/easing）
  const curve = curves[seg + 1];
  const easedT = curve ? evalEasingCurve(curve, localT) : EASING_FN[easings[seg + 1] ?? 'linear'](localT);
  return v0 + (v1 - v0) * easedT;
};

/**
 * 求某个动画属性在指定帧的值。
 * @param prop 动画属性
 * @param frame 当前帧（0..totalFrames）
 * @param totalFrames 片段总帧数
 * @param fallback 默认值（prop 为空时）
 */
export const evalProp = (
  prop: AnimatedProp | undefined,
  frame: number,
  totalFrames: number,
  fallback = 0,
): number => {
  if (!prop) return fallback;
  const kfs = prop.keyframes;
  if (!kfs || kfs.length === 0) return prop.static ?? fallback;

  const sorted = [...kfs].sort((a, b) => a.t - b.t);
  const times = sorted.map((k) => k.t * totalFrames);
  const values = sorted.map((k) => k.value);
  const easings = sorted.map((k) => k.easing ?? 'linear');
  const curves = sorted.map((k) => k.curve);
  return interpolateValues(frame, times, values, easings, curves);
};

// 入场动画缓动
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * 入场动画求值：在片段开头播放一次。CSS 预览与 Remotion 渲染共用，保证所见即所得。
 * 返回画布比例的位移/缩放/旋转/模糊，由调用方乘以画布像素尺寸。
 * @param anim 入场动画预设
 * @param frame 当前帧（相对片段 Sequence）
 * @param content 文本内容（typewriter 据此切片；视频传 ''）
 * @param opacity 元素自身不透明度（与动画透明度相乘）
 */
export const applyEntranceAnim = (
  anim: EntranceAnim | undefined,
  frame: number,
  content: string,
  opacity: number,
): EntranceAnimResult => {
  const identity: EntranceAnimResult = {
    content,
    opacity,
    tx: 0,
    ty: 0,
    scaleMul: 1,
    rotateDeg: 0,
    blur: 0,
  };
  if (!anim || anim === 'none') return identity;

  const DUR = anim === 'typewriter' ? 20 : 15;
  const p = Math.max(0, Math.min(1, frame / DUR));
  const e = easeOutCubic(p);

  switch (anim) {
    case 'typewriter': {
      const n = Math.max(0, Math.min(content.length, Math.round(content.length * p)));
      return {...identity, content: content.slice(0, n)};
    }
    case 'fadeIn':
      return {...identity, opacity: opacity * p};
    case 'fadeUp':
      return {...identity, opacity: opacity * p, ty: (1 - e) * 0.05};
    case 'slideLeft': // 从右滑入
      return {...identity, opacity: opacity * p, tx: (1 - e) * 0.18};
    case 'slideRight': // 从左滑入
      return {...identity, opacity: opacity * p, tx: -(1 - e) * 0.18};
    case 'slideUp': // 从下滑入
      return {...identity, opacity: opacity * p, ty: (1 - e) * 0.22};
    case 'slideDown': // 从上滑入
      return {...identity, opacity: opacity * p, ty: -(1 - e) * 0.22};
    case 'scaleIn':
      return {...identity, opacity: opacity * p, scaleMul: 0.8 + 0.2 * e};
    case 'popIn':
      return {...identity, opacity: opacity * p, scaleMul: 0.5 + 0.5 * e};
    case 'bounce':
      return {...identity, opacity: opacity * Math.min(1, p * 3), ty: (1 - easeOutBack(p)) * 0.08};
    case 'blurIn':
      return {...identity, opacity: opacity * p, blur: (1 - p) * 0.02};
    case 'rotateIn':
      return {
        ...identity,
        opacity: opacity * p,
        rotateDeg: (1 - e) * -10,
        scaleMul: 0.92 + 0.08 * p,
      };
    default:
      return identity;
  }
};

/** 兼容旧数据：把元素上的旧 textAnim 字段迁移到 entranceAnim。 */
export const migrateCustomDef = (def: CustomTemplateDef): CustomTemplateDef => {
  if (!def || !def.elements) return def;
  return {
    ...def,
    elements: def.elements.map((el) => {
      const old = (el as unknown as {textAnim?: EntranceAnim}).textAnim;
      if (old !== undefined && el.entranceAnim === undefined) {
        const {textAnim: _drop, ...rest} = el as unknown as {textAnim?: EntranceAnim} & CustomElement;
        return {...rest, entranceAnim: old} as CustomElement;
      }
      return el;
    }),
  };
};

// ====== 工厂函数 ======

let elementCounter = 0;
const genElementId = () => `el-${Date.now().toString(36)}-${elementCounter++}`;

/** 创建视频框元素（默认居中 60%×50%） */
export const createVideoElement = (name = '视频框'): CustomElement => ({
  id: genElementId(),
  type: 'video',
  name,
  videoFit: 'cover',
  x: {static: 0.5},
  y: {static: 0.5},
  width: {static: 0.6},
  height: {static: 0.5},
  rotation: {static: 0},
  opacity: {static: 1},
  scale: {static: 1},
  borderRadius: 12,
  perspective: 1200,
  rotateX: 0,
  rotateY: 0,
  entranceAnim: 'none',
});

/** 创建文本框元素 */
export const createTextElement = (role: TextRole, name?: string): CustomElement => {
  const defaultName = name ?? ({title: '标题', subtitle: '副标题', feature: '功能', brand: '品牌'}[role]);
  return {
    id: genElementId(),
    type: 'text',
    name: defaultName,
    textRole: role,
    textStyle: {fontSize: 48, fontWeight: 700, color: '#111827'},
    placeholder: ({title: '主标题', subtitle: '副标题', feature: '功能要点', brand: '品牌名'}[role]),
    entranceAnim: 'none',
    x: {static: 0.5},
    y: {static: 0.85},
    width: {static: 0.8},
    height: {static: 0.15},
    rotation: {static: 0},
    opacity: {static: 1},
    scale: {static: 1},
  };
};

/** 创建装饰形状元素（默认半透明品牌蓝矩形） */
export const createShapeElement = (shape: ShapeKind = 'rect', name = '装饰形状'): CustomElement => ({
  id: genElementId(),
  type: 'shape',
  name,
  shape,
  fill: 'rgba(37, 99, 235, 0.25)',
  x: {static: 0.5},
  y: {static: 0.5},
  width: {static: shape === 'line' ? 0.5 : 0.2},
  height: {static: shape === 'line' ? 0.004 : 0.2},
  rotation: {static: 0},
  opacity: {static: 1},
  scale: {static: 1},
  borderRadius: shape === 'rect' ? 12 : 0,
  entranceAnim: 'none',
});

/** 由方向派生默认比例预设 id */
export const defaultAspectIdFor = (orientation: Orientation): string =>
  orientation === 'portrait' ? '9-16' : '16-9';

/** 创建空白自定义模板 */
export const createBlankCustomTemplate = (orientation: Orientation): CustomTemplateDef => ({
  id: `custom-${Date.now().toString(36)}`,
  name: '我的模板',
  duration: 8,
  background: 'linear-gradient(135deg, #F8F9FA 0%, #FFFFFF 50%, #F1F5F9 100%)',
  orientation,
  aspectRatioId: defaultAspectIdFor(orientation),
  elements: [
    createVideoElement(),
    createTextElement('title'),
  ],
  isCustom: true,
});

/**
 * 在指定时间点为属性打关键帧。若该时间已有关键帧则更新，否则新增。
 * 更新时保留原 curve（除非显式传入新 curve）。
 */
export const setKeyframe = (
  prop: AnimatedProp,
  t: number,
  value: number,
  easing: Easing = 'linear',
  curve?: EasingCurve,
): AnimatedProp => {
  const kfs = [...(prop.keyframes || [])];
  const idx = kfs.findIndex((k) => Math.abs(k.t - t) < 0.001);
  if (idx >= 0) {
    kfs[idx] = {t, value, easing, curve: curve !== undefined ? curve : kfs[idx].curve};
  } else {
    kfs.push({t, value, easing, ...(curve ? {curve} : {})});
  }
  kfs.sort((a, b) => a.t - b.t);
  return {...prop, keyframes: kfs};
};

/** 删除指定时间点的关键帧 */
export const removeKeyframe = (prop: AnimatedProp, t: number): AnimatedProp => {
  const kfs = (prop.keyframes || []).filter((k) => Math.abs(k.t - t) >= 0.001);
  return {...prop, keyframes: kfs.length > 0 ? kfs : undefined};
};

// ====== 从内置模板创建（用于微调，另存为新自定义模板，不动原模板）======

/** 静态数值快捷构造 */
const s = (v: number): AnimatedProp => ({static: v});

/**
 * 把内置模板转换成一个可编辑的 CustomTemplateDef（近似布局）。
 * 返回的模板带全新 custom- id，保存后即新自定义模板，原内置模板不受影响。
 * 注：内置模板的复杂逐帧动画无法 1:1 转换，这里取其静态布局作为微调起点。
 */
export const builtInTemplateToCustom = (templateId: string, orientation: Orientation): CustomTemplateDef => {
  const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const vid = (x: number, y: number, w: number, h: number, extra: Partial<CustomElement> = {}): CustomElement => ({
    ...createVideoElement(),
    x: s(x), y: s(y), width: s(w), height: s(h),
    ...extra,
  });
  const txt = (role: TextRole, x: number, y: number, w: number, h: number, extra: Partial<CustomElement> = {}): CustomElement => ({
    ...createTextElement(role),
    x: s(x), y: s(y), width: s(w), height: s(h),
    ...extra,
  });

  switch (templateId) {
    case 'RevealSlide':
      return {id, name: '3D倾斜平推(副本)', duration: 8, orientation, isCustom: true,
        background: 'linear-gradient(135deg, #F8F9FA 0%, #FFFFFF 50%, #F1F5F9 100%)',
        elements: [
          vid(0.5, 0.42, 0.6, 0.5, {rotateY: -10, perspective: 1200}),
          txt('title', 0.5, 0.88, 0.8, 0.1),
        ]};
    case 'StackCards':
      return {id, name: '卡片堆叠(副本)', duration: 10, orientation, isCustom: true,
        background: 'linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 50%, #C7D2FE 100%)',
        elements: [
          vid(0.5, 0.45, 0.55, 0.55, {rotateY: -8, perspective: 1500}),
          txt('title', 0.5, 0.12, 0.8, 0.1),
        ]};
    case 'CinematicPan':
      return {id, name: '电影感运镜(副本)', duration: 10, orientation, isCustom: true,
        background: 'linear-gradient(135deg, #1F2937 0%, #111827 50%, #0F172A 100%)',
        elements: [
          vid(0.5, 0.48, 0.65, 0.45, {perspective: 2000}),
          txt('title', 0.5, 0.12, 0.8, 0.1, {textStyle: {fontSize: 52, fontWeight: 700, color: '#F8FAFC'}}),
        ]};
    case 'SplitShowcase':
      return {id, name: '分屏展示(副本)', duration: 10, orientation, isCustom: true,
        background: '#FFFFFF',
        elements: [
          vid(0.27, 0.5, 0.46, 0.6, {rotateY: -6, perspective: 1400}),
          txt('title', 0.72, 0.32, 0.4, 0.12),
          txt('subtitle', 0.72, 0.5, 0.4, 0.1, {textStyle: {fontSize: 28, fontWeight: 400, color: '#6B7280'}}),
        ]};
    case 'MinimalFloat':
      return {id, name: '极简悬浮(副本)', duration: 6, orientation, isCustom: true,
        background: '#FFFFFF',
        elements: [
          vid(0.5, 0.45, 0.7, 0.4, {rotateX: 3, rotateY: -6, perspective: 1800}),
          txt('title', 0.5, 0.8, 0.8, 0.1, {textStyle: {fontSize: 44, fontWeight: 300, color: '#111827'}}),
        ]};
    case 'KenBurns':
      return {id, name: 'KenBurns推拉(副本)', duration: 6, orientation, isCustom: true,
        background: '#0F172A',
        elements: [
          vid(0.5, 0.42, 0.8, 0.6, {borderRadius: 16}),
          txt('title', 0.5, 0.88, 0.8, 0.1, {textStyle: {fontSize: 40, fontWeight: 300, color: '#FFFFFF'}}),
        ]};
    case 'GridMosaic':
      return {id, name: '网格拼图(副本)', duration: 8, orientation, isCustom: true,
        background: '#F8F9FA',
        elements: [
          txt('title', 0.5, 0.1, 0.8, 0.08),
          vid(0.28, 0.38, 0.36, 0.26),
          vid(0.72, 0.38, 0.36, 0.26),
          vid(0.28, 0.72, 0.36, 0.26),
          vid(0.72, 0.72, 0.36, 0.26),
        ]};
    case 'VerticalScroll':
      return {id, name: '竖屏滚动卡(副本)', duration: 8, orientation, isCustom: true,
        background: 'linear-gradient(135deg, #1F2937 0%, #111827 100%)',
        elements: [
          vid(0.5, 0.5, 1, 1, {borderRadius: 0, videoFit: 'cover'}),
          txt('title', 0.5, 0.5, 0.84, 0.12, {textStyle: {fontSize: 40, fontWeight: 800, color: '#FFFFFF'}}),
        ]};
    case 'SplitCompare':
      return {id, name: '分屏对比(副本)', duration: 8, orientation, isCustom: true,
        background: '#111827',
        elements: [
          vid(0.25, 0.5, 0.5, 1, {borderRadius: 0}),
          vid(0.75, 0.5, 0.5, 1, {borderRadius: 0}),
          txt('title', 0.5, 0.1, 0.6, 0.1, {textStyle: {fontSize: 32, fontWeight: 600, color: '#FFFFFF'}}),
        ]};
    default:
      return createBlankCustomTemplate(orientation);
  }
};

// ====== 结构校验（导入文件 / 存量数据 / 市场模板包共用） ======

/** 元素入场动画合法值（与 EntranceAnim 一致） */
const ENTRANCE_ANIM_VALUES: ReadonlySet<string> = new Set([
  'none', 'fadeIn', 'fadeUp', 'slideLeft', 'slideRight', 'slideUp', 'slideDown',
  'scaleIn', 'popIn', 'bounce', 'blurIn', 'rotateIn', 'typewriter',
]);
const EASING_VALUES: ReadonlySet<string> = new Set(['linear', 'easeIn', 'easeOut', 'easeInOut']);
const SHAPE_VALUES: ReadonlySet<string> = new Set(['rect', 'ellipse', 'line']);
const BINDABLE_PROP_VALUES: ReadonlySet<string> = new Set(['x', 'y', 'width', 'height', 'rotation', 'opacity', 'scale']);
const ANIMATED_PROP_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'scale'] as const;

/** AnimatedProp 结构：{keyframes?: [{t 0..1, value, easing?}], static?: number} */
const isValidAnimatedProp = (p: unknown): boolean => {
  if (typeof p !== 'object' || p === null) return false;
  const ap = p as {keyframes?: unknown; static?: unknown};
  if (ap.static !== undefined && (typeof ap.static !== 'number' || !Number.isFinite(ap.static))) return false;
  if (ap.keyframes !== undefined) {
    if (!Array.isArray(ap.keyframes)) return false;
    for (const k of ap.keyframes) {
      if (typeof k !== 'object' || k === null) return false;
      const kf = k as {t?: unknown; value?: unknown; easing?: unknown};
      if (typeof kf.t !== 'number' || !Number.isFinite(kf.t) || kf.t < 0 || kf.t > 1) return false;
      if (typeof kf.value !== 'number' || !Number.isFinite(kf.value)) return false;
      if (kf.easing !== undefined && (typeof kf.easing !== 'string' || !EASING_VALUES.has(kf.easing))) return false;
    }
  }
  return true;
};

/** 参数规格结构校验（自定义模板/AI 生成模板共用） */
export const isValidParamSpec = (s: unknown): boolean => {
  if (typeof s !== 'object' || s === null) return false;
  const spec = s as Record<string, unknown>;
  if (typeof spec.key !== 'string' || !spec.key) return false;
  if (typeof spec.label !== 'string' || !spec.label) return false;
  for (const k of ['min', 'max', 'step', 'default'] as const) {
    if (typeof spec[k] !== 'number' || !Number.isFinite(spec[k] as number)) return false;
  }
  if ((spec.min as number) > (spec.max as number)) return false;
  if ((spec.step as number) <= 0) return false;
  if (spec.unit !== undefined && typeof spec.unit !== 'string') return false;
  return true;
};

/**
 * 自定义模板结构校验（导入文件、读取存量、市场模板包共用）。
 * 返回错误信息数组，空数组 = 合法。只查结构与字段类型，不修改数据。
 */
export const validateCustomTemplateDef = (def: unknown): string[] => {
  const errors: string[] = [];
  if (typeof def !== 'object' || def === null) return ['模板必须是 JSON 对象'];
  const d = def as Record<string, unknown>;
  if (typeof d.id !== 'string' || !d.id) errors.push('缺少模板 id（字符串）');
  if (typeof d.name !== 'string' || !d.name) errors.push('缺少模板名称 name（字符串）');
  if (d.isCustom !== true) errors.push('isCustom 必须为 true');
  if (typeof d.duration !== 'number' || !Number.isFinite(d.duration) || d.duration <= 0 || d.duration > 120) {
    errors.push('duration 必须是 0-120 秒的数字');
  }
  if (typeof d.background !== 'string' || !d.background) errors.push('background 必须是字符串（CSS 颜色/渐变）');
  if (d.orientation !== 'landscape' && d.orientation !== 'portrait') errors.push('orientation 必须是 landscape/portrait');
  if (!Array.isArray(d.elements)) {
    errors.push('elements 必须是数组');
    return errors;
  }
  if (d.elements.length === 0) errors.push('elements 至少包含一个元素');
  if (d.elements.length > 50) errors.push('elements 超过 50 个元素');
  d.elements.forEach((el, i) => {
    const at = `元素 ${i + 1}`;
    if (typeof el !== 'object' || el === null) {
      errors.push(`${at}：必须是对象`);
      return;
    }
    const e = el as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) errors.push(`${at}：缺少 id（字符串）`);
    if (e.type !== 'video' && e.type !== 'text' && e.type !== 'shape') errors.push(`${at}：type 必须是 video/text/shape`);
    if (typeof e.name !== 'string') errors.push(`${at}：缺少 name（字符串）`);
    for (const key of ANIMATED_PROP_KEYS) {
      if (!isValidAnimatedProp(e[key])) errors.push(`${at}：${key} 必须是动画属性对象（keyframes/static）`);
    }
    if (e.entranceAnim !== undefined && (typeof e.entranceAnim !== 'string' || !ENTRANCE_ANIM_VALUES.has(e.entranceAnim))) {
      errors.push(`${at}：entranceAnim 非法`);
    }
    if (e.videoFit !== undefined && e.videoFit !== 'cover' && e.videoFit !== 'contain') {
      errors.push(`${at}：videoFit 必须是 cover/contain`);
    }
    if (e.textRole !== undefined && !['title', 'subtitle', 'feature', 'brand'].includes(e.textRole as string)) {
      errors.push(`${at}：textRole 必须是 title/subtitle/feature/brand`);
    }
    if (e.fixedText !== undefined && (typeof e.fixedText !== 'string' || e.fixedText.length > 50)) {
      errors.push(`${at}：fixedText 必须是不超过 50 字符的字符串`);
    }
    if (e.textStyle !== undefined) {
      const ts = e.textStyle as Record<string, unknown>;
      if (typeof ts !== 'object' || ts === null
        || (ts.fontSize !== undefined && typeof ts.fontSize !== 'number')
        || (ts.fontWeight !== undefined && typeof ts.fontWeight !== 'number')
        || (ts.color !== undefined && typeof ts.color !== 'string')) {
        errors.push(`${at}：textStyle 结构非法（fontSize/fontWeight 为数字、color 为字符串）`);
      }
    }
    if (e.shape !== undefined && (typeof e.shape !== 'string' || !SHAPE_VALUES.has(e.shape))) {
      errors.push(`${at}：shape 必须是 rect/ellipse/line`);
    }
    if (e.fill !== undefined && typeof e.fill !== 'string') errors.push(`${at}：fill 必须是字符串`);
    if (e.borderColor !== undefined && typeof e.borderColor !== 'string') errors.push(`${at}：borderColor 必须是字符串`);
    if (e.borderWidth !== undefined && (typeof e.borderWidth !== 'number' || !Number.isFinite(e.borderWidth) || e.borderWidth < 0)) {
      errors.push(`${at}：borderWidth 必须是非负数字`);
    }
    if (e.blur !== undefined && (typeof e.blur !== 'number' || !Number.isFinite(e.blur) || e.blur < 0 || e.blur > 0.2)) {
      errors.push(`${at}：blur 必须是 0-0.2 的数字（占画布最小边比例）`);
    }
  });

  // 参数规格与绑定
  if (d.textSlots !== undefined && !isValidTextSlots(d.textSlots)) {
    errors.push('textSlots 必须是 title/subtitle/features/brandName 组成的数组');
  }
  if (d.paramSpecs !== undefined) {
    if (!Array.isArray(d.paramSpecs)) {
      errors.push('paramSpecs 必须是数组');
    } else {
      if (d.paramSpecs.length > 20) errors.push('paramSpecs 超过 20 个参数');
      const keys = new Set<string>();
      d.paramSpecs.forEach((s, i) => {
        if (!isValidParamSpec(s)) {
          errors.push(`参数 ${i + 1}：结构非法（需要 key/label/min/max/step/default）`);
          return;
        }
        const key = (s as {key: string}).key;
        if (keys.has(key)) errors.push(`参数 ${i + 1}：key "${key}" 重复`);
        keys.add(key);
      });
    }
  }
  if (d.paramBindings !== undefined) {
    if (!Array.isArray(d.paramBindings)) {
      errors.push('paramBindings 必须是数组');
    } else {
      const specKeys = new Set(
        Array.isArray(d.paramSpecs)
          ? d.paramSpecs.filter(isValidParamSpec).map((s) => (s as {key: string}).key)
          : [],
      );
      const elIds = new Set(
        d.elements
          .filter((el) => typeof el === 'object' && el !== null && typeof (el as {id?: unknown}).id === 'string')
          .map((el) => (el as {id: string}).id),
      );
      d.paramBindings.forEach((b, i) => {
        const at = `绑定 ${i + 1}`;
        if (typeof b !== 'object' || b === null) {
          errors.push(`${at}：必须是对象`);
          return;
        }
        const binding = b as Record<string, unknown>;
        if (typeof binding.paramKey !== 'string' || !specKeys.has(binding.paramKey)) {
          errors.push(`${at}：paramKey 必须引用 paramSpecs 中已定义的 key`);
        }
        if (typeof binding.elementId !== 'string' || !elIds.has(binding.elementId)) {
          errors.push(`${at}：elementId 必须引用 elements 中已定义的元素 id`);
        }
        if (typeof binding.prop !== 'string' || !BINDABLE_PROP_VALUES.has(binding.prop)) {
          errors.push(`${at}：prop 必须是 x/y/width/height/rotation/opacity/scale`);
        }
        if (binding.mode !== 'multiply' && binding.mode !== 'add') {
          errors.push(`${at}：mode 必须是 multiply/add`);
        }
      });
    }
  }
  return errors;
};
