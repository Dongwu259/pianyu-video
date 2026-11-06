/**
 * consolidate_project（收集工程素材）的纯函数部分：本地路径判定、素材会话 URL 还原、
 * 同名冲突改名、工程引用路径收集。
 * 主进程的复制落地（fs）在 main/ipc/media.ts 的 media:consolidate，这里只做可单测的纯计算。
 */

/** 本地文件路径判定：跳过 http(s)/data/blob 等非本地引用与空串 */
export const isLocalFilePath = (p: string | null | undefined): p is string => {
  if (!p) return false;
  return !/^(https?|data|blob):/i.test(p);
};

/**
 * 素材会话 URL → 原始本地路径（与 renderer/utils/clipPath.ts 的 clipSrcToPath 同逻辑，
 * 这里复制一份纯函数版，供 shared 层与 Node 单测使用——shared 不 import renderer）。
 */
export const unwrapMediaSrc = (src: string): string => {
  if (!src || !/^https?:\/\//i.test(src)) return src;
  try {
    const p = new URL(src).searchParams.get('path');
    if (p) return p;
  } catch {
    // 非法 URL，原样返回
  }
  return src;
};

/**
 * 同名冲突改名：「a.mp4」不可用时依次试「a-1.mp4」「a-2.mp4」…
 * isTaken(候选名) 返回 true = 该名不可用（目标已存在且内容不同）；
 * 返回最终可用候选名（原名可用时原样返回）。
 */
export const uniqueCopyName = (name: string, isTaken: (candidate: string) => boolean): string => {
  if (!isTaken(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i <= 999; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
  // 999 个后缀全冲突是病态场景：退化为时间戳名，保证总能给出不撞名的候选
  return `${base}-${Date.now()}${ext}`;
};

/** 工程媒体引用的结构快照（与 projectStore 状态同形，只取收集所需字段） */
export interface ProjectMediaRefs {
  segments: {
    videos: {src?: string; cursorTrack?: string; stabilization?: {trackPath?: string}; groundTrack?: {trackPath?: string}}[];
    narration?: {path?: string; source?: string};
    overlay?: {path?: string} | null;
  }[];
  bgm?: {path?: string} | null;
  logo?: {path?: string} | null;
}

/**
 * 收集工程引用的全部本地文件路径（去重、保持首次出现顺序）：
 * 片段素材 src（会话 URL 已还原）、鼠标轨迹 sidecar、稳定 sidecar、
 * import 旁白音频（tts 缓存在 userData，跨机不迁移，跳过）、悬浮层图片、BGM、Logo。
 * 远程 URL/data/blob 与空值一律跳过。
 */
export const collectProjectMediaPaths = (project: ProjectMediaRefs): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | null | undefined) => {
    if (!isLocalFilePath(p)) return;
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const seg of project.segments ?? []) {
    for (const v of seg.videos ?? []) {
      push(unwrapMediaSrc(v.src ?? ''));
      push(v.cursorTrack);
      push(v.stabilization?.trackPath);
      push(v.groundTrack?.trackPath);
    }
    if (seg.narration?.source === 'import') push(seg.narration.path);
    push(seg.overlay?.path);
  }
  push(project.bgm?.path);
  push(project.logo?.path);
  return out;
};
