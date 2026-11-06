/**
 * 模板: UICallout - 录屏局部放大标注（进阶装置）
 *
 * 效果: 录屏素材增值器——全屏铺满后向焦点平滑推近（行业标准节奏：
 * 点击前 ~0.8s 推进、讲解时 hold、结尾按需退出），焦点处品牌色圆环
 * 描边生长 + 脉冲，标题做成焦点旁的标注芯片。竖版天然放大效果更佳。
 *
 * 焦点原理：transformOrigin 设在焦点上，推近时焦点像素在屏幕上不动，
 * 圆环画在屏幕坐标系焦点处即与内容对齐（不需要反解内容坐标）。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - videos[0]: 录屏素材（1 段，cover 全屏铺满）
 * - title: 标注文案（芯片，如「一键生成故事板」）
 * - subtitle: 可选补充小字
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: UI_CALLOUT_PARAMS）：zoom 推近倍率 /
 * focusX 焦点横坐标(0-1) / focusY 焦点纵坐标(0-1) / circleScale 圆环大小 /
 * zoomOut 结尾拉远(0关/1开) / zoomSec 推近时长（拉远/画圈按节奏比例联动）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {EASINGS, entryEase} from '../animations/motion';
import {fitVideo} from '../utils/fitVideo';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {UI_CALLOUT_PARAMS} from '../../shared/template-registry';
import {clipEndSec} from '../../shared/clipCuts';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

export const UICallout: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);

  const p = makeParamReader(UI_CALLOUT_PARAMS, params);
  const zoomLevel = p('zoom');               // 推近倍率
  const focusX = Math.min(0.95, Math.max(0.05, p('focusX'))); // 焦点（钳制在安全范围）
  const focusY = Math.min(0.95, Math.max(0.05, p('focusY')));
  const circleScale = p('circleScale');      // 圆环大小倍率
  const zoomOut = Math.round(p('zoomOut')) === 1; // 结尾是否拉远
  const zoomSec = p('zoomSec');              // 推近时长（拉远/画圈按现有节奏比例联动）
  const entry = entryEase(p('motionEase'));  // 推近缓动档位：0=模板原曲线（C 批统一时间语言）

  const video = videos[0];
  if (!video) {
    // 无素材不成立：渲染底色与文案提示（不会黑屏崩渲染）
    return (
      <AbsoluteFill style={{background: '#0F172A'}}>
        {text.title && (
          <div style={{position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: tokens.fontSize.subtitle, fontFamily: tokens.bodyFont}}>
            {text.title}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ====== 推近时间线：zoomSec 推进 → hold → 结尾拉远（可选） ======
  // 三个时序由 zoomSec 按原节奏比例联动（默认 0.8s → 推 24 帧 / 拉 16 帧 / 画圈 12 帧）
  const zoomInDur = Math.max(6, Math.round(zoomSec * FPS));
  const zoomOutDur = Math.max(6, Math.round(zoomInDur * (16 / 24)));
  const zoomOutStart = zoomOut
    ? Math.max(zoomInDur + 10, totalDurationFrames - (zoomOutDur + 2))
    : Infinity;
  const inProg = interpolate(frame, [0, zoomInDur], [1, zoomLevel], {
    easing: entry,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outProg =
    frame >= zoomOutStart
      ? interpolate(frame, [zoomOutStart, zoomOutStart + zoomOutDur], [zoomLevel, 1], {
          easing: EASINGS.inOut,
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : zoomLevel;
  const scaleNow = frame >= zoomOutStart ? outProg : inProg;

  // 驻留微运动：入场完成后素材绕焦点缓慢呼吸、标注芯片轻微漂移（P2 质感）
  // （breathe 以焦点为 transformOrigin，焦点像素不动，圆环标注对齐不受影响；
  //   cover 全屏素材只做扩张相 [1,1.012]——收缩半周会在画布外缘露底）
  const breathe = dwellBreathe(frame, FPS, 0.006, 4.5, 0) + 0.006;
  const chipDrift = dwellDrift(frame, FPS, 2.5 * (canvasW / 1920), 2 * (canvasW / 1920), 9, 0);

  // ====== 圆环标注：推近到位后描边生长 + 常驻脉冲（时长随 zoomSec 联动） ======
  const circleStart = zoomInDur + 4;
  const circleDur = Math.max(6, Math.round(zoomInDur / 2));
  const circleProg = interpolate(frame, [circleStart, circleStart + circleDur], [0, 1], {
    easing: EASINGS.standard,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const pulse = 0.5 + 0.5 * Math.sin((frame - circleStart) * 0.09);

  // ====== 版式 ======
  const fit = fitVideo(canvasW, canvasH, video.width, video.height, 'cover');
  const focusPx = {x: canvasW * focusX, y: canvasH * focusY};
  const R = Math.min(canvasW, canvasH) * 0.16 * circleScale;
  const chipFs = tokens.fontSize.body * 0.95;
  // 芯片放圆环下方（焦点靠下沿时翻到上方）
  const chipBelow = focusY < 0.62;
  const chipTop = chipBelow ? focusPx.y + R + chipFs * 0.7 : focusPx.y - R - chipFs * 2.3;
  const chipLeft = Math.min(Math.max(focusPx.x - canvasW * 0.18, canvasW * 0.05), canvasW * 0.5);

  return (
    <AbsoluteFill style={{background: '#0F172A'}}>
      {/* 素材：cover 全屏，向焦点推近（origin 在焦点 → 焦点不动） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          transform: `scale(${scaleNow * breathe})`,
          transformOrigin: `${focusX * 100}% ${focusY * 100}%`,
        }}
      >
        <div style={{position: 'absolute', left: -fit.offsetX, top: -fit.offsetY, width: fit.width, height: fit.height}}>
          <ClipMedia
            src={video.src}
            mediaType={video.type}
            muted={video.muted}
            volume={video.volume}
            startFrom={Math.round((video.trimStart || 0) * FPS)}
            endSec={clipEndSec(video)}
            cutsSec={video.cuts}
            style={{width: '100%', height: '100%', objectFit: 'fill'}}
          />
        </div>
      </div>
      <BackgroundEffectLayer />

      {/* 圆环标注：屏幕坐标系焦点处（推近时焦点不动，天然对齐） */}
      <svg
        style={{position: 'absolute', left: 0, top: 0, pointerEvents: 'none'}}
        width={canvasW}
        height={canvasH}
      >
        <circle
          cx={focusPx.x}
          cy={focusPx.y}
          r={R * circleProg}
          fill="none"
          stroke={ACCENT()}
          strokeWidth={Math.max(3, canvasW * 0.0028)}
          opacity={0.95}
        />
        {circleProg > 0.9 && (
          <circle
            cx={focusPx.x}
            cy={focusPx.y}
            r={R * (1.06 + pulse * 0.16)}
            fill="none"
            stroke={ACCENT()}
            strokeWidth={Math.max(1.5, canvasW * 0.0014)}
            opacity={0.35 * (1 - pulse)}
          />
        )}
      </svg>

      {/* 标注芯片 + 补充小字 */}
      {text.title && (
        <div
          style={{
            position: 'absolute',
            left: chipLeft,
            top: Math.max(canvasH * 0.05, chipTop),
            width: canvasW * 0.4,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            opacity: fadeIn(frame, circleStart + 8, 10),
            transform: `translate(${chipDrift.x}px, ${chipDrift.y}px)`,
          }}
        >
          <div
            style={{
              background: ACCENT(),
              color: '#FFFFFF',
              fontSize: chipFs,
              fontWeight: 700,
              fontFamily: VIDEO_DESIGN.bodyFont,
              borderRadius: chipFs * 0.5,
              padding: `${chipFs * 0.22}px ${chipFs * 0.6}px`,
              lineHeight: 1.3,
              boxShadow: `0 ${chipFs * 0.3}px ${chipFs * 0.8}px rgba(0,0,0,0.35)`,
            }}
          >
            {text.title}
          </div>
          {text.subtitle && (
            <div
              style={{
                color: 'rgba(255,255,255,0.85)',
                fontSize: tokens.fontSize.caption * 1.05,
                fontWeight: 400,
                fontFamily: VIDEO_DESIGN.bodyFont,
                lineHeight: 1.4,
                marginTop: tokens.spacing.element * 0.7,
                textShadow: '0 1px 4px rgba(0,0,0,0.6)',
                opacity: fadeIn(frame, circleStart + 14, 10),
              }}
            >
              {text.subtitle}
            </div>
          )}
        </div>
      )}

      {/* 品牌名 */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.05,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.05),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: fadeIn(frame, 10, 14),
          }}
        >
          <div style={{width: 8, height: 8, borderRadius: '50%', background: ACCENT()}} />
          <span
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
              fontWeight: style?.brand?.fontWeight ?? 500,
              color: 'rgba(255,255,255,0.85)',
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.14em',
              textShadow: '0 1px 4px rgba(0,0,0,0.5)',
            }}
          >
            {text.brandName}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default UICallout;
