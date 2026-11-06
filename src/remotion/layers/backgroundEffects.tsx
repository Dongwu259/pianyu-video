/**
 * 背景特效 - 作用于片段背景层（基础背景之上、视频/文字之下）。
 *
 * 与视频画布特效独立。由 BackgroundEffectContext 注入当前片段的背景特效类型，
 * 各模板在背景块之后渲染 <BackgroundEffectLayer/> 消费（置于背景之上、视频之下）。
 *
 * 国风特效（inkDrip/inkSplash/inkWash）自带宣纸底色；商业特效自带深色底色
 * （云雾/光斑/光束/粒子均为发光叠加，浅色模板上会不可见，故必须自带底色）。
 * 每帧用确定性伪随机驱动动画，预览(Player)与渲染一致。
 */
import React, {createContext, useContext} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import type {BackgroundEffect} from '../../shared/types';
import {easeOutBack, easeOutCubic, inkBlotPath, inkDripPath, inkTendrilPath, mountainPath, rand, smoothOpenPath} from '../utils/ink';

export const BackgroundEffectContext = createContext<BackgroundEffect>('none');

/** 便捷 Hook：取当前片段的背景特效。 */
export const useBackgroundEffect = (): BackgroundEffect => useContext(BackgroundEffectContext);

/** 宣纸底色（国风特效用）。 */
const PAPER_BG = 'linear-gradient(135deg, #F5F1E6 0%, #EDE4CF 100%)';
const INK = 'rgba(20,16,28,';

/** 宣纸纤维纹理（feTurbulence 灰度噪声，低透明度 multiply 叠加）。 */
const PAPER_GRAIN_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23p)'/%3E%3C/svg%3E";

/** 宣纸底 + 纤维纹理。 */
const PaperBase: React.FC = () => (
  <>
    <AbsoluteFill style={{background: PAPER_BG}} />
    <AbsoluteFill
      style={{
        backgroundImage: `url("${PAPER_GRAIN_URL}")`,
        backgroundSize: '200px 200px',
        opacity: 0.07,
        mixBlendMode: 'multiply',
      }}
    />
  </>
);

// ====== 国风：墨汁滴落 ======
const InkDripBg: React.FC<{frame: number}> = ({frame}) => {
  const {width, height} = useVideoConfig();
  const aspect = width / height;
  // 滴柱参数：各自独立循环，easeOutCubic 先快后慢，收尾淡出；每轮换新摆动种子
  const drips = Array.from({length: 8}, (_, i) => {
    const cycle = 240 + rand(i * 13.7) * 120;
    const phase = rand(i * 7.9) * cycle;
    const t = (frame + phase) % cycle;
    const curCycle = Math.floor((frame + phase) / cycle);
    const prog = Math.min(1, t / (cycle * 0.42));
    const fadeStart = cycle * 0.86;
    return {
      x: 4 + (i / 8) * 94 + rand(i * 9.1) * 5,
      w: 0.35 + rand(i * 5.3) * 0.65, // 宽度（% 画布宽）
      len: easeOutCubic(prog) * (35 + rand(i * 3.7) * 48), // 当前长度（% 画布高）
      op: (t > fadeStart ? Math.max(0, 1 - (t - fadeStart) / (cycle - fadeStart)) : 1) * (0.45 + rand(i * 6.1) * 0.4),
      seed: i * 17.3 + curCycle * 91.7,
    };
  });
  // 顶部墨缘：波浪底边 + 每滴根部隆起（墨汁从缘边"汇聚"成滴）
  const bandPts: {x: number; y: number}[] = [];
  for (let x = -4; x <= 104; x += 3) {
    let y = 2.4 + Math.sin(x * 0.31) * 0.5 + rand(x * 1.7) * 0.9;
    for (const d of drips) {
      y += (1.1 + d.w * 2.2) * Math.exp(-((x - d.x) * (x - d.x)) / 5.1);
    }
    bandPts.push({x, y: Math.min(y, 13)});
  }
  const bandPath = `${smoothOpenPath(bandPts)} L 104,-4 L -4,-4 Z`;
  return (
    <>
      <PaperBase />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', filter: 'blur(0.5px)'}}
      >
        <defs>
          <linearGradient id="inkdrip-band" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={`${INK}0.9)`} />
            <stop offset="1" stopColor={`${INK}0.5)`} />
          </linearGradient>
        </defs>
        <path d={bandPath} fill="url(#inkdrip-band)" />
        {drips.map((d, i) =>
          d.len > 0.6 && d.op > 0.01 ? (
            <path key={i} d={inkDripPath(d.x, d.len, d.w, d.seed, aspect)} fill={`${INK}${d.op.toFixed(3)})`} />
          ) : null,
        )}
      </svg>
    </>
  );
};

// ====== 国风：墨汁喷溅 ======
const InkSplashBg: React.FC<{frame: number}> = ({frame}) => {
  const {width, height} = useVideoConfig();
  const unit = Math.min(width, height) / 100; // 短边基准尺寸单位，保证不同比例下大小一致
  const CYCLE = 190;
  const splashes = Array.from({length: 6}, (_, i) => {
    const local = frame - i * 26;
    if (local < 0) return null;
    const cyc = Math.floor(local / CYCLE);
    const t = local % CYCLE;
    if (t > 125) return null; // 每轮 125 帧生命周期，间隔后换位置重新喷
    const seed = i * 131.7 + cyc * 57.3; // 每轮换形态种子 → 每轮喷溅形状都不同
    const size = (4.6 + rand(seed + 1.3) * 5.6) * unit; // 主墨团基准半径 px
    return {
      key: i,
      seed,
      x: 10 + rand(seed + 2.1) * 80,
      y: 12 + rand(seed + 3.7) * 68,
      size,
      grow: easeOutBack(t / 26), // 炸开带回弹
      dotFly: easeOutCubic(t / 30), // 卫星点飞出
      op: t < 8 ? t / 8 : t > 80 ? Math.max(0, 1 - (t - 80) / 35) : 1,
      rot: rand(seed + 5.9) * 360,
    };
  }).filter((s): s is NonNullable<typeof s> => s !== null);
  return (
    <>
      <PaperBase />
      {splashes.map((s) => {
        const box = Math.ceil(s.size * 9); // 容纳远溅细点
        // 卫星墨点：角度/距离/大小全随机，少量大点 + 大量小点
        const dots = Array.from({length: 14}, (_, j) => {
          const ang = rand(s.seed + 10.1 + j * 3.3) * Math.PI * 2;
          const dist = s.size * (0.9 + Math.pow(rand(s.seed + 11.7 + j * 5.1), 1.6) * 2.1);
          const r = Math.max(0.8, s.size * (0.04 + Math.pow(rand(s.seed + 12.9 + j * 7.7), 2) * 0.13));
          return {ang, dist, r, a: 0.5 + rand(s.seed + 13.3 + j) * 0.35};
        });
        // 远溅细点
        const specks = Array.from({length: 9}, (_, j) => {
          const ang = rand(s.seed + 20.1 + j * 4.3) * Math.PI * 2;
          const dist = s.size * (2.6 + rand(s.seed + 21.7 + j * 6.1) * 1.8);
          return {ang, dist, r: 0.6 + rand(s.seed + 22.9 + j) * 1.2};
        });
        // 拖尾触手 3-5 条
        const tendrils = Array.from({length: 3 + Math.floor(rand(s.seed + 30.1) * 3)}, (_, j) => ({
          ang: rand(s.seed + 31.7 + j * 8.3) * Math.PI * 2,
          len: s.size * (1.1 + rand(s.seed + 32.9 + j) * 1.3),
          w: s.size * (0.1 + rand(s.seed + 33.3 + j) * 0.1),
          seed: s.seed + 34.1 + j,
        }));
        return (
          <div key={s.key} style={{position: 'absolute', left: `${s.x}%`, top: `${s.y}%`}}>
            <svg
              width={box}
              height={box}
              viewBox={`${-box / 2} ${-box / 2} ${box} ${box}`}
              style={{
                position: 'absolute',
                left: -box / 2,
                top: -box / 2,
                overflow: 'visible',
                opacity: s.op.toFixed(3),
                filter: 'blur(0.4px)',
              }}
            >
              <g transform={`rotate(${f2(s.rot)}) scale(${f2(s.grow)})`}>
                {/* 三层同形墨团：外浅内深，模拟洇染边缘 */}
                <path d={inkBlotPath(s.seed, 0, 0, s.size)} fill={`${INK}0.4)`} />
                <path d={inkBlotPath(s.seed, 0, 0, s.size * 0.78)} fill={`${INK}0.7)`} />
                <path d={inkBlotPath(s.seed + 1.1, 0, 0, s.size * 0.48)} fill={`${INK}0.88)`} />
                {tendrils.map((td, j) => (
                  <path key={j} d={inkTendrilPath(td.seed, td.ang, td.len * s.grow, td.w)} fill={`${INK}0.55)`} />
                ))}
                {dots.map((d, j) => {
                  const dist = d.dist * s.dotFly;
                  return (
                    <circle
                      key={j}
                      cx={f2(Math.cos(d.ang) * dist)}
                      cy={f2(Math.sin(d.ang) * dist)}
                      r={f2(d.r)}
                      fill={`${INK}${d.a.toFixed(2)})`}
                    />
                  );
                })}
                {specks.map((d, j) => {
                  const dist = d.dist * s.dotFly;
                  return (
                    <circle
                      key={`sp${j}`}
                      cx={f2(Math.cos(d.ang) * dist)}
                      cy={f2(Math.sin(d.ang) * dist)}
                      r={f2(d.r)}
                      fill={`${INK}0.5)`}
                    />
                  );
                })}
              </g>
            </svg>
          </div>
        );
      })}
    </>
  );
};

const f2 = (v: number): string => v.toFixed(2);

// ====== 国风：水墨山水 ======
const InkWashBg: React.FC<{frame: number}> = ({frame}) => {
  // 三层山水平视差漂移（远慢近快、相位错开），营造云水流动感
  const dFar = Math.sin(frame * 0.006) * 6;
  const dMid = Math.sin(frame * 0.01 + 1) * 9;
  const dLow = Math.sin(frame * 0.013 + 1.6) * 10.5;
  const dNear = Math.sin(frame * 0.016 + 2) * 12;
  // 云雾持续横向流动（正弦往返，平滑无跳变）
  const mist1 = Math.sin(frame * 0.02) * 22;
  const mist2 = Math.sin(frame * 0.015 + 2) * 22;
  const moonGlow = 0.7 + Math.sin(frame * 0.03) * 0.2;
  // 四层山：谐波 + 主峰的平滑山脊线，垂直渐变晕染（上浓下淡，没入雾水）
  const far = mountainPath(1, 47, 12, {rough: 0.55});
  const mid = mountainPath(2, 57, 16, {rough: 0.8});
  const low = mountainPath(3, 68, 19, {rough: 1});
  const near = mountainPath(4, 83, 22, {rough: 1.15});
  // 水波涟漪：长短不一的淡墨横线，缓慢漂移
  const ripples = Array.from({length: 7}, (_, i) => ({
    x: 6 + rand(i * 4.1) * 58,
    y: 79 + i * 2.4 + rand(i * 6.7) * 1.5,
    len: 7 + rand(i * 8.3) * 12,
    op: 0.1 + rand(i * 9.9) * 0.1,
    drift: Math.sin(frame * 0.012 + i * 1.3) * 3,
  }));
  // 飞鸟：三只墨雁，横向缓漂 + 翅膀扇动
  const birds = [
    {bx: 33, by: 17, s: 1},
    {bx: 39.5, by: 20.5, s: 0.72},
    {bx: 45, by: 15.5, s: 0.55},
  ].map((b, i) => ({
    ...b,
    x: b.bx + Math.sin(frame * 0.01 + i * 2.1) * 2.5,
    flap: 1 + 0.3 * Math.sin(frame * 0.28 + i * 1.7),
  }));
  const GULL = 'M -1.8,0 Q -0.9,-1.2 0,-0.3 Q 0.9,-1.2 1.8,0 Q 0.9,-0.6 0,0.05 Q -0.9,-0.6 -1.8,0 Z';
  const MOON_X = 72;
  return (
    <>
      <PaperBase />
      {/* 月（光晕呼吸）+ 大晕 */}
      <div
        style={{
          position: 'absolute',
          left: `${MOON_X}%`,
          top: '20%',
          width: '22%',
          aspectRatio: '1',
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(246,241,224,0.55), rgba(246,241,224,0.12) 55%, transparent 75%)',
          opacity: moonGlow,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: `${MOON_X}%`,
          top: '20%',
          width: '8.5%',
          aspectRatio: '1',
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background: 'radial-gradient(circle at 38% 35%, #FDFAF0, #F4EDD8 72%)',
          boxShadow: '0 0 34px 10px rgba(248,243,226,0.65)',
          opacity: 0.98,
        }}
      />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{position: 'absolute', inset: 0, width: '100%', height: '100%'}}>
        <defs>
          {/* 山体重墨 → 底部渐隐，模拟水墨晕染 */}
          <linearGradient id="iw-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(60,70,86,0.17)" />
            <stop offset="1" stopColor="rgba(60,70,86,0.03)" />
          </linearGradient>
          <linearGradient id="iw-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(42,50,64,0.32)" />
            <stop offset="1" stopColor="rgba(42,50,64,0.06)" />
          </linearGradient>
          <linearGradient id="iw-low" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(28,34,46,0.46)" />
            <stop offset="1" stopColor="rgba(28,34,46,0.1)" />
          </linearGradient>
          <linearGradient id="iw-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(17,21,31,0.72)" />
            <stop offset="1" stopColor="rgba(17,21,31,0.24)" />
          </linearGradient>
          <linearGradient id="iw-water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(130,145,158,0)" />
            <stop offset="0.3" stopColor="rgba(130,145,158,0.11)" />
            <stop offset="1" stopColor="rgba(100,115,132,0.2)" />
          </linearGradient>
          <linearGradient id="iw-refl" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(243,238,220,0.28)" />
            <stop offset="1" stopColor="rgba(243,238,220,0)" />
          </linearGradient>
        </defs>
        {/* 远山（最淡，微虚化） */}
        <g transform={`translate(${dFar.toFixed(2)})`} style={{filter: 'blur(1.2px)'}}>
          <path d={far.path} fill="url(#iw-far)" />
        </g>
        {/* 山间云雾带 A */}
        <rect x={(-25 + mist1).toFixed(1)} y="44" width="150" height="9" fill="rgba(245,242,232,0.5)" style={{filter: 'blur(7px)'}} />
        {/* 中山 */}
        <g transform={`translate(${dMid.toFixed(2)})`} style={{filter: 'blur(0.8px)'}}>
          <path d={mid.path} fill="url(#iw-mid)" />
        </g>
        {/* 水面 */}
        <rect x="-40" y="74" width="180" height="26" fill="url(#iw-water)" />
        {/* 月影（微微闪烁） */}
        <rect x={(MOON_X - 1.4).toFixed(1)} y="75" width="2.8" height="14" fill="url(#iw-refl)" opacity={(0.6 + Math.sin(frame * 0.05) * 0.25).toFixed(2)} />
        {/* 涟漪 */}
        {ripples.map((r, i) => (
          <path
            key={i}
            d={`M ${(r.x + r.drift).toFixed(1)},${r.y.toFixed(1)} h ${r.len.toFixed(1)}`}
            stroke={`rgba(40,52,68,${r.op.toFixed(2)})`}
            strokeWidth="0.28"
            strokeLinecap="round"
            fill="none"
          />
        ))}
        {/* 低山 */}
        <g transform={`translate(${dLow.toFixed(2)})`} style={{filter: 'blur(0.4px)'}}>
          <path d={low.path} fill="url(#iw-low)" />
        </g>
        {/* 山间云雾带 B */}
        <rect x={(-25 + mist2).toFixed(1)} y="62" width="150" height="8" fill="rgba(245,242,232,0.45)" style={{filter: 'blur(8px)'}} />
        {/* 近山（最浓） */}
        <g transform={`translate(${dNear.toFixed(2)})`}>
          <path d={near.path} fill="url(#iw-near)" />
        </g>
        {/* 飞鸟 */}
        {birds.map((b, i) => (
          <g key={i} transform={`translate(${b.x.toFixed(1)},${b.by}) scale(${b.s},${(b.s * b.flap).toFixed(2)})`} opacity="0.7">
            <path d={GULL} fill="rgba(30,36,48,0.8)" />
          </g>
        ))}
      </svg>
    </>
  );
};

// ====== 国风：云雾飘动 ======
const MistDriftBg: React.FC<{frame: number}> = ({frame}) => {
  const clouds = Array.from({length: 8}, (_, i) => ({
    y: 6 + i * 12 + rand(i * 3) * 8,
    size: 320 + rand(i * 5) * 280,
    speed: 0.22 + rand(i * 7) * 0.35,
    phase: rand(i * 11) * 130,
    op: 0.3 + rand(i * 13) * 0.32,
    dark: i % 3 === 2, // 穿插暗云，增加远近层次
  }));
  return (
    <>
      {/* 晨雾山谷底色（云雾为亮白叠加，需深色底衬托） */}
      <AbsoluteFill style={{background: 'linear-gradient(180deg, #2B3644 0%, #46566A 55%, #6B7C8C 100%)'}} />
      {clouds.map((c, i) => {
        const x = ((frame * c.speed + c.phase) % 130) - 15;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: `${c.y}%`,
              left: `${x}%`,
              width: c.size,
              height: c.size * 0.45,
              background: c.dark
                ? 'radial-gradient(ellipse, rgba(26,34,44,0.6), transparent 70%)'
                : 'radial-gradient(ellipse, rgba(252,253,255,0.92), transparent 70%)',
              filter: 'blur(18px)',
              opacity: c.op,
            }}
          />
        );
      })}
    </>
  );
};

// ====== 商业：光斑散景 ======
const BokehBg: React.FC<{frame: number}> = ({frame}) => {
  const circles = Array.from({length: 24}, (_, i) => ({
    x: rand(i * 7) * 100,
    size: 28 + rand(i * 5) * 110,
    speed: 0.25 + rand(i * 3) * 0.45, // 上浮速度（更快）
    phase: rand(i * 11) * 100,
    hue: rand(i * 13) * 360,
    op: 0.35 + rand(i * 17) * 0.4,
    twinkle: rand(i * 19) * Math.PI * 2, // 闪烁相位
    pulse: rand(i * 23) * Math.PI * 2, // 大小脉动相位
    sway: rand(i * 29) * Math.PI * 2, // 水平摆动相位
    blur: Math.floor(rand(i * 31) * 3) * 2, // 景深：0/2/4px 虚化差异
  }));
  return (
    <>
      {/* 夜景底色（散景为发光叠加，需深色底衬托） */}
      <AbsoluteFill style={{background: 'linear-gradient(160deg, #101726 0%, #1A2338 60%, #222C46 100%)'}} />
      {circles.map((c, i) => {
        const y = (((c.phase - frame * c.speed) % 100) + 100) % 100;
        const sway = Math.sin(frame * 0.02 + c.sway) * 4;
        const op = Math.max(0, c.op * (0.45 + Math.sin(frame * 0.08 + c.twinkle) * 0.55));
        const scale = 0.8 + Math.sin(frame * 0.05 + c.pulse) * 0.2;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${(c.x + sway).toFixed(1)}%`,
              top: `${y.toFixed(1)}%`,
              width: c.size,
              height: c.size,
              borderRadius: '50%',
              background: `radial-gradient(circle, hsla(${c.hue},75%,72%,${op.toFixed(3)}) 0%, hsla(${c.hue},75%,68%,${(op * 0.55).toFixed(3)}) 55%, transparent 72%)`,
              filter: `blur(${c.blur}px)`,
              mixBlendMode: 'screen',
              transform: `scale(${scale.toFixed(2)})`,
            }}
          />
        );
      })}
    </>
  );
};

// ====== 商业：光线投射 ======
const LightRaysBg: React.FC<{frame: number}> = ({frame}) => {
  const rot = Math.sin(frame * 0.02) * 6;
  // 光束里的浮尘（缓慢上浮 + 闪烁）
  const motes = Array.from({length: 12}, (_, i) => ({
    x: 20 + rand(i * 7.1) * 60,
    size: 1.5 + rand(i * 5.3) * 2.5,
    speed: 0.1 + rand(i * 3.7) * 0.15,
    phase: rand(i * 11.3) * 100,
    twinkle: rand(i * 13.9) * Math.PI * 2,
  }));
  return (
    <>
      {/* 舞台深色底（光束为发光叠加，需深色底衬托） */}
      <AbsoluteFill style={{background: 'linear-gradient(180deg, #0A0E18 0%, #131A2B 68%, #1C2640 100%)'}} />
      {/* 底部光池 */}
      <div
        style={{
          position: 'absolute',
          left: '15%',
          right: '15%',
          bottom: '-12%',
          height: '38%',
          background: 'radial-gradient(ellipse, rgba(255,238,195,0.16), transparent 70%)',
        }}
      />
      {/* 顶部光源辉光（扁平椭圆，照亮光束根部） */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '-24%',
          width: '64%',
          height: '30%',
          transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse, rgba(255,242,205,0.5), transparent 65%)',
          mixBlendMode: 'screen',
        }}
      />
      {/* 扇形光束（150°-250° 向下扇区，轻微摆动） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `conic-gradient(from ${(140 + rot).toFixed(1)}deg at 50% -10%, transparent 0deg, rgba(255,240,200,0.4) 14deg, transparent 26deg, transparent 46deg, rgba(255,240,200,0.3) 58deg, transparent 70deg, transparent 92deg, rgba(255,240,200,0.36) 104deg, transparent 116deg, transparent 360deg)`,
          mixBlendMode: 'screen',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `conic-gradient(from ${(165 + rot * 0.7).toFixed(1)}deg at 50% -10%, transparent 0deg, rgba(255,246,220,0.2) 10deg, transparent 22deg, transparent 40deg, rgba(255,246,220,0.16) 52deg, transparent 64deg, transparent 360deg)`,
          mixBlendMode: 'screen',
        }}
      />
      {/* 浮尘 */}
      {motes.map((m, i) => {
        const y = (((m.phase - frame * m.speed) % 100) + 100) % 100;
        const op = Math.max(0, 0.25 + Math.sin(frame * 0.09 + m.twinkle) * 0.3);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${m.x}%`,
              top: `${y.toFixed(1)}%`,
              width: m.size,
              height: m.size,
              borderRadius: '50%',
              background: 'rgba(255,244,214,0.9)',
              opacity: op.toFixed(2),
            }}
          />
        );
      })}
    </>
  );
};

// ====== 商业：流光渐变 ======
const GradientFlowBg: React.FC<{frame: number}> = ({frame}) => {
  const pos = (frame * 0.4) % 200;
  return (
    <>
      <AbsoluteFill
        style={{
          background: 'linear-gradient(120deg, #1e3a8a, #7c3aed, #db2777, #f59e0b, #1e3a8a)',
          backgroundSize: '200% 200%',
          backgroundPosition: `${pos}% ${(pos * 0.5).toFixed(1)}%`,
        }}
      />
      <AbsoluteFill style={{background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.35))'}} />
    </>
  );
};

// ====== 商业：粒子上升 ======
const ParticlesBg: React.FC<{frame: number}> = ({frame}) => {
  const particles = Array.from({length: 42}, (_, i) => ({
    x: rand(i * 7) * 100,
    size: 1.5 + rand(i * 5) * 3.5,
    speed: 0.12 + rand(i * 3) * 0.26,
    phase: rand(i * 11) * 100,
    twinkle: rand(i * 13) * Math.PI * 2,
    warm: rand(i * 17) > 0.4, // 暖金/冷白混合
  }));
  return (
    <>
      {/* 深夜底色（粒子为发光叠加，需深色底衬托） */}
      <AbsoluteFill style={{background: 'linear-gradient(180deg, #0C1120 0%, #151D33 100%)'}} />
      {particles.map((p, i) => {
        const y = (((p.phase - frame * p.speed) % 100) + 100) % 100;
        const op = Math.max(0.08, 0.4 + Math.sin(frame * 0.1 + p.twinkle) * 0.4);
        const glow = p.warm ? 'rgba(255,228,170,0.5)' : 'rgba(200,220,255,0.5)';
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${p.x}%`,
              top: `${y}%`,
              width: p.size,
              height: p.size,
              borderRadius: '50%',
              background: p.warm ? 'rgba(255,240,208,0.95)' : 'rgba(228,238,255,0.95)',
              boxShadow: `0 0 ${(p.size * 2.4).toFixed(1)}px ${(p.size * 0.6).toFixed(1)}px ${glow}`,
              opacity: op.toFixed(2),
            }}
          />
        );
      })}
    </>
  );
};

const renderBackgroundEffect = (effect: BackgroundEffect, frame: number): React.ReactNode => {
  switch (effect) {
    case 'inkDrip':
      return <InkDripBg frame={frame} />;
    case 'inkSplash':
      return <InkSplashBg frame={frame} />;
    case 'inkWash':
      return <InkWashBg frame={frame} />;
    case 'mistDrift':
      return <MistDriftBg frame={frame} />;
    case 'bokeh':
      return <BokehBg frame={frame} />;
    case 'lightRays':
      return <LightRaysBg frame={frame} />;
    case 'gradientFlow':
      return <GradientFlowBg frame={frame} />;
    case 'particles':
      return <ParticlesBg frame={frame} />;
    default:
      return null;
  }
};

/**
 * 背景特效层。各模板在背景块之后渲染本组件（位于背景之上、视频/文字之下）。
 * 无特效时返回 null。内部用 useCurrentFrame 驱动动画。
 */
export const BackgroundEffectLayer: React.FC = () => {
  const effect = useBackgroundEffect();
  const frame = useCurrentFrame();
  if (!effect || effect === 'none') return null;
  return (
    <AbsoluteFill style={{pointerEvents: 'none', overflow: 'hidden'}}>
      {renderBackgroundEffect(effect, frame)}
    </AbsoluteFill>
  );
};
