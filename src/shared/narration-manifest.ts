/**
 * 旁白单一源 manifest（管线路线图 P1-3）——词表/段位/新鲜度契约（纯函数，单测锚定）
 *
 * v11 实证的漂移事故未遂：改词「一搜即达」要同步 make-narration.py 的 LINES 和装配 NAR
 * 表两处。本模块定契约：**manifest 是唯一词源**（`{file, seg, text}[]` + 重生成命令），
 * 生成器（python）与装配（lib-promo）都只读它；生成器写 stamp（每句 mp3 对应的文本
 * sha1），装配渲前对账——manifest 改了词没重生成 = 过期，渲染被拦并给出重生成命令。
 *
 * hash 契约（python/node 双端实现必须一致）：sha1(text 的 UTF-8 字节) 的 hex 小写。
 *   python:  hashlib.sha1(text.encode("utf-8")).hexdigest()
 *   node:    createHash('sha1').update(text, 'utf8').digest('hex')
 *
 * 生成器增量语义：stamp 里 hash 与 manifest 一致且 mp3 在盘 = 跳过（音频字节不动，
 * 重渲对照逐字节稳定）；不一致/缺文件才重跑 TTS。--force 全量、--stamp-only 只补账
 * （manifest 从既有词表迁移时，mp3 已按同文本生成过，直接建 stamp 不动音频）。
 */

import {createHash} from 'node:crypto';
import type {NarLine} from './promo-storyboard.ts';

export interface NarrationManifest {
  version: 1;
  /** 过期报错里给的重生成命令（如 "python promo/v11-takes/make-narration.py"） */
  regenCommand: string;
  lines: NarLine[];
}

/** 生成器产物：盘上 mp3 对应的文本 hash（改词重生成后更新；装配据此对账） */
export interface NarrationStamp {
  stampedAt: string;
  /** mp3 文件名 → sha1(text)（生成时的文本，不是 manifest 当前文本——两者差 = 过期） */
  hashes: Record<string, string>;
}

export const hashNarrationText = (text: string): string =>
  createHash('sha1').update(text, 'utf8').digest('hex');

export interface FreshnessResult {
  ok: boolean;
  /** 文本已改但 mp3 未重生成的行（manifest≠stamp） */
  stale: NarLine[];
  /** mp3 不在盘上的行（生成没跑完/被删） */
  missingOnDisk: NarLine[];
  /** stamp 文件本身缺失（生成器从没跑过） */
  noStamp: boolean;
}

/** 纯对账（盘上文件存在性由调用方注入，便于单测） */
export const checkNarrationFreshness = (
  lines: NarLine[],
  stamp: NarrationStamp | null,
  mp3Exists: (file: string) => boolean,
): FreshnessResult => {
  if (!stamp) return {ok: false, stale: [], missingOnDisk: [], noStamp: true};
  const stale: NarLine[] = [];
  const missingOnDisk: NarLine[] = [];
  for (const line of lines) {
    const stamped = stamp.hashes[line.file];
    if (stamped !== hashNarrationText(line.text)) stale.push(line);
    else if (!mp3Exists(line.file)) missingOnDisk.push(line);
  }
  return {ok: stale.length === 0 && missingOnDisk.length === 0, stale, missingOnDisk, noStamp: false};
};

/** 过期报告（装配报错用：哪个文件、什么词、跑什么命令） */
export const freshnessError = (r: FreshnessResult, regenCommand: string): string => {
  if (r.noStamp) return `旁白 stamp 不存在——先跑 ${regenCommand} 建立基线（mp3 文本对账缺它没法判新旧）`;
  const parts: string[] = [];
  if (r.stale.length > 0) {
    parts.push(`改词未重新生成 ${r.stale.length} 句：${r.stale.map((l) => `${l.file}「${l.text}」`).join('、')}`);
  }
  if (r.missingOnDisk.length > 0) {
    parts.push(`mp3 缺失 ${r.missingOnDisk.length} 句：${r.missingOnDisk.map((l) => l.file).join('、')}`);
  }
  return `旁白过期（${parts.join('；')}）——跑 ${regenCommand} 后再装配（生成器增量，只会重做变化的句子）`;
};

/**
 * 断言升级的第二向：段长装不下旁白（+0.4s 余量）时，给**可直接采用的最小段长**——
 * 吸附到 ≥ narDur+margin 的最近整拍（节拍表口径与卡点吸附同源，装配抄进去就能过吸附）。
 * 节拍表装不下（旁白比音乐还长）时退回 narDur+margin+0.1s。
 */
export const suggestMinSegmentSec = (narDurSec: number, beats: number[], marginSec = 0.4): number => {
  const need = narDurSec + marginSec;
  const hit = beats.filter((b) => b >= need - 1e-9).sort((a, b) => a - b)[0];
  return hit !== undefined ? Math.round(hit * 100) / 100 : Math.round((need + 0.1) * 100) / 100;
};
