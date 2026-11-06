/**
 * 模板: PanelFlyout - UI 拆层飞出（B6 旗舰，随变临摹复盘「时间线/属性板从主界面后面飞出」）
 *
 * 视频 + UI 区域清单（clip.uiRegions，来自 <素材名>.regions.json sidecar）：
 * 底层 = 整幅录屏，flyAt 起后压暗+微虚化（「其他部分模糊隐去」）；各区域（侧栏/属性板/
 * 时间轴…）裁成独立圆角卡层——卡内是窗口式像素级对齐副本（与聚焦浮出同款数学）——
 * 按角色方向（侧栏向左/属性板向右/时间轴向下）弹簧飞出并放大，错峰 stagger。
 * role=main（或最大区域）不飞，作为主界面垫底。
 *
 * 区域来源三路（B6 视觉检测线裁决：能力要通用，不只是片语）：
 * - visual：scripts/extract-ui-regions.cjs 视觉检测（任意录屏可用）
 * - cdp：Electron/web UI 经 CDP 直接分析 DOM 结构元素（精确盒）
 * - ax：无障碍树 / computer-use UI 列表（接口留位，录制侧增强）
 *
 * 无区域数据时退化为整幅静帧（不空场）；帧驱动确定性，无 Clock。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {ClipMedia} from '../layers/ClipMedia';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {makeParamReader} from '../utils/params';
import {clipEndSec} from '../../shared/clipCuts';
import {springProgress} from '../../shared/click-zoom-smooth';
import type {UiRegionSource} from '../../shared/ui-regions';
import {PANEL_FLYOUT_PARAMS} from '../../shared/template-registry';

/** 确定性散列（0-1）：飞出距离/角度的逐区域微差（同输入恒同输出） */
const hashUnit = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
};

/** 角色飞出方向（单位向量）：侧栏向左 / 属性板向右 / 时间轴向下 / 其余向外上 */
const roleDirection = (role: UiRegionSource['role'], cx: number, cy: number): {x: number; y: number} => {
  if (role === 'sidebar') return {x: -1, y: 0};
  if (role === 'panel') return {x: 1, y: 0};
  if (role === 'timeline') return {x: 0, y: 1};
  // main/未知：按区域中心相对画面中心的方向向外（退化保护）
  const dx = cx - 0.5;
  const dy = cy - 0.5;
  const len = Math.hypot(dx, dy) || 1;
  return {x: dx / len, y: dy / len};
};

export const PanelFlyout: React.FC<TemplateProps> = ({
  videos,
  text,
  segmentDuration,
  style,
  params,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const totalFrames = Math.max(1, Math.round((segmentDuration || 6) * FPS));

  const p = makeParamReader(PANEL_FLYOUT_PARAMS, params);
  const flyAt = p('flyAt');           // 起飞时刻（段长比例）
  const flyStagger = p('flyStagger'); // 错峰间隔（秒）
  const flyAmp = p('flyAmp');         // 飞出距离倍率
  const dim = p('dim');               // 底层压暗
  const blurBgOn = p('blurBg') >= 0.5; // 底层微虚化

  const video = videos[0];
  const videoW = video?.width || canvasW;
  const videoH = video?.height || canvasH;
  const regions = (video?.uiRegions ?? []).slice(0, 6);

  // cover 拟合 + 垂直裁切上限（画幅审计 P0-2）：画布比素材宽时满幅 cover 会把
  // UI 顶栏/时间轴整条裁掉（21:9 实锤裁上下 12%）——裁切封顶画布高的 8%，
  // 超出部分换左右留边（垫底层起飞后压暗+虚化，留边不抢戏；区域卡与窗口副本
  // 全走同一 offX/offY/dispW/dispH 仿射，对位恒成立）。16:9 及更窄画幅天然
  // 不触上限（cover 本来只裁 <1%），现役行为零漂移。
  const coverW = canvasW / videoW;
  const coverH = canvasH / videoH;
  const V_CROP_MAX = 0.08;
  const coverScale =
    coverW > coverH ? Math.min(coverW, (canvasH * (1 + V_CROP_MAX)) / videoH) : Math.max(coverW, coverH);
  const dispW = videoW * coverScale;
  const dispH = videoH * coverScale;
  const offX = (canvasW - dispW) / 2;
  const offY = (canvasH - dispH) / 2;

  // 主界面垫底：role=main 优先，否则面积最大者
  let backdrop: UiRegionSource | null = regions.find((r) => r.role === 'main') ?? null;
  if (!backdrop && regions.length > 0) {
    backdrop = regions.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
  }
  const flying = regions.filter((r) => r !== backdrop);
  // 区域多于 1 块时垫底层与飞出层才有意义；仅 main 一块 = 全幅垫底（不飞）
  const flyStart = Math.round(flyAt * totalFrames);
  const dimQ = interpolate(frame, [flyStart, flyStart + Math.round(0.35 * FPS)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const bgBlur = blurBgOn ? 5 * dimQ : 0;
  const bgFilter =
    dimQ > 0.001
      ? `brightness(${(1 - dim * dimQ).toFixed(3)})${bgBlur > 0.05 ? ` blur(${bgBlur.toFixed(1)}px)` : ''}`
      : undefined;

  // 入场淡入（出场转场由 MultiSegmentPromo 统一负责）
  const opacity = interpolate(frame, [0, 10], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  /** 区域 i 的飞出进度（错峰弹簧） */
  const flyQOf = (i: number): number => {
    const delay = Math.round(i * flyStagger * FPS);
    const q = (frame - flyStart - delay) / Math.max(1, Math.round(0.75 * FPS));
    return springProgress(Math.min(1, Math.max(0, q)));
  };

  return (
    <AbsoluteFill style={{opacity}}>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {video && (
        <AbsoluteFill>
          {/* 垫底层：整幅录屏（flyAt 后压暗+微虚化，「其他部分模糊隐去」） */}
          <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
            <ClipMedia
              src={video.src}
              mediaType={video.type}
              muted={video.muted}
              volume={video.volume}
              startFrom={Math.round((video.trimStart || 0) * FPS)}
              endSec={clipEndSec(video)}
              cutsSec={video.cuts}
              style={{
                position: 'absolute', left: offX, top: offY, width: dispW, height: dispH,
                objectFit: 'fill', filter: bgFilter,
              }}
            />
          </div>

          {/* 飞出层：各区域独立圆角卡，窗口式像素对齐副本 + 角色方向弹簧飞出 */}
          {flying.map((r, i) => {
            const q = flyQOf(i);
            if (q <= 0.001) return null; // 起飞前与垫底层重合（垫底已显示该区域）
            const rectX = offX + r.x * dispW;
            const rectY = offY + r.y * dispH;
            const rectW = r.w * dispW;
            const rectH = r.h * dispH;
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            const dir = roleDirection(r.role, cx, cy);
            const jitterA = (hashUnit(r.id) - 0.5) * 0.35; // ±10° 方向微差
            const cos = Math.cos(jitterA);
            const sin = Math.sin(jitterA);
            const dx = dir.x * cos - dir.y * sin;
            const dy = dir.x * sin + dir.y * cos;
            const dist = flyAmp * canvasH * (0.24 + 0.14 * hashUnit(`${r.id}:d`)) * q;
            const scale = 1 + 0.05 * q;
            const margin = 6;
            const left = Math.max(margin, Math.min(rectX, canvasW - rectW - margin));
            const top = Math.max(margin, Math.min(rectY, canvasH - rectH - margin));
            return (
              <div
                key={r.id}
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width: rectW,
                  height: rectH,
                  overflow: 'hidden',
                  borderRadius: 14,
                  border: '1px solid rgba(255, 255, 255, 0.18)',
                  boxShadow: `0 ${Math.round(18 + 30 * q)}px ${Math.round(44 + 40 * q)}px -14px rgba(0, 0, 0, ${0.4 + 0.3 * q})`,
                  transform: `translate(${(dx * dist).toFixed(1)}px, ${(dy * dist).toFixed(1)}px) scale(${scale.toFixed(4)})`,
                  opacity: Math.min(1, q * 4),
                  pointerEvents: 'none',
                  zIndex: 2 + i,
                }}
              >
                {/* 窗口式副本：与垫底层同参对齐，卡窗即原位像素 */}
                <div
                  style={{
                    position: 'absolute',
                    left: offX - left,
                    top: offY - top,
                    width: videoW,
                    height: videoH,
                    transform: `scale(${coverScale})`,
                    transformOrigin: '0 0',
                  }}
                >
                  <ClipMedia
                    src={video.src}
                    mediaType={video.type}
                    muted
                    startFrom={Math.round((video.trimStart || 0) * FPS)}
                    endSec={clipEndSec(video)}
                    cutsSec={video.cuts}
                    style={{width: '100%', height: '100%', objectFit: 'fill'}}
                  />
                </div>
                {r.label && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 8,
                      top: 8,
                      padding: '3px 10px',
                      borderRadius: 999,
                      background: 'rgba(10, 14, 24, 0.72)',
                      border: '1px solid rgba(255,255,255,0.16)',
                      color: 'rgba(255,255,255,0.9)',
                      fontSize: Math.max(12, canvasW * 0.009),
                      fontFamily: 'inherit',
                      pointerEvents: 'none',
                    }}
                  >
                    {r.label}
                  </div>
                )}
              </div>
            );
          })}
        </AbsoluteFill>
      )}
      {/* 文字层：底部标题/副标题条（与 CursorFollow 同款暗衬底——拆层转场段的「在干什么」提示）。
          zIndex 20：区域卡 zIndex 2+i 会飞过底部，文字条必须压在最上（v5 实锤被时间轴卡盖住） */}
      {text?.title && (
        <div style={{position: 'absolute', bottom: canvasH * 0.08, left: 0, right: 0, textAlign: 'center', zIndex: 20}}>
          <div style={{
            display: 'inline-block',
            padding: '14px 30px 16px',
            borderRadius: 18,
            background: 'rgba(7, 11, 18, 0.55)',
            boxShadow: '0 10px 36px rgba(0, 0, 0, 0.35)',
          }}>
            <div style={{
              fontSize: style?.title?.fontSize ?? canvasW * 0.032,
              fontWeight: style?.title?.fontWeight ?? 700,
              color: style?.title?.color ?? '#F2F6FF',
              letterSpacing: '-0.01em',
              textShadow: '0 2px 16px rgba(0, 0, 0, 0.65), 0 1px 3px rgba(0, 0, 0, 0.8)',
            }}>
              {text.title}
            </div>
            {text.subtitle && (
              <div style={{
                marginTop: 8,
                fontSize: style?.subtitle?.fontSize ?? canvasW * 0.016,
                fontWeight: 500,
                color: style?.subtitle?.color ?? 'rgba(242,246,255,0.75)',
                textShadow: '0 1px 10px rgba(0, 0, 0, 0.6)',
              }}>
                {text.subtitle}
              </div>
            )}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
