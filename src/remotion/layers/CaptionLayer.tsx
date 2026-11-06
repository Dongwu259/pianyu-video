/**
 * CaptionLayer - 烧录字幕层
 *
 * 在所在片段的时间轴内（由外层 Sequence from=段起点 对齐）按 startSec/endSec
 * 显示当前字幕行。位置/字号/底色/动效由项目级 CaptionStyle 决定。
 *
 * 出现动效（CaptionStyle.anim）：
 * - line（默认）：整行 0.2s 淡入淡出；
 * - wordPop：逐词卡拉OK 弹出——中文按字、英文按词，词窗在行时间窗内均分，
 *   每词 spring 弹入（scale 0.4→1 轻过冲），竖版社交流的标配观感。
 *
 * 竖版安全区：bottom/top 定位在竖版画幅下自动抬升到平台 UI 遮挡线之上
 * （Reels/TikTok 底部 ~18%、顶部 ~10%，见 utils/safeArea.ts），横版不受影响。
 *
 * 用法：<Sequence from={段起点}><CaptionLayer lines={seg.captions} style={captionStyle}/></Sequence>
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import type {CaptionLine, CaptionStyle} from '../../shared/types';
import {tokenizeCaption} from '../../shared/promo-text-parse';
import {getScaledTokens} from '../config/designTokens';
import {SPRINGS} from '../animations/motion';
import {safeBottom, safeTop} from '../utils/safeArea';

/** 行首尾淡入淡出帧数（约 0.2s @30fps） */
const FADE_FRAMES = 6;

interface CaptionLayerProps {
  lines: CaptionLine[];
  style: CaptionStyle;
}

export const CaptionLayer: React.FC<CaptionLayerProps> = ({lines, style}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const t = frame / fps;
  const tokens = getScaledTokens(width, height);
  // 基准字号用副标题档（1080p 下 40px）：旧版用 caption 档（22px）默认太小看不清；
  // 用户仍可通过 captionStyle.fontSizeScale 在 0.5~2.5 倍间调节
  const fontSize = Math.round(tokens.fontSize.subtitle * (style.fontSizeScale || 1));

  // 定位当前时间点的字幕行
  const active = lines.find((l) => t >= l.startSec && t < l.endSec);
  if (!active || !active.text) return null;

  // 行首尾淡入淡出（整行包络，对两种动效都生效）
  const startFrame = Math.round(active.startSec * fps);
  const endFrame = Math.round(active.endSec * fps);
  let opacity = 1;
  const sinceStart = frame - startFrame;
  const untilEnd = endFrame - frame;
  if (sinceStart < FADE_FRAMES) opacity = Math.max(0, sinceStart / FADE_FRAMES);
  if (untilEnd < FADE_FRAMES) opacity = Math.max(0, untilEnd / FADE_FRAMES);

  // 位置（项目级）；竖版下 bottom/top 抬到平台安全区内
  const baseMargin = Math.round(tokens.spacing.section * 0.6);
  const posStyle: React.CSSProperties =
    style.position === 'bottom'
      ? {bottom: safeBottom(width, height, baseMargin), top: 'auto'}
      : style.position === 'top'
        ? {top: safeTop(width, height, baseMargin), bottom: 'auto'}
        : {top: '50%', transform: 'translateY(-50%)'};

  // ====== wordPop：词窗均分 + 每词 spring 弹入 ======
  const units = style.anim === 'wordPop' ? tokenizeCaption(active.text) : [];
  const countableTotal = units.filter((u) => u.countable).length;
  const lineDur = Math.max(1, endFrame - startFrame);
  let countableIdx = 0;

  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          ...posStyle,
        }}
      >
        <div
          style={{
            maxWidth: '82%',
            padding: `${Math.round(fontSize * 0.35)}px ${Math.round(fontSize * 0.6)}px`,
            borderRadius: Math.round(fontSize * 0.25),
            background: style.bgOpacity > 0 ? `rgba(0, 0, 0, ${style.bgOpacity})` : 'transparent',
            color: style.color,
            fontSize,
            fontFamily: tokens.bodyFont,
            fontWeight: 600,
            lineHeight: 1.4,
            textAlign: 'center',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            opacity,
          }}
        >
          {units.length === 0
            ? active.text
            : units.map((u, i) => {
                if (!u.countable) return <span key={i}>{u.text}</span>;
                const k = countableIdx++;
                const unitStart = startFrame + Math.floor((k / countableTotal) * lineDur);
                const pop = spring({
                  frame: frame - unitStart,
                  fps,
                  config: SPRINGS.charPop,
                });
                if (pop <= 0) return <span key={i} style={{opacity: 0}}>{u.text}</span>;
                return (
                  <span
                    key={i}
                    style={{
                      display: 'inline-block',
                      opacity: Math.min(1, pop * 1.6),
                      transform: `scale(${0.4 + pop * 0.6})`,
                      transformOrigin: '50% 85%',
                    }}
                  >
                    {u.text}
                  </span>
                );
              })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default CaptionLayer;
