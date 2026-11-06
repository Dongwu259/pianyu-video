/**
 * TemplateHoverPreview - 模板卡片悬停动态预览（模板选择器 / 首页推荐横排共用）
 *
 * hover 卡片 500ms 后在卡片旁弹出小窗，用 RemotionPreviewPlayer 实时渲染该模板
 * （合成演示文案段 + 占位媒体：优先用当前片段/素材库里的真实素材——「套你的素材看效果」，
 * 什么素材都没有时用程序生成的渐变占位图）。静态缩略图选不准、单击选定试错成本高的
 * 痛点直接消掉；离开卡片即销毁，任何时刻至多存活一个预览。
 *
 * 弹层 pointer-events:none——永远不会挡住点击选模板。
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useProjectStore} from '../store/projectStore';
import {layoutForTemplate} from '../store/projectStore';
import {RemotionPreviewPlayer} from './RemotionPreviewPlayer';
import {
  findDataDrivenDef,
  findGeneratedDef,
  isCustomTemplateId,
  isGeneratedTemplateId,
  isMarketTemplateId,
} from '../../shared/template-registry';
import {getAspectRatioPreset} from '../../shared/aspect-ratios';
import type {TemplateMeta, TemplateProps, VideoClip} from '../../shared/types';
import './TemplateHoverPreview.css';

/** hover 多久才出预览（ms）：快速扫过不出，避免 Player 频繁挂载 */
const HOVER_DELAY_MS = 500;
/** 预览时长（秒）：模板默认时长再长也只预览开头这几秒 */
const PREVIEW_SEC = 6;
const POP_W = 384;

export interface HoverPreviewState {
  template: TemplateMeta;
  rect: {top: number; left: number; right: number; bottom: number};
}

/** 悬停管理 hook：进卡延时出预览、离卡即清；换筛选/滚动的清理由宿主调 onLeave */
export const useHoverPreview = (): {
  preview: HoverPreviewState | null;
  onEnter: (t: TemplateMeta, el: HTMLElement) => void;
  onLeave: () => void;
} => {
  const [preview, setPreview] = useState<HoverPreviewState | null>(null);
  const timerRef = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPreview(null);
  }, []);
  const onEnter = useCallback(
    (t: TemplateMeta, el: HTMLElement) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const rect = el.getBoundingClientRect();
      timerRef.current = window.setTimeout(() => setPreview({template: t, rect}), HOVER_DELAY_MS);
    },
    [],
  );
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);
  return {preview, onEnter, onLeave: clear};
};

/** 程序生成渐变占位图（工程里没有任何素材时给需素材模板垫画面） */
let placeholderSrc: string | null = null;
const getPlaceholderSrc = (): string => {
  if (placeholderSrc) return placeholderSrc;
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 640, 360);
  grad.addColorStop(0, '#1E3A8A');
  grad.addColorStop(0.55, '#2563EB');
  grad.addColorStop(1, '#7C3AED');
  g.fillStyle = grad;
  g.fillRect(0, 0, 640, 360);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath();
  g.arc(500, 105, 46, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(70, 212, 330, 22);
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.fillRect(70, 250, 210, 14);
  placeholderSrc = c.toDataURL('image/png');
  return placeholderSrc;
};

export const TemplateHoverPreview: React.FC<{state: HoverPreviewState | null}> = ({state}) => {
  const aspectRatioId = useProjectStore((s) => s.aspectRatioId);
  const orientation = useProjectStore((s) => s.orientation);
  const customTemplates = useProjectStore((s) => s.customTemplates);
  const marketTemplates = useProjectStore((s) => s.marketTemplates);
  const generatedTemplates = useProjectStore((s) => s.generatedTemplates);
  const segmentVideos = useProjectStore((s) => s.videos);
  const mediaPool = useProjectStore((s) => s.mediaPool);

  if (!state) return null;
  const t = state.template;

  // 自定义/云端/AI 生成模板：先解析 def，未安装（找不到 def）就静默不弹
  const isGen = isGeneratedTemplateId(t.id);
  const isDataDriven = isCustomTemplateId(t.id) || isMarketTemplateId(t.id);
  const genDef = isGen ? findGeneratedDef(t.id, generatedTemplates) : undefined;
  const dataDef = isDataDriven ? findDataDrivenDef(t.id, customTemplates, marketTemplates) : undefined;
  if (isGen && !genDef) return null;
  if (isDataDriven && !dataDef) return null;

  // 占位媒体链：当前片段素材 → 素材库 → 程序占位图（有真素材时预览=「套你的素材看效果」）
  const media = segmentVideos[0] ?? mediaPool[0];
  const videos: VideoClip[] = [
    media
      ? {...media, id: 'hover-preview'}
      : {id: 'hover-preview', src: getPlaceholderSrc(), name: '占位图', type: 'image', width: 640, height: 360, duration: 0, trimStart: 0, trimEnd: 0, trimmedDuration: 0},
  ];
  const duration = Math.min(PREVIEW_SEC, Math.max(3, t.defaultDuration || PREVIEW_SEC));
  const inputProps: TemplateProps = {
    videos,
    text: {title: '这是标题文案', subtitle: '副标题：一句话说清亮点', features: ['要点文案一', '要点文案二', '要点文案三'], brandName: '品牌名'},
    orientation,
    segmentDuration: duration,
    style: {},
    layout: layoutForTemplate(t.id, orientation),
  };

  // 定位：贴卡片右侧优先，放不下换左侧，再不行夹进视口
  const preset = getAspectRatioPreset(aspectRatioId);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const playerH = Math.round((POP_W * preset.height) / preset.width);
  const popH = playerH + 36;
  let left = state.rect.right + 10;
  if (left + POP_W > vw - 8) left = state.rect.left - POP_W - 10;
  if (left < 8) left = Math.max(8, Math.min(state.rect.left, vw - POP_W - 8));
  const top = Math.max(70, Math.min(state.rect.top - 4, vh - popH - 16));

  return createPortal(
    <div className="thp-pop" style={{top, left, width: POP_W, height: popH}}>
      <div className="thp-head">
        <span className="thp-name">{t.name}</span>
        <span className="thp-meta">动态预览 · 前 {duration}s</span>
      </div>
      <div className="thp-player" style={{height: playerH}}>
        <RemotionPreviewPlayer
          inputProps={inputProps}
          orientation={orientation}
          aspectRatioId={aspectRatioId}
          templateId={t.id}
          duration={duration}
          loop
          controls={false}
          {...(isGen ? {generatedTemplateDef: genDef} : {})}
          {...(isDataDriven && !isGen ? {customTemplateDef: dataDef} : {})}
        />
      </div>
    </div>,
    document.body,
  );
};
