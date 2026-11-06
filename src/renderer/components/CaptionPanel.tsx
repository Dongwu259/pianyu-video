/**
 * CaptionPanel - 片段烧录字幕编辑面板（故事板「字幕」Tab）
 *
 * 每段若干字幕行（文案 + 起止秒，相对段起点）。可手动增删改，或「从旁白生成」
 * 按标点切句均分到段时长。渲染时由 MultiSegmentPromo 顶层 CaptionLayer 显示。
 */

import React from 'react';
import {useProjectStore} from '../store/projectStore';
import type {CaptionLine} from '../../shared/types';
import {Plus, Trash2, Sparkles, Mic} from 'lucide-react';
import {clipSrcToPath} from '../utils/clipPath';
import {CaptionStyleControls} from './CaptionStyleControls';
import './CaptionPanel.css';

/** 按标点切句，过滤空句 */
const splitSentences = (text: string): string[] =>
  text
    .split(/[。！？!?\n]+|[,，;；、]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** 从旁白文案生成字幕行：切句后均分到段时长，每行最短 0.8s，末行对齐段尾 */
const captionsFromNarration = (text: string, duration: number): CaptionLine[] => {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const per = Math.max(0.8, duration / sentences.length);
  return sentences.map((s, i) => ({
    text: s,
    startSec: Math.round(i * per * 10) / 10,
    endSec: Math.round(Math.min(duration, (i + 1) * per) * 10) / 10,
  }));
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Electron invoke 抛错会带前缀，剥掉只留中文正文 */
const stripIpcPrefix = (err: unknown): string =>
  String(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const CaptionPanel: React.FC = () => {
  const {segments, activeSegmentIndex, setSegmentCaptions, clearSegmentCaptions} = useProjectStore();
  const [asrLoading, setAsrLoading] = React.useState(false);
  const [asrMsg, setAsrMsg] = React.useState('');
  const segment = segments[activeSegmentIndex];
  if (!segment) return null;
  const duration = segment.duration || 8;
  const captions: CaptionLine[] = segment.captions || [];
  // ASR 识别目标：本段第一个视频素材（图片没有音轨，不可识别）
  const asrClip = segment.videos.find((v) => v.type === 'video');

  const update = (next: CaptionLine[]) => setSegmentCaptions(activeSegmentIndex, next.length > 0 ? next : undefined);

  const addLine = () => {
    const last = captions[captions.length - 1];
    const start = last ? last.endSec : 0;
    let end = round1(start + 1);
    if (end <= start || end > duration) end = round1(Math.min(duration, start + 0.5));
    update([...captions, {text: '', startSec: round1(start), endSec: end}]);
  };

  const editLine = (i: number, patch: Partial<CaptionLine>) => {
    update(captions.map((c, j) => (j === i ? {...c, ...patch} : c)));
  };

  const removeLine = (i: number) => {
    update(captions.filter((_, j) => j !== i));
  };

  const generateFromNarration = () => {
    const text = (segment.narration?.text || '').trim();
    if (!text) return;
    update(captionsFromNarration(text, duration));
  };

  /** 从素材识别字幕：确认后调 ASR 服务，结果写入本段字幕（撤销/脏标记由 store setter 接入） */
  const transcribeFromMedia = async () => {
    if (!asrClip) return;
    const overwrite = captions.length > 0 ? '，并覆盖当前字幕' : '';
    if (!window.confirm(`将调用 ASR 服务识别「${asrClip.name}」的语音（消耗你的 ASR 服务额度）${overwrite}`)) return;
    setAsrLoading(true);
    setAsrMsg('');
    try {
      const lines = await window.api.asrTranscribe({path: clipSrcToPath(asrClip.src), segmentDuration: duration});
      if (lines.length === 0) {
        setAsrMsg('未识别到可用字幕（素材可能无人声）');
        return;
      }
      update(lines);
      setAsrMsg(`已识别 ${lines.length} 行字幕`);
    } catch (err) {
      setAsrMsg(stripIpcPrefix(err));
    } finally {
      setAsrLoading(false);
    }
  };

  return (
    <div className="caption-panel">
      <div className="caption-toolbar">
        <button className="btn-small" onClick={addLine}>
          <Plus size={12} /> 添加字幕行
        </button>
        <button
          className="btn-small"
          onClick={generateFromNarration}
          disabled={!segment.narration?.text?.trim()}
          title="从本段旁白文案切句生成字幕"
        >
          <Sparkles size={12} /> 从旁白生成
        </button>
        <button
          className="btn-small"
          onClick={transcribeFromMedia}
          disabled={!asrClip || asrLoading}
          title={asrClip ? '调用 ASR 服务识别本段视频素材的语音生成字幕' : '本段暂无视频素材，无法识别语音'}
        >
          <Mic size={12} /> {asrLoading ? '识别中…' : '从素材识别字幕'}
        </button>
        {captions.length > 0 && (
          <button className="btn-small btn-danger" onClick={() => clearSegmentCaptions(activeSegmentIndex)}>
            <Trash2 size={12} /> 清空
          </button>
        )}
        <span className="caption-dur-hint">段时长 {duration}s（止 ≤ {duration}）</span>
      </div>

      {asrMsg && <p className="caption-asr-msg">{asrMsg}</p>}

      {captions.length === 0 ? (
        <p className="caption-empty">本段暂无字幕。可手动添加，或填写旁白后点「从旁白生成」。</p>
      ) : (
        <div className="caption-list">
          {captions.map((c, i) => (
            <div className="caption-row" key={i}>
              <input
                className="caption-text"
                value={c.text}
                onChange={(e) => editLine(i, {text: e.target.value})}
                placeholder="字幕文案"
                maxLength={60}
              />
              <label className="caption-time">
                起
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={c.startSec}
                  onChange={(e) => {
                    // 起不能晚于止（最少留 0.1s），否则该行静默不显示
                    const v = Math.max(0, Number(e.target.value) || 0);
                    editLine(i, {startSec: Math.min(v, Math.max(0, c.endSec - 0.1))});
                  }}
                />
              </label>
              <label className="caption-time">
                止
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={c.endSec}
                  onChange={(e) => {
                    // 止不能早于起，且不超段时长
                    const v = Math.max(0, Number(e.target.value) || 0);
                    editLine(i, {endSec: Math.min(duration, Math.max(v, c.startSec + 0.1))});
                  }}
                />
              </label>
              <button className="btn-icon btn-danger" onClick={() => removeLine(i)} title="删除该行">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 字幕样式（全片通用，与「风格」面板同一控件） */}
      <div className="caption-style-section">
        <span className="caption-style-title">字幕样式（全片通用）</span>
        <CaptionStyleControls />
      </div>
    </div>
  );
};

export default CaptionPanel;
