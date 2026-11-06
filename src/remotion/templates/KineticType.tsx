/**
 * 模板: KineticType - 节拍大字（说服力场景 / hook 开场）
 *
 * 效果: 市场第二大品类（VideoHive kinetic typography 检索 8000+）。
 * 整屏超大字号逐行「砸入」：弹簧过冲落位 + 快速失焦收实，「」包住的关键词
 * 以品牌色高亮盒呈现；画面同时最多保留 3 行（第 4 行砸入时首行退场），
 * 末行落位后随呼吸微缩放。整体倾斜角可调出海报感。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - features: 逐行大字（每行一个节拍）；为空时把 title 按标点/空格切句
 * - title: features 为空时的唯一文案源（正常用法优先 features）
 * - 「关键词」: 行内高亮（品牌色底 + 白字，引号本身不渲染）
 * - brandName: 左下角品牌小字
 *
 * 卡点用法：有 BGM 节拍时全自动——合成器按段窗口切片下发 beatGrid，每行砸入时刻
 * 对齐段内拍点（一拍一行，每 4 拍下拍行放大加重；行多于拍退化为半拍/均匀分配）；
 * 无 BGM 时走原「行间隔」时间模型（可手动调成鼓点间隔的整数倍压拍）。
 *
 * 个性化参数（paramSpecs: KINETIC_TYPE_PARAMS）：lineInterval 行间隔（秒）/
 * typeScale 字号 / emphasis 末行强调 / tilt 整体倾角（°）。
 */

import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {SPRINGS} from '../animations/motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {parseHighlightSegments} from '../../shared/promo-text-parse';
import {distributeOnBeats} from '../../shared/beat-grid';
import {exitShineProgress} from '../../shared/exit-shine';
import {KINETIC_TYPE_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

/** 强调色相对亮度（0-1）：高亮盒字色自适应——黄系亮 accent 上白字不可读（P3） */
const hexLuma = (hex: string): number => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};
const ACCENT_LUMA = () => hexLuma(ACCENT());


/** features 为空时把 title 切成大字行（标点/空格分隔，过滤空段） */
const splitToLines = (text: string): string[] =>
  (text ?? '')
    .split(/[，。！？；、\n,!?;]+|\s{2,}/u)
    .map((s) => s.trim())
    .filter(Boolean);

/** 同时在场的最大行数（第 N+1 行砸入时首行退场，保持画面不挤） */
const MAX_VISIBLE = 3;

export const KineticType: React.FC<TemplateProps> = ({text, segmentDuration, style, params, beatGrid}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 5) * FPS);

  const p = makeParamReader(KINETIC_TYPE_PARAMS, params);
  const lineIntervalSec = p('lineInterval'); // 行间隔（秒，调到鼓点间隔的整数倍）
  const typeScale = p('typeScale');           // 字号倍率
  const emphasis = p('emphasis');             // 末行强调强度
  const tilt = p('tilt');                     // 整体倾角（°）
  const exitFxOn = p('exitFx') >= 0.5;        // 退场照亮扫光（B4：末窗高光带扫过文字）

  // ====== 行来源：features 优先，缺省切 title ======
  const features = text.features ?? [];
  const lines = (features.length > 0 ? features : splitToLines(text.title)).slice(0, 8);

  // ====== 每行的到达/退场帧 ======
  // beatGrid 存在时逐行踩拍：第 i 行在第 i 拍砸入（一拍一行；行多于拍退化为半拍/均匀
  // 分配，末行不出段尾），每 4 拍下拍行加重。缺省走原「行间隔」时间模型（零回归）。
  const beatDist = beatGrid ? distributeOnBeats(lines.length, beatGrid.beatsSec, segmentDuration || 5, FPS) : null;
  const intervalF = Math.max(6, lineIntervalSec * FPS);
  const arriveAt = (i: number) => (beatDist ? (beatDist.frames[i] ?? Infinity) : 4 + i * intervalF);
  // 第 i 行在第 (i + MAX_VISIBLE) 行到达时退场（末尾 3 行保持到片段结束）
  const exitAt = (i: number) => arriveAt(i + MAX_VISIBLE);
  const lastIdx = lines.length - 1;

  // ====== 版式 ======
  const padX = canvasW * 0.08;
  const baseSize = canvasW * (isPortrait ? 0.088 : 0.06) * typeScale;
  // 长行自适应缩字号：按可用宽度 / 全角字宽估算，最长 16 字封顶不缩成蚊字
  const sizeFor = (line: string): number => {
    const maxChars = Math.max(4, Math.floor((canvasW - padX * 2) / baseSize));
    return line.length > maxChars ? Math.max(baseSize * 0.5, baseSize * (maxChars / line.length)) : baseSize;
  };

  // 退场照亮扫光（B4）：末窗 0.9s 内高光带扫过全部在场行；进度 0/1（带未入画/已扫出）不渲染层。
  // 亮度抬升与扫光带同窗（照亮感=带过+整体微亮），字段只加不改——扫光层是纯叠加。
  // 扫光带颜色按字色亮度自适应：深字=白带（照亮）、浅字=glow 蓝带（白带扫白字不可见，v4 实锤）
  const shineQ = exitFxOn ? exitShineProgress(frame, totalDurationFrames, FPS) : 0;
  const shineLift = shineQ > 0 && shineQ < 1 ? Math.sin(Math.PI * shineQ) : 0;
  const inkColor = style?.feature?.color ?? style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark;
  const shineBand = hexLuma(typeof inkColor === 'string' ? inkColor : '') > 0.62
    ? 'linear-gradient(105deg, rgba(124,156,255,0) 38%, rgba(124,156,255,0.95) 50%, rgba(124,156,255,0) 62%)'
    : 'linear-gradient(105deg, rgba(255,255,255,0) 38%, rgba(255,255,255,0.95) 50%, rgba(255,255,255,0) 62%)';

  return (
    <AbsoluteFill>
      {/* 背景层：近黑深底（大字冲击力最佳载体；可被 style.background 覆盖） */}
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 大字栈：整体倾斜（tilt ≠ 0 时海报感） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: baseSize * 0.28,
          padding: `0 ${padX}px`,
          transform: tilt !== 0 ? `rotate(${tilt}deg)` : undefined,
        }}
      >
        {lines.map((line, i) => {
          const arrive = arriveAt(i);
          if (frame < arrive) return null; // 未到节拍不渲染

          // 入场：强过冲弹簧砸入 + 快速失焦收实（模糊只在入场窗内算，常态零 filter 保渲染性能）
          const slam = spring({frame: frame - arrive, fps: FPS, config: SPRINGS.cardSettle});
          const focus = interpolate(frame, [arrive, arrive + 7], [10, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const isLast = i === lastIdx;
          // 末行落位后的呼吸微缩放（emphasis 0 = 关）
          const breathe = isLast && emphasis > 0 ? 1 + Math.sin((frame - arrive) * 0.09) * 0.015 * emphasis : 1;

          // 退场：更早到达的行被挤出窗口时上浮让位（退场比入场快，accel 手感）
          const exitStart = exitAt(i);
          const exitProg =
            !isLast && i < lastIdx - (MAX_VISIBLE - 1) && frame >= exitStart
              ? interpolate(frame, [exitStart, exitStart + 7], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                })
              : 0;
          if (exitProg >= 1) return null;

          const size = sizeFor(line);
          // 重拍行（每 4 拍下拍）放大加重——砸入量 +0.3，落拍体感更强
          const accentBeat = beatDist?.accented[i] ?? false;
          const startScale = 1.45 + (accentBeat ? 0.3 : 0) + (isLast ? 0.15 * emphasis : 0);
          const segs = parseHighlightSegments(line);

          // 砸入拖影：弹簧收敛前在主文字后面垫两层「更早时刻」的放大残影，
          // 模拟缩放砸入的运动模糊（纯文本层开销极小；Trail 需要子组件内部驱动动画，
          // 本模板动效在父作用域计算，ghost 层是等价的轻量做法）
          const ghost = Math.max(0, 1 - slam * 1.7);

          return (
            <div
              key={i}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexWrap: 'wrap',
                rowGap: size * 0.2,
                opacity: Math.min(slam, 1 - exitProg),
                transform: `scale(${(startScale - (startScale - 1) * slam) * breathe}) translateY(${-exitProg * size * 0.7}px)`,
                filter:
                  focus > 0.05 || shineLift > 0
                    ? `${focus > 0.05 ? `blur(${focus.toFixed(2)}px) ` : ''}${
                        shineLift > 0 ? `brightness(${(1 + 0.32 * shineLift).toFixed(3)})` : ''
                      }`.trim()
                    : undefined,
              }}
            >
              {ghost > 0.02 &&
                ([0.72, 0.42] as const).map((k, gi) => (
                  <div
                    key={`ghost-${gi}`}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      zIndex: -1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexWrap: 'wrap',
                      rowGap: size * 0.2,
                      transform: `scale(${1 + (startScale - 1) * k})`,
                      opacity: ghost * (gi === 0 ? 0.32 : 0.18),
                      pointerEvents: 'none',
                    }}
                  >
                    {segs.map((seg, j) => (
                      <span
                        key={j}
                        style={{
                          fontSize: size,
                          fontWeight: 800,
                          color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
                          fontFamily: VIDEO_DESIGN.titleFont,
                          lineHeight: 1.22,
                          margin: `0 ${size * 0.02}px`,
                        }}
                      >
                        {seg.text}
                      </span>
                    ))}
                  </div>
                ))}
              {segs.map((seg, j) =>
                seg.highlight ? (
                  <span
                    key={j}
                    style={{
                      fontSize: size,
                      fontWeight: 800,
                      color: ACCENT_LUMA() > 0.62 ? '#17181C' : '#FFFFFF',
                      fontFamily: VIDEO_DESIGN.titleFont,
                      lineHeight: 1.22,
                      background: ACCENT(),
                      borderRadius: size * 0.14,
                      padding: `${size * 0.04}px ${size * 0.16}px`,
                      margin: `0 ${size * 0.03}px`,
                      boxDecorationBreak: 'clone',
                      WebkitBoxDecorationBreak: 'clone',
                    }}
                  >
                    {seg.text}
                  </span>
                ) : (
                  <span
                    key={j}
                    style={{
                      fontSize: size,
                      fontWeight: 800,
                      color: style?.title?.color ?? VIDEO_DESIGN.colors.textTitleDark,
                      fontFamily: VIDEO_DESIGN.titleFont,
                      lineHeight: 1.22,
                      letterSpacing: '-0.01em',
                      margin: `0 ${size * 0.02}px`,
                    }}
                  >
                    {seg.text}
                  </span>
                ),
              )}
              {/* 退场照亮扫光（B4）：与正文同排版的文字副本，background-clip:text 高光带
                  左→右扫过（高亮盒行不做副本——盒内文字的照亮由底层的 brightness 抬升承担） */}
              {shineQ > 0 && shineQ < 1 && (
                <div
                  aria-hidden
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexWrap: 'wrap',
                    rowGap: size * 0.2,
                    pointerEvents: 'none',
                  }}
                >
                  {segs
                    .filter((seg) => !seg.highlight)
                    .map((seg, j) => (
                      <span
                        key={j}
                        style={{
                          fontSize: size,
                          fontWeight: 800,
                          fontFamily: VIDEO_DESIGN.titleFont,
                          lineHeight: 1.22,
                          letterSpacing: '-0.01em',
                          margin: `0 ${size * 0.02}px`,
                          background: shineBand,
                          backgroundSize: '260% 100%',
                          backgroundPosition: `${(-130 + 360 * shineQ).toFixed(1)}% 0`,
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                          color: 'transparent',
                        }}
                      >
                        {seg.text}
                      </span>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 品牌名：左下角小字（深底反白） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: padX,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.06),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: fadeIn(frame, 10, 14),
          }}
        >
          <div
            style={{
              width: Math.max(8, Math.round(tokens.fontSize.caption * 0.45)),
              height: Math.max(8, Math.round(tokens.fontSize.caption * 0.45)),
              borderRadius: '50%',
              background: ACCENT(),
            }}
          />
          <span
            style={{
              fontSize: style?.brand?.fontSize ?? tokens.fontSize.caption,
              fontWeight: style?.brand?.fontWeight ?? 500,
              color: style?.brand?.color ?? VIDEO_DESIGN.colors.textBodyDark,
              fontFamily: VIDEO_DESIGN.bodyFont,
              letterSpacing: '0.14em',
            }}
          >
            {text.brandName}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};

export default KineticType;
