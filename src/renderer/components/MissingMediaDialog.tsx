/**
 * MissingMediaDialog — 缺失媒体提示与重新链接
 *
 * 打开工程后若 missingMedia 非空则弹出，列出缺失文件；
 * 每项可「重新链接」（片段素材复用 selectVideos 选新文件，背景音乐走 selectAudioFile），
 * 或点击「知道了」整体跳过（缺失素材保留在故事板中，加载失败由预览/渲染环节兜底）。
 */

import React, {useState} from 'react';
import {AlertTriangle, X, Link2} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import type {MissingMediaEntry} from '../store/projectStore';
import {clipSrcToPath} from '../utils/clipPath';
import './MissingMediaDialog.css';

export const MissingMediaDialog: React.FC = () => {
  const missingMedia = useProjectStore((s) => s.missingMedia);
  const {relinkMissingMedia, dismissMissingMedia} = useProjectStore();
  const [busy, setBusy] = useState(false);

  if (missingMedia.length === 0) return null;

  const handleRelink = async (entry: MissingMediaEntry) => {
    setBusy(true);
    try {
      if (entry.segmentIndex === -3) {
        // Logo：走图片选择
        const img = await window.api.selectImageFile();
        if (img) {
          relinkMissingMedia(entry, {src: img.src, path: img.path, name: img.name});
        }
      } else if (entry.segmentIndex === -1 || entry.videoIndex === -2) {
        // 背景音乐或旁白音频：走音频选择；旁白另取时长
        const audio = await window.api.selectAudioFile();
        if (audio) {
          let duration: number | undefined;
          if (entry.videoIndex === -2) {
            try {
              duration = (await window.api.analyzeAudio(audio.path)).duration;
            } catch {
              duration = undefined;
            }
          }
          relinkMissingMedia(entry, {src: audio.src, path: audio.path, name: audio.name, duration});
        }
      } else {
        // 片段素材：复用视频选择，取第一个选中文件
        const selected = await window.api.selectVideos();
        if (selected && selected.length > 0) {
          const clip = selected[0];
          relinkMissingMedia(entry, {
            src: clip.src,
            path: clipSrcToPath(clip.src),
            name: clip.name,
            width: clip.width,
            height: clip.height,
            duration: clip.duration,
            thumbnail: clip.thumbnail,
          });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content missing-media-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={dismissMissingMedia}><X size={18} /></button>

        <div className="missing-media-title">
          <AlertTriangle size={18} /> 有 {missingMedia.length} 个媒体文件缺失
        </div>
        <p className="missing-media-desc">
          以下文件在原路径找不到（可能已被移动或删除）。可逐项重新链接，或点击「知道了」暂时跳过。
        </p>

        <div className="missing-media-list">
          {missingMedia.map((entry, i) => (
            <div className="missing-media-item" key={`${entry.segmentIndex}-${entry.videoIndex}-${i}`}>
              <div className="missing-media-info">
                <span className="missing-media-name">{entry.name}</span>
                <span className="missing-media-path" title={entry.path}>{entry.path}</span>
              </div>
              <button className="btn-small" disabled={busy} onClick={() => handleRelink(entry)}>
                <Link2 size={12} /> 重新链接
              </button>
            </div>
          ))}
        </div>

        <div className="missing-media-footer">
          <button className="btn-small" onClick={dismissMissingMedia}>知道了</button>
        </div>
      </div>
    </div>
  );
};

export default MissingMediaDialog;
