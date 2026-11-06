/**
 * PanelBoard - 3D 场景模板的媒体/文字展板（CameraJourney3D 抽出，四款共用）
 *
 * 结构：品牌色描边发光底板 + 深色薄板 + 媒体平面（视频/图片纹理，cover 已在纹理侧裁切）
 * 或纯文字排版（毛玻璃大字卡：半透明板面 + 品牌色装饰条 + 大字）；媒体展板的标题 =
 * 板面底部暗条（任何驻留距离都在画内）。
 * 挂在父 group 下（浮动/朝向由父级控制）；文字第 0 帧就在位（远景/飞行途中无半成品字）。
 *
 * 美化光标：媒体展板可带录屏光标轨迹（cursorPoints/clicks，模板按驻留窗口算好 cursorSec
 * 传入）——发光点 + 点击脉冲画在板面上，随展板一起透视；无轨迹/无点击时零开销。
 */
import React, {useMemo} from 'react';
import * as THREE from 'three';
import {RoundedBox} from '@react-three/drei';
import {ThreeText} from './ThreeText';
import type {CursorClick, CursorPoint} from '../../shared/capture';

export interface PanelBoardProps {
  /** 板面宽高（three 世界单位） */
  pw: number;
  ph: number;
  /** 品牌色（描边发光底板） */
  accent: string;
  /** 视频展板纹理（与 imageTexture 二选一） */
  videoTexture?: THREE.Texture | null;
  /** 图片展板纹理 */
  imageTexture?: THREE.Texture | null;
  /** 展板标题（features 行）；无媒体时做成毛玻璃文字卡 */
  caption?: string;
  /** 字号倍率（= panelSize 档位） */
  textScale?: number;
  /** 展板标题独立字号倍率（captionSize 参数；默认 1） */
  captionScale?: number;
  /** 底板发光呼吸（1 = 常态；驻留时模板传 1~1.45 的正弦呼吸） */
  glowPulse?: number;
  /** 倒影模式（GalleryHall3D 地板假倒影）：低透明材质 + 省略文字层（防倒立字穿帮） */
  mirror?: boolean;
  /** 美化光标：录屏鼠标轨迹（视频像素坐标）与点击事件；随 cursorSec 驱动 */
  cursorPoints?: CursorPoint[];
  cursorClicks?: CursorClick[];
  /** 光标当前对应的媒体时间（秒，素材绝对时间；<0 或缺省 = 不显示） */
  cursorSec?: number;
  /** 轨迹坐标的视频像素尺寸 */
  cursorVW?: number;
  cursorVH?: number;
}

/** 光标精灵贴图：柔和光晕点（径向渐变，白心 + 品牌色晕）；模块级缓存按色调一次生成 */
const glowDotCache = new Map<string, THREE.CanvasTexture>();
const glowDotTexture = (accent: string): THREE.CanvasTexture => {
  const hit = glowDotCache.get(accent);
  if (hit) return hit;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.42, accent + 'CC');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  glowDotCache.set(accent, tex);
  return tex;
};

export const PanelBoard: React.FC<PanelBoardProps> = ({
  pw,
  ph,
  accent,
  videoTexture,
  imageTexture,
  caption,
  textScale = 1,
  captionScale = 1,
  glowPulse = 1,
  mirror = false,
  cursorPoints,
  cursorClicks,
  cursorSec = -1,
  cursorVW = 1920,
  cursorVH = 1080,
}) => {
  const hasMedia = !!videoTexture || !!imageTexture;
  const showCaption = !!caption && !mirror;
  // 标题条位置：抬离板底（0.30）避免与画面下缘的段字幕重叠
  const capY = -(ph / 2 - 0.3 * textScale);

  // ====== 美化光标：当前时刻的点位 + 最近一次点击（≤0.32s 内触发脉冲） ======
  const cursor = useMemo(() => {
    if (!cursorPoints || cursorPoints.length === 0 || cursorSec < 0 || !hasMedia || mirror) return null;
    const tMs = cursorSec * 1000;
    if (tMs < cursorPoints[0].t) return null; // 首航点之前光标尚未入画（不冻结在中心）
    let p: CursorPoint = cursorPoints[0];
    for (const q of cursorPoints) {
      if (q.t <= tMs) p = q;
      else break;
    }
    const click = (cursorClicks ?? []).reduce<CursorClick | null>((best, c) => {
      const dt = tMs - c.t;
      return dt >= 0 && dt <= 320 && (!best || c.t > best.t) ? c : best;
    }, null);
    const pulse = click ? 1 - (tMs - click.t) / 320 : 0;
    // 视频像素 → 板面局部坐标（cover 裁切近似为直接缩放：纹理侧已裁到板比例）
    const x = (p.x / cursorVW - 0.5) * pw;
    const y = -(p.y / cursorVH - 0.5) * ph;
    return {x, y, pulse};
  }, [cursorPoints, cursorClicks, cursorSec, cursorVW, cursorVH, pw, ph, hasMedia, mirror]);

  return (
    <>
      {/* 品牌色描边发光底板 + 薄板（glowPulse 驻留呼吸；castShadow 供方向光投影） */}
      <RoundedBox args={[pw + 0.26, ph + 0.26, 0.04]} radius={0.07} smoothness={4} position={[0, 0, -0.045]} castShadow>
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.48 * glowPulse} roughness={0.4} metalness={0.4} transparent={mirror} opacity={mirror ? 0.3 : 1} />
      </RoundedBox>
      <RoundedBox args={[pw + 0.16, ph + 0.16, 0.08]} radius={0.05} smoothness={4} castShadow>
        <meshStandardMaterial color="#151C2A" roughness={0.5} metalness={0.5} transparent={mirror} opacity={mirror ? 0.4 : 1} />
      </RoundedBox>

      {videoTexture && (
        <mesh position={[0, 0, 0.041]}>
          <planeGeometry args={[pw, ph]} />
          <meshBasicMaterial map={videoTexture} toneMapped={false} transparent={mirror} opacity={mirror ? 0.3 : 1} />
        </mesh>
      )}
      {!videoTexture && imageTexture && (
        <mesh position={[0, 0, 0.041]}>
          <planeGeometry args={[pw, ph]} />
          <meshBasicMaterial map={imageTexture} toneMapped={false} transparent={mirror} opacity={mirror ? 0.3 : 1} />
        </mesh>
      )}

      {/* 美化光标：小号光晕点贴在画面上层 + 点击扩散环（帧驱动确定性） */}
      {cursor && (
        <>
          <mesh position={[cursor.x, cursor.y, 0.062]}>
            <planeGeometry args={[0.15, 0.15]} />
            <meshBasicMaterial map={glowDotTexture(accent)} transparent opacity={0.92} toneMapped={false} depthWrite={false} />
          </mesh>
          {cursor.pulse > 0 && (
            <mesh position={[cursor.x, cursor.y, 0.061]} scale={1 + (1 - cursor.pulse) * 2.0}>
              <ringGeometry args={[0.042, 0.054, 32]} />
              <meshBasicMaterial color={accent} transparent opacity={cursor.pulse * 0.75} toneMapped={false} depthWrite={false} />
            </mesh>
          )}
        </>
      )}

      {/* 纯文字展板（毛玻璃大字卡）：半透明板面 + 品牌色装饰条 + 大字居中 */}
      {!hasMedia && showCaption && (
        <>
          <mesh position={[0, 0, 0.044]}>
            <planeGeometry args={[pw * 1.04, ph * 1.04]} />
            <meshBasicMaterial color={accent} transparent opacity={0.14} toneMapped={false} depthWrite={false} />
          </mesh>
          <mesh position={[0, ph * 0.30, 0.045]}>
            <boxGeometry args={[pw * 0.22, 0.05, 0.02]} />
            <meshBasicMaterial color={accent} />
          </mesh>
          <ThreeText text={caption} size={0.44 * textScale} depth={0.035} color="#F5F8FF" maxWidth={pw * 0.85} startFrame={0} stagger={2} position={[0, -0.02, 0.05]} />
        </>
      )}

      {/* 媒体展板标题：板面底部暗条（任何驻留距离都在画内） */}
      {hasMedia && showCaption && (
        <>
          <mesh position={[0, capY, 0.048]}>
            <planeGeometry args={[pw, 0.44 * textScale * captionScale]} />
            <meshBasicMaterial color="#0A0F18" transparent opacity={0.72} />
          </mesh>
          <ThreeText
            text={caption}
            size={0.19 * textScale * captionScale}
            depth={0.025}
            color="#E8F0FF"
            maxWidth={pw * 0.9}
            startFrame={0}
            stagger={2}
            position={[0, capY, 0.06]}
          />
        </>
      )}
    </>
  );
};
