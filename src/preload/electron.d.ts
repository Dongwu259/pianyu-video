/**
 * 扩展 Window 接口，声明 window.api 的类型
 */

import type {ElectronApi} from './index';

declare global {
  interface Window {
    api: ElectronApi;
  }
}

export {};
