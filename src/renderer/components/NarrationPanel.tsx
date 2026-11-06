/**
 * NarrationPanel - 片段旁白编辑面板（故事板「旁白」Tab）
 *
 * 每段一条旁白：文案 + TTS 合成或导入音频 + 音量 + 试听。
 * 渲染时由 MultiSegmentPromo 从该段起点播放（顶层 <Audio>，不被段时长截断）。
 * TTS 走 OpenAI 兼容 /audio/speech（主进程缓存）；未配置时可导入现成音频兜底。
 */

import React, {useEffect, useRef, useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {toLocalVideoUrl} from './RemotionPreviewPlayer';
import {Mic, Play, Pause, Sparkles, FolderOpen, Loader2, Trash2} from 'lucide-react';
import './NarrationPanel.css';

export const NarrationPanel: React.FC = () => {
  const {segments, activeSegmentIndex, updateSegmentNarration, clearSegmentNarration} = useProjectStore();
  const segment = segments[activeSegmentIndex];
  const narration = segment?.narration;

  const [ttsConfigured, setTtsConfigured] = useState<boolean | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    window.api.ttsGetStatus().then((s) => setTtsConfigured(Boolean(s.configured && s.baseUrl && s.model))).catch(() => setTtsConfigured(false));
  }, []);

  const setText = (text: string) => {
    if (!segment) return;
    updateSegmentNarration(activeSegmentIndex, {text});
  };

  const setVolume = (volume: number) => {
    if (!segment) return;
    updateSegmentNarration(activeSegmentIndex, {volume});
  };

  const setSpeed = (speed: number) => {
    if (!segment) return;
    updateSegmentNarration(activeSegmentIndex, {speed});
  };

  /** 音色覆盖（空串 = 回退设置里的默认音色；写 undefined 交给 tts 服务用默认） */
  const setVoice = (voice: string) => {
    if (!segment) return;
    updateSegmentNarration(activeSegmentIndex, voice.trim() ? {voice: voice.trim().slice(0, 60)} : {voice: undefined});
  };

  /** TTS 合成：调主进程合成并落盘缓存，回填 src/path/duration */
  const handleSynthesize = async () => {
    const text = (narration?.text || '').trim();
    if (!text) {
      setError('请先填写旁白文案');
      return;
    }
    setSynthesizing(true);
    setError('');
    try {
      const speed = narration?.speed ?? 1;
      const voice = narration?.voice;
      const result = await window.api.ttsSynthesize({text, speed, ...(voice ? {voice} : {})});
      updateSegmentNarration(activeSegmentIndex, {
        src: result.src,
        path: result.path,
        duration: result.duration,
        source: 'tts',
        speed,
        ...(voice ? {voice} : {}),
        volume: narration?.volume ?? 1,
      });
    } catch (err) {
      setError(String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSynthesizing(false);
    }
  };

  /** 导入现成音频作为旁白 */
  const handleImport = async () => {
    setImporting(true);
    setError('');
    try {
      const file = await window.api.selectAudioFile();
      if (!file) return;
      const analysis = await window.api.analyzeAudio(file.path);
      updateSegmentNarration(activeSegmentIndex, {
        text: narration?.text || '',
        src: file.src,
        path: file.path,
        duration: analysis.duration,
        source: 'import',
        volume: narration?.volume ?? 1,
      });
    } catch (err) {
      setError('加载音频失败：' + String(err));
    } finally {
      setImporting(false);
    }
  };

  const togglePreview = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play().catch(() => {});
      setPlaying(true);
    }
  };

  const hasAudio = Boolean(narration?.src);
  const previewSrc = narration?.src ? toLocalVideoUrl(narration.src) : '';

  return (
    <div className="narration-panel">
      <div className="form-group">
        <label>旁白文案</label>
        <textarea
          className="narration-text"
          value={narration?.text || ''}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入这段的旁白文案，例如：三步上手，小白也能剪出好片子。"
          rows={4}
          maxLength={200}
        />
        <span className="narration-counter">{(narration?.text || '').length}/200</span>
      </div>

      <div className="narration-actions">
        <button className="btn-small" onClick={handleSynthesize} disabled={synthesizing || !narration?.text?.trim()}>
          {synthesizing ? <><Loader2 size={12} className="icon-spin" /> 合成中…</> : <><Sparkles size={12} /> TTS 生成</>}
        </button>
        <button className="btn-small" onClick={handleImport} disabled={importing}>
          {importing ? <><Loader2 size={12} className="icon-spin" /> 导入中…</> : <><FolderOpen size={12} /> 导入音频</>}
        </button>
        {hasAudio && (
          <button className="btn-small btn-danger" onClick={() => { clearSegmentNarration(activeSegmentIndex); setPlaying(false); }} title="移除旁白音频">
            <Trash2 size={12} /> 移除
          </button>
        )}
      </div>

      {ttsConfigured === false && (
        <p className="narration-hint">未配置 TTS：可导入现成音频，或到「设置 → TTS 语音合成」配置后用文字合成。</p>
      )}
      {ttsConfigured === true && (
        <p className="narration-hint">TTS 旁白为 AI 合成语音：含 AI 旁白的成片发布到各平台时，请按平台规则声明 AI 生成内容。</p>
      )}

      {hasAudio ? (
        <div className="narration-audio-row">
          <audio ref={audioRef} src={previewSrc} onEnded={() => setPlaying(false)} preload="auto" />
          <button className="narration-play" onClick={togglePreview} title="试听">
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <span className="narration-source">
            <Mic size={12} /> {narration?.source === 'tts' ? 'TTS' : '导入'} · {(narration?.duration ?? 0).toFixed(1)}s
          </span>
          <label className="narration-vol">
            音量
            <input type="range" min={0} max={1} step={0.05} value={narration?.volume ?? 1} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
          {narration?.source === 'tts' && (
            <label
              className="narration-vol"
              title="语速只影响 TTS 合成：调整后需重新点「TTS 生成」（新语速会重新合成，不命中旧缓存）"
            >
              语速
              <input type="range" min={0.5} max={2} step={0.05} value={narration?.speed ?? 1} onChange={(e) => setSpeed(Number(e.target.value))} />
            </label>
          )}
          {narration?.source === 'tts' && (
            <label
              className="narration-voice"
              title="音色覆盖（留空用「设置 → TTS」的默认音色）；换音色需重新点「TTS 生成」"
            >
              音色
              <input
                type="text"
                className="narration-voice-input"
                placeholder="默认"
                value={narration?.voice ?? ''}
                onChange={(e) => setVoice(e.target.value)}
              />
            </label>
          )}
        </div>
      ) : (
        narration?.text?.trim() && <p className="narration-hint">文案已保存，点击「TTS 生成」或「导入音频」生成旁白。</p>
      )}

      {error && <p className="narration-error">{error}</p>}
    </div>
  );
};

export default NarrationPanel;
