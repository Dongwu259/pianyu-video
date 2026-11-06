/**
 * HighlightModal - 高光精选面板（mine_highlights 启发式预筛的人工确认回环）
 *
 * 候选缩略图墙（AI 推荐分 + 理由 + 时间区间）→ 用户点选确认 →
 * 一键转 set_segment_trim 挖段（单选 = 裁剪 trim；多选 = 区间外挖洞 cuts）。
 * 用户选择同步落本地 jsonl（userData/highlight-choices.jsonl，RLHF 留口）。
 *
 * 数据源：projectStore.highlightCandidates（mine_highlights 工具的预筛产物，
 * 会话态不持久化）；素材卡出现「高光」入口（有候选时）。
 */

import React, {useState} from 'react';
import {X, Sparkles, Check, Scissors} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import {clipSrcToPath} from '../utils/clipPath';
import './HighlightModal.css';

interface HighlightModalProps {
  onClose: () => void;
}

export const HighlightModal: React.FC<HighlightModalProps> = ({onClose}) => {
  const highlightCandidates = useProjectStore((s) => s.highlightCandidates);
  const applyHighlightPick = useProjectStore((s) => s.applyHighlightPick);
  const clearHighlightCandidates = useProjectStore((s) => s.clearHighlightCandidates);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState(false);

  if (!highlightCandidates) return null;
  const {segmentIndex, videoIndex, data} = highlightCandidates;
  const {candidates, thumbnails, mediaName, durationSec, usedAi} = data;

  const toggle = (i: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const confirm = () => {
    const ranges = candidates.filter((_, i) => picked.has(i))
      .map((c) => ({startSec: c.startSec, endSec: c.endSec}));
    if (ranges.length === 0) return;
    applyHighlightPick(segmentIndex, videoIndex, ranges);
    // RLHF 留口：用户选择（含完整候选排序与分项分）落本地 jsonl，后续训练线可采
    const clip = useProjectStore.getState().segments[segmentIndex]?.videos[videoIndex];
    if (clip) {
      void window.api.highlightRecordChoice({
        sourcePath: (() => {try {return clipSrcToPath(clip.src);} catch {return '';}})(),
        segmentIndex, videoIndex,
        candidates: candidates.map((c) => ({startSec: c.startSec, endSec: c.endSec, score: c.score, motion: c.motion, audio: c.audio, exposure: c.exposure})),
        picked: ranges,
        usedAi,
      }).catch(() => {});
    }
    setApplied(true);
    setTimeout(() => {
      clearHighlightCandidates();
      onClose();
    }, 900);
  };

  const totalPicked = candidates.filter((_, i) => picked.has(i))
    .reduce((sum, c) => sum + (c.endSec - c.startSec), 0);

  return (
    <div className="hm-overlay" onClick={applied ? undefined : onClose}>
      <div className="hm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hm-header">
          <div className="hm-title">
            <Sparkles size={15} />
            <span>高光精选 · {mediaName}</span>
            <span className="hm-meta">{durationSec.toFixed(0)}s · {candidates.length} 候选 · {usedAi ? 'AI 看图精选 + 启发式' : '启发式预筛'}</span>
          </div>
          <button className="hm-close" onClick={onClose} disabled={applied}><X size={15} /></button>
        </div>

        <div className="hm-grid">
          {candidates.map((c, i) => {
            const on = picked.has(i);
            return (
              <button
                key={i}
                className={`hm-card ${on ? 'picked' : ''}`}
                onClick={() => toggle(i)}
                title={`${c.startSec.toFixed(1)}-${c.endSec.toFixed(1)}s（综合 ${c.score}）`}
              >
                <div className="hm-thumb">
                  {thumbnails[i] ? <img src={thumbnails[i]} alt="" /> : <div className="hm-thumb-empty">无预览</div>}
                  <span className="hm-score">{c.score.toFixed(2)}</span>
                  {on && <span className="hm-check"><Check size={13} /></span>}
                </div>
                <div className="hm-info">
                  <span className="hm-time">{c.startSec.toFixed(1)} → {c.endSec.toFixed(1)}s</span>
                  <span className="hm-reasons">{c.reasons.slice(0, 2).join(' · ')}</span>
                  <span className="hm-bars">
                    <i style={{width: `${Math.round(c.motion * 100)}%`}} title={`运动 ${c.motion}`} />
                    <i style={{width: `${Math.round(c.audio * 100)}%`}} title={`音轨 ${c.audio}`} />
                    <i style={{width: `${Math.round(c.exposure * 100)}%`}} title={`曝光 ${c.exposure}`} />
                    <i style={{width: `${Math.round((c.person ?? 0) * 100)}%`}} title={`人物概率 ${c.person ?? 0}（肤色+中心构图弱信号，非人脸检测）`} />
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="hm-footer">
          <span className="hm-hint">
            {picked.size > 0
              ? `已选 ${picked.size} 段共 ${totalPicked.toFixed(1)}s——确认后一键挖段（${picked.size === 1 ? '裁剪为选中区间' : '保留选中区间、区间外挖洞无缝拼接'}）`
              : '点选候选（可多选）：选中区间保留，其余挖掉'}
          </span>
          <button className="hm-confirm" onClick={confirm} disabled={picked.size === 0 || applied}>
            {applied ? <><Check size={13} /> 已挖段</> : <><Scissors size={13} /> 挖段落地（{picked.size}）</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HighlightModal;
