/**
 * 内置示例工程（sample-project）服务
 *
 * 说明:
 * - 本模块只做纯逻辑（定位资源目录 / 复制到 userData / 相对媒体路径重写），
 *   不 import electron，因此可以在纯 Node 环境直接做单元测试；
 *   IPC 入口在 src/main/ipc/project.ts（sample:open）。
 * - resources/sample-project/sample.vtproj 中的媒体引用一律为相对路径（media/xxx），
 *   打开时复制到 userData/sample-project 后重写为该副本目录下的绝对路径，
 *   保证工程文件本身可随安装包分发、跨机器可用。
 */

import fs from 'fs';
import path from 'path';
import {readProjectFile, saveProjectFile, collectMediaPaths} from './projectFile';
import type {ProjectFilePayload, ProjectFileData} from './projectFile';

/** 示例工程目录名（resources 下的源目录与 userData 下的副本目录同名） */
export const SAMPLE_PROJECT_DIRNAME = 'sample-project';
/** 示例工程文件名 */
export const SAMPLE_PROJECT_FILENAME = 'sample.vtproj';

/**
 * 示例工程源目录的候选路径（开发 / 打包两种布局，与 renderer.ts findEntryPoint 同模式）。
 * 开发环境: __dirname = <project>/out/main → 上 2 级 = 项目根
 * 打包后:   __dirname = <app>/resources/app/out/main → 上 2 级 = resources/app
 */
export const getSampleSourceCandidates = (dirname: string): string[] => {
  const from2 = path.resolve(dirname, '../../');
  return [
    path.join(from2, 'resources', SAMPLE_PROJECT_DIRNAME),
    // 兜底：应用以项目根为工作目录启动时
    path.join(process.cwd(), 'resources', SAMPLE_PROJECT_DIRNAME),
  ];
};

/** 在候选路径中找第一个包含 sample.vtproj 的目录；都找不到返回 null */
export const findSampleSourceDir = (candidates: string[]): string | null => {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, SAMPLE_PROJECT_FILENAME))) return dir;
  }
  return null;
};

/**
 * 把示例工程从源目录复制到目标目录（递归）。
 * 目标已存在 sample.vtproj 时：版本相同或更新则跳过（幂等：不覆盖用户可能编辑过的副本）；
 * 源的 sampleVersion 更新（重制示例工程）时覆盖刷新旧副本。
 */
export const ensureSampleCopy = (srcDir: string, destDir: string): void => {
  const srcFile = path.join(destDir, SAMPLE_PROJECT_FILENAME);
  if (fs.existsSync(srcFile)) {
    // 内置示例升级（sampleVersion 更大）时刷新旧副本；同版本不动（保护用户编辑）
    try {
      const destVer = JSON.parse(fs.readFileSync(srcFile, 'utf8')).sampleVersion ?? 1;
      const srcVer = JSON.parse(fs.readFileSync(path.join(srcDir, SAMPLE_PROJECT_FILENAME), 'utf8')).sampleVersion ?? 1;
      if (srcVer <= destVer) return;
      fs.rmSync(destDir, {recursive: true, force: true});
    } catch {
      return; // 版本读取失败：按旧语义跳过，不覆盖
    }
  }
  fs.cpSync(srcDir, destDir, {recursive: true});
};

/** 判断媒体引用是否需要重写（相对路径才重写；绝对路径与 http(s) URL 原样保留） */
export const isRelativeMediaRef = (ref: string): boolean => {
  if (!ref) return false;
  if (/^https?:\/\//i.test(ref)) return false;
  return !path.isAbsolute(ref);
};

/** 单个媒体引用重写：相对路径解析到 baseDir 下并归一化 */
const rewriteRef = (ref: string, baseDir: string): string =>
  isRelativeMediaRef(ref) ? path.resolve(baseDir, ref) : ref;

/**
 * 把工程数据中的相对媒体路径重写为 baseDir 下的绝对路径。
 * 覆盖范围与 collectMediaPaths 一致：片段素材 src / 导入旁白 path / 背景音乐 path / Logo path。
 * 返回新对象，不改入参。
 */
export const rewriteMediaPathsToAbsolute = (data: ProjectFileData, baseDir: string): ProjectFileData => ({
  ...data,
  segments: data.segments.map((seg) => ({
    ...seg,
    videos: seg.videos.map((clip) => ({...clip, src: rewriteRef(clip.src, baseDir)})),
    narration:
      seg.narration?.source === 'import' && seg.narration.path
        ? {...seg.narration, path: rewriteRef(seg.narration.path, baseDir)}
        : seg.narration,
  })),
  bgm: data.bgm?.path ? {...data.bgm, path: rewriteRef(data.bgm.path, baseDir)} : data.bgm,
  logo: data.logo?.path ? {...data.logo, path: rewriteRef(data.logo.path, baseDir)} : data.logo,
});

/**
 * 从副本目录加载示例工程：读 sample.vtproj → 重写相对媒体路径为绝对路径 → 回写副本
 * （回写后该副本可直接被 project:openPath / 最近工程列表再次打开）。
 * 返回 payload（data 已重写）与副本工程文件路径。
 */
export const loadSampleProjectCopy = (
  destDir: string,
): {payload: ProjectFilePayload; projectPath: string; mediaPaths: string[]} => {
  const projectPath = path.join(destDir, SAMPLE_PROJECT_FILENAME);
  const payload = readProjectFile(projectPath);
  const data = rewriteMediaPathsToAbsolute(payload.data, destDir);
  saveProjectFile(projectPath, {...payload, data});
  return {payload: {...payload, data}, projectPath, mediaPaths: collectMediaPaths(data)};
};
