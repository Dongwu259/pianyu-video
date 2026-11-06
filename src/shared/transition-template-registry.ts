/**
 * 转场模板注册表 —— 「转场即模板」机制的共享事实源（阶段一底层框架）。
 *
 * 动机（2026-09-27 架构评审）：内置 18 种转场是参数化特效，衔接表现力到顶（PPT 感）。
 * 转场模板 = 独立 Remotion 合成，输入 A 段尾 + B 段头各 T 秒的预渲染视频，输出整个衔接段
 * （含音视频所有权：自带 SFX 与 BGM ducking）。与内容模板一样可无限扩展，带叙事语义标签供
 * AI 按上下段内容选择。完整方案见 docs/transition-timeline-roadmap.md §4.1。
 *
 * 阶段状态：本模块只做注册/查询/校验/提示词描述；Remotion 合成（composable）为阶段 1b——
 * composable=false 的条目渲染器必须回退到 Segment.transition 内置特效。
 */
import type {SfxKind} from './types';
import type {TemplateParamSpec} from './types';

export type TransitionTemplateInput = 'video+video' | 'any';

export interface TransitionTemplateDef {
  id: string;
  name: string;
  desc: string;
  /** 衔接段时长范围（秒） */
  durationRange: [number, number];
  defaultDurationSec: number;
  /** 两侧输入要求：video+video = 两段都需真实视频素材（文字卡/纯色段不支持）；any = 无限制 */
  inputs: TransitionTemplateInput;
  /** 叙事语义标签：运动连续/情绪转换/节奏卡点/场景切换/揭示 …… 供 AI 按叙事选型 */
  narrativeTags: string[];
  /** 自带音效类别（转场合成拥有衔接处音频；undefined = 静音转场） */
  sfx?: SfxKind;
  paramSpecs: TemplateParamSpec[];
  /** Remotion 合成是否已实现；false = 注册占位，渲染回退内置转场 */
  composable: boolean;
}

export const TRANSITION_TEMPLATE_REGISTRY: TransitionTemplateDef[] = [
  {
    id: 'MorphLens',
    name: '实体承接',
    desc: 'A 画面中的屏幕/镜面实体「长成」B 的全画幅（屏幕替换式承接，前段实体必须可见）',
    durationRange: [0.8, 2],
    defaultDurationSec: 1.2,
    inputs: 'video+video',
    narrativeTags: ['运动连续', '揭示'],
    sfx: 'whoosh',
    paramSpecs: [
      {key: 'lensEase', label: '承接缓动（0 线性 / 1 缓出 / 2 缓入出）', min: 0, max: 2, step: 1, default: 1},
      {key: 'growPower', label: '放大强度（×，1 = 全幅恰好铺满）', min: 0.8, max: 1.6, step: 0.05, default: 1.15},
    ],
    composable: false,
  },
  {
    id: 'WhipThrough',
    name: '镜头推穿',
    desc: '镜头推穿 A 的主体，穿出时已在 B 的世界（相机连续，两侧主体宜居中且同向）',
    durationRange: [0.6, 1.6],
    defaultDurationSec: 0.9,
    inputs: 'video+video',
    narrativeTags: ['运动连续', '节奏卡点'],
    sfx: 'whoosh',
    paramSpecs: [
      {key: 'direction', label: '推穿朝向（1 上 / 2 下 / 3 左 / 4 右）', min: 1, max: 4, step: 1, default: 4},
      {key: 'blurPeak', label: '峰值动态模糊（×）', min: 0, max: 2, step: 0.1, default: 1},
    ],
    composable: false,
  },
  {
    id: 'ObjectSweep',
    name: '物件扫场',
    desc: '一枚 3D 物件横扫画面带走 A 带来 B（物件类型/颜色可参数化，适合品牌色强化）',
    durationRange: [0.8, 1.8],
    defaultDurationSec: 1.1,
    inputs: 'any',
    narrativeTags: ['场景切换', '节奏卡点'],
    sfx: 'impact',
    paramSpecs: [
      {key: 'direction', label: '扫场方向（1 上 / 2 下 / 3 左 / 4 右）', min: 1, max: 4, step: 1, default: 3},
      {key: 'scale', label: '物件大小（×）', min: 0.6, max: 2, step: 0.1, default: 1},
    ],
    composable: false,
  },
];

const REGISTRY_BY_ID = new Map(TRANSITION_TEMPLATE_REGISTRY.map((d) => [d.id, d]));

export const getTransitionTemplate = (id: string): TransitionTemplateDef | undefined =>
  REGISTRY_BY_ID.get(id);

export const isTransitionTemplateId = (id: string): boolean => REGISTRY_BY_ID.has(id);

export interface ListTransitionTemplatesOpts {
  /** 只列 composable=true 的（渲染可用）；缺省全列 */
  readyOnly?: boolean;
  /** 按叙事标签过滤（如「运动连续」） */
  narrativeTag?: string;
  /** inputs 是否允许文字卡/纯色段：true 时排除 video+video 专属条目 */
  allowTextCards?: boolean;
}

export const listTransitionTemplates = (opts: ListTransitionTemplatesOpts = {}): TransitionTemplateDef[] =>
  TRANSITION_TEMPLATE_REGISTRY.filter((d) => {
    if (opts.readyOnly && !d.composable) return false;
    if (opts.narrativeTag && !d.narrativeTags.includes(opts.narrativeTag)) return false;
    if (opts.allowTextCards && d.inputs === 'video+video') return false;
    return true;
  });

/** 数值按 paramSpecs 钳制（未知键丢弃）；与内容模板 customParams 同语义 */
export const clampTransitionTemplateParams = (
  def: TransitionTemplateDef,
  raw: Record<string, unknown> | undefined,
): Record<string, number> | undefined => {
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  let touched = false;
  for (const spec of def.paramSpecs) {
    const v = raw[spec.key];
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    out[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
    touched = true;
  }
  return touched ? out : undefined;
};

/** patch 值校验：id 必须在注册表；返回 {def, params} 或错误清单（params 未给时取模板默认） */
export const validateTransitionTemplateRef = (
  id: unknown,
  params: unknown,
): {ok: true; def: TransitionTemplateDef; params: Record<string, number> | undefined} | {ok: false; errors: string[]} => {
  if (typeof id !== 'string' || !id) return {ok: false, errors: ['transitionTemplateId 必须是转场模板 id 字符串']};
  const def = getTransitionTemplate(id);
  if (!def) {
    return {ok: false, errors: [`未知转场模板 id：${id}（可用：${TRANSITION_TEMPLATE_REGISTRY.map((d) => d.id).join('、')}）`]};
  }
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return {ok: false, errors: ['transitionTemplateParams 必须是对象（键见该模板 paramSpecs）']};
  }
  return {ok: true, def, params: clampTransitionTemplateParams(def, params as Record<string, unknown>)};
};

/** 生成给模型看的紧凑清单文本（工具返回值；composable=false 的注明「合成尚未上线，选了会回退内置转场」） */
export const describeTransitionTemplates = (defs: TransitionTemplateDef[]): string =>
  JSON.stringify(
    defs.map((d) => ({
      id: d.id,
      name: d.name,
      desc: d.desc,
      durationSec: d.durationRange,
      inputs: d.inputs,
      tags: d.narrativeTags,
      params: d.paramSpecs.map((p) => `${p.key}(${p.min}-${p.max}默认${p.default})`),
      ready: d.composable,
      ...(d.composable ? {} : {note: '合成尚未上线：选了会回退到内置转场效果'}),
    })),
    null,
    0,
  );
