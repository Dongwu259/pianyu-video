/**
 * 故事板完整性体检（纯函数，零 LLM 成本的宿主护栏）——request_render 前的收尾检查。
 *
 * 动机（2026-09 端侧实验）：小模型会漏收尾步骤——2B 模型搭完整故事板但全程未设转场。
 * 检查不阻断渲染：问题随工具结果回告模型（可修复后重渲），渲染照常进行。
 * 与 readability-lint.ts 分工：那边管"文案可读性"（review_render 的本地半边），
 * 这里管"结构完整性"（缺文案/缺素材/缺转场这类漏步骤问题）。
 */

import type {Segment} from './types';

export type CompletenessRule = 'empty-title' | 'no-media' | 'no-transition';

export interface CompletenessIssue {
  /** warn = 结构缺失应修复；info = 建议项（硬切风格也可能是有意为之） */
  severity: 'warn' | 'info';
  /** 关联片段下标（no-transition 为全片级，缺省） */
  segmentIndex?: number;
  rule: CompletenessRule;
  message: string;
  suggestion: string;
}

export const lintStoryboardCompleteness = (input: {segments: Segment[]}): CompletenessIssue[] => {
  const issues: CompletenessIssue[] = [];
  const {segments} = input;
  segments.forEach((seg, i) => {
    if (!seg.text?.title?.trim()) {
      issues.push({
        severity: 'warn', segmentIndex: i, rule: 'empty-title',
        message: `第 ${i + 1} 段没有主标题文案`,
        suggestion: '用 update_segment 补 title（≤30 字）；纯 3D 场景模板等不展示文字的段可忽略',
      });
    }
    if (seg.videos.length === 0) {
      issues.push({
        severity: 'warn', segmentIndex: i, rule: 'no-media',
        message: `第 ${i + 1} 段没有素材`,
        suggestion: '提醒用户上传，或用 import_segment_media 导入；纯 3D 场景/纯文字模板的段可忽略',
      });
    }
  });
  const hasTransition = segments.some((s) => s.transition && s.transition !== 'none');
  if (segments.length > 1 && !hasTransition) {
    issues.push({
      severity: 'info', rule: 'no-transition',
      message: '全片没有设置任何转场（段间全部硬切）',
      suggestion: '按叙事节奏给段间设 1-2 种转场（update_segment 的 transition 字段）；刻意硬切风格可忽略',
    });
  }
  return issues;
};
