/**
 * 授权到期续费提醒的判定逻辑（纯函数，无依赖，便于单测）
 *
 * 渲染端用法见 renderer/components/RenewalReminderBanner.tsx：
 * 授权状态加载完成后评估一次，命中则在应用顶部挂温和横幅（不遮挡工作）。
 */

/** 提醒阈值：剩余天数 <= 该值才提醒 */
export const RENEWAL_REMINDER_DAYS = 7;

/** 常规提醒最小间隔（24h）；临期（daysLeft <= 1）不受此限，每个自然日必提醒 */
export const RENEWAL_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** localStorage 键：上次提醒时间（epoch ms） */
export const RENEWAL_PROMPT_STORAGE_KEY = 'licenseRenewalPromptAt';

/** 判定所需的授权状态子集（与 LicenseStatus 结构兼容） */
export interface RenewalReminderStatus {
  entitlement: string;   // 'licensed' | 'free'
  plan: string | null;   // monthly / yearly / lifetime
  daysLeft: number | null;
}

/**
 * 是否满足提醒的授权条件：
 * 已激活（非 free）、非终身授权、且剩余天数已进入提醒窗口。
 * 未激活（free）走免费版自己的 UI，终身授权无到期概念，均不提醒。
 */
export const isRenewalDue = (status: RenewalReminderStatus | null | undefined): boolean => {
  if (!status) return false;
  if (status.entitlement === 'free') return false;
  if (status.plan === 'lifetime') return false;
  return status.daysLeft != null && status.daysLeft <= RENEWAL_REMINDER_DAYS;
};

/** 两个时间戳是否同一自然日（本地时区） */
export const isSameLocalDay = (a: number, b: number): boolean => {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
};

/**
 * 是否应弹出续费提醒：
 * - 常规（2 <= daysLeft <= 7）：距上次提醒 >= 24h 才再弹
 * - 临期（daysLeft <= 1）：不受 24h 限制，但同一自然日只弹一次（每天必弹）
 */
export const shouldShowRenewalReminder = (
  status: RenewalReminderStatus | null | undefined,
  lastPromptAt: number | null,
  now: number,
): boolean => {
  if (!isRenewalDue(status)) return false;
  if (!lastPromptAt || lastPromptAt <= 0) return true;
  if ((status as RenewalReminderStatus).daysLeft! <= 1) {
    return !isSameLocalDay(lastPromptAt, now);
  }
  return now - lastPromptAt >= RENEWAL_REMINDER_INTERVAL_MS;
};

/** epoch ms → YYYY-MM-DD（与 LicenseModal 的 formatDate 一致） */
export const formatRenewalDate = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
