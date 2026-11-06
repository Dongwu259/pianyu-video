/**
 * AI 生成模板（三期 D2）主进程服务：受限 TSX → esbuild 编译 → userData 持久化。
 *
 * 主进程是唯一的编译点：渲染进程（含 LLM 工具执行器）只提交源码，
 * 扫描（shared/generated-template）与编译（本模块）都在这里权威执行，
 * 渲染端拿到的 compiled 永远是主进程产物，不信任渲染端自编译结果。
 *
 * esbuild 是 @remotion/bundler 的传递依赖（node_modules 根已提升，打包经
 * asarUnpack 显式放出，electron.vite.config external 已列），transform 无 bundle
 * 毫秒级完成——源码禁止 import，无需依赖解析。
 */

import {
  GENERATED_TEMPLATE_ID_PREFIX,
  GENERATED_TEMPLATE_MAX_COUNT,
  scanGeneratedSource,
  validateGeneratedTemplateDef,
  type GeneratedTemplateDef,
} from '../../shared/generated-template';
import {sanitizeTextSlots} from '../../shared/custom-template';
import type {TemplateParamSpec} from '../../shared/types';
import {compileGeneratedSource} from './templateGenCompile';
import {getGeneratedTemplates, setGeneratedTemplates} from './store';

export {compileGeneratedSource} from './templateGenCompile';
export type {CompileResult} from './templateGenCompile';

export interface SaveGeneratedPayload {
  /** 传入 = 覆盖迭代该模板（沿用 id，故事板引用不断）；缺省 = 新建 */
  templateId?: string;
  name: string;
  description: string;
  source: string;
  duration: number;
  paramSpecs?: TemplateParamSpec[];
  /** 文字槽位声明（可选）：组件实际消费的 props.text 字段。
   *  非法值剔除并警告；覆盖迭代缺省时沿用旧声明（显式传 [] 表示不展示文字）。 */
  textSlots?: string[];
}

export interface SaveGeneratedResult {
  ok: boolean;
  errors?: string[];
  /** 非致命提醒（如 textSlots 非法值被剔除），面向 LLM 回告 */
  warnings?: string[];
  def?: GeneratedTemplateDef;
  list?: GeneratedTemplateDef[];
}

/**
 * 扫描 → 编译 → 落库（新增或覆盖）。任何一步失败都不落盘，errors 直接回喂 LLM 改稿。
 */
export const saveGeneratedTemplate = (payload: SaveGeneratedPayload): SaveGeneratedResult => {
  const scan = scanGeneratedSource(payload.source);
  if (!scan.ok) return {ok: false, errors: scan.errors};

  const compiled = compileGeneratedSource(payload.source);
  if (!compiled.ok || !compiled.code) return {ok: false, errors: compiled.errors ?? ['编译失败']};

  const list = getGeneratedTemplates();
  const existing = payload.templateId ? list.find((t) => t.id === payload.templateId) : undefined;
  if (payload.templateId && !existing) {
    return {ok: false, errors: [`要覆盖的模板 ${payload.templateId} 不存在（留空 templateId 表示新建）`]};
  }
  if (!existing && list.length >= GENERATED_TEMPLATE_MAX_COUNT) {
    return {ok: false, errors: [`生成模板已达上限（${GENERATED_TEMPLATE_MAX_COUNT} 个），可先删除不用的或覆盖迭代现有模板`]};
  }

  // 文字槽位：显式给出时清洗（非法值剔除并警告）；覆盖迭代未给出时沿用旧声明
  const warnings: string[] = [];
  let textSlots: string[] | undefined;
  if (payload.textSlots !== undefined) {
    const s = sanitizeTextSlots(payload.textSlots);
    textSlots = s.slots;
    if (s.dropped.length > 0) {
      warnings.push(`textSlots 含非法槽位 ${s.dropped.map((d) => `「${d}」`).join('')}，已剔除（合法值：title/subtitle/features/brandName）`);
    }
  } else if (existing) {
    textSlots = existing.textSlots;
  }

  const now = Date.now();
  const def: GeneratedTemplateDef = {
    id: existing?.id ?? `${GENERATED_TEMPLATE_ID_PREFIX}${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: payload.name.trim(),
    description: payload.description.trim(),
    source: payload.source,
    compiled: compiled.code,
    duration: Math.round(payload.duration * 10) / 10,
    ...(payload.paramSpecs && payload.paramSpecs.length > 0 ? {paramSpecs: payload.paramSpecs} : {}),
    ...(textSlots !== undefined ? {textSlots} : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const structural = validateGeneratedTemplateDef(def);
  if (structural.length > 0) return {ok: false, errors: structural};

  const next = existing ? list.map((t) => (t.id === def.id ? def : t)) : [...list, def];
  setGeneratedTemplates(next);
  return {ok: true, def, list: next, ...(warnings.length > 0 ? {warnings} : {})};
};

export const deleteGeneratedTemplate = (id: string): GeneratedTemplateDef[] => {
  const next = getGeneratedTemplates().filter((t) => t.id !== id);
  setGeneratedTemplates(next);
  return next;
};

/** 存量 list 校验（坏数据不进渲染进程；返回清理后的列表，有丢弃时回写） */
export const listValidGeneratedTemplates = (): GeneratedTemplateDef[] => {
  const list = getGeneratedTemplates();
  const valid = list.filter((def) => validateGeneratedTemplateDef(def).length === 0);
  if (valid.length !== list.length) {
    console.warn(`[template-gen] 丢弃 ${list.length - valid.length} 个结构非法的存量生成模板并回写清理`);
    setGeneratedTemplates(valid);
  }
  return valid;
};
