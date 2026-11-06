/**
 * 发布元数据：平台规格 + 文案组装/校验纯函数
 *
 * 各平台标题字数上限为公开的编辑器限制（2026-08 核对）；视频号未公开稳定上限，
 * 不做校验只组装文案。发布动作本身由用户在平台完成，这里产出可直接粘贴的文案。
 */

import type {PublishMetadata} from './types';

export type PublishPlatform = 'douyin' | 'bilibili' | 'xiaohongshu' | 'channels' | 'youtube';

export interface PlatformSpec {
  label: string;
  /** 标题字数上限（null = 不校验） */
  titleLimit: number | null;
  /** 简介字数上限（null = 不校验） */
  descLimit: number | null;
  /** 话题标签样式：hash = #标签 空格拼接；comma = 逗号拼接（B 站标签输入框） */
  tagStyle: 'hash' | 'comma';
  /** 最多标签数（null = 不校验） */
  tagCountLimit: number | null;
  note: string;
}

export const PLATFORM_SPECS: Record<PublishPlatform, PlatformSpec> = {
  douyin: {label: '抖音', titleLimit: 55, descLimit: null, tagStyle: 'hash', tagCountLimit: null, note: '标题 + 话题标签（抖音无独立简介，文案合并进标题区）'},
  bilibili: {label: '哔哩哔哩', titleLimit: 80, descLimit: 250, tagStyle: 'comma', tagCountLimit: 10, note: '标题 / 简介 / 标签分栏填写，标签用逗号分隔'},
  xiaohongshu: {label: '小红书', titleLimit: 20, descLimit: 1000, tagStyle: 'hash', tagCountLimit: 10, note: '标题限 20 字，正文 + 话题标签'},
  channels: {label: '视频号', titleLimit: null, descLimit: null, tagStyle: 'hash', tagCountLimit: null, note: '文案 + 话题标签（平台未公开字数上限，仅组装不校验）'},
  youtube: {label: 'YouTube', titleLimit: 100, descLimit: 5000, tagStyle: 'hash', tagCountLimit: null, note: '标题 ≤100 字符；话题标签放描述末尾'},
};

export const PUBLISH_PLATFORMS = Object.keys(PLATFORM_SPECS) as PublishPlatform[];

/** 标签清洗：接受字符串数组或逗号/空格/中文逗号分隔的字符串，去 #、去空、去重、限量 */
export const sanitizeTags = (raw: unknown): string[] => {
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.map((t) => String(t));
  } else if (typeof raw === 'string') {
    list = raw.split(/[,，\s#]+/);
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const t = item.replace(/^#+/, '').trim().slice(0, 30);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
};

/** 组装某平台的可粘贴文案 */
export const buildPlatformCopy = (platform: PublishPlatform, meta: PublishMetadata): string => {
  const spec = PLATFORM_SPECS[platform];
  const title = meta.title.trim();
  const desc = meta.description.trim();
  const tags = meta.tags;
  const hashTags = tags.map((t) => `#${t}`).join(' ');
  const commaTags = tags.join('，');
  switch (platform) {
    case 'douyin':
      return [title, hashTags].filter(Boolean).join('\n');
    case 'bilibili':
      return [title, desc, tags.length > 0 ? `标签：${commaTags}` : ''].filter(Boolean).join('\n');
    case 'xiaohongshu':
    case 'channels':
      return [title, desc, hashTags].filter(Boolean).join('\n');
    case 'youtube':
      return [title, desc, hashTags].filter(Boolean).filter((s) => s !== '').join('\n\n');
  }
};

export interface PlatformLimitWarning {
  platform: PublishPlatform;
  field: 'title' | 'description' | 'tags';
  /** 超出的字数/标签数 */
  over: number;
  message: string;
}

/** 校验元数据是否超出各平台编辑器限制（超限不阻断保存，发布前提示收缩） */
export const checkPlatformLimits = (meta: PublishMetadata): PlatformLimitWarning[] => {
  const warnings: PlatformLimitWarning[] = [];
  const titleLen = meta.title.trim().length;
  const descLen = meta.description.trim().length;
  for (const p of PUBLISH_PLATFORMS) {
    const spec = PLATFORM_SPECS[p];
    if (spec.titleLimit !== null && titleLen > spec.titleLimit) {
      warnings.push({platform: p, field: 'title', over: titleLen - spec.titleLimit,
        message: `${spec.label}标题超限 ${titleLen - spec.titleLimit} 字（上限 ${spec.titleLimit}）`});
    }
    if (spec.descLimit !== null && descLen > spec.descLimit) {
      warnings.push({platform: p, field: 'description', over: descLen - spec.descLimit,
        message: `${spec.label}简介超限 ${descLen - spec.descLimit} 字（上限 ${spec.descLimit}）`});
    }
    if (spec.tagCountLimit !== null && meta.tags.length > spec.tagCountLimit) {
      warnings.push({platform: p, field: 'tags', over: meta.tags.length - spec.tagCountLimit,
        message: `${spec.label}最多 ${spec.tagCountLimit} 个标签，当前 ${meta.tags.length} 个`});
    }
  }
  return warnings;
};
