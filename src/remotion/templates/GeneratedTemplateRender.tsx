/**
 * GeneratedTemplateRender - AI 生成模板（三期 D2）渲染器
 *
 * 与 CustomTemplateRender 平级：CustomTemplateRender 解释 .vttemplate 纯数据，
 * 本组件执行 LLM 生成的受限 TSX 编译产物（实例化见 generated/instantiate.ts）。
 * 双保险：实例化失败 → 回退占位；组件体内抛错 → 错误边界回退占位。
 * 占位组件保证整片渲染不炸（该段显示提示画面而不是让渲染超时失败）。
 */

import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {GeneratedTemplateDef} from '../../shared/generated-template';
import type {
  Orientation,
  PromoStyle,
  PromoText,
  TemplateLayout,
  VideoClip,
} from '../../shared/types';
import {VIDEO_DESIGN} from '../config/designTokens';
import {instantiateGenerated} from '../generated/instantiate';

export interface GeneratedTemplateRenderProps {
  def: GeneratedTemplateDef;
  videos: VideoClip[];
  text: PromoText;
  orientation: Orientation;
  segmentDuration?: number;
  style?: PromoStyle;
  layout?: TemplateLayout;
  params?: Record<string, number>;
}

/** 失败兜底画面：标明模板名，引导回 AI 助手重新生成 */
const GeneratedFallback: React.FC<{name: string}> = ({name}) => (
  <AbsoluteFill
    style={{background: '#111827', justifyContent: 'center', alignItems: 'center'}}
  >
    <div
      style={{
        color: '#9ca3af',
        fontSize: VIDEO_DESIGN.fontSize.body,
        fontFamily: VIDEO_DESIGN.bodyFont,
        textAlign: 'center',
        padding: '0 80px',
      }}
    >
      <div
        style={{
          fontSize: VIDEO_DESIGN.fontSize.subtitle,
          color: '#e5e7eb',
          fontWeight: 600,
          marginBottom: 16,
        }}
      >
        🤖 {name}
      </div>
      AI 生成模板渲染失败，请在 AI 助手中重新生成或更换模板
    </div>
  </AbsoluteFill>
);

/** 生成组件专用错误边界：一个坏模板不炸整片渲染 */
class GeneratedErrorBoundary extends React.Component<
  {name: string; children: React.ReactNode},
  {failed: boolean}
> {
  state = {failed: false};

  static getDerivedStateFromError(): {failed: boolean} {
    return {failed: true};
  }

  componentDidCatch(err: unknown): void {
    console.warn(`[gen-template] 渲染出错（${this.props.name}）:`, err);
  }

  render(): React.ReactNode {
    return this.state.failed ? <GeneratedFallback name={this.props.name} /> : this.props.children;
  }
}

export const GeneratedTemplateRender: React.FC<GeneratedTemplateRenderProps> = ({
  def,
  videos,
  text,
  orientation,
  segmentDuration,
  style,
  layout,
  params,
}) => {
  const Comp = React.useMemo(() => instantiateGenerated(def.compiled), [def.compiled]);
  if (!Comp) return <GeneratedFallback name={def.name} />;
  return (
    <GeneratedErrorBoundary name={def.name}>
      <Comp
        videos={videos}
        text={text}
        orientation={orientation}
        segmentDuration={segmentDuration ?? def.duration}
        style={style}
        layout={layout}
        params={params ?? {}}
      />
    </GeneratedErrorBoundary>
  );
};

export default GeneratedTemplateRender;
