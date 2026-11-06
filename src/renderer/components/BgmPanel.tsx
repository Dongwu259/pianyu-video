/**
 * BgmPanel - 背景音乐音轨面板
 *
 * 项目级背景音乐：导入音频、显示波形、调音量/淡入淡出、试听。
 * 渲染时由 MultiSegmentPromo 的 <Audio> 播放（带淡入淡出包络）。
 *
 * 内置配乐库：resources/bgm 12 首（Kevin MacLeod / incompetech，CC BY 4.0，
 * 用户拍板 2026-10-13 可用）。与本地曲库走完全相同的数据路径，选中曲带
 * credit 字段——渲染端自动烧录片尾署名（强制署名，不可关）。
 *
 * 本地曲库：用户指定一个本地文件夹当曲库，曲库区块在现有上传按钮下方，
 * 点选曲目与「选择音频」上传走完全相同的数据路径。
 */

import React, {useState, useRef, useEffect} from 'react';
import {useProjectStore} from '../store/projectStore';
import {Music, Play, Pause, Zap, FolderOpen, ChevronDown, ChevronUp, Sparkles, Disc3} from 'lucide-react';
import {bgmCreditLine, isAttributionRequired, type BgmBuiltinTrack} from '../../shared/bgm-credits';
import './BgmPanel.css';

/**
 * 音效设计（SFX）内联控件：总开关 + 轨道音量 + 三类自动放置开关。
 * 与背景音乐合并为同一行「声音」板块（竖线分隔），与有无 BGM 无关
 * （beatImpact 无 BGM 波形时自然无节拍可放），故两个分支都渲染。
 * 放置规则见 shared/sfx-plan.ts；预览/导出共用同一逻辑。
 */
const SfxInline: React.FC = () => {
  const sfx = useProjectStore((s) => s.sfx);
  const setSfx = useProjectStore((s) => s.setSfx);
  const chips: {key: 'transitionWhoosh' | 'beatImpact' | 'introRiser'; label: string; title: string}[] = [
    {key: 'transitionWhoosh', label: '转场音效', title: '片段转场中点按类型放匹配音效：滑动/推拉/甩镜=唰，淡化/模糊=气息，缩放/运镜/翻转=低频下坠，闪白=重音，擦除=风声（硬切不放）'},
    {key: 'beatImpact', label: '节拍重音', title: 'BGM 节拍落点自动放 impact（需先添加背景音乐；避开转场与片头）'},
    {key: 'introRiser', label: '片头上升音', title: '片头第 0 帧放品牌揭示音铺底（气流 + 和弦渐强）'},
  ];
  return (
    <div className="sfx-inline">
      <span className="bgm-name" title="自动音效：转场风声 / 节拍重音 / 片头上升音，渲染时按放置规则混入">
        <Sparkles size={13} /> 音效
      </span>
      <label className="sfx-master" title="音效总开关（不影响背景音乐）">
        <input type="checkbox" checked={sfx.enabled} onChange={(e) => setSfx({enabled: e.target.checked})} />
        启用
      </label>
      <label className="bgm-ctrl sfx-vol">
        <span>音量 {Math.round(sfx.volume * 100)}%</span>
        <input
          type="range" min={0} max={1} step={0.05} value={sfx.volume}
          disabled={!sfx.enabled}
          onChange={(e) => setSfx({volume: Number(e.target.value)})}
        />
      </label>
      <div className="sfx-chips">
        {chips.map((c) => (
          <button
            key={c.key}
            className={`sfx-chip ${sfx.enabled && sfx[c.key] ? 'on' : ''}`}
            disabled={!sfx.enabled}
            title={c.title}
            onClick={() => setSfx({[c.key]: !sfx[c.key]})}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
};

interface LibraryTrack {
  name: string;
  path: string;
}

/** 内置曲库区块：resources/bgm 12 首 CC BY 4.0（挂载时取一次；曲子随安装包走不会变） */
const BuiltinLibrarySection: React.FC<{picking: boolean; onPick: (t: BgmBuiltinTrack) => void}> = ({picking, onPick}) => {
  const [tracks, setTracks] = useState<BgmBuiltinTrack[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.getBgmLibrary()
      .then((list) => { if (!cancelled) setTracks(list); })
      .catch(() => { if (!cancelled) setTracks([]); });
    return () => { cancelled = true; };
  }, []);

  if (tracks === null) return null; // 加载中不占位，避免空区块闪现
  if (tracks.length === 0) return null; // 目录缺失（异常安装）整体不显示

  return (
    <div className="bgm-lib bgm-lib-builtin">
      <div className="bgm-lib-head">
        <span className="bgm-lib-title"><Disc3 size={12} /> 内置配乐</span>
        <span className="bgm-cc-badge" title="CC BY 4.0：可自由使用，成片须署名——片语会在片尾自动附上，发布时建议在描述区也带上">CC BY 4.0 · 成片自动署名</span>
      </div>
      <div className="bgm-lib-list">
        {tracks.map((t) => (
          <div
            key={t.file}
            className={`bgm-lib-track${picking ? ' disabled' : ''}`}
            title={`Music: ${t.title} by ${t.author} (${t.license})`}
            onClick={() => { if (!picking) onPick(t); }}
          >
            <Music size={12} />
            <span className="bgm-lib-track-name">{t.title}</span>
            <span className="bgm-mood-chip">{t.moodLabel}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** 曲库曲目行：名称 + 懒加载时长（进入可视区才分析；主进程有磁盘缓存） */
const LibraryTrackRow: React.FC<{track: LibraryTrack; disabled: boolean; onPick: (t: LibraryTrack) => void}> = ({track, disabled, onPick}) => {
  const [duration, setDuration] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    let cancelled = false;
    const load = () => {
      window.api.analyzeMusic(track.path)
        .then((a) => { if (!cancelled && a.duration > 0) setDuration(a.duration); })
        .catch(() => {});
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        load();
      }
    });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [track.path]);

  return (
    <div
      ref={rowRef}
      className={`bgm-lib-track${disabled ? ' disabled' : ''}`}
      title={track.path}
      onClick={() => { if (!disabled) onPick(track); }}
    >
      <Music size={12} />
      <span className="bgm-lib-track-name">{track.name}</span>
      <span className="bgm-lib-track-dur">{duration === null ? '…' : `${duration.toFixed(1)}s`}</span>
    </div>
  );
};

/** 曲库区块：未设置目录时给引导；已设置时列曲目（点选 = 设为 BGM） */
const MusicLibrarySection: React.FC<{picking: boolean; onPick: (t: LibraryTrack) => void}> = ({picking, onPick}) => {
  const musicDir = useProjectStore((s) => s.appSettings.musicLibraryDir);
  const setAppSettings = useProjectStore((s) => s.setAppSettings);
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [scanning, setScanning] = useState(false);

  // 目录变化时重新扫描（含首次挂载；App 启动时已把设置同步进 store）
  useEffect(() => {
    if (!musicDir) {
      setTracks([]);
      return;
    }
    let cancelled = false;
    setScanning(true);
    window.api.scanMusicLibrary()
      .then((list) => { if (!cancelled) setTracks(list); })
      .catch(() => { if (!cancelled) setTracks([]); })
      .finally(() => { if (!cancelled) setScanning(false); });
    return () => { cancelled = true; };
  }, [musicDir]);

  // 设置/更换曲库目录：主进程弹目录选择框 → 写入设置（settings:set 白名单）→ 同步内存 store 触发扫描
  const chooseDir = async () => {
    const dir = await window.api.selectMusicDir();
    if (!dir) return;
    await window.api.setSettings({musicLibraryDir: dir});
    setAppSettings({musicLibraryDir: dir});
  };

  if (!musicDir) {
    return (
      <div className="bgm-lib bgm-lib-empty">
        <button className="btn-secondary" onClick={chooseDir}>
          <FolderOpen size={14} /> 设置曲库目录
        </button>
        <span className="bgm-hint">指定一个本地文件夹作为曲库，即可直接点选配乐</span>
      </div>
    );
  }

  return (
    <div className="bgm-lib">
      <div className="bgm-lib-head">
        <span className="bgm-lib-title"><FolderOpen size={12} /> 曲库</span>
        <button className="btn-small" onClick={chooseDir} title={musicDir}>更换目录</button>
        {scanning && <span className="bgm-hint">扫描中…</span>}
      </div>
      {!scanning && tracks.length === 0 ? (
        <span className="bgm-hint">曲库目录中没有音频文件（mp3 / wav / m4a / ogg / flac）</span>
      ) : (
        <div className="bgm-lib-list">
          {tracks.map((t) => (
            <LibraryTrackRow key={t.path} track={t} disabled={picking} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
};

export const BgmPanel: React.FC = () => {
  const {bgm, setBgm, updateBgm, alignSegmentsToBeats, segments, beatPulse, setBeatPulse} = useProjectStore();
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [alignMsg, setAlignMsg] = useState('');
  // 曲库区块默认收起（两条横栏压缩成一条），点「曲库」按钮展开
  const [libOpen, setLibOpen] = useState(false);
  // 试听播放进度（秒），随 <audio> timeupdate 更新
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);

  // 换曲后归零进度、停止播放态
  useEffect(() => { setCurrentTime(0); setPlaying(false); }, [bgm?.src]);

  /** 波形条点击跳转 */
  const handleWaveClick = (e: React.MouseEvent) => {
    const a = audioRef.current;
    const el = waveRef.current;
    if (!a || !el || !bgm || bgm.duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * bgm.duration;
    setCurrentTime(a.currentTime);
  };

  /** 曲库展开/收起切换按钮（始终挂在音轨横栏右端） */
  const libToggle = (
    <button
      className="btn-small bgm-lib-toggle"
      onClick={() => setLibOpen((o) => !o)}
      title={libOpen ? '收起曲库' : '展开曲库（内置配乐 12 首 + 指定本地文件夹）'}
    >
      <FolderOpen size={12} /> 曲库 {libOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </button>
  );

  /** 卡点对齐：把各片段切点吸附到检测出的节拍上 */
  const handleAlign = () => {
    const r = alignSegmentsToBeats();
    const bpmSuffix = bgm?.bpm ? ` · ≈${Math.round(bgm.bpm)} BPM` : '';
    if (!r) setAlignMsg('未检测到可用节拍（换一首鼓点清晰的曲子试试）');
    else if (r.movedCount === 0) setAlignMsg(`各切点已在节拍上${bpmSuffix}`);
    else setAlignMsg(`已对齐 ${r.movedCount} 个切点（${r.beatCount} 拍${bpmSuffix}）`);
    window.setTimeout(() => setAlignMsg(''), 3000);
  };

  const handleAdd = async () => {
    setLoading(true);
    try {
      const file = await window.api.selectAudioFile();
      if (!file) return;
      const analysis = await window.api.analyzeAudio(file.path);
      setBgm({
        name: file.name,
        src: file.src,
        path: file.path,
        duration: analysis.duration,
        volume: 0.6,
        fadeIn: 0.5,
        fadeOut: 1.0,
        peaks: analysis.peaks,
        beats: analysis.beats,
        bpm: analysis.bpm,
      });
    } catch (err) {
      alert('加载音频失败：' + String(err));
    } finally {
      setLoading(false);
    }
  };

  /** 点选曲库曲目：与上传完全相同的数据路径（注册 HTTP src + 分析 + 写 projectStore.bgm） */
  const handlePickLibraryTrack = async (t: LibraryTrack) => {
    setLoading(true);
    try {
      const src = await window.api.getVideoHttpUrl(t.path);
      const analysis = await window.api.analyzeMusic(t.path);
      setBgm({
        name: t.name,
        src,
        path: t.path,
        duration: analysis.duration,
        volume: 0.6,
        fadeIn: 0.5,
        fadeOut: 1.0,
        peaks: analysis.peaks,
        beats: analysis.beats,
        bpm: analysis.bpm,
      });
    } catch (err) {
      alert('加载音频失败：' + String(err));
    } finally {
      setLoading(false);
    }
  };

  /** 点选内置配乐：与本地曲库相同的注册/分析数据路径，选中曲带 credit（渲染端强制片尾署名） */
  const handlePickBuiltinTrack = async (t: BgmBuiltinTrack) => {
    setLoading(true);
    try {
      const src = await window.api.getVideoHttpUrl(t.path);
      const analysis = await window.api.analyzeMusic(t.path);
      setBgm({
        name: t.title,
        src,
        path: t.path,
        duration: analysis.duration,
        volume: 0.6,
        fadeIn: 0.5,
        fadeOut: 1.0,
        peaks: analysis.peaks,
        beats: analysis.beats,
        bpm: analysis.bpm,
        credit: {file: t.file, title: t.title, author: t.author, license: t.license, url: t.url},
      });
    } catch (err) {
      alert('加载音频失败：' + String(err));
    } finally {
      setLoading(false);
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

  if (!bgm) {
    return (
      <div className="bgm-wrap">
        <div className="bgm-panel bgm-empty">
          <span className="bgm-name sound-label" title="声音板块：背景音乐 + 自动音效">
            <Music size={13} /> 声音
          </span>
          <button className="btn-secondary" onClick={handleAdd} disabled={loading}>
            {loading ? '加载中...' : <><Music size={14} /> 添加背景音乐</>}
          </button>
          <span className="bgm-hint">为整段视频配乐（渲染时混入，含淡入淡出）</span>
          <span className="bgm-spacer" />
          <SfxInline />
          {libToggle}
        </div>
        {libOpen && (
          <>
            <BuiltinLibrarySection picking={loading} onPick={handlePickBuiltinTrack} />
            <MusicLibrarySection picking={loading} onPick={handlePickLibraryTrack} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="bgm-wrap">
      <div className="bgm-panel">
        <audio
          ref={audioRef}
          src={bgm.src}
          preload="auto"
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            // 兜底：ffmpeg 分析失败时 duration 为 0（面板曾因此恒显 0.0s），用音频元数据修正
            const d = e.currentTarget.duration;
            if (bgm.duration <= 0 && Number.isFinite(d) && d > 0) updateBgm({duration: d});
          }}
        />
        <button className="bgm-play" onClick={togglePreview} title="试听">{playing ? <Pause size={12} /> : <Play size={12} />}</button>
        <span className="bgm-name" title={bgm.name}><Music size={13} /> {bgm.name}</span>
        {isAttributionRequired(bgm.credit) && (
          <span
            className="bgm-cc-badge"
            title={`署名行：${bgmCreditLine(bgm.credit!)}\n片语会在成片片尾自动附上此署名`}
          >
            CC BY 4.0 · 片尾自动署名
          </span>
        )}
        <span className="bgm-dur">{currentTime.toFixed(1)}/{bgm.duration.toFixed(1)}s</span>

        <div
          ref={waveRef}
          className="bgm-wave"
          onClick={handleWaveClick}
          title="点击跳转"
          style={bgm.duration > 0 ? {
            background: `linear-gradient(to right, color-mix(in srgb, var(--color-accent) 22%, transparent) ${Math.min(100, (currentTime / bgm.duration) * 100)}%, transparent ${Math.min(100, (currentTime / bgm.duration) * 100)}%)`,
          } : undefined}
        >
          {(bgm.peaks && bgm.peaks.length > 0 ? bgm.peaks : [0.1]).map((p, i) => (
            <div key={i} className="bgm-bar" style={{height: `${Math.max(6, p * 100)}%`}} />
          ))}
        </div>

        <div className="bgm-ctrls">
          <label className="bgm-ctrl">
            <span>音量</span>
            <input type="range" min={0} max={1} step={0.05} value={bgm.volume}
              onChange={(e) => updateBgm({volume: Number(e.target.value)})} />
          </label>
          <label className="bgm-ctrl">
            <span>淡入 {bgm.fadeIn.toFixed(1)}s</span>
            <input type="range" min={0} max={5} step={0.1} value={bgm.fadeIn}
              onChange={(e) => updateBgm({fadeIn: Number(e.target.value)})} />
          </label>
          <label className="bgm-ctrl">
            <span>淡出 {bgm.fadeOut.toFixed(1)}s</span>
            <input type="range" min={0} max={5} step={0.1} value={bgm.fadeOut}
              onChange={(e) => updateBgm({fadeOut: Number(e.target.value)})} />
          </label>
        </div>

        <div className="bgm-actions">
          <button
            className="btn-small"
            onClick={handleAlign}
            disabled={segments.length < 2}
            title="把各片段的切点吸附到 BGM 节拍上（卡点剪辑）"
          >
            <Zap size={12} /> 卡点对齐
          </button>
          <button
            className={`sfx-chip ${beatPulse ? 'on' : ''}`}
            title="节拍脉冲：BGM 鼓点上画面微缩放 + 光效闪动（预览/导出均生效）"
            onClick={() => setBeatPulse(!beatPulse)}
          >
            节拍脉冲
          </button>
          {alignMsg && <span className="bgm-align-msg">{alignMsg}</span>}
          <button className="btn-small" onClick={handleAdd} title="更换">更换</button>
          <button className="btn-small btn-danger" onClick={() => { setBgm(null); setPlaying(false); }}>移除</button>
        </div>
        <SfxInline />
        {libToggle}
      </div>
      {libOpen && (
        <>
          <BuiltinLibrarySection picking={loading} onPick={handlePickBuiltinTrack} />
          <MusicLibrarySection picking={loading} onPick={handlePickLibraryTrack} />
        </>
      )}
    </div>
  );
};

export default BgmPanel;
