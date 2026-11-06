/**
 * GroundScene - 3D 地面元素层（AR 贴地效果）
 *
 * 数学与结构（见 shared/groundTrack.ts 头注 + scripts/ground-matrix3d-spike.ts 实证）：
 * 地面坐标系 = 分析参考帧的图像坐标（视频像素），z 轴垂直地面向上（朝相机）。
 * 每帧由锚点轨迹解出 3x4 投影矩阵 P，嵌入 CSS matrix3d（浏览器自动透视除法），
 * 外层容器 transformOrigin 必须 '0 0'（默认 50% 50% 会把平移列绕画布中心重排）。
 * 元素子树 transformStyle: preserve-3d，立起（rotateX(-90°) 绕底边）/抬升
 * （translateZ）/绕竖轴（rotateZ）等 3D 变换与外层投影正确组合。
 *
 * 挂载：ClipMedia 内、媒体元素的兄弟位置（同盒同 transform 链——模板 3D 画框、
 * KenBurns 推拉、稳定校正全都同构继承）；本文件出口 GroundMediaOverlay 由
 * ClipMedia 在检出 GroundTrackingContext 条目时渲染。
 */

import React, {useLayoutEffect, useRef, useState} from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {VIDEO_DESIGN} from '../config/designTokens';
import {timelineToMediaSec} from '../../shared/clipCuts';
import type {ClipCut} from '../../shared/clipCuts';
import {autoYawScreenUpright, autoYawTowardCamera, cameraCenterFromP, groundMatrix3dAt, homographyFromP} from '../../shared/groundTrack';
import type {CameraPos} from '../../shared/groundTrack';
import type {GroundElement} from '../../shared/types';
import type {GroundOverlayEntry} from './groundTracking';

const r4 = (n: number): number => Math.round(n * 10000) / 10000;

/** hex 颜色明暗缩放（k<1 变暗；非 hex 原样返回） */
const shade = (hex: string, k: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (shift: number) => Math.max(0, Math.min(255, Math.round(((n >> shift) & 0xff) * k)));
  return `rgb(${c(16)}, ${c(8)}, ${c(0)})`;
};

/** 入场进度（0..1，easeOutCubic；segment 局部帧驱动，rise/fade 消费） */
const entranceProgress = (frame: number, fps: number): number => {
  const dur = Math.round(fps * 0.6);
  if (dur <= 0) return 1;
  const p = Math.max(0, Math.min(1, frame / dur));
  return 1 - Math.pow(1 - p, 3);
};

// ====== 元素渲染（全部在地面坐标系，视频像素单位）======

interface ElementCtx {
  videoW: number;
  videoH: number;
  frame: number;
  fps: number;
  /** 当帧相机中心（地面坐标）：立起面板未显式设 yawDeg 时正面朝它 */
  cam?: CameraPos;
  /** 当帧地面单应（homographyFromP）：躺平/立体文字未显式设 yawDeg 时保持画面正立 */
  h?: number[];
}

/**
 * 生效朝向：显式 yawDeg 优先；缺省自动——立起面板/立牌正面朝相机（俯拍、
 * 绕行机位下固定 0° 会背对镜头显镜像），躺平/立体文字保持画面内正立
 * （相机平移/环绕/俯拍/侧滚下始终可读，AR 贴地文字的标准行为）。
 */
const uprightYawDeg = (el: GroundElement, h?: number[]): number =>
  el.yawDeg ?? (h ? autoYawScreenUpright(h) : 0);

const facingYawDeg = (el: GroundElement, gx: number, gy: number, cam?: CameraPos): number =>
  el.yawDeg ?? (cam ? autoYawTowardCamera(cam, gx, gy) : 0);

/**
 * 三轴姿态链（接在 rotateZ(yaw) 之后）：pitch 绕地面水平轴倾斜（躺平文字 ±90° =
 * 竖立面向 yaw 方向），roll 在元素自身平面内打转。CSS 右结合：roll 先在自身平面
 * 旋转，再随 pitch 倾斜，最后由 yaw 定向——三者正交，可合成三维中任意朝向。
 */
const orientCss = (el: GroundElement): string =>
  `${el.pitchDeg ? ` rotateX(${r4(el.pitchDeg)}deg)` : ''}${el.rollDeg ? ` rotateZ(${r4(el.rollDeg)}deg)` : ''}`;

/** 厚度倍率（缺省 1，0.2~3；extruded 挤出厚度 / 几何体高度） */
const depthMul = (el: GroundElement): number =>
  el.depth !== undefined && el.depth > 0 ? Math.min(3, el.depth) : 1;

/** 贴地阴影：基点处的椭圆渐变（立体元素共用） */
const GroundShadow: React.FC<{gx: number; gy: number; w: number; opacity?: number}> = ({gx, gy, w, opacity = 0.35}) => (
  <div style={{
    position: 'absolute', left: gx - w / 2, top: gy - w * 0.16, width: w, height: w * 0.32,
    background: `radial-gradient(ellipse at center, rgba(0,0,0,${opacity}) 0%, rgba(0,0,0,0) 68%)`,
  }} />
);

/** 躺平文字（z=0 平面；lift 可浮空） */
const FlatText: React.FC<{el: GroundElement; ctx: ElementCtx; color: string; fontPx: number; p: number}> = ({el, ctx, color, fontPx, p}) => {
  const w = el.size * ctx.videoW;
  const rise = el.entrance === 'rise' ? (1 - p) * fontPx * 0.6 : 0;
  const lift = (el.lift ?? 0) * ctx.videoW;
  const yaw = uprightYawDeg(el, ctx.h);
  return (
    <div style={{
      position: 'absolute',
      left: el.u * ctx.videoW - w / 2, top: el.v * ctx.videoH - fontPx * 0.75,
      width: w, height: fontPx * 1.5,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: VIDEO_DESIGN.titleFont, fontWeight: 800, whiteSpace: 'nowrap',
      fontSize: fontPx, color,
      textShadow: '0 2px 12px rgba(0,0,0,0.45)',
      transformOrigin: '50% 50%',
      transform: `translateZ(${r4(lift - rise)}px) rotateZ(${r4(yaw)}deg)${orientCss(el)}`,
      opacity: (el.opacity ?? 1) * (el.entrance === 'fade' ? p : 1),
    }}>
      {el.text}
    </div>
  );
};

/** 立起面板文字（广告牌：绕底边立起，透视高度真实） */
const BillboardText: React.FC<{el: GroundElement; ctx: ElementCtx; color: string; fontPx: number; p: number; panel?: boolean}> = ({el, ctx, color, fontPx, p, panel}) => {
  const w = el.size * ctx.videoW;
  const h = fontPx * 1.9;
  const rise = el.entrance === 'rise' ? (1 - p) * h : 0;
  const yaw = facingYawDeg(el, el.u * ctx.videoW, el.v * ctx.videoH, ctx.cam);
  return (
    <div style={{
      position: 'absolute',
      left: el.u * ctx.videoW - w / 2, top: el.v * ctx.videoH - h,
      width: w, height: h,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: VIDEO_DESIGN.titleFont, fontWeight: 800, whiteSpace: 'nowrap',
      fontSize: fontPx, color: panel ? '#ffffff' : color,
      ...(panel ? {
        background: `linear-gradient(180deg, ${shade(color, 1.12)} 0%, ${color} 100%)`,
        borderRadius: fontPx * 0.18,
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      } : {
        textShadow: '0 3px 16px rgba(0,0,0,0.5)',
      }),
      transformOrigin: '50% 100%',
      // pitch 并入立起角（前倾/后仰），roll 在面板自身平面内打转
      transform: `translateZ(${r4(-(el.lift ?? 0) * ctx.videoW - rise)}px) rotateZ(${r4(yaw)}deg) rotateX(${r4(-90 + (el.pitchDeg ?? 0))}deg)${el.rollDeg ? ` rotateZ(${r4(el.rollDeg)}deg)` : ''}`,
      opacity: (el.opacity ?? 1) * (el.entrance === 'fade' ? p : 1),
    }}>
      {el.text}
    </div>
  );
};

/** 立体厚度字（多层切片近似挤出；躺在地上向上隆起；depth 调挤出厚度） */
const ExtrudedText: React.FC<{el: GroundElement; ctx: ElementCtx; color: string; fontPx: number; p: number}> = ({el, ctx, color, fontPx, p}) => {
  const w = el.size * ctx.videoW;
  const dMul = depthMul(el);
  const depth = fontPx * 0.3 * dMul;
  // 层数随厚度走：厚了层间不脱节，薄了不浪费（10 层为基准，8~24 封顶）
  const layers = Math.max(8, Math.min(24, Math.round(10 * dMul)));
  const lift = (el.lift ?? 0) * ctx.videoW;
  const rise = el.entrance === 'rise' ? (1 - p) * depth * 2 : 0;
  const boxH = fontPx * 1.5;
  const yaw = uprightYawDeg(el, ctx.h);
  return (
    <div style={{
      position: 'absolute',
      left: el.u * ctx.videoW - w / 2, top: el.v * ctx.videoH - boxH / 2,
      width: w, height: boxH,
      transformOrigin: '50% 50%',
      transform: `translateZ(${r4(lift - rise)}px) rotateZ(${r4(yaw)}deg)${orientCss(el)}`,
      opacity: (el.opacity ?? 1) * (el.entrance === 'fade' ? p : 1),
    }}>
      {Array.from({length: layers}, (_, i) => {
        const k = i / (layers - 1); // 0 底层 → 1 顶层
        return (
          <div key={i} style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: VIDEO_DESIGN.titleFont, fontWeight: 800, whiteSpace: 'nowrap',
            fontSize: fontPx, color: shade(color, 0.32 + 0.68 * k),
            transform: `translateZ(${r4(k * depth)}px)`,
          }}>
            {el.text}
          </div>
        );
      })}
    </div>
  );
};

/** 立体几何体通用面片：绕竖轴分布的竖直面（盒/柱/锥共用的构造原语） */
const SidePanel: React.FC<{
  thetaDeg: number; radius: number; width: number; height: number;
  zOffset: number; color: string; k: number; clipPath?: string;
}> = ({thetaDeg, radius, width, height, zOffset, color, k, clipPath}) => (
  <div style={{
    position: 'absolute', left: -width / 2, top: -height, width, height,
    transformOrigin: '50% 100%',
    transform: `rotateZ(${r4(thetaDeg)}deg) translateX(${r4(radius)}px) translateZ(${r4(zOffset)}px) rotateX(-90deg)`,
    background: `linear-gradient(180deg, ${shade(color, k * 1.18)} 0%, ${shade(color, k * 0.72)} 100%)`,
    clipPath,
  }} />
);

/** 立方体 / 圆柱 / 锥体（CSS 3D 面片拼装；底面贴地；depth = 高度倍率） */
const GroundShape: React.FC<{el: GroundElement; ctx: ElementCtx; color: string; p: number}> = ({el, ctx, color, p}) => {
  const w = el.size * ctx.videoW;
  const h = w * 0.75 * depthMul(el);
  const gx = el.u * ctx.videoW;
  const gy = el.v * ctx.videoH;
  const rise = el.entrance === 'rise' ? (1 - p) * h * 0.8 : 0;
  const lift = (el.lift ?? 0) * ctx.videoW;

  let faces: React.ReactNode = null;
  if (el.form === 'box') {
    const d = w * 0.85;
    faces = (
      <>
        {/* 顶面（水平，高度 h） */}
        <div style={{
          position: 'absolute', left: -w / 2, top: -d / 2, width: w, height: d,
          background: shade(color, 1.25),
          transform: `translateZ(${r4(h)}px)`,
        }} />
        {/* 四侧面：θ=0/+x 宽 d，θ=90/+y 宽 w */}
        <SidePanel thetaDeg={0} radius={w / 2} width={d} height={h} zOffset={0} color={color} k={0.82} />
        <SidePanel thetaDeg={180} radius={w / 2} width={d} height={h} zOffset={0} color={color} k={0.58} />
        <SidePanel thetaDeg={90} radius={d / 2} width={w} height={h} zOffset={0} color={color} k={1} />
        <SidePanel thetaDeg={270} radius={d / 2} width={w} height={h} zOffset={0} color={color} k={0.66} />
      </>
    );
  } else if (el.form === 'cylinder') {
    const r = w / 2;
    const N = 16;
    const chord = 2 * r * Math.tan(Math.PI / N) + 1.2;
    faces = (
      <>
        {Array.from({length: N}, (_, i) => {
          const theta = (i * 360) / N;
          const faceLight = 0.55 + 0.5 * Math.max(0, Math.cos(((theta - 300) * Math.PI) / 180));
          return (
            <SidePanel key={i} thetaDeg={theta} radius={r} width={chord} height={h} zOffset={0}
              color={color} k={faceLight} />
          );
        })}
        {/* 顶面圆盘 */}
        <div style={{
          position: 'absolute', left: -r, top: -r, width: r * 2, height: r * 2,
          borderRadius: '50%', background: shade(color, 1.22),
          transform: `translateZ(${r4(h)}px)`,
        }} />
      </>
    );
  } else { // cone
    const r = w / 2;
    const N = 18;
    const chord = 2 * r * Math.tan(Math.PI / N) + 1.2;
    faces = (
      <>
        {Array.from({length: N}, (_, i) => {
          const theta = (i * 360) / N;
          const faceLight = 0.5 + 0.5 * Math.max(0, Math.cos(((theta - 300) * Math.PI) / 180));
          return (
            <SidePanel key={i} thetaDeg={theta + 90 / N} radius={r} width={chord} height={h} zOffset={0}
              color={color} k={faceLight}
              clipPath={`polygon(50% 0, 100% 100%, 0 100%)`} />
          );
        })}
      </>
    );
  }

  return (
    <>
      <GroundShadow gx={gx} gy={gy} w={w * 1.25} />
      <div style={{
        position: 'absolute', left: gx, top: gy, width: 0, height: 0,
        transformStyle: 'preserve-3d',
        transform: `translateZ(${r4(lift - rise)}px) rotateZ(${r4(el.yawDeg ?? 0)}deg)${orientCss(el)}`,
        opacity: (el.opacity ?? 1) * (el.entrance === 'fade' ? p : 1),
      }}>
        {faces}
      </div>
    </>
  );
};

/** 立牌（纯色竖立面板，无文字） */
const PlateShape: React.FC<{el: GroundElement; ctx: ElementCtx; color: string; p: number}> = ({el, ctx, color, p}) => {
  const w = el.size * ctx.videoW;
  const h = w * 0.62;
  const rise = el.entrance === 'rise' ? (1 - p) * h : 0;
  const yaw = facingYawDeg(el, el.u * ctx.videoW, el.v * ctx.videoH, ctx.cam);
  return (
    <>
      <GroundShadow gx={el.u * ctx.videoW} gy={el.v * ctx.videoH} w={w * 1.1} />
      <div style={{
        position: 'absolute',
        left: el.u * ctx.videoW - w / 2, top: el.v * ctx.videoH - h,
        width: w, height: h,
        background: `linear-gradient(180deg, ${shade(color, 1.15)} 0%, ${color} 100%)`,
        borderRadius: Math.min(14, w * 0.05),
        boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
        transformOrigin: '50% 100%',
        transform: `translateZ(${r4(-(el.lift ?? 0) * ctx.videoW - rise)}px) rotateZ(${r4(yaw)}deg) rotateX(${r4(-90 + (el.pitchDeg ?? 0))}deg)${el.rollDeg ? ` rotateZ(${r4(el.rollDeg)}deg)` : ''}`,
        opacity: (el.opacity ?? 1) * (el.entrance === 'fade' ? p : 1),
      }} />
    </>
  );
};

// ====== 场景出口 ======

/** 元素子树渲染（matrix3d 容器的 children；Remotion 渲染与静态预览共用） */
const GroundElementsView: React.FC<{elements: GroundElement[]; ctx: ElementCtx; p: number}> = ({elements, ctx, p}) => {
  const accent = VIDEO_DESIGN.colors.accent;
  return (
    <>
      {elements.map((el) => {
        const color = el.color ?? accent;
        const w = el.size * ctx.videoW;
        const len = Math.max(2, (el.text ?? '').length);
        const fontPx = Math.min(w * 0.16, (w * 1.12) / len);
        const key = el.id;
        if (el.kind === 'text') {
          if (el.form === 'billboard') {
            return <React.Fragment key={key}>
              <GroundShadow gx={el.u * ctx.videoW} gy={el.v * ctx.videoH} w={w * 0.9} />
              <BillboardText el={el} ctx={ctx} color={color} fontPx={fontPx} p={p} />
            </React.Fragment>;
          }
          if (el.form === 'extruded') {
            return <ExtrudedText key={key} el={el} ctx={ctx} color={color} fontPx={fontPx} p={p} />;
          }
          return <FlatText key={key} el={el} ctx={ctx} color={color} fontPx={fontPx} p={p} />;
        }
        if (el.form === 'plate') return <PlateShape key={key} el={el} ctx={ctx} color={color} p={p} />;
        return <GroundShape key={key} el={el} ctx={ctx} color={color} p={p} />;
      })}
    </>
  );
};

export const GroundScene3D: React.FC<{entry: GroundOverlayEntry; solved: {P: number[]; css: string}}> = ({entry, solved}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const cam = cameraCenterFromP(solved.P) ?? undefined;
  const h = homographyFromP(solved.P);
  const ctx: ElementCtx = {videoW: entry.videoW, videoH: entry.videoH, frame, fps, cam, h};
  const p = entranceProgress(frame, fps);
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      width: entry.videoW, height: entry.videoH,
      transformOrigin: '0 0', transformStyle: 'preserve-3d',
      transform: solved.css,
    }}>
      <GroundElementsView elements={entry.elements} ctx={ctx} p={p} />
    </div>
  );
};

/**
 * 静态地面场景（无 Remotion 依赖）：GroundModal 弹窗预览用。
 * 铺在「视频像素坐标系」里（与渲染路径同构），外层负责把容器缩放到预览盒
 * （transform: scale(容器宽/videoW)，origin 0 0）；入场进度固定 1（入场完成态）。
 * pointerEvents: none 不挡上层交互（拖拽标记）。
 */
export const GroundSceneStatic: React.FC<{
  elements: GroundElement[];
  videoW: number;
  videoH: number;
  solved: {P: number[]; css: string};
}> = ({elements, videoW, videoH, solved}) => {
  const cam = cameraCenterFromP(solved.P) ?? undefined;
  const h = homographyFromP(solved.P);
  const ctx: ElementCtx = {videoW, videoH, frame: 0, fps: 30, cam, h};
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      width: videoW, height: videoH,
      transformOrigin: '0 0', transformStyle: 'preserve-3d',
      pointerEvents: 'none',
      transform: solved.css,
    }}>
      <GroundElementsView elements={elements} ctx={ctx} p={1} />
    </div>
  );
};
// ====== ClipMedia 集成出口 =====

export interface GroundMediaOverlayProps {
  entry: GroundOverlayEntry;
  /** ClipMedia 侧的媒体元素 style（模板适配/变换全在这里，兄弟元素复刻同链） */
  style?: React.CSSProperties;
  /** 稳定校正 transform（ClipMedia 已算好；与媒体元素同一串，保证同构） */
  stabTransform: string;
  /** 视频起播帧（挖段时间轴换算用，与 ClipMedia 同参） */
  startFrom: number;
  cutsSec?: ClipCut[];
  /** 窗口尾（媒体绝对秒）：ClipMedia 封口时同步钳制，冻结帧上元素不再漂移 */
  endSec?: number;
}

/**
 * 媒体兄弟层的地面 3D 场景：复刻媒体元素的盒几何与 transform 链 → 测量盒实际
 * 尺寸（useLayoutEffect + offsetWidth/Height，逐帧确定性）→ 按 object-fit 算出
 * 视频显示矩形 → 3D 场景（视频像素坐标系）经 translate/scale/matrix3d 贴上去。
 * 溢出按媒体盒裁切（overflow hidden；裁切发生在场景子树已透视除法之后，安全）。
 */
export const GroundMediaOverlay: React.FC<GroundMediaOverlayProps> = ({entry, style, stabTransform, startFrom, cutsSec, endSec}) => {
  const {fps} = useVideoConfig();
  const frame = useCurrentFrame();
  const probeRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{w: number; h: number} | null>(null);

  useLayoutEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setBox((prev) => (prev && prev.w === w && prev.h === h ? prev : {w, h}));
  });

  const mediaSec0 = timelineToMediaSec(frame / fps, startFrom / fps, cutsSec);
  const mediaSec = endSec !== undefined ? Math.min(mediaSec0, endSec) : mediaSec0;
  const gm = groundMatrix3dAt(entry.track, entry.videoW, entry.videoH, mediaSec);
  if (!gm || !box || box.w <= 0 || box.h <= 0) {
    return (
      <div ref={probeRef} aria-hidden style={{
        ...(style ?? {}), position: 'absolute', left: 0, top: 0, objectFit: undefined,
        transform: stabTransform, pointerEvents: 'none', visibility: 'hidden',
      }} />
    );
  }

  // object-fit 等效显示矩形（媒体元素盒内的视频内容矩形）
  const objectFit = (style?.objectFit as string | undefined) ?? 'contain';
  const vw = entry.videoW;
  const vh = entry.videoH;
  let dispW: number;
  let dispH: number;
  if (objectFit === 'fill') {
    dispW = box.w;
    dispH = box.h;
  } else if (objectFit === 'cover') {
    const s = Math.max(box.w / vw, box.h / vh);
    dispW = vw * s;
    dispH = vh * s;
  } else {
    const s = Math.min(box.w / vw, box.h / vh);
    dispW = vw * s;
    dispH = vh * s;
  }
  const offX = (box.w - dispW) / 2;
  const offY = (box.h - dispH) / 2;
  const sx = dispW / vw;
  const sy = dispH / vh;

  return (
    <div style={{
      ...(style ?? {}),
      // 显式 left/top 0：媒体元素多为静态定位，兄弟层若靠 auto 静态位置定位，
      // 会被前面的块级媒体顶到其下方（出画）；显式锚定父级（= 媒体所在框）原点
      position: 'absolute', left: 0, top: 0, objectFit: undefined,
      transform: `${stabTransform}${style?.transform ? ` ${style.transform}` : ''}`,
      transformOrigin: style?.transformOrigin ?? '50% 50%',
      overflow: 'hidden', pointerEvents: 'none',
    }}>
      <div ref={probeRef} style={{position: 'absolute', width: '100%', height: '100%', visibility: 'hidden'}} />
      <div style={{
        position: 'absolute', left: 0, top: 0,
        transformOrigin: '0 0',
        transform: `translate(${r4(offX)}px, ${r4(offY)}px) scale(${r4(sx)}, ${r4(sy)})`,
      }}>
        <GroundScene3D entry={entry} solved={gm} />
      </div>
    </div>
  );
};
