/**
 * 模板: TutorialStep - 教程步骤卡（1.6「操作视频」M2）
 *
 * 教程编排（auto_tutorial）的步骤间奏卡：超大步骤号 + 步骤标题 + 进度点。
 * 语言取第二轮参照研究的「元素级微节奏」——数字从画面里砸入，标题随行浮现，
 * 底部进度点一眼看到全片进度。无需素材（auto_tutorial 自动产，也可手动用）。
 */

import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {AnimatedText} from '../layers/AnimatedText';
import {Background} from '../layers/Background';
import {TemplateProps} from '../../shared/types';
import {FPS} from '../config/resolutions';
import {VIDEO_DESIGN, getScaledTokens} from '../config/designTokens';
import {makeParamReader} from '../utils/params';
import {textStrokeCss} from '../utils/textStroke';
import {SPRINGS} from '../animations/motion';
import {TUTORIAL_STEP_PARAMS} from '../../shared/template-registry';

export const TutorialStep: React.FC<TemplateProps> = ({
  text,
  segmentDuration,
  style,
  params,
  textAnim,
}) => {
  const frame = useCurrentFrame();
  const {width: canvasW, height: canvasH} = useVideoConfig();
  const tokens = getScaledTokens(canvasW, canvasH);
  const p = makeParamReader(TUTORIAL_STEP_PARAMS, params);
  const stepIndex = Math.max(0, Math.round(p('stepIndex')));
  const stepTotal = Math.max(0, Math.round(p('stepTotal')));
  const accent = style?.title?.color ?? VIDEO_DESIGN.colors.accent ?? '#7c9cff';

  // 步骤号从文本 title 里解析（「第 3 步」→ 3）；解析不出用参数
  const parsed = /第\s*(\d+)\s*步/.exec(text.title || '');
  const stepNo = parsed ? Number(parsed[1]) : stepIndex;

  const enter = spring({frame, fps: FPS, config: SPRINGS.stampSettle, durationInFrames: 22});
  const titleIn = interpolate(frame, [10, 26], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  // 不做整段自淡出：段尾自淡出会把 crossfade 的「出段垫底帧」变成黑帧（边界黑缝），
  // 交接交给段间过场（入段自带覆盖），硬切则瞬时替换。

  const numSize = canvasH * 0.34;
  const dots = stepTotal > 0 ? Math.min(stepTotal, 12) : 0;

  return (
    <AbsoluteFill>
      <Background variant="gradient-dark" />
      {/* 背景巨型步骤号（水印层，低透明度） */}
      <div
        style={{
          position: 'absolute',
          right: canvasW * 0.04,
          bottom: -canvasH * 0.06,
          fontSize: canvasH * 0.62,
          fontWeight: 900,
          color: 'rgba(255, 255, 255, 0.045)',
          fontFamily: VIDEO_DESIGN.titleFont,
          letterSpacing: '-0.04em',
          lineHeight: 1,
        }}
      >
        {String(stepNo).padStart(2, '0')}
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* 主步骤号：砸入 + 描边辉光 */}
        <div
          style={{
            transform: `scale(${0.6 + 0.4 * enter}) rotateZ(${(1 - enter) * -4}deg)`,
            fontSize: numSize,
            fontWeight: 900,
            lineHeight: 1,
            color: accent,
            fontFamily: VIDEO_DESIGN.titleFont,
            letterSpacing: '-0.03em',
            textShadow: `0 0 60px ${accent}55, 0 18px 50px rgba(0, 0, 0, 0.5)`,
          }}
        >
          {String(stepNo).padStart(2, '0')}
        </div>

        {text.title && (
          <div style={{marginTop: canvasH * 0.03, opacity: titleIn}}>
            <AnimatedText
              text={text.title}
              preset={textAnim ?? 'charPop'}
              startFrame={10}
              style={{
                fontSize: tokens.fontSize.title * 1.15,
                fontWeight: 800,
                color: VIDEO_DESIGN.colors.textTitleDark,
                ...(textStrokeCss(style?.title) ?? {}),
              }}
            />
          </div>
        )}
        {text.subtitle && (
          <div style={{marginTop: canvasH * 0.015, opacity: titleIn}}>
            <AnimatedText
              text={text.subtitle}
              preset="fadeIn"
              startFrame={20}
              style={{
                fontSize: tokens.fontSize.title * 0.8,
                fontWeight: 600,
                color: VIDEO_DESIGN.colors.textBodyDark,
                ...textStrokeCss(style?.subtitle),
              }}
            />
          </div>
        )}

        {/* 进度点：当前步高亮 */}
        {dots > 0 && (
          <div style={{display: 'flex', gap: canvasW * 0.012, marginTop: canvasH * 0.05}}>
            {Array.from({length: dots}, (_, i) => (
              <div
                key={i}
                style={{
                  width: canvasW * 0.009,
                  height: canvasW * 0.009,
                  borderRadius: '50%',
                  background: i + 1 === stepNo ? accent : 'rgba(255, 255, 255, 0.22)',
                  boxShadow: i + 1 === stepNo ? `0 0 12px ${accent}99` : 'none',
                  transform: `scale(${i + 1 === stepNo ? 1.35 : 1})`,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

export default TutorialStep;
