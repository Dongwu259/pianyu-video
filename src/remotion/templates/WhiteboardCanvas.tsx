/**
 * 模板: WhiteboardCanvas - 白板画布（P2，随变临摹复盘最有辨识度的镜头语言）
 *
 * 多张卡片（文字/视频）散布在画布上，相机在卡间横移+逐卡推近驻留+结尾拉远收全貌
 * （shared/whiteboard-canvas.ts 确定性布局与相机数学）。卡片白底圆角浮层（图纸排版
 * 节奏，两行错落），开场逐卡弹入（元素级微节奏）。卡间连接线不做（随变产品特点，
 * 用户裁决）。
 *
 * 文案编码：`[v]标题|副题` 视频卡（消费 videos 未用片段，按序）/ `[t]`、无前缀 = 文字卡。
 * 无素材也能出（纯文字卡即可成片）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {springProgress} from '../../shared/click-zoom-smooth';
import {clipEndSec} from '../../shared/clipCuts';
import {secToFrame} from '../../shared/frame-grid';
import {
  parseWhiteboardCards,
  layoutWhiteboard,
  whiteboardCameraAt,
  WHITEBOARD_WORLD_W,
  WHITEBOARD_WORLD_H,
} from '../../shared/whiteboard-canvas';
import {WHITEBOARD_CANVAS_PARAMS} from '../../shared/template-registry';

/** 卡片开场弹窗帧长 */
const CARD_POP_FRAMES = 20;

export const WhiteboardCanvas: React.FC<TemplateProps> = ({
  videos,
  text,
  brandColor,
  segmentDuration,
  style,
  params,
  planCaptionWindows,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 8) * FPS));

  const p = makeParamReader(WHITEBOARD_CANVAS_PARAMS, params);
  const zoomIn = p('zoomIn');
  const pullBackOn = p('pullBack') >= 0.5;
  const popOn = p('cardPop') >= 0.5;
  const panModeOn = p('panMode') >= 0.5; // 平面移动模式：移动段纯平移、驻留轻微推近（v7 复盘防晕）
  const contentZoom = p('contentZoom'); // 卡内素材随推近放大幅度（0=关）

  const cards = parseWhiteboardCards(text.features ?? [], 9); // 显式 9 卡——缺省 maxCards=6 会静默截断（v6-v8 实锤：9 卡只渲染了 6 张）
  const rects = layoutWhiteboard(cards);
  // M2 冻结接管：卡槽窗由物化层治理（序 = 投影 captions 序 = 卡序；长度与卡数不齐时
  // whiteboardCameraAt 宁少勿猜回退均匀数学）。未接管 undefined = 均匀数学零漂移。
  const cardWindows = planCaptionWindows?.length
    ? planCaptionWindows.map((w) => ({startFrame: secToFrame(w.startSec), endFrame: secToFrame(w.endSec)}))
    : undefined;
  const cam = whiteboardCameraAt(frame, totalFrames, rects, {
    zoomIn,
    pullBack: pullBackOn,
    panMode: panModeOn,
    ...(cardWindows ? {cardWindows} : {}),
  });
  // 相机推近进度（0=全景 1=驻留档）：驱动视频卡内容同步放大；拉远尾段随之回落
  const fitScale = 1 / WHITEBOARD_WORLD_W;
  const contentPushQ = Math.min(1, Math.max(0, (cam.scale / fitScale - 1) / Math.max(0.01, zoomIn - 1)));

  // 世界平面（画布 px）：相机 transform 施加在整个平面
  const worldW = canvasW * WHITEBOARD_WORLD_W;
  const worldH = canvasH * WHITEBOARD_WORLD_H;

  // 视频卡按序消费 clips
  let videoIdx = 0;

  // 白纸卡（图纸感）：深墨字——深浅舞台都成立
  const ink = {cardBg: 'rgba(255, 255, 255, 0.96)', title: '#17181C', sub: 'rgba(23,24,28,0.55)', border: 'rgba(23,24,28,0.1)'};

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: worldW,
          height: worldH,
          transform: `translate(-50%, -50%) translate(${(cam.tx * canvasW).toFixed(1)}px, ${(cam.ty * canvasH).toFixed(1)}px) scale(${cam.scale.toFixed(4)})`,
          fontFamily: VIDEO_DESIGN.bodyFont,
        }}
      >
        {cards.map((card, i) => {
          const r = rects[i];
          const cardW = r.w * worldW;
          const cardH = r.h * worldH;
          const left = r.cx * worldW - cardW / 2;
          const top = r.cy * worldH - cardH / 2;
          // 开场逐卡弹入（错峰 spring），随卡片被相机光顾保持呼吸微缩放
          const pop = popOn
            ? springProgress((frame - 6 - i * 5) / CARD_POP_FRAMES)
            : 1;
          if (pop <= 0.001) return null;
          const isVideo = card.type === 'video' && videoIdx < videos.length;
          const clip = isVideo ? videos[videoIdx++] : undefined;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left,
                top,
                width: cardW,
                height: cardH,
                opacity: Math.min(1, pop * 1.2),
                transform: `rotate(${r.rot}deg) scale(${(0.82 + 0.18 * pop).toFixed(4)})`,
                borderRadius: 16,
                background: ink.cardBg,
                border: `1px solid ${ink.border}`,
                boxShadow: '0 30px 70px -18px rgba(0, 0, 0, 0.55)',
                overflow: 'hidden',
                pointerEvents: 'none',
              }}
            >
              {clip ? (
                <>
                  {/* 卡内素材随相机推近同步放大（卡内 Ken Burns）——全屏录屏塞进小卡
                      内容太小看不清（v6 复盘），推近驻留时再放大一档才可读 */}
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      transform: `scale(${(1 + contentZoom * contentPushQ).toFixed(4)})`,
                      transformOrigin: '50% 42%',
                      pointerEvents: 'none',
                    }}
                  >
                    <ClipMedia
                      src={clip.src}
                      mediaType={clip.type}
                      muted
                      startFrom={Math.round((clip.trimStart || 0) * FPS)}
                      endSec={clipEndSec(clip)}
                      cutsSec={clip.cuts}
                      style={{width: '100%', height: '100%', objectFit: 'cover'}}
                    />
                  </div>
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: cardH * 0.52,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      padding: `${cardH * 0.06}px ${cardW * 0.05}px`,
                      background: 'linear-gradient(to top, rgba(10, 12, 20, 0.92) 0%, rgba(10, 12, 20, 0.62) 45%, transparent 100%)',
                      color: '#FFFFFF',
                      fontSize: tokens.fontSize.body * 0.92,
                      fontWeight: 600,
                      textShadow: '0 1px 8px rgba(10, 12, 20, 0.9)',
                    }}
                  >
                    {card.title}
                    {card.sub && (
                      <span style={{opacity: 0.75, fontWeight: 400, marginLeft: cardW * 0.02}}>{card.sub}</span>
                    )}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    gap: cardH * 0.07,
                    padding: `0 ${cardW * 0.09}px`,
                  }}
                >
                  <div
                    style={{
                      fontSize: Math.min(cardH * 0.22, cardW * 0.11),
                      fontWeight: 700,
                      color: ink.title,
                      lineHeight: 1.3,
                    }}
                  >
                    {card.title}
                  </div>
                  {card.sub && (
                    <div style={{fontSize: Math.min(cardH * 0.13, cardW * 0.062), color: ink.sub, lineHeight: 1.4}}>
                      {card.sub}
                    </div>
                  )}
                  <div style={{width: cardW * 0.16, height: 4, borderRadius: 999, background: brandColor ?? VIDEO_DESIGN.colors.accent, marginTop: cardH * 0.03}} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 品牌名：左下角小字 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.055,
            bottom: canvasH * 0.055,
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

