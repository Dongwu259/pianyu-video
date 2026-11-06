/**
 * BgmCreditLayer - 配乐署名层（片尾强制烧录，用户拍板 2026-10-13）
 *
 * 内置配乐为 CC BY 4.0（有署名义务）：成片最后 ~2.8s 在底部中央淡入一行
 * 标准署名（Music: <曲> by <作者> (域名) · CC BY 4.0），随片尾淡出一起消失。
 * 「强制」= 只要 bgm.credit 的许可是 CC BY 系就渲染，无用户开关——署名义务
 * 不给漏掉的机会。与 FinePrintLayer（用户常驻小字）分层不互扰：本层抬高一行
 * 避开 finePrint 的 bottomCenter 位置。
 *
 * 署名行格式与导出完成提示/描述区复制共用 shared/bgm-credits.ts 的 bgmCreditLine。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {bgmCreditLine, isAttributionRequired, type BgmCredit} from '../../shared/bgm-credits';
import {getScaledTokens} from '../config/designTokens';
import {safeBottom} from '../utils/safeArea';

interface BgmCreditLayerProps {
  credit: BgmCredit;
  /** 成片总帧数（含片尾淡黑）；窗口锚定在 [endFrame-2.8s, endFrame) */
  endFrame: number;
}

/** 署名窗口时长（秒）：足够读完一行，又不喧宾夺主 */
const CREDIT_WINDOW_SEC = 2.8;
/** 淡入/淡出帧数：淡入独立、淡出贴片尾黑（不突兀弹出/消失） */
const CREDIT_FADE_FRAMES = 12;

export const BgmCreditLayer: React.FC<BgmCreditLayerProps> = ({credit, endFrame}) => {
  const frame = useCurrentFrame();
  const {width, height, fps} = useVideoConfig();
  const tokens = getScaledTokens(width, height);

  if (!isAttributionRequired(credit)) return null;

  const windowFrames = Math.round(CREDIT_WINDOW_SEC * fps);
  const start = endFrame - windowFrames;
  if (frame < start || frame >= endFrame) return null;

  const inCurve = Math.min(1, (frame - start + 1) / CREDIT_FADE_FRAMES);
  const outCurve = Math.min(1, (endFrame - frame) / CREDIT_FADE_FRAMES);
  const opacity = 0.8 * Math.min(inCurve, outCurve);
  if (opacity <= 0.01) return null;

  const fontSize = Math.max(10, Math.round(height * 0.014));
  // 抬高一行避开 FinePrintLayer 的底部小字位（两者同现也不压字）
  const marginBottom = safeBottom(width, height, Math.round(height * 0.015)) + Math.round(height * 0.038);

  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: Math.round(width * 0.04),
          right: Math.round(width * 0.04),
          bottom: marginBottom,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            color: '#ffffff',
            fontSize,
            fontFamily: tokens.bodyFont,
            fontWeight: 400,
            lineHeight: 1.4,
            letterSpacing: '0.03em',
            textAlign: 'center',
            whiteSpace: 'nowrap',
            opacity,
            textShadow: '0 1px 3px rgba(0, 0, 0, 0.6)',
          }}
        >
          {bgmCreditLine(credit)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default BgmCreditLayer;
