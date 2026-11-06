/**
 * LocalModelModal - 片语本地模型弹窗（付费版专属：8 元解锁，本地不限 token）
 *
 * 触发：①首次激活成功（LicenseModal onActivated）②付费版启动且未做过决策
 * （App.tsx 延迟弹，localStorage 记决策）③设置页 AI 区入口。
 *
 * 流程：打开即检测电脑状态（显卡显存 / 推理引擎 / 权重 / 磁盘，红绿灯）→
 * 已激活可一键下载（权重 4.3GB + 内置 llama.cpp 引擎，sha256 校验 + 进度条）；
 * 完成后自动拉起本地服务并把「设置 → AI 助手」接线到本地端点，零手动配置。
 * 未激活展示解锁引导（免费版可看不可下）。
 * 硬件门槛 8GB+ 显存不满足时下载按钮保留但红字警示（用户自担）。
 */

import React, {useEffect, useState} from 'react';
import {X, Cpu, HardDrive, Download, CheckCircle2, XCircle, Loader2, Sparkles, ShoppingCart, Box, PackageCheck} from 'lucide-react';
import {useProjectStore} from '../store/projectStore';
import {
  LOCAL_MODEL_BASE,
  LOCAL_MODEL_COMMERCIAL,
  LOCAL_MODEL_DECISION_KEY,
  LOCAL_MODEL_NAME,
  LOCAL_MODEL_PORT_BASE,
  LOCAL_MODEL_TOTAL_GB,
  diskVerdict,
  vramVerdict,
} from '../../shared/local-model';
import {PURCHASE_URL, openLink} from './LicenseModal';
import './LocalModelModal.css';

interface LocalModelModalProps {
  onClose: () => void;
  /** 设置页等主动入口打开时不写「不再提示」决策（用户自己找来的） */
  manual?: boolean;
}

type EnvState = import('../../main/services/localModel').LocalModelEnv | null;
type DlState = import('../../main/services/localModel').LocalModelDownloadState | null;

export const LocalModelModal: React.FC<LocalModelModalProps> = ({onClose, manual}) => {
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const [env, setEnv] = useState<EnvState>(null);
  const [detectError, setDetectError] = useState('');
  const [dl, setDl] = useState<DlState>(null);

  const isLicensed = licenseStatus?.entitlement === 'licensed';

  useEffect(() => {
    let alive = true;
    window.api.localModelDetect()
      .then((e) => {if (alive) setEnv(e);})
      .catch((err) => {if (alive) setDetectError(String(err));});
    void window.api.localModelDownloadState().then((s) => {if (alive && s.status !== 'idle') setDl(s);});
    const off = window.api.onLocalModelProgress((s) => setDl(s));
    return () => {alive = false; off();};
  }, []);

  const dismiss = (decision: string) => {
    if (!manual) {
      try {localStorage.setItem(LOCAL_MODEL_DECISION_KEY, decision);} catch {/* 隐私模式失败可忽略 */}
    }
    onClose();
  };

  const startDownload = async () => {
    setDl(await window.api.localModelDownloadStart());
    try {localStorage.setItem(LOCAL_MODEL_DECISION_KEY, 'downloaded');} catch {/* 同上 */}
  };

  const vram = env ? vramVerdict(env.maxVramMb) : null;
  const disk = env ? diskVerdict(env.freeDiskBytes) : null;
  const downloading = dl?.status === 'downloading' || dl?.status === 'verifying' || dl?.status === 'importing';
  const done = dl?.status === 'done';
  const ready = env?.runtimeRunning || (done && dl?.served);
  const endpoint = `http://127.0.0.1:${env?.runtimePort ?? LOCAL_MODEL_PORT_BASE}/v1`;
  const currentFileMb = dl ? (dl.currentBytes / 1024 / 1024).toFixed(0) : '0';
  const currentTotalMb = dl ? (Math.max(dl.currentTotal, 1) / 1024 / 1024).toFixed(0) : '0';
  const fileProgress = dl && dl.currentTotal > 0 ? Math.min(100, Math.round((dl.currentBytes / dl.currentTotal) * 100)) : 0;

  return (
    <div className="lmm-overlay" onClick={downloading ? undefined : onClose}>
      <div className="lmm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lmm-header">
          <div className="lmm-title"><Sparkles size={15} /><span>片语本地模型</span></div>
          <button className="lmm-close" onClick={() => dismiss(dl ? 'downloaded' : 'dismissed')} disabled={downloading}><X size={15} /></button>
        </div>

        <div className="lmm-body">
          {/* 模型介绍（与官网 models.html 同口径：全称 + 基座 + 微调说明） */}
          <div className="lmm-model-card">
            <div className="lmm-model-name">
              <PackageCheck size={15} />
              <span>片语剪辑模型</span>
              <code>{LOCAL_MODEL_NAME}</code>
            </div>
            <div className="lmm-model-desc">
              基于 <b>{LOCAL_MODEL_BASE}</b> 多模态基座专门训练微调的端侧模型——看得懂画面、
              会做剪辑决策，用片语自建的真实剪辑轨迹数据集蒸馏而来，专为片语工作流打造。
            </div>
          </div>

          {/* 商业口径 */}
          <div className="lmm-pitch">
            <div className="lmm-price">{LOCAL_MODEL_COMMERCIAL.priceNote} · {LOCAL_MODEL_COMMERCIAL.benefit}</div>
            <div className="lmm-hw">{LOCAL_MODEL_COMMERCIAL.hardwareNote}（下载约 {LOCAL_MODEL_TOTAL_GB}GB）</div>
          </div>

          {/* 已就绪态 */}
          {ready && (
            <div className="lmm-ready">
              <CheckCircle2 size={16} />
              <div>
                <div className="lmm-ready-title">本地模型已就绪（<code>{LOCAL_MODEL_NAME}</code>）</div>
                <div className="lmm-hint">AI 助手已自动连接本地服务（<code>{endpoint}</code>），无需手动配置；未生效时重启片语即可。</div>
              </div>
            </div>
          )}

          {/* 电脑状态检测 */}
          <div className="lmm-checks">
            <div className="lmm-checks-title">电脑状态检测</div>
            {detectError ? (
              <div className="lmm-check error"><XCircle size={14} /><span>检测失败：{detectError}</span></div>
            ) : !env ? (
              <div className="lmm-check"><Loader2 size={14} className="spin" /><span>正在检测显卡 / 磁盘 / 本地服务…</span></div>
            ) : (
              <>
                <div className={`lmm-check ${vram!.ok ? 'ok' : 'bad'}`}>
                  {vram!.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <Cpu size={13} />
                  <span className="lmm-check-label">显存 {vram!.label}</span>
                  <span className="lmm-check-detail">{env.gpus[0]?.name ?? '—'} · {vram!.detail}</span>
                </div>
                <div className={`lmm-check ${env.runtimeRunning ? 'ok' : env.runtimeInstalled ? 'ok' : 'warn'}`}>
                  {env.runtimeRunning || env.runtimeInstalled ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <Box size={13} />
                  <span className="lmm-check-label">推理引擎 {env.runtimeRunning ? '运行中' : env.runtimeInstalled ? `已内置${env.runtimeVersion ? `（${env.runtimeVersion}）` : ''}` : '未下载'}</span>
                  <span className="lmm-check-detail">
                    {env.runtimeRunning
                      ? `本地服务 ${endpoint}`
                      : env.runtimeInstalled
                        ? '权重下载完成后自动启动'
                        : <>无需安装任何第三方软件：下载流程会自动获取内置推理引擎（llama.cpp，约 0.4GB）</>}
                  </span>
                </div>
                <div className={`lmm-check ${env.weightsReady ? 'ok' : 'warn'}`}>
                  {env.weightsReady ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <PackageCheck size={13} />
                  <span className="lmm-check-label">模型权重 {env.weightsReady ? '已下载' : '未下载'}</span>
                  <span className="lmm-check-detail">{env.weightsReady ? `${LOCAL_MODEL_NAME}（约 ${LOCAL_MODEL_TOTAL_GB}GB，含视觉理解）` : `下载约 ${LOCAL_MODEL_TOTAL_GB}GB（断点续传，中断可续）`}</span>
                </div>
                <div className={`lmm-check ${disk!.ok ? 'ok' : 'bad'}`}>
                  {disk!.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <HardDrive size={13} />
                  <span className="lmm-check-label">磁盘 {disk!.label}</span>
                  <span className="lmm-check-detail">{disk!.detail}</span>
                </div>
              </>
            )}
          </div>

          {/* 下载进度 */}
          {dl && (downloading || done || dl.status === 'failed' || dl.status === 'cancelled') && (
            <div className="lmm-progress">
              {downloading && (
                <>
                  <div className="lmm-progress-label">
                    {dl.status === 'importing' ? (dl.currentFile ?? '准备中…')
                      : dl.status === 'verifying' ? `校验 ${dl.currentFile ?? ''} …`
                      : `下载 ${dl.currentFile ?? ''}（${currentFileMb} / ${currentTotalMb} MB）`}
                    <span className="lmm-progress-files">{dl.filesDone} / {dl.filesTotal} 项</span>
                  </div>
                  <div className="lmm-progress-bar"><i style={{width: `${dl.status === 'importing' ? 100 : fileProgress}%`}} /></div>
                  <button className="lmm-cancel" onClick={() => void window.api.localModelDownloadCancel()}>取消下载</button>
                </>
              )}
              {dl.status === 'failed' && (
                <div className="lmm-check bad"><XCircle size={14} /><span>下载失败：{dl.error ?? '未知错误'}。网络恢复后重试（已完成的文件会跳过）</span></div>
              )}
              {dl.status === 'cancelled' && (
                <div className="lmm-check warn"><XCircle size={14} /><span>已取消。可随时重新下载（已完成的文件会跳过）</span></div>
              )}
              {done && (
                <div className="lmm-done-note">
                  {dl.served
                    ? <>✓ 权重就绪、本地服务已启动，AI 助手已自动连接（<code>{endpoint}</code>）。直接开始对话即可本地出片。</>
                    : <>✓ 权重已下载到 <code>{dl.weightsDir}</code>。本地服务未能自动启动——重启片语会自动拉起；若仍未生效，在本地模型面板点「重新检查 / 补齐文件」。</>}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lmm-footer">
          {isLicensed ? (
            <>
              <span className="lmm-hint">
                {vram && !vram.ok ? '⚠️ 显存不满足 8GB 门槛，仍要下载请自行确认可用性' : '下载含断点幂等：中断后重试会跳过已完成文件'}
              </span>
              {!downloading && (
                <button className="lmm-primary" onClick={startDownload} disabled={!!detectError}>
                  <Download size={13} /> {done || ready || env?.weightsReady ? '重新检查 / 补齐文件' : `下载并启用（${LOCAL_MODEL_TOTAL_GB}GB）`}
                </button>
              )}
              {!downloading && !done && (
                <button className="lmm-secondary" onClick={() => dismiss('dismissed')}>暂不下载</button>
              )}
            </>
          ) : (
            <>
              {/* 2026-11-06 开源转型：不是「解锁软件」而是「下载专有模型」——明确给出自带模型的出路，
                  避免被当成假开源；价格口径统一走 LOCAL_MODEL_COMMERCIAL（¥6/月） */}
              <span className="lmm-hint">
                {LOCAL_MODEL_COMMERCIAL.priceNote}（{LOCAL_MODEL_COMMERCIAL.benefit}）。
                编辑器本身免费无限制；也可以不用我们的模型——设置里可接入自己的 Ollama / llama-server / OpenAI 兼容端点。
              </span>
              <button className="lmm-primary" onClick={() => openLink(PURCHASE_URL)}>
                <ShoppingCart size={13} /> 订阅 ¥6/月 获取模型
              </button>
              <button className="lmm-secondary" onClick={() => dismiss('dismissed')}>以后再说</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default LocalModelModal;
