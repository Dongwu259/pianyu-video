/**
 * AI 生成模板（三期 D2）的 esbuild 编译——独立模块，零 Electron 依赖。
 * 从 templateGen.ts 拆出：单测（Node 直跑）只能引 esbuild，
 * 不能经 templateGen → store → electron-store 的依赖链把 Electron 拖进来。
 */

import {transformSync} from 'esbuild';

export interface CompileResult {
  ok: boolean;
  code?: string;
  errors?: string[];
}

/** 受限 TSX → JS（React.createElement 形态）。语法错误转成 LLM 可读的带行号信息 */
export const compileGeneratedSource = (source: string): CompileResult => {
  try {
    const out = transformSync(source, {
      loader: 'tsx',
      jsx: 'transform', // → React.createElement（React 由渲染端注入作用域）
      target: 'es2020',
      legalComments: 'none',
    });
    return {ok: true, code: out.code};
  } catch (err) {
    // esbuild 错误格式含 "✘ [ERROR] message\n  file:line:col"，提炼成紧凑列表
    const msg = String((err as {message?: unknown})?.message ?? err);
    const lines = msg
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('✘') || /ERROR/.test(l) || /^\S+:\d+:\d+:/.test(l))
      .slice(0, 5);
    return {
      ok: false,
      errors: [
        `TSX 编译失败：${lines.length > 0 ? lines.join('；').replace(/✘\s*\[ERROR\]\s*/g, '') : msg.slice(0, 300)}`,
        '修正语法后重新调用 generate_template（常见问题：JSX 标签未闭合、用了未注入的标识符）',
      ],
    };
  }
};
