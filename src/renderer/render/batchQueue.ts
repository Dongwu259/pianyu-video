/**
 * 批量导出（多比例）队列状态机 — 纯函数模块，便于单元测试
 *
 * 语义约定（RenderPanel 的批量导出区块按此执行）：
 * - 严格串行：RENDER_START 一次只允许一个渲染，队列逐 job 推进（nextJob 只取首个 pending）；
 * - 失败即停：当前 job 标记 failed 后，其余 pending 一律标记 skipped（同一工程批量导出，
 *   一个失败多为系统性原因——目录不可信/授权/磁盘，继续渲染大概率连环失败）；
 * - 取消清空：cancelRest 返回空队列（当前渲染由 RENDER_CANCEL 终止，其结果随队列一并丢弃）。
 */

/** 批量任务状态：等待 / 渲染中 / 完成 / 失败 / 已跳过 */
export type BatchJobStatus = 'pending' | 'rendering' | 'done' | 'failed' | 'skipped';

export interface BatchJob {
  /** 稳定标识（取 aspectRatioId，同一批次内唯一） */
  id: string;
  /** 画幅预设 id（'16-9' 等），决定 compositionId 与输出尺寸 */
  aspectRatioId: string;
  /** 展示名（'16:9 横屏'） */
  label: string;
  /** 输出文件名（不含扩展名，已带画幅后缀，如「片语-16x9」） */
  filename: string;
  status: BatchJobStatus;
  /** 渲染进度 0-100（仅 rendering 有意义） */
  progress: number;
  /** 失败原因（status === 'failed' 时） */
  error?: string;
  /** 实际输出路径（status === 'done' 时） */
  outputPath?: string;
}

/** 画幅预设 id → 文件名后缀（'16-9' → '16x9'，与「片语-16x9.mp4」命名约定一致） */
export const ratioIdToSuffix = (aspectRatioId: string): string => aspectRatioId.replace(/-/g, 'x');

/** 组装批量输出文件名（不含扩展名）：`<base>-<画幅后缀>` */
export const buildBatchFilename = (baseName: string, aspectRatioId: string): string =>
  `${baseName}-${ratioIdToSuffix(aspectRatioId)}`;

/** 由勾选项创建初始队列（全部 pending，顺序即勾选顺序） */
export const createBatchJobs = (
  items: {aspectRatioId: string; label: string; filename: string}[],
): BatchJob[] =>
  items.map((item) => ({
    id: item.aspectRatioId,
    aspectRatioId: item.aspectRatioId,
    label: item.label,
    filename: item.filename,
    status: 'pending' as const,
    progress: 0,
  }));

/**
 * 推进队列：把首个 pending 标记为 rendering 并返回它。
 * 没有 pending 时 job 为 null（队列耗尽）。不改动其它 job。
 */
export const nextJob = (jobs: BatchJob[]): {jobs: BatchJob[]; job: BatchJob | null} => {
  const index = jobs.findIndex((j) => j.status === 'pending');
  if (index === -1) return {jobs, job: null};
  const next = jobs.map((j, i) => (i === index ? {...j, status: 'rendering' as const, progress: 0} : j));
  return {jobs: next, job: next[index]};
};

/** 更新 rendering job 的进度（无该 job 或非 rendering 时原样返回） */
export const updateJobProgress = (jobs: BatchJob[], id: string, progress: number): BatchJob[] =>
  jobs.map((j) => (j.id === id && j.status === 'rendering' ? {...j, progress} : j));

/** 当前 job 完成：status → done（进度钉在 100，记录实际输出路径） */
export const markJobDone = (jobs: BatchJob[], id: string, outputPath: string): BatchJob[] =>
  jobs.map((j) =>
    j.id === id && j.status === 'rendering'
      ? {...j, status: 'done' as const, progress: 100, outputPath}
      : j,
  );

/** 当前 job 失败：status → failed 并记录原因；其余 pending 一律 skipped（失败即停语义）。
 *  仅对 rendering 中的 job 生效，其它情况原样返回 */
export const markJobFailed = (jobs: BatchJob[], id: string, error: string): BatchJob[] => {
  const target = jobs.find((j) => j.id === id);
  if (!target || target.status !== 'rendering') return jobs;
  return jobs.map((j) => {
    if (j.id === id) {
      return {...j, status: 'failed' as const, error};
    }
    if (j.status === 'pending') {
      return {...j, status: 'skipped' as const};
    }
    return j;
  });
};

/** 取消：清空整个队列（当前渲染由主进程 RENDER_CANCEL 终止，无需保留状态） */
export const cancelRest = (): BatchJob[] => [];

/** 队列是否仍在运行（有待渲染或渲染中的 job） */
export const isBatchRunning = (jobs: BatchJob[]): boolean =>
  jobs.some((j) => j.status === 'pending' || j.status === 'rendering');
