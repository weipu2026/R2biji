/* JMbiji Service Worker:仅缓存应用自身(外壳),不碰任何库数据与 /api/*
 *
 * ⚠️ 两件必须一起做的事(改了 public/ 下的代码就要想到它们):
 *   1. 新增/删除 js 模块 → 同步改下面的 ASSETS 清单,否则离线时那个模块拉不到。
 *      (tests/assets.test.mjs 会自动核对清单与实际文件,漏了会变红。)
 *   2. **改完任何被缓存的资源,必须把 CACHE 版本号 +1。**
 *      静态 js/css 是 cache-first,而浏览器只在 sw.js 这个文件本身变化时才重新安装;
 *      不升版本号 → 老用户永远拿到旧缓存里的 js,表现为「部署了但界面没变」。
 *      页面 HTML 已是 network-first(2026-09-24),普通刷新即可拿到新外壳。
 */
const CACHE = 'jmbiji-v16';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/crypto.js',
  './js/format.js',
  './js/vaultlib.js',
  './js/api.js',
  './js/lib.js',
  './js/render.js',
  './js/search.js',
  './js/session.js',
  './js/tabsync.js',
  './js/zip.js',
  './js/ui.js',
  './js/main.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 硬护栏:/api/* 一律不经过缓存。密文与 vault.json 只要被 Cache Storage 留过
  // 一份,锁屏就形同虚设(换用户/退出登录都还能从缓存读出来)。
  // 目前 ASSETS 清单里没有 API 路径,这行是防止将来有人往里加。
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  // 页面本体(导航请求)network-first:部署新版后普通刷新一次就能拿到新外壳,
  // 不再依赖「新 SW install 完成 → 自动刷新」的时序;断网才回退缓存,离线可用性不丢。
  // 其余静态资源仍 cache-first:内容随 CACHE 版本整体更替,命中缓存最省往返。
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then((h) => h || caches.match('./index.html')),
      ),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)),
  );
});
