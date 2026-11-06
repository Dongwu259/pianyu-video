/**
 * StatusBar - 应用底部状态栏
 *
 * 左侧状态文字（优先级：渲染中 > 瞬时状态（加载中/已自动保存…）> 就绪），
 * 右侧当前工程名 + 未保存标记。替代原先顶栏的「已自动保存」提示（空间不足被截断）。
 */

import React from 'react';
import {Loader2, CircleCheck, CircleDot} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import {useUIStore} from '../store/uiStore';
import './StatusBar.css';

export const StatusBar: React.FC = () => {
  const isRendering = useProjectStore((s) => s.isRendering);
  const renderProgress = useProjectStore((s) => s.renderProgress);
  const isDirty = useProjectStore((s) => s.isDirty);
  const projectName = useProjectStore((s) => s.projectName);
  const statusText = useUIStore((s) => s.statusText);

  const busy = isRendering;
  const text = busy
    ? `渲染中… ${Math.round(renderProgress)}%`
    : (statusText ?? '就绪');

  return (
    <footer className="app-statusbar">
      <span className={`statusbar-state ${busy ? 'busy' : ''}`}>
        {busy ? <Loader2 size={12} className="statusbar-spin" /> : <CircleCheck size={12} />}
        {text}
      </span>
      <span className="statusbar-right">
        {isDirty && (
          <span className="statusbar-dirty" title="有未保存的更改">
            <CircleDot size={11} /> 未保存
          </span>
        )}
        <span className="statusbar-project">{projectName || '未命名工程'}</span>
      </span>
    </footer>
  );
};

export default StatusBar;
