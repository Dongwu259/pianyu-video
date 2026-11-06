/**
 * 模板: ChatConversation - 对话气泡会话流（P1，随变临摹复盘：AI 产品「过程可视化=信任证据」）
 *
 * features 逐行编码气泡脚本（`u:` 用户 / `a:` AI / 无前缀视为 AI，见 shared/chat-conversation.ts）：
 * 用户气泡=accent 渐变底白字+顶部内高光（品牌色=用户声音），AI 气泡=中性卡；逐条从
 * 发送侧滑入+弹簧落正（底部锚定，新气泡把旧气泡往上推），AI 气泡先出「打字三点」
 * 停留再换文本（布局零跳动）；同侧连发分组（组内间距收紧+圆角阶梯）；
 * 每条带同侧头像（AI=线稿机器人 typing 眨眼 / 用户=accent 人形）；组首时间戳
 * （入场时刻 m:ss）+ 用户 ✓✓ 已读；右下角 ✓N 任务徽章（N=AI 条数），左下角品牌小字。
 *
 * bgStyle 0 深 / 1 浅（P3 浅色主题族：AI 卡=白卡深字、描边深）。
 * avatar/meta/group 参数 0 关=对应层退化（旧观感），全关≈升级前形态。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {REF_ASPECT, cavityLift} from '../utils/aspectLayout';
import {springProgress} from '../../shared/click-zoom-smooth';
import {parseChatLines, bubbleEnterFrame, chatGroupStarts, chatTimestampLabel, CHAT_BUBBLE_POP_FRAMES, CHAT_TYPING_SEC, CHAT_PUSH_FRAMES, CHAT_META_LINE_EM, estimateChatRows} from '../../shared/chat-conversation';
import {CHAT_CONVERSATION_PARAMS} from '../../shared/template-registry';

/** 用户气泡强调色档（0=品牌色；1-4 与 3D 族主题色同族——纯色表不引 three） */
const USER_ACCENTS = ['#F5B32B', '#22D3EE', '#FB7185', '#34D399'];

/** hex 明暗系数（f<0 变暗；非 #rrggbb 原样返回——品牌色兜底） */
const shadeHex = (hex: string, f: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + f))));
  return `#${((ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255))
    .toString(16)
    .padStart(6, '0')}`;
};

export const ChatConversation: React.FC<TemplateProps> = ({
  text,
  brandColor,
  segmentDuration,
  style,
  params,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);

  const p = makeParamReader(CHAT_CONVERSATION_PARAMS, params);
  const pace = p('pace');
  const typingOn = p('typing') >= 0.5;
  const userColorMode = Math.round(p('userColor'));
  const widthScale = p('widthScale');
  const badgeOn = p('badge') >= 0.5;
  const onLight = Math.round(p('bgStyle')) === 1;
  const avatarOn = p('avatar') >= 0.5;
  const metaOn = p('meta') >= 0.5;
  const groupOn = p('group') >= 0.5;

  const accent = userColorMode === 0 ? brandColor ?? '#3B82F6' : USER_ACCENTS[Math.min(4, Math.max(1, userColorMode)) - 1];
  const lines = parseChatLines(text.features ?? []);
  const totalFrames = Math.max(1, Math.round((segmentDuration || 8) * FPS));
  const inkTitle = onLight ? '#17181C' : VIDEO_DESIGN.colors.textTitleDark;
  const inkBody = onLight ? '#3D4351' : VIDEO_DESIGN.colors.textBodyDark;
  const cardBg = onLight ? 'rgba(255, 255, 255, 0.92)' : 'rgba(255, 255, 255, 0.08)';
  const cardBorder = onLight ? 'rgba(23, 24, 28, 0.12)' : 'rgba(255, 255, 255, 0.14)';

  // 底部安全区（字幕带）+ 列左右留白。
  // 列宽封顶（画幅审计 P1-5）：21:9 等宽画幅按画布宽度等比会拿到 1560px 级的气泡列
  // （泡宽夸张、行数骤减、上方大空腔）——封顶 16:9 等效宽；16:9 及更窄画幅不触顶（零漂移）
  const bottom = safeBottom(canvasW, canvasH, canvasH * 0.06);
  const colW = Math.min(canvasW, canvasH * REF_ASPECT + 1) * widthScale;

  // 逐条时间线
  const enters = lines.map((_, i) => bubbleEnterFrame(i, lines.length, totalFrames, FPS, pace));
  const typingFrames = Math.round(CHAT_TYPING_SEC * FPS);
  const aiCount = lines.filter((l) => l.role === 'ai').length;
  const badgeEnter = lines.length > 0 ? enters[enters.length - 1] + Math.round(0.3 * FPS) : totalFrames + 1;

  // 底部锚定列表的丝滑入场：新泡 wrapper 高度从 0 渐展开（overflow hidden + 本体从
  // 自身高度下方滑入）——布局被「连续高度增长」顶起，旧泡零瞬移零补偿（v5 实锤：
  // 补偿式推挤把未入场泡的满额高压在自己身上，泡被裁出底边）。
  // 泡高确定化：行数估算 → 本体固定盒（估算偏大 5% 宽余量保证 ≥ 实际行数），
  // wrapper 展开终值=本体高，换文/展开全程同源无跳。
  const gap = canvasH * 0.018;
  const padY = canvasH * 0.016;
  const padX = canvasW * 0.017;
  const fontSize = tokens.fontSize.body * 1.04;
  // 头像对（升级）：每条气泡同侧头像（AI 左=线稿机器人 typing 眨眼 / 用户右=accent
  // 人形）——wrapper 改 flex row 容纳，气泡文本可用宽同步扣除（换文零跳同源）
  const avatarD = fontSize * 2.15;
  const avatarGap = fontSize * 0.5;
  // 连发分组：同角色连续=同组（组内间距 0.38×、圆角阶梯、时间戳只标组首）——
  // groupOn=0 时每条视为组首=旧版等距/全圆角行为
  const groupStarts = chatGroupStarts(lines);
  const isGroupStart = (i: number) => !groupOn || groupStarts[i];
  const prevSame = (i: number) => groupOn && i > 0 && lines[i - 1].role === lines[i].role;
  const nextSame = (i: number) => groupOn && i < lines.length - 1 && lines[i + 1].role === lines[i].role;
  // meta 行（组首时间戳 / 用户 ✓✓ 已读）：高度入 estHeights（typing 期占位 opacity 0 → 换文零跳）
  const hasMeta = (i: number) => metaOn && (groupStarts[i] || lines[i].role === 'user');
  const bubbleContentW = colW * 0.92 - (avatarOn ? avatarD + avatarGap : 0) - padX * 2;
  const estHeights = lines.map((l, i) => {
    const rows = estimateChatRows(l.text, bubbleContentW, fontSize);
    return rows * fontSize * 1.5 + padY * 2 + 2 + (hasMeta(i) ? fontSize * CHAT_META_LINE_EM : 0); // +2 = 上下 border
  });
  const fixedContentH = (i: number): string => `${(estHeights[i] - padY * 2 - 2).toFixed(1)}px`;
  // 内容盒垂直重心（画幅审计 P1-5）：气泡终态高度不足可用区一半时（方形/宽画幅小字号
  // 场景的「上方大空腔」），底部锚点整体上抬空腔的一半×0.9——仍偏下，保留对话
  // 「往上长」的观感；内容够满则不抬（16:9 现役行为零漂移）
  const zoneTop = canvasH * 0.1;
  const zoneBottomPx = bottom + canvasH * 0.05;
  const stackH = estHeights.reduce(
    (s, h, i) => s + h + (i === 0 ? gap : groupStarts[i] ? gap : gap * 0.38),
    0,
  );
  const lift = cavityLift(zoneBottomPx - zoneTop, stackH);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : onLight ? (
        <AbsoluteFill style={{background: 'linear-gradient(165deg, #FDFBF2 0%, #F8F0CE 55%, #F1E2A0 100%)'}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 气泡列：底部锚定（新气泡推旧气泡上移），顶部渐隐帘收溢出 */}
      <div
        style={{
          position: 'absolute',
          left: (canvasW - colW) / 2,
          width: colW,
          top: canvasH * 0.1,
          bottom: zoneBottomPx + lift,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          alignItems: 'stretch',
          overflow: 'hidden',
          fontFamily: VIDEO_DESIGN.bodyFont,
          maskImage: 'linear-gradient(to bottom, transparent 0, black 9%, black 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 9%, black 100%)',
        }}
      >
        {lines.map((line, i) => {
          const enter = enters[i];
          const isUser = line.role === 'user';
          // 用户气泡直接弹入；AI 气泡先以三点形态提前 typingFrames 出现
          const appear = isUser || !typingOn ? enter : enter - typingFrames;
          const pop = springProgress((frame - appear) / CHAT_BUBBLE_POP_FRAMES);
          if (pop <= 0.001) return null;
          const textQ = isUser || !typingOn ? 1 : interpolate(frame, [enter, enter + 6], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          const typingNow = !isUser && typingOn && frame < enter;
          const start = isGroupStart(i);
          // 头像（同侧驻留每条）：AI=线稿机器人（typing 期眨眼=「正在想」），用户=accent 人形
          const avatar = avatarOn && (
            <div
              style={{
                width: avatarD,
                height: avatarD,
                borderRadius: '50%',
                flexShrink: 0,
                alignSelf: 'flex-start',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: isUser
                  ? `linear-gradient(165deg, ${accent}, ${shadeHex(accent, -0.14)})`
                  : onLight ? '#FFFFFF' : 'rgba(255, 255, 255, 0.10)',
                border: `1px solid ${isUser ? 'transparent' : cardBorder}`,
                boxShadow: onLight
                  ? '0 6px 16px -8px rgba(23, 24, 28, 0.28)'
                  : '0 8px 18px -10px rgba(0, 0, 0, 0.5)',
                opacity: Math.min(1, pop * 1.2),
                transform: `scale(${(0.6 + 0.4 * pop).toFixed(4)})`,
                pointerEvents: 'none',
              }}
            >
              {isUser ? (
                <svg viewBox="0 0 32 32" width={avatarD * 0.58} height={avatarD * 0.58} aria-hidden>
                  <circle cx="16" cy="11.5" r="5.2" fill="#FFFFFF" />
                  <path d="M7.6 27a8.4 8.4 0 0 1 16.8 0Z" fill="#FFFFFF" />
                </svg>
              ) : (
                <svg viewBox="0 0 32 32" width={avatarD * 0.62} height={avatarD * 0.62} aria-hidden>
                  {/* 天线（顶球=accent 点亮 typing 心跳） */}
                  <line x1="16" y1="5.5" x2="16" y2="9" stroke={inkBody} strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="16" cy="4.4" r="1.9" fill={accent} opacity={typingNow ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(frame * 0.55)) : 0.9} />
                  {/* 头：typing 期每 ~0.5s 眨一次眼（横线）=「正在想」 */}
                  <rect x="7" y="9" width="18" height="13" rx="6" fill="none" stroke={inkBody} strokeWidth="1.8" />
                  {typingNow && frame % 15 < 2 ? (
                    <>
                      <line x1="10.3" y1="15.5" x2="13.7" y2="15.5" stroke={inkBody} strokeWidth="1.7" strokeLinecap="round" />
                      <line x1="18.3" y1="15.5" x2="21.7" y2="15.5" stroke={inkBody} strokeWidth="1.7" strokeLinecap="round" />
                    </>
                  ) : (
                    <>
                      <circle cx="12" cy="15.5" r="1.8" fill={inkBody} />
                      <circle cx="20" cy="15.5" r="1.8" fill={inkBody} />
                    </>
                  )}
                  <rect x="3.6" y="12.5" width="2.6" height="6" rx="1.3" fill="none" stroke={inkBody} strokeWidth="1.6" />
                  <rect x="25.8" y="12.5" width="2.6" height="6" rx="1.3" fill="none" stroke={inkBody} strokeWidth="1.6" />
                </svg>
              )}
            </div>
          );
          return (
            // wrapper 高度从 0 展开：旧泡被连续顶起（布局级丝滑，零补偿零瞬移）；
            // 组内（同侧连发）间距收紧到 0.38×——对话的呼吸节奏（聊天 App 分组惯例）
            <div
              key={i}
              style={{
                alignSelf: isUser ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
                height: `${(estHeights[i] * Math.min(1, pop * 1.15)).toFixed(1)}px`,
                marginTop: `${((start ? gap : gap * 0.38) * Math.min(1, pop * 1.15)).toFixed(1)}px`,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: isUser ? 'row-reverse' : 'row',
                alignItems: 'flex-start',
                pointerEvents: 'none',
              }}
            >
              {avatar}
              <div
                style={{
                  marginLeft: isUser ? 0 : avatarOn ? avatarGap : 0,
                  marginRight: isUser ? (avatarOn ? avatarGap : 0) : 0,
                  maxWidth: '100%',
                  opacity: Math.min(1, pop * 1.2),
                  // 入场：从发送侧水平滑入 + 向下滑落 + 倾斜落正（镜像）
                  transform: `scale(${(0.9 + 0.1 * pop).toFixed(4)}) translate(${((isUser ? 1 : -1) * (1 - pop) * fontSize * 0.9).toFixed(1)}px, ${(-(1 - pop) * estHeights[i] * 0.7).toFixed(1)}px) rotate(${((isUser ? 1 : -1) * (1 - pop) * 8).toFixed(2)}deg)`,
                  transformOrigin: isUser ? 'top right' : 'top left',
                  // 用户气泡=accent 165° 渐变 + 顶部内高光（对抗纯平色块）；AI 中性卡不变
                  background: isUser
                    ? `linear-gradient(165deg, ${accent}, ${shadeHex(accent, -0.13)})`
                    : cardBg,
                  border: isUser ? 'none' : `1px solid ${cardBorder}`,
                  color: isUser ? '#FFFFFF' : inkTitle,
                  borderRadius: 18,
                  // 圆角阶梯（分组语义，内侧角=用户右/AI左）：组中间条首尾内侧都收紧
                  // 到 6（连发成块）；组界保持尾巴角语言——顶内侧 5（原版方向暗示）、
                  // 底内侧 18；外侧恒 18。groupOn=0 → prevSame/nextSame 恒 false=原版
                  borderTopRightRadius: isUser ? (prevSame(i) ? 6 : 5) : undefined,
                  borderTopLeftRadius: isUser ? undefined : prevSame(i) ? 6 : 5,
                  borderBottomRightRadius: isUser ? (nextSame(i) ? 6 : 18) : undefined,
                  borderBottomLeftRadius: isUser ? undefined : nextSame(i) ? 6 : 18,
                  padding: `${padY}px ${padX}px`,
                  boxShadow: onLight
                    ? `0 8px 22px -10px rgba(23, 24, 28, 0.25)${isUser ? ', inset 0 1px 0 rgba(255,255,255,0.25)' : ''}`
                    : `0 10px 26px -12px rgba(0, 0, 0, 0.5)${isUser ? ', inset 0 1px 0 rgba(255,255,255,0.22)' : ''}`,
                  fontSize,
                  lineHeight: 1.5,
                  height: fixedContentH(i),
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {typingNow
                  ? // 打字三点：相位错落的圆点呼吸
                    <span style={{display: 'inline-flex', alignItems: 'center', gap: fontSize * 0.28, height: fontSize * 1.2}}>
                      {[0, 1, 2].map((d) => (
                        <span
                          key={d}
                          style={{
                            width: fontSize * 0.22,
                            height: fontSize * 0.22,
                            borderRadius: '50%',
                            background: inkBody,
                            opacity: 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(frame * 0.55 - d * 1.1)),
                          }}
                        />
                      ))}
                    </span>
                  : textQ > 0
                    ? <span style={{opacity: textQ, display: 'inline-block'}}>{line.text}</span>
                    : null}
                {/* meta 行：组首时间戳（入场时刻 m:ss，回放流逝感）+ 用户 ✓✓ 已读。
                    typing 期占位不显（opacity 0）——高度早已入 estHeights，换文零跳 */}
                {hasMeta(i) && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: isUser ? 'space-between' : 'flex-end',
                      alignItems: 'center',
                      gap: fontSize * 0.3,
                      fontSize: fontSize * 0.58,
                      lineHeight: 1,
                      letterSpacing: '0.04em',
                      marginTop: fontSize * 0.22,
                      color: isUser ? 'rgba(255, 255, 255, 0.85)' : inkBody,
                      opacity: typingNow ? 0 : 0.62 * textQ,
                      pointerEvents: 'none',
                    }}
                  >
                    {isUser && <span style={{letterSpacing: '0.08em', fontVariantNumeric: 'tabular-nums'}}>{chatTimestampLabel(appear / FPS)}</span>}
                    {isUser
                      ? <span style={{letterSpacing: '0.1em'}}>✓✓</span>
                      : groupStarts[i] && <span style={{fontVariantNumeric: 'tabular-nums'}}>{chatTimestampLabel(appear / FPS)}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ✓N 任务徽章：右下角（AI 条数=并行任务能力暗示，随变「✓11」同款语言） */}
      {badgeOn && aiCount > 0 && (() => {
        const pop = springProgress((frame - badgeEnter) / CHAT_BUBBLE_POP_FRAMES);
        if (pop <= 0.001) return null;
        return (
          <div
            style={{
              position: 'absolute',
              right: canvasW * 0.06,
              bottom: bottom + canvasH * 0.05,
              padding: `${canvasH * 0.008}px ${canvasW * 0.012}px`,
              borderRadius: 999,
              background: onLight ? 'rgba(23, 24, 28, 0.82)' : 'rgba(255, 255, 255, 0.1)',
              border: `1px solid ${onLight ? 'rgba(23,24,28,0.3)' : 'rgba(255,255,255,0.2)'}`,
              color: '#FFFFFF',
              fontSize: tokens.fontSize.body * 0.9,
              fontWeight: 600,
              fontFamily: VIDEO_DESIGN.bodyFont,
              opacity: Math.min(1, pop * 1.2),
              transform: `scale(${(0.7 + 0.3 * pop).toFixed(3)})`,
              pointerEvents: 'none',
            }}
          >
            ✓ {aiCount}
          </div>
        );
      })()}

      {/* 品牌名：左下角小字 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.06,
            bottom: bottom + canvasH * 0.05,
            color: onLight ? 'rgba(23, 24, 28, 0.5)' : 'rgba(255, 255, 255, 0.5)',
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
