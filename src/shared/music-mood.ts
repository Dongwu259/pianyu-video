/**
 * 曲库情绪/能量推导（纯函数，Node 可直跑单测）。
 *
 * 版权决策更新（2026-10-13 用户拍板）：片语内置 12 首 CC BY 4.0 配乐（resources/bgm，
 * incompetech/Kevin MacLeod，成片强制署名——见 bgm-credits.ts）；本地文件夹曲库仍是主来源。
 * 「按情绪找配乐」自动推导口径不变：
 * - mood：文件名/标签关键词映射（中英文常见命名习惯，如 epic/欢快/钢琴/rock；内置曲
 *   的六情绪槽位名 uplifting/energetic/温暖 等也在表内）
 * - energy：音频峰值包络统计（波形数据分析结果 peaks，music:analyze IPC 产出）
 *
 * 推导必然粗糙（文件名 + 波形 ≠ 真情绪），工具返回里始终附推导依据，最终由 AI/用户定夺。
 */

export type MusicMood = 'epic' | 'upbeat' | 'calm' | 'sad' | 'corporate' | 'tense' | 'unknown';
export type MusicEnergy = 'high' | 'mid' | 'low' | 'unknown';

/** 关键词 → 情绪（小写匹配；命中多个取首个） */
const MOOD_KEYWORDS: ReadonlyArray<[MusicMood, string[]]> = [
  ['epic', ['epic', 'trailer', 'cinematic', '史诗', '大片', '震撼', 'horn', 'orchestra', '交响']],
  ['upbeat', ['upbeat', 'happy', 'pop', 'funk', 'dance', '欢快', '活泼', '轻快', '阳光', '活力', '节奏', 'uplifting', 'energetic', '振奋']],
  ['calm', ['calm', 'ambient', 'piano', 'acoustic', 'lofi', 'lo-fi', 'soft', '安静', '舒缓', '轻音乐', '钢琴', '治愈', '氛围', 'warm', '温暖']],
  ['sad', ['sad', 'emotional', 'melancholy', '悲伤', '伤感', '抒情', '慢歌']],
  ['corporate', ['corporate', 'business', 'tech', 'startup', '商业', '科技', '企业', '正能量', '励志', 'motivational', 'inspiring']],
  ['tense', ['tense', 'suspense', 'dark', 'drama', '紧张', '悬疑', '黑暗', '低沉', 'deep']],
];

export const classifyMusicMood = (name: string): MusicMood => {
  const n = (name || '').toLowerCase();
  for (const [mood, words] of MOOD_KEYWORDS) {
    if (words.some((w) => n.includes(w))) return mood;
  }
  return 'unknown';
};

export const MOOD_LABELS: Record<MusicMood, string> = {
  epic: '史诗/预告片',
  upbeat: '欢快/律动',
  calm: '安静/氛围',
  sad: '伤感/抒情',
  corporate: '商业/科技',
  tense: '紧张/暗黑',
  unknown: '未识别',
};

/**
 * 峰值包络 → 能量档。peaks 为 0..1 波形峰值序列（music:analyze 产出）。
 * 取均值与 P90 双指标：均值高 = 全程能量足；均值低但 P90 高 = 有爆发段（卡点可用）。
 */
export const energyFromPeaks = (peaks?: number[]): {level: MusicEnergy; avg: number; p90: number} => {
  const valid = (peaks || []).filter((p) => Number.isFinite(p) && p >= 0);
  if (valid.length < 8) return {level: 'unknown' as MusicEnergy, avg: 0, p90: 0};
  const sorted = [...valid].sort((a, b) => a - b);
  const avg = valid.reduce((s, p) => s + p, 0) / valid.length;
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  let level: MusicEnergy;
  if (avg >= 0.45 || p90 >= 0.8) level = 'high';
  else if (avg >= 0.22 || p90 >= 0.5) level = 'mid';
  else level = 'low';
  return {level, avg: Math.round(avg * 100) / 100, p90: Math.round(p90 * 100) / 100};
};

/** 给 AI 看的曲库条目描述 */
export interface MusicCandidate {
  name: string;
  path: string;
  durationSec?: number;
  mood: MusicMood;
  energy: MusicEnergy;
  energyAvg?: number;
}

/** 按情绪/能量给候选打分排序（同 mood +3，同能量档 +2，commercial 默认偏好中高能量） */
export const rankMusicForMood = (candidates: MusicCandidate[], wantMood?: MusicMood, wantEnergy?: MusicEnergy): MusicCandidate[] => {
  const score = (c: MusicCandidate): number => {
    let s = 0;
    if (wantMood && c.mood === wantMood) s += 3;
    if (wantEnergy && c.energy === wantEnergy) s += 2;
    if (!wantMood && c.mood !== 'unknown') s += 1; // 无明确要求时优先可识别的
    if (c.mood === 'corporate' && !wantMood) s += 1; // 宣传片缺省商业向
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
};
