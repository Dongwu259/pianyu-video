/**
 * 授权/订阅服务（主进程）
 *
 * 授权码模式：
 * - activateLicense: 授权码 + 设备指纹换取 token，token 用 safeStorage 加密落盘
 * - verifyIfNeeded: 距上次校验超过 7 天时联网复核（服务器滑动续期，返回新 token 需持久化）；
 *   网络失败按「离线」处理，保留当前状态
 * - getEntitlement: token 在、未过期、且离线未超过 30 天宽限期 → 'licensed'，否则 'free'
 * - 授权只用于「专有资产」：模型权重下载 / 模板包。编辑器本体不设限制
 *   （2026-11-06 开源转型后 EDITOR_UNRESTRICTED=true，水印与 720p 钳制已停用，见 shared/editor-policy.ts）
 *
 * 服务器接口契约见 server/src/routes/license.ts。
 */

import crypto from 'crypto';
import os from 'os';
import {execFile, execFileSync} from 'child_process';
import {promisify} from 'util';
import {app, safeStorage} from 'electron';
import {getGlobalSettings, getLicense, setLicense, getMachineId, setMachineId, getLicenseHighWater, setLicenseHighWater} from './store';
import type {StoredLicense} from './store';
import type {LicenseActivateResult, LicenseEntitlement, LicenseStatus} from '../../shared/types';

// 内置默认授权服务器地址：官网与授权 API 共用 /videotool 前缀，
// nginx 剥掉前缀后反代到 127.0.0.1:8787，客户端无需感知
const DEFAULT_LICENSE_SERVER_URL = 'https://studio.dwphoto.top/videotool';

// ====== 授权响应验签（Ed25519）======
// 服务端对 activate/verify 响应的 {code, plan, expiresAt, machineId} 签名（见 server/src/sign.ts）。
// 本地授权记录是明文 JSON，不验签则用户手改 expiresAt 即永久授权；验签失败 = 本地记录被篡改。
// 公钥由 server/scripts/generate-signing-key.mjs 生成并嵌入；私钥只存在于服务器 .env。
// 重新生成密钥对会使全部已发布客户端验签失败（本地记录强制联网复核），非泄漏勿换。
const LICENSE_SIGN_PUBLIC_KEY = 'MCowBQYDK2VwAyEAjshS1VGyX9E1ZWoREaXkOtjQv0w726wsZ64T2JuNZ3Q=';

let cachedSignPubKey: crypto.KeyObject | null = null;
const getSignPublicKey = (): crypto.KeyObject => {
  if (!cachedSignPubKey) {
    cachedSignPubKey = crypto.createPublicKey({
      key: Buffer.from(LICENSE_SIGN_PUBLIC_KEY, 'base64'),
      type: 'spki',
      format: 'der',
    });
  }
  return cachedSignPubKey;
};

/** 签名负载规范形式，必须与 server/src/sign.ts 的 canonicalLicensePayload 完全一致 */
const canonicalLicensePayload = (code: string, plan: string, expiresAt: number, machineId: string): string =>
  `vt1.${code}.${plan}.${expiresAt}.${machineId}`;

/** 验签授权记录的关键字段；signature 缺失/非法/字段被篡改均返回 false */
const verifyLicenseSignature = (lic: {code: string; plan: string; expiresAt: number; machineId: string; signature?: string}): boolean => {
  if (!lic.signature) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalLicensePayload(lic.code, lic.plan, lic.expiresAt, lic.machineId), 'utf8'),
      getSignPublicKey(),
      Buffer.from(lic.signature, 'base64')
    );
  } catch {
    return false;
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** 距上次服务器校验超过该间隔则重新校验（滑动续期） */
const VERIFY_INTERVAL_MS = 7 * DAY_MS;
/** 离线宽限期：30 天内未能联网校验仍维持已授权权益 */
const OFFLINE_GRACE_MS = 30 * DAY_MS;
/** 服务器请求超时 */
const REQUEST_TIMEOUT_MS = 8000;

/** 服务器明确判定授权失效的 reason（收到后本地降级为免费版） */
const INVALID_REASONS = ['REVOKED', 'EXPIRED', 'NOT_ACTIVATED', 'MACHINE_MISMATCH', 'INVALID_TOKEN'];

/** 授权服务器 base URL：开发环境可用设置页的高级配置联调；生产环境强制内置地址（防伪造服务端）。
 *  崩溃上报（services/crashReporter.ts）复用同一解析，不另开端点绕过口 */
export const getServerBaseUrl = (): string => {
  if (!app.isPackaged) {
    const fromSettings = getGlobalSettings().licenseServerUrl?.trim();
    if (fromSettings) return fromSettings.replace(/\/+$/, '');
  }
  return DEFAULT_LICENSE_SERVER_URL;
};

/** POST JSON，带超时控制；网络层异常抛给调用方按「离线」处理 */
const postJson = async (path: string, body: object): Promise<{status: number; data: any}> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${getServerBaseUrl()}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return {status: res.status, data};
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 读取 Windows MachineGuid（OS 装机时生成，重装本软件不变、不随网卡变化）。
 * 作为设备指纹主源，比 MAC 稳定得多；读失败返回 null 走 MAC 兜底。
 */
const readWindowsMachineGuid = (): string | null => {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
};

/** MachineGuid 不可用时，从主网卡 MAC + 主机名派生指纹（兜底，含原逻辑） */
const deriveFromMac = (): string => {
  let mac = '';
  for (const list of Object.values(os.networkInterfaces())) {
    const hit = (list || []).find((n) => !n.internal && n.mac && n.mac !== '00:00:00:00:00:00');
    if (hit?.mac) {
      mac = hit.mac;
      break;
    }
  }
  if (mac) {
    return crypto.createHash('sha256').update(`${mac}|${os.hostname()}`).digest('hex').slice(0, 32);
  }
  // 极少数环境拿不到 MAC（如精简虚拟机）：退化为随机 UUID，必须持久化保持稳定
  return crypto.randomUUID().replace(/-/g, '');
};

/**
 * 获取（或首次生成）设备指纹：
 * 优先用已持久化的值；否则 Windows 取 MachineGuid、其余平台取 MAC+hostname，
 * SHA-256 截 32 位。MachineGuid 比网卡 MAC 稳定（换网卡/装虚拟网卡不变），卸载本软件
 * 也不变，故重装后重新派生得到同一指纹，服务端认作同一台机。预发布无存量用户，无需迁移。
 */
export const getOrCreateMachineId = (): string => {
  const saved = getMachineId();
  if (saved) return saved;

  const guid = readWindowsMachineGuid();
  const id = guid
    ? crypto.createHash('sha256').update(`guid:${guid}`).digest('hex').slice(0, 32)
    : deriveFromMac();
  setMachineId(id);
  return id;
};

// ===== 持久凭证（重装恢复，仅 Windows）=====
// 激活成功后把整份授权记录用 safeStorage（Windows 下为 DPAPI，绑定「本机+本 Windows
// 用户」）加密，写入注册表 HKCU\Software\PromoVideoGenerator。userData 被手动删除或
// 重装本软件时，同机同用户下 DPAPI 仍可解密，启动时优先恢复，免去重新输入激活码。
// DPAPI 密钥本机绑定，凭证复制到别的机器/别的用户均解不开；再叠加服务端 machine_id
// 校验（MACHINE_MISMATCH），不破坏「一码一机」。任一环节失败均静默降级到 userData 副本。
const DURABLE_REG_KEY = 'HKCU\\Software\\PromoVideoGenerator';
const DURABLE_REG_VALUE = 'License';

const execFileAsync = promisify(execFile);

// 注意：reg.exe 失败时会把 GBK 编码的中文错误写进 stderr（默认 inherit 会直接污染
// 控制台，且启动期的同步查询会卡住主进程）——读改异步 + 写/删显式 pipe 吞掉 stderr。
const regRead = async (value: string): Promise<string | null> => {
  if (process.platform !== 'win32') return null;
  try {
    const {stdout} = await execFileAsync('reg', ['query', DURABLE_REG_KEY, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const m = stdout.match(new RegExp(`${value}\\s+REG_SZ\\s+(.+)`));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
};

const regWrite = (value: string, data: string): void => {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('reg', ['add', DURABLE_REG_KEY, '/v', value, '/t', 'REG_SZ', '/d', data, '/f'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // 写失败不影响主流程：userData 副本仍在，只是丢失重装恢复能力
  }
};

const regDeleteValue = (): void => {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('reg', ['delete', DURABLE_REG_KEY, '/v', DURABLE_REG_VALUE, '/f'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // 键值不存在或删除失败均忽略
  }
};

/** base64 -> base64url（去掉 +/ 与 =，避免 reg 命令行把 / 当开关解析） */
const toBase64Url = (b64: string): string => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (s: string): string => {
  const pad = (4 - (s.length % 4)) % 4;
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
};

/** 写持久凭证：把整份 StoredLicense 加密后落注册表（无 token 则不写） */
const writeDurableCredential = (lic: StoredLicense): void => {
  if (!lic.tokenEncrypted) return;
  try {
    const json = JSON.stringify(lic);
    const enc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64');
    regWrite(DURABLE_REG_VALUE, toBase64Url(enc));
  } catch {
    // 忽略
  }
};

/** 读持久凭证：解密还原 StoredLicense；不存在/解密失败/不合法均返回 null */
const readDurableCredential = async (): Promise<StoredLicense | null> => {
  const raw = await regRead(DURABLE_REG_VALUE);
  if (!raw) return null;
  try {
    const enc = Buffer.from(fromBase64Url(raw), 'base64');
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(enc) : enc.toString('utf8');
    const lic = JSON.parse(json) as StoredLicense;
    if (typeof lic.code === 'string' && typeof lic.tokenEncrypted === 'string' && lic.tokenEncrypted) {
      return lic;
    }
    return null;
  } catch {
    return null;
  }
};

const clearDurableCredential = (): void => regDeleteValue();

/**
 * 启动时恢复：userData 没有 license 时，尝试从注册表持久凭证解密恢复。
 * 同机重装（Windows 用户不变）可免重输码；恢复后交由 verifyIfNeeded 联网复核。
 * 必须在 verifyIfNeeded 之前调用一次。
 */
export const restoreLicenseIfMissing = async (): Promise<void> => {
  if (getLicense()) return;
  const lic = await readDurableCredential();
  if (lic) {
    setLicense(lic);
    setMachineId(lic.machineId);
  }
};

/** safeStorage 加密 token；不可用时退化为 base64 明文（见 decryptToken 注释） */
const encryptToken = (token: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(token).toString('base64');
  }
  // 个别 Linux 桌面缺少 keyring 时 safeStorage 不可用，只能明文（base64）存储
  return Buffer.from(token, 'utf8').toString('base64');
};

const decryptToken = (tokenEncrypted: string): string => {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(tokenEncrypted, 'base64'));
  }
  // 与 encryptToken 的明文退化分支对应
  return Buffer.from(tokenEncrypted, 'base64').toString('utf8');
};

/** 授权码掩码：XXXX-****-****-XXXX（仅保留首尾各一段供用户辨认） */
const maskCode = (code: string): string => {
  const segments = code.split('-');
  if (segments.length === 4) {
    return `${segments[0]}-****-****-${segments[3]}`;
  }
  // 非标准格式兜底：保留首尾各 4 个字符
  return code.length > 8 ? `${code.slice(0, 4)}****${code.slice(-4)}` : code;
};

/** 激活：POST /api/license/activate，成功后加密持久化 token */
export const activateLicense = async (code: string): Promise<LicenseActivateResult> => {
  const trimmed = (code || '').trim().toUpperCase();
  if (!trimmed) {
    return {success: false, error: 'BAD_REQUEST', message: '请输入授权码'};
  }

  const machineId = getOrCreateMachineId();
  const machineName = os.hostname();

  let res: {status: number; data: any};
  try {
    res = await postJson('/api/license/activate', {code: trimmed, machineId, machineName});
  } catch {
    return {success: false, error: 'NETWORK', message: '无法连接授权服务器，请检查网络后重试'};
  }

  if (res.status !== 200) {
    return {
      success: false,
      error: res.data?.error || 'UNKNOWN',
      message: res.data?.message || '激活失败，请稍后重试',
    };
  }

  const {token, plan, expiresAt, machinesUsed, maxMachines, signature} = res.data;
  // 验签服务端响应：生产环境下无有效签名 = 响应被篡改/服务端配置缺失，拒绝采信
  const sigValid = verifyLicenseSignature({code: trimmed, plan, expiresAt, machineId, signature});
  if (!sigValid && app.isPackaged) {
    return {success: false, error: 'SIGNATURE', message: '授权服务器响应校验失败，请稍后重试或联系客服'};
  }
  if (!sigValid) {
    console.warn('[License] 激活响应无有效签名（开发模式容忍，生产将拒绝）');
  }
  const stored: StoredLicense = {
    code: trimmed,
    tokenEncrypted: encryptToken(token),
    plan,
    expiresAt,
    lastVerifiedAt: Date.now(),
    machineId,
    machineName,
    machinesUsed,
    maxMachines: typeof maxMachines === 'number' ? maxMachines : undefined,
    signature: typeof signature === 'string' && signature ? signature : undefined,
  };
  setLicense(stored);
  writeDurableCredential(stored); // 写持久凭证：同机重装可免重输码
  return {success: true, plan, expiresAt};
};

/**
 * 按需校验：距上次校验超过 7 天才发起请求。
 * - 网络失败/超时 → 视为离线，保留当前状态（离线宽限由 getEntitlement 判定）
 * - valid:true → 持久化滑动续期的新 token 与最新 plan/expiresAt
 * - valid:false 且为确定性失效原因 → 清空 token（保留授权码等记录），权益降级为免费版
 */
export const verifyIfNeeded = async (): Promise<void> => {
  const lic = getLicense();
  if (!lic?.tokenEncrypted) return;
  const now = Date.now();
  // 本地记录验签失败（被篡改或从旧版升级缺签名）时跳过间隔限制，立即联网复核：
  // 服务端按数据库真实值重新签发，合法用户自愈，篡改者拿到的还是真实（过期）值
  if (now - lic.lastVerifiedAt <= VERIFY_INTERVAL_MS && verifyLicenseSignature(lic)) return;

  let res: {status: number; data: any};
  try {
    res = await postJson('/api/license/verify', {token: decryptToken(lic.tokenEncrypted), machineId: lic.machineId});
  } catch {
    // 离线：不做任何变更，等待下次校验
    return;
  }

  if (res.data?.valid === true) {
    // 验签响应：被篡改的响应不采信（生产拒绝；开发容忍但记日志）
    const sigOk = verifyLicenseSignature({
      code: lic.code,
      plan: res.data.plan,
      expiresAt: res.data.expiresAt,
      machineId: lic.machineId,
      signature: res.data.signature,
    });
    if (!sigOk && app.isPackaged) return;
    if (!sigOk) console.warn('[License] 校验响应无有效签名（开发模式容忍，生产将拒绝）');
    const updated: StoredLicense = {
      ...lic,
      tokenEncrypted: encryptToken(res.data.token),
      plan: res.data.plan,
      expiresAt: res.data.expiresAt,
      // 滑动续期同步最新机器占用数与机位上限（老服务端缺省则保留本地原值）
      machinesUsed: typeof res.data.machinesUsed === 'number' ? res.data.machinesUsed : lic.machinesUsed,
      maxMachines: typeof res.data.maxMachines === 'number' ? res.data.maxMachines : lic.maxMachines,
      lastVerifiedAt: now,
      signature: typeof res.data.signature === 'string' && res.data.signature ? res.data.signature : lic.signature,
    };
    setLicense(updated);
    writeDurableCredential(updated); // 同步刷新持久凭证
    return;
  }

  if (INVALID_REASONS.includes(res.data?.reason)) {
    setLicense({...lic, tokenEncrypted: '', lastVerifiedAt: now});
    clearDurableCredential(); // 确定性失效：清除持久凭证，避免重装后恢复已失效的授权
  }
};

/** 解绑：尽力通知服务器释放机器位（失败不阻塞），随后清除本地授权记录 */
export const deactivateLicense = async (): Promise<{success: boolean; message?: string}> => {
  const lic = getLicense();
  if (lic?.tokenEncrypted) {
    try {
      await postJson('/api/license/deactivate', {token: decryptToken(lic.tokenEncrypted), machineId: lic.machineId});
    } catch {
      // 离线解绑：仅清除本地记录
    }
  }
  clearDurableCredential(); // 解绑：清除持久凭证，本机不再自动恢复
  setLicense(null);
  return {success: true};
};

/**
 * 当前权益等级：
 * token 存在 且 未过期 且 距上次校验未超 30 天离线宽限期 → 'licensed'，否则 'free'。
 * 时间比较一律走「单调高水位」（见过的最大 Date.now()，持久化）而非裸系统时间：
 * 回拨系统时钟不能让 now 变小，月卡无法借回拨 + 断网变永久。
 * 生产环境额外要求：本地记录通过服务端公钥验签（防记事本篡改），且 lastVerifiedAt
 * 不得显著「在未来」（防伪造离线宽限起点）。
 */
export const getEntitlement = (): LicenseEntitlement => {
  const lic = getLicense();
  const realNow = Date.now();
  // 单调时间高水位：记录见过的最大时间值。回拨时钟后 realNow < 高水位，
  // 后续比较全部用高水位，回拨立即失效（高水位本身被改小只会让权益更早失效）
  const prevHighWater = getLicenseHighWater();
  const now = Math.max(prevHighWater, realNow);
  if (now !== prevHighWater) setLicenseHighWater(now);

  if (!lic?.tokenEncrypted) return 'free';
  if (lic.expiresAt <= now) return 'free';
  if (lic.lastVerifiedAt + OFFLINE_GRACE_MS <= now) return 'free';
  // 生产环境：本地记录验签失败 = 被篡改（或旧版升级缺签名，待联网复核自愈）
  if (app.isPackaged && !verifyLicenseSignature(lic)) return 'free';
  // lastVerifiedAt 在未来 = 伪造离线宽限（5 分钟容差覆盖时钟抖动）
  if (lic.lastVerifiedAt > now + 5 * 60 * 1000) return 'free';
  return 'licensed';
};

/** 供 UI 展示的授权状态 */
export const getLicenseStatus = (): LicenseStatus => {
  const entitlement = getEntitlement();
  const lic = getLicense();
  if (!lic) {
    return {entitlement, plan: null, expiresAt: null, daysLeft: null, offlineDaysLeft: null, machinesUsed: null, maxMachines: null, code: null};
  }
  // 与 getEntitlement 同一时间基准（高水位防回拨），展示与判定一致
  const now = Math.max(getLicenseHighWater(), Date.now());
  return {
    entitlement,
    plan: lic.plan,
    expiresAt: lic.expiresAt,
    daysLeft: Math.max(0, Math.ceil((lic.expiresAt - now) / DAY_MS)),
    offlineDaysLeft: Math.max(0, Math.ceil((lic.lastVerifiedAt + OFFLINE_GRACE_MS - now) / DAY_MS)),
    machinesUsed: lic.machinesUsed ?? null,
    maxMachines: lic.maxMachines ?? null,
    code: lic.code ? maskCode(lic.code) : null,
  };
};

/** 模型下载 gating：用持久凭证里的完整激活码换取带 token 的下载 URL（付费 plan 门在服务端） */
export const fetchModelDlUrls = async (): Promise<Record<string, string> | null> => {
  try {
    const lic = await readDurableCredential();
    if (!lic?.code) return null;
    const resp = await fetch(`${DEFAULT_LICENSE_SERVER_URL}/api/modeldl/unlock`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({code: lic.code, machineId: lic.machineId}),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {ok?: boolean; files?: {name: string; url: string}[]};
    if (!data.ok || !data.files) return null;
    // 服务端返回的是挂载点内相对路径（/downloads/models/xxx?code=&token=），
    // 必须补上服务器基地址——https.get 收到相对路径会直接 Invalid URL（2026-10-08 RC 体检抓到的 P0）
    const urls: Record<string, string> = {};
    for (const f of data.files) {
      urls[f.name] = /^https?:\/\//.test(f.url) ? f.url : `${getServerBaseUrl()}${f.url}`;
    }
    return urls;
  } catch (err) {
    console.warn('[license] fetchModelDlUrls 失败（退直链）:', err instanceof Error ? err.message : err);
    return null;
  }
};
