/**
 * 渲染导出面板 — 多段故事板模式
 * 功能：故事板预览 → 专业导出设置 → 渲染 → 进度反馈 → 完成
 */

import React, {useEffect, useState, useCallback, useRef} from 'react';
import {useProjectStore} from '../store/projectStore';
import {useStartRender} from '../hooks/useStartRender';
import {TEMPLATES} from '../../shared/template-registry';
import {ASPECT_RATIO_PRESETS} from '../../shared/aspect-ratios';
import type {RenderFormat, RenderOptions, RenderEncoderUsed, MultiSegmentProps} from '../../shared/types';
import {bgmCreditLine, isAttributionRequired} from '../../shared/bgm-credits';
import {
  createBatchJobs, nextJob, updateJobProgress, markJobDone, markJobFailed,
  cancelRest, isBatchRunning, buildBatchFilename,
} from '../render/batchQueue';
import type {BatchJob} from '../render/batchQueue';
import {ChevronDown, ChevronRight, Loader2, Check, FolderOpen, Folder, AlertTriangle, Play, ArrowLeft, X, Layers, Image, Zap} from 'lucide-react';
import {FullVideoPreview} from './FullVideoPreview';
import {PublishKitModal} from './PublishKitModal';
import './RenderPanel.css';

export const RenderPanel: React.FC = () => {
  const {
    segments,
    aspectRatioId,
    setAspectRatioId,
    renderSettings,
    setRenderSettings,
    appSettings,
    isRendering,
    renderProgress,
    renderOutputPath,
    setProgress,
    setStep,
    getTotalDuration,
    licenseStatus,
    orientation,
    customTemplates,
    marketTemplates,
    generatedTemplates,
    bgm,
    logo,
    captionStyle,
    finePrint,
    colorGrade,
    brandColor,
    fontMood,
  } = useProjectStore();

  // 渲染触发逻辑与 AI 助手确认卡共用（授权/水印/720p 闸门在主进程 RENDER_START 不变）
  const startRenderJob = useStartRender();

  const [error, setError] = useState<string>('');
  const [warning, setWarning] = useState<string>('');
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  // 渲染中切走再回来（返回编辑再进步骤页）组件重挂载：startTimestamp 归零会让 ETA
  // 用 Date.now() 起算变成「预计还需 N 小时」——isRendering 为真且无时间戳时此处补打点
  useEffect(() => {
    if (isRendering && startTimestamp === 0) setStartTimestamp(Date.now());
    if (!isRendering && startTimestamp !== 0) setStartTimestamp(0);
  }, [isRendering, startTimestamp]);
  // 本次渲染实际使用的编码器（完成提示中展示；开始新渲染时清空）
  const [completedEncoder, setCompletedEncoder] = useState<RenderEncoderUsed | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 封面与发布信息弹窗（成片衍生品：封面设计 + 发布元数据）
  const [showPublishKit, setShowPublishKit] = useState(false);
  // 免费版提示条（可关闭，仅本次会话内记住）
  const [licenseNoticeDismissed, setLicenseNoticeDismissed] = useState(false);
  // 输出目录（默认取设置页的 defaultOutputDir，可临时更改）
  const [outputDir, setOutputDir] = useState<string>(appSettings.defaultOutputDir || '');

  // 成片含 TTS 旁白（AI 合成语音）时，导出完成后提示用户按平台规则声明 AI 生成内容
  const hasTtsNarration = segments.some((s) => s.narration?.source === 'tts' && s.narration?.src);
  // 配乐为 CC BY 4.0（内置曲库）时，导出完成后提示署名行（片尾已自动烧录，描述区建议一并带上）
  const bgmCredit = bgm?.credit;
  const bgmCreditText = isAttributionRequired(bgmCredit) ? bgmCreditLine(bgmCredit) : '';

  // ====== 批量导出（多比例队列）======
  // 勾选项（画幅预设 id）；批量任务队列（空 = 未运行/已取消）
  const [batchSelected, setBatchSelected] = useState<string[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  // 串行循环防重入：运行中为 true
  const batchRunningRef = useRef(false);
  // 只提供与当前工程方向一致的比例（跨横竖屏重排版不在本期）
  const batchPresets = ASPECT_RATIO_PRESETS.filter((p) => p.orientation === orientation);
  const batchRunning = isBatchRunning(batchJobs);

  // 设置页默认输出目录变化时同步（首次加载或修改设置后）
  useEffect(() => {
    setOutputDir(appSettings.defaultOutputDir || '');
  }, [appSettings.defaultOutputDir]);

  const handleChangeDir = async () => {
    const dir = await window.api.selectOutputDir();
    if (dir) setOutputDir(dir);
  };

  // 订阅渲染进度（单次渲染写全局 store；批量运行中同步更新当前 job）
  useEffect(() => {
    const unsubscribe = window.api.onRenderProgress(({progress}) => {
      setProgress(progress);
      setBatchJobs((prev) => {
        const current = prev.find((j) => j.status === 'rendering');
        return current ? updateJobProgress(prev, current.id, progress) : prev;
      });
    });
    return unsubscribe;
  }, [setProgress]);

  // 勾选/取消勾选一个画幅；改动勾选即作废旧一轮的结果列表
  const toggleBatchPreset = (id: string) => {
    setBatchSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setBatchJobs([]);
  };

  // 开始批量导出：逐 job 调 RENDER_START（严格串行，主进程渲染服务零改动）
  const handleBatchStart = useCallback(async () => {
    if (batchRunningRef.current || segments.length === 0 || batchSelected.length === 0) return;
    batchRunningRef.current = true;
    setError('');
    setWarning('');
    try {
      // 输出目录只解析一次：为空时弹一次选择框（会注册 allowedOutputDirs），后续 job 复用
      let dir = outputDir;
      if (!dir) {
        dir = await window.api.selectOutputDir();
        if (dir) setOutputDir(dir);
      }
      if (!dir) {
        setError('请先选择输出目录');
        return;
      }
      const baseName = renderSettings.filename || '片语';
      // 按画幅预设的声明顺序排列（与用户勾选先后无关），产出顺序稳定
      const items = batchPresets
        .filter((p) => batchSelected.includes(p.id))
        .map((p) => ({
          aspectRatioId: p.id,
          label: `${p.label} ${p.name}`,
          filename: buildBatchFilename(baseName, p.id),
        }));
      let current = createBatchJobs(items);
      setBatchJobs(current);

      for (;;) {
        const step = nextJob(current);
        if (!step.job) {
          setBatchJobs(step.jobs);
          break;
        }
        current = step.jobs;
        setBatchJobs(current);
        const result = await startRenderJob(dir, {
          aspectRatioId: step.job.aspectRatioId,
          filename: step.job.filename,
        });
        if (result.success) {
          current = markJobDone(current, step.job.id, result.outputPath || '');
          setBatchJobs(current);
        } else if (result.cancelled) {
          // 用户取消：RENDER_CANCEL 已停当前渲染，清空队列
          setBatchJobs(cancelRest());
          break;
        } else {
          // 失败即停：当前标记失败，后续标记跳过（语义见 batchQueue.ts）
          current = markJobFailed(current, step.job.id, result.error || '渲染失败，请重试');
          setBatchJobs(current);
          break;
        }
      }
    } finally {
      batchRunningRef.current = false;
    }
  }, [segments.length, batchSelected, batchPresets, outputDir, renderSettings.filename, startRenderJob]);

  // 取消批量：停当前渲染（其结果为 cancelled，循环据此清空队列）
  const handleBatchCancel = useCallback(async () => {
    await window.api.cancelRender();
  }, []);

  // 开始渲染（组装逻辑见 useStartRender，与 AI 助手确认卡共用）
  const handleRender = useCallback(async () => {
    if (segments.length === 0) return;

    setError('');
    setWarning('');
    setCompletedEncoder(null);
    setStartTimestamp(Date.now());

    const result = await startRenderJob(outputDir);
    if (result.success) {
      setCompletedEncoder(result.encoderUsed ?? null);
      const notes: string[] = [];
      if (result.usedFallback && result.outputPath) {
        notes.push(`原保存路径不可用，已保存到: ${result.outputPath}`);
      }
      // 硬件编码不可用/失败回退软件编码时给用户一句说明
      if (result.encoderNote) notes.push(result.encoderNote);
      // 段级缓存命中提示（改一段只重渲该段，其余段直接拼缓存）
      if (result.cacheInfo && result.cacheInfo.hit > 0) {
        notes.push(`段级缓存命中 ${result.cacheInfo.hit}/${result.cacheInfo.total} 段`);
      }
      if (notes.length > 0) setWarning(notes.join('；'));
    } else if (result.cancelled) {
      setWarning('渲染已取消，未生成文件');
    } else {
      setError(result.error || '渲染失败，请重试');
    }
  }, [segments.length, outputDir, startRenderJob]);

  // 快速预览：一键渲一版 540p 低码率样片检查节奏与文案（临时覆盖渲染设置，不动用户保存的值）
  const handleQuickPreview = useCallback(async () => {
    if (segments.length === 0) return;

    setError('');
    setWarning('');
    setCompletedEncoder(null);
    setStartTimestamp(Date.now());

    const base = renderSettings.filename || `promo-${Date.now()}`;
    const result = await startRenderJob(outputDir, {
      filename: `${base}-preview`,
      renderSettings: {crf: 27, scale: 0.5, x264Preset: 'ultrafast'},
    });
    if (result.success) {
      setCompletedEncoder(result.encoderUsed ?? null);
      setWarning(`快速预览已出片 → ${result.outputPath || ''}（确认节奏/文案后再用完整设置渲正片）`);
    } else if (result.cancelled) {
      setWarning('快速预览已取消，未生成文件');
    } else {
      setError(result.error || '渲染失败，请重试');
    }
  }, [segments.length, outputDir, renderSettings.filename, startRenderJob]);

  // 打开输出文件
  const handleOpenFile = async () => {
    if (renderOutputPath) {
      await window.api.openInExplorer(renderOutputPath);
    }
  };

  // 格式化总时长
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
  };

  // 预估文件大小（粗略估算）
  const estimateSize = (): string => {
    if (renderSettings.format === 'gif') return 'GIF 不适用';
    const totalSeconds = getTotalDuration();
    if (totalSeconds === 0) return '';
    // 粗略: bitrate ≈ (CRF 相关的估算) × scale²
    const baseBitrate = Math.max(0.5, (30 - renderSettings.crf) * 0.8); // Mbps
    const scaledBitrate = baseBitrate * (renderSettings.scale ** 2);
    const sizeMB = (scaledBitrate * totalSeconds) / 8;
    return `约 ${sizeMB.toFixed(0)} MB`;
  };

  // 实际输出像素（预设 × scale；免费版短边钳 720、GIF 恒钳 720，与主进程 renderer.ts 同口径）
  const currentPreset = ASPECT_RATIO_PRESETS.find((p) => p.id === aspectRatioId) ?? ASPECT_RATIO_PRESETS[0];
  const isLicensed = licenseStatus?.entitlement !== 'free';
  const outputDims = ((): string => {
    let w = Math.round(currentPreset.width * renderSettings.scale);
    let h = Math.round(currentPreset.height * renderSettings.scale);
    const clampShort = (maxShort: number) => {
      const short = Math.min(w, h);
      if (short > maxShort) {
        const k = maxShort / short;
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
    };
    if (renderSettings.format === 'gif') clampShort(720);
    else if (!isLicensed) clampShort(720);
    w = Math.max(2, Math.floor(w / 2) * 2);
    h = Math.max(2, Math.floor(h / 2) * 2);
    return `${w}×${h}`;
  })();

  const totalDuration = getTotalDuration();
  const formatLabels: Record<RenderFormat, string> = {mp4: 'MP4', 'mp4-hevc': 'MP4 (HEVC)', mov: 'MOV (ProRes)', webm: 'WebM (VP9)', gif: 'GIF'};
  const encoderUsedLabels: Record<RenderEncoderUsed, string> = {
    nvenc: 'NVIDIA NVENC 硬件编码',
    qsv: 'Intel QSV 硬件编码',
    software: '软件编码',
  };

  return (
    <div className="render-panel">
      <div className="render-header">
        <h2>渲染导出</h2>
        <p className="render-subtitle">先「快速预览」看样片，满意后「渲染成片」——编码细节都收在高级折叠里，默认即是 1080p MP4</p>
      </div>

      {/* 免费版提示（不阻塞导出，可关闭） */}
      {licenseStatus?.entitlement === 'free' && !licenseNoticeDismissed && (
        <div className="license-notice-bar">
          <span>当前为免费版，导出视频将带有水印且分辨率受限，激活授权码后可去除</span>
          <button className="license-notice-close" onClick={() => setLicenseNoticeDismissed(true)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* 整片预览（导出前，所见即所得，含转场/BGM/视频音频/免费版水印） */}
      <FullVideoPreview
        inputProps={{segments, orientation, customTemplates: [...customTemplates, ...marketTemplates.map((t) => t.def)], generatedTemplates, bgm, logo, captionStyle, finePrint, colorGrade, brandColor, fontMood} as MultiSegmentProps}
        aspectRatioId={aspectRatioId}
      />

      {/* 故事板概览 */}
      <div className="render-storyboard">
        <h3>故事板 ({segments.length} 片段 · {formatDuration(totalDuration)})</h3>
        <div className="render-segments">
          {segments.map((seg, i) => {
            const tmpl = TEMPLATES.find((t) => t.id === seg.templateId);
            return (
              <div key={seg.id} className="render-segment-item">
                <span className="seg-num">{i + 1}</span>
                <span className="seg-name">{tmpl?.name || seg.templateId}</span>
                <span className="seg-duration">{seg.duration.toFixed(1)}s</span>
                {i < segments.length - 1 && <span className="seg-arrow">→</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ====== 出片行动区：两个大按钮打头（预设优先；格式/CRF 等编码细节收进下方高级折叠） ====== */}
      <div className="render-action-row" data-tour="presets">
        <button
          className="render-big-action"
          onClick={handleQuickPreview}
          disabled={isRendering || batchRunning || segments.length === 0}
          title="立即以 540p + CRF 27 + 极速编码渲一版样片，检查节奏与文案（文件名自动加 -preview；不改动你保存的导出设置）"
        >
          <Zap size={22} />
          <span className="rba-copy">
            <b>快速预览</b>
            <span>540p 样片，几十秒出片，先看节奏和文案对不对</span>
          </span>
        </button>
        <button
          className="render-big-action render-big-primary"
          onClick={handleRender}
          disabled={isRendering || batchRunning || segments.length === 0}
          title="按当前设置（画质与编码细节在下方「高级」折叠里）渲染正片"
        >
          <Play size={22} />
          <span className="rba-copy">
            <b>渲染成片</b>
            <span>
              {formatLabels[renderSettings.format]} · {outputDims}{!isLicensed ? '（免费版 720p + 水印）' : ''}
              {estimateSize() ? ` · ${estimateSize()}` : ''} → {outputDir || '渲染时选择目录'}
            </span>
          </span>
        </button>
      </div>

      {/* ====== 导出设置 ====== */}
      <div className="render-options">

        {/* 输出目录 + 文件名 */}
        <div className="option-card option-card-column">
          <div className="crf-header">
            <span className="option-label">输出目录</span>
            <button className="btn-choose-dir" onClick={handleChangeDir} disabled={batchRunning}>更改</button>
          </div>
          <span className="settings-path" title={outputDir} style={{fontSize: 13, color: '#6B7280', wordBreak: 'break-all'}}>
            {outputDir || '（未设置，渲染时将弹出选择框）'}
          </span>
          <div className="crf-header" style={{marginTop: 10}}>
            <span className="option-label">文件名</span>
            <span style={{fontSize: 11, color: '#9CA3AF'}}>留空则自动生成 promo-时间戳</span>
          </div>
          <input
            type="text"
            className="render-input"
            value={renderSettings.filename}
            onChange={(e) => setRenderSettings({filename: e.target.value})}
            placeholder="promo-video"
          />
        </div>

        {/* 画质预设（只应用设置，渲染点上面的大按钮） */}
        <div className="option-card">
          <div className="option-left" style={{gap: 8, flexWrap: 'wrap'}}>
            <span className="option-label">画质预设</span>
            <button
              className="crf-preset"
              title="CRF 23 + 1080p MP4：体积约为最佳档的 1/3，微信/抖音可直接发送。只应用设置，仍需点「渲染成片」"
              onClick={() => setRenderSettings({crf: 23, scale: 1, format: 'mp4'})}
              disabled={batchRunning}
            >
              分享优化（约 1/3 体积）
            </button>
            <span className="estimate-size">
              默认 1080p MP4 已适合绝大多数场景，格式 / 分辨率 / CRF 等在下方「高级」里
            </span>
          </div>
        </div>

        {/* ====== 高级设置（折叠）：格式 / 比例 / 分辨率 / CRF / 音频 / 编码器 ====== */}
        <div className="advanced-toggle-row">
          <button
            className="advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 画质与编码设置（高级）
          </button>
        </div>

        {showAdvanced && (
          <div className="advanced-settings">
        {/* 输出格式 + 方向 */}
        <div className="option-card">
          <div className="option-left">
            <span className="option-label">格式</span>
            <select
              className="render-select"
              value={renderSettings.format}
              onChange={(e) => setRenderSettings({format: e.target.value as RenderFormat})}
            >
              <option value="mp4">MP4 (H.264)</option>
              <option value="mp4-hevc" title="同质量约为 H.264 一半体积；老设备/老播放器兼容性差">MP4 (H.265/HEVC)</option>
              <option value="mov">MOV (ProRes)</option>
              <option value="webm">WebM (VP9)</option>
              <option value="gif" title="GIF 动图：无音频、体积大，输出短边自动限制在 720px 以内，适合短片段预览/文档嵌入">GIF 动图（≤720p）</option>
            </select>
          </div>
          <div className="option-right">
            <span className="option-label">比例</span>
            <select
              className="render-select"
              value={aspectRatioId}
              disabled={batchRunning}
              onChange={(e) => setAspectRatioId(e.target.value)}
            >
              {ASPECT_RATIO_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label} {p.name}（{p.width}×{p.height}）</option>
              ))}
            </select>
          </div>
        </div>

        {/* 分辨率（帧率锁定 30fps：全链路帧换算均按 30 硬编码，不提供选择） */}
        <div className="option-card">
          <div className="option-left">
            <span className="option-label">分辨率</span>
            <select
              className="render-select"
              value={renderSettings.scale}
              onChange={(e) => setRenderSettings({scale: Number(e.target.value)})}
            >
              <option value={0.5}>540p（流畅）</option>
              <option value={1}>1080p（标准）</option>
              <option value={1.5}>1620p（增强）</option>
              <option value={2}>4K 2160p（高清）</option>
            </select>
          </div>
          <div className="option-right">
            <span className="option-label">实际输出</span>
            <span className="estimate-size" title={isLicensed ? '预设尺寸 × 分辨率倍率' : '免费版短边最高 720p，激活后解锁 4K'}>
              {outputDims}{!isLicensed && renderSettings.scale > 0.7 ? '（免费版受限）' : ''}
            </span>
          </div>
        </div>

        {/* 视频质量 CRF（ProRes/GIF 不支持 CRF，禁用并提示） */}
        <div className="option-card option-card-column">
          <div className="crf-header">
            <span className="option-label">视频质量 (CRF)</span>
            <span className="crf-value">
              {renderSettings.format === 'mov' || renderSettings.format === 'gif'
                ? '不适用'
                : renderSettings.crf}
            </span>
          </div>
          <input
            type="range"
            className="crf-slider"
            min={18}
            max={30}
            step={1}
            value={renderSettings.crf}
            disabled={renderSettings.format === 'mov' || renderSettings.format === 'gif'}
            title={renderSettings.format === 'mov' ? 'ProRes 不使用 CRF（固定高质量中间格式）' : renderSettings.format === 'gif' ? 'GIF 不支持 CRF 质量参数' : undefined}
            onChange={(e) => setRenderSettings({crf: Number(e.target.value)})}
          />
          <div className="crf-labels">
            <span>高质量（大文件）</span>
            <span>低质量（小文件）</span>
          </div>
          <div className="crf-presets">
            {[{label: '最佳', v: 18}, {label: '高', v: 21}, {label: '中', v: 23}, {label: '低', v: 27}].map((p) => (
              <button
                key={p.v}
                className={`crf-preset ${renderSettings.crf === p.v ? 'active' : ''}`}
                disabled={renderSettings.format === 'mov' || renderSettings.format === 'gif'}
                onClick={() => setRenderSettings({crf: p.v})}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 静音 + 预估大小（GIF 本身不含音频，无需勾选） */}
        <div className="option-card">
          <label className="checkbox-label" title={renderSettings.format === 'gif' ? 'GIF 格式不包含音频轨' : undefined}>
            <input
              type="checkbox"
              checked={renderSettings.format === 'gif' ? true : renderSettings.muted}
              disabled={renderSettings.format === 'gif'}
              onChange={(e) => setRenderSettings({muted: e.target.checked})}
            />
            静音输出（不含音频）
          </label>
          <span className="estimate-size">预估: {estimateSize()}</span>
        </div>

        {/* 响度归一化（-14 LUFS：社交/流媒体投放标准；GIF/静音无音轨自动跳过） */}
        <div className="option-card">
          <label
            className="checkbox-label"
            title={
              renderSettings.format === 'gif' || renderSettings.muted
                ? '当前导出无音轨，响度归一化不生效'
                : '成片综合响度归一到 -14 LUFS（B 站/YouTube/信息流投放标准），真峰值上限 -1.5 dBTP'
            }
          >
            <input
              type="checkbox"
              checked={renderSettings.loudnorm && renderSettings.format !== 'gif' && !renderSettings.muted}
              disabled={renderSettings.format === 'gif' || renderSettings.muted}
              onChange={(e) => setRenderSettings({loudnorm: e.target.checked})}
            />
            响度归一化（-14 LUFS 投放标准）
          </label>
        </div>

        {/* 段级渲染缓存（局部重渲：改一段只重渲该段及邻段；GIF 不适用） */}
        <div className="option-card">
          <label
            className="checkbox-label"
            title={
              renderSettings.format === 'gif'
                ? 'GIF 格式不走分段缓存'
                : '3 段及以上的故事板按段分块渲染并缓存：改一段只重渲该段及邻段，其余段直接拼接，审片迭代大幅提速；分块失败自动回退整片渲染。GIF / WebM 不适用'
            }
          >
            <input
              type="checkbox"
              checked={renderSettings.segmentCache && renderSettings.format !== 'gif' && renderSettings.format !== 'webm'}
              disabled={renderSettings.format === 'gif' || renderSettings.format === 'webm'}
              onChange={(e) => setRenderSettings({segmentCache: e.target.checked})}
            />
            分段缓存（改一段只重渲该段）
          </label>
        </div>

            {/* 编码器预设 */}
            <div className="option-card">
              <div className="option-left">
                <span className="option-label">编码速度</span>
                <select
                  className="render-select"
                  value={renderSettings.x264Preset}
                  disabled={renderSettings.format !== 'mp4'}
                  onChange={(e) => setRenderSettings({x264Preset: e.target.value as RenderOptions['x264Preset']})}
                >
                  <option value="ultrafast">最快（低质量）</option>
                  <option value="superfast">超快</option>
                  <option value="veryfast">很快</option>
                  <option value="fast">快</option>
                  <option value="medium">中等（推荐）</option>
                  <option value="slow">慢（高质量）</option>
                  <option value="slower">很慢</option>
                </select>
              </div>
              <div className="option-right">
                <span className="option-label">编码器</span>
                <select
                  className="render-select"
                  value={renderSettings.encoder ?? 'auto'}
                  disabled={renderSettings.format !== 'mp4'}
                  onChange={(e) => setRenderSettings({encoder: e.target.value as RenderOptions['encoder']})}
                >
                  <option value="auto">自动（推荐）</option>
                  <option value="nvenc">NVIDIA NVENC</option>
                  <option value="qsv">Intel QSV</option>
                  <option value="software">软件 x264</option>
                </select>
              </div>
            </div>

            {/* 覆盖选项 */}
            <div className="option-card">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={renderSettings.overwrite}
                  onChange={(e) => setRenderSettings({overwrite: e.target.checked})}
                />
                覆盖同名文件
              </label>
            </div>
          </div>
        )}
      </div>

      {/* ====== 批量导出（与当前工程同方向的多比例队列） ====== */}
      <div className="batch-export">
        <h3><Layers size={15} /> 批量导出（多比例）</h3>
        <p className="batch-hint">
          勾选与当前工程同方向的比例，按队列逐比例导出；文件名自动带画幅后缀（如 片语-16x9.mp4），输出目录沿用上方设置。
        </p>
        <div className="batch-presets">
          {batchPresets.map((p) => (
            <label key={p.id} className={`batch-preset ${batchSelected.includes(p.id) ? 'active' : ''}`}>
              <input
                type="checkbox"
                checked={batchSelected.includes(p.id)}
                disabled={batchRunning}
                onChange={() => toggleBatchPreset(p.id)}
              />
              {p.label} {p.name}（{p.width}×{p.height}）
            </label>
          ))}
        </div>
        {batchJobs.length > 0 && (
          <div className="batch-jobs">
            {batchJobs.map((job) => (
              <div key={job.id} className={`batch-job batch-job-${job.status}`}>
                <span className="batch-job-name">{job.label}</span>
                <span className="batch-job-status">
                  {job.status === 'pending' && '等待'}
                  {job.status === 'rendering' && (
                    <><Loader2 size={12} className="icon-spin" /> 渲染中 {Math.round(job.progress)}%</>
                  )}
                  {job.status === 'done' && '完成'}
                  {job.status === 'failed' && `失败：${job.error}`}
                  {job.status === 'skipped' && '已跳过'}
                </span>
              </div>
            ))}
          </div>
        )}
        {hasTtsNarration && batchJobs.some((j) => j.status === 'done') && (
          <p className="batch-hint">
            本片含 AI 合成语音旁白：发布到各平台时，请按平台规则勾选 AI 生成内容声明。
          </p>
        )}
        {bgmCreditText && batchJobs.some((j) => j.status === 'done') && (
          <p className="batch-hint">
            本片配乐为 CC BY 4.0：片尾已自动附署名；发布时建议在描述区也带上：{bgmCreditText}
          </p>
        )}
        <div className="batch-actions">
          {batchRunning ? (
            <button className="btn-secondary" onClick={handleBatchCancel}>
              取消批量导出
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={isRendering || batchSelected.length === 0 || segments.length === 0}
              onClick={handleBatchStart}
            >
              <Play size={14} /> 开始批量导出{batchSelected.length > 0 ? `（${batchSelected.length} 个比例）` : ''}
            </button>
          )}
        </div>
      </div>

      {/* ====== 渲染进度（批量导出时不显示单次的进度区，避免两个取消入口） ====== */}
      {(isRendering || renderProgress > 0) && !batchRunning && (
        <div className="render-progress-area">
          <div className="progress-header">
            <span className="progress-status">
              {isRendering ? <><Loader2 size={14} className="icon-spin" /> 渲染中...</> : renderProgress >= 100 ? <><Check size={14} /> 完成{completedEncoder ? `（${encoderUsedLabels[completedEncoder]}）` : ''}</> : '已取消'}
            </span>
            <span className="progress-percent">{Math.round(renderProgress)}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{width: `${renderProgress}%`}} />
          </div>
          {isRendering && (
            <button className="btn-secondary btn-cancel-render" onClick={() => window.api.cancelRender()}>
              取消渲染
            </button>
          )}
          {isRendering && renderProgress > 0 && renderProgress < 100 && (
            <p className="progress-hint">
              {(() => {
                const elapsed = (Date.now() - startTimestamp) / 1000;
                const estimatedTotal = elapsed / (renderProgress / 100);
                const remaining = Math.max(0, Math.round(estimatedTotal - elapsed));
                if (remaining < 60) return `预计还需约 ${remaining} 秒...`;
                return `预计还需约 ${Math.ceil(remaining / 60)} 分钟...`;
              })()}
            </p>
          )}
          {renderOutputPath && (
            <button className="btn-link" onClick={handleOpenFile}>
              <FolderOpen size={14} /> 在文件夹中显示
            </button>
          )}
          {renderOutputPath && hasTtsNarration && (
            <p className="progress-hint">
              本片含 AI 合成语音旁白：发布到各平台时，请按平台规则勾选 AI 生成内容声明。
            </p>
          )}
          {renderOutputPath && bgmCreditText && (
            <p className="progress-hint">
              本片配乐为 CC BY 4.0：片尾已自动附署名；发布时建议在描述区也带上
              <code style={{userSelect: 'all', marginLeft: 4}}>{bgmCreditText}</code>
            </p>
          )}
        </div>
      )}

      {/* 错误/警告 */}
      {error && (
        <div className="render-error">
          <span><AlertTriangle size={14} /> {error}</span>
        </div>
      )}
      {warning && !error && (
        <div className="render-warning">
          <span><Folder size={14} /> {warning}</span>
        </div>
      )}

      {/* 底部操作 */}
      <div className="render-footer">
        <button className="btn-secondary" onClick={() => setStep(2)}>
          <ArrowLeft size={14} /> 返回编辑
        </button>
        <button className="btn-secondary" onClick={() => setShowPublishKit(true)} disabled={segments.length === 0}>
          <Image size={14} /> 封面与发布信息
        </button>
        <button
          className="btn-primary btn-render"
          disabled={isRendering || batchRunning || segments.length === 0}
          onClick={handleRender}
        >
          {isRendering ? '渲染中...' : <><Play size={14} /> 开始渲染</>}
        </button>
      </div>

      {/* 封面与发布信息弹窗 */}
      {showPublishKit && <PublishKitModal onClose={() => setShowPublishKit(false)} />}
    </div>
  );
};

export default RenderPanel;
