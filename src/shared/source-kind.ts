/**
 * 素材来源类型（sourceKind）启发式标注
 *
 * 实拍/录屏/图形三分类是 AI 模板选型的关键信号：
 * - live-action（实拍）：画面是主角 → 优先 Fullbleed 满幅族，禁止缩成 3D 画中画小窗
 * - screen-recording（录屏）：UI 演示 → 画中画族/字幕条族才是正解
 * - graphic（图形/截图/模型）：演示型素材
 *
 * 启发式规则（克制——不确定就默认 live-action 由用户改，宁可标实拍不可标录屏）：
 * 1. 图片 / 3D 模型 → graphic（确定）
 * 2. 本软件录屏（带鼠标轨迹 sidecar）/ MediaRecorder webm → screen-recording（确定）
 * 3. 视频无设备元数据 + 分辨率恰为常见屏幕分辨率（实拍相机几乎不输出 1366×768 这类
 *    桌面分辨率；1080p 相机可输出但多带 make/model）→ screen-recording（中置信）
 * 4. 其余视频（有设备元数据 / mxf 电影机 / 任意摄影分辨率）→ live-action（缺省）
 */

import type {MediaSourceKind} from './types';

export type {MediaSourceKind};

export const SOURCE_KINDS: readonly MediaSourceKind[] = ['live-action', 'screen-recording', 'graphic'];

export const SOURCE_KIND_LABELS: Record<MediaSourceKind, string> = {
  'live-action': '实拍',
  'screen-recording': '录屏',
  graphic: '图形',
};

/** 常见桌面分辨率（精确匹配；3840×2160 等摄影常见分辨率故意不在列——4K 相机太普遍） */
const COMMON_SCREEN_RESOLUTIONS = new Set([
  '1366x768', '1440x900', '1536x864', '1600x900', '1680x1050', '1920x1080',
  '1920x1200', '2560x1440', '2880x1800', '3440x1440',
]);

export interface SourceKindProbeInput {
  type: 'video' | 'image' | 'model';
  width: number;
  height: number;
  /** ffprobe 设备元数据（相机直出常带；录屏软件不带） */
  make?: string;
  model?: string;
  /** 本软件录屏标记（鼠标轨迹 sidecar 存在 / MediaRecorder 产物） */
  isAppRecording?: boolean;
  /** 文件扩展名（webm 是 MediaRecorder 专属容器，强录屏信号） */
  ext?: string;
}

export const guessSourceKind = (input: SourceKindProbeInput): MediaSourceKind => {
  if (input.type === 'image' || input.type === 'model') return 'graphic';
  if (input.isAppRecording) return 'screen-recording';
  const ext = (input.ext ?? '').toLowerCase().replace(/^\./, '');
  if (ext === 'webm') return 'screen-recording'; // MediaRecorder 专属容器
  if (input.make || input.model) return 'live-action'; // 相机元数据 = 实拍
  if (COMMON_SCREEN_RESOLUTIONS.has(`${input.width}x${input.height}`)) {
    return 'screen-recording';
  }
  return 'live-action';
};
