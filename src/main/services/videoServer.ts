/**
 * 本地视频 HTTP 服务器
 *
 * 为什么需要: Remotion 渲染使用 headless Chromium，该浏览器出于安全策略会阻止
 * file:// 协议加载媒体文件（MEDIA_ELEMENT_ERROR: URL safety check）。
 *
 * 解决方案: 启动一个本地 HTTP 服务器，将视频文件通过 http:// 协议提供给 Remotion。
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

let server: http.Server | null = null;
let port = 0;

/**
 * 已注册媒体路径白名单。
 * 本服务无任何鉴权且监听回环端口，本机任意进程都能请求——不设白名单则
 * `?path=C:\任意文件` 即可读全盘。只有经 filePathToHttpUrl/registerMediaPath
 * 注册过（即应用自己产生过 URL）的路径才会被服务，其余一律 403。
 */
const allowedPaths = new Set<string>();

/** 注册一个允许被本服务器提供的媒体文件路径（两侧归一化到 path.resolve，正/反斜杠与相对写法视为同一路径） */
export const registerMediaPath = (filePath: string): void => {
  if (filePath) allowedPaths.add(path.resolve(filePath));
};

/** 查询路径是否已注册进白名单（asr:transcribe 这类会把文件内容发往第三方端点的通道必须先校验） */
export const isRegisteredMediaPath = (filePath: string): boolean =>
  Boolean(filePath) && allowedPaths.has(path.resolve(filePath));

/**
 * CORS：只放行本机回源（Electron dev 预览 localhost:3000、Remotion bundle/headless
 * localhost:任意端口）与 null（打包后 file:// 页面），拒绝公网站点读用户媒体。
 * @remotion/media 的 WebCodecs 解码路径用 fetch 拉视频，没有 ACAO 会整块退回
 * OffthreadVideo 兜底（慢且绕路）；Range 响应头需显式 Expose 才能被 JS 读到。
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const corsHeadersFor = (req: http.IncomingMessage): Record<string, string> => {
  const origin = req.headers.origin || '';
  if (origin !== 'null' && !LOOPBACK_ORIGIN.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? 'null' : origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
  };
};

// MIME 类型映射
const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  // 音频（背景音乐）
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  // 3D 模型（three.js GLTFLoader）
  '.glb': 'model/gltf-binary',
};

/** 管道输出文件流；流错误（如读取中途文件被删）只断开响应，不击穿主进程 */
const streamFile = (res: http.ServerResponse, filePath: string, opts: {start?: number; end?: number}): void => {
  const stream = fs.createReadStream(filePath, opts);
  stream.on('error', (err) => {
    console.error('[VideoServer] 读取流错误:', err);
    res.destroy();
  });
  stream.pipe(res);
};

/**
 * 启动视频文件服务器
 * @returns 服务器端口号
 */
export const startVideoServer = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(port);
      return;
    }

    server = http.createServer((req, res) => {
      // 整个回调必须无异常逸出：http server 回调里的同步异常会击穿主进程（无兜底时直接退出）
      try {
        // 从 URL 中提取文件路径
        // URL 格式: http://localhost:PORT/video?path=encodeURIComponent(filePath)
        // 注意：searchParams.get 已做过一次百分号解码，绝不能再 decodeURIComponent——
        // 文件名含裸 %（如 "100% off.mp4"）会抛 URIError 直接崩溃主进程
        const url = new URL(req.url || '', `http://localhost:${port}`);
        const filePath = url.searchParams.get('path') || '';

        // CORS 预检直接应答（实际请求仍走下方白名单校验）
        const cors = corsHeadersFor(req);
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          res.end();
          return;
        }

        // 白名单：只服务应用自己注册过的媒体路径，挡本机其它进程的任意文件读取
        // 查找与注册同样走 path.resolve 归一——注册时 resolve 过，URL 里带来的是原始
        // 字符串（正/反斜杠取决于调用方），不 resolve 会把同一路径的正斜杠写法误判 403
        if (!filePath || !allowedPaths.has(path.resolve(filePath))) {
          res.writeHead(403, {'Content-Type': 'text/plain', ...cors});
          res.end('Forbidden');
          return;
        }

        if (!fs.existsSync(filePath)) {
          res.writeHead(404, {'Content-Type': 'text/plain', ...cors});
          res.end('Not Found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_MAP[ext] || 'application/octet-stream';
        // statSync 与 existsSync 之间存在 TOCTOU 窗口（预览时用户移动/删除素材），必须 try-catch
        let fileSize: number;
        try {
          fileSize = fs.statSync(filePath).size;
        } catch {
          res.writeHead(404, {'Content-Type': 'text/plain', ...cors});
          res.end('Not Found');
          return;
        }

        // 处理 Range 请求（视频拖动必需）
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          // 非法 Range（NaN / 越界）按 416 处理，绝不能让 NaN 进入 createReadStream
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
            res.writeHead(416, {'Content-Range': `bytes */${fileSize}`, ...cors});
            res.end();
            return;
          }
          const safeEnd = Math.min(end, fileSize - 1);
          const chunkSize = safeEnd - start + 1;

          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            ...cors,
          });
          streamFile(res, filePath, {start, end: safeEnd});
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
            ...cors,
          });
          streamFile(res, filePath, {});
        }
      } catch (err) {
        // 兜底：任何意外错误返回 500，绝不逸出到主进程
        console.error('[VideoServer] 请求处理失败:', err);
        if (!res.headersSent) res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end();
      }
    });

    // 端口 0 = 系统自动分配可用端口
    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (addr && typeof addr !== 'string') {
        port = addr.port;
        console.log(`[VideoServer] 启动成功，端口: ${port}`);
        resolve(port);
      } else {
        reject(new Error('无法获取视频服务器端口'));
      }
    });

    server.on('error', (err) => {
      console.error('[VideoServer] 启动失败:', err);
      reject(err);
    });
  });
};

/**
 * 获取当前视频服务器端口
 */
export const getVideoServerPort = (): number => {
  return port;
};

/**
 * 将本地文件路径转换为 HTTP URL（同时注册进白名单）
 */
export const filePathToHttpUrl = (filePath: string): string => {
  if (!filePath) return '';
  // 如果已经是 HTTP URL，直接返回
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  registerMediaPath(filePath);
  // 转换为本地 HTTP URL
  return `http://127.0.0.1:${port}/video?path=${encodeURIComponent(filePath)}`;
};

/**
 * 关闭视频服务器
 */
export const stopVideoServer = (): Promise<void> => {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        port = 0;
        resolve();
      });
    } else {
      resolve();
    }
  });
};
