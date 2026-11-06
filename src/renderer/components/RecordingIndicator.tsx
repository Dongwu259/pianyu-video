/**
 * RecordingIndicator — 全局悬浮录制指示条
 *
 * 录制期间固定显示在右下角（无论用户在哪一步/哪个面板），
 * 显示源名称与已录时长，可一键停止并保存（自动加入当前选中片段素材）。
 * 与录屏弹窗、AI 助手工具共用 captureStore，三方状态一致。
 */

import React, {useState} from 'react';
import {useCaptureStore} from '../store/captureStore';
import {stopRecording, addCaptureToSegment} from '../capture/screenCapture';
import {Square, Loader2} from 'lucide-react';
import './RecordingIndicator.css';

const fmtElapsed = (sec: number): string => {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const RecordingIndicator: React.FC = () => {
  const recording = useCaptureStore((s) => s.recording);
  const sourceName = useCaptureStore((s) => s.sourceName);
  const elapsedSec = useCaptureStore((s) => s.elapsedSec);
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState('');

  if (!recording && !savedNote) return null;

  const handleStop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await stopRecording();
      if (saved) {
        // 纯录屏会话（首页「只录屏」入口）：只落盘不导入，文件在录制文件夹
        if (useCaptureStore.getState().standaloneMode) {
          setSavedNote('已保存到录制文件夹（纯录屏，不进故事板）');
        } else {
          const res = await addCaptureToSegment(saved);
          setSavedNote(`已保存并加入第 ${res.segmentIndex + 1} 段素材`);
        }
        setTimeout(() => setSavedNote(''), 4000);
      }
    } catch (err) {
      console.error('[capture] 停止录制失败:', err);
    } finally {
      setBusy(false);
    }
  };

  if (!recording) {
    // 刚保存完的短暂提示
    return <div className="recording-indicator saved">{savedNote}</div>;
  }

  return (
    <div className="recording-indicator">
      <span className="capture-rec-dot" />
      <span className="recording-indicator-time">{fmtElapsed(elapsedSec)}</span>
      <span className="recording-indicator-name" title={sourceName}>{sourceName}</span>
      <button className="recording-indicator-stop" onClick={handleStop} disabled={busy}>
        {busy ? <Loader2 size={12} className="icon-spin" /> : <Square size={12} />} 停止并保存
      </button>
    </div>
  );
};

export default RecordingIndicator;
