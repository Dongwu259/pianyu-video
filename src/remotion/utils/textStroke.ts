/**
 * 文字描边工具 - TextStyle.strokeColor/strokeWidth → CSS
 */

import type {TextStyle} from '../../shared/types';

/** 文字描边 CSS：strokeWidth>0 且有 strokeColor 时生效（-webkit-text-stroke，可继承，AnimatedText 逐字分支同样生效） */
export const textStrokeCss = (ts?: TextStyle): React.CSSProperties => {
  if (!ts?.strokeColor || !ts.strokeWidth || ts.strokeWidth <= 0) return {};
  return {WebkitTextStroke: `${ts.strokeWidth}px ${ts.strokeColor}`};
};
