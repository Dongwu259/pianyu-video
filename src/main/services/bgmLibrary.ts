/**
 * 内置配乐库（BGM）服务
 *
 * 定位 resources/bgm 目录（开发/打包两种布局，与 sfxLibrary 同模式），
 * 把 BGM_CREDITS 署名数据与磁盘上实际存在的曲子对上，产出内置曲库条目
 * （绝对路径 + 情绪槽位 + 署名信息）。渲染端点选后与本地曲库走完全相同的
 * 数据路径（getVideoHttpUrl + analyzeMusic），选中曲带 credit 字段——
 * CC BY 4.0 有署名义务，渲染端自动烧录片尾署名（强制署名，用户拍板 2026-10-13）。
 *
 * 许可差异记档：resources/sfx 是程序化合成（零版权随包分发）；resources/bgm
 * 是 Kevin MacLeod / incompetech 的 CC BY 4.0（可随包分发但须署名）。
 */

import fs from 'fs';
import path from 'path';
import {BGM_CREDITS, BGM_MOOD_LABELS, bgmMoodFromFile, type BgmBuiltinTrack} from '../../shared/bgm-credits';

const BGM_DIRNAME = 'bgm';

/** resources/bgm 候选路径（与 sfxLibrary 完全同公式：开发 = 项目根/resources；打包经 cwd 兜底） */
const getBgmDirCandidates = (dirname: string): string[] => {
  const from2 = path.resolve(dirname, '../../');
  return [
    path.join(from2, 'resources', BGM_DIRNAME),
    path.join(process.cwd(), 'resources', BGM_DIRNAME),
  ];
};

/** 找第一个存在的 bgm 目录；找不到返回 null（内置曲库区块整体不显示） */
export const findBgmDir = (dirname: string): string | null => {
  for (const dir of getBgmDirCandidates(dirname)) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
};

/**
 * 内置曲库条目表（credits ∩ 磁盘存在；按 credits 顺序保证确定性）。
 * 目录缺失/全缺货返回空数组——UI 显示空态，不阻塞任何功能。
 */
export const listBuiltinBgm = (dirname: string): BgmBuiltinTrack[] => {
  const dir = findBgmDir(dirname);
  if (!dir) return [];
  return BGM_CREDITS.filter((c) => fs.existsSync(path.join(dir, c.file))).map((c) => {
    const mood = bgmMoodFromFile(c.file);
    return {
      ...c,
      mood,
      moodLabel: BGM_MOOD_LABELS[mood] ?? mood,
      path: path.join(dir, c.file),
    };
  });
};
