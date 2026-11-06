/**
 * 内置音效库（SFX）服务
 *
 * 定位 resources/sfx 目录（开发/打包两种布局，与 sampleProject 同模式），
 * 列出各类音效的变体文件，并转成视频服务器 HTTP URL 供 Remotion <Audio> 播放。
 * 音效文件由 scripts/make-sfx.mjs 程序化合成生成（无版权问题，随安装包分发）。
 */

import fs from 'fs';
import path from 'path';
import type {SfxKind, SfxSources} from '../../shared/types';
import {filePathToHttpUrl} from './videoServer';

const SFX_DIRNAME = 'sfx';
const SFX_KINDS: SfxKind[] = ['whoosh', 'swish', 'sweep', 'drop', 'impact', 'riser', 'click', 'pop', 'ding'];

/** 各类别空表（缺货类别 = 空数组，放置逻辑自动跳过/降级） */
const emptySfxTable = (): Record<SfxKind, string[]> =>
  Object.fromEntries(SFX_KINDS.map((k) => [k, [] as string[]])) as Record<SfxKind, string[]>;

/** resources/sfx 候选路径：开发 = 项目根/resources/sfx；打包 = resources/app/resources/sfx */
const getSfxDirCandidates = (dirname: string): string[] => {
  const from2 = path.resolve(dirname, '../../');
  return [
    path.join(from2, 'resources', SFX_DIRNAME),
    path.join(process.cwd(), 'resources', SFX_DIRNAME),
  ];
};

/** 找第一个存在的 sfx 目录；找不到返回 null（音效整体降级为不放） */
export const findSfxDir = (dirname: string): string | null => {
  for (const dir of getSfxDirCandidates(dirname)) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
};

/** 列出各类音效的变体文件绝对路径（按文件名排序保证确定性；目录缺失返回全空表） */
export const listSfxFiles = (sfxDir: string | null): Record<SfxKind, string[]> => {
  const empty = emptySfxTable();
  if (!sfxDir) return empty;
  let names: string[] = [];
  try {
    names = fs.readdirSync(sfxDir).filter((n) => n.toLowerCase().endsWith('.wav')).sort();
  } catch {
    return empty;
  }
  const out = {...empty};
  for (const kind of SFX_KINDS) {
    out[kind] = names
      .filter((n) => n.startsWith(`${kind}-`))
      .map((n) => path.join(sfxDir, n));
  }
  return out;
};

/** 音效库 URL 表（类别 → 变体 HTTP URL 列表），供渲染端/无头渲染做 MultiSegmentProps.sfxSources */
export const getSfxLibraryUrls = (dirname: string): SfxSources => {
  const files = listSfxFiles(findSfxDir(dirname));
  return Object.fromEntries(
    SFX_KINDS.map((k) => [k, files[k].map(filePathToHttpUrl)]),
  ) as SfxSources;
};
