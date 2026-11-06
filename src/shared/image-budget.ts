/**
 * 看图预算（纯逻辑，可单测）——防小模型/健忘 agent 重复抽帧把上下文烧穿。
 *
 * 动机（2026-09 端侧实验，scripts/.scratch/vlm-agent-bench.mjs）：
 * 2B 模型一次任务对 3 段素材重复看图 10 张，32k 上下文第 19 步耗尽；
 * 768px 帧在 Qwen3-VL 约 1.4k token/张，重复看图是上下文的第一大消耗。
 * 双闸：同一帧（素材 + 0.5s 时间桶）最多重发 2 次；会话附图总量上限。
 * 消费方：view_segment_frame / view_media_frames 执行器（panel 会话实例 + MCP 共享实例）。
 */

/** 时间桶宽度（秒）：同帧判定容差，抽帧时间点有浮点抖动 */
export const FRAME_BUCKET_SEC = 0.5;

/** 同一帧最多附图次数（首次 + 1 次重看；panel 历史里旧图被替换成占位后允许再看一次） */
export const IMAGE_BUDGET_MAX_PER_FRAME = 2;

/** 会话附图总量上限 */
export const IMAGE_BUDGET_MAX_TOTAL = 30;

export interface ImageBudget {
  total: number;
  perKey: Map<string, number>;
}

export const createImageBudget = (): ImageBudget => ({total: 0, perKey: new Map()});

/** 预算键：素材路径 + 时间桶（路径用 clipSrcToPath 归一化后的绝对路径） */
export const frameBudgetKey = (src: string, timeSec: number): string =>
  `${src}@${Math.round(timeSec / FRAME_BUCKET_SEC)}`;

/** 复位预算：新故事板（set_storyboard）= 新工作会话，此前批次的看图配额不应累积占用 */
export const resetImageBudget = (budget: ImageBudget): void => {
  budget.total = 0;
  budget.perKey.clear();
};

export interface ImageBudgetVerdict {
  allow: boolean;
  /** 拒绝原因（回告模型，指引其基于已有信息决策） */
  reason?: string;
}

/** 申请附一张图；允许时占用配额（有副作用），拒绝时返回原因 */
export const takeImageBudget = (budget: ImageBudget, key: string): ImageBudgetVerdict => {
  if (budget.total >= IMAGE_BUDGET_MAX_TOTAL) {
    return {allow: false, reason: `会话附图已达上限（${IMAGE_BUDGET_MAX_TOTAL} 张），请基于已看画面与素材元数据决策`};
  }
  const sent = budget.perKey.get(key) ?? 0;
  if (sent >= IMAGE_BUDGET_MAX_PER_FRAME) {
    return {allow: false, reason: `该帧已附图 ${sent} 次（上限 ${IMAGE_BUDGET_MAX_PER_FRAME}），请勿重复抽帧；如需其它时刻请指定不同 timeSec`};
  }
  budget.perKey.set(key, sent + 1);
  budget.total += 1;
  return {allow: true};
};
