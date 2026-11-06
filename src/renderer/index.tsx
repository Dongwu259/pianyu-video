/**
 * 渲染进程入口 - React 应用启动
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import {App} from './App';
import {useProjectStore} from './store/projectStore';
import {useUIStore} from './store/uiStore';
import {loadBrandFontForPreview} from '../remotion/config/brandFont';
import './styles/global.css';

// 加载内置品牌字体（MiSans），保证预览与最终渲染文字一致；失败自动回退系统字体
loadBrandFontForPreview();

// GUI 测试 / 控制台调试钩子：CDP 驱动的验证脚本直接读工程状态做断言
(window as unknown as {__pianyuStore?: typeof useProjectStore}).__pianyuStore = useProjectStore;
(window as unknown as {__pianyuUIStore?: typeof useUIStore}).__pianyuUIStore = useUIStore;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
