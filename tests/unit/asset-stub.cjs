/**
 * 单测资源 stub：tsx/node 直跑时把二进制资源 import 替换为路径字符串。
 * ThreeText 等组件顶层 import .ttf 字体（bundle 环境由 Vite/webpack 转成 asset URL），
 * node 无法编译二进制——必须在 import instantiate.ts 之前注册（ESM 按序求值，放第一个 import）。
 */
const stub = (m, filename) => {
  m.exports = `asset-stub:${filename}`;
};
require.extensions['.ttf'] = stub;
require.extensions['.otf'] = stub;
require.extensions['.glb'] = stub;
