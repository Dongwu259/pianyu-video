/**
 * LogoLayer - 用户品牌 Logo 层（项目级，顶层常驻）
 *
 * 经本地 HTTP 服务器加载图片（与视频/音频同源，videoServer 已支持 png/jpg），
 * 按 position/size/opacity 渲染。size = 占画布宽度的比例；图片等比缩放。
 * 叠加在画面四角之一，位于水印（免费版）之下。
 */

import {AbsoluteFill, Img, useVideoConfig} from 'remotion';
import type {LogoConfig} from '../../shared/types';

interface LogoLayerProps {
  logo: LogoConfig;
}

export const LogoLayer: React.FC<LogoLayerProps> = ({logo}) => {
  const {width} = useVideoConfig();
  if (!logo.src || !logo.visible) return null;

  const logoWidth = Math.round(width * logo.size);
  const margin = Math.round(width * 0.03);
  const pos: React.CSSProperties =
    logo.position === 'topLeft'
      ? {top: margin, left: margin}
      : logo.position === 'topRight'
        ? {top: margin, right: margin}
        : logo.position === 'bottomLeft'
          ? {bottom: margin, left: margin}
          : {bottom: margin, right: margin};

  return (
    <AbsoluteFill style={{pointerEvents: 'none', zIndex: 800}}>
      <Img
        src={logo.src}
        style={{
          position: 'absolute',
          width: logoWidth,
          height: 'auto',
          opacity: logo.opacity,
          ...pos,
        }}
      />
    </AbsoluteFill>
  );
};

export default LogoLayer;
