/**
 * 工程保存滚动备份服务（纯逻辑，不 import electron，可在纯 Node 环境单测）
 *
 * 背景（真实踩坑）：手滑把坏状态保存覆盖了好工程，旧内容无法找回。
 * 规则：显式保存（保存/另存为/MCP save_project）覆盖已存在的目标文件之前，
 * 把旧文件复制到备份目录（userData/project-backups/）：
 *   <目标文件名>.<yyyyMMdd-HHmmss>.vtproj
 * 同一目标文件按文件名前缀最多保留最近 PROJECT_BACKUP_KEEP 份，超出删最旧；
 * 首次保存（目标不存在）不备份；autosave 不经过本模块。
 * 任何失败都收敛为 warning 返回，绝不 throw——保存动作必须能继续。
 */

import fs from 'fs';
import path from 'path';

/** 每个目标文件保留的备份份数上限 */
export const PROJECT_BACKUP_KEEP = 5;

/** 备份文件名时间戳：yyyyMMdd-HHmmss（本地时间；定长格式，字典序 = 时间序） */
export const formatBackupStamp = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** 拼备份文件名：foo.vtproj + 时间戳 → foo.vtproj.20260902-153000.vtproj */
export const buildBackupName = (targetName: string, stamp: string): string =>
  `${targetName}.${stamp}.vtproj`;

/** 目标文件名之后的部分必须严格是「.时间戳.vtproj」才算备份（挡掉 malformed / 同前缀其它文件） */
const BACKUP_SUFFIX_RE = /^\.\d{8}-\d{6}\.vtproj$/;

/** 从目录文件名清单挑出某目标文件的备份名（其它工程/无关文件一律忽略） */
export const listBackupsFor = (dirFiles: string[], targetName: string): string[] =>
  dirFiles.filter((f) => f.startsWith(targetName) && BACKUP_SUFFIX_RE.test(f.slice(targetName.length)));

/**
 * prune 决策（纯函数）：备份文件名清单 → 保留/删除分组。
 * 时间戳定长，字典序降序即时间降序，保留前 keep 份、其余删除。
 */
export const planBackupPrune = (backupNames: string[], keep: number): {keep: string[]; remove: string[]} => {
  const sorted = [...backupNames].sort().reverse();
  return {keep: sorted.slice(0, keep), remove: sorted.slice(keep)};
};

export interface RollingBackupResult {
  /** 是否实际写了备份（目标不存在 = 首次保存，false） */
  backedUp: boolean;
  /** 写出的备份文件完整路径（backedUp 时有值） */
  backupPath?: string;
  /** 本次 prune 实际删除的旧备份完整路径 */
  pruned: string[];
  /** 备份/清理失败的中文警告（调用方上报告警即可，不阻断保存） */
  warning?: string;
}

/**
 * 覆盖保存前做滚动备份 + prune。
 * opts.now 可注入时钟（同秒多次保存会撞同名备份，测试用递增时钟模拟多天）。
 */
export const createRollingBackup = (
  targetPath: string,
  backupDir: string,
  opts: {keep?: number; now?: () => Date} = {},
): RollingBackupResult => {
  const keep = opts.keep ?? PROJECT_BACKUP_KEEP;
  const now = opts.now ?? (() => new Date());
  try {
    // 首次保存（目标不存在）不备份；目录类异常路径也不算
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return {backedUp: false, pruned: []};
    }
    fs.mkdirSync(backupDir, {recursive: true});
    const targetName = path.basename(targetPath);
    const backupPath = path.join(backupDir, buildBackupName(targetName, formatBackupStamp(now())));
    fs.copyFileSync(targetPath, backupPath);
    // prune：只清本目标前缀的备份，其它工程/无关文件不动
    const {remove} = planBackupPrune(listBackupsFor(fs.readdirSync(backupDir), targetName), keep);
    const pruned: string[] = [];
    for (const name of remove) {
      const p = path.join(backupDir, name);
      try {
        fs.unlinkSync(p);
        pruned.push(p);
      } catch {
        // 单个删不掉不阻断（下次备份会再尝试）
      }
    }
    return {backedUp: true, backupPath, pruned};
  } catch (err) {
    // 磁盘满/权限等：只告警，由调用方决定不阻断保存
    return {backedUp: false, pruned: [], warning: err instanceof Error ? err.message : String(err)};
  }
};
