/**
 * MCP 一键接入 - 把片语的接入配置直接写入本机已装 agent 的配置文件。
 *
 * 本模块是**纯 Node 实现，绝不 import electron**（要能被 tsx 单测直接加载）；
 * home 目录由调用方注入（生产为 app.getPath('home')），electron 胶水见 main/ipc/mcp.ts。
 *
 * 各 agent 的配置位置与条目格式（2026-08 按官方文档核实）：
 * - Kimi Code CLI：~/.kimi-code/mcp.json（JSON）；HTTP 条目 = {url, headers}。
 * - Claude Code：~/.claude.json（JSON，核心大配置，写前必须备份）；
 *   HTTP 条目 = {type:'http', url, headers}。
 * - OpenAI Codex CLI：~/.codex/config.toml（TOML）；节 = [mcp_servers.pianyu]（注意
 *   是 mcp_servers 下划线），HTTP 用 url + http_headers 内联表。
 * - OpenClaw：~/.openclaw/openclaw.json（JSON5，允许注释/尾逗号；读取做宽松解析，
 *   写出严格 JSON——严格 JSON 本身就是合法 JSON5）；条目在 mcp.servers.pianyu 嵌套键。
 * - ZCode CLI：~/.zcode/cli/config.json（严格 JSON，**未知键会静默丢弃 server**，
 *   条目只放 type/url/enabled 等规范键）；条目在 mcp.servers.pianyu。
 * - DeepSeek Harness（dsh）：~/.dsh/cordis.patch.yml（YAML patch 层）；MCP server
 *   是一行 `- insert:` 装载 @deepseek-ai/dsh-mcp-client 插件、config.serverName=pianyu。
 *
 * 写入策略（全部格式统一）：读 → 校验（损坏抛中文错误且不改动）→ 备份（已有备份
 * 不覆盖）→ 合并 pianyu 条目（文本格式用行级外科手术编辑，其余内容逐字节保留）→
 * 原子写（tmp + rename）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {McpAgentId, McpAgentInfo, McpAgentInstallResult} from '../../shared/mcp';

/** pianyu 条目里 url 的形态：本机回环 + /mcp 端点（listAgents 据此判定「已接入」） */
const PIANYU_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp$/;

/** json 类 agent 的条目形状判定：url 指向本机 /mcp 且带 Bearer 头 */
const isPianyuEntry = (entry: unknown): boolean => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.url !== 'string' || !PIANYU_URL_RE.test(e.url)) return false;
  const headers = e.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
  const auth = (headers as Record<string, unknown>).Authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ');
};

// ====== JSON / JSON5 读取 ======

/** 字符串感知的 JSON5 宽松解析：剥 // 与 /* *\/ 注释、去尾逗号（字符串内容原样保留） */
const parseJsonLenient = (raw: string): unknown => {
  let out = '';
  let i = 0;
  let inStr: string | null = null;
  while (i < raw.length) {
    const c = raw[i];
    const n = raw[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === ',') {
      // 向后看（跳过空白与注释）：下一个有效字符是 } 或 ] 则丢弃该尾逗号
      let j = i + 1;
      let drop = false;
      while (j < raw.length) {
        if (/\s/.test(raw[j])) {
          j++;
          continue;
        }
        if (raw[j] === '/' && raw[j + 1] === '/') {
          while (j < raw.length && raw[j] !== '\n') j++;
          continue;
        }
        if (raw[j] === '/' && raw[j + 1] === '*') {
          j += 2;
          while (j < raw.length && !(raw[j] === '*' && raw[j + 1] === '/')) j++;
          j += 2;
          continue;
        }
        drop = raw[j] === '}' || raw[j] === ']';
        break;
      }
      if (!drop) out += ',';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
};

/** 读 JSON 配置；文件不存在返回 {}（fresh install）；json5=true 时先严格解析、失败退宽松解析 */
const readJsonConfig = (configPath: string, json5: boolean): Record<string, unknown> => {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf8');
  try {
    return parseJsonOrThrow(raw, configPath);
  } catch (err) {
    if (!json5) throw err;
    try {
      return asObject(parseJsonLenient(raw), configPath);
    } catch {
      throw new Error(`配置文件 JSON/JSON5 解析失败，未改动，请手动修复：${configPath}`);
    }
  }
};

const parseJsonOrThrow = (raw: string, configPath: string): Record<string, unknown> => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`配置文件 JSON 损坏，未改动，请手动修复：${configPath}`);
  }
  return asObject(json, configPath);
};

const asObject = (json: unknown, configPath: string): Record<string, unknown> => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`配置文件结构异常（顶层不是对象），未改动，请手动修复：${configPath}`);
  }
  return json as Record<string, unknown>;
};

// ====== TOML 段编辑（Codex）：只动 [mcp_servers.pianyu] 节，其余逐字节保留 ======

const TOML_HEADER = /^\[mcp_servers\.pianyu\]\s*$/m;
const TOML_NEXT_TABLE = /^\[/;

const mergeTomlSection = (raw: string, sectionText: string): string => {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => TOML_HEADER.test(l));
  if (start < 0) {
    const prefix = raw && !raw.endsWith('\n') ? '\n\n' : raw ? '\n' : '';
    return raw + prefix + sectionText;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOML_NEXT_TABLE.test(lines[i])) {
      end = i;
      break;
    }
  }
  const replaced = [...lines.slice(0, start), ...sectionText.split('\n'), ...lines.slice(end)];
  return replaced.join('\n');
};

const extractTomlSection = (raw: string): string | null => {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => TOML_HEADER.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOML_NEXT_TABLE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

// ====== YAML patch 行编辑（dsh）：只动 serverName: pianyu 那条顶层 insert 行 ======

const DSH_ROW_MARKER = 'serverName: pianyu';

const mergeYamlRow = (raw: string, rowText: string, configPath: string): string => {
  const lines = raw.split(/\r?\n/);
  // 顶层列表项边界 = 列 0 以「- 」开头的行；先确认文件是 patch 列表结构
  const firstContent = lines.find((l) => l.trim() && !l.trim().startsWith('#'));
  if (firstContent && !/^-\s/.test(firstContent)) {
    throw new Error(`配置文件不是预期的 patch 列表结构，未改动，请手动处理：${configPath}`);
  }
  const itemStarts: number[] = [];
  lines.forEach((l, i) => {
    if (/^- /.test(l)) itemStarts.push(i);
  });
  for (let k = 0; k < itemStarts.length; k++) {
    const s = itemStarts[k];
    const e = k + 1 < itemStarts.length ? itemStarts[k + 1] : lines.length;
    if (lines.slice(s, e).some((l) => l.includes(DSH_ROW_MARKER))) {
      const replaced = [...lines.slice(0, s), ...rowText.split('\n'), ...lines.slice(e)];
      return replaced.join('\n');
    }
  }
  // 不存在：追加为新顶层行
  const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
  return raw + prefix + rowText;
};

const extractYamlRow = (raw: string): string | null => {
  const lines = raw.split(/\r?\n/);
  const itemStarts: number[] = [];
  lines.forEach((l, i) => {
    if (/^- /.test(l)) itemStarts.push(i);
  });
  for (let k = 0; k < itemStarts.length; k++) {
    const s = itemStarts[k];
    const e = k + 1 < itemStarts.length ? itemStarts[k + 1] : lines.length;
    const block = lines.slice(s, e);
    if (block.some((l) => l.includes(DSH_ROW_MARKER))) return block.join('\n');
  }
  return null;
};

// ====== agent 定义 ======

interface AgentDef {
  id: McpAgentId;
  name: string;
  /** 配置文件绝对路径 */
  configPath: (homeDir: string) => string;
  /** 是否已安装（按目录/文件存在性判定，不读内容） */
  isInstalled: (homeDir: string) => boolean;
  /** json 类：写入/读回 pianyu 条目（不同 agent 键路径不同） */
  setJsonEntry?: (json: Record<string, unknown>, url: string, token: string) => void;
  getJsonEntry?: (json: Record<string, unknown>) => unknown;
  /** json 类且配置可能带注释（OpenClaw JSON5）：读取走宽松解析 */
  json5?: boolean;
  /** 文本类（toml/yaml）：生成配置块 + 行级合并 + 已配置判定 */
  buildText?: (url: string, token: string) => string;
  mergeText?: (raw: string, url: string, token: string, configPath: string) => string;
  isTextConfigured?: (raw: string) => boolean;
  /** 文本类：提取 pianyu 配置块（端口自愈读取条目用） */
  textBlock?: (raw: string) => string | null;
}

/** 嵌套 mcp.servers.pianyu 键路径的读写（openclaw / zcode 共用） */
const setNestedMcpServers = (json: Record<string, unknown>, entry: Record<string, unknown>) => {
  const mcp = (json.mcp && typeof json.mcp === 'object' && !Array.isArray(json.mcp)
    ? json.mcp
    : {}) as Record<string, unknown>;
  const servers = (mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers)
    ? mcp.servers
    : {}) as Record<string, unknown>;
  servers.pianyu = entry;
  mcp.servers = servers;
  json.mcp = mcp;
};

const getNestedMcpServers = (json: Record<string, unknown>): unknown => {
  const mcp = json.mcp;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return undefined;
  const servers = (mcp as Record<string, unknown>).servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
  return (servers as Record<string, unknown>).pianyu;
};

/** 文本块是否含指向本机 /mcp 的 pianyu 配置（文本类 configured 判定） */
const textHasPianyu = (block: string | null): boolean => {
  if (!block) return false;
  const urlMatch = block.match(/url\s*=\s*"([^"]+)"|url:\s*"?([^"\n]+)"?/);
  const url = urlMatch?.[1] ?? urlMatch?.[2];
  return (!!url && PIANYU_URL_RE.test(url) && block.includes('Bearer '));
};

const AGENTS: AgentDef[] = [
  {
    id: 'kimi',
    name: 'Kimi Code CLI',
    configPath: (homeDir) => path.join(homeDir, '.kimi-code', 'mcp.json'),
    isInstalled: (homeDir) => fs.existsSync(path.join(homeDir, '.kimi-code')),
    setJsonEntry: (json, url, token) => {
      const servers = (json.mcpServers && typeof json.mcpServers === 'object' && !Array.isArray(json.mcpServers)
        ? json.mcpServers
        : {}) as Record<string, unknown>;
      servers.pianyu = {url, headers: {Authorization: `Bearer ${token}`}};
      json.mcpServers = servers;
    },
    getJsonEntry: (json) => {
      const servers = json.mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
      return (servers as Record<string, unknown>).pianyu;
    },
  },
  {
    id: 'claude',
    name: 'Claude Code',
    configPath: (homeDir) => path.join(homeDir, '.claude.json'),
    isInstalled: (homeDir) => fs.existsSync(path.join(homeDir, '.claude.json')),
    setJsonEntry: (json, url, token) => {
      const servers = (json.mcpServers && typeof json.mcpServers === 'object' && !Array.isArray(json.mcpServers)
        ? json.mcpServers
        : {}) as Record<string, unknown>;
      servers.pianyu = {type: 'http', url, headers: {Authorization: `Bearer ${token}`}};
      json.mcpServers = servers;
    },
    getJsonEntry: (json) => {
      const servers = json.mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
      return (servers as Record<string, unknown>).pianyu;
    },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    configPath: (homeDir) => path.join(homeDir, '.codex', 'config.toml'),
    isInstalled: (homeDir) => fs.existsSync(path.join(homeDir, '.codex')),
    buildText: (url, token) =>
      [
        '[mcp_servers.pianyu]',
        `url = "${url}"`,
        `http_headers = { Authorization = "Bearer ${token}" }`,
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 180',
      ].join('\n'),
    mergeText: (raw, url, token) => mergeTomlSection(raw, AGENTS.find((a) => a.id === 'codex')!.buildText!(url, token)),
    isTextConfigured: (raw) => textHasPianyu(extractTomlSection(raw)),
    textBlock: extractTomlSection,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    configPath: (homeDir) => path.join(homeDir, '.openclaw', 'openclaw.json'),
    isInstalled: (homeDir) => fs.existsSync(path.join(homeDir, '.openclaw')),
    json5: true,
    setJsonEntry: (json, url, token) =>
      setNestedMcpServers(json, {
        url,
        transport: 'streamable-http',
        headers: {Authorization: `Bearer ${token}`},
        enabled: true,
      }),
    getJsonEntry: (json) => getNestedMcpServers(json),
  },
  {
    id: 'zcode',
    name: 'ZCode CLI',
    configPath: (homeDir) => path.join(homeDir, '.zcode', 'cli', 'config.json'),
    isInstalled: (homeDir) => fs.existsSync(path.join(homeDir, '.zcode')),
    // 严格 schema：未知键会静默丢弃 server，条目只放规范键
    setJsonEntry: (json, url, token) =>
      setNestedMcpServers(json, {type: 'http', url, headers: {Authorization: `Bearer ${token}`}, enabled: true}),
    getJsonEntry: (json) => getNestedMcpServers(json),
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    configPath: (homeDir) => path.join(homeDir, '.dsh', 'cordis.patch.yml'),
    isInstalled: (homeDir) => fs.existsSync(path.join(homeDir, '.dsh')),
    buildText: (url, token) =>
      [
        '- insert:',
        '  - id: mcp-pianyu',
        "    name: '@deepseek-ai/dsh-mcp-client'",
        '    config:',
        '      serverName: pianyu',
        '      transport: streamable-http',
        `      url: "${url}"`,
        '      headers:',
        `        Authorization: "Bearer ${token}"`,
        '      toolCallTimeoutMs: 180000',
      ].join('\n'),
    mergeText: (raw, url, token, configPath) =>
      mergeYamlRow(raw, AGENTS.find((a) => a.id === 'dsh')!.buildText!(url, token), configPath),
    isTextConfigured: (raw) => textHasPianyu(extractYamlRow(raw)),
    textBlock: extractYamlRow,
  },
];

/** agent id 运行时清单（IPC 一键接入的入参校验用；与 shared/mcp.ts 的 McpAgentId 类型一一对应，新增 agent 两处同步） */
export const MCP_AGENT_IDS: readonly McpAgentId[] = AGENTS.map((a) => a.id);

// ====== 原子写 ======

const atomicWrite = (configPath: string, content: string) => {
  fs.mkdirSync(path.dirname(configPath), {recursive: true});
  const tmpPath = `${configPath}.pianyu-tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, configPath);
};

/** 探测各 agent 的安装/配置状态（安装后刷新、弹窗打开时调用） */
export const listAgents = (homeDir: string): McpAgentInfo[] =>
  AGENTS.map((def) => {
    const configPath = def.configPath(homeDir);
    const installed = def.isInstalled(homeDir);
    let configured = false;
    if (installed && fs.existsSync(configPath)) {
      try {
        if (def.getJsonEntry) {
          configured = isPianyuEntry(def.getJsonEntry(readJsonConfig(configPath, !!def.json5)));
        } else if (def.isTextConfigured) {
          configured = def.isTextConfigured(fs.readFileSync(configPath, 'utf8'));
        }
      } catch {
        // 配置损坏：按未配置展示（写入时会给出明确中文报错）
        configured = false;
      }
    }
    return {id: def.id, name: def.name, installed, configured, configPath};
  });

/**
 * 一键接入：把 pianyu 条目写入指定 agent 的配置文件。
 * 已配置过的重复调用是幂等的（内容一致；备份沿用首次，不覆盖）。
 */
export const installAgent = (
  homeDir: string,
  id: McpAgentId,
  {url, token}: {url: string; token: string},
): McpAgentInstallResult => {
  const def = AGENTS.find((a) => a.id === id);
  if (!def) throw new Error(`未知的 agent：${id}`);
  const configPath = def.configPath(homeDir);

  const existed = fs.existsSync(configPath);

  if (def.setJsonEntry) {
    // json 类：读（损坏在此抛中文错，备份/写入不会执行）→ 合并 → 原子写
    const json = readJsonConfig(configPath, !!def.json5);
    backupIfExists(configPath, existed);
    def.setJsonEntry(json, url, token);
    atomicWrite(configPath, `${JSON.stringify(json, null, 2)}\n`);
  } else if (def.mergeText && def.buildText) {
    // 文本类：行级外科手术合并，未涉内容逐字节保留
    const raw = existed ? fs.readFileSync(configPath, 'utf8') : '';
    const merged = def.mergeText(raw, url, token, configPath);
    backupIfExists(configPath, existed);
    atomicWrite(configPath, merged.endsWith('\n') ? merged : `${merged}\n`);
  } else {
    throw new Error(`agent 定义不完整：${id}`);
  }

  return {
    configPath,
    backupPath: existed ? `${configPath}.pianyu-bak` : undefined,
    message: `已写入 ${def.name} 的配置${existed ? '（原配置已备份）' : ''}，重启 ${def.name} 后生效。`,
  };
};

/** 备份原配置（仅文件已存在时；已有备份不覆盖——首次备份最接近用户原始状态） */
const backupIfExists = (configPath: string, existed: boolean) => {
  if (!existed) return;
  const backupPath = `${configPath}.pianyu-bak`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(configPath, backupPath);
};

// ====== MCP 端口自愈 ======

/** 单个 agent 的自愈结果（healed=true 时 fromUrl 为改写前地址） */
export interface McpAgentHealResult {
  id: McpAgentId;
  name: string;
  healed: boolean;
  fromUrl?: string;
}

/** 从文本类 pianyu 配置块提取 url 与 Bearer token（toml 的 url= 与 yaml 的 url: 通吃） */
const extractTextEntry = (block: string | null): {url: string; token: string} | null => {
  if (!block) return null;
  const urlMatch = block.match(/url\s*=\s*"([^"]+)"|url:\s*"?([^"\n]+)"?/);
  const url = (urlMatch?.[1] ?? urlMatch?.[2] ?? '').trim();
  const tokenMatch = block.match(/Bearer\s+([A-Za-z0-9._-]+)/);
  if (!url || !tokenMatch) return null;
  return {url, token: tokenMatch[1]};
};

/** 读取某 agent 配置里 pianyu 条目的 {url, token}；文件缺失/无条目/解析失败一律返回 null（自愈跳过） */
const readPianyuEntry = (def: AgentDef, homeDir: string): {url: string; token: string} | null => {
  const configPath = def.configPath(homeDir);
  if (!fs.existsSync(configPath)) return null;
  try {
    if (def.getJsonEntry) {
      const entry = def.getJsonEntry(readJsonConfig(configPath, !!def.json5));
      if (!isPianyuEntry(entry)) return null;
      const e = entry as {url: string; headers: {Authorization: string}};
      return {url: e.url, token: e.headers.Authorization.slice('Bearer '.length)};
    }
    if (def.textBlock) {
      const parsed = extractTextEntry(def.textBlock(fs.readFileSync(configPath, 'utf8')));
      if (!parsed || !PIANYU_URL_RE.test(parsed.url)) return null;
      return parsed;
    }
  } catch {
    return null; // 配置损坏：不碰（自愈绝不制造新问题；一键接入写入时会给出明确中文报错）
  }
  return null;
};

/**
 * MCP 端口自愈：实际端口与已接入配置不一致时，把 agent 配置里的地址改写为当前实际地址。
 * MCP 服务每次成功启动后调用（含启动拉起/开关/改端口重启），不变式：
 * 「所有 token 未变的已接入 agent 配置，永远指向当前运行中的地址」。
 *
 * 安全边界（缺一不可）：
 * - 只动「我们的条目」：url 为本机回环 /mcp 形态且 Authorization 与当前 token 完全一致；
 * - token 不一致 = 用户重新生成过（主动吊销语义），绝不顺带恢复访问；
 * - 非本机 /mcp 形态的 url（用户手改过）不碰；
 * - 改写复用 installAgent（原子写 + 首次备份语义），token 原值写回，纯 URL 修正。
 */
export const healAgentConfigs = (homeDir: string, currentUrl: string, currentToken: string): McpAgentHealResult[] => {
  const healed: McpAgentHealResult[] = [];
  if (!currentUrl || !currentToken) return healed;
  for (const def of AGENTS) {
    const entry = readPianyuEntry(def, homeDir);
    if (!entry) continue;
    if (entry.token !== currentToken) continue;   // 重新生成过 token = 已吊销，不恢复
    if (entry.url === currentUrl) continue;       // 已指向当前地址
    if (!PIANYU_URL_RE.test(entry.url)) continue; // 非本机 /mcp 形态，不碰
    try {
      installAgent(homeDir, def.id, {url: currentUrl, token: currentToken});
      healed.push({id: def.id, name: def.name, healed: true, fromUrl: entry.url});
    } catch {
      // 单个 agent 写失败不影响其余；下次启动会再尝试
    }
  }
  return healed;
};
