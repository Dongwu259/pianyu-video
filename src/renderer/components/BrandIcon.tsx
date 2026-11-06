/**
 * 片语品牌图标(分段播放):紫色渐变方底 + 白色三段播放三角 + AI 星点。
 * 与 resources/icons/icon.svg 同源;用于界面内嵌展示(左上角 logo、关于弹窗)。
 * 任意尺寸清晰,无需走资源管道。
 */
import React, {useId} from 'react';

interface BrandIconProps {
  /** 图标边长(px) */
  size?: number;
  className?: string;
}

export const BrandIcon: React.FC<BrandIconProps> = ({size = 24, className}) => {
  // useId 保证多实例同时渲染(如关于弹窗打开时左上角 logo 也在)渐变 id 不冲突;
  // useId 返回值含冒号,在 url(#…) 引用里不安全,去掉。
  const uid = useId().replace(/:/g, '');
  const bg = `bi-bg-${uid}`;
  const glow = `bi-glow-${uid}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      role="img"
      aria-label="片语"
    >
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#A855F7" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
        <radialGradient id={glow} cx="0.3" cy="0.22" r="0.8">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.22" />
          <stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0.05" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" rx="228" ry="228" fill={`url(#${bg})`} />
      <rect width="1024" height="1024" rx="228" ry="228" fill={`url(#${glow})`} />
      <g fill="#FFFFFF">
        <polygon points="380,300 602.3,424 380,424" />
        <polygon points="380,450 648.9,450 760,512 648.9,574 380,574" />
        <polygon points="380,600 602.3,600 380,724" />
        <polygon
          points="790,378 801.1,418.9 842,430 801.1,441.1 790,482 778.9,441.1 738,430 778.9,418.9"
          fillOpacity="0.92"
        />
        <polygon
          points="720,296 725.1,314.9 744,320 725.1,325.1 720,344 714.9,325.1 696,320 714.9,314.9"
          fillOpacity="0.8"
        />
      </g>
    </svg>
  );
};

export default BrandIcon;
