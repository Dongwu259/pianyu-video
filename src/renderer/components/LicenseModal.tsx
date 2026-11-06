/**
 * LicenseModal — 授权管理弹窗
 * 展示授权状态（套餐/到期/剩余天数/离线宽限/机器数），支持激活授权码与解绑设备
 */

import React, {useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {KeyRound, X, Loader2, ShieldCheck, ShoppingCart} from 'lucide-react';
import './LicenseModal.css';

interface LicenseModalProps {
  onClose: () => void;
  /** 激活成功回调（首次激活弹「是否下载本地模型权重」） */
  onActivated?: () => void;
}

/** 官网价格区（购买授权入口，含各套餐直达下单链接）；续费提醒横幅复用同一地址 */
export const PURCHASE_URL = 'https://studio.dwphoto.top/videotool/#pricing';

/** 打开外部链接：优先走 preload 暴露的 shell.openExternal 封装 */
export const openLink = (url: string) => {
  if (!url) return;
  if (window.api?.openExternal) {
    void window.api.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
};

/** 套餐标识 → 中文名 */
const PLAN_LABELS: Record<string, string> = {
  monthly: '月度订阅',
  yearly: '年度订阅',
  lifetime: '终身授权',
  trial: '试用版',
};

/** epoch ms → YYYY-MM-DD */
const formatDate = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * 激活码输入清洗：容错的粘贴/手输口径——全角与异形连字符统一为 -、去空格与杂字符、
 * 大写化；无连字符的 16 位连续码自动按 4 位补连字符（与服务器存储格式一致）。
 */
export const normalizeCodeInput = (raw: string): string => {
  let s = raw
    .toUpperCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[—–−ー﹣]/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!s.includes('-') && /^[A-Z0-9]{16}$/.test(s)) {
    s = s.replace(/(.{4})(?=.)/g, '$1-');
  }
  return s;
};

export const LicenseModal: React.FC<LicenseModalProps> = ({onClose, onActivated}) => {
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const refreshLicenseStatus = useProjectStore((s) => s.refreshLicenseStatus);

  const [code, setCode] = useState('');
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isLicensed = licenseStatus?.entitlement === 'licensed';

  const handleActivate = async () => {
    const trimmed = normalizeCodeInput(code);
    if (!trimmed || activating) return;
    setError('');
    setNotice('');
    setActivating(true);
    try {
      const result = await window.api.activateLicense(trimmed);
      if (result.success) {
        setCode('');
        setNotice('激活成功，感谢您的支持！');
        await refreshLicenseStatus();
        onActivated?.();
      } else {
        setError(result.message || '激活失败，请稍后重试');
      }
    } catch {
      setError('激活请求失败，请检查网络后重试');
    } finally {
      setActivating(false);
    }
  };

  const handleDeactivate = async () => {
    if (!window.confirm('确定要解绑当前设备吗？解绑后本机将恢复为免费版。')) return;
    setError('');
    setNotice('');
    try {
      await window.api.deactivateLicense();
      setNotice('已解绑当前设备');
      await refreshLicenseStatus();
    } catch {
      setError('解绑失败，请稍后重试');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content license-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>

        <h2 className="license-title"><KeyRound size={18} /> 授权</h2>

        {/* ====== 当前状态 ====== */}
        {isLicensed && licenseStatus ? (
          <div className="license-status-card is-licensed">
            <div className="license-status-head">
              <ShieldCheck size={16} />
              <span>{PLAN_LABELS[licenseStatus.plan || ''] || licenseStatus.plan}</span>
            </div>
            <div className="license-status-rows">
              {licenseStatus.code && (
                <div className="license-row">
                  <span className="license-label">授权码</span>
                  <span className="license-value license-code">{licenseStatus.code}</span>
                </div>
              )}
              {licenseStatus.expiresAt && (
                <div className="license-row">
                  <span className="license-label">到期日期</span>
                  <span className="license-value">{formatDate(licenseStatus.expiresAt)}</span>
                </div>
              )}
              {licenseStatus.daysLeft != null && (
                <div className="license-row">
                  <span className="license-label">剩余天数</span>
                  <span className="license-value">{licenseStatus.daysLeft} 天</span>
                </div>
              )}
              {licenseStatus.offlineDaysLeft != null && (
                <div className="license-row">
                  <span className="license-label">离线可用</span>
                  <span className="license-value">剩余 {licenseStatus.offlineDaysLeft} 天</span>
                </div>
              )}
              {licenseStatus.machinesUsed != null && (
                <div className="license-row">
                  <span className="license-label">已激活设备</span>
                  <span className="license-value">
                    {licenseStatus.machinesUsed}
                    {licenseStatus.maxMachines != null ? ` / ${licenseStatus.maxMachines} 台` : ' 台'}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="license-status-card">
            <div className="license-status-head is-free">
              <span>未激活 · 当前为免费版</span>
            </div>
            <p className="license-free-hint">导出视频将带有水印且分辨率受限，激活授权码后可去除。</p>
          </div>
        )}

        {/* ====== 激活表单 ====== */}
        {!isLicensed && (
          <>
            <div className="license-activate-form">
              <input
                type="text"
                className="license-input"
                placeholder="请输入授权码（XXXX-XXXX-XXXX-XXXX）"
                value={code}
                onChange={(e) => setCode(normalizeCodeInput(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                disabled={activating}
                spellCheck={false}
              />
              <button
                className="license-btn-primary"
                onClick={handleActivate}
                disabled={activating || !code.trim()}
              >
                {activating ? <><Loader2 size={14} className="icon-spin" /> 激活中...</> : '激活'}
              </button>
            </div>
            <div className="license-purchase">
              <button
                type="button"
                className="license-btn-purchase"
                onClick={() => openLink(PURCHASE_URL)}
              >
                <ShoppingCart size={14} /> 购买授权
              </button>
              <p className="license-purchase-hint">
                付款后约 1 分钟，激活码自动发送到您的爱发电私信；订阅续费自动延期，无需换码。
              </p>
            </div>
          </>
        )}

        {/* 错误 / 提示 */}
        {error && <p className="license-error">{error}</p>}
        {notice && !error && <p className="license-notice">{notice}</p>}

        {/* ====== 解绑 ====== */}
        {isLicensed && (
          <div className="license-footer">
            <button className="license-btn-danger" onClick={handleDeactivate}>解绑当前设备</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default LicenseModal;
