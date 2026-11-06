import {defineConfig} from 'electron-vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'path';

// Keep the usual development port, but allow callers to choose another one.
const configuredRendererPort = Number.parseInt(process.env.VITE_PORT ?? '5173', 10);
const rendererPort = Number.isInteger(configuredRendererPort) && configuredRendererPort > 0 && configuredRendererPort <= 65535
  ? configuredRendererPort
  : 5173;

/**
 * 生产构建收紧 CSP：移除 script-src 'unsafe-inline'。
 * dev server 需要它执行 @vitejs/plugin-react 注入的内联 preamble（react-refresh），
 * 生产产物全部是外链 JS，可以安全去掉（XSS 拿到 HTML 注入点也无法执行脚本）。
 * 注意保留 'unsafe-eval'：AI 生成模板（三期 D2）在渲染端以 new Function 实例化
 * 编译产物（remotion/generated/instantiate.ts），该能力是本功能的刻意设计，
 * 攻击面由 shared/generated-template.ts 的静态扫描 + 无 import + 白名单作用域收敛。
 * （本插件按前缀子串替换，'unsafe-inline' 被剥掉后 'unsafe-eval' 依然保留。）
 */
const strictCspPlugin = () => ({
  name: 'strict-csp',
  transformIndexHtml: {
    order: 'post' as const,
    handler(html: string, ctx: {bundle?: unknown}) {
      // 仅构建阶段（有 bundle）处理；dev server 原样保留
      if (!ctx.bundle) return html;
      return html.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'");
    },
  },
});

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        // Remotion 包内部使用 require.resolve() 解析自身模块
        // 如果被 bundle 进单个 JS 文件，路径会失效 → 必须标记为 external
        // uiohook-napi/koffi 是原生模块（运行时加载 .node），同样必须 external
        external: [
          /^@remotion\//,
          'remotion',
          'react',
          'react-dom',
          'webpack',
          'esbuild',
          'chromium-bidi',
          'aws4',
          'uiohook-napi',
          'koffi',
        ],
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    // 同样在 SSR 解析时也外部化这些包（避免 Vite 试图处理它们）
    // 注意：Vite 5 的 ssr.external 类型为 string[]（不支持 RegExp），故显式列出
    ssr: {
      external: [
        '@remotion/bundler',
        '@remotion/renderer',
        '@remotion/cli',
        '@remotion/player',
        'remotion',
        'webpack',
        'esbuild',
        'uiohook-napi',
        'koffi',
      ],
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [react(), strictCspPlugin()],
    server: {
      port: rendererPort,
      // electron-vite injects the actual listening port into ELECTRON_RENDERER_URL.
      // This lets a second dev instance move to the next available port.
      strictPort: false,
    },
  },
});
