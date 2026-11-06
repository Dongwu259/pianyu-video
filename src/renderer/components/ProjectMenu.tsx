/**
 * ProjectMenu — 头部「工程」菜单
 *
 * 下拉项：新建 / 打开… / 保存 / 另存为… / 最近工程子列表
 * 按钮旁显示当前工程名 + 未保存 ● 标记。
 */

import React, {useEffect, useRef, useState} from 'react';
import {FilePlus, FolderOpen, Save, FileDown, Clock, ChevronDown, FileText, Sparkles} from 'lucide-react';
import {useProjectStore, getRecentProjects} from '../store/projectStore';
import type {RecentProject} from '../store/projectStore';
import './ProjectMenu.css';

export const ProjectMenu: React.FC = () => {
  const projectName = useProjectStore((s) => s.projectName);
  const projectFilePath = useProjectStore((s) => s.projectFilePath);
  const isDirty = useProjectStore((s) => s.isDirty);
  const {newProject, openProject, openProjectPath, openSampleProject, saveProject, saveProjectAs} = useProjectStore();

  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // 打开菜单时刷新最近工程列表
  useEffect(() => {
    if (open) {
      getRecentProjects().then(setRecents);
    }
  }, [open]);

  // 点击菜单外部时收起
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="project-menu" ref={rootRef}>
      <button className="btn-header" onClick={() => setOpen((v) => !v)}>
        <FileText size={14} /> 工程 <ChevronDown size={12} />
      </button>
      <span className="project-name" title={projectFilePath || '尚未保存到文件'}>
        {projectName}
        {isDirty && <span className="project-dirty" title="有未保存的更改">●</span>}
      </span>

      {open && (
        <div className="project-dropdown">
          <button className="dropdown-item" onClick={run(newProject)}>
            <FilePlus size={13} /> 新建
          </button>
          <button className="dropdown-item" onClick={run(openProject)}>
            <FolderOpen size={13} /> 打开… <kbd>Ctrl+O</kbd>
          </button>
          <button className="dropdown-item" onClick={run(openSampleProject)}>
            <Sparkles size={13} /> 打开示例工程
          </button>
          <button className="dropdown-item" onClick={run(saveProject)}>
            <Save size={13} /> 保存 <kbd>Ctrl+S</kbd>
          </button>
          <button className="dropdown-item" onClick={run(saveProjectAs)}>
            <FileDown size={13} /> 另存为… <kbd>Ctrl+Shift+S</kbd>
          </button>

          <div className="dropdown-divider" />
          <div className="dropdown-title">最近工程</div>
          {recents.length === 0 && <div className="dropdown-empty">暂无最近工程</div>}
          {recents.map((r) => (
            <button
              key={r.path}
              className="dropdown-item dropdown-recent"
              title={r.path}
              onClick={run(() => openProjectPath(r.path))}
            >
              <Clock size={13} /> <span className="recent-name">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ProjectMenu;
