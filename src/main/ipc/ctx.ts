import type {BrowserWindow} from 'electron';
import type {ProxyTranscodeService} from '../services/proxyTranscode';

/**
 * IPC 模块共享上下文：由 index.ts 组装后传入各 register 函数，
 * 避免 ipc 模块反向依赖入口文件的模块级状态。
 */
export interface IpcCtx {
  /** 主窗口可能已销毁（closed 后置 null），使用时需判空 */
  getMainWindow: () => BrowserWindow | null;
  isDev: boolean;
  /** 代理转码服务（mxf/超大/4K 素材；index.ts 组装，抽帧/导入/协议共享单例） */
  proxyService?: ProxyTranscodeService;
}
