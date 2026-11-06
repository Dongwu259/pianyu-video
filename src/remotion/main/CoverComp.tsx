/**
 * 封面合成：全片画面（指定帧）+ 封面覆盖层。
 *
 * 与 MultiSegment-<比例> 共用同一套 bundle 与素材预处理：
 * 导出 = 对本合成做一次 renderStill（frame = timeSec × 30），
 * 预览 = 封面设计面板用 Remotion Player 暂停在本帧。
 */

import React from 'react';
import {AbsoluteFill, useVideoConfig} from 'remotion';
import {MultiSegmentPromo} from './MultiSegmentPromo';
import {CoverOverlay} from '../layers/CoverOverlay';
import type {MultiSegmentProps, CoverConfig} from '../../shared/types';

export interface CoverCompProps {
  /** 全片 props（与 MultiSegment-<比例> 合成完全同口径） */
  project: MultiSegmentProps;
  cover: CoverConfig;
  /** 主体遮挡 mask（PNG data URL，主体区域透明）；behind 图层据此渲染到主体后面 */
  subjectMask?: string;
}

export const CoverComp: React.FC<CoverCompProps> = ({project, cover, subjectMask}) => {
  const {width, height} = useVideoConfig();
  return (
    <AbsoluteFill style={{backgroundColor: '#000'}}>
      <MultiSegmentPromo {...project} />
      <CoverOverlay canvasW={width} canvasH={height} cover={cover} subjectMask={subjectMask} />
    </AbsoluteFill>
  );
};
