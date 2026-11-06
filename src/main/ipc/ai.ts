/**
 * AI 相关 IPC（LLM 助手聊天 / TTS 语音合成）
 */

import fs from 'node:fs';
import pathModule from 'node:path';
import {ipcMain, app} from 'electron';
import {IPC_CHANNELS} from '../../shared/ipc-channels';
import {llmChat, cancelLlmChat, setLlmApiKey, getLlmStatus} from '../services/llm';
import {synthesizeSpeech, setTtsApiKey, getTtsStatus} from '../services/tts';
import {transcribeMedia, setAsrApiKey, getAsrStatus} from '../services/asr';
import {
  searchStockMedia, downloadStockMedia, fetchStockThumbnail, setStockApiKey, getStockStatus,
} from '../services/stockMedia';
import {generateImage, getImageGenStatus} from '../services/imageGen';
import {generateModel, getModelGenStatus, setModelGenApiKey} from '../services/modelGen';
import {analyzeRenderAudio} from '../services/audioReview';
import {analyzeSourceTimeline, analyzeHighlightCandidates} from '../services/highlightMining';
import {isRegisteredMediaPath} from '../services/videoServer';
import {trackAiChat} from '../services/usage';
import type {LlmChatRequest} from '../../shared/llm-chat';
import type {TtsSynthesizeRequest} from '../../shared/llm-chat';
import type {AsrTranscribeRequest} from '../../shared/asr';
import type {StockSearchRequest, StockDownloadRequest} from '../../shared/stock-media';
import type {ImageGenRequest} from '../../shared/image-gen';
import type {ModelGenRequest} from '../../shared/model-gen';

export const registerAiIpc = () => {
  // ====== LLM 助手 ======

  // 转发一轮聊天（OpenAI 兼容，非流式）；错误以中文 Error 抛回渲染进程
  ipcMain.handle(IPC_CHANNELS.LLM_CHAT, async (_, req: LlmChatRequest) => {
    const message = await llmChat(req);
    // 匿名用量统计：成功回复才计数（track 内部静默容错）
    trackAiChat();
    return message;
  });

  // 中止进行中的聊天请求（渲染端「取消」按钮/关闭面板时调用）
  ipcMain.handle('llm:cancel', async () => {
    cancelLlmChat();
  });

  // 保存 API key（safeStorage 加密落盘；空字符串 = 清除）
  ipcMain.handle(IPC_CHANNELS.LLM_SET_API_KEY, async (_, key: string) => {
    setLlmApiKey(key);
    return true;
  });

  // 查询配置状态（只回 已配置/baseUrl/model，key 永不回渲染进程）
  ipcMain.handle(IPC_CHANNELS.LLM_GET_STATUS, async () => {
    return getLlmStatus();
  });

  // ====== TTS 语音合成 ======

  // 合成旁白语音（OpenAI 兼容 /audio/speech，落盘 userData/tts 缓存）；错误以中文 Error 抛回渲染进程
  ipcMain.handle(IPC_CHANNELS.TTS_SYNTHESIZE, async (_, req: TtsSynthesizeRequest) => {
    return synthesizeSpeech(req);
  });

  // 保存 TTS API key（safeStorage 加密落盘；空字符串 = 清除）
  ipcMain.handle(IPC_CHANNELS.TTS_SET_API_KEY, async (_, key: string) => {
    setTtsApiKey(key);
    return true;
  });

  // 查询 TTS 配置状态（只回 已配置/baseUrl/model/voice，key 永不回渲染进程）
  ipcMain.handle(IPC_CHANNELS.TTS_GET_STATUS, async () => {
    return getTtsStatus();
  });

  // ====== ASR 语音识别 ======

  // 转录素材语音为字幕行（OpenAI 兼容 /audio/transcriptions）；错误以中文 Error 抛回渲染进程
  ipcMain.handle(IPC_CHANNELS.ASR_TRANSCRIBE, async (_, req: AsrTranscribeRequest) => {
    // 安全：只转录应用自己注册过的媒体路径（白名单见 videoServer）——
    // 否则渲染进程任意 JS 可把本机任意文件（如私人录音）上传到第三方 ASR 端点
    if (!req || typeof req.path !== 'string' || !isRegisteredMediaPath(req.path)) {
      throw new Error('素材未注册（仅可识别故事板中已添加的素材）');
    }
    return transcribeMedia(req);
  });

  // 保存 ASR API key（safeStorage 加密落盘；空字符串 = 清除）
  ipcMain.handle(IPC_CHANNELS.ASR_SET_API_KEY, async (_, key: string) => {
    setAsrApiKey(key);
    return true;
  });

  // 查询 ASR 配置状态（只回 已配置/baseUrl/model，key 永不回渲染进程）
  ipcMain.handle(IPC_CHANNELS.ASR_GET_STATUS, async () => {
    return getAsrStatus();
  });

  // ====== Stock 素材搜索（Pexels/Pixabay） ======

  // 聚合搜索（已配 key 的源都查；单源失败聚到 warnings 不拖垮整体）
  ipcMain.handle(IPC_CHANNELS.STOCK_SEARCH, async (_, req: StockSearchRequest) => {
    return searchStockMedia(req);
  });

  // 下载素材（域名白名单校验 + 120MB 上限；落盘 userData/stock-media 并注册媒体白名单）
  ipcMain.handle(IPC_CHANNELS.STOCK_DOWNLOAD, async (_, req: StockDownloadRequest) => {
    return downloadStockMedia(req);
  });

  // 缩略图代下载 -> dataUrl（失败返回空串；渲染进程不直连外网）
  ipcMain.handle(IPC_CHANNELS.STOCK_THUMBNAIL, async (_, url: string) => {
    return fetchStockThumbnail(url);
  });

  // 保存某家的 API key（safeStorage 加密落盘；空字符串 = 清除）
  ipcMain.handle(IPC_CHANNELS.STOCK_SET_API_KEY, async (_, provider: string, key: string) => {
    if (provider !== 'pexels' && provider !== 'pixabay') throw new Error('未知的素材源');
    setStockApiKey(provider, key);
    return true;
  });

  // 查询已配置的素材源（key 永不回渲染进程）
  ipcMain.handle(IPC_CHANNELS.STOCK_GET_STATUS, async () => {
    return getStockStatus();
  });

  // ====== 文生图（与 AI 助手共用端点与 Key，仅模型名单独配置） ======

  ipcMain.handle(IPC_CHANNELS.IMAGE_GEN_GENERATE, async (_, req: ImageGenRequest) => {
    return generateImage(req);
  });

  ipcMain.handle(IPC_CHANNELS.IMAGE_GEN_GET_STATUS, async () => {
    return getImageGenStatus();
  });

  // ====== 文生 3D（Meshy 兼容 Text-to-3D，独立加密 Key） ======

  // 发起 3D 生成任务（pending 单例，立即返回任务快照；渲染端轮询 getStatus 直到终态）
  ipcMain.handle(IPC_CHANNELS.MODEL_GEN_GENERATE, async (_, req: ModelGenRequest) => {
    return generateModel(req);
  });

  // 查询配置状态 + 任务快照（进度/产物路径，key 永不回渲染进程）
  ipcMain.handle(IPC_CHANNELS.MODEL_GEN_GET_STATUS, async () => {
    return getModelGenStatus();
  });

  // 保存文生 3D API key（safeStorage 加密落盘；空字符串 = 清除）
  ipcMain.handle(IPC_CHANNELS.MODEL_GEN_SET_API_KEY, async (_, key: string) => {
    setModelGenApiKey(key);
    return true;
  });

  // ====== 成片音频审片（纯本地 ffmpeg 探测；路径白名单校验在服务内） ======

  ipcMain.handle(IPC_CHANNELS.RENDER_ANALYZE_AUDIO, async (_, path: string) => {
    return analyzeRenderAudio(path);
  });

  // ====== 源素材挖矿时间线（mine_highlights）======
  // 安全：与 asr:transcribe 同口径——ASR 会把素材音频上传第三方端点，只放行已注册媒体路径
  ipcMain.handle(IPC_CHANNELS.MINING_ANALYZE_TIMELINE, async (_, path: string, opts?: {asrSegments?: unknown}) => {
    if (typeof path !== 'string' || !path || !isRegisteredMediaPath(path)) {
      throw new Error('素材未注册（仅可分析故事板中已添加的素材）');
    }
    // 复用转写缓存（P0-4）：asrSegments 只是本机已持久化的分段文本/时间，不含路径类载荷；
    // 结构过滤在 service 层做（非法条目被剔除，不足以复用时照常跑 ASR）
    const raw = Array.isArray(opts?.asrSegments) ? (opts!.asrSegments as Array<{start: number; end: number; text: string}>) : undefined;
    return analyzeSourceTimeline(path, raw ? {asrSegments: raw} : undefined);
  });

  // ====== 高光候选启发式预筛（mine_highlights 预筛层：场景检测+音轨+曝光，零模型）======
  ipcMain.handle(IPC_CHANNELS.MINING_HIGHLIGHT_CANDIDATES, async (_, req: {path?: unknown; topN?: unknown; targetSec?: unknown}) => {
    const path = typeof req?.path === 'string' ? req.path : '';
    if (!path || !isRegisteredMediaPath(path)) {
      throw new Error('素材未注册（仅可分析故事板中已添加的素材）');
    }
    return analyzeHighlightCandidates(path, {
      ...(typeof req?.topN === 'number' ? {topN: req.topN} : {}),
      ...(typeof req?.targetSec === 'number' ? {targetSec: req.targetSec} : {}),
    });
  });

  // ====== 精选面板用户选择记录（RLHF 留口：本地 jsonl 追加，随素材同目录风格放 userData）======
  ipcMain.handle(IPC_CHANNELS.HIGHLIGHT_RECORD_CHOICE, async (_, req: {
    sourcePath?: unknown; segmentIndex?: unknown; videoIndex?: unknown;
    candidates?: unknown; picked?: unknown; usedAi?: unknown;
  }) => {
    const sourcePath = typeof req?.sourcePath === 'string' ? req.sourcePath : '';
    if (!sourcePath) throw new Error('缺少素材路径');
    const record = {
      ts: new Date().toISOString(),
      sourcePath,
      segmentIndex: typeof req?.segmentIndex === 'number' ? req.segmentIndex : null,
      videoIndex: typeof req?.videoIndex === 'number' ? req.videoIndex : null,
      candidates: Array.isArray(req?.candidates) ? req.candidates : [],
      picked: Array.isArray(req?.picked) ? req.picked : [],
      usedAi: req?.usedAi === true,
    };
    try {
      const file = pathModule.join(app.getPath('userData'), 'highlight-choices.jsonl');
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      return {ok: true, file};
    } catch (err) {
      // 记录失败不影响主流程（面板仍正常挖段）
      return {ok: false, error: err instanceof Error ? err.message : String(err)};
    }
  });
};
