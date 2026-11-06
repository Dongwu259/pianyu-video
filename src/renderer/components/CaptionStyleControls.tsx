/**
 * CaptionStyleControls - 字幕样式控件（项目级）
 *
 * 位置/字号/底色/字色。同时用在「品牌」面板与「字幕」Tab——
 * 用户的第一直觉是在字幕 Tab 找样式设置，两处保持同一控件避免重复实现。
 */

import React from 'react';
import {useProjectStore} from '../store/projectStore';
import {CAPTION_POSITION_OPTIONS} from '../../shared/types';
import type {CaptionAnim, CaptionPosition} from '../../shared/types';

const CAPTION_ANIM_OPTIONS: {value: CaptionAnim; label: string}[] = [
  {value: 'line', label: '整行淡入'},
  {value: 'wordPop', label: '逐词弹出'},
];

export const CaptionStyleControls: React.FC = () => {
  const {captionStyle, setCaptionStyle} = useProjectStore();
  return (
    <div className="brand-ctrls">
      <label className="brand-ctrl">
        位置
        <select
          value={captionStyle.position}
          onChange={(e) => setCaptionStyle({position: e.target.value as CaptionPosition})}
        >
          {CAPTION_POSITION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="brand-ctrl">
        动效
        <select
          value={captionStyle.anim ?? 'line'}
          onChange={(e) => setCaptionStyle({anim: e.target.value as CaptionAnim})}
        >
          {CAPTION_ANIM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="brand-ctrl">
        字号 {(captionStyle.fontSizeScale * 100).toFixed(0)}%
        <input
          type="range" min={0.5} max={2.5} step={0.1} value={captionStyle.fontSizeScale}
          onChange={(e) => setCaptionStyle({fontSizeScale: Number(e.target.value)})}
        />
      </label>
      <label className="brand-ctrl">
        底色 {Math.round(captionStyle.bgOpacity * 100)}%
        <input
          type="range" min={0} max={1} step={0.05} value={captionStyle.bgOpacity}
          onChange={(e) => setCaptionStyle({bgOpacity: Number(e.target.value)})}
        />
      </label>
      <label className="brand-ctrl">
        字色
        <input
          type="color" value={captionStyle.color}
          onChange={(e) => setCaptionStyle({color: e.target.value})}
        />
      </label>
    </div>
  );
};

export default CaptionStyleControls;
