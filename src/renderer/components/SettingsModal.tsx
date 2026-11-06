/**
 * SettingsModal — 设置页面弹窗
 * 管理用户偏好：默认输出目录、渲染格式、CRF、自动保存
 */

import React, {useEffect, useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {Settings as SettingsIcon, X, ChevronDown, ChevronRight, Sun, Moon, Monitor, Copy, Eye, EyeOff, RefreshCw, Check} from 'lucide-react';
import {DEFAULT_SETTINGS} from '../../shared/settings';
import type {AppSettings} from '../../shared/settings';
import {AI_PROVIDER_PRESETS} from '../../shared/ai-presets';
import type {AiProviderPreset} from '../../shared/ai-presets';
import type {McpAgentId, McpAgentInfo, McpServerStatus} from '../../shared/mcp';
import './SettingsModal.css';

// 类型与默认值已移至 shared/settings.ts（解开 projectStore → 组件的依赖，便于单测），此处再导出兼容
export type {AppSettings} from '../../shared/settings';
export {DEFAULT_SETTINGS} from '../../shared/settings';

/**
 * 可折叠分区：设置项从「一页到底」改为「每区折叠、默认只开常规」。
 * 收起时不渲染 children（分区内容重、控件多，不渲染也省 DOM）；
 * 深链（AI 面板「前往手动配置」等）先把目标分区展开再滚动定位。
 */
const SettingsSection: React.FC<{
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({id, title, open, onToggle, children}) => (
  <>
    <div
      className={`settings-section-title settings-section-toggle ${open ? 'open' : 'collapsed'}`}
      id={`settings-sec-${id}`}
      onClick={onToggle}
      role="button"
      aria-expanded={open}
    >
      <ChevronRight size={14} className="settings-section-chevron" />
      {title}
    </div>
    {open && children}
  </>
);

/** 从持久化存储加载设置 */
const loadSettings = async (): Promise<AppSettings> => {
  try {
    const saved = await window.api.getSettings();
    return {...DEFAULT_SETTINGS, ...saved};
  } catch {
    return {...DEFAULT_SETTINGS};
  }
}

interface SettingsModalProps {
  onClose: () => void;
  /** 打开后滚动定位到的分区（AI 助手面板「前往设置」深链）：'ai' = AI 助手，'mcp' = Agent 接入（MCP） */
  initialSection?: 'ai' | 'mcp';
  /** 打开片语本地模型弹窗（检测电脑状态 / 下载权重；付费版功能） */
  onOpenLocalModel?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({onClose, initialSection, onOpenLocalModel}) => {
  const setAppSettings = useProjectStore((s) => s.setAppSettings);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 是否打包环境（生产隐藏仅开发联调用的设置项；默认 true = 未确认前按生产处理）
  const [isPackaged, setIsPackaged] = useState(true);
  // AI 助手：API key 输入框内容与「已配置」状态（key 只进不出，保存后不回显）
  const [llmKeyInput, setLlmKeyInput] = useState('');
  const [llmKeyConfigured, setLlmKeyConfigured] = useState(false);
  const [llmKeySaved, setLlmKeySaved] = useState(false);
  // TTS：同模式
  const [ttsKeyInput, setTtsKeyInput] = useState('');
  const [ttsKeyConfigured, setTtsKeyConfigured] = useState(false);
  const [ttsKeySaved, setTtsKeySaved] = useState(false);
  // ASR：同模式
  const [asrKeyInput, setAsrKeyInput] = useState('');
  const [asrKeyConfigured, setAsrKeyConfigured] = useState(false);
  const [asrKeySaved, setAsrKeySaved] = useState(false);
  // 文生 3D：同模式（Key 独立于 AI 助手，服务商不同）
  const [modelGenKeyInput, setModelGenKeyInput] = useState('');
  const [modelGenKeyConfigured, setModelGenKeyConfigured] = useState(false);
  const [modelGenKeySaved, setModelGenKeySaved] = useState(false);
  // LLM 连通性测试：发起一次极小请求，验证「预设+Key」组合是否真的能通（选错模型/Key 打错字当场暴露）
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ok: boolean; text: string} | null>(null);
  // 分区折叠状态：默认只展开「常规」，其余收起；AI 面板深链进来时先展开目标分区
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['general']));
  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const [pexelsKeyInput, setPexelsKeyInput] = useState('');
  const [pexelsKeyConfigured, setPexelsKeyConfigured] = useState(false);
  const [pexelsKeySaved, setPexelsKeySaved] = useState(false);
  const [pixabayKeyInput, setPixabayKeyInput] = useState('');
  const [pixabayKeyConfigured, setPixabayKeyConfigured] = useState(false);
  const [pixabayKeySaved, setPixabayKeySaved] = useState(false);
  // MCP 服务接口：状态（含 token）/ 端口输入框 / token 显隐 / 各复制按钮的「已复制」反馈
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus | null>(null);
  const [mcpPortInput, setMcpPortInput] = useState('');
  const [mcpShowToken, setMcpShowToken] = useState(false);
  const [mcpCopied, setMcpCopied] = useState<'url' | 'token' | 'config' | 'instruct' | null>(null);
  // MCP 一键接入：本机 agent 探测结果 / 最近一次接入操作的行内反馈（成功或中文错误）
  const [mcpAgents, setMcpAgents] = useState<McpAgentInfo[]>([]);
  const [mcpAgentMsg, setMcpAgentMsg] = useState<{ok: boolean; text: string} | null>(null);

  // 加载持久化设置并同步到内存 store
  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      setAppSettings(loaded);
    });
    // 拉取 API key 配置状态（只返回 已配置/未配置）
    window.api.llmGetStatus().then((s) => setLlmKeyConfigured(s.configured)).catch(() => {});
    window.api.ttsGetStatus().then((s) => setTtsKeyConfigured(s.configured)).catch(() => {});
    window.api.asrGetStatus().then((s) => setAsrKeyConfigured(s.configured)).catch(() => {});
    // 文生 3D 配置状态（只返回 已配置/未配置）
    window.api.modelGenGetStatus().then((s) => setModelGenKeyConfigured(s.configured)).catch(() => {});
    // Stock 素材源配置状态（Pexels / Pixabay）
    window.api.stockGetStatus().then((s) => {
      setPexelsKeyConfigured(s.pexels);
      setPixabayKeyConfigured(s.pixabay);
    }).catch(() => {});
    // 打包状态（生产环境隐藏仅开发联调用的设置项）
    window.api.getAppInfo().then((info) => setIsPackaged(info.isPackaged)).catch(() => {});
    // MCP 服务状态（含端口与 token，供本区分区展示/复制）
    window.api.mcpGetStatus().then((s) => {
      setMcpStatus(s);
      setMcpPortInput(String(s.port || ''));
    }).catch(() => {});
    // MCP 一键接入：探测本机已装 agent（Kimi Code CLI / Claude Code）及其配置状态
    window.api.mcpListAgents().then((r) => setMcpAgents(r.agents)).catch(() => {});
  }, [setAppSettings]);

  // 深链定位：带 initialSection 打开时先展开目标分区（收起时内容不在 DOM，直接滚动会落空），
  // 稍延迟等展开渲染完成再滚到分区标题
  useEffect(() => {
    if (!initialSection) return;
    const sectionId = initialSection === 'mcp' ? 'mcp' : 'ai';
    setOpenSections((prev) => (prev.has(sectionId) ? prev : new Set(prev).add(sectionId)));
    const id = window.setTimeout(() => {
      document.getElementById(`settings-sec-${sectionId}`)
        ?.scrollIntoView({block: 'start'});
    }, 60);
    return () => window.clearTimeout(id);
  }, [initialSection]);

  // 当前命中的 LLM 厂商预设（按 baseUrl 归一化匹配；用户改过模型名不影响命中——预设只锚定端点）
  const activeLlmPreset =
    AI_PROVIDER_PRESETS.find((p) => p.llm.baseUrl === settings.llmBaseUrl.trim().replace(/\/+$/, '')) ?? null;

  // 更新并持久化（同时同步到内存 store，供其他组件读取）
  const handleUpdate = (partial: Partial<AppSettings>) => {
    const updated = {...settings, ...partial};
    setSettings(updated);
    setAppSettings(partial);
    window.api.setSettings(updated);
  };

  // 保存 API key：主进程 safeStorage 加密后落盘；空输入不改动已保存的 key
  const handleSaveLlmKey = async () => {
    const key = llmKeyInput.trim();
    if (!key) return;
    await window.api.llmSetApiKey(key);
    setLlmKeyInput('');
    setLlmKeyConfigured(true);
    setLlmKeySaved(true);
    setTimeout(() => setLlmKeySaved(false), 2000);
  };

  // 清除已保存的 API key
  const handleClearLlmKey = async () => {
    await window.api.llmSetApiKey('');
    setLlmKeyConfigured(false);
  };

  // 保存 TTS API key（同 LLM 模式）
  const handleSaveTtsKey = async () => {
    const key = ttsKeyInput.trim();
    if (!key) return;
    await window.api.ttsSetApiKey(key);
    setTtsKeyInput('');
    setTtsKeyConfigured(true);
    setTtsKeySaved(true);
    setTimeout(() => setTtsKeySaved(false), 2000);
  };

  const handleClearTtsKey = async () => {
    await window.api.ttsSetApiKey('');
    setTtsKeyConfigured(false);
  };

  // 保存 ASR API key（同 LLM 模式）
  const handleSaveAsrKey = async () => {
    const key = asrKeyInput.trim();
    if (!key) return;
    await window.api.asrSetApiKey(key);
    setAsrKeyInput('');
    setAsrKeyConfigured(true);
    setAsrKeySaved(true);
    setTimeout(() => setAsrKeySaved(false), 2000);
  };

  const handleClearAsrKey = async () => {
    await window.api.asrSetApiKey('');
    setAsrKeyConfigured(false);
  };

  // 保存文生 3D API key（同 LLM 模式）
  const handleSaveModelGenKey = async () => {
    const key = modelGenKeyInput.trim();
    if (!key) return;
    await window.api.modelGenSetApiKey(key);
    setModelGenKeyInput('');
    setModelGenKeyConfigured(true);
    setModelGenKeySaved(true);
    setTimeout(() => setModelGenKeySaved(false), 2000);
  };

  // 连通性测试：极小 chat 请求（约 10 个 token 的成本），按当前设置里的 baseUrl/model + 已存 Key 实测
  const handleTestLlm = async () => {
    if (!settings.llmBaseUrl.trim() || !settings.llmModel.trim()) {
      setLlmTestResult({ok: false, text: '请先点上方厂商预设（或手动填写服务地址与模型名）'});
      return;
    }
    setLlmTesting(true);
    setLlmTestResult(null);
    try {
      const reply = await window.api.llmChat({messages: [{role: 'user', content: '连通性测试，请只回复四个字：连接成功'}]});
      const text = typeof reply.content === 'string' ? reply.content.trim() : '（返回多模态内容）';
      setLlmTestResult({ok: true, text: `连通正常：${text.slice(0, 40) || '(空回复)'}`});
    } catch (err) {
      setLlmTestResult({ok: false, text: err instanceof Error ? err.message : String(err)});
    } finally {
      setLlmTesting(false);
    }
  };

  const handleClearModelGenKey = async () => {
    await window.api.modelGenSetApiKey('');
    setModelGenKeyConfigured(false);
  };

  // ====== MCP 服务接口 ======

  const handleMcpToggle = async (enabled: boolean) => {
    const s = await window.api.mcpSetEnabled(enabled).catch(() => null);
    if (s) setMcpStatus(s);
  };

  // 端口失焦/回车时落盘（运行中主进程会自动重启服务，实际端口以返回状态为准）
  const handleMcpPortCommit = async () => {
    const port = Number(mcpPortInput);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setMcpPortInput(String(mcpStatus?.port || ''));
      return;
    }
    const s = await window.api.mcpSetPort(port).catch(() => null);
    if (s) {
      setMcpStatus(s);
      setMcpPortInput(String(s.port));
    }
  };

  const handleMcpRegenerateToken = async () => {
    if (!window.confirm('重新生成后，已配置的第三方 agent 需要换新 token 才能继续接入。确定重新生成吗？')) return;
    const s = await window.api.mcpRegenerateToken().catch(() => null);
    if (s) setMcpStatus(s);
  };

  /** 复制到剪贴板并给「已复制」反馈（失败时退回 textarea 方案） */
  const handleMcpCopy = async (kind: 'url' | 'token' | 'config' | 'instruct', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setMcpCopied(kind);
    setTimeout(() => setMcpCopied(null), 1500);
  };

  /** Kimi CLI / Claude Code 等客户端的 mcp.json 配置片段 */
  const mcpConfigSnippet = (): string => {
    const url = mcpStatus?.url || `http://127.0.0.1:${mcpStatus?.port || 17890}/mcp`;
    return JSON.stringify(
      {mcpServers: {pianyu: {type: 'http', url, headers: {Authorization: `Bearer ${mcpStatus?.token || ''}`}}}},
      null,
      2,
    );
  };

  /** 给任意 agent 的接入指令文本（粘贴给 agent，让它照官网文档自行完成接入） */
  const mcpInstructText = (): string => {
    const url = mcpStatus?.url || `http://127.0.0.1:${mcpStatus?.port || 17890}/mcp`;
    return `请依照 https://studio.dwphoto.top/videotool/mcp.html 的文档，帮我接入"片语"的 MCP 服务。服务地址：${url}，Token：${mcpStatus?.token || ''}。`;
  };

  /** 一键接入：主进程把当前 url+token 写入 agent 配置文件（写前备份 + 原子写）；完成后刷新徽标 */
  const handleMcpInstallAgent = async (id: McpAgentId) => {
    setMcpAgentMsg(null);
    try {
      const res = await window.api.mcpInstallAgent(id);
      setMcpAgentMsg({ok: true, text: res.message});
      const r = await window.api.mcpListAgents().catch(() => null);
      if (r) setMcpAgents(r.agents);
    } catch (e) {
      // ipc 抛错会带 "Error invoking remote method '...': Error: " 前缀，剥掉只留中文正文
      const raw = e instanceof Error ? e.message : String(e);
      setMcpAgentMsg({ok: false, text: raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')});
    }
  };

  const handleSelectDir = async () => {
    const dir = await window.api.selectOutputDir();
    if (dir) {
      handleUpdate({defaultOutputDir: dir});
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}><X size={18} /></button>

        <h2 className="settings-title"><SettingsIcon size={18} /> 设置</h2>

        <div className="settings-list">
          <SettingsSection id="general" title="常规" open={openSections.has('general')} onToggle={() => toggleSection('general')}>
          {/* 外观主题 */}
          <div className="settings-item settings-item-row">
            <label className="settings-label">外观</label>
            <div className="theme-switch">
              <button
                type="button"
                className={`theme-option ${settings.theme === 'light' ? 'active' : ''}`}
                onClick={() => handleUpdate({theme: 'light'})}
              >
                <Sun size={14} /> 浅色
              </button>
              <button
                type="button"
                className={`theme-option ${settings.theme === 'dark' ? 'active' : ''}`}
                onClick={() => handleUpdate({theme: 'dark'})}
              >
                <Moon size={14} /> 深色
              </button>
              <button
                type="button"
                className={`theme-option ${settings.theme === 'system' ? 'active' : ''}`}
                title="跟随 Windows 深浅色设置自动切换"
                onClick={() => handleUpdate({theme: 'system'})}
              >
                <Monitor size={14} /> 跟随系统
              </button>
            </div>
          </div>

          {/* 编辑模式：精简（默认）只留核心标签页，专家显示全部标签页与高级控件 */}
          <div className="settings-item settings-item-row">
            <label className="settings-label" title="精简 = 只显示素材/文字/参数三个标签页并隐藏起点、缓动曲线等高级控件；专家 = 显示全部">
              编辑模式
            </label>
            <div className="theme-switch">
              <button
                type="button"
                className={`theme-option ${!settings.editorProMode ? 'active' : ''}`}
                onClick={() => handleUpdate({editorProMode: false})}
              >
                精简（推荐）
              </button>
              <button
                type="button"
                className={`theme-option ${settings.editorProMode ? 'active' : ''}`}
                onClick={() => handleUpdate({editorProMode: true})}
              >
                专家
              </button>
            </div>
          </div>

          {/* 默认输出目录 */}
          <div className="settings-item">
            <label className="settings-label">默认输出目录</label>
            <div className="settings-control">
              <span className="settings-path" title={settings.defaultOutputDir}>
                {settings.defaultOutputDir || '（未设置，每次手动选择）'}
              </span>
              <button className="btn-choose-dir" onClick={handleSelectDir}>
                {settings.defaultOutputDir ? '更改' : '选择'}
              </button>
            </div>
          </div>

          {/* 默认渲染格式 */}
          <div className="settings-item">
            <label className="settings-label">默认渲染格式</label>
            <select
              className="settings-select"
              value={settings.defaultFormat}
              onChange={(e) => handleUpdate({defaultFormat: e.target.value as AppSettings['defaultFormat']})}
            >
              <option value="mp4">MP4 (H.264)</option>
              <option value="mov">MOV (ProRes)</option>
              <option value="webm">WebM (VP9)</option>
            </select>
          </div>

          {/* 默认画质 CRF */}
          <div className="settings-item">
            <label className="settings-label">
              默认画质 (CRF) <span className="settings-value">{settings.defaultCrf}</span>
            </label>
            <input
              type="range"
              className="settings-slider"
              min={18}
              max={30}
              step={1}
              value={settings.defaultCrf}
              onChange={(e) => handleUpdate({defaultCrf: Number(e.target.value)})}
            />
            <div className="settings-range-labels">
              <span>高质量</span>
              <span>小文件</span>
            </div>
          </div>

          {/* 自动保存 */}
          <div className="settings-item settings-item-row">
            <label className="settings-label">自动保存</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings.autoSave}
                onChange={(e) => handleUpdate({autoSave: e.target.checked})}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">每 30 秒将有改动的工程备份到自动保存文件；异常退出后下次启动可恢复</p>
          </SettingsSection>

          <SettingsSection id="privacy" title="隐私与统计" open={openSections.has('privacy')} onToggle={() => toggleSection('privacy')}>
          {/* 匿名崩溃报告（opt-in，默认关闭）：内容不含文件内容/工程数据/激活码，
              详见隐私政策「崩溃报告」条款 */}
          <div className="settings-item settings-item-row">
            <label className="settings-label">匿名崩溃报告</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings.crashReporting}
                onChange={(e) => handleUpdate({crashReporting: e.target.checked})}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">默认关闭。开启后，应用崩溃时会上报版本号、系统平台与错误信息（不含文件路径正文、工程内容与激活码），帮助我们修复问题</p>

          {/* 匿名用量统计（默认开启）：仅功能使用次数，主进程每 24h 至多上报一次，
              失败静默重试；内容不含任何素材与工程内容（见 main/services/usage.ts） */}
          <div className="settings-item settings-item-row">
            <label className="settings-label">帮助改进产品（发送匿名用量统计）</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings.usageReporting}
                onChange={(e) => handleUpdate({usageReporting: e.target.checked})}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">仅包含功能使用次数，不含任何素材与工程内容</p>
          </SettingsSection>

          {/* ====== AI 助手 ======
              支持任何 OpenAI 兼容端点（DeepSeek / Qwen / Kimi / OpenAI / Ollama 等）。
              baseUrl 与模型名为明文设置项（随本设置持久化）；
              API key 单独走 llm:setApiKey，由主进程 safeStorage 加密存储，不回显。 */}
          <SettingsSection id="ai" title="AI 助手" open={openSections.has('ai')} onToggle={() => toggleSection('ai')}>

          {/* MCP 推荐注：手动配置是次选路径，优先引导去 MCP 一键接入（模型由 agent 自带）。
              MCP 分区紧跟本区（Key 填充之后），展开并滚动过去 */}
          <div className="settings-mcp-note">
            <span>
              推荐：优先用 MCP 连接本机 agent（Kimi CLI / Claude Code 等）——模型由 agent 自带，免填下方服务地址与 API Key。
            </span>
            <button
              type="button"
              className="settings-mcp-note-link"
              onClick={() => {
                setOpenSections((prev) => (prev.has('mcp') ? prev : new Set(prev).add('mcp')));
                window.setTimeout(() => document.getElementById('settings-sec-mcp')?.scrollIntoView({block: 'start'}), 60);
              }}
            >
              前往 Agent 接入 ↓
            </button>
          </div>

          {/* 片语本地模型入口（专有模型：订阅 ¥6/月 可下载本地不限 token；检测显存/下载权重） */}
          {onOpenLocalModel && (
            <div className="settings-mcp-note local-model">
              <span>
                片语本地模型：8 元付费版解锁，<b>本地使用不限 token</b>、数据不出本机（需 8GB 及以上显存）。
              </span>
              <button type="button" className="settings-mcp-note-link" onClick={onOpenLocalModel}>
                检测电脑 / 下载权重 →
              </button>
            </div>
          )}

          {/* 厂商预设（AI 零门槛）：一键填 baseUrl/模型，Key 用户自贴；
              将来备案完成后接入托管内置通道时，在 ai-presets.ts 追加一个预设即可，UI 零改动 */}
          <div className="settings-item">
            <label className="settings-label">快速填充：点厂商，粘 Key，即用</label>
            <PresetChipsRow
              presets={AI_PROVIDER_PRESETS}
              activeId={activeLlmPreset?.id ?? null}
              onPick={(p) => {
                handleUpdate({llmBaseUrl: p.llm.baseUrl, llmModel: p.llm.model});
                setLlmTestResult(null);
              }}
            />
            {activeLlmPreset && (
              <p className="settings-preset-note">
                {activeLlmPreset.note}
                <button
                  type="button"
                  className="settings-preset-link"
                  onClick={() => void window.api.openExternal(activeLlmPreset.keyUrl)}
                >
                  获取 {activeLlmPreset.name} API Key ↗
                </button>
              </p>
            )}
          </div>

          <div className="settings-item">
            <label className="settings-label">服务地址 (Base URL)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="点上方厂商预设一键填充"
              value={settings.llmBaseUrl}
              onChange={(e) => handleUpdate({llmBaseUrl: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">模型 (Model)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="deepseek-chat"
              value={settings.llmModel}
              onChange={(e) => handleUpdate({llmModel: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">编辑模型（可选，双模型路由）</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="留空 = 单模型；填 Ollama 第二个模型名，改稿类对话自动切到它"
              value={settings.llmModelEdit}
              onChange={(e) => handleUpdate({llmModelEdit: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">
              API Key
              <span className={`llm-key-status ${llmKeyConfigured ? 'configured' : ''}`}>
                {llmKeyConfigured ? '已配置' : '未配置'}
              </span>
            </label>
            <div className="settings-control">
              <input
                type="password"
                className="settings-text-input"
                placeholder={llmKeyConfigured ? '已保存，输入新 Key 可覆盖' : 'sk-...'}
                value={llmKeyInput}
                onChange={(e) => setLlmKeyInput(e.target.value)}
              />
              <button className="btn-choose-dir" onClick={handleSaveLlmKey} disabled={!llmKeyInput.trim()}>
                {llmKeySaved ? '已保存' : '保存'}
              </button>
              {llmKeyConfigured && (
                <button className="btn-choose-dir" onClick={handleClearLlmKey}>清除</button>
              )}
            </div>
          </div>
          <p className="settings-hint">Key 经系统安全存储加密后保存在本机，不会上传到任何地方（除你配置的 AI 服务）</p>

          {/* 连通性测试：验证「预设 + Key」组合真实可用，别等对话时才发现 Key 打错 */}
          <div className="settings-item">
            <div className="settings-control">
              <button className="btn-choose-dir" onClick={() => void handleTestLlm()} disabled={llmTesting}>
                {llmTesting ? '测试中…' : '测试连接'}
              </button>
              {llmTestResult && (
                <span className={`llm-test-result ${llmTestResult.ok ? 'ok' : 'fail'}`}>
                  {llmTestResult.ok ? '✓ ' : '✗ '}
                  {llmTestResult.text}
                </span>
              )}
            </div>
          </div>
          </SettingsSection>

          {/* ====== Agent 接入（MCP）——紧跟 AI 助手（Key 填充）之后：
              手动配 Key 走上面，不想管 Key 就用本区把 agent 接进来（模型由 agent 自带）。
              内嵌 MCP 服务器，让 Kimi CLI / Claude Code 等本机 agent 直接调用片语能力
              （读写故事板/看图自检/触发渲染）。仅绑 127.0.0.1 + Bearer token 鉴权；
              token 由主进程 safeStorage 加密存储，此处展示仅供本机复制配置。 */}
          <SettingsSection id="mcp" title="Agent 接入（MCP）" open={openSections.has('mcp')} onToggle={() => toggleSection('mcp')}>
          <div className="settings-item settings-item-row">
            <label className="settings-label">启用 MCP 服务</label>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={mcpStatus?.enabled ?? false}
                onChange={(e) => void handleMcpToggle(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
          <p className="settings-hint">
            启用后，本机的 AI agent（Kimi CLI / Claude Code 等）可读写故事板、查看画面、触发渲染与录屏；副作用操作（渲染/TTS/录屏）将自动执行，不再弹确认卡。仅监听本机回环地址（127.0.0.1），局域网/公网无法访问。
          </p>

          <div className="settings-item">
            <label className="settings-label">端口</label>
            <div className="settings-control">
              <input
                type="number"
                className="settings-text-input"
                min={1024}
                max={65535}
                value={mcpPortInput}
                onChange={(e) => setMcpPortInput(e.target.value)}
                onBlur={() => void handleMcpPortCommit()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleMcpPortCommit();
                }}
              />
            </div>
          </div>
          <p className="settings-hint">默认 17890；被占用时自动顺延。修改端口后服务自动重启生效。</p>

          <div className="settings-item">
            <label className="settings-label">
              服务状态
              <span className={`llm-key-status ${mcpStatus?.running ? 'configured' : ''}`}>
                {mcpStatus?.running ? '运行中' : '未运行'}
              </span>
            </label>
            <div className="settings-control">
              <span className="settings-path" title={mcpStatus?.url || ''}>
                {mcpStatus?.running ? mcpStatus.url : '（启用后显示接入地址）'}
              </span>
              {mcpStatus?.running && (
                <button className="btn-choose-dir" onClick={() => void handleMcpCopy('url', mcpStatus.url)}>
                  {mcpCopied === 'url' ? <Check size={13} /> : <Copy size={13} />} {mcpCopied === 'url' ? '已复制' : '复制'}
                </button>
              )}
            </div>
          </div>

          <div className="settings-item">
            <label className="settings-label">接入 Token</label>
            <div className="settings-control">
              <input
                type={mcpShowToken ? 'text' : 'password'}
                className="settings-text-input"
                readOnly
                value={mcpStatus?.token || ''}
              />
              <button className="btn-choose-dir" onClick={() => setMcpShowToken(!mcpShowToken)}>
                {mcpShowToken ? <EyeOff size={13} /> : <Eye size={13} />} {mcpShowToken ? '隐藏' : '显示'}
              </button>
              <button
                className="btn-choose-dir"
                disabled={!mcpStatus?.token}
                onClick={() => void handleMcpCopy('token', mcpStatus?.token || '')}
              >
                {mcpCopied === 'token' ? <Check size={13} /> : <Copy size={13} />} {mcpCopied === 'token' ? '已复制' : '复制'}
              </button>
              <button className="btn-choose-dir" onClick={() => void handleMcpRegenerateToken()}>
                <RefreshCw size={13} /> 重新生成
              </button>
            </div>
          </div>
          <p className="settings-hint">Token 是接入凭证，经系统安全存储加密后保存在本机；泄露后点「重新生成」即可作废旧 Token。</p>

          <div className="settings-item">
            <label className="settings-label">接入配置</label>
            <div className="settings-control">
              <button className="btn-choose-dir" disabled={!mcpStatus?.token} onClick={() => void handleMcpCopy('config', mcpConfigSnippet())}>
                {mcpCopied === 'config' ? <Check size={13} /> : <Copy size={13} />} {mcpCopied === 'config' ? '已复制' : '复制接入配置'}
              </button>
            </div>
          </div>
          <p className="settings-hint">粘贴到 Kimi CLI / Claude Code 的 MCP 配置（mcp.json）即可完成接入；仅支持 stdio 的旧客户端可用 npx mcp-remote 桥接，详见安装目录 MCP.md。</p>

          {/* ====== 一键接入 ======
              把当前服务地址与 token 直接写入本机已装 agent 的配置文件（主进程写前备份 + 原子写）。
              「已接入」的 agent 仍允许点击重写：token 重新生成 / 配置损坏后用于修复配置。 */}
          <div className="settings-item">
            <label className="settings-label">一键接入</label>
            <div className="mcp-agent-list">
              {mcpAgents.map((a) => (
                <div className="mcp-agent-row" key={a.id}>
                  <span className="mcp-agent-name" title={a.configPath}>{a.name}</span>
                  <span className={`llm-key-status ${a.installed && a.configured ? 'configured' : ''}`}>
                    {!a.installed ? '未检测到' : a.configured ? '已接入 ✓' : '未接入'}
                  </span>
                  <button
                    className="btn-choose-dir"
                    disabled={!a.installed}
                    onClick={() => void handleMcpInstallAgent(a.id)}
                  >
                    {a.configured ? '重新写入' : '一键接入'}
                  </button>
                </div>
              ))}
            </div>
            <div className="settings-control">
              <button
                className="btn-choose-dir"
                disabled={!mcpStatus?.token}
                onClick={() => void handleMcpCopy('instruct', mcpInstructText())}
              >
                {mcpCopied === 'instruct' ? <Check size={13} /> : <Copy size={13} />} {mcpCopied === 'instruct' ? '已复制' : '复制接入指令'}
              </button>
            </div>
          </div>
          {mcpAgentMsg && (
            <p className={`mcp-agent-msg ${mcpAgentMsg.ok ? 'ok' : 'error'}`}>{mcpAgentMsg.text}</p>
          )}
          <p className="settings-hint">「复制接入指令」可粘贴给任意 agent，让它照官网文档自行完成接入。写入配置后需重启对应 agent 才生效。服务端口被占用顺延时，下次启动片语会自动把已接入 agent 配置里的地址改写为实际端口（重新生成过 Token 的除外）。</p>

          {/* ====== TTS 语音合成 ======
              旁白轨的语音合成后端。支持任何提供 /audio/speech 的 OpenAI 兼容服务。
              baseUrl/model/voice 为明文设置项；API key 单独走 tts:setApiKey，主进程 safeStorage 加密，不回显。
              未配置时旁白仍可导入现成音频文件。 */}
          </SettingsSection>

          <SettingsSection id="tts" title="TTS 语音合成" open={openSections.has('tts')} onToggle={() => toggleSection('tts')}>

          {/* TTS 厂商预设：目前 OpenAI 兼容 /audio/speech 的国内厂商以硅基流动为主 */}
          <div className="settings-item">
            <label className="settings-label">快速填充</label>
            <PresetChipsRow
              presets={AI_PROVIDER_PRESETS.filter((p) => p.tts)}
              activeId={AI_PROVIDER_PRESETS.find((p) => p.tts?.baseUrl === settings.ttsBaseUrl.trim().replace(/\/+$/, ''))?.id ?? null}
              onPick={(p) => {
                if (!p.tts) return;
                handleUpdate({ttsBaseUrl: p.tts.baseUrl, ttsModel: p.tts.model, ttsVoice: p.tts.voice});
              }}
            />
            <p className="settings-hint">推荐硅基流动：与大模型同一家、同一个 API Key 即可配音（CosyVoice2 中文自然度较好）。</p>
          </div>

          <div className="settings-item">
            <label className="settings-label">服务地址 (Base URL)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="点上方快速填充，或粘贴 OpenAI 兼容端点"
              value={settings.ttsBaseUrl}
              onChange={(e) => handleUpdate({ttsBaseUrl: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">模型 (Model)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="tts-1"
              value={settings.ttsModel}
              onChange={(e) => handleUpdate({ttsModel: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">音色 (Voice)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="alloy"
              value={settings.ttsVoice}
              onChange={(e) => handleUpdate({ttsVoice: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">
              API Key
              <span className={`llm-key-status ${ttsKeyConfigured ? 'configured' : ''}`}>
                {ttsKeyConfigured ? '已配置' : '未配置'}
              </span>
            </label>
            <div className="settings-control">
              <input
                type="password"
                className="settings-text-input"
                placeholder={ttsKeyConfigured ? '已保存，输入新 Key 可覆盖' : 'sk-...'}
                value={ttsKeyInput}
                onChange={(e) => setTtsKeyInput(e.target.value)}
              />
              <button className="btn-choose-dir" onClick={handleSaveTtsKey} disabled={!ttsKeyInput.trim()}>
                {ttsKeySaved ? '已保存' : '保存'}
              </button>
              {ttsKeyConfigured && (
                <button className="btn-choose-dir" onClick={handleClearTtsKey}>清除</button>
              )}
            </div>
          </div>
          <p className="settings-hint">用于旁白轨的文字转语音。未配置时仍可导入现成音频作为旁白。</p>

          {/* ====== 语音识别（ASR）======
              「从素材识别字幕」的语音转文字后端。支持任何提供 /audio/transcriptions 的
              OpenAI 兼容服务。baseUrl/model 为明文设置项；API key 单独走 asr:setApiKey，
              主进程 safeStorage 加密，不回显。 */}
          </SettingsSection>

          <SettingsSection id="asr" title="语音识别 (ASR)" open={openSections.has('asr')} onToggle={() => toggleSection('asr')}>

          {/* ASR 厂商预设：SenseVoice 中文识别效果好且 OpenAI 兼容路径可用 */}
          <div className="settings-item">
            <label className="settings-label">快速填充</label>
            <PresetChipsRow
              presets={AI_PROVIDER_PRESETS.filter((p) => p.asr)}
              activeId={AI_PROVIDER_PRESETS.find((p) => p.asr?.baseUrl === settings.asrBaseUrl.trim().replace(/\/+$/, ''))?.id ?? null}
              onPick={(p) => {
                if (!p.asr) return;
                handleUpdate({asrBaseUrl: p.asr.baseUrl, asrModel: p.asr.model});
              }}
            />
            <p className="settings-hint">推荐硅基流动：与大模型同一个 API Key，中文识别（SenseVoice）效果好。</p>
          </div>

          <div className="settings-item">
            <label className="settings-label">服务地址 (Base URL)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="点上方快速填充，或粘贴 OpenAI 兼容端点"
              value={settings.asrBaseUrl}
              onChange={(e) => handleUpdate({asrBaseUrl: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">模型 (Model)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="whisper-1"
              value={settings.asrModel}
              onChange={(e) => handleUpdate({asrModel: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">
              API Key
              <span className={`llm-key-status ${asrKeyConfigured ? 'configured' : ''}`}>
                {asrKeyConfigured ? '已配置' : '未配置'}
              </span>
            </label>
            <div className="settings-control">
              <input
                type="password"
                className="settings-text-input"
                placeholder={asrKeyConfigured ? '已保存，输入新 Key 可覆盖' : 'sk-...'}
                value={asrKeyInput}
                onChange={(e) => setAsrKeyInput(e.target.value)}
              />
              <button className="btn-choose-dir" onClick={handleSaveAsrKey} disabled={!asrKeyInput.trim()}>
                {asrKeySaved ? '已保存' : '保存'}
              </button>
              {asrKeyConfigured && (
                <button className="btn-choose-dir" onClick={handleClearAsrKey}>清除</button>
              )}
            </div>
          </div>
          <p className="settings-hint">用于字幕面板的「从素材识别字幕」：把片段素材的语音转成字幕行。未配置时该功能不可用。</p>

          {/* ====== Stock 素材搜索 ======
              Pexels / Pixabay 免费商用免署名素材聚合搜索（AI 助手与 MCP 的
              search_stock_media / import_stock_media 工具）。API key 免费申请，
              safeStorage 加密存储；不配也能正常用其他功能。 */}
          </SettingsSection>

          <SettingsSection id="stock" title="Stock 素材搜索" open={openSections.has('stock')} onToggle={() => toggleSection('stock')}>

          <div className="settings-item">
            <label className="settings-label">
              Pexels API Key
              <span className={`llm-key-status ${pexelsKeyConfigured ? 'configured' : ''}`}>
                {pexelsKeyConfigured ? '已配置' : '未配置'}
              </span>
            </label>
            <div className="settings-control">
              <input
                type="password"
                className="settings-text-input"
                placeholder={pexelsKeyConfigured ? '已保存，输入新 Key 可覆盖' : '在 pexels.com/api 免费申请'}
                value={pexelsKeyInput}
                onChange={(e) => setPexelsKeyInput(e.target.value)}
              />
              <button
                className="btn-choose-dir"
                onClick={async () => {
                  const key = pexelsKeyInput.trim();
                  if (!key) return;
                  await window.api.stockSetApiKey('pexels', key);
                  setPexelsKeyInput('');
                  setPexelsKeyConfigured(true);
                  setPexelsKeySaved(true);
                  setTimeout(() => setPexelsKeySaved(false), 2000);
                }}
                disabled={!pexelsKeyInput.trim()}
              >
                {pexelsKeySaved ? '已保存' : '保存'}
              </button>
              {pexelsKeyConfigured && (
                <button className="btn-choose-dir" onClick={async () => {
                  await window.api.stockSetApiKey('pexels', '');
                  setPexelsKeyConfigured(false);
                }}>清除</button>
              )}
            </div>
          </div>

          <div className="settings-item">
            <label className="settings-label">
              Pixabay API Key
              <span className={`llm-key-status ${pixabayKeyConfigured ? 'configured' : ''}`}>
                {pixabayKeyConfigured ? '已配置' : '未配置'}
              </span>
            </label>
            <div className="settings-control">
              <input
                type="password"
                className="settings-text-input"
                placeholder={pixabayKeyConfigured ? '已保存，输入新 Key 可覆盖' : '在 pixabay.com/api/docs 免费申请'}
                value={pixabayKeyInput}
                onChange={(e) => setPixabayKeyInput(e.target.value)}
              />
              <button
                className="btn-choose-dir"
                onClick={async () => {
                  const key = pixabayKeyInput.trim();
                  if (!key) return;
                  await window.api.stockSetApiKey('pixabay', key);
                  setPixabayKeyInput('');
                  setPixabayKeyConfigured(true);
                  setPixabayKeySaved(true);
                  setTimeout(() => setPixabayKeySaved(false), 2000);
                }}
                disabled={!pixabayKeyInput.trim()}
              >
                {pixabayKeySaved ? '已保存' : '保存'}
              </button>
              {pixabayKeyConfigured && (
                <button className="btn-choose-dir" onClick={async () => {
                  await window.api.stockSetApiKey('pixabay', '');
                  setPixabayKeyConfigured(false);
                }}>清除</button>
              )}
            </div>
          </div>
          <p className="settings-hint">
            配置后 AI 助手与接入的 agent 可搜索/下载免费商用免署名素材（search_stock_media 工具）。两家 Key 都免费申请，配一家即可，两家都配则聚合搜索。
          </p>

          {/* ====== 文生图 ======
              OpenAI 兼容 /images/generations 端点。与 AI 助手共用服务地址与 API Key
              （聚合网关普遍同端点提供），仅模型名单独配置。 */}
          </SettingsSection>

          <SettingsSection id="image" title="文生图" open={openSections.has('image')} onToggle={() => toggleSection('image')}>

          {/* 文生图厂商预设：与 AI 助手共用 API Key，选了「一家配齐」厂商即零额外配置 */}
          <div className="settings-item">
            <label className="settings-label">快速填充</label>
            <PresetChipsRow
              presets={AI_PROVIDER_PRESETS.filter((p) => p.image)}
              activeId={AI_PROVIDER_PRESETS.find((p) => p.image?.baseUrl === (settings.imageGenBaseUrl.trim() || settings.llmBaseUrl.trim()).replace(/\/+$/, ''))?.id ?? null}
              onPick={(p) => {
                if (!p.image) return;
                handleUpdate({imageGenBaseUrl: p.image.baseUrl, imageGenModel: p.image.model});
              }}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">模型 (Model)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="dall-e-3（视服务商支持而定）"
              value={settings.imageGenModel}
              onChange={(e) => handleUpdate({imageGenModel: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">服务地址覆盖（可选）</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="留空 = 用 AI 助手的服务地址"
              value={settings.imageGenBaseUrl}
              onChange={(e) => handleUpdate({imageGenBaseUrl: e.target.value})}
            />
          </div>
          <p className="settings-hint">
            与 AI 助手共用服务地址与 API Key，仅模型名单独配置（generate_image 工具）。生成结果按提示词哈希缓存在本机，重复生成不重复计费。
          </p>

          {/* ====== 文生 3D ======
              Meshy 兼容 Text-to-3D：文本提示词 → .glb 模型素材，直接进故事板
              （generate_model 工具，配 ModelTurntable 等 3D 模板）。Key 独立于
              AI 助手（服务商不同），safeStorage 加密存储。 */}
          </SettingsSection>

          <SettingsSection id="modelgen" title="文生 3D" open={openSections.has('modelgen')} onToggle={() => toggleSection('modelgen')}>

          <div className="settings-item">
            <label className="settings-label">服务地址 (Base URL)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="https://api.meshy.ai"
              value={settings.modelGenBaseUrl}
              onChange={(e) => handleUpdate({modelGenBaseUrl: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">模型 (Model)</label>
            <input
              type="text"
              className="settings-text-input"
              placeholder="meshy-4"
              value={settings.modelGenModel}
              onChange={(e) => handleUpdate({modelGenModel: e.target.value})}
            />
          </div>

          <div className="settings-item">
            <label className="settings-label">
              API Key
              <span className={`llm-key-status ${modelGenKeyConfigured ? 'configured' : ''}`}>
                {modelGenKeyConfigured ? '已配置' : '未配置'}
              </span>
            </label>
            <div className="settings-control">
              <input
                type="password"
                className="settings-text-input"
                placeholder={modelGenKeyConfigured ? '已保存，输入新 Key 可覆盖' : 'msy-...'}
                value={modelGenKeyInput}
                onChange={(e) => setModelGenKeyInput(e.target.value)}
              />
              <button className="btn-choose-dir" onClick={handleSaveModelGenKey} disabled={!modelGenKeyInput.trim()}>
                {modelGenKeySaved ? '已保存' : '保存'}
              </button>
              {modelGenKeyConfigured && (
                <button className="btn-choose-dir" onClick={handleClearModelGenKey}>清除</button>
              )}
            </div>
          </div>
          <p className="settings-hint">
            文本提示词生成 .glb 3D 模型素材并直接进故事板（generate_model 工具）。Key 到 meshy.ai 申请（与 AI 助手的 Key 相互独立）；换 Tripo 等 Meshy 兼容服务时只改服务地址与模型名。生成结果按提示词哈希缓存在本机，重复生成不重复计费。
          </p>
          </SettingsSection>

          {/* 高级设置（折叠）。授权服务器地址仅供开发联调：生产构建会被主进程忽略，
              指向伪造服务端即可白嫖授权，故打包后整段隐藏 */}
          {!isPackaged && (
            <>
              <div className="settings-advanced-toggle">
                <button className="settings-advanced-btn" onClick={() => setShowAdvanced(!showAdvanced)}>
                  {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />} 高级
                </button>
              </div>
              {showAdvanced && (
                <>
                  <div className="settings-item">
                    <label className="settings-label">授权服务器地址</label>
                    <input
                      type="text"
                      className="settings-text-input"
                      placeholder="留空使用默认服务器"
                      value={settings.licenseServerUrl || ''}
                      onChange={(e) => handleUpdate({licenseServerUrl: e.target.value})}
                    />
                  </div>
                  <p className="settings-hint">用于激活/校验授权码的服务端地址（仅开发环境生效），例如 http://127.0.0.1:8787</p>
                </>
              )}
            </>
          )}
        </div>

        <div className="settings-footer">
          <button
            className="btn-reset"
            onClick={() => {
              // 恢复默认只重置常规偏好；AI 助手/TTS/ASR 的服务地址与模型（及授权服务器地址）
              // 属于环境配置，被一键清掉用户很难发觉，予以保留
              if (!window.confirm('确定恢复默认设置吗？（AI 助手 / TTS / ASR 的服务配置会保留）')) return;
              handleUpdate({
                ...DEFAULT_SETTINGS,
                llmBaseUrl: settings.llmBaseUrl,
                llmModel: settings.llmModel,
                llmModelEdit: settings.llmModelEdit,
                ttsBaseUrl: settings.ttsBaseUrl,
                ttsModel: settings.ttsModel,
                ttsVoice: settings.ttsVoice,
                asrBaseUrl: settings.asrBaseUrl,
                asrModel: settings.asrModel,
                imageGenModel: settings.imageGenModel,
                imageGenBaseUrl: settings.imageGenBaseUrl,
                modelGenBaseUrl: settings.modelGenBaseUrl,
                modelGenModel: settings.modelGenModel,
                licenseServerUrl: settings.licenseServerUrl,
              });
            }}
          >
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
};

/** 厂商预设 chip 行：点一下填好该分区的端点/模型/音色（Key 仍由用户粘贴，永不内置） */
const PresetChipsRow: React.FC<{
  presets: AiProviderPreset[];
  activeId: string | null;
  onPick: (p: AiProviderPreset) => void;
}> = ({presets, activeId, onPick}) => (
  <div className="settings-preset-row">
    {presets.map((p) => (
      <button
        key={p.id}
        type="button"
        className={`settings-preset-chip ${activeId === p.id ? 'active' : ''}`}
        title={p.note}
        onClick={() => onPick(p)}
      >
        {p.name}
        {p.freeNote && <span className="settings-preset-badge">免费</span>}
      </button>
    ))}
  </div>
);

export default SettingsModal;
