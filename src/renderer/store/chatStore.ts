/**
 * AI 助手对话 store —— 面板开合、应用重启都不丢历史。
 *
 * 面板组件（AIAssistantPanel）自身不存对话：界面消息（uiMessages）与 API 历史
 * （apiMessages，不含 system 首条）都放本 store，关闭面板只是卸载组件。
 * 每次变更同步写 localStorage（写前剥掉 base64 图片，见 shared/chat-history），
 * 应用启动时在本模块加载阶段同步恢复。
 *
 * yolo（完全权限模式）也在这里持久化：开启后面板内所有工具确认自动允许，
 * 与 MCP 桥「持有 token 即信任」的口径一致。
 */

import {create} from 'zustand';
import type {LlmChatMessage} from '../../shared/llm-chat';
import {stripImagesForStorage, type UiMsg} from '../../shared/chat-history';

const STORAGE_KEY = 'vt-ai-chat-v1';

interface PersistedChat {
  uiMessages: UiMsg[];
  apiMessages: LlmChatMessage[];
  yolo: boolean;
  savedAt: string;
}

const loadPersisted = (): Partial<PersistedChat> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Partial<PersistedChat>;
    return {
      uiMessages: Array.isArray(p.uiMessages) ? p.uiMessages : [],
      apiMessages: Array.isArray(p.apiMessages) ? (p.apiMessages as LlmChatMessage[]) : [],
      yolo: p.yolo === true,
    };
  } catch {
    // 存储损坏时静默从零开始（历史丢了但应用不能炸）
    return {};
  }
};

const persist = (state: {uiMessages: UiMsg[]; apiMessages: LlmChatMessage[]; yolo: boolean}): void => {
  try {
    const payload: PersistedChat = {
      uiMessages: state.uiMessages,
      apiMessages: stripImagesForStorage(state.apiMessages),
      yolo: state.yolo,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 超配额等写入失败：本轮历史只在内存里，不中断对话
  }
};

export interface ChatStoreState {
  uiMessages: UiMsg[];
  /** 发给 API 的历史（不含 system 首条，面板加载时按当前体裁重建到 index 0） */
  apiMessages: LlmChatMessage[];
  yolo: boolean;
  /** 追加一条界面消息（id 由调用方生成，保证与面板 nextId 口径一致） */
  pushUi: (msg: UiMsg) => void;
  /** 整体替换界面消息（导入存档 / 清空） */
  replaceUi: (msgs: UiMsg[]) => void;
  /** 同步 API 历史（剥图后落 localStorage） */
  syncApi: (msgs: LlmChatMessage[]) => void;
  setYolo: (v: boolean) => void;
  /** 新对话：清空全部历史 */
  clear: () => void;
}

const initial = loadPersisted();

export const useChatStore = create<ChatStoreState>((set, get) => ({
  uiMessages: initial.uiMessages ?? [],
  apiMessages: initial.apiMessages ?? [],
  yolo: initial.yolo ?? false,

  pushUi: (msg) => {
    set((s) => {
      const uiMessages = [...s.uiMessages, msg];
      persist({uiMessages, apiMessages: s.apiMessages, yolo: s.yolo});
      return {uiMessages};
    });
  },
  replaceUi: (msgs) => {
    set(() => {
      persist({uiMessages: msgs, apiMessages: get().apiMessages, yolo: get().yolo});
      return {uiMessages: msgs};
    });
  },
  syncApi: (msgs) => {
    // 传进来的可能含 system 首条（面板工作数组）；首条是按体裁动态重建的，不存档，
    // 其余 system 消息（如压缩摘要）是历史的一部分，保留
    const apiMessages =
      msgs.length > 0 && msgs[0].role === 'system' ? msgs.slice(1) : msgs.slice();
    set((s) => {
      persist({uiMessages: s.uiMessages, apiMessages, yolo: s.yolo});
      return {apiMessages};
    });
  },
  setYolo: (v) => {
    set((s) => {
      persist({uiMessages: s.uiMessages, apiMessages: s.apiMessages, yolo: v});
      return {yolo: v};
    });
  },
  clear: () => {
    set(() => {
      persist({uiMessages: [], apiMessages: [], yolo: get().yolo});
      return {uiMessages: [], apiMessages: []};
    });
  },
}));
