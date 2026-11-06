/**
 * 成片可读性体检（纯函数，零 LLM 成本的本地质量守门）
 *
 * 规则来自字幕/短视频行业的硬规格（BBC/Netflix 字幕指南与短视频实践的共识）：
 * - 停留时长：观众阅读速度约 13 字符/秒，一段可见文字至少要停留 ceil(字数/13) 秒；
 * - 行宽：每行 ≤30 字符（超过会被模板缩小字号或折行成蚊字）；
 * - 行数：要点条数 >5 时多数模板排版拥挤（同屏 3 行是舒适上限）；
 * - 标题：>20 字的标题在标题类模板里会失去大字冲击力；
 * - hook 密度：前 3 秒画面变化（含首帧）≥3 次（约每秒 1 次）是快节奏宣传片的留存基线。
 *
 * 消费方：review_render 工具（视觉审片的本地半边，成片未渲染时也能先体检文案）。
 */

import type {Segment} from './types';

/** 阅读速度（字符/秒） */
export const READABILITY_CHARS_PER_SEC = 13;
/** 单行字符上限 */
export const READABILITY_MAX_LINE_CHARS = 30;
/** 标题字符上限（超过失去大字冲击力） */
export const READABILITY_MAX_TITLE_CHARS = 20;
/** 要点条数的信息上限（超过提示拆段） */
export const READABILITY_MAX_FEATURES = 5;
/** hook 检查窗口（秒） */
export const HOOK_WINDOW_SEC = 3;
/** 教程单步主段时长上限（秒）——操作视频共识 8-20s/步 */
export const TUTORIAL_MAX_STEP_SEC = 20;

export type ReadabilityRule =
  | 'dwell'
  | 'line-length'
  | 'line-count'
  | 'title-length'
  | 'caption-dwell'
  | 'caption-length'
  | 'hook-density'
  | 'tutorial-step-length'
  | 'tutorial-step-title';

export interface ReadabilityIssue {
  /** warn = 明确影响可读性应修改；info = 建议项（节奏/风格考量） */
  severity: 'warn' | 'info';
  /** 关联片段下标（hook-density 为全片级，缺省） */
  segmentIndex?: number;
  rule: ReadabilityRule;
  message: string;
  suggestion: string;
}

const charCount = (s: string | undefined | null): number => (s ? Array.from(s).length : 0);

/** 一段里观众实际要读的字量估算：标题 + 副标题 + 前 3 条要点（多数模板同屏至多 3 行） */
export const estimateVisibleChars = (seg: Segment): number =>
  charCount(seg.text?.title) + charCount(seg.text?.subtitle) + (seg.text?.features ?? []).slice(0, 3).reduce((n, f) => n + charCount(f), 0);

/** 字符数按阅读速度需要的最短停留秒数（向上取整到 0.5s 档） */
export const minDwellSec = (chars: number): number => Math.ceil((chars / READABILITY_CHARS_PER_SEC) * 2) / 2;

/**
 * 对故事板跑可读性体检。
 * 输入 segments（与工程同构）；返回问题清单（warn 在前）。
 */
export const lintReadability = (input: {segments: Segment[]}): ReadabilityIssue[] => {
  const {segments} = input;
  const issues: ReadabilityIssue[] = [];

  // ====== 逐段规则 ======
  segments.forEach((seg, i) => {
    const dur = seg.duration || 8;

    // 1) 停留时长：字数 / 时长超阅读速度（0.3s 宽限吸收转场重叠）
    const chars = estimateVisibleChars(seg);
    if (chars > 0) {
      const need = minDwellSec(chars);
      if (dur + 0.3 < need) {
        issues.push({
          severity: 'warn',
          segmentIndex: i,
          rule: 'dwell',
          message: `第 ${i + 1} 段可见文字约 ${chars} 字，时长 ${dur}s，按 ${READABILITY_CHARS_PER_SEC} 字/秒至少需要 ${need}s`,
          suggestion: `延长该段时长到 ≥${need}s（有 BGM 时可用 align_beats 吸附到节拍），或删减文案`,
        });
      }
    }

    // 2) 行宽：要点/副标题超 30 字
    const longLines: string[] = [];
    (seg.text?.features ?? []).forEach((f) => {
      if (charCount(f) > READABILITY_MAX_LINE_CHARS) longLines.push(f);
    });
    if (charCount(seg.text?.subtitle) > READABILITY_MAX_LINE_CHARS) longLines.push(seg.text?.subtitle || '');
    if (longLines.length > 0) {
      issues.push({
        severity: 'warn',
        segmentIndex: i,
        rule: 'line-length',
        message: `第 ${i + 1} 段有 ${longLines.length} 行超过 ${READABILITY_MAX_LINE_CHARS} 字（如「${longLines[0].slice(0, 12)}…」）`,
        suggestion: `拆成多行要点或精简文案；过长行会被模板缩小字号，观感变差`,
      });
    }

    // 3) 标题过长（信息级）
    if (charCount(seg.text?.title) > READABILITY_MAX_TITLE_CHARS) {
      issues.push({
        severity: 'info',
        segmentIndex: i,
        rule: 'title-length',
        message: `第 ${i + 1} 段标题 ${charCount(seg.text?.title)} 字，超过 ${READABILITY_MAX_TITLE_CHARS} 字`,
        suggestion: '标题压缩成一句短语，细节挪到要点/字幕里，保留大字冲击力',
      });
    }

    // 4) 要点条数（信息级）
    const featureCount = (seg.text?.features ?? []).length;
    if (featureCount > READABILITY_MAX_FEATURES) {
      issues.push({
        severity: 'info',
        segmentIndex: i,
        rule: 'line-count',
        message: `第 ${i + 1} 段有 ${featureCount} 条要点，超出多数模板的舒适排版（≤${READABILITY_MAX_FEATURES}）`,
        suggestion: '删减要点或拆成两段（每段 3-4 条 + 各自素材）',
      });
    }

    // 5) 字幕行：行宽 + 停留
    (seg.captions ?? []).forEach((cap, ci) => {
      const cc = charCount(cap.text);
      const span = Math.max(0, cap.endSec - cap.startSec);
      if (cc > READABILITY_MAX_LINE_CHARS) {
        issues.push({
          severity: 'warn',
          segmentIndex: i,
          rule: 'caption-length',
          message: `第 ${i + 1} 段第 ${ci + 1} 行字幕 ${cc} 字，超 ${READABILITY_MAX_LINE_CHARS} 字`,
          suggestion: '长句拆成两行短字幕（按语义断句）',
        });
      }
      if (cc > 0 && span > 0 && span + 0.1 < cc / READABILITY_CHARS_PER_SEC) {
        issues.push({
          severity: 'warn',
          segmentIndex: i,
          rule: 'caption-dwell',
          message: `第 ${i + 1} 段第 ${ci + 1} 行字幕 ${cc} 字只停留 ${span.toFixed(1)}s（需 ≥${(cc / READABILITY_CHARS_PER_SEC).toFixed(1)}s）`,
          suggestion: '拉长该行字幕时间窗或精简句子',
        });
      }
    });
  });

  // ====== 全片规则 ======
  // hook 密度：前 3 秒的画面变化次数（段起点 = 一次变化，含首帧）
  if (segments.length > 1) {
    const changes = [1]; // 首帧
    let acc = 0;
    for (let i = 0; i < segments.length - 1; i++) {
      acc += segments[i].duration || 8;
      if (acc <= HOOK_WINDOW_SEC) changes.push(1);
    }
    const total = changes.reduce((n, v) => n + v, 0);
    if (total < HOOK_WINDOW_SEC && (segments[0]?.duration || 8) + (segments[1]?.duration || 8) >= HOOK_WINDOW_SEC) {
      issues.push({
        severity: 'info',
        rule: 'hook-density',
        message: `前 ${HOOK_WINDOW_SEC} 秒画面仅变化 ${total} 次（含首帧），快节奏宣传片建议每秒 ≥1 次`,
        suggestion: '把首段拆成 2-3 个短切段（1s 左右），或换内部动效强的模板（节拍大字/卡片汇聚）',
      });
    }
  }

  // ====== 教程专项（1.6）：故事板含教程步骤卡（≥2）时追加教程体检 ======
  const stepCardCount = segments.filter((s) => s.templateId === 'TutorialStep').length;
  if (stepCardCount >= 2) {
    segments.forEach((seg, i) => {
      const dur = seg.duration || 8;
      if (seg.templateId === 'ScreenDemo' && dur > TUTORIAL_MAX_STEP_SEC) {
        issues.push({
          severity: 'warn',
          segmentIndex: i,
          rule: 'tutorial-step-length',
          message: `第 ${i + 1} 段（教程步骤主段）时长 ${dur}s，超过单步建议上限 ${TUTORIAL_MAX_STEP_SEC}s`,
          suggestion: '操作视频一步 8-20s 观众跟得上：过长步骤用 split_segment 拆成两步，或 set_segment_trim 裁掉步内停顿',
        });
      }
      if (seg.templateId === 'TutorialStep' && charCount(seg.text?.subtitle) === 0) {
        issues.push({
          severity: 'info',
          segmentIndex: i,
          rule: 'tutorial-step-title',
          message: `第 ${i + 1} 段步骤卡没有步骤标题`,
          suggestion: '副标题用一句动词短语概括这一步（如「新建一个项目」），观众才知道每步在做什么',
        });
      }
    });
  }

  // warn 在前、info 在后；同类内保持段序
  const rank = {warn: 0, info: 1} as const;
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
};
