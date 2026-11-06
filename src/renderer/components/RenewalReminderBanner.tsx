/**
 * RenewalReminderBanner — 授权到期续费提醒横幅
 *
 * 授权状态加载完成后评估一次（判定逻辑见 shared/license-renewal.ts）：
 * 已激活非终身授权且剩余 <= 7 天时，在应用顶部挂一条温和横幅（非模态，不遮挡工作）。
 * 频率控制：localStorage 记上次提醒时间，常规 24h 内最多一次；临期（<=1 天）每天必弹。
 */

import React, {useEffect, useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {PURCHASE_URL, openLink} from './LicenseModal';
import {
  RENEWAL_PROMPT_STORAGE_KEY,
  shouldShowRenewalReminder,
  formatRenewalDate,
} from '../../shared/license-renewal';
import {Clock} from 'lucide-react';
import './RenewalReminderBanner.css';

/** 读取上次提醒时间（epoch ms；缺失/非法按 null 处理） */
const readLastPromptAt = (): number | null => {
  try {
    const raw = localStorage.getItem(RENEWAL_PROMPT_STORAGE_KEY);
    const v = raw ? Number(raw) : 0;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

/** 记录本次提醒时间（频率控制依据；写失败不影响展示） */
const writeLastPromptAt = (now: number): void => {
  try {
    localStorage.setItem(RENEWAL_PROMPT_STORAGE_KEY, String(now));
  } catch {
    // 隐私模式等写失败：放弃频率控制，不阻断提示
  }
};

export const RenewalReminderBanner: React.FC = () => {
  const licenseStatus = useProjectStore((s) => s.licenseStatus);
  const [visible, setVisible] = useState(false);

  // licenseStatus 为 null = 尚未加载；加载完成（或激活/解绑后刷新）时重新评估。
  // 命中即记入提醒时间：即使本次未点按钮直接关窗，24h 内也不再打扰；
  // 不再命中（如刚续费/激活新码）则收起横幅。
  useEffect(() => {
    if (!licenseStatus) return;
    if (shouldShowRenewalReminder(licenseStatus, readLastPromptAt(), Date.now())) {
      writeLastPromptAt(Date.now());
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [licenseStatus]);

  if (!visible || !licenseStatus || licenseStatus.daysLeft == null || !licenseStatus.expiresAt) {
    return null;
  }

  const message =
    licenseStatus.daysLeft <= 0
      ? `授权将于今天到期（${formatRenewalDate(licenseStatus.expiresAt)}），续费后授权自动延续`
      : `授权将于 ${licenseStatus.daysLeft} 天后到期（${formatRenewalDate(licenseStatus.expiresAt)}），续费后授权自动延续`;

  const handleRenew = () => {
    openLink(PURCHASE_URL);
    setVisible(false);
  };

  return (
    <div className="renewal-reminder-banner" role="status">
      <Clock size={14} className="renewal-reminder-icon" />
      <span className="renewal-reminder-text">{message}</span>
      <button type="button" className="renewal-reminder-btn-primary" onClick={handleRenew}>
        前往续费
      </button>
      <button type="button" className="renewal-reminder-btn-dismiss" onClick={() => setVisible(false)}>
        我知道了
      </button>
    </div>
  );
};

export default RenewalReminderBanner;
