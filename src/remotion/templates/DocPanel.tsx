/**
 * 模板: DocPanel - 文档面板（P4，随变临摹复盘 35-40s：纸面文档+选区高亮+配图占位格）
 *
 * 居中白色纸面卡（toolBar 开=窗口条三点+标题），段落顺序浮现；行内 `[[选区]]` 渲染为
 * 选区高亮呼吸（落定后脉冲）；`img:标签` 行渲染为文档底部虚线占位格（逐格弹入——
 * 「全部生成」后的资产格语言）。纸面白卡深字，深浅舞台都成立。
 * 解析见 shared/doc-panel.ts（段落/选区/占位格，纯函数单测锚定）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {REF_ASPECT} from '../utils/aspectLayout';
import {springProgress} from '../../shared/click-zoom-smooth';
import {parseDocParagraphs, parseDocPlaceholders, docPanelTimeline} from '../../shared/doc-panel';
import {secToFrame} from '../../shared/frame-grid';
import {DOC_PANEL_PARAMS} from '../../shared/template-registry';

/** 段落浮现窗长（帧） */
const PARA_POP_FRAMES = 16;
/** 占位格弹入窗长（帧） */
const CELL_POP_FRAMES = 20;

export const DocPanel: React.FC<TemplateProps> = ({
  text,
  brandColor,
  segmentDuration,
  style,
  params,
  planCaptionWindows,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH, fps} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);

  const p = makeParamReader(DOC_PANEL_PARAMS, params);
  const pace = p('pace');
  const selectPulseOn = p('selectPulse') >= 0.5;
  const toolBarOn = p('toolBar') >= 0.5;
  const accent = brandColor ?? VIDEO_DESIGN.colors.accent;

  const paragraphs = parseDocParagraphs(text.features ?? []);
  const placeholders = parseDocPlaceholders(text.features ?? []);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 8) * FPS));

  // 纸面卡几何
  // 纸宽封顶（画幅审计 P1-5）：按画布宽 0.6 在 21:9 会拉出 1512px 宽纸（左右大空、
  // 字行过长）——封顶 16:9 等效宽（按高度折算）；16:9 恰好两值相等（零漂移）
  const paperW = Math.min(canvasW * 0.6, canvasH * REF_ASPECT * 0.6 + 0.5);
  const paperH = canvasH * 0.78;
  const bottom = safeBottom(canvasW, canvasH, canvasH * 0.05);
  const paperX = (canvasW - paperW) / 2;
  const paperY = (canvasH - paperH - bottom) / 2;

  // 时间线：与 SFX UI 音效放置同源（shared/doc-panel.ts docPanelTimeline）。
  // M2 冻结接管：段落窗由物化层治理（投影 captions 序 = [title?, 段落...]——去 title 位后
  // 即段落窗；长度与段落数不齐时 docPanelTimeline 宁少勿猜回退均匀数学）。未接管零漂移。
  const hasTitle = !!text.title;
  const paraWins = planCaptionWindows?.length
    ? planCaptionWindows
        .slice(hasTitle ? 1 : 0)
        .map((w) => ({startFrame: secToFrame(w.startSec), endFrame: secToFrame(w.endSec)}))
    : undefined;
  const tl = docPanelTimeline(paragraphs.length, placeholders.length, totalFrames, FPS, pace, paraWins);
  const paraEnter = tl.paraEnter;
  const cellEnter = tl.cellEnter;
  // 标题窗包络（窗口条标题随窗显隐；无窗 = 全程在场零漂移；边缘 6 帧线性过渡同 CursorFollow 口径）
  const titleWin = planCaptionWindows?.[0];
  const titleEnv = (() => {
    if (!titleWin) return 1;
    const s = Math.round(titleWin.startSec * fps);
    const e = Math.round(titleWin.endSec * fps);
    if (frame < s || frame >= e) return 0;
    return Math.min(1, (frame - s) / 6, (e - frame) / 6);
  })();

  const fontSize = tokens.fontSize.body * 1.02;
  const barH = paperH * 0.075;

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 纸面卡（白纸深字，深浅舞台都成立） */}
      <div
        style={{
          position: 'absolute',
          left: paperX,
          top: paperY,
          width: paperW,
          height: paperH,
          borderRadius: 12,
          background: '#FFFFFF',
          boxShadow: '0 34px 80px -20px rgba(0, 0, 0, 0.55)',
          overflow: 'hidden',
          fontFamily: VIDEO_DESIGN.bodyFont,
          pointerEvents: 'none',
        }}
      >
        {/* 窗口条：三点 + 文档标题 */}
        {toolBarOn && (
          <div
            style={{
              height: barH,
              display: 'flex',
              alignItems: 'center',
              gap: barH * 0.22,
              padding: `0 ${barH * 0.5}px`,
              borderBottom: '1px solid rgba(23, 24, 28, 0.08)',
              background: 'rgba(23, 24, 28, 0.03)',
            }}
          >
            {['#F87171', '#FBBF24', '#34D399'].map((c, i) => (
              <span key={i} style={{width: barH * 0.26, height: barH * 0.26, borderRadius: '50%', background: c, opacity: 0.85}} />
            ))}
            {text.title && (
              <span
                style={{
                  marginLeft: 'auto',
                  marginRight: 'auto',
                  paddingRight: barH * 2.4,
                  fontSize: fontSize * 0.8,
                  color: 'rgba(23, 24, 28, 0.45)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                {...(titleEnv < 1 ? {opacity: titleEnv} : {})}
              >
                {text.title}
              </span>
            )}
          </div>
        )}

        {/* 段落：顺序浮现 + 选区高亮呼吸 */}
        <div style={{padding: `${paperH * 0.045}px ${paperW * 0.07}px`, display: 'flex', flexDirection: 'column', gap: fontSize * 0.85, transform: scrollY > 0.5 ? `translateY(${(-scrollY).toFixed(1)}px)` : undefined}}>
          {paragraphs.map((para, i) => {
            const pop = springProgress((frame - paraEnter(i)) / PARA_POP_FRAMES);
            if (pop <= 0.001) return null;
            return (
              <div
                key={i}
                style={{
                  fontSize,
                  lineHeight: 1.72,
                  color: '#1F2937',
                  opacity: Math.min(1, pop * 1.2),
                  // 入场：右侧滑入 + 逆时针倾斜落正（与对话气泡的垂直滑落方向区分，v6 复盘）
                  transform: `translateX(${((1 - pop) * paperW * 0.09).toFixed(1)}px) rotate(${((1 - pop) * -5).toFixed(2)}deg) translateY(${((1 - pop) * 10).toFixed(1)}px)`,
                  transformOrigin: 'left center',
                }}
              >
                {para.segments.map((seg, j) =>
                  seg.selected ? (
                    <span
                      key={j}
                      style={{
                        background: `${accent}33`,
                        borderRadius: 4,
                        padding: '1px 3px',
                        boxShadow: `inset 0 0 0 1px ${accent}55`,
                        ...(selectPulseOn
                          ? {opacity: 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(frame * 0.14))}
                          : {}),
                      }}
                    >
                      {seg.text}
                    </span>
                  ) : (
                    <span key={j}>{seg.text}</span>
                  ),
                )}
              </div>
            );
          })}
        </div>

        {/* 配图占位格：文档底部虚线格逐格弹入（「全部生成」资产格语言） */}
        {placeholders.length > 0 && (
          <div
            style={{
              position: 'absolute',
              left: paperW * 0.07,
              right: paperW * 0.07,
              bottom: paperH * 0.05,
              display: 'flex',
              gap: paperW * 0.025,
            }}
          >
            {placeholders.map((label, i) => {
              const pop = springProgress((frame - cellEnter(i)) / CELL_POP_FRAMES);
              if (pop <= 0.001) return null;
              const cellH = paperH * 0.16;
              return (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: cellH,
                    borderRadius: 10,
                    border: '1.5px dashed rgba(23, 24, 28, 0.28)',
                    background: 'rgba(23, 24, 28, 0.03)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: cellH * 0.12,
                    opacity: Math.min(1, pop * 1.2),
                    transform: `scale(${(0.8 + 0.2 * pop).toFixed(3)})`,
                  }}
                >
                  <svg width={cellH * 0.3} height={cellH * 0.3} viewBox="0 0 24 24" aria-hidden>
                    <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="rgba(23,24,28,0.4)" strokeWidth="1.8" />
                    <circle cx="9" cy="10" r="1.8" fill="rgba(23,24,28,0.4)" />
                    <path d="M4 18 L10 12 L14 16 L17 13 L20 16" fill="none" stroke="rgba(23,24,28,0.4)" strokeWidth="1.8" strokeLinejoin="round" />
                  </svg>
                  <span style={{fontSize: fontSize * 0.72, color: 'rgba(23, 24, 28, 0.5)'}}>{label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 品牌名：左下角小字 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.055,
            bottom: bottom + canvasH * 0.03,
            color: 'rgba(255, 255, 255, 0.5)',
            fontSize: tokens.fontSize.body * 0.85,
            letterSpacing: '0.08em',
            fontFamily: VIDEO_DESIGN.bodyFont,
            pointerEvents: 'none',
          }}
        >
          {text.brandName}
        </div>
      )}
    </AbsoluteFill>
  );
};
