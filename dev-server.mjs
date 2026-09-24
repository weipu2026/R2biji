#!/usr/bin/env node
/* ============================================================
 * JMbiji 本地开发服务器(零依赖,Node ≥ 22,内置全局 Request/Response)
 *
 *   node dev-server.mjs [端口]     默认 8787
 *
 * - 静态资源:public/ 目录(禁缓存,改完刷新即生效)
 * - /api/*:走与部署完全相同的 worker/worker.js + 内存版 R2
 *   (worker/memory-r2.mjs,条件写语义与真机一致)
 * - ★ 每个请求都新建 env 对象 —— 与 Cloudflare 运行时一致。共用同一个 env
 *   会把「状态挂在 env 上」这类 bug 掩盖掉(限流曾因此完全失效,本地却看着正常)。
 * - 访问密钥门:设了 ACCESS_KEY=xxx 就启用;不设则本地默认关掉这层门
 *   (生产环境不设会 fail closed 返回 503,本地刻意放宽以免处处要输密钥)
 * - ⚠️ 数据只存在内存里,重启即清空 —— 仅用于本地体验/调 UI;
 *   正式使用请部署到 Cloudflare(npx wrangler deploy)。
 * ============================================================ */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './worker/worker.js';
import { MemoryR2 } from './worker/memory-r2.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.argv[2]) || 8787;

/* 与生产一致的唯一 R2 绑定(跨请求持久);env 本身必须每请求新建 */
const VAULT_BINDING = new MemoryR2();
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const DOOR_OPEN = !ACCESS_KEY;

/** 每个请求一份新的 env —— 复刻 Cloudflare 的 per-request env 语义 */
const envForRequest = () => (DOOR_OPEN
  ? { VAULT: VAULT_BINDING, ALLOW_NO_ACCESS_KEY: '1' }
  : { VAULT: VAULT_BINDING, ACCESS_KEY });

/** 本地静态资源的硬化头:镜像 public/_headers(生产由 CF 解析该文件) */
const STATIC_SEC_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 生产环境里这个文件被 CF 解析掉、不会作为资源返回;本地也照样 404
  if (rel === '/_headers' || rel === '/_redirects') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }
  // 路径穿越防护:归一化后必须仍在 public/ 内
  const full = normalize(join(PUBLIC_DIR, rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let data;
  try {
    data = await readFile(full);
    await stat(full); // 确认是文件而非目录
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache, no-store, must-revalidate',
    ...STATIC_SEC_HEADERS,
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = Buffer.concat(await req.toArray());
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      const request = new Request(url.href, {
        method: req.method,
        headers,
        body: body ?? undefined,
      });
      const out = await handleApiRequest(request, envForRequest());
      const buf = out.body ? Buffer.from(await out.arrayBuffer()) : null;
      const headersOut = {};
      out.headers.forEach((v, k) => { headersOut[k] = v; });
      res.writeHead(out.status, headersOut);
      res.end(buf);
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (e) {
    console.error('[jmbiji] 请求处理失败:', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal Error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`JMbiji 已启动: http://localhost:${PORT}`);
  if (DOOR_OPEN) {
    console.log('⚠️  本地未设 ACCESS_KEY:访问密钥门已关闭(生产环境下不设会直接 503)');
    console.log('   想按生产语义试:ACCESS_KEY=至少16个字符 node dev-server.mjs');
  } else {
    console.log('访问密钥门:已启用(网页首次打开会要求输入 ACCESS_KEY)');
  }
  console.log('提示:本地数据仅存内存,重启即清空(用于体验/调 UI);正式使用请 wrangler deploy');
});
