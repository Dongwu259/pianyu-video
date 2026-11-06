/**
 * AIAssistantPanel — AI 助手聊天面板（右侧抽屉）
 *
 * 对话循环：用户消息 → llmChat（带工具 schema）→ 若返回 tool_calls 则本地执行
 * （执行器查表在 ai/toolExecutors，故事板状态在 zustand，校验器在 shared/llm-tools），
 * 把结果以 role:'tool' 追加后再发给模型，直到无 tool_calls、达到 30 轮上限或用户取消（防死循环）。
 * baseUrl/model 由主进程自查全局设置（不信任渲染端入参）；任何提前退出路径都会为
 * 未应答的 tool_calls 补 role:tool 消息，保证对话历史始终合法。
 *
 * 对话持久化：界面消息与 API 历史存 chatStore（localStorage），关闭面板/重启应用
 * 都不丢；恢复时经 sanitizeRestoredHistory 修复崩溃造成的悬空 tool_calls。
 * 历史过长（>AUTO_COMPACT_THRESHOLD_CHARS）在每轮对话结束后自动压缩成摘要，也可手动压缩；
 * 支持导出（Markdown 人读版 / JSON 往返版）与导入恢复。
 *
 * YOLO 完全权限：开关持久化在 chatStore。开启后所有工具确认（含全自动流水线入口、
 * 录屏/截屏/TTS 等副作用）自动允许、渲染确认卡自动开始渲染——与 MCP 桥
 * 「持有 token 即信任」同口径，供无人值守的批量/自动流程使用。
 *
 * request_render 工具不直接渲染：在面板插入确认卡（YOLO 时自动开始），用户点击
 * 「开始渲染」后走 useStartRender（与渲染导出页同一套组装，主进程授权闸门不变）。
 * 渲染结束（成功/失败/取消）会把结果作为 user 消息回传对话历史，模型下一轮可据
 * 此继续（如 view_media_frames 抽查成片画面）。
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useProjectStore} from '../store/projectStore';
import {useChatStore} from '../store/chatStore';
import {useStartRender} from '../hooks/useStartRender';
import type {StartRenderResult} from '../hooks/useStartRender';
import {createLlmTools, filterToolDefsForEdge} from '../../shared/llm-tools';
import {buildSystemPrompt} from '../../shared/llm-prompt';
import {isLlmLoopback} from '../../shared/llm-chat';
import {routeEdgeModel} from '../../shared/edge-router';
import {createImageBudget} from '../../shared/image-budget';
import {compactConversation, shouldCompact} from '../../shared/conversation-compact';
import {mergeTemplateMetas} from '../../shared/template-registry';
import {VIDEO_TYPE_LABEL} from '../../shared/video-type';
import {TRANSITION_OPTIONS, VIDEO_EFFECT_OPTIONS, BACKGROUND_EFFECT_OPTIONS, TEXT_ANIM_OPTIONS} from '../../shared/types';
import type {LlmChatMessage, LlmToolCall, ContentPart} from '../../shared/llm-chat';
import {
  type UiMsg,
  AUTO_COMPACT_THRESHOLD_CHARS,
  estimateHistoryChars,
  findCompactionCut,
  buildCompactionMessages,
  applyCompaction,
  sanitizeRestoredHistory,
  serializeChatMarkdown,
  buildChatArchive,
  parseChatArchive,
} from '../../shared/chat-history';
import {executeLlmTool} from '../ai/toolExecutors';
import type {ToolExecResult} from '../ai/toolExecutors';
import {buildDemoStoryboardSpecs, demoStoryboardMessage} from '../ai/demoStoryboard';
import {AI_PROVIDER_PRESETS, getAiProviderPreset} from '../../shared/ai-presets';
import {Sparkles, X, Send, Loader2, Wrench, Play, FolderOpen, Zap, Archive, Download, Upload, Plus, LayoutTemplate} from 'lucide-react';
import './AIAssistantPanel.css';
import {BriefTemplateModal} from './BriefTemplateModal';

/** 最多允许的 LLM 调用轮次（agent 多步：看图/截片/旁白/自检/渲染，给足空间） */
const MAX_ROUNDS = 30;

/** 「一键成片」快捷按钮的预设指令（不走输入框，直接作为用户消息发送） */
const ONE_CLICK_PROMPT = `请一键成片：基于当前故事板已有素材直接做出完整成片，全程不要向我提问（除非故事板里完全没有任何素材，那就告诉我需要先上传素材或用录屏/截屏工具制作）。按顺序自主执行：
1. 用 get_storyboard / get_segment_media（必要时 view_segment_frame）盘点每段素材；
2. 为每段挑选最合适的模板，并用 customParams 刻意调好参数（如画框大小、运镜速度），不要全用默认值；已有素材的片段用 update_segment 修改，不要用 set_storyboard 重建（会丢素材）；
3. 写精炼有冲击力的中文文案：update_segment 设置标题/副标题/要点与旁白，set_segment_captions 配好烧录字幕；
4. 明显需要时用 set_logo 调整 Logo、set_bgm_ducking 开启 BGM 避让；
5. 完成后调用 request_render 请求渲染。
所有选择自行决定，最后在回复里说明你的假设即可。`;

let msgSeq = 0;
const nextId = () => `m-${Date.now()}-${msgSeq++}`;

/** Electron invoke 抛错会带前缀，剥掉只留中文正文 */
const toUserError = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

/** 导出文件名时间戳（20260824-1530 形式） */
const fileStamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** 历史中最多保留的含图消息条数（每张抽帧 base64 很大，旧图替换为文字占位，防上下文无限膨胀） */
const KEEP_IMAGE_MESSAGES = 2;

/** 把较旧含图消息里的 image_url 片段替换为文字占位（就地修改，保留最近 KEEP_IMAGE_MESSAGES 条不动） */
const pruneImageMessages = (msgs: LlmChatMessage[]): void => {
  const imgIdx: number[] = [];
  msgs.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')) imgIdx.push(i);
  });
  for (const i of imgIdx.slice(0, Math.max(0, imgIdx.length - KEEP_IMAGE_MESSAGES))) {
    const m = msgs[i];
    if (Array.isArray(m.content)) {
      m.content = m.content.map((p): ContentPart =>
        p.type === 'image_url'
          ? {type: 'text', text: '（历史画面图片已省略以节省上下文，如需再看请重新调用 view_segment_frame、view_media_frames 或 take_screenshot）'}
          : p,
      );
    }
  }
};

/** 渲染确认卡：request_render 工具触发，用户点击后才真正渲染；结束后经 onDone 把结果回传对话。
 *  YOLO 模式下 autoStart=true，挂载即自动开始（无人值守）。 */
const RenderConfirmCard: React.FC<{
  onCancel: () => void;
  onDone: (result: StartRenderResult) => void;
  autoStart?: boolean;
}> = ({onCancel, onDone, autoStart}) => {
  const startRenderJob = useStartRender();
  const isRendering = useProjectStore((s) => s.isRendering);
  const renderProgress = useProjectStore((s) => s.renderProgress);
  const [phase, setPhase] = useState<'pending' | 'rendering' | 'done' | 'failed'>('pending');
  const [outputPath, setOutputPath] = useState('');
  const [error, setError] = useState('');

  const handleStart = useCallback(async () => {
    // 重入保护：渲染进行中（含渲染导出页等其它入口发起的）不重复触发
    if (useProjectStore.getState().isRendering) return;
    setPhase('rendering');
    setError('');
    const dir = useProjectStore.getState().appSettings.defaultOutputDir || '';
    const result = await startRenderJob(dir);
    if (result.success) {
      setOutputPath(result.outputPath || '');
      setPhase('done');
    } else if (result.cancelled) {
      // 用户取消不视为失败：卡片回到待确认态，可再次点击开始
      setPhase('pending');
    } else {
      setError(result.error || '渲染失败，请重试');
      setPhase('failed');
    }
    // 成功/失败/取消都回传对话：模型需要知道渲染结果才能继续（如抽查成片画面）
    onDone(result);
  }, [startRenderJob, onDone]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void handleStart();
    }
  }, [autoStart, handleStart]);

  return (
    <div className="ai-render-card">
      <div className="ai-render-card-title">
        <Play size={14} /> AI 请求开始渲染{autoStart ? '（YOLO 自动执行）' : ''}
      </div>
      {phase === 'pending' && (
        <div className="ai-render-card-actions">
          <button className="ai-btn-primary" onClick={handleStart} disabled={isRendering}>
            开始渲染
          </button>
          <button className="ai-btn-ghost" onClick={onCancel}>取消</button>
        </div>
      )}
      {phase === 'rendering' && (
        <div className="ai-render-card-progress">
          <div className="ai-progress-bar">
            <div className="ai-progress-fill" style={{width: `${renderProgress}%`}} />
          </div>
          <span className="ai-progress-text">
            <Loader2 size={12} className="icon-spin" /> 渲染中… {Math.round(renderProgress)}%
          </span>
        </div>
      )}
      {phase === 'done' && (
        <div className="ai-render-card-result">
          <span className="ai-render-ok">渲染完成</span>
          <span className="ai-render-path" title={outputPath}>{outputPath}</span>
          <button className="ai-btn-ghost" onClick={() => window.api.openInExplorer(outputPath)}>
            <FolderOpen size={12} /> 在文件夹中显示
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="ai-render-card-result">
          <span className="ai-render-fail">{error}</span>
          <button className="ai-btn-primary" onClick={handleStart} disabled={isRendering}>重试</button>
        </div>
      )}
    </div>
  );
};

interface AIAssistantPanelProps {
  onClose: () => void;
  /** 引导用户去设置页；带分区参数时设置弹窗打开后直接滚动定位（'mcp' = Agent 接入，'ai' = AI 助手手动配置） */
  onOpenSettings: (section?: 'ai' | 'mcp') => void;
}

export const AIAssistantPanel: React.FC<AIAssistantPanelProps> = ({onClose, onOpenSettings}) => {
  // 对话历史在 chatStore（localStorage 持久化），面板卸载不丢；这里只订阅渲染
  const uiMessages = useChatStore((s) => s.uiMessages);
  const yolo = useChatStore((s) => s.yolo);
  const [input, setInput] = useState('');
  // 场景提示词模板弹窗（三期后半 · 官方提示词模板商店）
  const [showBriefModal, setShowBriefModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 历史压缩进行中（自动/手动共用） */
  const [compacting, setCompacting] = useState(false);
  /** null = 正在检查配置 */
  const [configured, setConfigured] = useState<boolean | null>(null);
  /** 本机已装的 MCP agent 名单（未配置引导里展示，让「推荐 MCP」落地为具体选项） */
  const [detectedAgents, setDetectedAgents] = useState<string[]>([]);
  const [renderRequested, setRenderRequested] = useState(false);
  /** AI 副作用工具的用户确认卡（录屏/截屏/TTS）：非 null 时工具执行器正等待用户点击 */
  const [pendingConfirm, setPendingConfirm] = useState<{label: string; detail?: string} | null>(null);
  /** 确认卡的 Promise resolver；取消对话/关闭面板时需以 false 释放等待中的工具执行器 */
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  /** 发给 API 的完整对话历史（首条为 system），用 ref 避免循环中读旧 state。
   *  惰性初始化：store 里有上次的历史则恢复（崩溃残留的悬空 tool_calls 先修复）。 */
  const apiMessagesRef = useRef<LlmChatMessage[] | null>(null);
  /** 看图预算（会话级）：清空/导入对话时重建（见 shared/image-budget.ts，防重复抽帧烧上下文） */
  const imageBudgetRef = useRef(createImageBudget());
  /** 工作草稿本（scratch_pad 工具后端）：localStorage 持久化，随工程跨会话存活。
   *  上下文被自动压缩时注入压缩边界，模型无需记住每步细节即可续接工作。 */
  const scratchpadRef = useRef({
    read: () => { try { return localStorage.getItem('pianyu-scratchpad') ?? ''; } catch { return ''; } },
    write: (s: string) => { try { localStorage.setItem('pianyu-scratchpad', s); } catch { /* 存储不可用时草稿退化为会话级 */ } },
  });
  if (apiMessagesRef.current === null) {
    const saved = useChatStore.getState().apiMessages;
    apiMessagesRef.current = [
      {role: 'system', content: buildSystemPrompt()},
      ...(saved.length > 0 ? sanitizeRestoredHistory(saved) : []),
    ];
  }
  const scrollRef = useRef<HTMLDivElement>(null);

  /** API 历史追加 + 同步持久化（面板内所有入历史的地方都走这里） */
  const pushApi = useCallback((m: LlmChatMessage) => {
    apiMessagesRef.current!.push(m);
    useChatStore.getState().syncApi(apiMessagesRef.current!);
  }, []);

  const pushUi = useCallback((msg: Omit<UiMsg, 'id'>) => {
    useChatStore.getState().pushUi({...msg, id: nextId()});
  }, []);

  // 体裁切换后重建 system 提示词（身份/剧本分册/模板清单随体裁变化；其余对话历史保留）；
  // 本地端点检测翻转时同样重建（自适应端侧档精简提示词）
  const videoType = useProjectStore((s) => s.videoType);
  const [localEndpoint, setLocalEndpoint] = useState(false);
  // 双模型路由：主模型 + 编辑模型（设置里配了编辑模型才启用；null = 单模型）
  const [edgeModels, setEdgeModels] = useState<{main: string; edit: string} | null>(null);
  const systemPrompt = useCallback(
    (vt: Parameters<typeof buildSystemPrompt>[0]) => buildSystemPrompt(vt, {edge: localEndpoint}),
    [localEndpoint],
  );
  useEffect(() => {
    apiMessagesRef.current![0] = {role: 'system', content: systemPrompt(videoType)};
  }, [videoType, systemPrompt]);

  // 工具 schema 与校验器（模板/枚举清单来自注册表，与应用内真实选项一致；
  // 模板列表 = 内置 + 自定义 + 已装市场模板 + AI 生成模板，随安装/删除动态更新）
  const customTemplates = useProjectStore((s) => s.customTemplates);
  const marketTemplates = useProjectStore((s) => s.marketTemplates);
  const generatedTemplates = useProjectStore((s) => s.generatedTemplates);
  const llm = useMemo(
    () =>
      createLlmTools({
        templates: mergeTemplateMetas(customTemplates, marketTemplates, generatedTemplates),
        transitions: TRANSITION_OPTIONS.map((t) => t.value),
        videoEffects: VIDEO_EFFECT_OPTIONS.map((e) => e.value),
        backgroundEffects: BACKGROUND_EFFECT_OPTIONS.map((e) => e.value),
        textAnims: TEXT_ANIM_OPTIONS.map((a) => a.value),
      }),
    [customTemplates, marketTemplates, generatedTemplates],
  );

  // 进入面板时检查配置：API key（主进程托管）+ baseUrl/model（明文设置项）；
  // 端点为 loopback（Ollama/llama.cpp 本地自托管）时自动启用端侧档：精简工具面 + 精简提示词
  const checkConfigured = useCallback(async () => {
    try {
      const status = await window.api.llmGetStatus();
      setConfigured(Boolean(status.configured && status.baseUrl?.trim() && status.model?.trim()));
      setLocalEndpoint(isLlmLoopback(status.baseUrl ?? ''));
      setEdgeModels(status.model?.trim() ? {main: status.model.trim(), edit: (status.editModel ?? '').trim()} : null);
    } catch {
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    checkConfigured();
  }, [checkConfigured]);

  // 未配置时探测本机已装的 MCP agent（探测失败静默——引导卡只是少一行提示，不影响主流程）
  useEffect(() => {
    if (configured !== false) return;
    window.api.mcpListAgents()
      .then((r) => setDetectedAgents(r.agents.filter((a) => a.installed).map((a) => a.name)))
      .catch(() => {});
  }, [configured]);

  // 新消息时滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight});
  }, [uiMessages, loading, renderRequested, pendingConfirm, compacting]);

  /** 渲染确认卡结束（成功/失败/取消）后把结果回传对话：注入 API 历史 + 界面系统样式消息 */
  const handleRenderDone = useCallback(
    (result: StartRenderResult) => {
      const text = result.success
        ? `[渲染结果] 成功，输出路径：${result.outputPath}；你可以用 view_media_frames 查看成片任意时刻的画面（路径即上面的输出路径）`
        : result.cancelled
          ? '[渲染结果] 用户取消了渲染'
          : `[渲染结果] 失败：${result.error || '未知原因'}`;
      pushApi({role: 'user', content: text});
      pushUi({role: 'system', content: text});
    },
    [pushApi, pushUi],
  );

  /** 确认卡点击：释放工具执行器中等待的 Promise（true=允许执行，false=拒绝） */
  const answerConfirm = (ok: boolean) => {
    confirmResolverRef.current?.(ok);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  };

  /** 用户取消标记：取消按钮/关闭面板/组件卸载时置位，agent 循环在每个 await 后检查 */
  const cancelledRef = useRef(false);

  /** 请求取消：中断 agent 循环，并通知主进程 abort 进行中的 fetch */
  const requestCancel = useCallback(() => {
    cancelledRef.current = true;
    window.api.llmCancel().catch(() => {});
    // 有等待中的确认卡时以「拒绝」释放，否则工具执行器永远挂起、循环无法退出
    confirmResolverRef.current?.(false);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }, []);

  // 卸载（关闭面板）时中止进行中的对话循环（历史已实时持久化，不丢）
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      window.api.llmCancel().catch(() => {});
    };
  }, []);

  /** 关闭面板：先停掉进行中的对话循环再走 onClose */
  const handleClose = useCallback(() => {
    requestCancel();
    onClose();
  }, [requestCancel, onClose]);

  /** 压缩历史对话：把切割点之前的消息经 LLM 摘要成一段 system 消息。
   *  auto=true 为每轮对话结束后的自动触发（失败静默）；false 为手动按钮（有结果提示）。 */
  const runCompaction = useCallback(
    async (auto: boolean) => {
      const msgs = apiMessagesRef.current!;
      const cut = findCompactionCut(msgs);
      if (cut <= 0) {
        if (!auto) pushUi({role: 'system', content: '当前对话不长，无需压缩（至少要有几十轮对话才有压缩空间）'});
        return;
      }
      const removed = msgs.slice(1, cut);
      setCompacting(true);
      try {
        const reply = await window.api.llmChat({messages: buildCompactionMessages(removed)});
        const summary = typeof reply.content === 'string' ? reply.content.trim() : '';
        if (!summary) throw new Error('模型没有返回摘要');
        apiMessagesRef.current = applyCompaction(msgs, cut, summary);
        useChatStore.getState().syncApi(apiMessagesRef.current);
        pushUi({
          role: 'system',
          content: `已压缩历史对话：${removed.length} 条较早消息 → 摘要（释放约 ${estimateHistoryChars(removed).toLocaleString()} 字符上下文）`,
        });
      } catch (err) {
        pushUi({role: 'system', content: `压缩对话历史失败（不影响当前对话）：${toUserError(err)}`});
      } finally {
        setCompacting(false);
      }
    },
    [pushUi],
  );

  /** 发送一条用户消息并跑工具调用循环（快捷提示按钮也走这里） */
  const handleSend = useCallback(
    async (text: string) => {
      const content = text.trim();
      // compacting 期间不发：压缩会整体替换历史数组，与对话循环并发会互相踩
      if (!content || loading || compacting) return;

      // 发送前再确认一次配置（用户可能刚在设置页填好）；baseUrl/model 由主进程自查设置，不经渲染端传参
      const status = await window.api.llmGetStatus().catch(() => null);
      if (!status?.configured || !status.baseUrl?.trim() || !status.model?.trim()) {
        setConfigured(false);
        setError('尚未完成 AI 助手配置：推荐在「设置 → Agent 接入（MCP）」一键接入本机 agent（模型由 agent 自带，免填地址与 Key），或在「设置 → AI 助手」手动填写服务地址、模型与 API Key');
        return;
      }

      setInput('');
      setError('');
      pushUi({role: 'user', content});
      pushApi({role: 'user', content});
      setLoading(true);
      cancelledRef.current = false;
      // 双模型路由（规则版）：空工程/创作意图词→主模型（创作），其余→编辑模型（分错代价不对称，向编辑兜底）。
      // 一轮对话只路由一次，工具轮次中途不换模型；压缩与看图中继不路由（辅助脑跟随主模型设置）。
      const edgeRoute = localEndpoint && edgeModels
        ? routeEdgeModel({
            userText: content,
            segmentCount: useProjectStore.getState().segments.length,
            defaultModel: edgeModels.main,
            editModel: edgeModels.edit,
          })
        : null;

      const finishCancelled = () => pushUi({role: 'assistant', content: '已取消'});

      /**
       * 为一组未应答的 tool_calls 补 role:tool 中止/错误消息。
       * 任何提前退出路径（轮次上限/取消）都必须先调用：assistant 消息带了 tool_calls
       * 却没有对应 tool 消息时，之后所有请求会被 API 以 400 拒绝，只能重开面板。
       */
      const abortToolCalls = (calls: LlmToolCall[], reason: string) => {
        for (const c of calls) {
          pushApi({
            role: 'tool',
            tool_call_id: c.id,
            content: JSON.stringify({ok: false, errors: [reason]}),
          });
        }
      };

      let injectedImageCount = 0;
      try {
        for (let round = 1; round <= MAX_ROUNDS; round++) {
          if (cancelledRef.current) {
            finishCancelled();
            return;
          }
          // EDGE（本地端点）：发送前按需压缩历史——system/首条 user/最近若干条完整保留，
          // 更早的 tool 结果截断、帧图换占位；压缩边界注入草稿本，工作状态不丢（见 shared/conversation-compact.ts）
          const pad = scratchpadRef.current.read();
          const outgoing = localEndpoint && shouldCompact(apiMessagesRef.current!)
            ? compactConversation(apiMessagesRef.current!, {
                keepLast: 10,
                boundaryNote: `【自动压缩】更早的对话已省略（工具结果截断、帧图移除）。你的工作草稿（可用 scratch_pad 读写）：\n${pad || '（空——建议现在用 scratch_pad 补记已完成与待办）'}`,
              })
            : apiMessagesRef.current!;
          const reply = await window.api.llmChat({
            messages: outgoing,
            tools: localEndpoint ? filterToolDefsForEdge(llm.toolDefs) : llm.toolDefs,
            ...(edgeRoute?.model ? {model: edgeRoute.model} : {}),
          });
          // assistant 消息原样入历史（含 tool_calls，供后续 tool 消息对应）
          pushApi(reply);

          const toolCalls = reply.tool_calls ?? [];
          const text2 = typeof reply.content === 'string' ? reply.content.trim() : '';
          if (toolCalls.length === 0) {
            // 无工具调用 = 最终回复，结束循环
            if (cancelledRef.current) {
              finishCancelled();
              return;
            }
            if (text2) pushUi({role: 'assistant', content: text2});
            return;
          }
          if (round >= MAX_ROUNDS) {
            // 退出前补上未执行的 tool 结果，保持历史合法
            abortToolCalls(toolCalls, '已达对话轮次上限，工具未执行');
            pushUi({role: 'assistant', content: '已达对话轮次上限，请补充说明后继续'});
            return;
          }

          // 有工具调用：展示文本（如有）+ 工具折叠卡，本地逐个执行后回发结果
          const toolNames = toolCalls.map((c) => c.function.name);
          pushUi({role: 'assistant', content: text2 || undefined, toolNames});
          const roundImages: {dataUrl: string; note: string}[] = [];
          for (let ci = 0; ci < toolCalls.length; ci++) {
            if (cancelledRef.current) {
              // 为剩余未应答的 tool_call 补中止消息，保持历史合法
              abortToolCalls(toolCalls.slice(ci), '用户已取消，工具未执行');
              finishCancelled();
              return;
            }
            const call = toolCalls[ci];
            let out: ToolExecResult;
            try {
              out = await executeLlmTool(call.function.name, call.function.arguments, {
                llm,
                getStore: () => useProjectStore.getState(),
                imageBudget: imageBudgetRef.current,
                // 草稿本后端（scratch_pad 工具）：localStorage 持久化，压缩边界自动带回
                scratchpad: scratchpadRef.current,
                // 视觉中继（决策脑/看图脑分离，仅 EDGE）：帧不进主上下文，由看图子会话出文字结论。
                // 注意分布：当前微调模型按「主对话直接看图」训练，中继开启属新分布，需下一轮蒸馏补看图评估轨迹
                visionRelay: localEndpoint ? async (frames, question) => {
                  try {
                    const r = await window.api.llmChat({
                      messages: [
                        {role: 'system', content: '你是片语的画面评估器。只输出简明客观的评估结论，不调用任何工具，不复述问题，不寒暄。'},
                        {role: 'user', content: [
                          {type: 'text' as const, text: question},
                          ...frames.map((f) => ({type: 'image_url' as const, image_url: {url: f.dataUrl}})),
                        ]},
                      ],
                    });
                    const t = typeof r.content === 'string' ? r.content.trim() : '';
                    return t || '（看图评估无输出，请基于其他信息决策）';
                  } catch {
                    return '（看图评估调用失败，请基于其他信息决策）';
                  }
                } : undefined,
                onRequestRender: () => setRenderRequested(true),
                // 副作用工具的用户确认：YOLO 时直接允许（与 MCP 桥同口径），
                // 否则弹卡等待点击，拒绝则工具收到「用户拒绝」
                requestConfirm: (label, detail) =>
                  useChatStore.getState().yolo
                    ? Promise.resolve(true)
                    : new Promise<boolean>((resolve) => {
                        confirmResolverRef.current = resolve;
                        setPendingConfirm({label, detail});
                      }),
              });
            } catch (toolErr) {
              // 工具执行中途抛错也要回 tool 消息（缺了它后续请求同样会被 API 400 拒绝）
              out = {result: {ok: false, errors: [`工具执行出错：${toUserError(toolErr)}`]}};
            }
            pushApi({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(out.result),
            });
            if (out.image) roundImages.push(out.image);
            if (out.images) roundImages.push(...out.images);
          }
          if (cancelledRef.current) {
            finishCancelled();
            return;
          }
          // 「看图」注入：所有工具结果之后，作为下一条 user 消息携带 image_url，
          // 让视觉模型在下一轮看到画面。非多模态模型若报错，下方 catch 会给提示。
          for (const img of roundImages) {
            const parts: ContentPart[] = [
              {type: 'text', text: `（系统附图：${img.note}。请据此判断画面内容，决定是否裁剪/取景。若你的模型不支持视觉，此图无法识别，可忽略并改用 get_segment_media 查看元数据。）`},
              {type: 'image_url', image_url: {url: img.dataUrl}},
            ];
            pushApi({role: 'user', content: parts});
            injectedImageCount++;
          }
          // 图片消息修剪：只保留最近几张含图消息，更早的 base64 替换为文字占位
          pruneImageMessages(apiMessagesRef.current!);
          useChatStore.getState().syncApi(apiMessagesRef.current!);
        }
      } catch (err) {
        if (cancelledRef.current) {
          // 用户取消：主进程 abort 触发的报错不展示（此时历史停在 user/tool 消息上，合法）
          finishCancelled();
          return;
        }
        const msg = toUserError(err);
        // 若本轮注入过图片且请求失败，多半是模型不支持视觉内容
        if (injectedImageCount > 0 && /image|vision|视觉|multimodal|content|400|422/i.test(msg)) {
          setError(`${msg}\n（本轮附带过画面图片：当前模型可能不支持视觉输入，请在「设置 -> AI 助手」换用多模态模型，如 gpt-4o / qwen-vl / glm-4v）`);
        } else {
          setError(msg);
        }
      } finally {
        setLoading(false);
        // 历史超阈值：本轮结束后自动压缩（失败不打断，静默记录结果到对话里）
        if (
          !cancelledRef.current &&
          apiMessagesRef.current &&
          estimateHistoryChars(apiMessagesRef.current) > AUTO_COMPACT_THRESHOLD_CHARS
        ) {
          void runCompaction(true);
        }
      }
    },
    [loading, compacting, llm, pushApi, pushUi, runCompaction],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend(input);
    }
  };

  // ===== 工具栏动作：YOLO / 新对话 / 导出 / 导入 =====
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const toggleYolo = () => {
    const next = !useChatStore.getState().yolo;
    useChatStore.getState().setYolo(next);
    pushUi({
      role: 'system',
      content: next
        ? '⚡ YOLO 已开启：后续所有 AI 操作（含渲染、录屏、全自动流水线）自动执行，不再逐条确认'
        : '⚡ YOLO 已关闭：AI 的副作用操作恢复逐条确认',
    });
  };

  /** 新对话：两步确认（第一次点击变成「确认？」，3 秒内再点才清空） */
  const handleNewChat = () => {
    if (loading) return;
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    useChatStore.getState().clear();
    imageBudgetRef.current = createImageBudget();
    apiMessagesRef.current = [{role: 'system', content: systemPrompt(videoType)}];
  };

  const exportChat = async (format: 'md' | 'json') => {
    setExportMenuOpen(false);
    const chat = useChatStore.getState();
    if (chat.uiMessages.length === 0) return;
    const currentVideoType = useProjectStore.getState().videoType;
    const content =
      format === 'md'
        ? serializeChatMarkdown(chat.uiMessages, {videoTypeLabel: VIDEO_TYPE_LABEL[currentVideoType]})
        : JSON.stringify(
            buildChatArchive({
              videoType: currentVideoType,
              uiMessages: chat.uiMessages,
              apiMessages: apiMessagesRef.current!,
            }),
            null,
            2,
          );
    const r = await window.api.chatExport({content, defaultName: `AI对话-${fileStamp()}.${format}`, format});
    if (r.success && r.path) pushUi({role: 'system', content: `对话已导出到：${r.path}`});
    else if (r.error) setError(r.error);
  };

  const importChat = async () => {
    if (loading) return;
    const r = await window.api.chatImport();
    if (!r) return; // 用户取消对话框
    if (!r.success || !r.content) {
      setError(r.error || '读取存档文件失败');
      return;
    }
    const parsed = parseChatArchive(r.content);
    if (!parsed.ok) {
      setError(`导入失败：${parsed.error}`);
      return;
    }
    const a = parsed.archive;
    // 整段替换：system 按当前体裁重建，正文用存档（已在 parse 内修复悬空 tool_calls）
    imageBudgetRef.current = createImageBudget();
    apiMessagesRef.current = [{role: 'system', content: systemPrompt(videoType)}, ...a.apiMessages];
    useChatStore.getState().replaceUi(a.uiMessages);
    useChatStore.getState().syncApi(apiMessagesRef.current);
    pushUi({role: 'system', content: `已导入对话存档（${a.uiMessages.length} 条消息 · 保存于 ${new Date(a.savedAt).toLocaleString('zh-CN')}）`});
  };

  /** 快速配置（AI 零门槛）：选厂商 → 粘 Key → 保存即用；默认选智谱（glm-4v-flash 免费，看图工具链开箱可用） */
  const [qcPresetId, setQcPresetId] = useState('zhipu');
  const [qcKey, setQcKey] = useState('');
  const [qcBusy, setQcBusy] = useState(false);
  const [qcError, setQcError] = useState<string | null>(null);
  const qcPreset = getAiProviderPreset(qcPresetId);
  const handleQuickSave = useCallback(async () => {
    const p = getAiProviderPreset(qcPresetId);
    const key = qcKey.trim();
    if (!p || !key || qcBusy) return;
    setQcBusy(true);
    setQcError(null);
    try {
      // 合并进持久化设置（只改 LLM 两项，不碰其他），同时同步内存 store
      const current = await window.api.getSettings();
      await window.api.setSettings({...current, llmBaseUrl: p.llm.baseUrl, llmModel: p.llm.model});
      useProjectStore.getState().setAppSettings({llmBaseUrl: p.llm.baseUrl, llmModel: p.llm.model});
      await window.api.llmSetApiKey(key);
      const status = await window.api.llmGetStatus();
      if (status.configured && status.baseUrl?.trim() && status.model?.trim()) {
        setConfigured(true); // 翻回聊天模式，立即可用
      } else {
        setQcError('保存未生效，请重试或到「设置 → AI 助手」手动配置');
      }
    } catch (err) {
      setQcError(err instanceof Error ? err.message : String(err));
    } finally {
      setQcBusy(false);
    }
  }, [qcPresetId, qcKey, qcBusy]);

  /** 演示编排（离线规则故事板）：未配置 LLM 时的「先跑通」路径——不联网、不用 Key，
   *  按当前体裁生成演示故事板并落到故事板页，让用户先体验「改文案 → 快速预览 → 渲染」闭环 */
  const [demoRunning, setDemoRunning] = useState(false);
  /** 演示编排完成：未配置态没有消息列表，成功反馈直接内联在演示区（完整说明入对话历史，配置后可见） */
  const [demoDone, setDemoDone] = useState(false);
  const handleDemoStoryboard = useCallback(() => {
    const s = useProjectStore.getState();
    const hasContent = s.segments.some((seg) => seg.videos.length > 0 || seg.text.title);
    if (hasContent && !window.confirm('演示编排会替换当前故事板内容（可 Ctrl+Z 撤销），继续吗？')) return;
    setDemoRunning(true);
    try {
      const available = new Set(mergeTemplateMetas(s.customTemplates, s.marketTemplates, s.generatedTemplates).map((t) => t.id));
      const specs = buildDemoStoryboardSpecs(videoType, available);
      if (specs.length === 0) {
        pushUi({role: 'system', content: '演示编排失败：模板库为空（内置模板未加载？）'});
        return;
      }
      s.applyAiStoryboard(specs);
      s.setStep(2);
      pushUi({role: 'system', content: demoStoryboardMessage(VIDEO_TYPE_LABEL[videoType], specs.length)});
      setDemoDone(true);
    } finally {
      setDemoRunning(false);
    }
  }, [videoType, pushUi]);

  return (
    <aside className="ai-panel">
      <div className="ai-panel-header">
        <span className="ai-panel-title">
          <Sparkles size={16} /> AI 助手
          {localEndpoint && (
            <span className="ai-edge-badge" title="服务地址为本机（Ollama/llama.cpp 等）：已自动启用端侧档——精简工具面与提示词、放宽请求超时，适配端侧小模型">
              本地精简模式
            </span>
          )}
        </span>
        <div className="ai-header-actions">
          <button
            className={`ai-icon-btn ${yolo ? 'ai-yolo-on' : ''}`}
            onClick={toggleYolo}
            title="YOLO 完全权限：开启后所有 AI 操作（含渲染、录屏、全自动流水线）自动执行，不再逐条确认。适合无人值守流程，请自行评估风险"
          >
            <Zap size={14} />
          </button>
          <button
            className="ai-icon-btn"
            onClick={() => void runCompaction(false)}
            disabled={loading || compacting}
            title="压缩对话历史：把较早的对话摘要成一段，释放上下文空间（历史过长时也会自动压缩）"
          >
            <Archive size={14} />
          </button>
          <div className="ai-export-wrap">
            <button
              className="ai-icon-btn"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={uiMessages.length === 0}
              title="导出对话记录（Markdown 人读版 / JSON 存档）"
            >
              <Download size={14} />
            </button>
            {exportMenuOpen && (
              <div className="ai-export-menu">
                <button onClick={() => void exportChat('md')}>Markdown（人读版）</button>
                <button onClick={() => void exportChat('json')}>JSON 存档（可再导入）</button>
              </div>
            )}
          </div>
          <button className="ai-icon-btn" onClick={() => void importChat()} disabled={loading || compacting} title="导入对话存档（JSON）">
            <Upload size={14} />
          </button>
          <button
            className={`ai-icon-btn ${confirmClear ? 'ai-clear-confirm' : ''}`}
            onClick={handleNewChat}
            disabled={loading || compacting}
            title="新对话（清空当前历史）"
          >
            {confirmClear ? '确认清空？' : <Plus size={14} />}
          </button>
          <button className="ai-icon-btn" onClick={handleClose} title="关闭"><X size={16} /></button>
        </div>
      </div>

      {yolo && (
        <div className="ai-yolo-banner">
          <Zap size={12} /> YOLO 已开启：AI 的所有操作自动执行，不再询问（点 ⚡ 关闭）
        </div>
      )}

      {configured === false ? (
        <div className="ai-setup-guide">
          {/* 先跑通：离线演示编排（不配置也能立即体验「生成故事板 → 渲染」闭环） */}
          <div className="ai-setup-demo">
            <div className="ai-setup-demo-title">还没配置 AI？先看一份演示编排</div>
            <p>
              用本地规则按「{VIDEO_TYPE_LABEL[videoType]}」体裁生成一份完整故事板（不联网、不用 API Key），
              马上就能到渲染页出样片。
            </p>
            <button className="ai-btn-primary" onClick={handleDemoStoryboard} disabled={demoRunning || demoDone}>
              {demoDone ? '✓ 已生成，见故事板页' : demoRunning ? '生成中…' : '一键生成演示故事板'}
            </button>
            {demoDone && (
              <p className="ai-demo-done-note">
                面板后面就是故事板页：改文案、换素材，或直接去渲染页点「快速预览」出样片。
              </p>
            )}
          </div>
          {/* 推荐路径：MCP 连接本机 agent——模型由 agent 自带，免去手动填 URL/API Key */}
          <div className="ai-setup-recommend">
            <div className="ai-setup-recommend-title">推荐：用 MCP 连接本机 AI agent</div>
            <p>
              Claude Code / Kimi CLI 等 agent 一键接入片语后即可直接做片——模型由 agent 自带，
              无需手动填写大模型服务地址与 API Key。
            </p>
            {detectedAgents.length > 0 && (
              <p className="ai-setup-detected">检测到本机已装：{detectedAgents.join('、')}</p>
            )}
            <div className="ai-setup-actions">
              <button className="ai-btn-primary" onClick={() => onOpenSettings('mcp')}>去设置一键接入</button>
              <button
                className="ai-btn-ghost"
                onClick={() => void window.api.openExternal('https://studio.dwphoto.top/videotool/mcp.html')}
              >
                接入文档
              </button>
            </div>
          </div>
          {/* 快速配置（三步约 1 分钟）：选厂商 → 粘 Key → 保存即用；服务商列表见 shared/ai-presets.ts */}
          <div className="ai-setup-quick">
            <div className="ai-setup-recommend-title">自己配内置助手（三步，约 1 分钟）</div>
            <ol className="ai-quick-steps">
              <li>
                <span className="ai-quick-step-label">① 选厂商</span>
                <div className="ai-quick-chips">
                  {AI_PROVIDER_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`ai-quick-chip ${qcPresetId === p.id ? 'active' : ''}`}
                      title={p.note}
                      onClick={() => setQcPresetId(p.id)}
                    >
                      {p.name}
                      {p.freeNote && <span className="ai-quick-badge">免费</span>}
                    </button>
                  ))}
                </div>
                {qcPreset && <p className="ai-quick-note">{qcPreset.note}</p>}
              </li>
              <li>
                <span className="ai-quick-step-label">② 粘贴 API Key</span>
                <div className="ai-quick-keyrow">
                  <input
                    type="password"
                    className="ai-quick-key"
                    placeholder="sk-..."
                    value={qcKey}
                    onChange={(e) => setQcKey(e.target.value)}
                  />
                  <button
                    className="ai-btn-ghost"
                    onClick={() => qcPreset && void window.api.openExternal(qcPreset.keyUrl)}
                  >
                    获取 Key ↗
                  </button>
                </div>
              </li>
              <li>
                <span className="ai-quick-step-label">③ 保存并启用</span>
                <button className="ai-btn-primary" disabled={!qcKey.trim() || qcBusy} onClick={() => void handleQuickSave()}>
                  {qcBusy ? '保存中…' : '保存并启用 AI 助手'}
                </button>
                {qcError && <p className="ai-quick-error">{qcError}</p>}
                <p className="ai-quick-hint">
                  Key 加密存在本机。配音/字幕识别/文生图可稍后在「设置」里一键补配（推荐硅基流动，与大模型同一个 Key）。
                </p>
              </li>
            </ol>
            <div className="ai-setup-manual">
              <button className="ai-btn-ghost" onClick={() => onOpenSettings('ai')}>前往手动配置（连通性测试 / Ollama 本地模型 / 补配配音字幕）</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="ai-messages" ref={scrollRef}>
            {uiMessages.length === 0 && (
              <div className="ai-empty-hint">
                告诉我你的产品与卖点，我来帮你搭故事板。素材可以你上传，也可以让我帮你录屏/截屏。
              </div>
            )}
            {uiMessages.map((m) => (
              <div key={m.id} className={`ai-msg ai-msg-${m.role}`}>
                {m.content && <div className="ai-bubble">{m.content}</div>}
                {m.toolNames && m.toolNames.length > 0 && (
                  <details className="ai-tool-card">
                    <summary>
                      <Wrench size={12} /> 调用 {m.toolNames.length} 个工具：{m.toolNames.join('、')}
                      <span className="ai-tool-done">已执行</span>
                    </summary>
                    <div className="ai-tool-list">
                      {m.toolNames.map((n, i) => (
                        <div key={i} className="ai-tool-item">{n}</div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
            {compacting && (
              <div className="ai-msg ai-msg-system">
                <div className="ai-bubble ai-bubble-loading">
                  <Loader2 size={14} className="icon-spin" /> 正在压缩历史对话…
                </div>
              </div>
            )}
            {loading && (
              <div className="ai-msg ai-msg-assistant">
                <div className="ai-bubble ai-bubble-loading">
                  <Loader2 size={14} className="icon-spin" /> 思考中…
                  <button className="ai-btn-ghost" onClick={requestCancel}>取消</button>
                </div>
              </div>
            )}
            {pendingConfirm && (
              <div className="ai-render-card">
                <div className="ai-render-card-title">
                  <Play size={14} /> {pendingConfirm.label}
                </div>
                {pendingConfirm.detail && <div className="ai-confirm-detail">{pendingConfirm.detail}</div>}
                <div className="ai-render-card-actions">
                  <button className="ai-btn-primary" onClick={() => answerConfirm(true)}>允许</button>
                  <button className="ai-btn-ghost" onClick={() => answerConfirm(false)}>拒绝</button>
                </div>
              </div>
            )}
            {renderRequested && (
              <RenderConfirmCard
                onCancel={() => setRenderRequested(false)}
                onDone={handleRenderDone}
                autoStart={useChatStore.getState().yolo}
              />
            )}
          </div>

          {error && <div className="ai-error">{error}</div>}

          <div className="ai-quick-prompts">
            <button className="ai-chip ai-chip-primary" onClick={() => handleSend(ONE_CLICK_PROMPT)} disabled={loading || compacting}>
              <Sparkles size={12} /> 一键成片
            </button>
            <button className="ai-chip" onClick={() => setShowBriefModal(true)} disabled={loading || compacting} title="选场景、填几个空，自动生成完整创作 brief">
              <LayoutTemplate size={12} /> 场景模板
            </button>
            <button className="ai-chip" onClick={() => handleSend('生成 30 秒产品宣传片')} disabled={loading || compacting}>
              生成 30 秒产品宣传片
            </button>
            <button className="ai-chip" onClick={() => handleSend('把我的长素材挖高光，剪成 1 分钟 vlog')} disabled={loading || compacting}>
              长素材剪成 vlog
            </button>
            <button className="ai-chip" onClick={() => handleSend('改成国风')} disabled={loading || compacting}>
              改成国风
            </button>
          </div>

          <div className="ai-input-row">
            <textarea
              className="ai-input"
              placeholder="描述你的需求…（Enter 发送，Shift+Enter 换行）"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              disabled={configured !== true || loading || compacting}
            />
            <button
              className="ai-send-btn"
              onClick={() => handleSend(input)}
              disabled={configured !== true || loading || compacting || !input.trim()}
              title="发送"
            >
              <Send size={16} />
            </button>
          </div>
          {showBriefModal && (
            <BriefTemplateModal
              onInsert={(brief) => setInput(brief)}
              onClose={() => setShowBriefModal(false)}
            />
          )}
        </>
      )}
    </aside>
  );
};

export default AIAssistantPanel;
