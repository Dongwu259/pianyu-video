/**
 * 参数档位选项解析（P2 参数控件化）
 *
 * 模板参数里约 1/3 是「离档选择」类（主题色/标题字体/驻留节奏/运镜…），历史上以
 * 数字编码滑块暴露，档位含义编码在 label 里：`主题色(0品牌/1青碧/2罗兰紫…)`——
 * 全库格式一致。本模块在注册表装载时把这些 label 统一解析成结构化 options，
 * 参数页据此渲染为「选项组」（色板/字体 chips/场景卡），不用逐条手改 93 处 spec。
 *
 * 解析守卫（不满足则保持滑块，绝不误伤连续数值参数）：
 * - label 以 `(0甲/1乙/…)` 结尾；
 * - 每段以非负整数开头且从 0 连续递增；
 * - 档位数 == max+1 且 min === 0（「推荐档(0无/1-4序号)」这类非档位 label 解不出
 *   连续整数序列，自动落回滑块）。
 */

import type {TemplateMeta, TemplateParamOption, TemplateParamSpec} from './types';
import {THREE_SCENES} from './three-scenes';

/** 主题色档位示意色（与渲染端 rig-utils THEME_ACCENTS 顺序一致；0 品牌色用主蓝） */
const THEME_COLOR_HEX: Record<string, string> = {
  '品牌': '#2563EB',
  '青碧': '#0D9488',
  '罗兰紫': '#7C3AED',
  '琥珀金': '#D97706',
  '玫红': '#DB2777',
  '翠绿': '#16A34A',
};

/** 从 `xxx(0甲/1乙/2丙)` 形态的 label 解析档位；形态不符返回 null */
export const parseLabeledOptions = (label: string): TemplateParamOption[] | null => {
  const m = /^(.*)\((\d+[^()]*)\)$/.exec(label.trim());
  if (!m) return null;
  const parts = m[2].split('/');
  const options: TemplateParamOption[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = /^(\d+)(.*)$/.exec(parts[i].trim());
    if (!seg) return null;
    const value = Number(seg[1]);
    const text = seg[2].trim();
    // 值必须从 0 连续递增；档位名不能以数字/-开头（「推荐档(0无/1-4序号)」这类范围档会吞出 '-4序号'）
    if (value !== i || text.length === 0 || /^[-\d]/.test(text)) return null;
    options.push({value, label: text});
  }
  return options.length >= 2 ? options : null;
};

/** 选项组显示用的干净 label（剥掉档位括注） */
export const cleanParamLabel = (label: string): string => label.replace(/\([^()]*\)$/, '').trim();

/**
 * 就地补全单个 spec 的 options（幂等）。特例：
 * - sceneStyle：档位来自 THREE_SCENES 单一数据源，色点用场景 css 渐变；
 * - themeColor：档位色取 THEME_COLOR_HEX。
 */
export const augmentParamSpecOptions = (spec: TemplateParamSpec): void => {
  if (spec.options) return;
  if (spec.key === 'sceneStyle') {
    spec.options = THREE_SCENES.map((s, i) => ({value: i, label: s.label, ...(s.css ? {color: s.css} : {})}));
    return;
  }
  if (spec.key === 'themeColor') {
    const parsed = parseLabeledOptions(spec.label);
    if (parsed && parsed.length === spec.max + 1) {
      spec.options = parsed.map((o) => ({...o, ...(THEME_COLOR_HEX[o.label] ? {color: THEME_COLOR_HEX[o.label]} : {})}));
    }
    return;
  }
  const parsed = parseLabeledOptions(spec.label);
  if (parsed && spec.min === 0 && parsed.length === spec.max + 1) {
    spec.options = parsed;
  }
};

/** 注册表装载后统一增强（TEMPLATES 内所有 paramSpecs） */
export const augmentTemplateParamOptions = (templates: TemplateMeta[]): void => {
  for (const t of templates) {
    for (const spec of t.paramSpecs ?? []) augmentParamSpecOptions(spec);
  }
};
