/**
 * 渲染端音效源解析：从主进程拉取内置音效库 URL 表并缓存（端口/路径随会话固定，拉一次即可）。
 * 供 startRender（导出）与 FullVideoPreview（预览）共用。
 */

import type {SfxSources} from '../../shared/types';

let cache: SfxSources | null = null;

/** 取音效源表（类别 → 变体 URL）。首次调用走 IPC，之后命中缓存；失败返回全空表（音效降级为不放） */
export const getSfxSources = async (): Promise<SfxSources> => {
  if (cache) return cache;
  try {
    cache = await window.api.getSfxLibrary();
  } catch {
    cache = {whoosh: [], swish: [], sweep: [], drop: [], impact: [], riser: [], click: [], pop: [], ding: []};
  }
  return cache;
};
