/**
 * 3D 标题字体档位表（titleFont 参数语义；与 ThreeText.tsx 内的 url 表按下标一一对应）
 *
 * 单独成模块（不含 ttf 资源导入）是为了让 node 侧单测/注册表能 import 档位数量与标签。
 * 0 文楷（默认，兼容旧渲染）/ 1 站酷庆科黄油体 / 2 站酷小薇 / 3 马善政楷书 / 4 站酷快乐体
 */
export const THREE_TITLE_FONT_LABELS = ['文楷', '黄油体', '小薇', '毛笔楷', '快乐体'] as const;
