/**
 * ASR 语音识别的共享纯逻辑（verbose_json 解析 → CaptionLine）
 *
 * 与 llm-tools.ts 同模式：不 import 任何运行时依赖，可在 Node 中直接做单测。
 * 主进程 services/asr.ts 负责抽音频/网络请求，解析与钳制走这里。
 */

import type {CaptionLine} from './types';

/** asr:getStatus IPC 返回（key 永不回渲染进程，只回是否已配置） */
export interface AsrStatus {
  /** API key 是否已配置 */
  configured: boolean;
  /** 当前设置中的 ASR 服务地址 */
  baseUrl?: string;
  /** 当前设置中的 ASR 模型名 */
  model?: string;
}

/** asr:transcribe IPC 入参 */
export interface AsrTranscribeRequest {
  /** 素材文件原始路径（视频或音频） */
  path: string;
  /** 所在片段时长（秒）：字幕时间钳到 [0, segmentDuration] */
  segmentDuration: number;
}

/** OpenAI 兼容 verbose_json 的单条分段 */
export interface AsrVerboseSegment {
  start: number;
  end: number;
  text: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * verbose_json segments → CaptionLine[]。
 * 规则（与 CaptionPanel 手动编辑的互钳语义对齐）：
 * - 文案 trim 后为空 → 丢弃；start/end 不是有限数字 → 丢弃
 * - 起止钳到 [0, duration]
 * - 钳后起 ≥ 止（含 ASR 起止倒置）时按面板「止最少比起晚 0.1s」钳正；
 *   钳不正（起已贴到段尾）→ 丢弃
 */
export const segmentsToCaptions = (segments: unknown, duration: number): CaptionLine[] => {
  if (!Array.isArray(segments) || !Number.isFinite(duration) || duration <= 0) return [];
  const lines: CaptionLine[] = [];
  for (const raw of segments) {
    if (typeof raw !== 'object' || raw === null) continue;
    const seg = raw as Partial<AsrVerboseSegment>;
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    if (!text) continue;
    const s = seg.start;
    const e = seg.end;
    if (typeof s !== 'number' || !Number.isFinite(s) || typeof e !== 'number' || !Number.isFinite(e)) continue;
    let startSec = Math.min(Math.max(s, 0), duration);
    let endSec = Math.min(Math.max(e, 0), duration);
    if (endSec <= startSec) {
      // 对齐 CaptionPanel 互钳：止不能早于起，最少留 0.1s
      endSec = Math.min(duration, startSec + 0.1);
    }
    startSec = round2(startSec);
    endSec = round2(endSec);
    if (endSec <= startSec) continue;
    lines.push({text, startSec, endSec});
  }
  return lines;
};
