/**
 * 模板: CodeTerminal - 代码/终端滚动（进阶装置）
 *
 * 效果: 开发者工具向（Stripe 式「代码即主角」）——深色终端卡 + 红黄绿窗口点，
 * 代码行打字机逐行出现（轻量语法高亮：注释/字符串/关键字/数字分色），
 * 超出可视行数自动上滚，光标块闪烁停在当前行尾。
 *
 * 文案编码（复用 PromoText，零 schema 变更）：
 * - features: 代码行（每行一条，≤14 行；空行保留）
 * - title: 终端标题栏文件名（如「deploy.sh」；缺省「terminal」）
 * - brandName: 左下角品牌小字
 *
 * 个性化参数（paramSpecs: CODE_TERMINAL_PARAMS）：typeSpeed 打字速度 /
 * codeScale 字号 / lineDelay 行间隔（秒）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background} from '../layers/Background';
import {BackgroundEffectLayer} from '../layers/backgroundEffects';
import {fadeIn} from '../animations/keyframes';
import {dwellBreathe, dwellDrift} from '../../shared/dwell-motion';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {safeBottom} from '../utils/safeArea';
import {CODE_TERMINAL_PARAMS} from '../../shared/template-registry';

// 品牌强调色随项目主题（getter）：模块顶层取值会冻结成加载时的颜色，必须渲染期取
const ACCENT = () => VIDEO_DESIGN.colors.accent;

/** 轻量语法着色（按行 token 化；不追求语言精确，追求观感成立） */
const SYNTAX_COLORS = {
  plain: '#D8E1EA',
  comment: '#7D8CA0',
  string: '#9ECE8C',
  keyword: '#7AA2F7',
  number: '#E8B36A',
} as const;

const SYNTAX_RE =
  /(\/\/[^\n]*|#[^\n]*)|('[^']*'|"[^"]*"|`[^`]*`)|\b(const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|await|async|def|lambda|try|catch|throw|yield|type|interface|enum|struct|fn|pub|use|mod|package|end|do|then|elif|not|and|or|in|of)\b|(\b\d+(?:\.\d+)?\b)/g;

const syntaxSpans = (line: string): Array<{text: string; color: string}> => {
  const out: Array<{text: string; color: string}> = [];
  let last = 0;
  for (const m of line.matchAll(SYNTAX_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({text: line.slice(last, idx), color: SYNTAX_COLORS.plain});
    const color = m[1] ? SYNTAX_COLORS.comment : m[2] ? SYNTAX_COLORS.string : m[3] ? SYNTAX_COLORS.keyword : SYNTAX_COLORS.number;
    out.push({text: m[0], color});
    last = idx + m[0].length;
  }
  if (last < line.length) out.push({text: line.slice(last), color: SYNTAX_COLORS.plain});
  return out;
};

export const CodeTerminal: React.FC<TemplateProps> = ({text, segmentDuration, style, params}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const isPortrait = canvasH > canvasW;
  const tokens = getScaledTokens(canvasW, canvasH);
  const totalDurationFrames = Math.round((segmentDuration || 6) * FPS);
  const pace = Math.max(totalDurationFrames / (6 * FPS), 0.5);

  const p = makeParamReader(CODE_TERMINAL_PARAMS, params);
  const typeSpeed = p('typeSpeed'); // 打字速度倍率（字符/帧）
  const codeScale = p('codeScale');  // 字号倍率
  const lineDelaySec = p('lineDelay'); // 行间隔（秒）

  const lines = (text.features ?? []).slice(0, 14);
  const lineStart = (i: number) => 8 * pace + i * Math.max(4, lineDelaySec * FPS);

  // ====== 版式：终端卡居中 ======
  const u = canvasW / 1920;
  const cardW = canvasW * (isPortrait ? 0.88 : 0.62);
  const cardH = canvasH * (isPortrait ? 0.5 : 0.62);
  const fs = (isPortrait ? canvasW * 0.026 : canvasW * 0.0145) * codeScale;
  const lineH = fs * 1.65;
  const headerH = fs * 2.6;
  const padX = fs * 1.1;
  const maxVisible = Math.floor((cardH - headerH - fs) / lineH);

  // 当前打字进度：最后一行是「当前行」；已完成行整行显示
  const typingLine = Math.min(
    lines.length - 1,
    Math.floor((frame - 8 * pace) / Math.max(4, lineDelaySec * FPS)),
  );
  const visibleCount = Math.min(lines.length, typingLine + 1);
  // 超出可视区：整体上滚（把最新行留在可视区内）
  const scrollLines = Math.max(0, visibleCount - maxVisible);
  const scrollY = scrollLines * lineH;

  // 光标：当前行尾闪烁（606ms 周期）
  const cursorOn = Math.floor(frame / 9) % 2 === 0;

  // 驻留微运动：入场完成后终端卡保持缓慢呼吸+漂移（P2 质感）
  const breathe = dwellBreathe(frame, FPS, 0.012, 4.5, 0);
  const drift = dwellDrift(frame, FPS, 4 * u, 3 * u, 9, 0);

  return (
    <AbsoluteFill>
      {style?.background ? (
        <AbsoluteFill style={{background: style.background}} />
      ) : (
        <Background variant="gradient-dark" />
      )}
      <BackgroundEffectLayer />

      {/* 终端卡 */}
      <div
        style={{
          position: 'absolute',
          left: (canvasW - cardW) / 2,
          top: canvasH * (isPortrait ? 0.2 : 0.16),
          width: cardW,
          height: cardH,
          background: 'rgba(13, 17, 23, 0.96)',
          borderRadius: Math.max(10, 14 * u),
          border: '1px solid rgba(122, 162, 247, 0.18)',
          boxShadow: `0 ${40 * u}px ${80 * u}px -${20 * u}px rgba(0,0,0,0.6), 0 0 ${36 * u}px rgba(37, 99, 235, 0.12)`,
          overflow: 'hidden',
          opacity: fadeIn(frame, 0, 10),
          transform: `translate(${drift.x}px, ${drift.y}px) scale(${breathe})`,
        }}
      >
        {/* 标题栏：红黄绿点 + 文件名 */}
        <div
          style={{
            height: headerH,
            display: 'flex',
            alignItems: 'center',
            gap: fs * 0.45,
            padding: `0 ${padX}px`,
            background: 'rgba(255, 255, 255, 0.04)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div style={{width: fs * 0.55, height: fs * 0.55, borderRadius: '50%', background: '#FF5F57'}} />
          <div style={{width: fs * 0.55, height: fs * 0.55, borderRadius: '50%', background: '#FEBC2E'}} />
          <div style={{width: fs * 0.55, height: fs * 0.55, borderRadius: '50%', background: '#28C840'}} />
          <span
            style={{
              marginLeft: fs * 0.6,
              fontSize: fs * 0.85,
              color: 'rgba(216, 225, 234, 0.65)',
              fontFamily: VIDEO_DESIGN.monoFont,
              lineHeight: 1,
            }}
          >
            {text.title || 'terminal'}
          </span>
        </div>

        {/* 代码区：打字机 + 自动上滚 */}
        <div style={{position: 'absolute', left: padX, right: padX, top: headerH + fs * 0.5, bottom: fs * 0.5, overflow: 'hidden'}}>
          <div style={{transform: `translateY(${-scrollY}px)`}}>
            {lines.map((line, i) => {
              if (i > typingLine) return null;
              const start = lineStart(i);
              const isCurrent = i === typingLine;
              // 当前行按帧切片打字；已完成行整行
              const chars = isCurrent
                ? Math.floor(Math.max(0, frame - start) * 1.6 * typeSpeed)
                : line.length;
              const shown = line.slice(0, Math.min(chars, line.length));
              return (
                <div
                  key={i}
                  style={{
                    height: lineH,
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: fs,
                    fontFamily: VIDEO_DESIGN.monoFont,
                    lineHeight: 1.3,
                    whiteSpace: 'pre',
                    opacity: fadeIn(frame, start, 3),
                  }}
                >
                  {syntaxSpans(shown).map((sp, j) => (
                    <span key={j} style={{color: sp.color}}>
                      {sp.text}
                    </span>
                  ))}
                  {isCurrent && cursorOn && (
                    <span style={{display: 'inline-block', width: fs * 0.55, height: fs * 1.05, background: 'rgba(122, 162, 247, 0.9)', marginLeft: 1}} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 品牌名（深底反白，竖版安全区） */}
      {text.brandName && (
        <div
          style={{
            position: 'absolute',
            left: canvasW * 0.07,
            bottom: safeBottom(canvasW, canvasH, canvasH * 0.06),
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing.tight,
            opacity: fadeIn(frame, 12 * pace, 14 * pace),
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

export default CodeTerminal;
